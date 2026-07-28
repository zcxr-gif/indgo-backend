'use strict';

/*
 * crewSetup.js
 * One-paste setup for a VA's own Supabase project.
 *
 * THE PROBLEM
 * -----------
 * Bring-your-own-database is the right model — a VA's crew, flights and pilot
 * logins belong to the VA — but the manual version of it asks a volunteer
 * airline manager to: create a Supabase project, find the SQL editor, paste
 * four hundred lines of DDL, run it, find Settings → API, and copy three values
 * (one of them secret) into a different site without mixing up which is which.
 * Every one of those steps is a place to give up, and the two that go wrong
 * quietly — pasting the anon key into the service_role box, or running the SQL
 * against the wrong project — produce a crew center that looks connected and
 * fails on the first write.
 *
 * THE ALTERNATIVE
 * ---------------
 * Supabase issues personal access tokens that drive its Management API. Given
 * one, this module does the whole thing on the VA's behalf: list their
 * projects (or create one), run the schema, read the project's API keys back,
 * store the connection, and verify it end to end. The VA pastes one token and
 * picks one project.
 *
 * WHAT WE DO WITH THE TOKEN
 * -------------------------
 * Use it for the duration of the request and then forget it. It is never
 * written to the database, never logged, and never returned to the browser.
 * That matters more than usual here: a Supabase PAT is not scoped to one
 * project, so it can do anything to the account that issued it. Holding one at
 * rest would make us a far more valuable target than holding a service key, and
 * the token is only needed for setup — nothing at run time uses it. The setup
 * flow tells the VA this, and tells them to revoke it afterwards.
 *
 * Env:
 *   SUPABASE_API_URL         override the management API base (tests point this
 *                            at a local impersonator; never at a user value).
 *   CREW_SETUP_TIMEOUT_MS    per-request timeout (default 20000 — creating a
 *                            project and running DDL are both slow).
 */

const axios = require('axios');
const crypto = require('crypto');

// Fixed, never derived from a request: everything below talks to Supabase and
// nowhere else, so there is no URL for a caller to point somewhere interesting.
const API_URL = (process.env.SUPABASE_API_URL || 'https://api.supabase.com').replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.CREW_SETUP_TIMEOUT_MS, 10) || 20000;

// Supabase's own status string for "project is up and serving".
const HEALTHY = 'ACTIVE_HEALTHY';

class SetupError extends Error {
    constructor(message, { status = 502, code = 'setup_error', detail = '' } = {}) {
        super(message);
        this.name = 'SetupError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

// ---------------------------------------------------------------------------
// Management API client
// ---------------------------------------------------------------------------
class Management {
    constructor(accessToken) {
        this.token = String(accessToken || '').trim();
    }

    async request(method, path, data) {
        let res;
        try {
            res = await axios({
                method,
                url: `${API_URL}${path}`,
                data,
                timeout: TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                validateStatus: () => true,
            });
        } catch (err) {
            const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
            throw new SetupError(
                timedOut ? 'Supabase took too long to answer. Try again in a moment.'
                    : 'Could not reach Supabase.',
                { status: 502, code: timedOut ? 'supabase_timeout' : 'supabase_unreachable' });
        }
        if (res.status >= 200 && res.status < 300) return res.data;
        throw this.explain(res);
    }

    // Supabase's message is usually the most useful thing we can show — it is
    // written for the account holder and knows things we do not (plan limits,
    // an org that needs a payment method). Pass it through for the cases where
    // it helps, and replace it where our own wording is clearer.
    explain(res) {
        const body = res.data || {};
        const detail = String(body.message || body.error || body.msg || '').slice(0, 400);
        if (res.status === 401 || res.status === 403) {
            return new SetupError(
                'Supabase rejected that access token. Create a fresh one at supabase.com/dashboard/account/tokens and paste it again.',
                { status: 400, code: 'bad_token', detail });
        }
        if (res.status === 404) {
            return new SetupError('That Supabase project no longer exists on this account.',
                { status: 404, code: 'project_not_found', detail });
        }
        if (res.status === 429) {
            return new SetupError('Supabase is rate-limiting this account. Wait a minute and try again.',
                { status: 429, code: 'rate_limited', detail });
        }
        return new SetupError(detail || `Supabase returned HTTP ${res.status}.`,
            { status: 502, code: 'supabase_error', detail });
    }

    listProjects() { return this.request('get', '/v1/projects'); }
    getProject(ref) { return this.request('get', `/v1/projects/${encodeURIComponent(ref)}`); }
    listOrganizations() { return this.request('get', '/v1/organizations'); }
    createProject(body) { return this.request('post', '/v1/projects', body); }
    // `reveal=true` returns the key values themselves rather than just their
    // names — this endpoint is the reason the VA never has to copy them.
    apiKeys(ref) { return this.request('get', `/v1/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`); }
    runSql(ref, query) {
        return this.request('post', `/v1/projects/${encodeURIComponent(ref)}/database/query`, { query });
    }
}

// ---------------------------------------------------------------------------
// Shapes we hand to the browser. Deliberately narrow: a project's id, name,
// region and status is everything the picker needs, and anything else on the
// Management API's project object is the VA's business, not ours to relay.
// ---------------------------------------------------------------------------
const publicProject = (p) => p && {
    ref: p.id || p.ref || '',
    name: p.name || '',
    region: p.region || '',
    status: p.status || '',
    ready: (p.status || '') === HEALTHY,
    createdAt: p.created_at || null,
};

const projectUrl = (ref) => `https://${ref}.supabase.co`;

// A database password for a project we create. The VA never needs it (nothing
// here connects to Postgres directly — everything goes through PostgREST with
// the service key), so it is generated, used once and forgotten. If they ever
// do want direct SQL access, Supabase can reset it from their dashboard.
const generateDbPassword = () => crypto.randomBytes(24).toString('base64url');

// Pull the anon + service_role keys out of whatever shape the API returned.
// Supabase has published these under a couple of field names over time; check
// the ones we know rather than assuming one.
function extractKeys(rows) {
    const out = { anonKey: '', serviceKey: '' };
    for (const row of Array.isArray(rows) ? rows : []) {
        const name = String(row.name || row.id || '').toLowerCase();
        const value = row.api_key || row.apiKey || row.key || '';
        if (!value) continue;
        if (name === 'anon' || name === 'anon_key' || name === 'publishable') out.anonKey = out.anonKey || value;
        if (name === 'service_role' || name === 'service_role_key' || name === 'secret') out.serviceKey = out.serviceKey || value;
    }
    return out;
}

/**
 * Run the crew center schema against a project.
 *
 * The SQL is our own file, served from the repo — never anything a caller
 * supplied — so this is not an arbitrary-SQL endpoint wearing a hat. It is
 * idempotent, so re-running it to pick up a new schema version is the normal
 * upgrade path rather than a risk.
 */
async function installSchema(mgmt, ref, sql) {
    if (!sql || !/create table if not exists crew_members/i.test(sql)) {
        throw new SetupError('The setup script could not be read on our side. Try again shortly.',
            { status: 500, code: 'schema_unavailable' });
    }
    try {
        await mgmt.runSql(ref, sql);
    } catch (err) {
        if (err instanceof SetupError && err.code === 'supabase_error') {
            throw new SetupError(
                'Supabase refused to run the setup script on that project. Its own message: ' + (err.detail || 'no detail given'),
                { status: 502, code: 'schema_install_failed', detail: err.detail });
        }
        throw err;
    }
}

/**
 * The whole setup, as one resumable step.
 *
 * Resumable because creating a Supabase project takes a minute or two, which is
 * longer than a request should be held open: when the project is not up yet
 * this returns `{ ready: false, stage: 'provisioning' }` and the caller polls
 * with the same token and ref until it is. Every stage is safe to repeat — the
 * schema install is idempotent, and saving the connection twice writes the same
 * values.
 *
 * @param {Object} opts
 * @param {string} opts.accessToken   the VA's Supabase personal access token
 * @param {string} [opts.projectRef]  an existing project to use
 * @param {Object} [opts.create]      { name, region, organizationId } to make a new one
 * @param {string} opts.sql           the schema to install
 * @param {Function} opts.save        async ({ url, anonKey, serviceKey }) => void
 * @param {Function} opts.verify      async ({ url, anonKey, serviceKey }) => health
 */
async function provision({ accessToken, projectRef = '', create = null, sql, save, verify }) {
    const mgmt = new Management(accessToken);
    let ref = String(projectRef || '').trim();
    let created = false;

    if (!ref) {
        if (!create) throw new SetupError('Pick a project, or ask us to create one.', { status: 400, code: 'no_project' });
        const name = String(create.name || '').trim().slice(0, 60) || 'crew-center';
        const organizationId = String(create.organizationId || '').trim();
        const region = String(create.region || 'us-east-1').trim();
        if (!organizationId) {
            throw new SetupError('Choose which Supabase organization the project belongs to.',
                { status: 400, code: 'no_organization' });
        }
        const project = await mgmt.createProject({
            name,
            organization_id: organizationId,
            region,
            db_pass: generateDbPassword(),
        });
        ref = project && (project.id || project.ref);
        if (!ref) throw new SetupError('Supabase created the project but did not say which one.', { status: 502, code: 'no_ref' });
        created = true;
    }

    // Is it up? A project that is still coming up will accept neither DDL nor a
    // key read, so stop here and let the caller poll.
    const project = await mgmt.getProject(ref);
    if (!project || (project.status && project.status !== HEALTHY)) {
        return {
            ready: false,
            created,
            stage: 'provisioning',
            project: publicProject(project || { id: ref }),
            message: created
                ? 'Supabase is building your project. This usually takes a minute or two.'
                : 'That project is still starting up. Give it a moment.',
        };
    }

    await installSchema(mgmt, ref, sql);

    const keys = extractKeys(await mgmt.apiKeys(ref));
    if (!keys.serviceKey) {
        throw new SetupError(
            'The tables are installed, but Supabase would not hand over that project’s service_role key. Copy it from Settings → API and paste it below instead.',
            { status: 502, code: 'keys_unavailable' });
    }

    const connection = { url: projectUrl(ref), anonKey: keys.anonKey, serviceKey: keys.serviceKey };
    await save(connection);

    // Prove it end to end over the path every real write takes, rather than
    // trusting that the previous four calls added up to a working connection.
    const health = await verify(connection);

    return {
        ready: true,
        created,
        stage: 'connected',
        project: publicProject(project),
        url: connection.url,
        health,
    };
}

module.exports = {
    Management,
    SetupError,
    provision,
    installSchema,
    extractKeys,
    publicProject,
    projectUrl,
    generateDbPassword,
    HEALTHY,
    API_URL,
};

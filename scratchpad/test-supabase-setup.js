'use strict';
// Conformance test for crewSetup — the one-paste path that turns a Supabase
// access token into a provisioned, connected crew center database.
//
// It stands up an impersonator of the bits of the Supabase Management API this
// module uses (list projects, list organizations, create a project, run SQL,
// reveal API keys) and drives the real provisioning flow against it. The
// properties worth defending here are not "does it call five endpoints" — they
// are:
//
//   * the access token is used and then GONE: never handed to `save`, never in
//     what we return, never written anywhere we can see
//   * a project that is still coming up parks the flow instead of failing it,
//     and polling again finishes the job (this is the normal case for a
//     project we just created, which takes a minute or two to boot)
//   * the schema we execute is the repo's own file — not anything a caller
//     supplied
//   * the service_role key reaches storage and never reaches the reply
//   * Supabase's own error text survives, because it knows things we don't
//     (plan limits, an org that needs a card) and the VA is the one who can act
//     on it
//
// No network beyond loopback; SUPABASE_API_URL points the client at the fake.

const http = require('http');
const path = require('path');
const fs = require('fs');

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ❌', label, '\n     got', JSON.stringify(got), '\n     exp', JSON.stringify(expected));
};
const OK = (label, cond, note) => {
    if (cond) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ❌', label, note ? `\n     ${note}` : '');
};

const GOOD_TOKEN = 'sbp_test_token_value';

// The fake account: one project that is already up, and room for one we create.
const projects = [
    { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'my-other-app', region: 'eu-west-2', status: 'ACTIVE_HEALTHY', created_at: '2026-01-01T00:00:00Z' },
];
const ranSql = [];        // every statement we were asked to execute
const seenAuth = [];      // every Authorization header we received

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    seenAuth.push(req.headers.authorization || '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const send = (code, payload) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
            return send(401, { message: 'Unauthorized' });
        }
        const data = body ? JSON.parse(body) : null;
        const p = url.pathname;

        if (p === '/v1/projects' && req.method === 'GET') return send(200, projects);
        if (p === '/v1/organizations') return send(200, [{ id: 'org-1', name: 'Skyward Virtual' }]);
        if (p === '/v1/projects' && req.method === 'POST') {
            if (!data.db_pass || String(data.db_pass).length < 12) return send(400, { message: 'db_pass too weak' });
            const project = {
                id: 'bbbbbbbbbbbbbbbbbbbb', name: data.name, region: data.region,
                // A brand new project is NOT up yet. This is the case the
                // resumable flow exists for.
                status: 'COMING_UP', created_at: new Date().toISOString(),
            };
            projects.push(project);
            return send(201, project);
        }
        const m = p.match(/^\/v1\/projects\/([^/]+)(\/.*)?$/);
        if (m) {
            const project = projects.find((x) => x.id === m[1]);
            if (!project) return send(404, { message: 'Project not found' });
            const rest = m[2] || '';
            if (!rest) return send(200, project);
            if (rest.startsWith('/api-keys')) {
                return send(200, [
                    { name: 'anon', api_key: `anon-key-for-${project.id}` },
                    { name: 'service_role', api_key: `service-key-for-${project.id}` },
                ]);
            }
            if (rest === '/database/query') {
                if (project.status !== 'ACTIVE_HEALTHY') return send(503, { message: 'Project is not ready' });
                ranSql.push({ ref: project.id, query: data.query });
                return send(201, []);
            }
        }
        send(404, { message: 'no such endpoint' });
    });
});

(async function run() {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.SUPABASE_API_URL = `http://127.0.0.1:${server.address().port}`;
    const crewSetup = require(path.join('..', 'crewSetup.js'));
    const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'crew-center-schema.sql'), 'utf8');

    console.log('\ncrewSetup — one-paste Supabase setup\n');

    // --- Looking at the account ---
    console.log('reading the account with a pasted token');
    const mgmt = new crewSetup.Management(GOOD_TOKEN);
    const listed = (await mgmt.listProjects()).map(crewSetup.publicProject);
    T('projects come back in the picker’s shape', listed[0],
        { ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'my-other-app', region: 'eu-west-2', status: 'ACTIVE_HEALTHY', ready: true, createdAt: '2026-01-01T00:00:00Z' });

    let bad = null;
    try { await new crewSetup.Management('sbp_wrong').listProjects(); } catch (e) { bad = e; }
    T('a bad token is the VA’s mistake, not a gateway failure', bad && bad.status, 400);
    T('with a code the dashboard can branch on', bad && bad.code, 'bad_token');
    OK('and a message telling them where to make a new one', /account\/tokens/.test(bad.message), bad.message);

    // --- The whole flow against an existing project ---
    console.log('\nsetting up an existing project');
    const saved = [];
    const verified = [];
    const out = await crewSetup.provision({
        accessToken: GOOD_TOKEN,
        projectRef: 'aaaaaaaaaaaaaaaaaaaa',
        sql: SQL,
        save: async (c) => { saved.push(c); },
        verify: async (c) => { verified.push(c); return { ok: true, provisioned: true, version: 3, accounts: true }; },
    });
    T('it reports itself done', { ready: out.ready, stage: out.stage, created: out.created }, { ready: true, stage: 'connected', created: false });
    T('the project url is derived from the ref', out.url, 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co');
    T('the schema was executed against that project', ranSql.length, 1);
    OK('and what ran is OUR file, verbatim', ranSql[0].query === SQL);
    OK('which creates the pilot-logins table', /create table if not exists crew_accounts/i.test(ranSql[0].query));
    T('both keys were fetched and stored', saved[0],
        { url: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', anonKey: 'anon-key-for-aaaaaaaaaaaaaaaaaaaa', serviceKey: 'service-key-for-aaaaaaaaaaaaaaaaaaaa' });
    T('the connection was proved end to end afterwards', verified.length, 1);
    T('and the health it reported comes back', out.health.accounts, true);

    // --- What must NOT be in the result ---
    console.log('\nwhat happens to the token');
    const serialised = JSON.stringify(out);
    OK('the access token is not in the reply', !serialised.includes(GOOD_TOKEN), serialised);
    OK('nor is the service_role key', !serialised.includes('service-key-for-'), serialised);
    OK('the token was never passed to the save callback',
        !JSON.stringify(saved).includes(GOOD_TOKEN));
    OK('it only ever went to Supabase, as a bearer header',
        seenAuth.every((a) => a === `Bearer ${GOOD_TOKEN}` || a === 'Bearer sbp_wrong'));

    // --- Creating a project, which takes a while ---
    console.log('\ncreating a new project');
    const call = (extra) => crewSetup.provision({
        accessToken: GOOD_TOKEN, sql: SQL,
        save: async (c) => { saved.push(c); },
        verify: async () => ({ ok: true, provisioned: true, version: 3, accounts: true }),
        ...extra,
    });

    let noOrg = null;
    try { await call({ create: { name: 'skyward-crew', region: 'us-east-1' } }); } catch (e) { noOrg = e; }
    T('an organization is required to create one', noOrg && noOrg.code, 'no_organization');

    const creating = await call({ create: { name: 'skyward-crew', region: 'us-east-1', organizationId: 'org-1' } });
    T('a fresh project parks rather than fails', { ready: creating.ready, stage: creating.stage }, { ready: false, stage: 'provisioning' });
    T('it says the project was created', creating.created, true);
    T('and hands back the ref to poll with', creating.project.ref, 'bbbbbbbbbbbbbbbbbbbb');
    OK('with something honest to show the VA meanwhile', /minute or two/.test(creating.message), creating.message);
    T('nothing was stored for a project that isn’t up', saved.length, 1);

    // Supabase finishes booting it.
    projects.find((x) => x.id === 'bbbbbbbbbbbbbbbbbbbb').status = 'ACTIVE_HEALTHY';
    const polled = await call({ projectRef: 'bbbbbbbbbbbbbbbbbbbb' });
    T('polling with the same ref finishes the job', { ready: polled.ready, stage: polled.stage }, { ready: true, stage: 'connected' });
    T('the schema ran on the new project too', ranSql[1].ref, 'bbbbbbbbbbbbbbbbbbbb');
    T('and its connection was stored', saved[1].url, 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co');

    // Re-running the whole thing is how a VA picks up a new schema version.
    const rerun = await call({ projectRef: 'bbbbbbbbbbbbbbbbbbbb' });
    T('re-running it is safe and just re-installs', rerun.ready, true);
    T('the SQL is idempotent, so it simply ran again', ranSql.length, 3);

    // --- Refusals ---
    console.log('\nrefusals');
    let noProject = null;
    try { await call({}); } catch (e) { noProject = e; }
    T('no project and no instruction to create one', noProject && noProject.code, 'no_project');

    let gone = null;
    try { await call({ projectRef: 'cccccccccccccccccccc' }); } catch (e) { gone = e; }
    T('a project that isn’t on the account', gone && gone.status, 404);

    let junkSql = null;
    try { await call({ projectRef: 'aaaaaaaaaaaaaaaaaaaa', sql: 'drop table users;' }); } catch (e) { junkSql = e; }
    T('a schema that isn’t ours is refused before it is executed', junkSql && junkSql.code, 'schema_unavailable');
    T('and nothing extra was run', ranSql.length, 3);

    // --- Key extraction ---
    console.log('\nreading keys back');
    T('the shapes Supabase has used over time',
        crewSetup.extractKeys([{ name: 'anon', api_key: 'a' }, { name: 'service_role', api_key: 's' }]),
        { anonKey: 'a', serviceKey: 's' });
    T('a project that reveals nothing usable',
        crewSetup.extractKeys([{ name: 'anon' }]), { anonKey: '', serviceKey: '' });

    server.close();
    console.log(failures ? `\n${failures} failing check(s)\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

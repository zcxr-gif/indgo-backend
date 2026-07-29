'use strict';

/*
 * crewStore.js
 * Where a VA's crew data actually lives.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * --------------------------------------
 * A VA's operational data belongs to the VA and is stored in the VA's own
 * Supabase project — never in ours. Inflight keeps only what it needs to run
 * the platform: the VA's *staff* logins, and the VA's directory/branding
 * metadata (name, slug, colours, fleet definitions, rank ladder, join
 * requirements). Rosters, flight reports, applications, applicant emails and
 * pilot accounts are created in, read from and deleted from the VA's project.
 *
 * Two adapters implement one interface:
 *
 *   SupabaseStore  The real one. Talks PostgREST to the VA's project with their
 *                  service key. See supabase/crew-center-schema.sql for the
 *                  tables it expects.
 *   LegacyStore    Read/write against our old Mongo collections. It exists for
 *                  exactly one reason: VAs onboarded before bring-your-own-data
 *                  still have rows here, and they must keep working until they
 *                  have migrated. It is never handed to a VA that has never had
 *                  managed data — those get a clear "connect your data store"
 *                  error instead (see forVa + REQUIRE_OWN_STORE).
 *
 * SHAPE PARITY
 * ------------
 * Both adapters return plain objects in the SAME shape the Mongo documents used
 * (`_id`, camelCase fields, Date instances for timestamps). That is deliberate:
 * the route handlers, the public serialisers (publicMember/publicRoute/
 * publicPirep) and the Discord/email notifiers were all written against that
 * shape and none of them had to learn about Postgres.
 *
 * Env:
 *   CREW_STORE_REQUIRE_OWN   'false' lets a VA with no Supabase connection fall
 *                            back to managed Mongo storage indefinitely. The
 *                            default (unset/'true') is the policy: a VA with no
 *                            connection and no legacy rows cannot store data.
 *   CREW_STORE_TIMEOUT_MS    per-request timeout to the VA's project (default 8000).
 */

const axios = require('axios');

const TIMEOUT_MS = parseInt(process.env.CREW_STORE_TIMEOUT_MS, 10) || 8000;
const REQUIRE_OWN_STORE = String(process.env.CREW_STORE_REQUIRE_OWN || 'true').toLowerCase() !== 'false';

// The schema version this code is written against. A project reporting an older
// version still works for everything that existed then — every column we read
// has existed since v1 — but the health endpoint flags it so the VA knows to
// re-run the SQL. Pilot logins (crew_accounts) arrived in v3 and are the one
// feature that genuinely needs the newer schema; see accountsSupported().
const EXPECTED_SCHEMA_VERSION = 5;

// The version that introduced crew_accounts.
const ACCOUNTS_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Columns that arrived after the first release
//
// A VA installs the schema once and, unless something tells them to, never
// thinks about it again. The code moves on: v4 gave an application an
// invitation, v5 split the network into own/codeshare and gated routes on rank.
// A project still on v3 has none of those columns, and PostgREST refuses a
// write that mentions one — it fails the WHOLE row rather than the column, so
// "add a route" returned a bare 502 on every VA who had not re-run the SQL.
// That is our schema drift, showing up as their outage.
//
// So writes degrade instead of failing: a column the project has not got is
// dropped and the write is retried, the store records that it did so, and the
// handler tells the VA what did not make it (see `drift` below and the
// database-update banner in the dashboard). The pilot still gets added; the
// codeshare flag is what waits for the upgrade.
//
// ONLY columns listed here may be dropped. Every one of them is additive and
// carries a default, so a row written without it is a valid row on the old
// shape — which is precisely what makes dropping it safe. Anything else that
// goes missing is a real fault and still fails loudly.
//
// This is the mirror of the `alter table ... add column if not exists` block in
// supabase/crew-center-schema.sql. Add a column there, add it here.
// ---------------------------------------------------------------------------
const LATE_COLUMNS = {
    crew_routes: new Set(['kind', 'partner_name', 'partner_logo', 'min_rank']),
    crew_applications: new Set([
        'discord_invite', 'invite_username', 'invite_password',
        'invite_issued_at', 'invite_claimed_at', 'invite_revoked_at', 'invite_account_id',
    ]),
};

// What each dropped column costs, in words a VA reads rather than column names.
const DRIFT_LABELS = {
    'crew_routes.kind': 'codeshare routes',
    'crew_routes.partner_name': 'codeshare partner names',
    'crew_routes.partner_logo': 'codeshare partner logos',
    'crew_routes.min_rank': 'rank-gated routes',
    'crew_applications.discord_invite': 'Discord invites on acceptances',
    'crew_applications.invite_username': 'saved pilot invitations',
    'crew_applications.invite_password': 'saved pilot invitations',
    'crew_applications.invite_issued_at': 'saved pilot invitations',
    'crew_applications.invite_claimed_at': 'saved pilot invitations',
    'crew_applications.invite_revoked_at': 'saved pilot invitations',
    'crew_applications.invite_account_id': 'saved pilot invitations',
};

const isLateColumn = (table, col) => !!(LATE_COLUMNS[table] && LATE_COLUMNS[table].has(col));

// Remembered per project, not per request: a VA on an old schema would
// otherwise spend one wasted round trip per missing column on every single
// write. The TTL is what lets an upgrade take effect on its own — and
// forgetSchemaDrift() below clears it the moment we install a schema ourselves,
// so the dashboard's "Update database" button never leaves the VA looking at
// stale degradation.
const MISSING_TTL_MS = 10 * 60 * 1000;
const _missingColumns = new Map();   // `${base}|${table}` -> { at, cols:Set }

function missingFor(base, table) {
    const hit = _missingColumns.get(`${base}|${table}`);
    if (!hit) return null;
    if (Date.now() - hit.at > MISSING_TTL_MS) { _missingColumns.delete(`${base}|${table}`); return null; }
    return hit.cols;
}
function noteMissing(base, table, col) {
    const cols = missingFor(base, table);
    if (cols) { cols.add(col); return; }
    _missingColumns.set(`${base}|${table}`, { at: Date.now(), cols: new Set([col]) });
}
/** Forget what a project was missing — call after installing a schema on it. */
function forgetSchemaDrift(url) {
    const base = String(url || '').replace(/\/+$/, '');
    if (!base) { _missingColumns.clear(); return; }
    for (const key of [..._missingColumns.keys()]) {
        if (key.startsWith(`${base}/rest/v1|`)) _missingColumns.delete(key);
    }
}

// Mongo models, injected by server.js so this module doesn't reach into the
// app's DB wiring. Only the legacy adapter touches them.
let models = null;

function configure(m) { models = m || null; }

// ---------------------------------------------------------------------------
// Errors
//
// Handlers map `status` straight onto the HTTP reply, so a failure inside the
// VA's project surfaces as something the VA can act on ("your data store is
// unreachable") rather than a generic 500 that looks like our bug.
// ---------------------------------------------------------------------------
class CrewStoreError extends Error {
    constructor(message, { status = 502, code = 'store_error', detail = '' } = {}) {
        super(message);
        this.name = 'CrewStoreError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

const NOT_CONNECTED = () => new CrewStoreError(
    'This VA has not connected a data store yet. Connect your Supabase project in Crew Center → Settings → Data store.',
    { status: 409, code: 'store_not_connected' });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const icao = (v) => str(v, 8).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const num = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
};
const int = (v, min, max) => Math.round(num(v, min, max));
// PostgREST returns timestamptz as an ISO string; Mongo gives a Date. Callers
// (and JSON.stringify) want one of the two, consistently.
const date = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------------------
// Row mapping: Postgres snake_case <-> the camelCase document shape.
//
// Each entity has a `fromRow` (Postgres -> document) and a `toRow` (document ->
// Postgres). toRow only emits keys that were actually supplied, so a PATCH of
// one field does not overwrite the other twenty with defaults.
// ---------------------------------------------------------------------------
const pick = (obj, out, key, col, fn) => {
    if (obj[key] !== undefined) out[col] = fn(obj[key]);
};

const memberFromRow = (r) => r && {
    _id: r.id,
    name: r.name || '',
    callsign: r.callsign || '',
    hours: Number(r.hours) || 0,
    role: r.role || '',
    aircraft: Array.isArray(r.aircraft) ? r.aircraft : [],
    status: r.status || 'active',
    ifUserId: r.if_user_id || '',
    ifcName: r.ifc_name || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const memberToRow = (m) => {
    const out = {};
    pick(m, out, 'name', 'name', (v) => str(v, 60));
    pick(m, out, 'callsign', 'callsign', (v) => str(v, 20));
    pick(m, out, 'hours', 'hours', (v) => num(v, 0, 1e6));
    pick(m, out, 'role', 'role', (v) => str(v, 40));
    pick(m, out, 'aircraft', 'aircraft', (v) => (Array.isArray(v) ? v.slice(0, 40).map((a) => str(a, 40)).filter(Boolean) : []));
    pick(m, out, 'status', 'status', (v) => (['active', 'loa', 'inactive'].includes(v) ? v : 'active'));
    pick(m, out, 'ifUserId', 'if_user_id', (v) => str(v, 40));
    pick(m, out, 'ifcName', 'ifc_name', (v) => str(v, 60));
    return out;
};

// A crew center login. `passwordHash` is carried in the document shape because
// the caller that compares a password needs it — nothing else may read it, and
// no serialiser in the app emits it (see publicAccount in crewAccounts.js).
const accountFromRow = (r) => r && {
    _id: r.id,
    username: r.username || '',
    displayName: r.display_name || '',
    passwordHash: r.password_hash || '',
    role: r.role || 'pilot',
    memberId: r.member_id || null,
    email: r.email || '',
    active: r.active !== false,
    mustChangePassword: !!r.must_change_password,
    createdVia: r.created_via || '',
    createdByName: r.created_by_name || '',
    lastLoginAt: date(r.last_login_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const accountToRow = (a) => {
    const out = {};
    pick(a, out, 'username', 'username', (v) => str(v, 60).toLowerCase());
    pick(a, out, 'displayName', 'display_name', (v) => str(v, 80));
    pick(a, out, 'passwordHash', 'password_hash', (v) => str(v, 120));
    pick(a, out, 'role', 'role', (v) => (['pilot', 'staff', 'owner'].includes(v) ? v : 'pilot'));
    pick(a, out, 'memberId', 'member_id', (v) => v || null);
    pick(a, out, 'email', 'email', (v) => str(v, 120).toLowerCase());
    pick(a, out, 'active', 'active', (v) => !!v);
    pick(a, out, 'mustChangePassword', 'must_change_password', (v) => !!v);
    pick(a, out, 'createdVia', 'created_via', (v) => str(v, 40));
    pick(a, out, 'createdByName', 'created_by_name', (v) => str(v, 80));
    pick(a, out, 'lastLoginAt', 'last_login_at', (v) => (date(v) ? date(v).toISOString() : null));
    return out;
};

const routeFromRow = (r) => r && {
    _id: r.id,
    flightNumber: r.flight_number || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraft: r.aircraft || '',
    distanceNm: Number(r.distance_nm) || 0,
    notes: r.notes || '',
    active: r.active !== false,
    // v5. `kind` defaults to 'own' rather than '' so a route read from a
    // pre-v5 project sorts with the airline's own network instead of falling
    // into a third, nonexistent category.
    kind: r.kind === 'codeshare' ? 'codeshare' : 'own',
    partnerName: r.partner_name || '',
    partnerLogo: r.partner_logo || '',
    minRank: r.min_rank || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const routeToRow = (r) => {
    const out = {};
    pick(r, out, 'flightNumber', 'flight_number', (v) => str(v, 12));
    pick(r, out, 'origin', 'origin', icao);
    pick(r, out, 'destination', 'destination', icao);
    pick(r, out, 'aircraft', 'aircraft', (v) => str(v, 60));
    pick(r, out, 'distanceNm', 'distance_nm', (v) => int(v, 0, 20000));
    pick(r, out, 'notes', 'notes', (v) => str(v, 500));
    pick(r, out, 'active', 'active', (v) => !!v);
    pick(r, out, 'kind', 'kind', (v) => (v === 'codeshare' ? 'codeshare' : 'own'));
    pick(r, out, 'partnerName', 'partner_name', (v) => str(v, 60));
    // A logo lands in an <img> on a public crew center page, so anything that
    // is not plainly an https URL is dropped rather than rendered.
    pick(r, out, 'partnerLogo', 'partner_logo', (v) => {
        const s = str(v, 600);
        return /^https:\/\//i.test(s) ? s : '';
    });
    pick(r, out, 'minRank', 'min_rank', (v) => str(v, 40));
    return out;
};

const pirepFromRow = (r) => r && {
    _id: r.id,
    memberId: r.member_id || null,
    routeId: r.route_id || null,
    pilotName: r.pilot_name || '',
    callsign: r.callsign || '',
    flightNumber: r.flight_number || '',
    ifUserId: r.if_user_id || '',
    flightId: r.flight_id || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraftName: r.aircraft_name || '',
    liveryName: r.livery_name || '',
    durationMin: Number(r.duration_min) || 0,
    landings: Number(r.landings) || 0,
    xp: Number(r.xp) || 0,
    violations: Number(r.violations) || 0,
    distanceNm: Number(r.distance_nm) || 0,
    server: r.server || '',
    inFleet: !!r.in_fleet,
    source: r.source || 'auto',
    status: r.status || 'pending',
    hoursApplied: !!r.hours_applied,
    flownAt: date(r.flown_at),
    reviewedAt: date(r.reviewed_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const pirepToRow = (p) => {
    const out = {};
    pick(p, out, 'memberId', 'member_id', (v) => v || null);
    pick(p, out, 'routeId', 'route_id', (v) => v || null);
    pick(p, out, 'pilotName', 'pilot_name', (v) => str(v, 60));
    pick(p, out, 'callsign', 'callsign', (v) => str(v, 20));
    pick(p, out, 'flightNumber', 'flight_number', (v) => str(v, 12));
    pick(p, out, 'ifUserId', 'if_user_id', (v) => str(v, 40));
    pick(p, out, 'flightId', 'flight_id', (v) => str(v, 60));
    pick(p, out, 'origin', 'origin', icao);
    pick(p, out, 'destination', 'destination', icao);
    pick(p, out, 'aircraftName', 'aircraft_name', (v) => str(v, 60));
    pick(p, out, 'liveryName', 'livery_name', (v) => str(v, 80));
    pick(p, out, 'durationMin', 'duration_min', (v) => int(v, 0, 100000));
    pick(p, out, 'landings', 'landings', (v) => int(v, 0, 100));
    pick(p, out, 'xp', 'xp', (v) => int(v, 0, 1e9));
    pick(p, out, 'violations', 'violations', (v) => int(v, 0, 10000));
    pick(p, out, 'distanceNm', 'distance_nm', (v) => int(v, 0, 20000));
    pick(p, out, 'server', 'server', (v) => str(v, 40));
    pick(p, out, 'inFleet', 'in_fleet', (v) => !!v);
    pick(p, out, 'source', 'source', (v) => (v === 'manual' ? 'manual' : 'auto'));
    pick(p, out, 'status', 'status', (v) => (['pending', 'approved', 'rejected'].includes(v) ? v : 'pending'));
    pick(p, out, 'hoursApplied', 'hours_applied', (v) => !!v);
    pick(p, out, 'flownAt', 'flown_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(p, out, 'reviewedAt', 'reviewed_at', (v) => (date(v) ? date(v).toISOString() : null));
    return out;
};

const applicationFromRow = (r) => r && {
    _id: r.id,
    ifcName: r.ifc_name || '',
    email: r.email || '',
    callsignPrefix: r.callsign_prefix || '',
    callsignNumber: r.callsign_number || '',
    grade: Number(r.grade) || 0,
    ifVerified: !!r.if_verified,
    ifUserId: r.if_user_id || '',
    answers: Array.isArray(r.answers) ? r.answers : [],
    status: r.status || 'pending',
    staffMessage: r.staff_message || '',
    statusToken: r.status_token || '',
    // The Discord invite the pilot was sent on acceptance, kept so their status
    // page can show it again — an emailed invite is easy to lose, and an
    // applicant with no email has the status link as their only copy.
    discordInvite: r.discord_invite || '',
    // The invitation handed to an accepted applicant. `invitePassword` is a live
    // credential for as long as it is non-empty — see crewInvite.js for the
    // lifecycle, and the schema for why it is stored at all. Handlers must run
    // it through crewInvite.inviteState() rather than reading it directly: a
    // password that is still in the column but claimed, revoked or expired must
    // not be shown to anyone.
    inviteUsername: r.invite_username || '',
    invitePassword: r.invite_password || '',
    inviteIssuedAt: date(r.invite_issued_at),
    inviteClaimedAt: date(r.invite_claimed_at),
    inviteRevokedAt: date(r.invite_revoked_at),
    inviteAccountId: r.invite_account_id || null,
    reviewedAt: date(r.reviewed_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const applicationToRow = (a) => {
    const out = {};
    pick(a, out, 'ifcName', 'ifc_name', (v) => str(v, 60));
    pick(a, out, 'email', 'email', (v) => str(v, 120).toLowerCase());
    pick(a, out, 'callsignPrefix', 'callsign_prefix', (v) => str(v, 10));
    pick(a, out, 'callsignNumber', 'callsign_number', (v) => str(v, 10));
    pick(a, out, 'grade', 'grade', (v) => int(v, 0, 5));
    pick(a, out, 'ifVerified', 'if_verified', (v) => !!v);
    pick(a, out, 'ifUserId', 'if_user_id', (v) => str(v, 40));
    pick(a, out, 'answers', 'answers', (v) => (Array.isArray(v)
        ? v.slice(0, 50).map((x) => ({ q: str(x && x.q, 120), a: str(x && x.a, 2000) })) : []));
    pick(a, out, 'status', 'status', (v) => (['pending', 'accepted', 'declined'].includes(v) ? v : 'pending'));
    pick(a, out, 'staffMessage', 'staff_message', (v) => str(v, 2000));
    pick(a, out, 'statusToken', 'status_token', (v) => str(v, 64));
    pick(a, out, 'discordInvite', 'discord_invite', (v) => str(v, 200));
    pick(a, out, 'inviteUsername', 'invite_username', (v) => str(v, 60));
    pick(a, out, 'invitePassword', 'invite_password', (v) => str(v, 128));
    pick(a, out, 'inviteIssuedAt', 'invite_issued_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(a, out, 'inviteClaimedAt', 'invite_claimed_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(a, out, 'inviteRevokedAt', 'invite_revoked_at', (v) => (date(v) ? date(v).toISOString() : null));
    // A uuid column: '' is not a valid uuid, so an empty id has to go as null.
    pick(a, out, 'inviteAccountId', 'invite_account_id', (v) => (str(v, 64) || null));
    pick(a, out, 'reviewedAt', 'reviewed_at', (v) => (date(v) ? date(v).toISOString() : null));
    return out;
};

// ---------------------------------------------------------------------------
// PostgREST transport
//
// A thin wrapper rather than @supabase/supabase-js: the client library adds a
// dependency (and an auth/realtime stack) for what is, at this level, four HTTP
// verbs against one host. axios is already the backend's HTTP client.
// ---------------------------------------------------------------------------
// Which column did the project not have? PostgREST says
//   Could not find the 'kind' column of 'crew_routes' in the schema cache
// and Postgres itself says
//   column "kind" of relation "crew_routes" does not exist
// Both are matched because a filter or a select produces the second one where a
// write produces the first.
//
// Narrowly, though: plenty of Postgres errors name a column ("null value in
// column \"name\" violates …") and reading one of those as a schema-version
// problem would drop the VA's data on the floor and call it an upgrade. Only
// the two "this column is not there" phrasings count; everything else gets ''.
function missingColumnFrom(body) {
    const text = [body && body.message, body && body.details, body && body.hint]
        .filter(Boolean).join(' ');
    if (!/schema cache|does not exist/i.test(text)) return '';
    const m = text.match(/could not find the\s+['"]([a-z0-9_]+)['"]\s+column/i)
        || text.match(/column\s+['"]?([a-z0-9_]+)['"]?\s+(?:of relation\s+['"]?[a-z0-9_.]+['"]?\s+)?does not exist/i);
    return m ? m[1] : '';
}

class Postgrest {
    constructor(url, serviceKey) {
        this.base = String(url).replace(/\/+$/, '') + '/rest/v1';
        this.key = serviceKey;
        // Columns this request had to drop because the project has not got
        // them. Per-instance (one store per request) so a handler can tell the
        // VA what its write did not include — see SupabaseStore.drift.
        this.dropped = new Set();
    }

    get headers() {
        return {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }

    async request(method, path, { params, data, prefer } = {}) {
        const headers = this.headers;
        if (prefer) headers.Prefer = prefer;
        try {
            const res = await axios({
                method, url: `${this.base}${path}`, params, data, headers,
                timeout: TIMEOUT_MS,
                // We want to inspect PostgREST's error body ourselves rather
                // than have axios throw a message that hides it.
                validateStatus: () => true,
            });
            if (res.status >= 200 && res.status < 300) return res.data;
            throw this.explain(res);
        } catch (err) {
            if (err instanceof CrewStoreError) throw err;
            const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
            throw new CrewStoreError(
                timedOut
                    ? 'The VA’s data store did not respond in time.'
                    : 'Could not reach the VA’s data store.',
                { status: 502, code: timedOut ? 'store_timeout' : 'store_unreachable', detail: err.message || '' });
        }
    }

    // Turn a PostgREST error body into something a VA admin can act on. The
    // three cases below are the ones people actually hit while setting up.
    explain(res) {
        const body = res.data || {};
        const detail = [body.message, body.details, body.hint].filter(Boolean).join(' — ');
        if (res.status === 401 || res.status === 403) {
            return new CrewStoreError(
                'The VA’s data store rejected our credentials. Re-copy the service key from Supabase → Settings → API.',
                { status: 502, code: 'store_unauthorized', detail });
        }
        // 404 on the table itself, or PGRST205 "could not find the table".
        if (res.status === 404 || body.code === 'PGRST205' || body.code === '42P01') {
            return new CrewStoreError(
                'The VA’s data store is missing the crew center tables. Run supabase/crew-center-schema.sql in the project’s SQL editor.',
                { status: 502, code: 'store_schema_missing', detail });
        }
        // A column we write that the project has not got: the project is on an
        // older schema than this code. PGRST204 is PostgREST's schema-cache
        // miss; 42703 is Postgres' own undefined_column, which is what comes
        // back when a filter or a select names it.
        //
        // 409, not 502: nothing is broken and nothing is unreachable — the
        // VA's database is simply behind, and the fix is one button in
        // Settings → Data store. A 502 said "our end fell over", which sent
        // people to us instead of to the thing that fixes it.
        const column = missingColumnFrom(body);
        if (column || body.code === 'PGRST204' || body.code === '42703') {
            const err = new CrewStoreError(
                column
                    ? `The VA’s data store is on an older schema and has no “${column}” column. Update it in Crew Center → Settings → Data store.`
                    : 'The VA’s data store is on an older schema than this crew center. Update it in Crew Center → Settings → Data store.',
                { status: 409, code: 'store_schema_outdated', detail });
            err.column = column;
            return err;
        }
        if (res.status === 409 || body.code === '23505') {
            return new CrewStoreError('That record already exists.', { status: 409, code: 'store_conflict', detail });
        }
        return new CrewStoreError('The VA’s data store returned an error.',
            { status: 502, code: 'store_error', detail: detail || `HTTP ${res.status}` });
    }

    select(table, params) { return this.request('get', `/${table}`, { params }); }

    insert(table, rows) {
        return this.write(table, rows, (data) => this.request('post', `/${table}`, { data, prefer: 'return=representation' }));
    }

    update(table, params, patch) {
        return this.write(table, patch, (data) => this.request('patch', `/${table}`, { params, data, prefer: 'return=representation' }));
    }

    /**
     * A write that survives a project on an older schema.
     *
     * Columns already known to be missing are left out before the first
     * attempt; one the project turns out not to have is dropped and the write
     * retried. Only columns in LATE_COLUMNS are ever dropped — see the note
     * there for why that is the safe set — so a genuinely wrong column name
     * still fails, loudly, on the first attempt.
     */
    async write(table, payload, run) {
        let data = this.strip(table, payload);
        // Bounded by the number of droppable columns: each pass removes one, so
        // this cannot spin even if the project answers oddly.
        const limit = (LATE_COLUMNS[table] ? LATE_COLUMNS[table].size : 0) + 1;
        for (let attempt = 0; ; attempt++) {
            try {
                const out = await run(data);
                return Array.isArray(out) ? out : [out];
            } catch (err) {
                const col = err && err.code === 'store_schema_outdated' ? err.column : '';
                if (!col || !isLateColumn(table, col) || attempt >= limit) throw err;
                noteMissing(this.base, table, col);
                const next = this.strip(table, payload);
                // Nothing came off — retrying would send the same body again.
                if (JSON.stringify(next) === JSON.stringify(data)) throw err;
                data = next;
            }
        }
    }

    /** The payload without the columns this project is known to lack. */
    strip(table, payload) {
        const missing = missingFor(this.base, table);
        if (!missing || !missing.size) return payload;
        const one = (row) => {
            if (!row || typeof row !== 'object') return row;
            const out = {};
            for (const [k, v] of Object.entries(row)) {
                if (missing.has(k)) { this.dropped.add(`${table}.${k}`); continue; }
                out[k] = v;
            }
            return out;
        };
        return Array.isArray(payload) ? payload.map(one) : one(payload);
    }

    remove(table, params) { return this.request('delete', `/${table}`, { params }); }

    rpc(fn, args) { return this.request('post', `/rpc/${fn}`, { data: args }); }
}

// ---------------------------------------------------------------------------
// The VA's own Supabase project
// ---------------------------------------------------------------------------
class SupabaseStore {
    constructor(va) {
        this.kind = 'supabase';
        this.owned = true;              // the VA owns this data
        this.slug = String(va.slug || '').toLowerCase();
        this.db = new Postgrest(va.supabaseUrl, va.supabaseServiceKey);
    }

    /**
     * What this request could not store because the project is on an older
     * schema — in the VA's words, not column names. Empty on a project that is
     * up to date, which is every project that has re-run the SQL.
     *
     * Handlers put this on the response so a write that quietly did less than
     * it was asked to says so, rather than looking like a success and losing a
     * codeshare flag. Nothing here is an error: the row was written.
     */
    drift() {
        const out = [];
        for (const key of this.db.dropped) {
            const label = DRIFT_LABELS[key] || key.split('.')[1];
            if (!out.includes(label)) out.push(label);
        }
        return out;
    }

    // Every query is scoped to this crew center's slug so one Supabase project
    // can safely back several brands (see the schema's multi-brand note).
    get scope() { return { va_slug: `eq.${this.slug}` }; }
    ident(id) { return { ...this.scope, id: `eq.${id}` }; }

    async one(table, params, fromRow) {
        const rows = await this.db.select(table, { ...params, limit: 1 });
        return rows && rows[0] ? fromRow(rows[0]) : null;
    }

    // --- Roster ---
    async listMembers({ limit = 2000 } = {}) {
        const rows = await this.db.select('crew_members', {
            ...this.scope, order: 'hours.desc,name.asc', limit,
        });
        return (rows || []).map(memberFromRow);
    }
    listActiveLinkedMembers({ limit = 300 } = {}) {
        return this.db.select('crew_members', {
            ...this.scope, status: 'eq.active', if_user_id: 'neq.', limit,
        }).then((rows) => (rows || []).map(memberFromRow));
    }
    getMember(id) { return this.one('crew_members', this.ident(id), memberFromRow); }
    async createMember(data) {
        const [row] = await this.db.insert('crew_members', { va_slug: this.slug, ...memberToRow(data) });
        return memberFromRow(row);
    }
    async updateMember(id, patch) {
        const [row] = await this.db.update('crew_members', this.ident(id), memberToRow(patch));
        return row ? memberFromRow(row) : null;
    }
    async deleteMember(id) { await this.db.remove('crew_members', this.ident(id)); return true; }

    // Credit or debit a pilot's hours. Read-modify-write: PostgREST has no
    // atomic increment, and the alternative (an RPC) would mean a VA whose
    // project predates that function silently loses hour crediting. The window
    // is small and the writers are our own serialised review actions.
    async addMemberHours(id, deltaHours) {
        const m = await this.getMember(id);
        if (!m) return null;
        const next = Math.max(0, (Number(m.hours) || 0) + Number(deltaHours || 0));
        return this.updateMember(id, { hours: next });
    }

    // --- Crew center logins ---
    //
    // These are the VA's pilots' accounts, and they live in the VA's project
    // like the rest of their data. A project still on a pre-v3 schema has no
    // crew_accounts table; rather than let a missing table surface as the
    // generic "run the SQL" error, upgrade() names the one thing that is
    // actually missing, because everything ELSE on that project works fine and
    // "your tables are missing" would read as a lie.
    async accounts(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the pilot-logins table yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_accounts_missing', detail: err.detail });
            }
            throw err;
        }
    }

    listAccounts({ limit = 2000 } = {}) {
        return this.accounts(async () => {
            const rows = await this.db.select('crew_accounts', { ...this.scope, order: 'username.asc', limit });
            return (rows || []).map(accountFromRow);
        });
    }
    getAccount(id) { return this.accounts(() => this.one('crew_accounts', this.ident(id), accountFromRow)); }
    // Usernames are stored lower-cased, so an equality match is the whole
    // lookup — no ilike, and the unique index answers it directly.
    getAccountByUsername(username) {
        const u = str(username, 60).toLowerCase();
        if (!u) return Promise.resolve(null);
        return this.accounts(() => this.one('crew_accounts', { ...this.scope, username: `eq.${u}` }, accountFromRow));
    }
    getAccountByMember(memberId) {
        if (!memberId) return Promise.resolve(null);
        return this.accounts(() => this.one('crew_accounts', { ...this.scope, member_id: `eq.${memberId}` }, accountFromRow));
    }
    createAccount(data) {
        return this.accounts(async () => {
            const [row] = await this.db.insert('crew_accounts', { va_slug: this.slug, ...accountToRow(data) });
            return accountFromRow(row);
        });
    }
    updateAccount(id, patch) {
        return this.accounts(async () => {
            const [row] = await this.db.update('crew_accounts', this.ident(id), accountToRow(patch));
            return row ? accountFromRow(row) : null;
        });
    }
    deleteAccount(id) {
        return this.accounts(async () => { await this.db.remove('crew_accounts', this.ident(id)); return true; });
    }

    // --- Routes ---
    async listRoutes({ activeOnly = false, limit = 3000 } = {}) {
        const params = { ...this.scope, order: 'flight_number.asc,created_at.desc', limit };
        if (activeOnly) params.active = 'is.true';
        const rows = await this.db.select('crew_routes', params);
        return (rows || []).map(routeFromRow);
    }
    getRoute(id) { return this.one('crew_routes', this.ident(id), routeFromRow); }
    async createRoute(data) {
        const [row] = await this.db.insert('crew_routes', { va_slug: this.slug, ...routeToRow(data) });
        return routeFromRow(row);
    }
    async updateRoute(id, patch) {
        const [row] = await this.db.update('crew_routes', this.ident(id), routeToRow(patch));
        return row ? routeFromRow(row) : null;
    }
    async deleteRoute(id) { await this.db.remove('crew_routes', this.ident(id)); return true; }

    // --- Flight reports ---
    async listPireps({ status = '', limit = 500 } = {}) {
        const params = { ...this.scope, order: 'flown_at.desc.nullslast,created_at.desc', limit };
        if (status) params.status = `eq.${status}`;
        const rows = await this.db.select('crew_pireps', params);
        return (rows || []).map(pirepFromRow);
    }
    getPirep(id) { return this.one('crew_pireps', this.ident(id), pirepFromRow); }
    async createPirep(data) {
        const [row] = await this.db.insert('crew_pireps', { va_slug: this.slug, ...pirepToRow(data) });
        return pirepFromRow(row);
    }
    async updatePirep(id, patch) {
        const [row] = await this.db.update('crew_pireps', this.ident(id), pirepToRow(patch));
        return row ? pirepFromRow(row) : null;
    }
    async deletePirep(id) { await this.db.remove('crew_pireps', this.ident(id)); return true; }

    // Which of these Infinite Flight flight ids have we already captured? Used
    // by the sync to skip flights without attempting (and failing) an insert.
    async seenFlightIds(flightIds) {
        const ids = (flightIds || []).map((i) => String(i)).filter(Boolean);
        if (!ids.length) return new Set();
        const rows = await this.db.select('crew_pireps', {
            ...this.scope,
            flight_id: `in.(${ids.map((i) => `"${i.replace(/"/g, '')}"`).join(',')})`,
            select: 'flight_id',
            limit: ids.length,
        });
        return new Set((rows || []).map((r) => r.flight_id));
    }

    // --- Applications ---
    async listApplications({ status = 'pending', limit = 500 } = {}) {
        const params = { ...this.scope, order: 'created_at.desc', limit };
        if (status) params.status = `eq.${status}`;
        const rows = await this.db.select('crew_applications', params);
        return (rows || []).map(applicationFromRow);
    }
    getApplication(id) { return this.one('crew_applications', this.ident(id), applicationFromRow); }
    getApplicationByToken(token) {
        return this.one('crew_applications', { ...this.scope, status_token: `eq.${token}` }, applicationFromRow);
    }
    // The invitation belonging to an account, so signing in can clear it.
    // Deliberately not filtered on a non-empty password: expressing "not the
    // empty string" in a PostgREST query string is fragile, and the caller has
    // to look at the row anyway. Cheap either way — this is one indexed lookup.
    getApplicationByInviteAccount(accountId) {
        return this.one('crew_applications', {
            ...this.scope, invite_account_id: `eq.${accountId}`,
        }, applicationFromRow);
    }
    async createApplication(data) {
        const [row] = await this.db.insert('crew_applications', { va_slug: this.slug, ...applicationToRow(data) });
        return applicationFromRow(row);
    }
    async updateApplication(id, patch) {
        const [row] = await this.db.update('crew_applications', this.ident(id), applicationToRow(patch));
        return row ? applicationFromRow(row) : null;
    }

    // --- Aggregates ---
    // One round trip via the schema's crew_stats() function. If the project is
    // on an older schema that predates it, fall back to counting client-side so
    // the figures still appear rather than the panel going blank.
    async stats() {
        try {
            const out = await this.db.rpc('crew_stats', { p_va_slug: this.slug });
            if (out && typeof out === 'object') return { ...out, source: 'supabase' };
        } catch (err) {
            if (err.code !== 'store_schema_missing') throw err;
        }
        return this.statsFallback();
    }

    async statsFallback() {
        const [members, pireps, routes] = await Promise.all([
            this.listMembers({ limit: 5000 }),
            this.listPireps({ limit: 5000 }),
            this.listRoutes({ limit: 5000 }),
        ]);
        return { ...computeStats({ members, pireps, routes, applications: [] }), source: 'supabase-fallback' };
    }

    // Is the project reachable and provisioned? Powers the settings screen's
    // green tick and tells the VA precisely what to fix when it is not.
    async health() {
        try {
            const rows = await this.db.select('crew_schema_info', { select: 'version,installed_at', limit: 1 });
            const version = rows && rows[0] ? Number(rows[0].version) : 0;
            return {
                ok: true,
                provisioned: version > 0,
                version,
                expectedVersion: EXPECTED_SCHEMA_VERSION,
                outdated: version > 0 && version < EXPECTED_SCHEMA_VERSION,
                // Can this project hold pilot logins? Reported separately from
                // `outdated` because it is the one capability an older schema
                // actually lacks, and the dashboard says so in those terms.
                accounts: version >= ACCOUNTS_SCHEMA_VERSION,
                installedAt: (rows && rows[0] && rows[0].installed_at) || null,
            };
        } catch (err) {
            return {
                ok: false,
                provisioned: false,
                version: 0,
                expectedVersion: EXPECTED_SCHEMA_VERSION,
                accounts: false,
                code: err.code || 'store_error',
                error: err.message,
                detail: err.detail || '',
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy managed storage (our Mongo)
//
// Only reachable by a VA that already has rows here. Everything it does is
// deliberately a straight translation of what the handlers used to do inline,
// so behaviour for a not-yet-migrated VA is bit-for-bit what it was.
// ---------------------------------------------------------------------------
class LegacyStore {
    constructor(va) {
        this.kind = 'managed';
        this.owned = false;             // hosted by us — the thing we're moving away from
        this.vaAdId = va._id;
        this.slug = String(va.slug || '').toLowerCase();
    }

    get q() { return { vaAdId: this.vaAdId }; }
    lean(doc) { return doc ? (doc.toObject ? doc.toObject() : doc) : null; }

    // Our own collections are never behind the code, so there is nothing to
    // report. Present so a handler can ask any store without checking which
    // kind it holds.
    drift() { return []; }

    listMembers({ limit = 2000 } = {}) {
        return models.CrewMember.find(this.q).sort({ hours: -1, name: 1 }).limit(limit).lean();
    }
    listActiveLinkedMembers({ limit = 300 } = {}) {
        return models.CrewMember.find({ ...this.q, status: 'active', ifUserId: { $exists: true, $ne: '' } })
            .limit(limit).lean();
    }
    getMember(id) { return models.CrewMember.findOne({ ...this.q, _id: id }).lean(); }
    async createMember(data) {
        return this.lean(await models.CrewMember.create({ ...this.q, ...memberDefaults(data) }));
    }
    async updateMember(id, patch) {
        const m = await models.CrewMember.findOne({ ...this.q, _id: id });
        if (!m) return null;
        Object.assign(m, patch);
        await m.save();
        return this.lean(m);
    }
    async deleteMember(id) { await models.CrewMember.deleteOne({ ...this.q, _id: id }); return true; }
    async addMemberHours(id, deltaHours) {
        const d = Number(deltaHours) || 0;
        if (d >= 0) {
            await models.CrewMember.updateOne({ ...this.q, _id: id }, { $inc: { hours: d } });
        } else {
            // Clamp at zero rather than $inc into negatives.
            const m = await models.CrewMember.findOne({ ...this.q, _id: id }).select('hours');
            if (!m) return null;
            m.hours = Math.max(0, (Number(m.hours) || 0) + d);
            await m.save();
        }
        return this.getMember(id);
    }

    // --- Crew center logins ---
    //
    // A not-yet-migrated VA's pilot logins are still rows in our central
    // VaPortalAccount collection, which is exactly what this adapter exists to
    // paper over: same interface, same document shape, so the login path and
    // the account provisioner never learn which side answered. The migration
    // copies these into the VA's project and then they stop being ours.
    accountQ() { return { vaAdId: this.vaAdId, role: 'pilot' }; }
    portalToAccount(a) {
        if (!a) return null;
        const d = this.lean(a);
        return {
            _id: d._id,
            username: d.username || '',
            displayName: d.displayName || '',
            passwordHash: d.passwordHash || '',
            role: 'pilot',
            memberId: null,          // the central table never linked to a roster row
            email: '',
            active: d.active !== false,
            mustChangePassword: !!d.mustChangePassword,
            createdVia: d.createdVia || '',
            createdByName: d.createdByName || '',
            lastLoginAt: d.lastLoginAt || null,
            createdAt: d.createdAt || null,
            updatedAt: d.updatedAt || null,
        };
    }
    async listAccounts({ limit = 2000 } = {}) {
        const rows = await models.VaPortalAccount.find(this.accountQ()).sort({ username: 1 }).limit(limit).lean();
        return rows.map((r) => this.portalToAccount(r));
    }
    async getAccount(id) {
        return this.portalToAccount(await models.VaPortalAccount.findOne({ ...this.accountQ(), _id: id }).lean());
    }
    async getAccountByUsername(username) {
        const u = str(username, 60).toLowerCase();
        if (!u) return null;
        return this.portalToAccount(await models.VaPortalAccount.findOne({ ...this.accountQ(), username: u }).lean());
    }
    async getAccountByMember() { return null; }
    async createAccount(data) {
        const doc = await models.VaPortalAccount.create({
            username: str(data.username, 60).toLowerCase(),
            displayName: str(data.displayName, 80),
            passwordHash: data.passwordHash,
            role: 'pilot',
            vaAdId: this.vaAdId,
            vaName: data.vaName || '',
            createdVia: 'owner',
            createdByName: str(data.createdByName, 80),
            mustChangePassword: data.mustChangePassword !== false,
            active: data.active !== false,
        });
        return this.portalToAccount(doc);
    }
    async updateAccount(id, patch) {
        const a = await models.VaPortalAccount.findOne({ ...this.accountQ(), _id: id });
        if (!a) return null;
        // Only the fields this interface owns — memberId and email have no
        // column on the central account and are dropped rather than stored
        // somewhere they would be missed by the migration.
        for (const k of ['username', 'displayName', 'passwordHash', 'active', 'mustChangePassword', 'lastLoginAt']) {
            if (patch[k] !== undefined) a[k] = k === 'username' ? String(patch[k]).toLowerCase() : patch[k];
        }
        await a.save();
        return this.portalToAccount(a);
    }
    async deleteAccount(id) {
        await models.VaPortalAccount.deleteOne({ ...this.accountQ(), _id: id });
        return true;
    }

    listRoutes({ activeOnly = false, limit = 3000 } = {}) {
        const q = activeOnly ? { ...this.q, active: true } : this.q;
        return models.CrewRoute.find(q).sort({ flightNumber: 1, createdAt: -1 }).limit(limit).lean();
    }
    getRoute(id) { return models.CrewRoute.findOne({ ...this.q, _id: id }).lean(); }
    async createRoute(data) { return this.lean(await models.CrewRoute.create({ ...this.q, ...data })); }
    async updateRoute(id, patch) {
        const r = await models.CrewRoute.findOne({ ...this.q, _id: id });
        if (!r) return null;
        Object.assign(r, patch);
        await r.save();
        return this.lean(r);
    }
    async deleteRoute(id) { await models.CrewRoute.deleteOne({ ...this.q, _id: id }); return true; }

    listPireps({ status = '', limit = 500 } = {}) {
        const q = status ? { ...this.q, status } : this.q;
        return models.CrewPirep.find(q).sort({ flownAt: -1, createdAt: -1 }).limit(limit).lean();
    }
    getPirep(id) { return models.CrewPirep.findOne({ ...this.q, _id: id }).lean(); }
    async createPirep(data) { return this.lean(await models.CrewPirep.create({ ...this.q, ...data })); }
    async updatePirep(id, patch) {
        const p = await models.CrewPirep.findOne({ ...this.q, _id: id });
        if (!p) return null;
        Object.assign(p, patch);
        await p.save();
        return this.lean(p);
    }
    async deletePirep(id) { await models.CrewPirep.deleteOne({ ...this.q, _id: id }); return true; }
    async seenFlightIds(flightIds) {
        const ids = (flightIds || []).filter(Boolean);
        if (!ids.length) return new Set();
        const rows = await models.CrewPirep.find({ ...this.q, flightId: { $in: ids } }).select('flightId').lean();
        return new Set(rows.map((r) => r.flightId));
    }

    listApplications({ status = 'pending', limit = 500 } = {}) {
        const q = status ? { ...this.q, status } : this.q;
        return models.CrewApplication.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    }
    getApplication(id) { return models.CrewApplication.findOne({ ...this.q, _id: id }).lean(); }
    getApplicationByToken(token) { return models.CrewApplication.findOne({ ...this.q, statusToken: token }).lean(); }
    getApplicationByInviteAccount(accountId) {
        return models.CrewApplication.findOne({ ...this.q, inviteAccountId: String(accountId) }).lean();
    }
    async createApplication(data) { return this.lean(await models.CrewApplication.create({ ...this.q, ...data })); }
    async updateApplication(id, patch) {
        const a = await models.CrewApplication.findOne({ ...this.q, _id: id });
        if (!a) return null;
        Object.assign(a, patch);
        await a.save();
        return this.lean(a);
    }

    async stats() {
        const [members, pireps, routes, applications] = await Promise.all([
            this.listMembers({ limit: 5000 }),
            this.listPireps({ limit: 20000 }),
            this.listRoutes({ limit: 5000 }),
            models.CrewApplication.find(this.q).select('status createdAt').limit(5000).lean(),
        ]);
        return { ...computeStats({ members, pireps, routes, applications }), source: 'managed' };
    }

    async health() {
        // `accounts: true` — managed pilot logins work, they just work in our
        // database instead of the VA's, which is the thing the migration fixes.
        return {
            ok: true, provisioned: true, managed: true, accounts: true,
            version: 0, expectedVersion: EXPECTED_SCHEMA_VERSION,
        };
    }

    // Does this VA actually have anything in managed storage? forVa asks this on
    // every request from a VA with no connected project, so it is an existence
    // probe (four indexed findOnes, short-circuited) rather than a count, and
    // the answer is cached — a VA does not sprout legacy rows spontaneously, and
    // the one transition that matters (legacy -> empty, after a release) is
    // handled by clearing the entry.
    async hasData() {
        const key = String(this.vaAdId);
        const hit = LEGACY_DATA_CACHE.get(key);
        if (hit && (Date.now() - hit.at) < LEGACY_DATA_TTL_MS) return hit.value;
        let value = false;
        for (const model of [models.CrewMember, models.CrewPirep, models.CrewApplication, models.CrewRoute]) {
            if (await model.findOne(this.q).select('_id').lean()) { value = true; break; }
        }
        LEGACY_DATA_CACHE.set(key, { at: Date.now(), value });
        return value;
    }
}

// vaAdId -> { at, value }. See LegacyStore.hasData.
const LEGACY_DATA_CACHE = new Map();
const LEGACY_DATA_TTL_MS = 5 * 60 * 1000;
const forgetLegacyData = (vaAdId) => LEGACY_DATA_CACHE.delete(String(vaAdId));

// Mongoose applies schema defaults on create; the Supabase path relies on
// column defaults. This keeps a hand-built member object complete either way.
const memberDefaults = (d) => ({
    name: '', callsign: '', hours: 0, role: '', aircraft: [], status: 'active',
    ifUserId: '', ifcName: '', ...d,
});

// ---------------------------------------------------------------------------
// Shared aggregate maths.
//
// The Supabase path normally computes this in Postgres (crew_stats). This JS
// version backs the legacy store and the older-schema fallback, and the two are
// kept deliberately identical in shape so no caller has to care which ran.
// ---------------------------------------------------------------------------
function computeStats({ members = [], pireps = [], routes = [], applications = [] }) {
    const now = Date.now();
    const within30d = (d) => d && (now - new Date(d).getTime()) < 30 * 86400000;
    const approved = pireps.filter((p) => p.status === 'approved');
    const recent = approved.filter((p) => within30d(p.flownAt || p.createdAt));
    const flownMin = approved.reduce((s, p) => s + (Number(p.durationMin) || 0), 0);
    const recentMin = recent.reduce((s, p) => s + (Number(p.durationMin) || 0), 0);
    const round1 = (n) => Math.round(n * 10) / 10;
    const lastFlight = approved.reduce((best, p) => {
        const t = p.flownAt || p.createdAt;
        return t && (!best || new Date(t) > new Date(best)) ? t : best;
    }, null);

    return {
        pilots: members.length,
        pilotsActive: members.filter((m) => m.status === 'active').length,
        pilotsLoa: members.filter((m) => m.status === 'loa').length,
        pilotsLinked: members.filter((m) => m.ifUserId).length,
        pilotsJoined30d: members.filter((m) => within30d(m.createdAt)).length,
        hours: round1(members.reduce((s, m) => s + (Number(m.hours) || 0), 0)),
        pireps: pireps.length,
        pirepsApproved: approved.length,
        pirepsPending: pireps.filter((p) => p.status === 'pending').length,
        pirepsRejected: pireps.filter((p) => p.status === 'rejected').length,
        flightHours: round1(flownMin / 60),
        flightHours30d: round1(recentMin / 60),
        flights30d: recent.length,
        landings: approved.reduce((s, p) => s + (Number(p.landings) || 0), 0),
        distanceNm: Math.round(approved.reduce((s, p) => s + (Number(p.distanceNm) || 0), 0)),
        lastFlightAt: lastFlight || null,
        routes: routes.length,
        routesActive: routes.filter((r) => r.active !== false).length,
        destinations: new Set(routes.filter((r) => r.active !== false && r.destination).map((r) => r.destination)).size,
        applicationsPending: applications.filter((a) => a.status === 'pending').length,
        applicationsAccepted: applications.filter((a) => a.status === 'accepted').length,
        applications30d: applications.filter((a) => a.status === 'pending' && within30d(a.createdAt)).length,
        topPilots: members
            .filter((m) => m.status === 'active' && (Number(m.hours) || 0) > 0)
            .sort((a, b) => (b.hours - a.hours) || String(a.name).localeCompare(String(b.name)))
            .slice(0, 10)
            .map((m) => ({ name: m.name, callsign: m.callsign, hours: round1(Number(m.hours) || 0) })),
        generatedAt: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Picking a store for a VA
//
// `va` must have been loaded with the secret service key selected — see
// crewStore.SELECT, which every caller uses so nobody forgets a field.
// ---------------------------------------------------------------------------
// `ranks` rides along because rank is now resolved server-side on nearly every
// crew route — the roster, the route network's gating, a promotion notice — and
// fetching the same small array again in each handler would be a second query
// per request for a field that is a few hundred bytes.
const SELECT = '_id slug callsign name contactEmail crewAccent ranks supabaseUrl supabaseAnonKey +supabaseServiceKey';

function isConnected(va) {
    return !!(va && va.supabaseUrl && va.supabaseServiceKey);
}

async function forVa(va) {
    if (!va) throw new CrewStoreError('Crew center not found.', { status: 404, code: 'va_not_found' });
    if (isConnected(va)) return new SupabaseStore(va);

    const legacy = new LegacyStore(va);
    if (!REQUIRE_OWN_STORE) return legacy;
    // A VA with rows in managed storage keeps working until they migrate;
    // anyone else has to bring their own project first.
    if (await legacy.hasData()) return legacy;
    throw NOT_CONNECTED();
}

// Read-only variant for public surfaces (the stats endpoint, the roster on a
// VA's own website). Returns null instead of throwing when the VA has no store
// at all, so a public page renders "no data yet" rather than an error.
async function forVaOrNull(va) {
    try { return await forVa(va); } catch { return null; }
}

module.exports = {
    configure,
    forVa,
    forVaOrNull,
    forgetLegacyData,
    forgetSchemaDrift,
    isConnected,
    computeStats,
    CrewStoreError,
    SupabaseStore,
    LegacyStore,
    SELECT,
    EXPECTED_SCHEMA_VERSION,
    ACCOUNTS_SCHEMA_VERSION,
    REQUIRE_OWN_STORE,
};

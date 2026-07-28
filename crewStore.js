'use strict';

/*
 * crewStore.js
 * Where a VA's crew data actually lives.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * --------------------------------------
 * A VA's operational data belongs to the VA and is stored in the VA's own
 * Supabase project — never in ours. Inflight keeps only what it needs to run
 * the platform: staff logins, and the VA's directory/branding metadata (name,
 * slug, colours, fleet definitions, rank ladder, join requirements). Rosters,
 * flight reports, applications and applicant emails are created in, read from
 * and deleted from the VA's project.
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
// version still works — every column we read has existed since v1 — but the
// health endpoint flags it so the VA knows to re-run the SQL.
const EXPECTED_SCHEMA_VERSION = 1;

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

const routeFromRow = (r) => r && {
    _id: r.id,
    flightNumber: r.flight_number || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraft: r.aircraft || '',
    distanceNm: Number(r.distance_nm) || 0,
    notes: r.notes || '',
    active: r.active !== false,
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
class Postgrest {
    constructor(url, serviceKey) {
        this.base = String(url).replace(/\/+$/, '') + '/rest/v1';
        this.key = serviceKey;
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
        if (res.status === 409 || body.code === '23505') {
            return new CrewStoreError('That record already exists.', { status: 409, code: 'store_conflict', detail });
        }
        return new CrewStoreError('The VA’s data store returned an error.',
            { status: 502, code: 'store_error', detail: detail || `HTTP ${res.status}` });
    }

    select(table, params) { return this.request('get', `/${table}`, { params }); }

    async insert(table, rows) {
        const out = await this.request('post', `/${table}`, { data: rows, prefer: 'return=representation' });
        return Array.isArray(out) ? out : [out];
    }

    async update(table, params, patch) {
        const out = await this.request('patch', `/${table}`, { params, data: patch, prefer: 'return=representation' });
        return Array.isArray(out) ? out : [out];
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
                installedAt: (rows && rows[0] && rows[0].installed_at) || null,
            };
        } catch (err) {
            return {
                ok: false,
                provisioned: false,
                version: 0,
                expectedVersion: EXPECTED_SCHEMA_VERSION,
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
        return { ok: true, provisioned: true, managed: true, version: 0, expectedVersion: EXPECTED_SCHEMA_VERSION };
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
const SELECT = '_id slug callsign name contactEmail crewAccent supabaseUrl supabaseAnonKey +supabaseServiceKey';

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
    isConnected,
    computeStats,
    CrewStoreError,
    SupabaseStore,
    LegacyStore,
    SELECT,
    EXPECTED_SCHEMA_VERSION,
    REQUIRE_OWN_STORE,
};

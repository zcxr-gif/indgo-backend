// crewStore.js
// =============================================================================
// Where a VA's own crew data (roster + flight reports) is read and written.
//
// The point: a VA can keep the bulk of its per-VA data — especially the
// auto-captured PIREPs, which grow without bound — in THEIR OWN Supabase
// project, so it never sits in the central Mongo. A VA is on Supabase only when
// it has explicitly migrated (crewDataStore === 'supabase') AND a service_role
// key is on file. Every other VA stays on the central Mongo exactly as before,
// so this is safe-by-default: nothing changes for a VA until it opts in.
//
// The service_role key bypasses Postgres RLS, so the backend owns these tables
// outright. The crew center keeps its existing JWT login — Supabase Auth is NOT
// involved. Tables are created by the setup SQL the owner runs in their project
// (crew_pilots, crew_pireps); ids are TEXT so a migrated Mongo _id can be reused
// verbatim as the row id, which keeps pirep→pilot references stable across the
// move without any remapping.
// =============================================================================

const mongoose = require('mongoose');
const axios = require('axios');

// Late-bound model lookup: the models are registered in server.js. Resolving
// them at call time (not require time) keeps crewStore independent of require
// order.
const M = (n) => mongoose.models[n];

// A VA is Supabase-backed only when it opted in. `va` here is the lean doc from
// resolveCrewVa, which now carries crewDataStore.
const onSupabase = (va) => !!(va && va.crewDataStore === 'supabase');

// --- service-key credential cache (the key is select:false + secret, so we
// don't want to reload it on every crew request) ---
const _credCache = new Map(); // vaId -> { url, key, at }
const CRED_TTL = 5 * 60 * 1000;
async function creds(vaId) {
    const id = String(vaId);
    const hit = _credCache.get(id);
    if (hit && Date.now() - hit.at < CRED_TTL) return hit;
    const doc = await M('VirtualAirlineAd').findById(id).select('+supabaseServiceKey supabaseUrl').lean();
    const rec = {
        url: String((doc && doc.supabaseUrl) || '').replace(/\/+$/, ''),
        key: String((doc && doc.supabaseServiceKey) || '').trim(),
        at: Date.now(),
    };
    _credCache.set(id, rec);
    return rec;
}
function invalidateCreds(vaId) { _credCache.delete(String(vaId)); }

// --- PostgREST call against the VA's project (service key => bypasses RLS) ---
async function rest(va, method, table, { body, params, prefer } = {}) {
    const c = await creds(va._id);
    if (!c.url || !c.key) { const e = new Error('supabase_not_configured'); e.code = 'NO_SUPABASE'; throw e; }
    const headers = { apikey: c.key, Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await axios({ method, url: `${c.url}/rest/v1/${table}`, headers, params, data: body, timeout: 9000 });
    return res.data;
}
// PostgREST `in.("a","b")` list, values quoted so ids with odd chars are safe.
const inList = (vals) => `in.(${vals.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;

// ============================ row mappers ====================================
// Callers use publicMember/publicPirep, which read _id + camelCase. So a
// Supabase row (snake_case) is mapped to that same shape, and a doc going the
// other way is mapped to snake_case columns.
const memberRowToDoc = (r) => r && ({
    _id: r.id, vaAdId: r.va_ad_id, name: r.name || '', callsign: r.callsign || '',
    hours: Number(r.hours) || 0, role: r.role || '', aircraft: r.aircraft || [],
    status: r.status || 'active', ifUserId: r.if_user_id || '', ifcName: r.ifc_name || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
});
const memberDocToRow = (d) => ({
    name: d.name || '', callsign: d.callsign || '', hours: Number(d.hours) || 0, role: d.role || '',
    aircraft: Array.isArray(d.aircraft) ? d.aircraft : [], status: d.status || 'active',
    if_user_id: d.ifUserId || '', ifc_name: d.ifcName || '',
});
const pirepRowToDoc = (r) => r && ({
    _id: r.id, vaAdId: r.va_ad_id, memberId: r.member_id || null, routeId: r.route_id || null,
    pilotName: r.pilot_name || '', callsign: r.callsign || '', flightNumber: r.flight_number || '',
    ifUserId: r.if_user_id || '', flightId: r.flight_id || '', origin: r.origin || '', destination: r.destination || '',
    aircraftName: r.aircraft_name || '', liveryName: r.livery_name || '',
    durationMin: Number(r.duration_min) || 0, landings: Number(r.landings) || 0, xp: Number(r.xp) || 0,
    violations: Number(r.violations) || 0, distanceNm: Number(r.distance_nm) || 0, server: r.server || '',
    inFleet: !!r.in_fleet, source: r.source || 'auto', status: r.status || 'pending',
    hoursApplied: !!r.hours_applied, flownAt: r.flown_at, reviewedAt: r.reviewed_at, createdAt: r.created_at,
});
const pirepDocToRow = (d) => ({
    member_id: d.memberId || null, route_id: d.routeId || null, pilot_name: d.pilotName || '',
    callsign: d.callsign || '', flight_number: d.flightNumber || '', if_user_id: d.ifUserId || '',
    flight_id: d.flightId || '', origin: d.origin || '', destination: d.destination || '',
    aircraft_name: d.aircraftName || '', livery_name: d.liveryName || '', duration_min: Number(d.durationMin) || 0,
    landings: Number(d.landings) || 0, xp: Number(d.xp) || 0, violations: Number(d.violations) || 0,
    distance_nm: Number(d.distanceNm) || 0, server: d.server || '', in_fleet: !!d.inFleet,
    source: d.source || 'auto', status: d.status || 'pending', hours_applied: !!d.hoursApplied,
    flown_at: d.flownAt || null, reviewed_at: d.reviewedAt || null,
});

// ============================ roster =========================================
const roster = {
    async list(va) {
        if (onSupabase(va)) {
            const rows = await rest(va, 'get', 'crew_pilots', { params: { va_ad_id: `eq.${va._id}`, order: 'hours.desc,name.asc', limit: 2000 } });
            return (rows || []).map(memberRowToDoc);
        }
        return M('CrewMember').find({ vaAdId: va._id }).sort({ hours: -1, name: 1 }).limit(2000).lean();
    },
    async get(va, id) {
        if (onSupabase(va)) {
            const rows = await rest(va, 'get', 'crew_pilots', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}`, limit: 1 } });
            return memberRowToDoc((rows || [])[0]) || null;
        }
        return M('CrewMember').findOne({ _id: id, vaAdId: va._id }).lean();
    },
    async create(va, doc) {
        if (onSupabase(va)) {
            const rows = await rest(va, 'post', 'crew_pilots', { body: { ...memberDocToRow(doc), va_ad_id: String(va._id) }, prefer: 'return=representation' });
            return memberRowToDoc((rows || [])[0]);
        }
        const m = await M('CrewMember').create({ vaAdId: va._id, ...doc });
        return m.toObject();
    },
    async update(va, id, patch) {
        if (onSupabase(va)) {
            const rows = await rest(va, 'patch', 'crew_pilots', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}` }, body: { ...memberDocToRow(patch), updated_at: new Date().toISOString() }, prefer: 'return=representation' });
            return memberRowToDoc((rows || [])[0]) || null;
        }
        const m = await M('CrewMember').findOne({ _id: id, vaAdId: va._id });
        if (!m) return null;
        Object.assign(m, patch); await m.save(); return m.toObject();
    },
    async remove(va, id) {
        if (onSupabase(va)) { await rest(va, 'delete', 'crew_pilots', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}` } }); return true; }
        await M('CrewMember').deleteOne({ _id: id, vaAdId: va._id }); return true;
    },
    // Credit (or debit, with a negative delta) a pilot's logged hours, clamped at 0.
    async addHours(va, id, deltaHours) {
        if (!id || !deltaHours) return;
        if (onSupabase(va)) {
            const cur = await roster.get(va, id); if (!cur) return;
            const next = Math.max(0, (Number(cur.hours) || 0) + deltaHours);
            await rest(va, 'patch', 'crew_pilots', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}` }, body: { hours: next } });
            return;
        }
        if (deltaHours > 0) { await M('CrewMember').updateOne({ _id: id }, { $inc: { hours: deltaHours } }); return; }
        const m = await M('CrewMember').findById(id).select('hours');
        if (m) { m.hours = Math.max(0, (Number(m.hours) || 0) + deltaHours); await m.save(); }
    },
};

// ============================ pireps =========================================
const pireps = {
    async list(va, { status, limit = 500 } = {}) {
        if (onSupabase(va)) {
            const params = { va_ad_id: `eq.${va._id}`, order: 'flown_at.desc.nullslast,created_at.desc', limit };
            if (status) params.status = `eq.${status}`;
            const rows = await rest(va, 'get', 'crew_pireps', { params });
            return (rows || []).map(pirepRowToDoc);
        }
        const q = { vaAdId: va._id }; if (status) q.status = status;
        return M('CrewPirep').find(q).sort({ flownAt: -1, createdAt: -1 }).limit(limit).lean();
    },
    async get(va, id) {
        if (onSupabase(va)) {
            const rows = await rest(va, 'get', 'crew_pireps', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}`, limit: 1 } });
            return pirepRowToDoc((rows || [])[0]) || null;
        }
        return M('CrewPirep').findOne({ _id: id, vaAdId: va._id }).lean();
    },
    async create(va, doc) {
        if (onSupabase(va)) {
            const rows = await rest(va, 'post', 'crew_pireps', { body: { ...pirepDocToRow(doc), va_ad_id: String(va._id) }, prefer: 'return=representation' });
            return pirepRowToDoc((rows || [])[0]);
        }
        const p = await M('CrewPirep').create({ vaAdId: va._id, ...doc });
        return p.toObject();
    },
    async update(va, id, patch) {
        if (onSupabase(va)) {
            // Only map the fields the caller actually set (partial patch).
            const row = {};
            const full = pirepDocToRow(patch);
            for (const [k, col] of Object.entries({
                status: 'status', hoursApplied: 'hours_applied', reviewedAt: 'reviewed_at',
                memberId: 'member_id', routeId: 'route_id',
            })) if (patch[k] !== undefined) row[col] = full[col];
            const rows = await rest(va, 'patch', 'crew_pireps', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}` }, body: row, prefer: 'return=representation' });
            return pirepRowToDoc((rows || [])[0]) || null;
        }
        const p = await M('CrewPirep').findOne({ _id: id, vaAdId: va._id });
        if (!p) return null;
        Object.assign(p, patch); await p.save(); return p.toObject();
    },
    async remove(va, id) {
        if (onSupabase(va)) { await rest(va, 'delete', 'crew_pireps', { params: { id: `eq.${id}`, va_ad_id: `eq.${va._id}` } }); return true; }
        await M('CrewPirep').deleteOne({ _id: id, vaAdId: va._id }); return true;
    },
    // Which of these IF flight ids are already captured (dedupe key for sync)?
    async seenFlightIds(va, ids) {
        const list = [...new Set((ids || []).map(String).filter(Boolean))];
        if (!list.length) return new Set();
        if (onSupabase(va)) {
            const rows = await rest(va, 'get', 'crew_pireps', { params: { va_ad_id: `eq.${va._id}`, flight_id: inList(list), select: 'flight_id', limit: list.length } });
            return new Set((rows || []).map((r) => r.flight_id));
        }
        const rows = await M('CrewPirep').find({ vaAdId: va._id, flightId: { $in: list } }).select('flightId').lean();
        return new Set(rows.map((r) => r.flightId));
    },
};

// ======================= provision + migrate =================================
// Confirm the VA's project has the tables we need (probe a cheap select). Throws
// a tagged error the endpoint can turn into a helpful message.
async function probe(va) {
    for (const t of ['crew_pilots', 'crew_pireps']) {
        try { await rest(va, 'get', t, { params: { limit: 1 } }); }
        catch (err) {
            const e = new Error(`table_missing:${t}`); e.code = 'TABLE_MISSING'; e.table = t; throw e;
        }
    }
    return true;
}
// Copy this VA's Mongo roster + pireps into its Supabase (idempotent upsert on
// the row id, which we set to the Mongo _id so references stay intact). Returns
// counts. Does NOT flip the store or delete anything — the caller decides.
async function copyToSupabase(va) {
    const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    const members = await M('CrewMember').find({ vaAdId: va._id }).lean();
    const preps = await M('CrewPirep').find({ vaAdId: va._id }).lean();
    let pilots = 0, flights = 0;
    for (const batch of chunk(members, 500)) {
        const body = batch.map((m) => ({ id: String(m._id), va_ad_id: String(va._id), ...memberDocToRow(m), created_at: m.createdAt, updated_at: m.updatedAt }));
        if (body.length) { await rest(va, 'post', 'crew_pilots', { body, params: { on_conflict: 'id' }, prefer: 'resolution=merge-duplicates,return=minimal' }); pilots += body.length; }
    }
    for (const batch of chunk(preps, 500)) {
        const body = batch.map((p) => ({ id: String(p._id), va_ad_id: String(va._id), ...pirepDocToRow(p), created_at: p.createdAt }));
        if (body.length) { await rest(va, 'post', 'crew_pireps', { body, params: { on_conflict: 'id' }, prefer: 'resolution=merge-duplicates,return=minimal' }); flights += body.length; }
    }
    return { pilots, flights };
}
// Remove this VA's Mongo roster + pireps (called only after a verified copy when
// the caller asked to reclaim the space).
async function purgeMongo(va) {
    const a = await M('CrewMember').deleteMany({ vaAdId: va._id });
    const b = await M('CrewPirep').deleteMany({ vaAdId: va._id });
    return { pilots: a.deletedCount || 0, flights: b.deletedCount || 0 };
}

module.exports = {
    onSupabase, invalidateCreds, roster, pireps, probe, copyToSupabase, purgeMongo,
    // exported for unit tests
    _map: { memberRowToDoc, memberDocToRow, pirepRowToDoc, pirepDocToRow, inList },
};

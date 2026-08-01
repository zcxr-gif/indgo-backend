'use strict';

/*
 * crewEvents.js
 * The events a VA gathers around, and the gate board that keeps them apart.
 *
 * WHAT LIVES HERE
 * ---------------
 * Everything about an event that is a decision rather than a database write:
 * what a submitted event is allowed to say (sanitizeEvent), what an event and
 * an attendee look like to the world (publicEvent / publicSignup), which
 * airport's stands the board covers (gateAirport, via crewStore), and how the
 * stands an airport HAS are combined with the stands pilots have TAKEN
 * (buildGateBoard).
 *
 * The rows themselves belong to crewStore, like every other piece of a VA's
 * data — see supabase/crew-center-schema.sql for the two tables.
 *
 * WHERE THE AUTHORITY SITS, BECAUSE IT IS THE WHOLE DESIGN
 * -------------------------------------------------------
 * Nothing in this file decides whether a gate is free. That is a unique index
 * on (event_id, upper(gate)) in the VA's own Postgres, and it has to be:
 * announcing an event puts a dozen pilots on the same map inside a minute, and
 * any "is this stand taken?" read performed before the insert loses that race.
 * The insert is attempted and Postgres arbitrates. What this file does is
 * present the outcome — which stands exist, which are held, and by whom.
 *
 * WHERE THE STANDS COME FROM
 * --------------------------
 * OpenStreetMap, through Overpass, cached for a day per airport. No VA
 * maintains a gate list; the tracker's dispatch gate picker already reads the
 * same `aeroway=gate|stand|parking_position` tags, so a stand a pilot files a
 * flight plan against is the stand they book at an event.
 *
 * The lookup is server-side rather than per-browser on purpose. Overpass is a
 * donated, rate-limited service, and an event announcement means everybody
 * opens the same airport at the same moment — one cached lookup per VA instead
 * of one per pilot is the difference between working and being blocked.
 *
 * Pure apart from fetchAirportGates(), which is the one thing here that talks
 * to the network. No database, no mongoose.
 */

const axios = require('axios');

// The mirrors, tried in order.
//
// The public overpass-api.de endpoint rate-limits hard and sheds load by
// timing out — on an event evening, when a whole VA opens the same gate board
// at once, it is the single most likely thing here to fail. One endpoint with
// no alternative meant every one of those pilots got "OpenStreetMap is
// unreachable" and an empty board. Kumi and France are independent instances
// of the same data, so a refusal from one says nothing about the next.
//
// OVERPASS_ENDPOINT still wins outright when set, so a deployment pointing at
// its own instance does not silently fan out to public ones.
const OVERPASS_ENDPOINTS = process.env.OVERPASS_ENDPOINT
    ? [process.env.OVERPASS_ENDPOINT]
    : [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.osm.ch/api/interpreter',
    ];
// 7 km covers sprawling fields (KDFW, OMDB, KORD) where remote hardstands sit
// well outside the terminal core. The same radius the tracker's dispatch gate
// picker uses, so the two agree about what "this airport's stands" means.
const GATE_RADIUS_M = 7000;
const GATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GATE_CACHE_MAX = 200;
const OVERPASS_TIMEOUT_MS = parseInt(process.env.OVERPASS_TIMEOUT_MS, 10) || 25000;

// Lower number wins when two elements carry the same ref, so a real gate node
// beats a parking_position that happens to share its name. Without this the
// winner was insertion-order — which is how the closer of two identically
// named stands used to disappear off the board.
const GATE_KIND_PRIORITY = { gate: 0, stand: 1, parking_position: 2, apron: 3 };

const STATUSES = ['draft', 'published', 'cancelled'];

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const icao = (v) => str(v, 8).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const when = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
// Rendered in an <img> on a public page, so https or nothing — the same rule a
// codeshare partner's logo follows.
const httpsOnly = (v) => { const s = str(v, 600); return /^https:\/\//i.test(s) ? s : ''; };

/**
 * What a submitted event is allowed to say.
 *
 * Note `status`: anything unrecognised becomes 'draft', never 'published'. An
 * event that appears on a VA's public calendar because a field was misspelt is
 * the one failure mode here that reaches strangers.
 */
function sanitizeEvent(b) {
    b = b || {};
    return {
        title: str(b.title, 120),
        description: str(b.description, 4000),
        bannerUrl: httpsOnly(b.bannerUrl),
        origin: icao(b.origin),
        destination: icao(b.destination),
        aircraft: str(b.aircraft, 60),
        flightNumber: str(b.flightNumber, 12),
        // The leg in the VA's network this event is flown on, when it is one.
        // '' rather than a uuid means a one-off: a fly-in from anywhere, a
        // charter to a field the network does not serve.
        routeId: str(b.routeId, 64),
        server: str(b.server, 30),
        startsAt: when(b.startsAt),
        endsAt: when(b.endsAt),
        slots: Math.max(0, Math.min(5000, Math.round(Number(b.slots) || 0))),
        gatesOpen: b.gatesOpen === undefined ? true : !!b.gatesOpen,
        gatesLocked: !!b.gatesLocked,
        gateIcao: icao(b.gateIcao),
        minRank: str(b.minRank, 40),
        status: STATUSES.includes(b.status) ? b.status : 'draft',
    };
}

/** The fields staff may change on somebody else's place at an event. */
function sanitizeSignupPatch(b, { allowIdentity = false } = {}) {
    b = b || {};
    const patch = {};
    if (allowIdentity && b.pilotName !== undefined) patch.pilotName = str(b.pilotName, 80);
    if (b.callsign !== undefined) patch.callsign = str(b.callsign, 20);
    if (b.aircraft !== undefined) patch.aircraft = str(b.aircraft, 60);
    if (b.note !== undefined) patch.note = str(b.note, 300);
    if (allowIdentity && b.status !== undefined) patch.status = b.status === 'waitlist' ? 'waitlist' : 'going';
    if (b.gate !== undefined) {
        patch.gate = str(b.gate, 20).toUpperCase();
        // Clearing the stand clears where it was. A position left behind by a
        // gate nobody holds would put a marker on an empty stand.
        patch.gateLat = patch.gate ? b.gateLat : null;
        patch.gateLon = patch.gate ? b.gateLon : null;
        patch.gateKind = patch.gate ? str(b.gateKind, 30) : '';
    }
    return patch;
}

/**
 * An attendee, as everyone sees them.
 *
 * A crew center's attendee list is public by design — the whole point is that
 * pilots can see who is coming and which stands are left — but it carries names
 * and stands only. No account id, no email, nothing that identifies a login.
 */
const publicSignup = (s) => ({
    id: s._id,
    memberId: s.memberId || null,
    pilotName: s.pilotName,
    callsign: s.callsign,
    aircraft: s.aircraft,
    gate: s.gate,
    gateLat: s.gateLat,
    gateLon: s.gateLon,
    gateKind: s.gateKind,
    note: s.note,
    status: s.status,
    signedUpAt: s.createdAt,
});

/**
 * An event, as everyone sees it.
 *
 * `ranks`/`viewer` give it the same rank treatment a route gets: a pilot below
 * the bar sees the event LOCKED, not hidden, with how much further they have to
 * fly. An event you can see and are working toward is the point of a ladder.
 *
 * Attendance figures are null — never 0 — when the caller did not pass
 * `signups`. A card that prints "0 going" for a figure nobody counted is a
 * claim, and the rule across this codebase is to say nothing rather than
 * something untrue.
 */
function publicEvent(e, { signups = null, ranks = null, viewer = null, canManage = false, meetsRank = null } = {}) {
    const going = signups ? signups.filter((s) => s.status === 'going') : null;
    const gated = !!e.minRank;
    const locked = gated && !!viewer && typeof meetsRank === 'function'
        && !meetsRank(ranks, viewer.hours, e.minRank);
    return {
        id: e._id,
        title: e.title,
        description: e.description,
        bannerUrl: e.bannerUrl,
        origin: e.origin,
        destination: e.destination,
        aircraft: e.aircraft,
        flightNumber: e.flightNumber,
        routeId: e.routeId || null,
        server: e.server,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        slots: e.slots,
        gatesOpen: e.gatesOpen,
        gatesLocked: e.gatesLocked,
        // Resolved once here rather than in three front-ends, so "which airport
        // is the board for?" has exactly one answer.
        gateIcao: gateAirport(e),
        minRank: e.minRank || '',
        status: e.status,
        locked,
        going: going ? going.length : null,
        waitlisted: signups ? signups.length - going.length : null,
        seatsLeft: going && e.slots ? Math.max(0, e.slots - going.length) : null,
        full: !!(going && e.slots && going.length >= e.slots),
        canManage,
        createdAt: e.createdAt,
    };
}

/**
 * Which airport's stands an event's gate board covers.
 *
 * Stored rather than derived because the answer is not always the origin: a
 * group departure parks everyone at the field they leave from, a fly-in parks
 * them at the field they arrive at. Empty means "the origin", which is the
 * common case and what the crew center fills in.
 */
const gateAirport = (e) => (e && (e.gateIcao || e.origin || e.destination)) || '';

/**
 * Is this pilot past the event's cap?
 *
 * Signing up past it is not refused — it lands on the waitlist, because an
 * event that quietly turns pilots away is one staff find out about too late.
 * A waitlisted pilot holds NO stand: the stand belongs to the event, and
 * someone who may not fly it should not be sitting on one.
 */
const isWaitlisted = (event, signups) => !!(event.slots > 0
    && (signups || []).filter((s) => s.status === 'going').length >= event.slots);

/**
 * Who gets the seat that has just come free: whoever has waited longest.
 *
 * Returns the signup to promote, or null. Promotion gives them a PLACE, not a
 * stand — they pick their own when they see they are in, because inheriting the
 * stand of whoever dropped out would put them somewhere they never chose.
 */
function nextOffWaitlist(event, signups) {
    if (!event || !event.slots) return null;
    const list = signups || [];
    if (list.filter((s) => s.status === 'going').length >= event.slots) return null;
    return list
        .filter((s) => s.status === 'waitlist')
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0] || null;
}

/**
 * Every mapped stand at the airport, each marked taken or free — plus the
 * stands pilots claimed that OpenStreetMap has never heard of.
 *
 * That last part is not a nicety. A pilot may hold a stand OSM does not carry
 * (a newly built pier, a VA's own numbering), and a board that drew only what
 * Overpass returned would show that stand as free and hand it to somebody else.
 * Anything claimed is on the board, mapped or not.
 */
function buildGateBoard(gates, signups) {
    const held = new Map();
    for (const s of signups || []) {
        if (s.gate) held.set(String(s.gate).toUpperCase(), s);
    }
    const board = (gates || []).map((g) => {
        const key = String(g.ref).toUpperCase();
        const holder = held.get(key);
        held.delete(key);
        return {
            ref: g.ref,
            lat: g.lat,
            lon: g.lon,
            kind: g.kind,
            taken: !!holder,
            takenBy: holder ? (holder.pilotName || 'A pilot') : '',
            takenByCallsign: holder ? holder.callsign : '',
            takenByAircraft: holder ? holder.aircraft : '',
            signupId: holder ? holder._id : null,
        };
    });
    for (const [, s] of held) {
        board.push({
            ref: s.gate,
            lat: s.gateLat,
            lon: s.gateLon,
            kind: s.gateKind || 'gate',
            taken: true,
            takenBy: s.pilotName || 'A pilot',
            takenByCallsign: s.callsign,
            takenByAircraft: s.aircraft,
            signupId: s._id,
            // So a front-end can say where this one came from rather than
            // drawing a stand it has no position for.
            unmapped: true,
        });
    }
    return board;
}

// ---------------------------------------------------------------------------
// The stands an airport actually has
// ---------------------------------------------------------------------------

const _gateCache = new Map();   // ICAO -> { at, gates }

/** Drop a cached airport (or all of them). Exposed for tests. */
function forgetGates(icaoCode) {
    if (!icaoCode) { _gateCache.clear(); return; }
    _gateCache.delete(String(icaoCode).trim().toUpperCase());
}

// Every flavour of parking spot OSM uses, as nodes AND ways — plenty of mappers
// draw stands as polygons, and `out center` gives those a point to put a marker
// on. Aprons need a ref or a name, or we would pin every nameless slab of
// concrete on the field.
const gateQueryBody = (scope) => `
  node["aeroway"="gate"](${scope});
  node["aeroway"="parking_position"](${scope});
  node["aeroway"="stand"](${scope});
  way["aeroway"="parking_position"](${scope});
  way["aeroway"="stand"](${scope});
  way["aeroway"="apron"]["ref"](${scope});
  way["aeroway"="apron"]["name"](${scope});`;

/** The Overpass query for one airport, by coordinates when we have them. */
function gateQuery(icaoCode, coords) {
    if (Array.isArray(coords) && coords.length >= 2) {
        return `[out:json][timeout:25];(${gateQueryBody(`around:${GATE_RADIUS_M},${coords[0]},${coords[1]}`)});out center tags;`;
    }
    // No coordinates on file — find the aerodrome by its ICAO tag and search
    // around whatever that resolves to. Keeps small fields working instead of
    // telling a VA their home base has no stands.
    return `[out:json][timeout:25];`
        + `(way["aeroway"="aerodrome"]["icao"="${icaoCode}"];`
        + `node["aeroway"="aerodrome"]["icao"="${icaoCode}"];`
        + `relation["aeroway"="aerodrome"]["icao"="${icaoCode}"];)->.apt;`
        + `(${gateQueryBody(`around.apt:${GATE_RADIUS_M}`)});out center tags;`;
}

/** Overpass elements -> [{ ref, lat, lon, kind }], deduped by ref. */
function parseOverpassGates(elements) {
    const byRef = new Map();
    for (const el of elements || []) {
        const tags = el.tags || {};
        const ref = str(tags.ref || tags.local_ref || tags.name, 20);
        if (!ref) continue;
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        if (lat == null || lon == null) continue;
        const kind = tags.aeroway || 'gate';
        const key = ref.toUpperCase();
        const prev = byRef.get(key);
        const rank = (k) => (GATE_KIND_PRIORITY[k] === undefined ? 9 : GATE_KIND_PRIORITY[k]);
        if (!prev || rank(kind) < rank(prev.kind)) byRef.set(key, { ref, lat, lon, kind });
    }
    return [...byRef.values()];
}

/**
 * The stands at an airport. Cached for a day: an airport's stands change on the
 * timescale of terminal construction, not of an event.
 *
 * `coordsFor` is injected rather than imported so this module does not have to
 * know where the backend keeps its airport coordinates (and so a test can
 * supply its own).
 */
async function fetchAirportGates(icaoCode, coordsFor, localGatesFor) {
    const code = String(icaoCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(code)) return [];

    const hit = _gateCache.get(code);
    if (hit && (Date.now() - hit.at) < GATE_CACHE_TTL_MS) return hit.gates;

    const coords = typeof coordsFor === 'function' ? coordsFor(code) : null;
    const body = 'data=' + encodeURIComponent(gateQuery(code, coords));

    let gates = null;
    let lastErr = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const res = await axios.post(endpoint, body, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: OVERPASS_TIMEOUT_MS,
            });
            const parsed = parseOverpassGates(res.data && res.data.elements);
            // An empty answer is a real answer for a field with no mapped
            // stands — but it is also what a rate-limited mirror returns while
            // pretending to be fine. Only an endpoint that found something ends
            // the loop; an empty one falls through to the next, and if they all
            // come back empty we take that as the truth.
            gates = parsed;
            if (parsed.length) break;
        } catch (err) {
            lastErr = err;
        }
    }

    // Every mirror refused. Before giving up, ask our own gate dataset — the
    // one /api/gates/:icao already serves. It has no coordinates for a map pin
    // at every field, but a named stand a pilot can pick off the list is worth
    // far more than an empty board and an apology.
    if (gates === null && typeof localGatesFor === 'function') {
        try {
            const local = await localGatesFor(code);
            if (Array.isArray(local) && local.length) {
                // Not cached: this is the degraded answer, and caching it for a
                // day would keep serving it long after Overpass came back.
                return local;
            }
        } catch { /* the fallback failing is not worth reporting over the original */ }
    }

    if (gates === null) throw lastErr || new Error('Overpass unavailable.');

    _gateCache.set(code, { at: Date.now(), gates });
    // Oldest-first eviction. A Map keeps insertion order, so the first key is
    // the least recently fetched — good enough for a cache whose whole job is
    // to survive one evening's event traffic.
    while (_gateCache.size > GATE_CACHE_MAX) {
        const oldest = _gateCache.keys().next().value;
        if (oldest === undefined) break;
        _gateCache.delete(oldest);
    }
    return gates;
}

module.exports = {
    sanitizeEvent,
    sanitizeSignupPatch,
    publicEvent,
    publicSignup,
    gateAirport,
    isWaitlisted,
    nextOffWaitlist,
    buildGateBoard,
    fetchAirportGates,
    parseOverpassGates,
    gateQuery,
    forgetGates,
    STATUSES,
};

/* ============================================================================
   crewInsights.js — what a VA's flying actually looks like.

   WHY THIS IS NOT crew_stats

   The existing stats answer "how big is this airline": pilots, hours, PIREPs,
   routes, and a top-ten by lifetime hours. They are computed in Postgres by
   crew_stats() and cached for a public homepage, and that is right for what
   they do.

   They cannot answer the questions a VA actually asks about its own operation:

     · which routes do people really fly, as opposed to which ones we published
     · who is flying NOW, as opposed to who has the most hours ever
     · which airports have become our hubs without anybody deciding that
     · which of our published routes has nobody ever flown
     · is the airline busier or quieter than it was three months ago

   Every one of those is a GROUP BY over flight reports, and none of them is in
   the SQL. Adding them there would mean a schema version bump and every VA
   re-running their migration before they saw a single figure. So this is plain
   JavaScript over rows the store already returns — it works today, on every VA,
   including the ones still on an older schema or on legacy managed storage.

   ONLY APPROVED FLIGHTS COUNT

   A pending report is a claim. A rejected one is a claim staff refused. Neither
   belongs in "your most popular route" — the whole point of review is that it
   decides what is true, and a leaderboard that counted unreviewed reports would
   reward filing rather than flying.

   Pure: no network, no database, no clock beyond `now` being injectable so the
   windows are testable.
   ========================================================================== */

'use strict';

/** Flights inside a window, oldest boundary inclusive. `days` of 0 means all. */
function withinDays(list, days, now) {
    if (!days) return list;
    const from = now - days * 86400000;
    return list.filter((f) => {
        const t = new Date(f.flownAt || f.createdAt).getTime();
        return Number.isFinite(t) && t >= from;
    });
}

const round1 = (n) => Math.round(n * 10) / 10;
const minutesOf = (list) => list.reduce((s, f) => s + (Number(f.durationMin) || 0), 0);

/** Approved flights only, newest first. The basis of everything below. */
function flownOnly(pireps) {
    return (pireps || [])
        .filter((p) => p.status === 'approved')
        .sort((a, b) => new Date(b.flownAt || b.createdAt || 0) - new Date(a.flownAt || a.createdAt || 0));
}

const icao = (s) => String(s || '').trim().toUpperCase();

/* ---------------------------------------------------------------------------
 * Most popular routes — what people FLY
 *
 * Keyed on the airports rather than the route id on purpose. A leg flown before
 * the route was published, or after it was retired, is still that city pair
 * being flown; grouping by route id would silently drop it and under-report the
 * pair that a VA is most likely to be asking about.
 * ------------------------------------------------------------------------- */
function topRoutes(flights, { limit = 10 } = {}) {
    const by = new Map();
    for (const f of flights) {
        const o = icao(f.origin); const d = icao(f.destination);
        if (!o || !d) continue;
        const key = `${o}-${d}`;
        const hit = by.get(key) || { origin: o, destination: d, flights: 0, minutes: 0, pilots: new Set() };
        hit.flights += 1;
        hit.minutes += Number(f.durationMin) || 0;
        if (f.memberId) hit.pilots.add(String(f.memberId));
        by.set(key, hit);
    }
    return [...by.values()]
        .map((r) => ({
            origin: r.origin, destination: r.destination,
            flights: r.flights, hours: round1(r.minutes / 60), pilots: r.pilots.size,
        }))
        .sort((a, b) => b.flights - a.flights || b.hours - a.hours)
        .slice(0, limit);
}

/* ---------------------------------------------------------------------------
 * Most active pilots — who is flying NOW
 *
 * Deliberately different from the existing topPilots, which ranks by the hours
 * column on the roster: that is a career total and never goes down, so it is a
 * hall of fame. It answers "who has been here longest", which is not the
 * question "who is carrying the airline this month".
 *
 * Ranked by flights rather than hours, so somebody doing short legs is not
 * beaten by one person who flew a single long-haul.
 * ------------------------------------------------------------------------- */
function topPilots(flights, members, { limit = 10 } = {}) {
    const nameOf = new Map((members || []).map((m) => [String(m._id || m.id), m]));
    const by = new Map();
    for (const f of flights) {
        // Reports filed without a roster link cannot be attributed to anybody.
        // Counting them under the typed pilot name would merge two people who
        // spell theirs differently and split one who changed theirs.
        if (!f.memberId) continue;
        const key = String(f.memberId);
        const hit = by.get(key) || { memberId: key, flights: 0, minutes: 0, landings: 0, lastFlightAt: null };
        hit.flights += 1;
        hit.minutes += Number(f.durationMin) || 0;
        hit.landings += Number(f.landings) || 0;
        const t = f.flownAt || f.createdAt || null;
        if (t && (!hit.lastFlightAt || new Date(t) > new Date(hit.lastFlightAt))) hit.lastFlightAt = t;
        by.set(key, hit);
    }
    return [...by.values()]
        .map((p) => {
            const m = nameOf.get(p.memberId);
            return {
                memberId: p.memberId,
                name: (m && m.name) || 'A pilot no longer on the roster',
                callsign: (m && m.callsign) || '',
                onRoster: !!m,
                flights: p.flights,
                hours: round1(p.minutes / 60),
                landings: p.landings,
                lastFlightAt: p.lastFlightAt,
            };
        })
        .sort((a, b) => b.flights - a.flights || b.hours - a.hours)
        .slice(0, limit);
}

/* ---------------------------------------------------------------------------
 * Busiest airports
 *
 * Departures and arrivals added together, because "how busy is this field for
 * us" is one number — a base with 40 out and 40 back is busier than one with 50
 * departures and nothing returning, and splitting them buries that.
 * ------------------------------------------------------------------------- */
function topAirports(flights, { limit = 10 } = {}) {
    const by = new Map();
    const bump = (code, which) => {
        const c = icao(code);
        if (!c) return;
        const hit = by.get(c) || { icao: c, departures: 0, arrivals: 0 };
        hit[which] += 1;
        by.set(c, hit);
    };
    for (const f of flights) { bump(f.origin, 'departures'); bump(f.destination, 'arrivals'); }
    return [...by.values()]
        .map((a) => ({ ...a, movements: a.departures + a.arrivals }))
        .sort((a, b) => b.movements - a.movements || a.icao.localeCompare(b.icao))
        .slice(0, limit);
}

/** Most flown aircraft, by legs. Useful for deciding what to add to the fleet. */
function topAircraft(flights, { limit = 10 } = {}) {
    const by = new Map();
    for (const f of flights) {
        const name = String(f.aircraftName || '').trim();
        if (!name) continue;
        const hit = by.get(name) || { aircraft: name, flights: 0, minutes: 0 };
        hit.flights += 1;
        hit.minutes += Number(f.durationMin) || 0;
        by.set(name, hit);
    }
    return [...by.values()]
        .map((a) => ({ aircraft: a.aircraft, flights: a.flights, hours: round1(a.minutes / 60) }))
        .sort((a, b) => b.flights - a.flights)
        .slice(0, limit);
}

/* ---------------------------------------------------------------------------
 * Activity by month
 *
 * Twelve buckets, oldest first, INCLUDING the empty ones. A chart that omits a
 * quiet month draws a straight line through it and hides exactly the dip a VA
 * opened this screen to find.
 * ------------------------------------------------------------------------- */
function monthlyActivity(flights, { months = 12, now = Date.now() } = {}) {
    const buckets = [];
    const cursor = new Date(now);
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    for (let i = months - 1; i >= 0; i--) {
        const d = new Date(cursor);
        d.setUTCMonth(d.getUTCMonth() - i);
        buckets.push({
            month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
            flights: 0, minutes: 0, pilots: new Set(),
        });
    }
    const index = new Map(buckets.map((b, i) => [b.month, i]));
    for (const f of flights) {
        const t = new Date(f.flownAt || f.createdAt);
        if (Number.isNaN(t.getTime())) continue;
        const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
        const i = index.get(key);
        if (i === undefined) continue;
        buckets[i].flights += 1;
        buckets[i].minutes += Number(f.durationMin) || 0;
        if (f.memberId) buckets[i].pilots.add(String(f.memberId));
    }
    return buckets.map((b) => ({
        month: b.month, flights: b.flights, hours: round1(b.minutes / 60), pilots: b.pilots.size,
    }));
}

/* ---------------------------------------------------------------------------
 * Which published routes nobody flies
 *
 * The most directly actionable thing here. A VA builds a network and then finds
 * out years later that a third of it has never been touched — this says which,
 * so it can be retired or promoted rather than quietly padding the map.
 * ------------------------------------------------------------------------- */
function routeCoverage(flights, routes) {
    const flown = new Set();
    for (const f of flights) {
        const o = icao(f.origin); const d = icao(f.destination);
        if (o && d) flown.add(`${o}-${d}`);
    }
    const active = (routes || []).filter((r) => r.active !== false);
    const never = active.filter((r) => !flown.has(`${icao(r.origin)}-${icao(r.destination)}`));
    return {
        routes: active.length,
        flown: active.length - never.length,
        neverFlown: never.length,
        // Named, not just counted — "12 routes unflown" is trivia until you can
        // see which ones.
        examples: never.slice(0, 12).map((r) => ({
            origin: icao(r.origin), destination: icao(r.destination),
            flightNumber: r.flightNumber || '',
        })),
    };
}

/* ---------------------------------------------------------------------------
 * The crew's own activity, from the noticeboard
 *
 * The crew center records a row every time a pilot joins, a promotion lands, a
 * check-ride comes due, an event is published or a schedule goes up — the same
 * events the Discord webhook announces. The webhook itself stores nothing; it
 * posts and forgets. These rows are the durable version of that feed, so they
 * are what a "what happened this month" figure can honestly be built from.
 * ------------------------------------------------------------------------- */
function crewActivity(notices, { days = 30, now = Date.now() } = {}) {
    const from = now - days * 86400000;
    const recent = (notices || []).filter((n) => {
        if (!n.auto && n.source !== 'auto') return false;   // a human wrote it
        const t = new Date(n.createdAt).getTime();
        return Number.isFinite(t) && t >= from;
    });
    const counts = {};
    for (const n of recent) {
        const k = String(n.kind || 'notice');
        counts[k] = (counts[k] || 0) + 1;
    }
    return {
        days,
        joins: counts.join || 0,
        promotions: counts.promotion || 0,
        checkrides: counts.checkride || 0,
        eventsPublished: counts.event || 0,
        schedulesPublished: counts.schedule || 0,
    };
}

/**
 * Everything, for one window.
 *
 * `days: 0` means all time. The window applies to the flight-derived figures
 * only — route coverage is deliberately all-time, because "nobody has flown
 * this in the last 30 days" is normal and "nobody has EVER flown this" is the
 * finding.
 */
function build({ pireps = [], members = [], routes = [], notices = [], days = 90, now = Date.now() } = {}) {
    const all = flownOnly(pireps);
    const window = withinDays(all, days, now);

    return {
        window: { days, from: days ? new Date(now - days * 86400000).toISOString() : null, to: new Date(now).toISOString() },
        totals: {
            flights: window.length,
            hours: round1(minutesOf(window) / 60),
            landings: window.reduce((s, f) => s + (Number(f.landings) || 0), 0),
            distanceNm: Math.round(window.reduce((s, f) => s + (Number(f.distanceNm) || 0), 0)),
            pilotsFlying: new Set(window.filter((f) => f.memberId).map((f) => String(f.memberId))).size,
            flightsAllTime: all.length,
            hoursAllTime: round1(minutesOf(all) / 60),
        },
        topRoutes: topRoutes(window),
        topPilots: topPilots(window, members),
        topAirports: topAirports(window),
        topAircraft: topAircraft(window),
        monthly: monthlyActivity(all, { now }),
        coverage: routeCoverage(all, routes),
        crew: crewActivity(notices, { now }),
        generatedAt: new Date(now).toISOString(),
    };
}

module.exports = {
    build,
    topRoutes, topPilots, topAirports, topAircraft,
    monthlyActivity, routeCoverage, crewActivity,
    flownOnly, withinDays,
};

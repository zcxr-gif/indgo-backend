// vaStats.js
// VA statistics engine — "how is this VA actually doing?"
//
// Two very different kinds of number live here, and the difference is the whole
// design:
//
//   1. REACH / ENGAGEMENT — how many people saw a VA on the tracker and how many
//      of them clicked through. The tracker (vaAds.js) beacons these at
//      POST /api/va-stats/track; the existing ad view/click counters feed in too.
//   2. OPERATIONS — takeoffs, landings, completed flights, who is airborne right
//      now, peak concurrent aircraft, busiest hour/route/aircraft. These come
//      from the ACARS takeoff/landing events server.js already receives at
//      /api/va-events.
//
// Storage is deliberately split so the raw data does NOT accumulate:
//
//   VaFlightLeg   RAW, EPHEMERAL. One doc per takeoff and per landing, for the
//                 CURRENT day only. It exists so the daily report can say
//                 "busiest route was EGLL→KJFK" and "longest flight was 6h12" —
//                 things an aggregate counter can't answer. At the end of every
//                 day, after the report is delivered, every leg for that day is
//                 DELETED. A short TTL index is the belt-and-braces backstop so
//                 a missed rollup still can't grow the collection.
//   VaStatDaily   The SUMMARY that survives — one small doc per (day, VA) plus a
//                 network-wide doc. Pure counters, `$inc`-ed atomically, so it
//                 stays tiny no matter how much traffic a day carries. Retained
//                 for VA_STATS_RETENTION_DAYS so the portal can draw a trend.
//
// End of day (the day boundary in the configured offset, see dayKey) the
// scheduler builds a report per VA, posts it to that VA's own Discord webhook
// (the same staff-approved webhook the takeoff/landing cards use) plus a
// network-wide report to the central feed, and then erases the day's legs.
//
// Env:
//   VA_STATS_TZ_OFFSET_MINUTES  shift the day boundary off UTC (default 0).
//                               e.g. -480 makes the "day" run on UTC-8.
//   VA_STATS_RETENTION_DAYS     how long the daily SUMMARIES are kept (default 120).
//   VA_STATS_LEG_TTL_HOURS      backstop TTL on raw legs (default 72).
//   VA_STATS_DAILY_REPORTS      'false' disables the end-of-day webhook posts.
//   VA_EVENTS_DISCORD_WEBHOOK_URL / DISCORD_WEBHOOK_URL   central report target.

const mongoose = require('mongoose');
const axios = require('axios');

const { extractRoute } = require('./vaEventCard');

const TZ_OFFSET_MIN = parseInt(process.env.VA_STATS_TZ_OFFSET_MINUTES, 10) || 0;
const RETENTION_DAYS = parseInt(process.env.VA_STATS_RETENTION_DAYS, 10) || 120;
const LEG_TTL_HOURS = parseInt(process.env.VA_STATS_LEG_TTL_HOURS, 10) || 72;
const DAILY_REPORTS_ENABLED = String(process.env.VA_STATS_DAILY_REPORTS || 'true').toLowerCase() !== 'false';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://inflight.info';

// A pilot list is capped so one runaway day can't turn a summary doc into a
// megabyte of usernames. Past the cap we stop adding names; the counters
// (takeoffs/landings) stay exact, only the *unique pilot* figure plateaus.
const PILOT_SET_CAP = 4000;

// An airborne entry with no landing after this long is abandoned — the pilot
// quit, the ACARS sender missed the landing, or the flight ended off-server.
// Keeps "currently airborne" honest instead of monotonically climbing.
const AIRBORNE_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/* ===========================================================================
 * Day keys
 * =========================================================================== */

// The stats "day" a moment belongs to, as YYYY-MM-DD. Everything (bucketing,
// the report, the erase) keys off this one function, so shifting
// VA_STATS_TZ_OFFSET_MINUTES moves the whole pipeline together.
function dayKey(d = new Date()) {
    return new Date(d.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

// The hour-of-day (0–23) a moment falls in, in the stats timezone. Backs the
// "busiest hour" figure.
function hourOfDay(d = new Date()) {
    return new Date(d.getTime() + TZ_OFFSET_MIN * 60000).getUTCHours();
}

function shiftDay(key, deltaDays) {
    const [y, m, d] = String(key).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
}

/* ===========================================================================
 * Models
 * =========================================================================== */

// RAW leg — one takeoff or one landing. Erased at the end of its day.
const VaFlightLegSchema = new mongoose.Schema({
    day: { type: String, required: true },
    // The VA this leg was attributed to. null = we couldn't match a listing; the
    // leg still counts toward the network totals and shows as "unattributed".
    vaAdId: { type: mongoose.Schema.Types.ObjectId, default: null },
    vaName: { type: String, default: '' },
    kind: { type: String, enum: ['takeoff', 'landing'], required: true },
    flightId: { type: String, default: '' },
    pilot: { type: String, default: '' },
    pilotKey: { type: String, default: '' },
    callsign: { type: String, default: '' },
    aircraft: { type: String, default: '' },
    livery: { type: String, default: '' },
    dep: { type: String, default: '' },
    arr: { type: String, default: '' },
    server: { type: String, default: '' },
    // Set on the LANDING leg when we saw this flight's takeoff too, so the report
    // can total airborne time without keeping the takeoff around.
    minutesAirborne: { type: Number, default: 0 },
    at: { type: Date, default: Date.now },
});
VaFlightLegSchema.index({ day: 1, vaAdId: 1, kind: 1 });
VaFlightLegSchema.index({ day: 1, at: 1 });
// Backstop only. The daily rollup deletes these explicitly; the TTL is what
// guarantees "we do not maintain this data" even if a rollup never runs.
VaFlightLegSchema.index({ at: 1 }, { expireAfterSeconds: LEG_TTL_HOURS * 3600 });

const VaFlightLeg = mongoose.models.VaFlightLeg || mongoose.model('VaFlightLeg', VaFlightLegSchema);

// Every counter the summary carries. Listed once so the schema, the zeroed
// default and the API response can't drift apart.
const COUNTER_FIELDS = [
    // Reach / engagement (tracker beacons + ad counters)
    'adImpressions',    // a VA card/banner was actually rendered on screen
    'adClicks',         // that card/banner was clicked
    'panelOpens',       // the Partners panel was opened on this VA
    'profileViews',     // the VA's detail panel was shown
    'applyClicks',      // "Apply now"
    'websiteClicks',
    'discordClicks',
    'eventClicks',      // an event link on the VA's panel
    'fleetClicks',      // a live-fleet card (opens that flight on the map)
    'rosterViews',      // the pilot roster was expanded
    'badgeClicks',      // the callsign badge inside a flight window
    'shareClicks',
    'crewCenterViews',  // the VA's Crew Center login/branding was loaded
    'embedLoads',       // the VA's embed widget resolved on their own site
    // Crew funnel (server-side, from the crew endpoints)
    'applications',
    'pireps',
    'newCrew',
    // Operations (ACARS events)
    'takeoffs',
    'landings',
    'flights',          // completed = a landing we could pair to a takeoff
    'flightMinutes',
];

const counterDefs = () => {
    const o = {};
    for (const f of COUNTER_FIELDS) o[f] = { type: Number, default: 0 };
    return o;
};

const VaStatDailySchema = new mongoose.Schema({
    day: { type: String, required: true },
    // 'va' = one partner's numbers; 'network' = everything, across every VA.
    scope: { type: String, enum: ['va', 'network'], default: 'va' },
    vaAdId: { type: mongoose.Schema.Types.ObjectId, default: null },
    vaName: { type: String, default: '' },

    ...counterDefs(),

    // Distinct pilot handles, capped (see PILOT_SET_CAP). `pilots` is everyone
    // seen; the other two split departures from arrivals so "how many pilots
    // took off" and "how many landed" are both answerable.
    pilots: { type: [String], default: [] },
    depPilots: { type: [String], default: [] },
    arrPilots: { type: [String], default: [] },

    // Breakdowns. Keys are sanitized (no dots / leading $) before writing.
    byHour: { type: Map, of: Number, default: () => new Map() },
    byAircraft: { type: Map, of: Number, default: () => new Map() },
    byRoute: { type: Map, of: Number, default: () => new Map() },
    byServer: { type: Map, of: Number, default: () => new Map() },
    byPilot: { type: Map, of: Number, default: () => new Map() },

    // Highest number of this VA's aircraft airborne at once, today.
    peakAirborne: { type: Number, default: 0 },

    // Set once the end-of-day report has been delivered. Doubles as the guard
    // that stops a restart from posting the same day twice.
    reportedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
}, { minimize: false });

VaStatDailySchema.index({ day: 1, scope: 1, vaAdId: 1 }, { unique: true });
VaStatDailySchema.index({ vaAdId: 1, day: -1 });
VaStatDailySchema.index({ day: 1, reportedAt: 1 });
VaStatDailySchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 });

const VaStatDaily = mongoose.models.VaStatDaily || mongoose.model('VaStatDaily', VaStatDailySchema);

/* ===========================================================================
 * Small helpers
 * =========================================================================== */

const dbUp = () => mongoose.connection.readyState === 1;

// Mongo map keys can't contain '.' or start with '$'. Also bound the length so a
// junk callsign can't bloat a doc.
const mapKey = (s) => String(s == null ? '' : s)
    .replace(/[.$]/g, '_')
    .trim()
    .slice(0, 48);

// Canonical pilot handle for de-duping. Same intent as the tracker's
// normUsername: the ACARS feed and our roster don't always agree on case or
// invisible characters.
const pilotKeyOf = (u) => {
    let s = String(u == null ? '' : u);
    try { s = s.normalize('NFKC'); } catch { /* older engine */ }
    return s.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase()
        .slice(0, 64);
};

const asId = (v) => {
    if (!v) return null;
    try { return new mongoose.Types.ObjectId(String(v)); } catch { return null; }
};

// Fire-and-forget write. Stats must NEVER be able to fail a user request or the
// ACARS ack path, so every write here swallows its error with a warning.
const bg = (promise, what) => {
    if (!promise || typeof promise.catch !== 'function') return;
    promise.catch(err => console.warn(`[va-stats] ${what} failed:`, err.message));
};

// Top N entries of a Mongo Map / plain object, biggest first.
function topEntries(mapish, n = 5) {
    if (!mapish) return [];
    const entries = mapish instanceof Map
        ? [...mapish.entries()]
        : Object.entries(mapish.toObject ? mapish.toObject() : mapish);
    return entries
        .filter(([, v]) => Number(v) > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([key, count]) => ({ key, count: Number(count) }));
}

/* ===========================================================================
 * The live "who is airborne right now" view
 *
 * Purely in-memory: a takeoff opens an entry, the matching landing closes it.
 * Nothing is persisted, so this costs one small Map and resets on restart —
 * which is correct, because after a restart we genuinely don't know who is
 * still up. It answers "how many are active right now" and supplies the
 * airborne duration that the landing leg records.
 * =========================================================================== */

const airborne = new Map(); // flightId -> { vaAdId, vaName, pilot, callsign, aircraft, dep, arr, server, since }

function pruneAirborne() {
    const cutoff = Date.now() - AIRBORNE_MAX_AGE_MS;
    for (const [id, entry] of airborne) {
        if (entry.since < cutoff) airborne.delete(id);
    }
}

function airborneCountFor(vaAdId) {
    const key = vaAdId ? String(vaAdId) : null;
    let n = 0;
    for (const entry of airborne.values()) {
        if (key === null || String(entry.vaAdId || '') === key) n += 1;
    }
    return n;
}

// Everything currently in the air, newest departure first, plus per-VA counts.
function liveSnapshot({ limit = 100 } = {}) {
    pruneAirborne();
    const now = Date.now();
    const flights = [...airborne.entries()]
        .map(([flightId, e]) => ({
            flightId,
            vaAdId: e.vaAdId ? String(e.vaAdId) : null,
            vaName: e.vaName || '',
            pilot: e.pilot || '',
            callsign: e.callsign || '',
            aircraft: e.aircraft || '',
            dep: e.dep || '',
            arr: e.arr || '',
            server: e.server || '',
            since: new Date(e.since),
            minutesAirborne: Math.round((now - e.since) / 60000),
        }))
        .sort((a, b) => b.since - a.since);

    const byVa = new Map();
    for (const f of flights) {
        // Flights we couldn't match to a listing still group by the name the
        // ACARS feed gave us — lumping every unmatched VA into one row would
        // label them all with whichever happened to arrive first.
        const key = f.vaAdId || `name:${(f.vaName || '').toLowerCase()}`;
        const row = byVa.get(key) || { vaAdId: f.vaAdId, vaName: f.vaName || 'Unattributed', airborne: 0, pilots: new Set() };
        row.airborne += 1;
        if (f.pilot) row.pilots.add(pilotKeyOf(f.pilot));
        byVa.set(key, row);
    }

    return {
        airborne: flights.length,
        pilots: new Set(flights.map(f => pilotKeyOf(f.pilot)).filter(Boolean)).size,
        vas: [...byVa.values()]
            .map(r => ({ vaAdId: r.vaAdId, vaName: r.vaName, airborne: r.airborne, pilots: r.pilots.size }))
            .sort((a, b) => b.airborne - a.airborne),
        flights: flights.slice(0, limit),
    };
}

/* ===========================================================================
 * Writing
 * =========================================================================== */

// One `updateOne` shape used by every write path. `inc` is a flat counter map,
// `addPilots` folds handles into the de-duped sets, `max` applies $max.
// Upserts, so the first event of the day creates the doc.
function bumpDoc({ day, scope, vaAdId, vaName }, { inc = {}, addPilots = {}, max = {} } = {}) {
    if (!dbUp()) return null;
    const filter = { day, scope, vaAdId: vaAdId || null };
    const update = {
        $setOnInsert: { createdAt: new Date() },
    };
    if (vaName) update.$set = { vaName };
    const incFields = Object.entries(inc).filter(([, v]) => Number(v));
    if (incFields.length) update.$inc = Object.fromEntries(incFields.map(([k, v]) => [k, Number(v)]));
    const addFields = Object.entries(addPilots).filter(([, v]) => v && v.length);
    if (addFields.length) {
        update.$addToSet = Object.fromEntries(addFields.map(([k, v]) => [k, { $each: v }]));
    }
    const maxFields = Object.entries(max).filter(([, v]) => Number.isFinite(v));
    if (maxFields.length) update.$max = Object.fromEntries(maxFields);

    // Two events for the same (day, VA) arriving before the doc exists can both
    // try to insert it, and the unique index turns the loser into a duplicate-key
    // error — silently dropping that event's counters. Retry once: by then the
    // doc exists, so the retry is a plain $inc that lands.
    // setDefaultsOnInsert is OFF deliberately. The counters are written as dotted
    // paths ($inc on 'byHour.14', 'byAircraft.A359'), and letting Mongoose also
    // $setOnInsert the parent `byHour` / `byAircraft` defaults would make Mongo
    // reject the whole update as a conflicting path. Nothing is lost: an absent
    // counter reads back as zero and an absent map/array reads back as empty
    // (see shapeDaily), and createdAt — which the retention TTL indexes — is set
    // explicitly above.
    const opts = { upsert: true, setDefaultsOnInsert: false };
    return VaStatDaily.updateOne(filter, update, opts).catch((err) => {
        if (err && err.code === 11000) return VaStatDaily.updateOne(filter, update, opts);
        throw err;
    });
}

// Record against BOTH the VA's own doc and the network doc in one go. Engagement
// on an unknown VA still counts toward the network.
function bump({ vaAdId, vaName, day = dayKey() }, payload) {
    const id = asId(vaAdId);
    if (id) bg(bumpDoc({ day, scope: 'va', vaAdId: id, vaName }, payload), 'va bump');
    bg(bumpDoc({ day, scope: 'network', vaAdId: null, vaName: '' }, payload), 'network bump');
}

// Public: bump one engagement counter for a VA. `type` is a tracker-facing name
// (see ENGAGEMENT_TYPES); unknown types are ignored rather than trusted.
const ENGAGEMENT_TYPES = {
    impression: 'adImpressions',
    click: 'adClicks',
    open: 'panelOpens',
    profile: 'profileViews',
    apply: 'applyClicks',
    website: 'websiteClicks',
    discord: 'discordClicks',
    event: 'eventClicks',
    fleet: 'fleetClicks',
    roster: 'rosterViews',
    badge: 'badgeClicks',
    share: 'shareClicks',
    crewCenter: 'crewCenterViews',
    embed: 'embedLoads',
    application: 'applications',
    pirep: 'pireps',
    crewJoin: 'newCrew',
};

// Bump one or more engagement counters. Safe to call from anywhere — it never
// throws, never awaits a DB round-trip on the caller's behalf.
function recordEngagement(vaAdId, type, count = 1, vaName = '') {
    const field = ENGAGEMENT_TYPES[type];
    if (!field) return false;
    // An engagement with no VA attached is meaningless (and, from the public
    // beacon, untrusted junk) — it would inflate the network totals with a row
    // no VA can be held to. Require a real listing id.
    const id = asId(vaAdId);
    if (!id) return false;
    const n = Math.max(1, Math.min(50, parseInt(count, 10) || 1));
    bump({ vaAdId: id, vaName }, { inc: { [field]: n } });
    return true;
}

// Record one ACARS takeoff/landing. Called from server.js's handleVaEvent AFTER
// the duplicate check, with whatever VA listing we could attribute it to (which
// may be null, and need NOT be a webhook-approved partner — a VA that never
// wired up a webhook still gets its numbers).
function recordFlightEvent(e, ad) {
    const now = new Date();
    const day = dayKey(now);
    const vaAdId = ad ? asId(ad._id) : null;
    const vaName = (ad && ad.name) || e.va?.name || e.va?.code || '';
    const isTakeoff = e.event === 'takeoff';
    const { dep, arr } = extractRoute(e) || {};
    const ac = e.aircraft || {};
    const pilot = String(e.username || '').trim();
    const pKey = pilotKeyOf(pilot);
    const flightId = String(e.flightId || '');

    pruneAirborne();

    // --- live airborne bookkeeping + flight pairing ---
    let minutesAirborne = 0;
    let completed = false;
    if (isTakeoff) {
        if (flightId) {
            airborne.set(flightId, {
                vaAdId: vaAdId ? String(vaAdId) : null,
                vaName,
                pilot,
                callsign: e.callsign || '',
                aircraft: ac.aircraftName || '',
                dep: dep || '',
                arr: arr || '',
                server: e.server || '',
                since: now.getTime(),
            });
        }
    } else {
        const open = flightId ? airborne.get(flightId) : null;
        if (open) {
            minutesAirborne = Math.max(0, Math.round((now.getTime() - open.since) / 60000));
            completed = true;
            airborne.delete(flightId);
        }
    }

    // --- raw leg (erased at end of day) ---
    if (dbUp()) {
        bg(VaFlightLeg.create({
            day,
            vaAdId,
            vaName,
            kind: isTakeoff ? 'takeoff' : 'landing',
            flightId,
            pilot,
            pilotKey: pKey,
            callsign: e.callsign || '',
            aircraft: ac.aircraftName || '',
            livery: ac.liveryName || '',
            dep: dep || '',
            arr: arr || '',
            server: e.server || '',
            minutesAirborne,
            at: now,
        }), 'leg insert');
    }

    // --- aggregate counters ---
    const inc = {
        [isTakeoff ? 'takeoffs' : 'landings']: 1,
        [`byHour.${hourOfDay(now)}`]: 1,
    };
    if (completed) { inc.flights = 1; inc.flightMinutes = minutesAirborne; }
    if (ac.aircraftName) inc[`byAircraft.${mapKey(ac.aircraftName)}`] = 1;
    if (e.server) inc[`byServer.${mapKey(e.server)}`] = 1;
    if (pilot) inc[`byPilot.${mapKey(pilot)}`] = 1;
    // A route is only meaningful once, on the landing — counting it on both legs
    // would double every city pair.
    if (!isTakeoff && (dep || arr)) inc[`byRoute.${mapKey(`${dep || '????'}-${arr || '????'}`)}`] = 1;

    const addPilots = {};
    if (pKey) {
        addPilots.pilots = [pKey];
        addPilots[isTakeoff ? 'depPilots' : 'arrPilots'] = [pKey];
    }

    const max = {};
    if (isTakeoff) {
        max.peakAirborne = airborneCountFor(vaAdId);
    }

    // Per-VA doc gets the VA's own peak; the network doc gets the global peak.
    const id = vaAdId;
    if (id) {
        bg(bumpDoc({ day, scope: 'va', vaAdId: id, vaName }, { inc, addPilots, max }), 'va flight bump');
    }
    bg(bumpDoc({ day, scope: 'network', vaAdId: null }, {
        inc,
        addPilots,
        max: isTakeoff ? { peakAirborne: airborne.size } : {},
    }), 'network flight bump');
}

// Guard the pilot sets against unbounded growth. Runs on the rollup, cheap, and
// only ever trims — the counters themselves are never touched.
async function trimPilotSets(day) {
    if (!dbUp()) return;
    try {
        const oversized = await VaStatDaily.find({
            day,
            $or: [
                { [`pilots.${PILOT_SET_CAP}`]: { $exists: true } },
                { [`depPilots.${PILOT_SET_CAP}`]: { $exists: true } },
                { [`arrPilots.${PILOT_SET_CAP}`]: { $exists: true } },
            ],
        }).select('_id pilots depPilots arrPilots').lean();
        for (const doc of oversized) {
            await VaStatDaily.updateOne({ _id: doc._id }, {
                $set: {
                    pilots: (doc.pilots || []).slice(0, PILOT_SET_CAP),
                    depPilots: (doc.depPilots || []).slice(0, PILOT_SET_CAP),
                    arrPilots: (doc.arrPilots || []).slice(0, PILOT_SET_CAP),
                },
            });
        }
    } catch (err) {
        console.warn('[va-stats] pilot-set trim failed:', err.message);
    }
}

/* ===========================================================================
 * Reading
 * =========================================================================== */

const zeroCounters = () => Object.fromEntries(COUNTER_FIELDS.map(f => [f, 0]));

// Shape one summary doc for the API. Adds the derived figures (unique pilot
// counts, CTR, average flight time, the top-N breakdowns) so every surface
// computes them identically.
function shapeDaily(doc, day) {
    const d = doc || {};
    const counters = zeroCounters();
    for (const f of COUNTER_FIELDS) counters[f] = Number(d[f] || 0);

    const impressions = counters.adImpressions;
    const clicks = counters.adClicks;
    const engagementTotal = clicks + counters.panelOpens + counters.profileViews
        + counters.applyClicks + counters.websiteClicks + counters.discordClicks
        + counters.eventClicks + counters.fleetClicks + counters.badgeClicks
        + counters.rosterViews + counters.shareClicks;

    return {
        day: d.day || day,
        vaAdId: d.vaAdId ? String(d.vaAdId) : null,
        vaName: d.vaName || '',
        ...counters,
        uniquePilots: (d.pilots || []).length,
        pilotsDeparted: (d.depPilots || []).length,
        pilotsLanded: (d.arrPilots || []).length,
        peakAirborne: Number(d.peakAirborne || 0),
        avgFlightMinutes: counters.flights ? Math.round(counters.flightMinutes / counters.flights) : 0,
        clickRate: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0, // %, 1dp
        engagementTotal,
        topAircraft: topEntries(d.byAircraft),
        topRoutes: topEntries(d.byRoute),
        topPilots: topEntries(d.byPilot),
        topServers: topEntries(d.byServer),
        byHour: (() => {
            const src = d.byHour instanceof Map ? Object.fromEntries(d.byHour) : (d.byHour || {});
            return Array.from({ length: 24 }, (_, h) => Number(src[String(h)] || 0));
        })(),
        busiestHour: (() => {
            const src = d.byHour instanceof Map ? Object.fromEntries(d.byHour) : (d.byHour || {});
            let best = null;
            for (let h = 0; h < 24; h += 1) {
                const v = Number(src[String(h)] || 0);
                if (v > 0 && (!best || v > best.count)) best = { hour: h, count: v };
            }
            return best;
        })(),
        reportedAt: d.reportedAt || null,
    };
}

// Load one (day, VA) summary, always returning a shaped object — a day with no
// activity reads back as a full row of zeros rather than null.
async function getDaily({ vaAdId = null, day = dayKey(), scope = null } = {}) {
    const useScope = scope || (vaAdId ? 'va' : 'network');
    if (!dbUp()) return shapeDaily(null, day);
    const doc = await VaStatDaily.findOne({ day, scope: useScope, vaAdId: asId(vaAdId) }).lean();
    return shapeDaily(doc, day);
}

// A contiguous run of days (oldest first) for trend charts. Missing days are
// filled with zeros so the series never has holes.
async function getRange({ vaAdId = null, days = 30, endDay = dayKey(), scope = null } = {}) {
    const useScope = scope || (vaAdId ? 'va' : 'network');
    const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const keys = [];
    for (let i = n - 1; i >= 0; i -= 1) keys.push(shiftDay(endDay, -i));
    let docs = [];
    if (dbUp()) {
        docs = await VaStatDaily.find({
            day: { $in: keys }, scope: useScope, vaAdId: asId(vaAdId),
        }).lean();
    }
    const byDay = new Map(docs.map(d => [d.day, d]));
    return keys.map(k => shapeDaily(byDay.get(k), k));
}

// Sum a shaped series into one total row. Breakdowns are re-merged so a 30-day
// "top route" is the top route across the whole window, not just the last day.
function sumSeries(rows, label = '') {
    const total = zeroCounters();
    const merge = (acc, list) => {
        for (const { key, count } of list) acc.set(key, (acc.get(key) || 0) + count);
        return acc;
    };
    const aircraft = new Map(); const routes = new Map(); const pilots = new Map(); const servers = new Map();
    const byHour = new Array(24).fill(0);
    let peakAirborne = 0;
    let uniquePilots = 0; let pilotsDeparted = 0; let pilotsLanded = 0;

    for (const r of rows) {
        for (const f of COUNTER_FIELDS) total[f] += Number(r[f] || 0);
        merge(aircraft, r.topAircraft); merge(routes, r.topRoutes);
        merge(pilots, r.topPilots); merge(servers, r.topServers);
        r.byHour.forEach((v, i) => { byHour[i] += v; });
        peakAirborne = Math.max(peakAirborne, r.peakAirborne);
        uniquePilots = Math.max(uniquePilots, r.uniquePilots);
        pilotsDeparted = Math.max(pilotsDeparted, r.pilotsDeparted);
        pilotsLanded = Math.max(pilotsLanded, r.pilotsLanded);
    }

    const toList = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, count]) => ({ key, count }));
    return {
        label,
        days: rows.length,
        ...total,
        // Across several days these are a best-effort floor: we keep per-day sets,
        // not a cross-day set, so the window figure is the busiest single day.
        uniquePilots, pilotsDeparted, pilotsLanded, peakAirborne,
        avgFlightMinutes: total.flights ? Math.round(total.flightMinutes / total.flights) : 0,
        clickRate: total.adImpressions ? Math.round((total.adClicks / total.adImpressions) * 1000) / 10 : 0,
        topAircraft: toList(aircraft), topRoutes: toList(routes),
        topPilots: toList(pilots), topServers: toList(servers),
        byHour,
    };
}

// The full picture for one VA: today, yesterday, 7/30-day rollups, the daily
// series, what's airborne right now, and today's raw legs (which exist only
// until the end-of-day erase).
async function vaOverview(vaAdId, { vaName = '', days = 30, legLimit = 50 } = {}) {
    const today = dayKey();
    const [series, legs] = await Promise.all([
        getRange({ vaAdId, days, endDay: today }),
        recentLegs({ vaAdId, day: today, limit: legLimit }),
    ]);
    const byDay = new Map(series.map(r => [r.day, r]));
    const live = liveSnapshot({ limit: 200 });
    const vaKey = vaAdId ? String(vaAdId) : null;

    return {
        day: today,
        timezoneOffsetMinutes: TZ_OFFSET_MIN,
        va: { id: vaKey, name: vaName },
        today: byDay.get(today) || shapeDaily(null, today),
        yesterday: byDay.get(shiftDay(today, -1)) || shapeDaily(null, shiftDay(today, -1)),
        last7: sumSeries(series.slice(-7), 'Last 7 days'),
        last30: sumSeries(series, `Last ${series.length} days`),
        series,
        live: {
            airborne: vaKey ? (live.vas.find(v => v.vaAdId === vaKey)?.airborne || 0) : live.airborne,
            pilots: vaKey ? (live.vas.find(v => v.vaAdId === vaKey)?.pilots || 0) : live.pilots,
            flights: vaKey ? live.flights.filter(f => f.vaAdId === vaKey) : live.flights,
        },
        legs,
    };
}

// Today's raw legs — the data that gets erased tonight. Newest first.
async function recentLegs({ vaAdId = null, day = dayKey(), limit = 50 } = {}) {
    if (!dbUp()) return [];
    const q = { day };
    if (vaAdId) q.vaAdId = asId(vaAdId);
    const rows = await VaFlightLeg.find(q).sort({ at: -1 })
        .limit(Math.max(1, Math.min(500, limit))).lean();
    return rows.map(r => ({
        kind: r.kind,
        flightId: r.flightId,
        vaAdId: r.vaAdId ? String(r.vaAdId) : null,
        vaName: r.vaName || '',
        pilot: r.pilot || '',
        callsign: r.callsign || '',
        aircraft: r.aircraft || '',
        dep: r.dep || '',
        arr: r.arr || '',
        server: r.server || '',
        minutesAirborne: r.minutesAirborne || 0,
        at: r.at,
    }));
}

// Every VA with a row for `day`, biggest first — the staff leaderboard.
async function leaderboard({ day = dayKey(), sort = 'flights', limit = 50 } = {}) {
    if (!dbUp()) return [];
    const allowed = new Set([...COUNTER_FIELDS, 'peakAirborne']);
    const field = allowed.has(sort) ? sort : 'flights';
    const docs = await VaStatDaily.find({ day, scope: 'va' })
        .sort({ [field]: -1 })
        .limit(Math.max(1, Math.min(200, limit)))
        .lean();
    return docs.map(d => shapeDaily(d, day));
}

/* ===========================================================================
 * The end-of-day report
 * =========================================================================== */

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const dur = (mins) => {
    const m = Math.max(0, Math.round(Number(mins) || 0));
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
// "+12" / "−4" / "—" against yesterday, so the report reads as a trend not a
// snapshot. Uses a real minus sign so the two directions line up visually.
const delta = (now, before) => {
    const d = Number(now || 0) - Number(before || 0);
    if (!d) return '—';
    return d > 0 ? `+${fmt(d)}` : `−${fmt(Math.abs(d))}`;
};
const prettyRoute = (key) => String(key || '').replace('-', ' → ');

const BRAND_ICON = `${PUBLIC_BASE_URL}/assets/brand/inflight-logo.png`;

// Build the Discord embed for one day. `scopeName` labels the report ("Air
// Canada Virtual" or "Network"). `prev` is yesterday's shaped row, used for the
// deltas; pass a zero row when there is no yesterday.
function buildReportEmbed({ day, stats, prev, scopeName, logoUrl, accentInt, extraFields = [] }) {
    const flightsLine = [
        `**${fmt(stats.takeoffs)}** takeoffs (${delta(stats.takeoffs, prev.takeoffs)})`,
        `**${fmt(stats.landings)}** landings (${delta(stats.landings, prev.landings)})`,
        `**${fmt(stats.flights)}** completed flights`,
    ].join('\n');

    const pilotsLine = [
        `**${fmt(stats.uniquePilots)}** pilots flew (${delta(stats.uniquePilots, prev.uniquePilots)})`,
        `**${fmt(stats.pilotsDeparted)}** departed · **${fmt(stats.pilotsLanded)}** landed`,
        `**${fmt(stats.peakAirborne)}** airborne at peak`,
    ].join('\n');

    const timeLine = [
        `**${dur(stats.flightMinutes)}** total airborne`,
        stats.flights ? `**${dur(stats.avgFlightMinutes)}** average leg` : null,
        stats.busiestHour ? `Busiest hour **${String(stats.busiestHour.hour).padStart(2, '0')}:00Z** (${fmt(stats.busiestHour.count)} movements)` : null,
    ].filter(Boolean).join('\n');

    const reachLine = [
        `**${fmt(stats.adImpressions)}** impressions (${delta(stats.adImpressions, prev.adImpressions)})`,
        `**${fmt(stats.profileViews)}** profile views · **${fmt(stats.adClicks)}** clicks`,
        `**${stats.clickRate}%** click-through`,
    ].join('\n');

    const outboundLine = [
        `**${fmt(stats.applyClicks)}** apply · **${fmt(stats.websiteClicks)}** website · **${fmt(stats.discordClicks)}** Discord`,
        `**${fmt(stats.crewCenterViews)}** crew centre · **${fmt(stats.embedLoads)}** embed loads`,
        `**${fmt(stats.applications)}** applications · **${fmt(stats.pireps)}** PIREPs · **${fmt(stats.newCrew)}** new crew`,
    ].join('\n');

    const listField = (name, rows, render) => (rows.length
        ? { name, value: rows.map((r, i) => `\`${i + 1}.\` ${render(r)}`).join('\n').slice(0, 1024), inline: true }
        : null);

    const fields = [
        { name: '✈️ Flights', value: flightsLine, inline: true },
        { name: '👨‍✈️ Pilots', value: pilotsLine, inline: true },
        { name: '⏱️ Air time', value: timeLine || '—', inline: false },
        { name: '👀 Reach', value: reachLine, inline: true },
        { name: '🔗 Engagement', value: outboundLine, inline: true },
        listField('🛫 Top routes', stats.topRoutes, r => `${prettyRoute(r.key)} — ${fmt(r.count)}`),
        listField('🛩️ Top aircraft', stats.topAircraft, r => `${r.key} — ${fmt(r.count)}`),
        listField('🏅 Most active pilots', stats.topPilots, r => `${r.key} — ${fmt(r.count)}`),
        ...extraFields,
    ].filter(Boolean);

    return {
        color: accentInt,
        author: logoUrl
            ? { name: scopeName, icon_url: logoUrl }
            : { name: scopeName },
        title: `📊 Daily report — ${day}`,
        description: stats.takeoffs + stats.landings === 0
            ? '_No flights logged today._'
            : `A full day of operations for **${scopeName}**.`,
        fields: fields.slice(0, 25),
        footer: {
            text: 'Inflight · daily VA statistics · flight records cleared after this report',
            icon_url: BRAND_ICON,
        },
        timestamp: new Date().toISOString(),
    };
}

const isDiscordWebhook = (url) => {
    try {
        const u = new URL(String(url));
        return /^https?:$/.test(u.protocol)
            && /(^|\.)discord(app)?\.com$/i.test(u.hostname)
            && /^\/api\/webhooks\//.test(u.pathname);
    } catch { return false; }
};

// Post one report, retrying nothing — a failed report is logged and the day is
// still marked reported, because the *erase* must not be blocked by a VA's
// broken webhook. (The summary row survives, so the numbers are never lost.)
async function postReport(webhookUrl, embed) {
    if (!isDiscordWebhook(webhookUrl)) return false;
    await axios.post(webhookUrl, { embeds: [embed] }, { timeout: 15000 });
    return true;
}

/**
 * Run the end-of-day pipeline for `day`:
 *   1. trim the pilot sets,
 *   2. post a per-VA report to every VA whose flight-events webhook is live,
 *   3. post the network report to the central feed,
 *   4. ERASE every raw leg for that day (and anything older still lying around),
 *   5. stamp reportedAt so a restart can't repeat it.
 *
 * `dryRun` builds and returns the reports without posting or erasing — that's
 * what the staff "preview" and the portal "send me a test" paths use.
 * `force` ignores the reportedAt guard.
 */
async function runDailyReport({ day = shiftDay(dayKey(), -1), dryRun = false, force = false, only = null } = {}) {
    // Same shape as a successful run (minus the content) so callers can read
    // .reports without guarding for the database being down.
    if (!dbUp()) return { ok: false, error: 'database not connected', day, dryRun, reports: [], erased: 0, skipped: [] };

    const result = { day, dryRun, reports: [], erased: 0, skipped: [] };

    if (!dryRun) await trimPilotSets(day);

    const [vaDocs, networkDoc, prevDocs] = await Promise.all([
        VaStatDaily.find({ day, scope: 'va' }).lean(),
        VaStatDaily.findOne({ day, scope: 'network' }).lean(),
        VaStatDaily.find({ day: shiftDay(day, -1) }).lean(),
    ]);

    const prevByVa = new Map(prevDocs.filter(d => d.scope === 'va').map(d => [String(d.vaAdId), d]));
    const prevNetwork = prevDocs.find(d => d.scope === 'network') || null;

    // Look the listings up once so we can read each VA's webhook + branding.
    const VirtualAirlineAd = mongoose.models.VirtualAirlineAd;
    let ads = [];
    if (VirtualAirlineAd) {
        const ids = vaDocs.map(d => d.vaAdId).filter(Boolean);
        if (ids.length) {
            ads = await VirtualAirlineAd.find({ _id: { $in: ids } })
                .select('name logoUrl flightEventsApproved flightEventsEnabled flightEventsCard +flightEventsWebhookUrl')
                .lean();
        }
    }
    const adById = new Map(ads.map(a => [String(a._id), a]));

    const accentOf = (ad) => {
        const raw = ad && ad.flightEventsCard && ad.flightEventsCard.accent;
        const m = /^#?([0-9a-f]{6})$/i.exec(String(raw || ''));
        return m ? parseInt(m[1], 16) : 0x3b82f6;
    };

    // --- per-VA reports ---
    for (const doc of vaDocs) {
        const id = String(doc.vaAdId || '');
        if (only && id !== String(only)) continue;
        if (!force && !dryRun && doc.reportedAt) { result.skipped.push({ vaAdId: id, reason: 'already reported' }); continue; }

        const ad = adById.get(id);
        const stats = shapeDaily(doc, day);
        const prev = shapeDaily(prevByVa.get(id), shiftDay(day, -1));
        const embed = buildReportEmbed({
            day,
            stats,
            prev,
            scopeName: doc.vaName || (ad && ad.name) || 'Virtual Airline',
            logoUrl: ad && ad.logoUrl,
            accentInt: accentOf(ad),
        });

        const deliverable = !!(ad && ad.flightEventsApproved && ad.flightEventsEnabled
            && ad.flightEventsWebhookUrl && isDiscordWebhook(ad.flightEventsWebhookUrl));

        const entry = { vaAdId: id, vaName: stats.vaName, deliverable, posted: false, embed: dryRun ? embed : undefined };

        if (!dryRun && DAILY_REPORTS_ENABLED && deliverable) {
            try {
                await postReport(ad.flightEventsWebhookUrl, embed);
                entry.posted = true;
            } catch (err) {
                entry.error = err.message;
                console.warn(`[va-stats] daily report to "${stats.vaName}" failed:`, err.message);
            }
        }
        result.reports.push(entry);
    }

    // --- network report ---
    if (!only) {
        const netStats = shapeDaily(networkDoc, day);
        const netPrev = shapeDaily(prevNetwork, shiftDay(day, -1));
        const byFlights = vaDocs.slice().sort((a, b) => (b.flights || 0) - (a.flights || 0)).slice(0, 5);
        const byReach = vaDocs.slice().sort((a, b) => (b.adClicks || 0) - (a.adClicks || 0)).slice(0, 5);
        const extraFields = [
            byFlights.length ? {
                name: '🏆 Busiest VAs',
                value: byFlights.map((d, i) => `\`${i + 1}.\` ${d.vaName || 'Unknown'} — ${fmt(d.flights || 0)} flights`).join('\n').slice(0, 1024),
                inline: true,
            } : null,
            byReach.length ? {
                name: '📈 Most clicked VAs',
                value: byReach.map((d, i) => `\`${i + 1}.\` ${d.vaName || 'Unknown'} — ${fmt(d.adClicks || 0)} clicks`).join('\n').slice(0, 1024),
                inline: true,
            } : null,
            { name: '🏢 Active VAs', value: `**${fmt(vaDocs.filter(d => (d.takeoffs || 0) + (d.landings || 0) > 0).length)}** VAs flew today`, inline: false },
        ].filter(Boolean);

        const embed = buildReportEmbed({
            day, stats: netStats, prev: netPrev, scopeName: 'Inflight network',
            logoUrl: BRAND_ICON, accentInt: 0x6366f1, extraFields,
        });
        const central = process.env.VA_EVENTS_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || null;
        const entry = { scope: 'network', deliverable: !!central, posted: false, embed: dryRun ? embed : undefined };
        if (!dryRun && DAILY_REPORTS_ENABLED && central) {
            try { await postReport(central, embed); entry.posted = true; }
            catch (err) { entry.error = err.message; console.warn('[va-stats] network report failed:', err.message); }
        }
        result.reports.push(entry);
    }

    if (dryRun) return result;

    // --- stamp + ERASE ---
    // The whole point of the raw legs is the report we just built. Now that it's
    // out, they go: this day's legs and anything older that's still lying around
    // (a day the scheduler slept through). The summaries stay.
    await VaStatDaily.updateMany({ day }, { $set: { reportedAt: new Date() } });
    try {
        const del = await VaFlightLeg.deleteMany({ day: { $lte: day } });
        result.erased = del.deletedCount || 0;
        console.log(`🧹 [va-stats] ${day} report delivered — erased ${result.erased} flight records.`);
    } catch (err) {
        console.error('[va-stats] leg erase failed:', err.message);
        result.eraseError = err.message;
    }

    pruneAirborne();
    return result;
}

/* ===========================================================================
 * Scheduler
 *
 * A minute tick that notices the stats day rolling over and reports the day
 * that just ended. On boot it also sweeps for any earlier day that was never
 * reported (the process was down at midnight), so a restart can't strand a
 * day's raw legs in the database.
 * =========================================================================== */

let currentDay = null;
let tickTimer = null;

async function catchUpUnreported() {
    if (!dbUp()) return;
    try {
        const today = dayKey();
        // `reportedAt: null` matches both an explicit null and a missing field,
        // which is what an upserted doc has until a report stamps it.
        const pending = await VaStatDaily.distinct('day', { day: { $lt: today }, reportedAt: null });
        for (const day of pending.sort()) {
            console.log(`[va-stats] catching up unreported day ${day}…`);
            await runDailyReport({ day });
        }
        // Sweep any orphan legs from days with no summary row at all.
        const del = await VaFlightLeg.deleteMany({ day: { $lt: today } });
        if (del.deletedCount) console.log(`🧹 [va-stats] erased ${del.deletedCount} stale flight records.`);
    } catch (err) {
        console.warn('[va-stats] catch-up failed:', err.message);
    }
}

function tick() {
    const today = dayKey();
    if (currentDay && currentDay !== today) {
        const ended = currentDay;
        currentDay = today;
        runDailyReport({ day: ended })
            .catch(err => console.error('[va-stats] daily report failed:', err.message));
        return;
    }
    currentDay = today;
}

// Boot the scheduler. Safe to call more than once.
function start() {
    if (tickTimer) return;
    currentDay = dayKey();
    tickTimer = setInterval(tick, 60 * 1000);
    if (tickTimer.unref) tickTimer.unref();

    const boot = () => { catchUpUnreported().catch(() => {}); };
    if (dbUp()) boot(); else mongoose.connection.once('connected', boot);

    console.log(`📊 [va-stats] engine started — day "${currentDay}"`
        + `${TZ_OFFSET_MIN ? ` (UTC${TZ_OFFSET_MIN >= 0 ? '+' : ''}${TZ_OFFSET_MIN / 60}h)` : ' (UTC)'}`
        + `, daily reports ${DAILY_REPORTS_ENABLED ? 'on' : 'off'}.`);
}

/* ===========================================================================
 * Routes
 * =========================================================================== */

// Crude per-IP budget for the public tracking beacon. The endpoint is
// unauthenticated by necessity (it's called from a browser on someone else's
// page), so it gets a ceiling rather than trust. Window resets lazily.
const TRACK_LIMIT_PER_MIN = parseInt(process.env.VA_STATS_TRACK_LIMIT, 10) || 240;
const trackBuckets = new Map(); // ip -> { count, resetAt }

function overTrackLimit(ip) {
    const now = Date.now();
    let b = trackBuckets.get(ip);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + 60000 }; trackBuckets.set(ip, b); }
    b.count += 1;
    if (trackBuckets.size > 5000) {
        for (const [k, v] of trackBuckets) { if (v.resetAt <= now) trackBuckets.delete(k); }
    }
    return b.count > TRACK_LIMIT_PER_MIN;
}

/**
 * Mount every stats route.
 *
 * @param {object} app        the express app
 * @param {object} deps
 *   requireAuth    staff-session guard (staffAuth.requireAuth)
 *   requireAdmin   admin-only guard; gates the destructive end-of-day run.
 *                  Falls back to requireAuth when not supplied.
 *   requirePortal  VA-portal guard (vaPortal); req.portal.vaAdId scopes the VA
 */
function registerVaStatsRoutes(app, { requireAuth, requireAdmin, requirePortal } = {}) {
    // ---- public ingest ---------------------------------------------------
    // The tracker beacons here. Accepts either a single { vaId, type } or a
    // batch { events: [{ vaId, type, count }] } so a page can flush several
    // impressions in one sendBeacon on unload.
    app.post('/api/va-stats/track', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
        if (overTrackLimit(ip)) return res.status(429).json({ ok: false, error: 'rate limited' });

        const body = req.body || {};
        const list = Array.isArray(body.events) ? body.events.slice(0, 40)
            : (body.type ? [body] : []);
        let accepted = 0;
        for (const ev of list) {
            if (!ev || typeof ev !== 'object') continue;
            if (recordEngagement(ev.vaId || ev.vaAdId || body.vaId, ev.type, ev.count, ev.vaName || '')) accepted += 1;
        }
        res.json({ ok: true, accepted });
    });

    // ---- public reads ----------------------------------------------------
    // Who is in the air right now, network-wide. Cheap (memory only) and open,
    // so the tracker and a VA's own site can both show a live counter.
    app.get('/api/va-stats/live', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const snap = liveSnapshot({ limit: Math.min(200, parseInt(req.query.limit, 10) || 100) });
        res.json({ ok: true, ...snap });
    });

    // A VA's own public numbers — safe subset, for a crew centre or the VA's site.
    app.get('/api/va-stats/public/:vaId', async (req, res) => {
        try {
            const id = asId(req.params.vaId);
            if (!id) return res.status(404).json({ ok: false, error: 'unknown VA' });
            const [today, week] = await Promise.all([
                getDaily({ vaAdId: id }),
                getRange({ vaAdId: id, days: 7 }),
            ]);
            const live = liveSnapshot({ limit: 200 });
            const row = live.vas.find(v => v.vaAdId === String(id));
            const w = sumSeries(week, 'Last 7 days');
            res.set('Cache-Control', 'public, max-age=60');
            res.json({
                ok: true,
                day: today.day,
                airborneNow: row ? row.airborne : 0,
                today: {
                    takeoffs: today.takeoffs, landings: today.landings, flights: today.flights,
                    uniquePilots: today.uniquePilots, peakAirborne: today.peakAirborne,
                    flightMinutes: today.flightMinutes,
                },
                last7: {
                    takeoffs: w.takeoffs, landings: w.landings, flights: w.flights,
                    flightMinutes: w.flightMinutes, topRoutes: w.topRoutes, topAircraft: w.topAircraft,
                },
            });
        } catch (err) {
            console.error('[va-stats] public read failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not load statistics.' });
        }
    });

    // ---- VA portal (the partner's own dashboard) -------------------------
    if (requirePortal) {
        app.get('/api/va-portal/stats', requirePortal, async (req, res) => {
            try {
                const vaAdId = req.portal.vaAdId;
                if (!vaAdId) return res.status(404).json({ error: 'No VA linked to this account.' });
                const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
                const data = await vaOverview(vaAdId, { vaName: req.portal.vaName || '', days });
                res.json(data);
            } catch (err) {
                console.error('[va-stats] portal read failed:', err.message);
                res.status(500).json({ error: 'Could not load your statistics.' });
            }
        });

        // Preview today's report exactly as tonight's webhook will render it.
        app.get('/api/va-portal/stats/preview', requirePortal, async (req, res) => {
            try {
                const vaAdId = req.portal.vaAdId;
                if (!vaAdId) return res.status(404).json({ error: 'No VA linked to this account.' });
                const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dayKey();
                const out = await runDailyReport({ day, dryRun: true, only: vaAdId });
                res.json({ day, report: (out.reports && out.reports[0]) || null });
            } catch (err) {
                console.error('[va-stats] portal preview failed:', err.message);
                res.status(500).json({ error: 'Could not build the report preview.' });
            }
        });
    }

    // ---- staff -----------------------------------------------------------
    if (requireAuth) {
        // Network overview + the per-VA leaderboard for a given day.
        app.get('/api/admin/va-stats', requireAuth, async (req, res) => {
            try {
                const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dayKey();
                const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
                const [network, series, board, legs] = await Promise.all([
                    getDaily({ day, scope: 'network' }),
                    getRange({ days, endDay: day, scope: 'network' }),
                    leaderboard({ day, sort: req.query.sort, limit: 100 }),
                    recentLegs({ day, limit: 40 }),
                ]);
                res.json({
                    ok: true,
                    day,
                    timezoneOffsetMinutes: TZ_OFFSET_MIN,
                    reportsEnabled: DAILY_REPORTS_ENABLED,
                    retentionDays: RETENTION_DAYS,
                    network,
                    last7: sumSeries(series.slice(-7), 'Last 7 days'),
                    last30: sumSeries(series, `Last ${series.length} days`),
                    series,
                    live: liveSnapshot({ limit: 200 }),
                    leaderboard: board,
                    legs,
                    pendingLegs: dbUp() ? await VaFlightLeg.countDocuments({ day }) : 0,
                });
            } catch (err) {
                console.error('[va-stats] staff read failed:', err.message);
                res.status(500).json({ error: 'Could not load VA statistics.' });
            }
        });

        // One VA's full history, from the staff side.
        app.get('/api/admin/va-stats/va/:vaId', requireAuth, async (req, res) => {
            try {
                const id = asId(req.params.vaId);
                if (!id) return res.status(404).json({ error: 'Unknown VA.' });
                const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
                res.json(await vaOverview(id, { days }));
            } catch (err) {
                console.error('[va-stats] staff VA read failed:', err.message);
                res.status(500).json({ error: 'Could not load that VA.' });
            }
        });

        // Preview (dry run) or actually run the end-of-day pipeline. The real run
        // posts every report AND erases that day's flight records, so it is a
        // POST, defaults to yesterday, and is admin-only — a dry run is not, so
        // any staff member can inspect what a day's report would say.
        app.post('/api/admin/va-stats/run-daily', requireAuth, async (req, res, next) => {
            const b = req.body || {};
            if (b.dryRun === true || b.dryRun === 'true') return next();
            return requireAdmin ? requireAdmin(req, res, next) : next();
        }, async (req, res) => {
            try {
                const b = req.body || {};
                const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day || '') ? b.day : shiftDay(dayKey(), -1);
                const out = await runDailyReport({
                    day,
                    dryRun: b.dryRun === true || b.dryRun === 'true',
                    force: b.force === true || b.force === 'true',
                });
                res.json(out);
            } catch (err) {
                console.error('[va-stats] manual run failed:', err.message);
                res.status(500).json({ error: err.message });
            }
        });
    }
}

module.exports = {
    // models
    VaFlightLeg,
    VaStatDaily,
    // writing
    recordFlightEvent,
    recordEngagement,
    ENGAGEMENT_TYPES,
    // reading
    dayKey,
    shiftDay,
    getDaily,
    getRange,
    sumSeries,
    vaOverview,
    leaderboard,
    liveSnapshot,
    recentLegs,
    // lifecycle
    runDailyReport,
    registerVaStatsRoutes,
    start,
};

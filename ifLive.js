'use strict';

/*
 * ifLive.js
 * The Infinite Flight PublicApi v3 data model, as decisions rather than I/O.
 *
 * WHAT LIVES HERE
 * ---------------
 * Everything about a Live organization, its aircraft and their schedules that
 * is a judgement rather than a network call: what the numeric enums mean
 * (ENUMS), what one of these objects looks like once it has crossed into our
 * API (publicOrganization / publicAircraft / publicPosition / publicSchedule),
 * whether a schedule a staff member has typed is one Infinite Flight will
 * accept (scheduleRequest), and how one of the VA's own scheduled departures
 * becomes an Infinite Flight schedule and back (fromCrewSchedule /
 * toCrewSchedule).
 *
 * Pure. No fetch, no mongoose, no express. ifOAuth.js does the talking; the
 * routes in server.js hold the I/O and nothing else. Same division as
 * crewSchedules.js, and for the same reason: the interesting parts of this
 * integration are decisions, and decisions are worth being able to read in one
 * file without a network in the way.
 *
 * THE API THIS DESCRIBES IS EXPLICITLY UNSTABLE
 * ---------------------------------------------
 * Infinite Flight ships PublicApi v3 as a preview: "endpoint paths, scopes,
 * response fields, enum values, validation rules, rate limits, access rules and
 * app review behaviour may change before general availability." That sentence
 * is the design constraint for this whole file, and it produces two rules that
 * are worth stating before anybody edits it.
 *
 *   1. AN UNKNOWN ENUM VALUE IS NOT AN ERROR. Every enum below is a lookup that
 *      may miss. A status of 5 — which is absent from today's published
 *      ScheduledFlightStatus table, sitting in the gap between TaxiingToRunway
 *      and InFlight — must not throw, must not be coerced to Unknown, and must
 *      not stop a fleet board painting. It comes out as { value: 5, name: '',
 *      label: 'Status 5' } and the page shows the number. A client that refuses
 *      values it has not been told about breaks on the morning Infinite Flight
 *      fills that gap in, and it breaks for every VA at once.
 *
 *   2. AN UNKNOWN FIELD IS KEPT. publicSchedule and friends name the fields the
 *      preview documents, and then carry anything else through untouched under
 *      `extra`. A renamed field therefore degrades to "the panel does not draw
 *      it yet" rather than "the data is gone".
 *
 * WHY WE VALIDATE AT ALL, WHEN THE API VALIDATES
 * ----------------------------------------------
 * Infinite Flight will refuse a bad schedule with a 400 and an errorCode. That
 * is the authority and this file does not try to outrank it. What it does is
 * catch the refusable cases BEFORE the round trip, because "arrival has to be
 * after departure" said next to the field is a correction and `{"errorCode":
 * 3}` two seconds later is a puzzle. Where the two disagree, Infinite Flight
 * wins: scheduleRequest is deliberately no stricter than the documented rules,
 * so it can never refuse something the API would have taken.
 */

// ---------------------------------------------------------------------------
// Enums
//
// Numeric on the wire, and the preview says so explicitly ("Enums are currently
// represented as numeric values in JSON"). They are written here as
// value → { name, label }: the NAME is Infinite Flight's own identifier, kept
// so a caller can branch on something stable-ish; the LABEL is what a person
// reads, because "FlightSchool" and "VIPExecutive" are identifiers, not words.
// ---------------------------------------------------------------------------

const table = (rows) => {
    const byValue = new Map();
    const byName = new Map();
    for (const [value, name, label] of rows) {
        const entry = { value, name, label: label || name };
        byValue.set(value, entry);
        byName.set(name.toLowerCase(), entry);
    }
    return { byValue, byName, list: [...byValue.values()] };
};

const ORGANIZATION_TYPE = table([
    [0, 'AutoJoin', 'Anyone can join'],
    [1, 'ManualJoin', 'Join with approval'],
    [2, 'ApplyToJoin', 'Apply to join'],
    [3, 'InviteOnly', 'Invite only'],
    [4, 'SingleMember', 'Single member'],
]);

const OPERATION_TYPE = table([
    [0, 'Undefined', 'Unspecified'],
    [1, 'Airline', 'Airline'],
    [2, 'Charter', 'Charter'],
    [3, 'Freight', 'Freight'],
    [4, 'Military', 'Military'],
    [5, 'FlightSchool', 'Flight school'],
    [6, 'Private', 'Private'],
]);

const WORLD_TYPE = table([
    [0, 'Solo', 'Solo'],
    [1, 'Casual', 'Casual'],
    [2, 'Training', 'Training'],
    [3, 'Expert', 'Expert'],
    [4, 'Private', 'Private'],
]);

const ORGANIZATION_STATUS = table([
    [0, 'Active', 'Active'],
    [1, 'Suspended', 'Suspended'],
    [2, 'Deleted', 'Deleted'],
]);

const AIRCRAFT_STATUS = table([
    [0, 'Active', 'Active'],
    [1, 'Deleted', 'Deleted'],
]);

const AIRCRAFT_VISIBILITY = table([
    [0, 'Unknown', 'Unknown'],
    [1, 'Visible', 'Visible'],
    [2, 'Hangared', 'Hangared'],
]);

const PERSISTENCE_STATE = table([
    [0, 'Unknown', 'Unknown'],
    [1, 'OnGround', 'On the ground'],
    [2, 'InFlight', 'In flight'],
    [3, 'Cancelled', 'Cancelled'],
    [4, 'Stopped', 'Stopped'],
    [5, 'Maintenance', 'Maintenance'],
]);

// Note the hole at 5 — it is absent from the published table, not omitted here.
// See rule 1 at the top of this file for what happens when Infinite Flight
// fills it in.
const SCHEDULE_STATUS = table([
    [0, 'Unknown', 'Unknown'],
    [1, 'Scheduled', 'Scheduled'],
    [2, 'Boarding', 'Boarding'],
    [3, 'Boarded', 'Boarded'],
    [4, 'TaxiingToRunway', 'Taxiing out'],
    [6, 'InFlight', 'In flight'],
    [7, 'Diverted', 'Diverted'],
    [8, 'Delayed', 'Delayed'],
    [9, 'Cancelled', 'Cancelled'],
    [10, 'TaxiingToParking', 'Taxiing in'],
    [11, 'Arrived', 'Arrived'],
]);

const FLIGHT_TYPE = table([
    [0, 'None', 'Unspecified'],
    [1, 'Commercial', 'Commercial'],
    [2, 'Charter', 'Charter'],
    [3, 'Cargo', 'Cargo'],
    [4, 'Training', 'Training'],
    [5, 'TestFlight', 'Test flight'],
    [6, 'MedicalEmergency', 'Medical emergency'],
    [7, 'Military', 'Military'],
    [8, 'VIPExecutive', 'VIP / executive'],
    [9, 'HumanitarianRelief', 'Humanitarian relief'],
    [10, 'GeneralAviation', 'General aviation'],
    [11, 'Airshow', 'Airshow'],
    [12, 'Other', 'Other'],
]);

/**
 * One enum value, described.
 *
 * Never throws and never returns null: an unrecognised number comes back
 * labelled with itself, which is the honest answer ("Infinite Flight says 5 and
 * we have not been told what 5 is") and keeps every caller free of a null check
 * that would otherwise be copied into three front-ends.
 */
function describeEnum(t, value) {
    if (value === null || value === undefined || value === '') {
        return { value: null, name: '', label: '' };
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return { value: null, name: '', label: String(value).slice(0, 40) };
    const hit = t.byValue.get(n);
    return hit ? { ...hit } : { value: n, name: '', label: `Status ${n}` };
}

/** The value for a name, for a caller that would rather write 'Cargo' than 3. */
function enumValue(t, name, fallback = null) {
    if (typeof name === 'number' && t.byValue.has(name)) return name;
    const hit = t.byName.get(String(name || '').toLowerCase());
    return hit ? hit.value : fallback;
}

/**
 * Every enum, as the front-end wants them: a flat list per enum, ready to fill
 * a <select>. Sent to the browser rather than duplicated there, so the day
 * Infinite Flight adds a flight type it appears in the picker after a backend
 * deploy and not after three.
 */
const ENUMS = {
    organizationType: ORGANIZATION_TYPE.list,
    operationType: OPERATION_TYPE.list,
    worldType: WORLD_TYPE.list,
    organizationStatus: ORGANIZATION_STATUS.list,
    aircraftStatus: AIRCRAFT_STATUS.list,
    aircraftVisibility: AIRCRAFT_VISIBILITY.list,
    persistenceState: PERSISTENCE_STATE.list,
    scheduleStatus: SCHEDULE_STATUS.list,
    flightType: FLIGHT_TYPE.list,
};

// ---------------------------------------------------------------------------
// Scopes
//
// "Apps should request only the scopes they need." What the crew center needs
// depends on what the VA is turning on, so the scope list is assembled from the
// features asked for rather than being one constant — a VA that only wants to
// see its fleet never gets asked to grant schedule writes.
// ---------------------------------------------------------------------------

const SCOPES = {
    openid: 'Sign you in',
    profile: 'Read your Infinite Flight profile',
    offline_access: 'Stay connected without signing in again',
    'live:organizations.read': 'Read the Live organizations you belong to',
    'live:aircraft.read': 'Read the aircraft in those organizations',
    'live:schedules.read': 'Read those aircraft’s schedules',
    'live:schedules.write': 'Create and change those schedules',
};

// What a crew center asks for by default: everything read, schedule writes, and
// a refresh token. offline_access is not optional in practice — an access token
// lasts half an hour (`expires_in: 1800`) and a crew center that could only act
// while somebody was watching would be useless for the automatic sync.
const DEFAULT_SCOPES = [
    'openid', 'profile', 'offline_access',
    'live:organizations.read', 'live:aircraft.read',
    'live:schedules.read', 'live:schedules.write',
];

// The minimum that gets a useful screen: the fleet, read-only.
const READ_SCOPES = [
    'openid', 'profile', 'offline_access',
    'live:organizations.read', 'live:aircraft.read', 'live:schedules.read',
];

/**
 * Normalise a requested scope set.
 *
 * Unknown scopes are dropped rather than passed through: an authorization
 * request carrying a scope the server does not issue is refused outright by
 * most OAuth servers, so forwarding a typo would turn "we asked for something
 * odd" into "sign-in is broken". openid is forced on because every other scope
 * here is meaningless without a signed-in user.
 */
function normalizeScopes(input) {
    const raw = Array.isArray(input)
        ? input
        : String(input || '').split(/[\s,]+/);
    const seen = new Set(['openid']);
    for (const s of raw) {
        const key = String(s || '').trim();
        if (key && Object.prototype.hasOwnProperty.call(SCOPES, key)) seen.add(key);
    }
    return [...seen];
}

const scopeString = (scopes) => normalizeScopes(scopes).join(' ');

/** Does this grant let us write schedules? Decides whether the panel offers to. */
const canWriteSchedules = (scopes) => normalizeScopes(scopes).includes('live:schedules.write');

// ---------------------------------------------------------------------------
// Public shapes
//
// What our API hands a browser. Three jobs each: rename nothing (the field
// names are Infinite Flight's, so a reader with the preview docs open
// recognises them), attach the decoded enum next to the raw number, and keep
// whatever we were not expecting.
// ---------------------------------------------------------------------------

const KNOWN = {
    organization: ['id', 'name', 'type', 'operationType', 'worldType', 'status', 'description'],
    aircraft: ['id', 'aircraftId', 'organizationId', 'registration', 'status', 'visibility',
        'fleetPriority', 'fleetRank', 'isFleetActiveSlot', 'createdAt'],
    position: ['id', 'state', 'isOnGround', 'latitude', 'longitude', 'altitude', 'heading',
        'speed', 'verticalSpeed', 'lastPilotId', 'lastPilotUsername', 'updatedAt'],
    schedule: ['id', 'status', 'callsign', 'organizationId', 'aircraftId', 'flightType',
        'originIcao', 'destinationIcao', 'scheduledDepartureUtc', 'scheduledArrivalUtc',
        'actualDepartureUtc', 'actualArrivalUtc', 'briefing', 'debriefing', 'flightPlan',
        'sequence', 'createdAt', 'updatedAt'],
};

/**
 * Everything on the object we were not expecting.
 *
 * This is the whole of our defence against rule 2 at the top of the file. A
 * preview API that renames `briefing` to `notes` would otherwise silently drop
 * a VA's briefings on the floor; instead they arrive under extra.notes, the
 * panel does not draw them yet, and the data is still there when it learns to.
 */
function extraOf(obj, known) {
    const out = {};
    for (const key of Object.keys(obj || {})) {
        if (!known.includes(key)) out[key] = obj[key];
    }
    return Object.keys(out).length ? out : undefined;
}

const text = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

function publicOrganization(o) {
    if (!o || typeof o !== 'object') return null;
    return {
        id: text(o.id, 64),
        name: text(o.name, 200) || '',
        description: text(o.description, 4000),
        type: describeEnum(ORGANIZATION_TYPE, o.type),
        operationType: describeEnum(OPERATION_TYPE, o.operationType),
        worldType: describeEnum(WORLD_TYPE, o.worldType),
        status: describeEnum(ORGANIZATION_STATUS, o.status),
        extra: extraOf(o, KNOWN.organization),
    };
}

/**
 * One organization aircraft.
 *
 * The two id fields are the thing to be careful about, and the preview is blunt
 * about it: `id` is the PERSISTENT organization aircraft id and the one every
 * other endpoint means by {aircraftId}, while `aircraftId` is Infinite Flight's
 * aircraft/livery content identifier and is a different thing entirely. Getting
 * them the wrong way round produces a 404 on a fleet you are looking at. They
 * keep their upstream names here so the confusion is at least the documented
 * confusion, and `id` is additionally surfaced as `fleetId` for callers that
 * would rather not think about it.
 *
 * `storage` is the one derived field: visibility and fleet slot are separate
 * facts ("Aircraft outside the organization's active fleet slots return
 * isFleetActiveSlot: false and may appear as storage in the Live portal even
 * when visibility is Visible"), and a fleet board wants the one answer the Live
 * portal would give.
 */
function publicAircraft(a) {
    if (!a || typeof a !== 'object') return null;
    const visibility = describeEnum(AIRCRAFT_VISIBILITY, a.visibility);
    const activeSlot = a.isFleetActiveSlot !== false;
    return {
        id: text(a.id, 64),
        fleetId: text(a.id, 64),
        aircraftId: text(a.aircraftId, 64),
        organizationId: text(a.organizationId, 64),
        registration: text(a.registration, 40) || '',
        status: describeEnum(AIRCRAFT_STATUS, a.status),
        visibility,
        fleetPriority: num(a.fleetPriority),
        fleetRank: num(a.fleetRank),
        isFleetActiveSlot: activeSlot,
        // Hangared beats out-of-slot: an aircraft that is both is put away, and
        // saying "storage" about it would suggest the fleet order is why.
        storage: visibility.name === 'Hangared' ? 'hangared' : (activeSlot ? 'active' : 'storage'),
        createdAt: text(a.createdAt, 40),
        extra: extraOf(a, KNOWN.aircraft),
    };
}

/**
 * The last persisted position, and how much to believe it.
 *
 * "This position is the stored Live aircraft state and can be stale when the
 * aircraft is not actively reporting" — so the age is computed here and sent
 * alongside, because every consumer of this needs it and none of them should be
 * doing date arithmetic on a string. `stale` is advisory: it says the reading is
 * old enough that a map pin drawn from it would be a claim rather than a fact.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

function publicPosition(p, now = Date.now()) {
    if (!p || typeof p !== 'object') return null;
    const updatedAt = text(p.updatedAt, 40);
    const at = updatedAt ? Date.parse(updatedAt) : NaN;
    const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : null;
    const lat = num(p.latitude);
    const lon = num(p.longitude);
    return {
        id: text(p.id, 64),
        state: describeEnum(PERSISTENCE_STATE, p.state),
        isOnGround: !!p.isOnGround,
        latitude: lat,
        longitude: lon,
        // A position of exactly 0,0 is very nearly always "we have never had
        // one" rather than a spot in the Gulf of Guinea, and a fleet board that
        // drops a pin there looks broken in a way that is hard to explain.
        hasFix: lat !== null && lon !== null && !(lat === 0 && lon === 0),
        altitude: num(p.altitude),
        heading: num(p.heading),
        speed: num(p.speed),
        verticalSpeed: num(p.verticalSpeed),
        lastPilotId: text(p.lastPilotId, 64),
        lastPilotUsername: text(p.lastPilotUsername, 60),
        updatedAt,
        ageMs,
        stale: ageMs === null ? true : ageMs > STALE_AFTER_MS,
        extra: extraOf(p, KNOWN.position),
    };
}

function publicSchedule(s) {
    if (!s || typeof s !== 'object') return null;
    const dep = text(s.scheduledDepartureUtc, 40);
    const arr = text(s.scheduledArrivalUtc, 40);
    return {
        id: text(s.id, 64),
        status: describeEnum(SCHEDULE_STATUS, s.status),
        callsign: text(s.callsign, 32) || '',
        organizationId: text(s.organizationId, 64),
        aircraftId: text(s.aircraftId, 64),
        flightType: describeEnum(FLIGHT_TYPE, s.flightType),
        originIcao: (text(s.originIcao, 8) || '').toUpperCase(),
        destinationIcao: (text(s.destinationIcao, 8) || '').toUpperCase(),
        scheduledDepartureUtc: dep,
        scheduledArrivalUtc: arr,
        actualDepartureUtc: text(s.actualDepartureUtc, 40),
        actualArrivalUtc: text(s.actualArrivalUtc, 40),
        briefing: text(s.briefing, 4000),
        debriefing: text(s.debriefing, 4000),
        flightPlan: text(s.flightPlan, 16000),
        sequence: num(s.sequence),
        blockMinutes: blockMinutes(dep, arr),
        createdAt: text(s.createdAt, 40),
        updatedAt: text(s.updatedAt, 40),
        extra: extraOf(s, KNOWN.schedule),
    };
}

/** Planned block time in minutes, or null when either end is missing/unparseable. */
function blockMinutes(departure, arrival) {
    const a = Date.parse(departure || '');
    const b = Date.parse(arrival || '');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return Math.round((b - a) / 60000);
}

/**
 * The leg in words — for a Discord notice, an activity row, or a confirmation.
 * Same shape and same fallbacks as crewSchedules.describeLeg, so the two kinds
 * of schedule read alike wherever they end up side by side.
 */
function describeSchedule(s) {
    if (!s) return '';
    const origin = s.originIcao || '';
    const destination = s.destinationIcao || '';
    const leg = [origin, destination].filter(Boolean).join(' → ');
    return [s.callsign, leg].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// ScheduleRequest
//
// The validation table from the preview docs, in code. Deliberately no
// stricter — see the note at the top about who the authority is.
// ---------------------------------------------------------------------------

const CALLSIGN_MAX = 32;
const ICAO_MAX = 8;
const BRIEFING_MAX = 4000;
const FLIGHT_PLAN_MAX = 16000;

// "Control characters are not allowed." Stripped rather than refused: a
// callsign pasted out of a spreadsheet routinely arrives with a stray tab or a
// non-breaking space in it, and refusing that is a puzzle where removing it is
// obviously right. What survives is what Infinite Flight would have accepted.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;
const stripControl = (v) => String(v == null ? '' : v)
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const fail = (reason, field) => ({ ok: false, reason, field: field || '' });

/**
 * An ISO 8601 instant, in the form the API asks for.
 *
 * Anything Date can parse is accepted and re-emitted as a UTC instant, because
 * the field is named `...Utc` and a browser that sends a local-time string with
 * no offset would otherwise schedule a departure some hours from where the
 * person meant it. Emitting `.000Z` every time also makes two schedules
 * comparable as strings, which the sync below relies on.
 */
function utc(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
}

/**
 * Validate and normalise a create/update body.
 *
 * Returns { ok: true, value } — the exact JSON to send — or { ok: false,
 * reason, field }, where `reason` is a sentence for the person typing and
 * `field` is what to put the ring around.
 */
function scheduleRequest(body) {
    const b = body && typeof body === 'object' ? body : {};

    const callsign = stripControl(b.callsign).slice(0, CALLSIGN_MAX);
    if (!callsign) return fail('Give the flight a callsign.', 'callsign');

    // The enum accepts either the number or the name, because a hand-written
    // request saying "Cargo" is clearer than one saying 3 and both are easy to
    // support. An absent flightType becomes Commercial rather than None: a VA
    // scheduling a line flight means a line flight, and None is the value you
    // pick on purpose.
    const flightType = enumValue(FLIGHT_TYPE, b.flightType, b.flightType === undefined ? 1 : null);
    if (flightType === null) return fail('Pick a flight type.', 'flightType');

    const origin = String(b.originIcao || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ICAO_MAX);
    if (!origin) return fail('Where does it depart from?', 'originIcao');
    const destination = String(b.destinationIcao || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ICAO_MAX);
    if (!destination) return fail('Where does it arrive?', 'destinationIcao');

    const departure = utc(b.scheduledDepartureUtc);
    if (!departure) return fail('Set a departure time.', 'scheduledDepartureUtc');
    const arrival = utc(b.scheduledArrivalUtc);
    if (!arrival) return fail('Set an arrival time.', 'scheduledArrivalUtc');
    if (Date.parse(arrival) <= Date.parse(departure)) {
        return fail('Arrival has to be after departure.', 'scheduledArrivalUtc');
    }

    // Optional, and length-checked rather than truncated. A briefing cut off at
    // 4,000 characters is a briefing that has lost its diversion plan without
    // saying so; the person who wrote it should be told and given the chance to
    // cut it themselves.
    const briefing = b.briefing == null || b.briefing === '' ? null : String(b.briefing);
    if (briefing !== null && briefing.length > BRIEFING_MAX) {
        return fail(`The briefing is ${briefing.length.toLocaleString()} characters — the limit is ${BRIEFING_MAX.toLocaleString()}.`, 'briefing');
    }
    const flightPlan = b.flightPlan == null || b.flightPlan === '' ? null : String(b.flightPlan);
    if (flightPlan !== null && flightPlan.length > FLIGHT_PLAN_MAX) {
        return fail(`The flight plan is ${flightPlan.length.toLocaleString()} characters — the limit is ${FLIGHT_PLAN_MAX.toLocaleString()}.`, 'flightPlan');
    }

    return {
        ok: true,
        value: {
            callsign,
            flightType,
            originIcao: origin,
            destinationIcao: destination,
            scheduledDepartureUtc: departure,
            scheduledArrivalUtc: arrival,
            briefing,
            flightPlan,
        },
    };
}

/** ScheduleFlightPlanRequest. Null or empty clears the stored plan, and says so. */
function flightPlanRequest(body) {
    const b = body && typeof body === 'object' ? body : {};
    const raw = b.flightPlan;
    if (raw == null || String(raw).trim() === '') return { ok: true, value: { flightPlan: null }, cleared: true };
    const flightPlan = String(raw);
    if (flightPlan.length > FLIGHT_PLAN_MAX) {
        return fail(`The flight plan is ${flightPlan.length.toLocaleString()} characters — the limit is ${FLIGHT_PLAN_MAX.toLocaleString()}.`, 'flightPlan');
    }
    return { ok: true, value: { flightPlan }, cleared: false };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ScheduleReorderRequest.
 *
 * `afterId: null` means "put it at the top", and that is a meaningfully
 * different request from omitting the field — so an absent afterId is treated
 * as null and sent explicitly, rather than left out of the body where the API
 * would have to guess.
 */
function reorderRequest(body) {
    const b = body && typeof body === 'object' ? body : {};
    const scheduleId = String(b.scheduleId || '').trim();
    if (!UUID.test(scheduleId)) return fail('Which schedule should move?', 'scheduleId');
    const afterRaw = b.afterId;
    if (afterRaw == null || afterRaw === '') return { ok: true, value: { scheduleId, afterId: null } };
    const afterId = String(afterRaw).trim();
    if (!UUID.test(afterId)) return fail('That is not a schedule id.', 'afterId');
    if (afterId === scheduleId) return fail('A schedule cannot be moved after itself.', 'afterId');
    return { ok: true, value: { scheduleId, afterId } };
}

/**
 * The order a list of ids implies, as a sequence of reorder calls.
 *
 * The API moves ONE schedule at a time relative to another, and a drag-and-drop
 * list hands back a whole new arrangement. Rather than making every front-end
 * work out the moves, this turns the arrangement into the calls: place the
 * first at the top (afterId null), then each subsequent one after its
 * predecessor. That is n calls for a list of n, which is more than the minimum —
 * but the minimum requires knowing the current order at the moment each call
 * lands, and it does not, because somebody else may be reordering the same
 * aircraft. Every call here is idempotent and states an absolute intention, so a
 * lost one leaves the list closer to right rather than shuffled.
 *
 * Only ids the caller has any business moving are emitted: "Only schedules with
 * status Scheduled or InFlight are reordered", so anything else in the list is
 * dropped here rather than spent as a call the API will decline.
 */
function reorderPlan(ids, schedules) {
    // "Was a list supplied?" and "did anything in it survive the filter?" are
    // different questions, and conflating them is a real bug: a caller who
    // passes no list at all means "you have not been told the statuses, move
    // what I asked for", while a list in which everything is cancelled means
    // "there is nothing here to move". A single `movable.size` check answers
    // both with the first, and would reorder an aircraft whose whole rota has
    // been cancelled.
    const known = Array.isArray(schedules) && schedules.length > 0;
    const movable = new Set(
        (known ? schedules : [])
            .filter((s) => {
                const name = describeEnum(SCHEDULE_STATUS, s && s.status).name;
                // Unknown-to-us statuses are allowed through: refusing to move
                // one because we have not heard of it is exactly the failure
                // mode rule 1 exists to prevent. The API is free to decline.
                return name !== 'Cancelled' && name !== 'Arrived' && name !== 'Diverted';
            })
            .map((s) => String(s.id))
    );
    const wanted = (Array.isArray(ids) ? ids : [])
        .map((i) => String(i || '').trim())
        .filter((i) => UUID.test(i) && (!known || movable.has(i)));

    const seen = new Set();
    const plan = [];
    let previous = null;
    for (const id of wanted) {
        if (seen.has(id)) continue;
        seen.add(id);
        plan.push({ scheduleId: id, afterId: previous });
        previous = id;
    }
    return plan;
}

// ---------------------------------------------------------------------------
// The bridge to the VA's own schedule
//
// A crew center already has schedules: crew_schedules in the VA's own Postgres,
// built off their route network, with seats pilots book (crewSchedules.js).
// Infinite Flight now has schedules too, attached to an aircraft in a Live
// organization. These are not the same object and must not be conflated — one
// has bookings and a rank gate, the other has a sequence and a real aeroplane —
// but a VA that keeps both by hand is doing the same typing twice.
//
// So: a link, not a merge. A crew schedule may carry the id of the Infinite
// Flight schedule it was pushed to, and these two functions are the whole of the
// translation between them.
// ---------------------------------------------------------------------------

/**
 * A crew center departure, as an Infinite Flight ScheduleRequest.
 *
 * The crew row's own field names (flightNumber, origin, destination, departsAt)
 * are this project's; the mapping is spelled out here rather than left to a
 * caller building an object literal, so there is one place to fix when either
 * side renames something.
 *
 * Arrival is the one piece of arithmetic: a crew schedule stores a departure and
 * a block time, Infinite Flight wants two instants. A row with neither gets a
 * refusal from scheduleRequest rather than an invented arrival.
 */
function fromCrewSchedule(row, { flightType } = {}) {
    const r = row || {};
    const departure = utc(r.departsAt || r.departureUtc || r.departure);
    let arrival = utc(r.arrivesAt || r.arrivalUtc || r.arrival);
    if (!arrival && departure) {
        const minutes = Number(r.blockMinutes || r.durationMinutes || 0);
        if (minutes > 0) arrival = new Date(Date.parse(departure) + minutes * 60000).toISOString();
    }
    return scheduleRequest({
        callsign: r.flightNumber || r.callsign || '',
        flightType: flightType === undefined ? r.ifFlightType : flightType,
        originIcao: r.origin || r.originIcao || '',
        destinationIcao: r.destination || r.destinationIcao || '',
        scheduledDepartureUtc: departure,
        scheduledArrivalUtc: arrival,
        briefing: r.notes || r.briefing || null,
        flightPlan: r.flightPlan || r.route || null,
    });
}

/**
 * An Infinite Flight schedule, as the fields of a crew center departure.
 *
 * Only the fields that mean the same thing on both sides. Seats, booking mode,
 * rank gates and status are the crew center's own business and are deliberately
 * absent: pulling a schedule in from Infinite Flight must never quietly reset a
 * departure's seat count or unpublish it.
 */
function toCrewSchedule(s) {
    const sc = publicSchedule(s) || {};
    return {
        flightNumber: sc.callsign || '',
        origin: sc.originIcao || '',
        destination: sc.destinationIcao || '',
        departsAt: sc.scheduledDepartureUtc || null,
        blockMinutes: sc.blockMinutes || 0,
        notes: sc.briefing || '',
        flightPlan: sc.flightPlan || '',
        ifScheduleId: sc.id || '',
        ifAircraftId: sc.aircraftId || '',
    };
}

/**
 * Has the Infinite Flight copy drifted from what we pushed?
 *
 * Compared field by field on the values that actually crossed, so "somebody
 * edited this in the Infinite Flight app" is answerable without keeping a
 * shadow copy. Times are compared as instants rather than strings — the API is
 * free to hand back `+00:00` where we sent `Z`, and that is not a change.
 */
function scheduleDiff(request, remote) {
    const a = request || {};
    const b = publicSchedule(remote) || {};
    const changed = [];
    const sameTime = (x, y) => {
        const p = Date.parse(x || ''); const q = Date.parse(y || '');
        if (!Number.isFinite(p) && !Number.isFinite(q)) return true;
        return p === q;
    };
    if ((a.callsign || '') !== (b.callsign || '')) changed.push('callsign');
    if (Number(a.flightType) !== Number(b.flightType && b.flightType.value)) changed.push('flightType');
    if ((a.originIcao || '') !== (b.originIcao || '')) changed.push('originIcao');
    if ((a.destinationIcao || '') !== (b.destinationIcao || '')) changed.push('destinationIcao');
    if (!sameTime(a.scheduledDepartureUtc, b.scheduledDepartureUtc)) changed.push('scheduledDepartureUtc');
    if (!sameTime(a.scheduledArrivalUtc, b.scheduledArrivalUtc)) changed.push('scheduledArrivalUtc');
    if ((a.briefing || '') !== (b.briefing || '')) changed.push('briefing');
    if ((a.flightPlan || '') !== (b.flightPlan || '')) changed.push('flightPlan');
    return changed;
}

// ---------------------------------------------------------------------------
// What the fleet is actually doing
//
// A VA's most expensive mistake is not a badly-built schedule — it is an
// aeroplane nobody has flown for three weeks that everybody assumes somebody
// else is using. That question was previously unanswerable from the crew
// center, and it is answerable now, because the rota and the actual times are
// both on the schedules we can read.
//
// Everything here is derived from data Infinite Flight has already given us. It
// invents nothing and, where a figure is genuinely unknown, it says null rather
// than 0 — the same rule the rest of this codebase holds. An aircraft with no
// schedules at all has flown `null` legs, not zero, unless the API actually
// told us its rota is empty.
// ---------------------------------------------------------------------------

// A departure that pushed back an hour ago is still today's flying. Same grace
// the crew center's own schedule list uses, so the two agree about what
// "upcoming" means.
const UPCOMING_GRACE_MS = 12 * 3600 * 1000;

/**
 * One aircraft's workload, from its rota.
 *
 * `schedules` is what listSchedules returned for this aircraft — already
 * shaped. Pass null for "we did not manage to read it", which is different from
 * an empty array meaning "it has nothing scheduled", and is reported as such.
 */
function aircraftUtilisation(aircraft, schedules, now = Date.now()) {
    const a = aircraft || {};
    const known = Array.isArray(schedules);
    const list = known ? schedules : [];

    let upcoming = 0;
    let scheduledMinutes = 0;
    let nextDepartureUtc = null;
    let lastArrivalUtc = null;
    let flown = 0;
    let cancelled = 0;

    for (const s of list) {
        const status = s.status && s.status.name;
        if (status === 'Cancelled') { cancelled += 1; continue; }

        const dep = Date.parse(s.scheduledDepartureUtc || '');
        if (Number.isFinite(dep) && dep > now - UPCOMING_GRACE_MS) {
            upcoming += 1;
            if (s.blockMinutes) scheduledMinutes += s.blockMinutes;
            if (nextDepartureUtc === null || dep < Date.parse(nextDepartureUtc)) {
                nextDepartureUtc = s.scheduledDepartureUtc;
            }
        }

        // An ACTUAL arrival is the only evidence this aeroplane really flew.
        // A scheduled arrival in the past is a plan that may or may not have
        // happened, and counting it would report a fleet as busy on the
        // strength of a rota nobody flew.
        const arrived = Date.parse(s.actualArrivalUtc || '');
        if (Number.isFinite(arrived)) {
            flown += 1;
            if (lastArrivalUtc === null || arrived > Date.parse(lastArrivalUtc)) {
                lastArrivalUtc = s.actualArrivalUtc;
            }
        }
    }

    const lastFlownMs = lastArrivalUtc ? Date.parse(lastArrivalUtc) : null;
    return {
        id: a.id || null,
        registration: a.registration || '',
        storage: a.storage || '',
        fleetRank: a.fleetRank ?? null,
        // Carried through so this list can show the same aircraft picture the
        // fleet board does. Null when the type could not be resolved, which the
        // image chain treats as "draw a generic silhouette" rather than as an
        // absence of picture.
        type: a.type || null,
        // null, not 0, when the rota could not be read — see the header.
        upcoming: known ? upcoming : null,
        scheduledMinutes: known ? scheduledMinutes : null,
        flownLegs: known ? flown : null,
        cancelledLegs: known ? cancelled : null,
        nextDepartureUtc,
        lastArrivalUtc,
        daysSinceFlown: lastFlownMs === null ? null : Math.floor((now - lastFlownMs) / 86400000),
        // IDLE is a judgement and is stated as one: in the active fleet, and
        // nothing coming up. An aeroplane in storage is not idle — it is put
        // away, which is a decision somebody made — and one we could not read
        // is not idle either, it is unknown.
        idle: known && upcoming === 0 && (a.storage === 'active'),
        rotaUnknown: !known,
    };
}

/**
 * The fleet's workload, and the aircraft worth looking at.
 *
 * `rotas` maps aircraft id → the schedules for it (or null/absent where the
 * read failed). Sorted so the answer to "what should I do about my fleet?" is
 * at the top: the idle aeroplanes first, longest-unflown first within that.
 */
function fleetUtilisation(aircraft, rotas, now = Date.now()) {
    const list = (Array.isArray(aircraft) ? aircraft : [])
        .map((a) => aircraftUtilisation(a, (rotas || {})[a.id] || null, now));

    const known = list.filter((r) => !r.rotaUnknown);
    const idle = list.filter((r) => r.idle);

    // Sorted for the reader, not for the machine: idle first, and among the
    // idle, the one that has sat longest. An aircraft never flown at all sorts
    // above one flown last week, because "we have never used this" is the more
    // interesting fact.
    const rank = (r) => (r.idle ? 0 : 1);
    const idleAge = (r) => (r.daysSinceFlown === null ? Infinity : r.daysSinceFlown);
    list.sort((x, y) => rank(x) - rank(y)
        || (rank(x) === 0 ? idleAge(y) - idleAge(x) : 0)
        || (x.fleetRank ?? 1e9) - (y.fleetRank ?? 1e9)
        || String(x.registration).localeCompare(String(y.registration)));

    return {
        aircraft: list,
        summary: {
            total: list.length,
            // Every count below is over the aircraft we could actually read, and
            // `unknown` says how many that leaves out — so a fleet whose rotas
            // half failed to load reports "3 idle of 8 read" rather than
            // quietly implying it read all twelve.
            read: known.length,
            unknown: list.length - known.length,
            idle: idle.length,
            upcomingLegs: known.reduce((n, r) => n + (r.upcoming || 0), 0),
            scheduledMinutes: known.reduce((n, r) => n + (r.scheduledMinutes || 0), 0),
            // The longest any active aeroplane has gone unflown. The single
            // number a VA actually reacts to.
            longestIdleDays: idle.reduce((n, r) => Math.max(n, r.daysSinceFlown === null ? 0 : r.daysSinceFlown), 0),
            neverFlown: idle.filter((r) => r.lastArrivalUtc === null).length,
        },
    };
}

// ---------------------------------------------------------------------------
// What went wrong, in words
// ---------------------------------------------------------------------------

/**
 * An HTTP status from PublicApi v3, said to a person.
 *
 * The preview publishes exactly five, and each of them has a different action
 * attached — which is the point of not letting them all surface as "the
 * Infinite Flight API returned an error". 403 in particular is four different
 * situations, and the one a VA hits first ("your app is still in testing") is
 * invisible unless somebody says it out loud.
 */
function statusMessage(status, { write = false } = {}) {
    switch (Number(status)) {
        case 400: return 'Infinite Flight refused that as invalid.';
        case 401: return 'Your Infinite Flight connection has expired. Reconnect it.';
        case 403: return write
            ? 'Infinite Flight says this account cannot change that organization’s schedules — only an owner or admin of the organization can, and the connected app has to be approved for anyone but its own testers.'
            : 'Infinite Flight says this account cannot see that. Check you are a member of the organization, and that the connected app is out of testing.';
        case 404: return 'Infinite Flight has no such organization, aircraft or schedule for this account.';
        case 429: return 'Infinite Flight is rate-limiting us. Try again shortly.';
        case 503:
        case 502:
        case 504: return 'Infinite Flight’s API is unavailable at the moment.';
        default: break;
    }
    if (Number(status) >= 500) return 'Infinite Flight’s API failed on that request.';
    return 'Infinite Flight could not answer that request.';
}

/**
 * Is this worth retrying, or is retrying just noise?
 *
 * Used by the sync so that a 429 backs off and a 403 does not — one is a queue,
 * the other is an answer, and treating them alike is how an integration ends up
 * hammering an endpoint that will never say yes.
 */
const isRetryable = (status) => Number(status) === 429 || Number(status) >= 500;

module.exports = {
    // enums
    ENUMS,
    ORGANIZATION_TYPE, OPERATION_TYPE, WORLD_TYPE, ORGANIZATION_STATUS,
    AIRCRAFT_STATUS, AIRCRAFT_VISIBILITY, PERSISTENCE_STATE, SCHEDULE_STATUS, FLIGHT_TYPE,
    describeEnum, enumValue,
    // scopes
    SCOPES, DEFAULT_SCOPES, READ_SCOPES, normalizeScopes, scopeString, canWriteSchedules,
    // shapes
    publicOrganization, publicAircraft, publicPosition, publicSchedule,
    blockMinutes, describeSchedule,
    // requests
    scheduleRequest, flightPlanRequest, reorderRequest, reorderPlan, utc,
    // the bridge
    fromCrewSchedule, toCrewSchedule, scheduleDiff,
    // utilisation
    aircraftUtilisation, fleetUtilisation, UPCOMING_GRACE_MS,
    // errors
    statusMessage, isRetryable,
    // limits, exported so the front-end counts down to the same numbers
    LIMITS: {
        callsign: CALLSIGN_MAX,
        icao: ICAO_MAX,
        briefing: BRIEFING_MAX,
        flightPlan: FLIGHT_PLAN_MAX,
    },
    STALE_AFTER_MS,
};

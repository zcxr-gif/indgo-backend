'use strict';

/*
 * crewSchedules.js
 * The airline's week: which legs are flown when, and who has taken them.
 *
 * WHAT LIVES HERE
 * ---------------
 * Everything about a scheduled departure that is a decision rather than a
 * database write: what a submitted schedule entry is allowed to say
 * (sanitizeSchedule), what a departure and a booking look like to the world
 * (publicSchedule / publicBooking), which seat a booking pilot should be given
 * (nextFreeSeat), and how one template becomes a fortnight of flying
 * (expandSeries).
 *
 * The rows belong to crewStore, like every other piece of a VA's data — see
 * supabase/crew-center-schema.sql for the two tables.
 *
 * WHY THIS IS NOT EVENTS
 * ----------------------
 * An event is everyone at once: one departure, twenty pilots, a gate board to
 * keep them off each other's stands. A schedule is the ordinary week: many
 * departures, each flown by one pilot or a small crew, nobody gathering. The
 * questions asked of the two are different — "who is coming?" against "is this
 * leg covered?" — so they are separate tables with separate modules, and the
 * shapes here deliberately rhyme with crewEvents.js without being it.
 *
 * WHERE THE AUTHORITY SITS
 * ------------------------
 * Nothing in this file decides whether a seat is free. That is a unique index
 * on (schedule_id, seat) in the VA's own Postgres, and it has to be: publishing
 * a fortnight of flying puts every pilot on the same page inside a minute, and
 * any "is this leg full?" read taken before the insert loses that race. What
 * nextFreeSeat() returns is a PROPOSAL — the lowest seat nobody was holding a
 * moment ago. The insert is attempted, Postgres arbitrates, and the caller
 * retries against what is free now. A pilot is told a departure is full only
 * when every seat has genuinely gone.
 *
 * Pure. No database, no network, no mongoose.
 */

const STATUSES = ['draft', 'published', 'cancelled'];

// How many seats one departure may carry. One is the overwhelming case; the
// ceiling is here so a typo cannot publish a leg with four thousand seats on it
// and make the schedule unreadable. Matches the column's own bounds.
const MAX_SEATS = 20;

// How far one template may be repeated in a single sitting. A VA builds a
// fortnight or a month at a time; anything past this is a data-entry accident,
// and every row is a real row in the VA's own project.
const MAX_SERIES = 60;

const REPEATS = ['none', 'daily', 'weekly'];

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const icao = (v) => str(v, 8).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const when = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * What a submitted schedule entry is allowed to say.
 *
 * Note `status`, for the reason sanitizeEvent notes it: anything unrecognised
 * becomes 'draft', never 'published'. A departure that appears on a VA's public
 * schedule because a field was misspelt is the one failure mode here that
 * reaches strangers.
 *
 * Note `seats`: floored at 1, not 0. The column refuses a zero and would fail
 * the whole write, and a caller sending one means "one pilot" — a departure
 * nobody can be assigned to is not a departure.
 */
function sanitizeSchedule(b) {
    b = b || {};
    return {
        // The leg in the VA's network this departure flies, when it is one. ''
        // rather than a uuid means an ad-hoc leg: a charter, a positioning
        // flight, a one-off the published network does not carry.
        routeId: str(b.routeId, 64),
        flightNumber: str(b.flightNumber, 12),
        origin: icao(b.origin),
        destination: icao(b.destination),
        aircraft: str(b.aircraft, 60),
        // WHICH AEROPLANE, as opposed to which TYPE.
        //
        // `aircraft` above is the type and livery — "Boeing 787-10, British
        // Airways" — which is what a VA has always been able to say about a
        // departure. This is a specific airframe out of the VA's Infinite
        // Flight organization: the persistent organization aircraft id, and its
        // registration kept alongside.
        //
        // The registration is DENORMALISED on purpose. It is the only part a
        // pilot reads ("you're on N682XL"), and looking it up would mean a call
        // to Infinite Flight to draw a schedule — on a page a whole roster
        // loads, for a VA that may not have connected an organization at all.
        // The id is the truth; this is the label, and a stale label on a
        // re-registered airframe is a far smaller problem than a schedule that
        // cannot render without a third party answering.
        ifAircraftId: str(b.ifAircraftId, 64),
        ifRegistration: str(b.ifRegistration, 40),
        departsAt: when(b.departsAt),
        arrivesAt: when(b.arrivesAt),
        seats: Math.max(1, Math.min(MAX_SEATS, Math.round(Number(b.seats) || 1))),
        minRank: str(b.minRank, 40),
        notes: str(b.notes, 2000),
        status: STATUSES.includes(b.status) ? b.status : 'draft',
    };
}

/** The fields staff may change on somebody else's booking. */
function sanitizeBookingPatch(b, { allowIdentity = false } = {}) {
    b = b || {};
    const patch = {};
    if (allowIdentity && b.pilotName !== undefined) patch.pilotName = str(b.pilotName, 80);
    if (b.callsign !== undefined) patch.callsign = str(b.callsign, 20);
    if (b.note !== undefined) patch.note = str(b.note, 300);
    // Deliberately absent: `seat` and `status`. The seat is the database's to
    // arbitrate (see the header), and 'flown' is set by a filed flight report
    // rather than by anyone saying so.
    return patch;
}

/**
 * A booking, as everyone sees it.
 *
 * A crew center's schedule is public by design — a pilot picking a leg needs to
 * see which are covered — but a booking carries a name and a seat only. No
 * account id, no email, nothing that identifies a login. Same rule as
 * publicSignup.
 */
const publicBooking = (b) => ({
    id: b._id,
    memberId: b.memberId || null,
    pilotName: b.pilotName,
    callsign: b.callsign,
    seat: b.seat,
    note: b.note,
    status: b.status,
    bookedAt: b.createdAt,
});

/**
 * A departure, as everyone sees it.
 *
 * `ranks`/`viewer` give it the same rank treatment a route and an event get: a
 * pilot below the bar sees the leg LOCKED, not hidden, with how much further
 * they have to fly.
 *
 * Coverage figures are null — never 0 — when the caller did not pass
 * `bookings`. A row printing "0 booked" for a figure nobody counted is a claim,
 * and the rule across this codebase is to say nothing rather than something
 * untrue.
 */
function publicSchedule(s, { bookings = null, ranks = null, viewer = null, canManage = false, meetsRank = null } = {}) {
    const taken = bookings ? bookings.length : null;
    const gated = !!s.minRank;
    const locked = gated && !!viewer && typeof meetsRank === 'function'
        && !meetsRank(ranks, viewer.hours, s.minRank);
    return {
        id: s._id,
        routeId: s.routeId || null,
        flightNumber: s.flightNumber,
        origin: s.origin,
        destination: s.destination,
        aircraft: s.aircraft,
        // The specific aeroplane, when the VA has assigned one. Sent as a pair
        // rather than a bare string so a front-end can link the id through to
        // the fleet board while showing the registration — and `null` rather
        // than an empty object when there is none, so "no airframe assigned"
        // cannot be mistaken for one with a blank registration.
        airframe: s.ifAircraftId ? {
            id: s.ifAircraftId,
            registration: s.ifRegistration || '',
        } : null,
        departsAt: s.departsAt,
        arrivesAt: s.arrivesAt,
        // Minutes rather than a formatted string: the crew center, the embed
        // and a VA's own site all want to render it their own way, and the one
        // thing they must not each re-derive is the arithmetic.
        blockMinutes: blockMinutes(s),
        seats: s.seats,
        minRank: s.minRank || '',
        notes: s.notes,
        status: s.status,
        locked,
        booked: taken,
        seatsLeft: taken == null ? null : Math.max(0, s.seats - taken),
        full: taken == null ? false : taken >= s.seats,
        flown: bookings ? bookings.some((b) => b.status === 'flown') : null,
        canManage,
        createdAt: s.createdAt,
    };
}

/**
 * Scheduled block time, in minutes, or null when the VA published only a
 * departure time — which plenty do.
 *
 * Negative results are treated as no answer rather than shown. An arrival
 * before its departure is a typo (or a VA entering local times in two zones),
 * and "-540 min" on a schedule row helps nobody.
 */
function blockMinutes(s) {
    const dep = when(s && s.departsAt);
    const arr = when(s && s.arrivesAt);
    if (!dep || !arr) return null;
    const mins = Math.round((arr.getTime() - dep.getTime()) / 60000);
    return mins > 0 ? mins : null;
}

/**
 * The lowest seat nobody is holding, or 0 when the departure is full.
 *
 * LOWEST, not next: seats are 1..seats and a cancellation leaves a hole in the
 * middle. Filling that hole rather than appending keeps a two-crew departure
 * reading as "1 and 2" instead of "1 and 7", and — because the unique index is
 * what actually decides — makes the retry after a lost race land somewhere
 * useful instead of climbing forever.
 *
 * This is a proposal, never a guarantee. See the header.
 */
function nextFreeSeat(schedule, bookings) {
    if (!schedule) return 0;
    const seats = Math.max(1, Math.min(MAX_SEATS, Number(schedule.seats) || 1));
    const held = new Set((bookings || []).map((b) => Number(b.seat) || 0));
    for (let seat = 1; seat <= seats; seat += 1) {
        if (!held.has(seat)) return seat;
    }
    return 0;
}

/** Has every seat gone? */
const isFull = (schedule, bookings) => nextFreeSeat(schedule, bookings) === 0;

/**
 * Can this departure still be booked at all?
 *
 * Separate from "is it full" because the answers are different sentences to the
 * pilot reading them, and because the ordering matters: a cancelled leg is not
 * "full", and a leg that left an hour ago is not either.
 *
 * The twelve-hour grace matches listSchedules({ upcomingOnly }) and the events
 * window: a pilot who is airborne on the leg still needs to reach their booking,
 * and staff assigning cover for a departure that has just pushed back is a
 * normal Tuesday, not an edge case.
 */
function bookingClosedReason(schedule, { now = Date.now() } = {}) {
    if (!schedule) return 'missing';
    if (schedule.status === 'cancelled') return 'cancelled';
    if (schedule.status !== 'published') return 'missing';
    const dep = when(schedule.departsAt);
    if (dep && dep.getTime() < now - 12 * 3600 * 1000) return 'departed';
    return '';
}

/**
 * One template, repeated — the difference between building a fortnight of
 * flying and typing it out thirty times.
 *
 * Returns the { departsAt, arrivesAt } pairs to create, the first of which is
 * the template's own times. Daily and weekly only: those are the two shapes an
 * airline's own schedule actually takes, and "every third Thursday" is a
 * calendar library's problem, not a crew center's.
 *
 * Arithmetic is done in whole days on the millisecond clock, which is what a
 * VA means by "same time next week" — the departure keeps its UTC time of day
 * across a daylight-saving boundary rather than drifting an hour. A VA that
 * wants the local hour held instead can edit the row; a VA whose whole schedule
 * silently moved would not know to.
 */
function expandSeries({ departsAt, arrivesAt, repeat = 'none', count = 1 } = {}) {
    const dep = when(departsAt);
    const arr = when(arrivesAt);
    const mode = REPEATS.includes(repeat) ? repeat : 'none';
    const times = Math.max(1, Math.min(MAX_SERIES, Math.round(Number(count) || 1)));

    // No departure time to step from, or no repetition asked for: one row, as
    // submitted. A schedule entry without a time is legitimate (staff sketching
    // next month's pattern) and must not be silently multiplied.
    if (!dep || mode === 'none') return [{ departsAt: dep, arrivesAt: arr }];

    const stepDays = mode === 'daily' ? 1 : 7;
    const out = [];
    for (let i = 0; i < times; i += 1) {
        const shift = i * stepDays * 24 * 3600 * 1000;
        out.push({
            departsAt: new Date(dep.getTime() + shift),
            arrivesAt: arr ? new Date(arr.getTime() + shift) : null,
        });
    }
    return out;
}

/* ===========================================================================
 * HOW THE VA CHOOSES TO RUN IT
 *
 * Airlines run bidding very differently and the crew center should not have an
 * opinion. Some publish a week and let anyone take anything; some assign every
 * leg by hand; some open the schedule at First Officer and no lower. That is
 * what these rules are, and they are the VA's to set (see `crewSchedule` on the
 * VA document).
 *
 * Two things worth stating, because they are what make this safe:
 *
 *   1. THE REFUSAL IS DECIDED HERE, ON THE SERVER'S SIDE OF THE WIRE. The panel
 *      reads the same rules to grey a button out and say why — but a browser
 *      that skipped straight to POST /book still gets stopped, because this
 *      function is what the endpoint calls. A rule enforced only in the UI is a
 *      suggestion.
 *
 *   2. A REFUSAL IS A SENTENCE, NOT A BOOLEAN. Every one of these carries the
 *      reason a pilot needs: not "you cannot book this" but "the schedule opens
 *      seven days before departure — this one opens on Tuesday". A rule a pilot
 *      cannot see the shape of is one they will ask staff about instead.
 * ========================================================================= */

const DEFAULT_RULES = {
    enabled: true,
    booking: 'pilots',
    minRank: '',
    maxPerPilot: 0,
    openDaysAhead: 0,
    cancelHoursBefore: 0,
};

const BOOKING_MODES = ['pilots', 'staff'];

/**
 * The VA's settings, with every field present and in range.
 *
 * Callers get a whole object or nothing useful — a half-populated rules object
 * is how "0 means unlimited" turns into "undefined means refuse everybody".
 */
function normalizeRules(cfg) {
    const c = cfg || {};
    const int = (v, lo, hi, def) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return {
        // Absent means on. The feature predates nobody's choice about it, and a
        // VA who has never opened these settings has not asked for it to be off.
        enabled: c.enabled === undefined ? true : !!c.enabled,
        booking: BOOKING_MODES.includes(c.booking) ? c.booking : 'pilots',
        minRank: str(c.minRank, 40),
        maxPerPilot: int(c.maxPerPilot, 0, 50, 0),
        openDaysAhead: int(c.openDaysAhead, 0, 365, 0),
        cancelHoursBefore: int(c.cancelHoursBefore, 0, 336, 0),
    };
}

/** When booking opens for a departure, or null when it is always open. */
function opensAt(schedule, rules) {
    const r = normalizeRules(rules);
    const dep = when(schedule && schedule.departsAt);
    if (!r.openDaysAhead || !dep) return null;
    return new Date(dep.getTime() - r.openDaysAhead * 24 * 3600 * 1000);
}

/**
 * Why this pilot may not take this leg — or null, meaning they may.
 *
 * Checked in the order a pilot would ask the questions, so the FIRST true thing
 * is the one they are told. "The schedule is staff-assigned" is more useful than
 * "you already hold three legs" to somebody who could never have booked it.
 *
 * `byStaff` skips the lot. A staff member assigning cover, or putting a guest
 * crew from a partner VA on a leg, is deliberately overriding these rules —
 * that is what assigning by hand IS — and blocking them with a bidding window
 * would leave a departure uncovered to enforce a rule about fairness.
 */
function bookingRefusal(schedule, rules, {
    now = Date.now(), held = 0, hours = 0, ranks = null, meetsRank = null, byStaff = false,
} = {}) {
    const r = normalizeRules(rules);

    if (!r.enabled) {
        return { code: 'schedule_off', message: 'This crew center isn’t using the schedule.' };
    }
    if (byStaff) return null;

    if (r.booking === 'staff') {
        return {
            code: 'staff_assigned',
            message: 'Your staff assign the flying on this schedule — ask them for a leg.',
        };
    }

    // The airline-wide gate. A per-departure minRank is checked separately by
    // the caller and stacks on top of this: either can refuse, so the effective
    // bar is whichever is higher, without this needing to order the ladder.
    if (r.minRank && typeof meetsRank === 'function' && !meetsRank(ranks, hours, r.minRank)) {
        return {
            code: 'rank_locked',
            message: `The schedule opens at ${r.minRank}.`,
            minRank: r.minRank,
        };
    }

    const open = opensAt(schedule, r);
    if (open && now < open.getTime()) {
        return {
            code: 'not_open_yet',
            message: `Booking opens ${r.openDaysAhead} day${r.openDaysAhead === 1 ? '' : 's'} before departure.`,
            opensAt: open,
        };
    }

    if (r.maxPerPilot && held >= r.maxPerPilot) {
        return {
            code: 'max_bookings',
            message: `You’re already holding ${held} departure${held === 1 ? '' : 's'} — this crew center allows ${r.maxPerPilot} at a time.`,
            maxPerPilot: r.maxPerPilot,
        };
    }

    return null;
}

/**
 * Why this pilot may not hand this leg back — or null, meaning they may.
 *
 * Two reasons, and they are different in kind. A flight already FLOWN is a
 * record of something that happened and deleting it would erase who flew it —
 * refused for everybody, staff included, because the fix for a wrong record is
 * to correct the flight report, not to unbook the past. A cutoff, by contrast,
 * is a courtesy to whoever has to find cover, so staff can always override it.
 */
function cancelRefusal(booking, schedule, rules, { now = Date.now(), byStaff = false } = {}) {
    if (booking && booking.status === 'flown') {
        return {
            code: 'already_flown',
            message: 'This leg has already been flown — it stays on the record.',
        };
    }
    if (byStaff) return null;

    const r = normalizeRules(rules);
    const dep = when(schedule && schedule.departsAt);
    if (r.cancelHoursBefore && dep && dep.getTime() - now < r.cancelHoursBefore * 3600 * 1000) {
        return {
            code: 'too_late',
            message: `Legs can’t be given back within ${r.cancelHoursBefore} hour${r.cancelHoursBefore === 1 ? '' : 's'} of departure — talk to your staff.`,
            cancelHoursBefore: r.cancelHoursBefore,
        };
    }
    return null;
}

/**
 * The rules as the crew center reads them.
 *
 * Sent on every schedule fetch so the panel can grey the right button and say
 * why before a pilot presses it. Identical in shape to what is enforced, which
 * is the point — two descriptions of one rule is how a UI ends up promising
 * something the server refuses.
 */
const publicRules = (rules) => normalizeRules(rules);

/**
 * The leg in words, for a Discord notice or a noticeboard row.
 *
 * Falls back through what is actually set rather than printing empty arrows: a
 * VA that publishes "BA117" and a time, and fills the airports in later, gets
 * "BA117" — not "BA117 · → ".
 */
function describeLeg(s) {
    if (!s) return '';
    const leg = [s.origin, s.destination].filter(Boolean).join(' → ');
    return [s.flightNumber, leg].filter(Boolean).join(' · ');
}

module.exports = {
    sanitizeSchedule,
    sanitizeBookingPatch,
    publicSchedule,
    publicBooking,
    blockMinutes,
    nextFreeSeat,
    isFull,
    bookingClosedReason,
    expandSeries,
    describeLeg,
    normalizeRules,
    bookingRefusal,
    cancelRefusal,
    opensAt,
    publicRules,
    DEFAULT_RULES,
    BOOKING_MODES,
    STATUSES,
    REPEATS,
    MAX_SEATS,
    MAX_SERIES,
};

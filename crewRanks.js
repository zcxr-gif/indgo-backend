'use strict';

/*
 * crewRanks.js
 * The VA's rank ladder, resolved in one place.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ladder itself is old — a VA has always been able to define ranks with
 * minimum hours, and the dashboard has always drawn a badge next to a pilot's
 * name. But the resolving was done in the browser, which meant the server had
 * no idea what rank anybody held. That was fine while a rank was decoration.
 * It stops being fine the moment a rank decides something:
 *
 *   * a route that only opens at First Officer has to be enforced somewhere a
 *     pilot cannot edit;
 *   * a promotion is worth announcing, and only the server sees the hours
 *     change that caused it;
 *   * three different surfaces drawing the same badge from three copies of the
 *     same arithmetic will eventually disagree, and the one that disagrees will
 *     be the one a pilot is looking at.
 *
 * So the ladder resolves here, and the server hands the answer out.
 *
 * RANK IS DERIVED, NEVER STORED
 * -----------------------------
 * A pilot's rank is a function of their hours and the VA's current ladder. It
 * is deliberately NOT a column on crew_members, because the moment it is stored
 * it can disagree with the hours next to it — and it would, constantly: every
 * approved flight, every rolled-back rejection, every time a VA edits the
 * ladder. A stored rank would need a migration every time someone moved a
 * threshold. A derived one is simply correct.
 *
 * The cost is that "when was I promoted?" has no answer here. That is the right
 * trade: the promotion NOTICE is emitted at the moment hours cross a rung (see
 * promotionFor), which is when anyone cares.
 *
 * CHECK-RIDES — THE ONE THING HOURS DO NOT DECIDE
 * -----------------------------------------------
 * A VA can mark any rung "requires a check-ride" (`requiresCheck`), and most
 * mark none, or one — the step up to Captain, usually. Hours then get a pilot
 * to the DOOR of that rung and no further: they hold the rung below and are
 * reported as `awaitingCheck`, until a staff member signs them off and the
 * rung's name lands in the pilot's `checksPassed`.
 *
 * So rank is still derived, from two inputs instead of one. It is emphatically
 * not stored — sign-off is stored, which is a different thing: it is a record
 * of something a human did, it does not go stale when the ladder is edited, and
 * it cannot disagree with the hours beside it.
 *
 * Sign-off is recorded by NAME, like every other rank reference in this file
 * (crew_routes.min_rank, the gate on an event). A VA reordering their ladder
 * must not silently un-promote their roster. And a rung that is renamed lets
 * the requirement lapse, which promotes the pilot — the same direction of
 * failure meetsRank chose, and the right one: a pilot stuck below a rank
 * because of a rename nobody remembers is a support ticket nobody can answer.
 *
 * THE ENTRY RUNG
 * --------------
 * A brand-new pilot has zero hours, and a VA whose ladder starts at "Second
 * Officer, 25h" would leave them with no rank at all — nameless on the roster
 * on their first day, which is precisely the moment a new pilot is looking.
 * So the lowest rung of a ladder is always the entry rank, whatever number is
 * written next to it. `rankForHours` floors it; the VA's threshold still
 * governs everyone above.
 */

const clampStr = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/**
 * Put a ladder in a known shape: sorted by hours ascending, junk dropped.
 *
 * Callers get a NEW array — the ladder arrives off a lean() mongoose document
 * that other code is also holding, and sorting in place would reorder it under
 * them.
 */
function normalizeLadder(ranks) {
    if (!Array.isArray(ranks)) return [];
    return ranks
        .filter((r) => r && clampStr(r.name, 40))
        .map((r) => ({
            name: clampStr(r.name, 40),
            minHours: Math.max(0, Number(r.minHours) || 0),
            color: clampStr(r.color, 20),
            icon: clampStr(r.icon, 30),
            image: clampStr(r.image, 600),
            // A rung a pilot cannot reach on hours alone. Absent on almost
            // every rung of almost every ladder.
            requiresCheck: !!r.requiresCheck,
            // What the VA wants flown or demonstrated, in their own words —
            // shown to the pilot so "awaiting a check-ride" is actionable
            // rather than mysterious.
            checkNote: clampStr(r.checkNote, 300),
        }))
        .sort((a, b) => a.minHours - b.minHours);
}

/** The set of rung names a pilot has been signed off for, lower-cased. */
function passedSet(checksPassed) {
    const out = new Set();
    for (const c of Array.isArray(checksPassed) ? checksPassed : []) {
        const name = clampStr(c, 40).toLowerCase();
        if (name) out.add(name);
    }
    return out;
}

/**
 * The rank a pilot holds: the highest rung their hours reach, stopping BELOW
 * any rung that requires a check-ride they have not passed.
 *
 * Returns null only when the VA has defined no ladder at all — in which case
 * there is no rank to hold and every surface should simply show nothing, rather
 * than inventing a "Pilot" nobody configured.
 *
 * The walk stops at the first unpassed gate rather than skipping over it. A
 * pilot with 400 hours who has not sat their Captain check does not leapfrog to
 * Senior Captain because they have the hours for that too — the ladder is a
 * ladder, and a rung you have not been signed off for is not one you climbed
 * past.
 */
function rankForHours(ranks, hours, checksPassed) {
    const ladder = normalizeLadder(ranks);
    if (!ladder.length) return null;
    const h = Math.max(0, Number(hours) || 0);
    const passed = passedSet(checksPassed);
    // The lowest rung is the entry rank regardless of its threshold — see the
    // header. Everyone starts somewhere. (A check-ride on the ENTRY rung is
    // ignored for the same reason: there is nothing below it to hold instead,
    // and a nameless pilot on their first day is what that rule exists to
    // prevent.)
    let held = ladder[0];
    for (const rung of ladder.slice(1)) {
        if (h < rung.minHours) break;
        if (rung.requiresCheck && !passed.has(rung.name.toLowerCase())) break;
        held = rung;
    }
    return held;
}

/**
 * The rung a pilot has earned on hours but is waiting to be signed off for, or
 * null when they are not waiting on anybody.
 *
 * This is what turns a stalled promotion into something a pilot and a staff
 * member can both see: the roster shows "ready for their Captain check-ride"
 * instead of a pilot who quietly stopped being promoted.
 */
function awaitingCheck(ranks, hours, checksPassed) {
    const ladder = normalizeLadder(ranks);
    if (ladder.length < 2) return null;
    const h = Math.max(0, Number(hours) || 0);
    const passed = passedSet(checksPassed);
    for (const rung of ladder.slice(1)) {
        if (h < rung.minHours) return null;                       // not there yet
        if (rung.requiresCheck && !passed.has(rung.name.toLowerCase())) {
            return { name: rung.name, minHours: rung.minHours, checkNote: rung.checkNote || '' };
        }
    }
    return null;
}

/** Where a rank sits on the ladder. -1 for "not on this ladder any more". */
function rankIndex(ranks, name) {
    const wanted = clampStr(name, 40).toLowerCase();
    if (!wanted) return -1;
    return normalizeLadder(ranks).findIndex((r) => r.name.toLowerCase() === wanted);
}

/**
 * Does a pilot on `hours` hold at least `requiredRank`?
 *
 * Open when nothing is required, and — deliberately — open when the required
 * rank is not on the ladder any more. A VA who renames or deletes a rank should
 * not silently lock pilots out of a chunk of their own route network; the
 * failure mode has to be "the gate lapses", not "the network quietly shrinks".
 */
function meetsRank(ranks, hours, requiredRank) {
    const need = clampStr(requiredRank, 40);
    if (!need) return true;
    const ladder = normalizeLadder(ranks);
    const idx = ladder.findIndex((r) => r.name.toLowerCase() === need.toLowerCase());
    if (idx < 0) return true;
    return Math.max(0, Number(hours) || 0) >= ladder[idx].minHours;
}

/** How many more hours until `requiredRank` — for "unlocks in 12h" copy. */
function hoursUntilRank(ranks, hours, requiredRank) {
    const need = clampStr(requiredRank, 40);
    if (!need) return 0;
    const ladder = normalizeLadder(ranks);
    const rung = ladder.find((r) => r.name.toLowerCase() === need.toLowerCase());
    if (!rung) return 0;
    return Math.max(0, rung.minHours - Math.max(0, Number(hours) || 0));
}

/**
 * The next rung up, and the gap to it. null once a pilot is at the top.
 * Drives the "38h to First Officer" line on a pilot's own dashboard.
 *
 * `hoursAway` is 0 for a pilot who already has the hours and is waiting on a
 * check-ride — which is exactly right, and is why the caller also gets
 * `requiresCheck`: nothing more to fly, someone to see.
 */
function nextRank(ranks, hours, checksPassed) {
    const ladder = normalizeLadder(ranks);
    if (!ladder.length) return null;
    const h = Math.max(0, Number(hours) || 0);
    // The rung above the one actually HELD, rather than the first rung whose
    // threshold is beyond these hours. The two agree for everybody except a
    // pilot stopped at a check-ride — and for them the by-hours answer points
    // past the very rung that is blocking them, telling someone waiting on
    // their Captain check that Senior Captain is what's next.
    const held = rankForHours(ranks, hours, checksPassed);
    const idx = held ? ladder.findIndex((r) => r.name === held.name) : -1;
    const next = ladder[idx + 1];
    return next ? { ...next, hoursAway: Math.max(0, next.minHours - h) } : null;
}

/**
 * Did crediting hours promote this pilot?
 *
 * Compares the rank held before against the rank held after, so it is immune to
 * how the hours moved — one long flight that skips two rungs reports the rung
 * actually reached, and a rejection that claws hours back reports nothing
 * rather than a demotion. Announcing demotions is deliberately not a feature:
 * an admin correcting a mistyped figure should not publish "Jo has been demoted"
 * to a Discord channel.
 *
 * `checksPassed` is held CONSTANT across both readings on purpose. This asks
 * "did the hours move them?", and a pilot whose hours crossed a check-gated
 * rung has not been promoted by them — they are now waiting on a check-ride,
 * which is awaitingCheck's business and a different notice. The promotion that
 * follows the sign-off is reported by promotionForCheck below.
 *
 * @returns {{from: Object|null, to: Object, skipped: number}|null}
 */
function promotionFor(ranks, hoursBefore, hoursAfter, checksPassed) {
    const before = rankForHours(ranks, hoursBefore, checksPassed);
    const after = rankForHours(ranks, hoursAfter, checksPassed);
    if (!after) return null;
    if (before && before.name === after.name) return null;
    const ladder = normalizeLadder(ranks);
    const fromIdx = before ? ladder.findIndex((r) => r.name === before.name) : -1;
    const toIdx = ladder.findIndex((r) => r.name === after.name);
    if (toIdx <= fromIdx) return null;   // a rollback, or a ladder edit. Say nothing.
    return { from: before, to: after, skipped: Math.max(0, toIdx - fromIdx - 1) };
}

/**
 * Did signing a pilot off promote them?
 *
 * The mirror of promotionFor: hours held constant, the sign-off list moving.
 * Staff passing someone's check-ride is exactly as much a promotion as the
 * hours that got them there, and it earns the same notice — so the two paths
 * into "Jo is now a Captain" produce the same announcement rather than one of
 * them happening silently.
 */
function promotionForCheck(ranks, hours, checksBefore, checksAfter) {
    const before = rankForHours(ranks, hours, checksBefore);
    const after = rankForHours(ranks, hours, checksAfter);
    if (!after) return null;
    if (before && before.name === after.name) return null;
    const ladder = normalizeLadder(ranks);
    const fromIdx = before ? ladder.findIndex((r) => r.name === before.name) : -1;
    const toIdx = ladder.findIndex((r) => r.name === after.name);
    if (toIdx <= fromIdx) return null;   // a revoked sign-off. Say nothing.
    return { from: before, to: after, skipped: Math.max(0, toIdx - fromIdx - 1) };
}

/**
 * What a member looks like once the ladder has been applied. Small on purpose —
 * this is merged into the member payload every surface already receives, so it
 * must not double the size of a roster response.
 */
function memberRank(ranks, hours, checksPassed) {
    const held = rankForHours(ranks, hours, checksPassed);
    if (!held) return null;
    const next = nextRank(ranks, hours, checksPassed);
    const waiting = awaitingCheck(ranks, hours, checksPassed);
    return {
        name: held.name,
        minHours: held.minHours,
        color: held.color || '',
        icon: held.icon || '',
        image: held.image || '',
        next: next ? {
            name: next.name,
            minHours: next.minHours,
            hoursAway: next.hoursAway,
            requiresCheck: !!next.requiresCheck,
        } : null,
        // Set only for a pilot who has the hours and is waiting on a person.
        // Every surface that draws a rank badge can then say so, which is the
        // difference between "you have stopped being promoted" and "you are
        // one check-ride away".
        awaitingCheck: waiting,
    };
}

module.exports = {
    normalizeLadder,
    rankForHours,
    rankIndex,
    meetsRank,
    hoursUntilRank,
    nextRank,
    awaitingCheck,
    promotionFor,
    promotionForCheck,
    memberRank,
};

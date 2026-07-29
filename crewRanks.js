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
        }))
        .sort((a, b) => a.minHours - b.minHours);
}

/**
 * The rank a pilot with this many hours holds.
 *
 * Returns null only when the VA has defined no ladder at all — in which case
 * there is no rank to hold and every surface should simply show nothing, rather
 * than inventing a "Pilot" nobody configured.
 */
function rankForHours(ranks, hours) {
    const ladder = normalizeLadder(ranks);
    if (!ladder.length) return null;
    const h = Math.max(0, Number(hours) || 0);
    // The lowest rung is the entry rank regardless of its threshold — see the
    // header. Everyone starts somewhere.
    let held = ladder[0];
    for (const rung of ladder) if (h >= rung.minHours) held = rung;
    return held;
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
 */
function nextRank(ranks, hours) {
    const ladder = normalizeLadder(ranks);
    const h = Math.max(0, Number(hours) || 0);
    const next = ladder.find((r) => r.minHours > h);
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
 * @returns {{from: Object|null, to: Object, skipped: number}|null}
 */
function promotionFor(ranks, hoursBefore, hoursAfter) {
    const before = rankForHours(ranks, hoursBefore);
    const after = rankForHours(ranks, hoursAfter);
    if (!after) return null;
    if (before && before.name === after.name) return null;
    const ladder = normalizeLadder(ranks);
    const fromIdx = before ? ladder.findIndex((r) => r.name === before.name) : -1;
    const toIdx = ladder.findIndex((r) => r.name === after.name);
    if (toIdx <= fromIdx) return null;   // a rollback, or a ladder edit. Say nothing.
    return { from: before, to: after, skipped: Math.max(0, toIdx - fromIdx - 1) };
}

/**
 * What a member looks like once the ladder has been applied. Small on purpose —
 * this is merged into the member payload every surface already receives, so it
 * must not double the size of a roster response.
 */
function memberRank(ranks, hours) {
    const held = rankForHours(ranks, hours);
    if (!held) return null;
    const next = nextRank(ranks, hours);
    return {
        name: held.name,
        minHours: held.minHours,
        color: held.color || '',
        icon: held.icon || '',
        image: held.image || '',
        next: next ? { name: next.name, minHours: next.minHours, hoursAway: next.hoursAway } : null,
    };
}

module.exports = {
    normalizeLadder,
    rankForHours,
    rankIndex,
    meetsRank,
    hoursUntilRank,
    nextRank,
    promotionFor,
    memberRank,
};

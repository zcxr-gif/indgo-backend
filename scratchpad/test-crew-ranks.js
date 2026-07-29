'use strict';
// Conformance test for crewRanks — the VA's ladder, resolved server-side.
//
// Rank stopped being decoration the moment it started gating routes and firing
// promotion notices, so the things checked here are the ones that would either
// lock pilots out of a network they should have, or publish something wrong to
// a Discord channel:
//
//   * a brand-new pilot at zero hours HOLDS a rank, even when the VA's ladder
//     starts at 25 hours — no nameless first day
//   * a gate on a rank that no longer exists lapses open, rather than quietly
//     shrinking the network
//   * a promotion fires once, on the rung actually reached, and a rollback
//     fires nothing — correcting a mistyped hours figure must never announce a
//     demotion
//   * the ladder is never mutated in place, because callers share it
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const R = require(path.join('..', 'crewRanks.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// A conventional ladder, and one that starts above zero — the case that used to
// leave a new pilot with no rank at all.
const LADDER = [
    { name: 'Cadet', minHours: 0, color: '#64748b', icon: 'star' },
    { name: 'Second Officer', minHours: 25 },
    { name: 'First Officer', minHours: 100 },
    { name: 'Captain', minHours: 300 },
];
const NO_ENTRY = [
    { name: 'Second Officer', minHours: 25 },
    { name: 'First Officer', minHours: 100 },
];

console.log('\ncrewRanks\n');

// --- The ladder itself ------------------------------------------------------
console.log(' the ladder');
T('sorts by hours regardless of the order it was saved in',
    R.normalizeLadder([{ name: 'C', minHours: 300 }, { name: 'A', minHours: 0 }, { name: 'B', minHours: 25 }]).map((r) => r.name),
    ['A', 'B', 'C']);
T('drops nameless rungs', R.normalizeLadder([{ name: '', minHours: 5 }, { name: 'Real', minHours: 0 }]).length, 1);
T('an absent ladder is an empty one', R.normalizeLadder(undefined), []);
T('negative hours are floored at zero', R.normalizeLadder([{ name: 'X', minHours: -50 }])[0].minHours, 0);

// Callers hold this array off a lean() document; sorting in place would
// reorder it under them.
const original = [{ name: 'C', minHours: 300 }, { name: 'A', minHours: 0 }];
R.normalizeLadder(original);
T('normalising does not mutate the caller’s array', original[0].name, 'C');

// --- Who holds what ---------------------------------------------------------
console.log('\n resolving a rank');
T('zero hours is the entry rung', R.rankForHours(LADDER, 0).name, 'Cadet');
T('exactly on a threshold counts as reaching it', R.rankForHours(LADDER, 25).name, 'Second Officer');
T('one hour short does not', R.rankForHours(LADDER, 24.9).name, 'Cadet');
T('well past the top stays at the top', R.rankForHours(LADDER, 99999).name, 'Captain');
T('no ladder means no rank, not an invented one', R.rankForHours([], 50), null);

// The reason the entry rung is floored: a VA whose ladder starts at 25h would
// otherwise leave every new pilot rankless on the day they are most likely to
// be looking at their own profile.
T('a ladder starting above zero still gives a new pilot its first rung',
    R.rankForHours(NO_ENTRY, 0).name, 'Second Officer');
T('  …and the rung above still requires its hours',
    R.rankForHours(NO_ENTRY, 99).name, 'Second Officer');

// --- Gating -----------------------------------------------------------------
console.log('\n gating a route');
T('no requirement is open to everyone', R.meetsRank(LADDER, 0, ''), true);
T('below the bar is closed', R.meetsRank(LADDER, 99, 'First Officer'), false);
T('on the bar is open', R.meetsRank(LADDER, 100, 'First Officer'), true);
T('rank names match case-insensitively', R.meetsRank(LADDER, 100, 'first officer'), true);
// A VA renaming or deleting a rank must not silently shrink their own network.
T('a requirement naming a rank that no longer exists lapses OPEN',
    R.meetsRank(LADDER, 0, 'Wing Commander'), true);
T('hours until a gate', R.hoursUntilRank(LADDER, 60, 'First Officer'), 40);
T('  …is zero once cleared', R.hoursUntilRank(LADDER, 500, 'First Officer'), 0);
T('  …and zero for a gate that lapsed', R.hoursUntilRank(LADDER, 0, 'Wing Commander'), 0);

// --- Progression ------------------------------------------------------------
console.log('\n the next rung');
// Returns the whole rung (so a caller can draw its badge) plus the gap.
T('names the next rank', R.nextRank(LADDER, 10).name, 'Second Officer');
T('  …and the gap to it', R.nextRank(LADDER, 10).hoursAway, 15);
T('  …carrying the rung’s own fields', R.nextRank(LADDER, 10).minHours, 25);
T('nothing left at the top', R.nextRank(LADDER, 1000), null);

// --- Promotions -------------------------------------------------------------
console.log('\n promotions');
T('crossing a threshold promotes', R.promotionFor(LADDER, 90, 110).to.name, 'First Officer');
T('  …and says where from', R.promotionFor(LADDER, 90, 110).from.name, 'Second Officer');
T('staying inside a band promotes nobody', R.promotionFor(LADDER, 30, 40), null);
T('one long flight clearing two rungs reports the rung reached',
    R.promotionFor(LADDER, 20, 310).to.name, 'Captain');
T('  …and says how many it skipped', R.promotionFor(LADDER, 20, 310).skipped, 2);

// Announcing a demotion when an admin fixes a mistyped figure would be worse
// than announcing nothing, so this returns null rather than a downward move.
T('a rollback announces NOTHING', R.promotionFor(LADDER, 310, 20), null);
T('a rejected flight clawing hours back announces nothing', R.promotionFor(LADDER, 110, 90), null);
T('no ladder means no promotion to announce', R.promotionFor([], 0, 500), null);

// --- The member payload -----------------------------------------------------
console.log('\n what a member carries');
const badge = R.memberRank(LADDER, 0);
T('a new pilot carries the entry rank', badge.name, 'Cadet');
T('  …with its styling', [badge.color, badge.icon], ['#64748b', 'star']);
T('  …and what is next', badge.next,
    { name: 'Second Officer', minHours: 25, hoursAway: 25, requiresCheck: false });
T('a top-rank pilot has no next', R.memberRank(LADDER, 5000).next, null);
T('no ladder means no badge at all', R.memberRank([], 100), null);

// --- Check-rides ------------------------------------------------------------
//
// A rung a VA has gated on a check-ride is the one place hours do not decide
// rank. What is checked here is that hours get a pilot to the door and no
// further, that they are told they are AT the door, that a sign-off both
// promotes and announces, and — the two that would be quiet disasters — that a
// gated rung is never leapfrogged, and that a ladder edit fails toward
// promoting people rather than stranding them.
console.log('\n check-rides');
const CHECKED = [
    { name: 'Cadet', minHours: 0 },
    { name: 'Second Officer', minHours: 25 },
    { name: 'First Officer', minHours: 100 },
    { name: 'Captain', minHours: 300, requiresCheck: true, checkNote: 'One long-haul sector with a training captain.' },
    { name: 'Senior Captain', minHours: 600 },
];

T('below the gate, nothing changes', R.rankForHours(CHECKED, 150, []).name, 'First Officer');
T('at the gate WITHOUT a sign-off, the pilot holds the rung below',
    R.rankForHours(CHECKED, 400, []).name, 'First Officer');
T('  …and is told which rung they are waiting on',
    R.awaitingCheck(CHECKED, 400, []).name, 'Captain');
T('  …in the VA’s own words',
    R.awaitingCheck(CHECKED, 400, []).checkNote, 'One long-haul sector with a training captain.');
T('with the sign-off, the rung is theirs',
    R.rankForHours(CHECKED, 400, ['Captain']).name, 'Captain');
T('  …and nobody is waiting on anything', R.awaitingCheck(CHECKED, 400, ['Captain']), null);
T('sign-off is matched case-insensitively, like every other rank reference',
    R.rankForHours(CHECKED, 400, ['captain']).name, 'Captain');

// The quiet disaster: hours for a rung ABOVE the gate must not carry a pilot
// over it. A ladder is a ladder.
T('a gated rung is never leapfrogged, however many hours are logged',
    R.rankForHours(CHECKED, 5000, []).name, 'First Officer');
T('  …and clearing it releases everything above it',
    R.rankForHours(CHECKED, 5000, ['Captain']).name, 'Senior Captain');

// The other one: an edit to the ladder must fail toward promoting people.
T('a renamed gate lapses rather than stranding the pilot',
    R.rankForHours([{ name: 'Cadet', minHours: 0 }, { name: 'Skipper', minHours: 300 }], 400, []).name, 'Skipper');
T('a check-ride on the ENTRY rung is ignored — there is nothing below it',
    R.rankForHours([{ name: 'Cadet', minHours: 0, requiresCheck: true }], 0, []).name, 'Cadet');

// Hours crossing a gated rung is not a promotion — it is a pilot arriving at a
// door. Announcing "Jo is now a Captain" there would be a lie staff then have
// to walk back.
T('crossing INTO a gated rung announces nothing', R.promotionFor(CHECKED, 250, 400, []), null);
T('  …but crossing an ungated one still does',
    R.promotionFor(CHECKED, 50, 150, []).to.name, 'First Officer');
T('and the sign-off is what announces the promotion',
    R.promotionForCheck(CHECKED, 400, [], ['Captain']).to.name, 'Captain');
T('  …saying where from', R.promotionForCheck(CHECKED, 400, [], ['Captain']).from.name, 'First Officer');
T('revoking a sign-off announces NOTHING, like every other downward move',
    R.promotionForCheck(CHECKED, 400, ['Captain'], []), null);
T('signing off a pilot who has not got the hours announces nothing',
    R.promotionForCheck(CHECKED, 50, [], ['Captain']), null);

const waiting = R.memberRank(CHECKED, 400, []);
T('the badge shows the rank actually held', waiting.name, 'First Officer');
T('  …and that a check-ride is what is holding it up', waiting.awaitingCheck.name, 'Captain');
// "Next" is the rung ABOVE the one held, not the next threshold in hours —
// otherwise a pilot waiting on their Captain check is told Senior Captain is
// what's next, which is both true and useless.
T('  …and the next rung is the one blocking them, not the one past it',
    waiting.next.name, 'Captain');
T('  …which says a check-ride is what it wants', waiting.next.requiresCheck, true);
T('  …and that there are no hours left to fly for it', waiting.next.hoursAway, 0);
T('a signed-off pilot’s badge is clean', R.memberRank(CHECKED, 400, ['Captain']).awaitingCheck, null);
T('an ungated ladder never makes anyone wait', R.memberRank(LADDER, 5000).awaitingCheck, null);

console.log(failures ? `\n${failures} failing check(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);

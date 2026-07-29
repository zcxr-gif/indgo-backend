'use strict';
// Conformance test for crewSchedules — the airline's week, and the seat a pilot
// takes off it.
//
// A schedule is the first thing in the crew center where two pilots can want
// the same thing at the same moment, so the cases checked here are the ones
// that would either hand one seat to two people or refuse a leg that was
// actually free:
//
//   * the seat proposed is the LOWEST free one, so a cancellation's hole gets
//     refilled instead of the numbering climbing forever
//   * a full departure proposes 0 rather than a seat past the cap
//   * seats are floored at 1 on the way in — the column refuses a zero, and a
//     write that fails the check constraint fails the WHOLE row
//   * a status that is not recognised becomes 'draft', never 'published': a
//     departure that reaches a VA's public schedule because a field was
//     misspelt is the one failure mode here that reaches strangers
//   * repeating a template steps whole days on the clock and keeps the
//     template's own times as the first row
//   * block time is null rather than negative when the arrival precedes the
//     departure, which is what a VA entering two local times produces
//   * booking is closed for the right reasons in the right order — cancelled
//     is not "full", and a leg that left is not either
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const S = require(path.join('..', 'crewSchedules.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

console.log('\ncrewSchedules — seats');

const leg = { _id: 'sch1', seats: 3, status: 'published', departsAt: new Date(Date.now() + 86400e3) };

T('an empty departure offers seat 1', S.nextFreeSeat(leg, []), 1);
T('the next pilot gets 2', S.nextFreeSeat(leg, [{ seat: 1 }]), 2);
// The hole matters: seat 2 cancelling must not push the next pilot to 4.
T('a cancelled middle seat is refilled, not skipped',
    S.nextFreeSeat(leg, [{ seat: 1 }, { seat: 3 }]), 2);
T('a full departure offers nothing', S.nextFreeSeat(leg, [{ seat: 1 }, { seat: 2 }, { seat: 3 }]), 0);
T('…and says so', S.isFull(leg, [{ seat: 1 }, { seat: 2 }, { seat: 3 }]), true);
T('a single-seat leg is the common case', S.nextFreeSeat({ seats: 1 }, []), 1);
// Seats out of range would otherwise let a corrupt row hand out seat 900.
T('seats are clamped when the row is nonsense', S.nextFreeSeat({ seats: 9000 }, []), 1);
T('a missing schedule offers nothing', S.nextFreeSeat(null, []), 0);

console.log('\ncrewSchedules — what a departure may say');

const clean = S.sanitizeSchedule({
    origin: 'egll', destination: ' kjfk ', flightNumber: 'BA117',
    aircraft: 'Boeing 787-9', seats: 0, status: 'live', minRank: 'Captain',
    notes: 'Night sector.', routeId: 'rt-1',
});
T('airports are normalised to ICAO', [clean.origin, clean.destination], ['EGLL', 'KJFK']);
T('zero seats becomes one, not a failed write', clean.seats, 1);
T('an unrecognised status is a draft, never published', clean.status, 'draft');
T('the rank gate is carried', clean.minRank, 'Captain');
T('a real status survives', S.sanitizeSchedule({ status: 'published' }).status, 'published');
T('seats are capped', S.sanitizeSchedule({ seats: 999 }).seats, S.MAX_SEATS);

console.log('\ncrewSchedules — block time');

const dep = '2026-03-01T18:40:00.000Z';
T('block time is the difference in minutes',
    S.blockMinutes({ departsAt: dep, arrivesAt: '2026-03-01T22:10:00.000Z' }), 210);
T('no arrival means no answer', S.blockMinutes({ departsAt: dep }), null);
// A VA entering 18:40 departure and 08:10 arrival in two different local zones
// produces this; "-630 min" on a schedule row helps nobody.
T('an arrival before its departure is no answer, not a negative one',
    S.blockMinutes({ departsAt: dep, arrivesAt: '2026-03-01T08:10:00.000Z' }), null);

console.log('\ncrewSchedules — repeating a template');

const one = S.expandSeries({ departsAt: dep, arrivesAt: '2026-03-01T22:10:00.000Z' });
T('no repetition asked for is one row', one.length, 1);
T('…and it is the template’s own time', one[0].departsAt.toISOString(), dep);

const weekly = S.expandSeries({ departsAt: dep, arrivesAt: '2026-03-01T22:10:00.000Z', repeat: 'weekly', count: 3 });
T('a weekly series has one row per week', weekly.length, 3);
T('the first row is the template itself', weekly[0].departsAt.toISOString(), dep);
T('the second is seven days on', weekly[1].departsAt.toISOString(), '2026-03-08T18:40:00.000Z');
T('and the arrival moves with it', weekly[1].arrivesAt.toISOString(), '2026-03-08T22:10:00.000Z');

const daily = S.expandSeries({ departsAt: dep, repeat: 'daily', count: 2 });
T('a daily series steps one day', daily[1].departsAt.toISOString(), '2026-03-02T18:40:00.000Z');
T('an absent arrival stays absent', daily[1].arrivesAt, null);

T('a series is capped', S.expandSeries({ departsAt: dep, repeat: 'daily', count: 5000 }).length, S.MAX_SERIES);
// Multiplying a row that has no time would produce N identical undated rows.
T('a template with no time is never multiplied',
    S.expandSeries({ repeat: 'weekly', count: 5 }).length, 1);
T('an unknown repeat is treated as none',
    S.expandSeries({ departsAt: dep, repeat: 'fortnightly', count: 4 }).length, 1);

console.log('\ncrewSchedules — when booking is closed');

const soon = new Date(Date.now() + 3600e3).toISOString();
const longGone = new Date(Date.now() - 48 * 3600e3).toISOString();
const justWent = new Date(Date.now() - 3600e3).toISOString();

T('an open departure is bookable',
    S.bookingClosedReason({ status: 'published', departsAt: soon }), '');
T('a draft is not there at all',
    S.bookingClosedReason({ status: 'draft', departsAt: soon }), 'missing');
// Ordering matters: a cancelled leg must read as cancelled, not as departed.
T('a cancelled departure says cancelled',
    S.bookingClosedReason({ status: 'cancelled', departsAt: longGone }), 'cancelled');
T('a departure that has gone says so',
    S.bookingClosedReason({ status: 'published', departsAt: longGone }), 'departed');
// The twelve-hour grace: a pilot airborne on the leg still needs their booking.
T('one that pushed back an hour ago is still reachable',
    S.bookingClosedReason({ status: 'published', departsAt: justWent }), '');
T('a departure with no time never expires',
    S.bookingClosedReason({ status: 'published' }), '');
T('nothing at all is missing', S.bookingClosedReason(null), 'missing');

console.log('\ncrewSchedules — what the world sees');

const pub = S.publicSchedule(
    { _id: 's1', seats: 2, status: 'published', origin: 'EGLL', destination: 'KJFK', minRank: '' },
    { bookings: [{ seat: 1, status: 'booked' }] },
);
T('coverage is counted when bookings were passed', [pub.booked, pub.seatsLeft, pub.full], [1, 1, false]);

// The rule this codebase holds everywhere: a figure nobody computed is not 0.
const uncounted = S.publicSchedule({ _id: 's1', seats: 2, status: 'published' }, {});
T('a figure nobody counted is null, not zero',
    [uncounted.booked, uncounted.seatsLeft], [null, null]);
T('…and an uncounted departure is not "full"', uncounted.full, false);

const gated = S.publicSchedule(
    { _id: 's2', seats: 1, status: 'published', minRank: 'Captain' },
    { viewer: { hours: 10 }, ranks: [], meetsRank: () => false },
);
T('a pilot below the bar sees it locked, not hidden', gated.locked, true);
T('a booking never carries the account that made it',
    Object.keys(S.publicBooking({ _id: 'b1', memberId: 'm1', accountId: 'acct-secret', seat: 1, pilotName: 'Rae', callsign: '', note: '', status: 'booked' })).includes('accountId'),
    false);

console.log('\ncrewSchedules — the leg in words');
T('a full leg reads as both parts',
    S.describeLeg({ flightNumber: 'BA117', origin: 'EGLL', destination: 'KJFK' }), 'BA117 · EGLL → KJFK');
// Half-filled rows are normal while staff are still building the week.
T('a leg with only a flight number does not print empty arrows',
    S.describeLeg({ flightNumber: 'BA117' }), 'BA117');
T('nothing at all is empty, not "undefined"', S.describeLeg(null), '');

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

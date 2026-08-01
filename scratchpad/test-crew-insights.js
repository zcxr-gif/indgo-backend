// test-crew-insights.js — the aggregation behind the VA statistics screen.
//
// Every check here is a way the numbers could be quietly wrong rather than
// obviously broken: counting reports nobody approved, ranking a pilot who left
// years ago above the one flying this week, or reporting a network as fully
// flown because a retired route happens to match.
//
// Run:  node scratchpad/test-crew-insights.js
'use strict';
const assert = require('assert');
const I = require('../crewInsights');

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);          // 2026-07-31
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

let pass = 0;
const ok = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); process.exitCode = 1; }
};
const head = (s) => console.log(`\n${s}`);

const flight = (o) => ({
    status: 'approved', origin: 'EGLL', destination: 'KJFK', aircraftName: 'Boeing 777-300ER',
    durationMin: 420, landings: 1, distanceNm: 3000, memberId: 'm1', flownAt: daysAgo(5), ...o,
});

const MEMBERS = [
    { _id: 'm1', name: 'Rae Okafor', callsign: 'BAW22', hours: 412, status: 'active' },
    { _id: 'm2', name: 'Jo Adeyemi', callsign: 'BAW71', hours: 88, status: 'active' },
];

/* ------------------------------------------------------------------ */
head('Only approved flights count');

ok('a pending report is not in the totals', () => {
    const out = I.build({ pireps: [flight({}), flight({ status: 'pending' })], members: MEMBERS, now: NOW });
    assert.strictEqual(out.totals.flights, 1);
});

ok('nor is a rejected one', () => {
    const out = I.build({ pireps: [flight({}), flight({ status: 'rejected' })], members: MEMBERS, now: NOW });
    assert.strictEqual(out.totals.flights, 1);
});

ok('a rejected report does not appear in a popular route', () => {
    const out = I.build({
        pireps: [flight({ status: 'rejected', origin: 'EGKK', destination: 'LEBL' }), flight({})],
        members: MEMBERS, now: NOW,
    });
    assert.ok(!out.topRoutes.some((r) => r.origin === 'EGKK'));
});

/* ------------------------------------------------------------------ */
head('Most popular routes');

ok('routes are ranked by how often they are flown', () => {
    const out = I.build({
        pireps: [
            flight({ origin: 'EGLL', destination: 'LFPG' }),
            flight({ origin: 'EGLL', destination: 'LFPG' }),
            flight({ origin: 'EGLL', destination: 'KJFK' }),
        ],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.topRoutes[0].destination, 'LFPG');
    assert.strictEqual(out.topRoutes[0].flights, 2);
});

ok('a city pair is counted whether or not a route row exists', () => {
    // Flown before the route was published, or after it was retired.
    const out = I.build({ pireps: [flight({ routeId: null, origin: 'EIDW', destination: 'EGPH' })], members: MEMBERS, now: NOW });
    assert.strictEqual(out.topRoutes[0].origin, 'EIDW');
});

ok('airports are matched case- and space-insensitively', () => {
    const out = I.build({
        pireps: [flight({ origin: ' eGlL ', destination: 'lfpg' }), flight({ origin: 'EGLL', destination: 'LFPG' })],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.topRoutes.length, 1);
    assert.strictEqual(out.topRoutes[0].flights, 2);
});

ok('a route counts the distinct pilots who fly it', () => {
    const out = I.build({
        pireps: [flight({ memberId: 'm1' }), flight({ memberId: 'm2' }), flight({ memberId: 'm1' })],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.topRoutes[0].pilots, 2);
});

ok('the opposite direction is its own route', () => {
    const out = I.build({
        pireps: [flight({ origin: 'EGLL', destination: 'KJFK' }), flight({ origin: 'KJFK', destination: 'EGLL' })],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.topRoutes.length, 2);
});

/* ------------------------------------------------------------------ */
head('Most active pilots — not the hall of fame');

ok('ranked by flights in the window, not lifetime hours', () => {
    // m1 has 412 career hours but flew once; m2 has 88 and flew three times.
    const out = I.build({
        pireps: [
            flight({ memberId: 'm1' }),
            flight({ memberId: 'm2' }), flight({ memberId: 'm2' }), flight({ memberId: 'm2' }),
        ],
        members: MEMBERS, days: 30, now: NOW,
    });
    assert.strictEqual(out.topPilots[0].name, 'Jo Adeyemi');
    assert.strictEqual(out.topPilots[0].flights, 3);
});

ok('somebody who stopped flying drops out of a 30-day window', () => {
    const out = I.build({
        pireps: [flight({ memberId: 'm1', flownAt: daysAgo(200) }), flight({ memberId: 'm2', flownAt: daysAgo(3) })],
        members: MEMBERS, days: 30, now: NOW,
    });
    assert.deepStrictEqual(out.topPilots.map((p) => p.memberId), ['m2']);
});

ok('…and is still there over all time', () => {
    const out = I.build({
        pireps: [flight({ memberId: 'm1', flownAt: daysAgo(200) }), flight({ memberId: 'm2', flownAt: daysAgo(3) })],
        members: MEMBERS, days: 0, now: NOW,
    });
    assert.strictEqual(out.topPilots.length, 2);
});

ok('a report with no roster link is not attributed to anybody', () => {
    const out = I.build({ pireps: [flight({ memberId: null })], members: MEMBERS, now: NOW });
    assert.strictEqual(out.topPilots.length, 0);
    assert.strictEqual(out.totals.flights, 1);          // still a flight
});

ok('a pilot removed from the roster is named as such, not dropped', () => {
    const out = I.build({ pireps: [flight({ memberId: 'gone' })], members: MEMBERS, now: NOW });
    assert.strictEqual(out.topPilots[0].onRoster, false);
    assert.match(out.topPilots[0].name, /no longer on the roster/);
});

/* ------------------------------------------------------------------ */
head('Busiest airports');

ok('departures and arrivals add up to movements', () => {
    const out = I.build({
        pireps: [flight({ origin: 'EGLL', destination: 'LFPG' }), flight({ origin: 'LFPG', destination: 'EGLL' })],
        members: MEMBERS, now: NOW,
    });
    const egll = out.topAirports.find((a) => a.icao === 'EGLL');
    assert.deepStrictEqual([egll.departures, egll.arrivals, egll.movements], [1, 1, 2]);
});

/* ------------------------------------------------------------------ */
head('Aircraft');

ok('the most flown type leads', () => {
    const out = I.build({
        pireps: [flight({ aircraftName: 'A320' }), flight({ aircraftName: 'A320' }), flight({ aircraftName: 'B738' })],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.topAircraft[0].aircraft, 'A320');
    assert.strictEqual(out.topAircraft[0].flights, 2);
});

ok('a report with no aircraft named is skipped rather than blank-keyed', () => {
    const out = I.build({ pireps: [flight({ aircraftName: '' })], members: MEMBERS, now: NOW });
    assert.strictEqual(out.topAircraft.length, 0);
});

/* ------------------------------------------------------------------ */
head('Activity by month');

ok('twelve buckets, oldest first', () => {
    const out = I.build({ pireps: [flight({})], members: MEMBERS, now: NOW });
    assert.strictEqual(out.monthly.length, 12);
    assert.strictEqual(out.monthly[11].month, '2026-07');
});

ok('a quiet month is reported as zero, not omitted', () => {
    const out = I.build({
        pireps: [flight({ flownAt: daysAgo(1) }), flight({ flownAt: daysAgo(70) })],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.monthly.length, 12);
    assert.ok(out.monthly.some((m) => m.flights === 0), 'expected at least one empty month');
});

ok('the monthly chart is all-time, not clipped to the window', () => {
    const out = I.build({ pireps: [flight({ flownAt: daysAgo(200) })], members: MEMBERS, days: 30, now: NOW });
    assert.strictEqual(out.monthly.reduce((s, m) => s + m.flights, 0), 1);
});

/* ------------------------------------------------------------------ */
head('Which routes nobody flies');

ok('an unflown published route is found and named', () => {
    const out = I.build({
        pireps: [flight({ origin: 'EGLL', destination: 'KJFK' })],
        routes: [
            { origin: 'EGLL', destination: 'KJFK', active: true },
            { origin: 'EGLL', destination: 'YSSY', active: true, flightNumber: 'BA15' },
        ],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.coverage.neverFlown, 1);
    assert.strictEqual(out.coverage.examples[0].destination, 'YSSY');
    assert.strictEqual(out.coverage.examples[0].flightNumber, 'BA15');
});

ok('a retired route is not counted against coverage', () => {
    const out = I.build({
        pireps: [], routes: [{ origin: 'EGLL', destination: 'YSSY', active: false }],
        members: MEMBERS, now: NOW,
    });
    assert.strictEqual(out.coverage.routes, 0);
});

ok('coverage is all-time even on a 30-day window', () => {
    // Flown once, two years ago: the route is not "never flown".
    const out = I.build({
        pireps: [flight({ origin: 'EGLL', destination: 'YSSY', flownAt: daysAgo(700) })],
        routes: [{ origin: 'EGLL', destination: 'YSSY', active: true }],
        members: MEMBERS, days: 30, now: NOW,
    });
    assert.strictEqual(out.coverage.neverFlown, 0);
});

/* ------------------------------------------------------------------ */
head('Crew activity, from the noticeboard');

ok('generated rows are counted by kind', () => {
    const out = I.build({
        pireps: [], members: MEMBERS, now: NOW,
        notices: [
            { kind: 'join', auto: true, createdAt: daysAgo(2) },
            { kind: 'join', auto: true, createdAt: daysAgo(3) },
            { kind: 'promotion', auto: true, createdAt: daysAgo(4) },
        ],
    });
    assert.strictEqual(out.crew.joins, 2);
    assert.strictEqual(out.crew.promotions, 1);
});

ok('a notice a human wrote is not counted as an event', () => {
    const out = I.build({
        pireps: [], members: MEMBERS, now: NOW,
        notices: [{ kind: 'join', auto: false, createdAt: daysAgo(2) }],
    });
    assert.strictEqual(out.crew.joins, 0);
});

ok('rows older than the window are excluded', () => {
    const out = I.build({
        pireps: [], members: MEMBERS, now: NOW,
        notices: [{ kind: 'join', auto: true, createdAt: daysAgo(90) }],
    });
    assert.strictEqual(out.crew.joins, 0);
});

/* ------------------------------------------------------------------ */
head('Degenerate input');

ok('an airline with nothing in it does not throw', () => {
    const out = I.build({ now: NOW });
    assert.strictEqual(out.totals.flights, 0);
    assert.deepStrictEqual(out.topRoutes, []);
    assert.strictEqual(out.monthly.length, 12);
    assert.strictEqual(out.coverage.neverFlown, 0);
});

ok('a flight with an unparseable date does not poison the buckets', () => {
    const out = I.build({ pireps: [flight({ flownAt: 'not a date' })], members: MEMBERS, days: 0, now: NOW });
    assert.strictEqual(out.monthly.reduce((s, m) => s + m.flights, 0), 0);
    assert.strictEqual(out.totals.flightsAllTime, 1);
});

console.log(`\n${process.exitCode ? 'FAILURES above. ' : ''}${pass} checks passed.`);

'use strict';
// Conformance test for crewEvents — events, and the gate board.
//
// The checks here are the ones that would either put two aircraft on the same
// stand, publish something to a VA's public calendar that staff had not
// finished writing, or state a figure nobody counted:
//
//   * an event with a junk status becomes a DRAFT, never published — a
//     misspelt field must not reach strangers
//   * the board's airport falls back origin → destination, and a VA's explicit
//     choice always wins (a fly-in parks at the arrival field)
//   * a claimed stand is marked taken, by name, whatever the case it was typed
//     in — the index is on upper(gate) and the board has to agree with it
//   * a stand OpenStreetMap has never heard of still appears when somebody
//     holds it, rather than being silently offered to the next pilot
//   * attendance is null, not 0, when nobody counted it
//   * the waitlist fills past the cap and drains oldest-first
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const E = require(path.join('..', 'crewEvents.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const OK = (label, cond, note) => {
    if (cond) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, note ? `\n      ${note}` : '');
};

console.log('• what a submitted event is allowed to say');
const clean = E.sanitizeEvent({
    title: '  Águila Transatlántica  ',
    origin: 'mmmx', destination: ' lemd ',
    startsAt: '2026-08-15T19:00:00Z',
    slots: '40',
    bannerUrl: 'https://cdn.example.com/aguila.png',
});
T('titles are trimmed', clean.title, 'Águila Transatlántica');
T('ICAOs are normalised', [clean.origin, clean.destination], ['MMMX', 'LEMD']);
T('slots arrive as a number', clean.slots, 40);
OK('dates become Dates', clean.startsAt instanceof Date);
T('an https banner is kept', clean.bannerUrl, 'https://cdn.example.com/aguila.png');

T('a plain-http banner is dropped, not rendered',
    E.sanitizeEvent({ bannerUrl: 'http://cdn.example.com/x.png' }).bannerUrl, '');
T('…and so is a javascript: one',
    E.sanitizeEvent({ bannerUrl: 'javascript:alert(1)' }).bannerUrl, '');

T('an event starts as a draft', E.sanitizeEvent({}).status, 'draft');
T('an unrecognised status falls to draft, NEVER published',
    E.sanitizeEvent({ status: 'pubished' }).status, 'draft');
T('…and a real one is honoured', E.sanitizeEvent({ status: 'published' }).status, 'published');
T('gates are open unless a VA says otherwise', E.sanitizeEvent({}).gatesOpen, true);
T('…and can be turned off', E.sanitizeEvent({ gatesOpen: false }).gatesOpen, false);
T('a nonsense date is no date rather than an Invalid Date',
    E.sanitizeEvent({ startsAt: 'sometime next Tuesday' }).startsAt, null);
T('slots cannot go negative', E.sanitizeEvent({ slots: -12 }).slots, 0);

console.log('• which airport the board covers');
T('a group departure parks at the origin',
    E.gateAirport({ origin: 'MMMX', destination: 'LEMD' }), 'MMMX');
T('a fly-in parks where the VA says',
    E.gateAirport({ origin: 'MMMX', destination: 'LEMD', gateIcao: 'LEMD' }), 'LEMD');
T('an arrivals-only event still has a board',
    E.gateAirport({ origin: '', destination: 'MMMX' }), 'MMMX');
T('and an event with no airports has none', E.gateAirport({}), '');

console.log('• the gate board');
const osmGates = [
    { ref: 'B24', lat: 19.43, lon: -99.07, kind: 'gate' },
    { ref: 'B25', lat: 19.44, lon: -99.08, kind: 'gate' },
    { ref: 'R12', lat: 19.45, lon: -99.09, kind: 'parking_position' },
];
const board = E.buildGateBoard(osmGates, [
    // Typed lower case on purpose: the unique index is on upper(gate), and a
    // board that did not fold case would show this stand as free.
    { _id: 's1', gate: 'b24', pilotName: 'Antony', callsign: 'AMX101', aircraft: 'B789', status: 'going' },
    // A stand OSM does not carry — a new pier, or the VA's own numbering.
    { _id: 's2', gate: 'T7', gateLat: 19.5, gateLon: -99.1, gateKind: 'stand', pilotName: 'Sam', callsign: 'AMX204', status: 'going' },
]);
const at = (ref) => board.find((g) => g.ref.toUpperCase() === ref);
T('a claimed stand is taken, and names who has it',
    [at('B24').taken, at('B24').takenBy, at('B24').takenByAircraft], [true, 'Antony', 'B789']);
T('case is not a way around the claim', at('B24').taken, true);
T('an unclaimed stand stays free', [at('B25').taken, at('B25').takenBy], [false, '']);
T('a free stand keeps its position so the map can draw it',
    [at('B25').lat, at('B25').lon], [19.44, -99.08]);
OK('a stand OSM has never heard of is still on the board',
    !!at('T7') && at('T7').taken && at('T7').unmapped === true,
    'a held stand that is missing from the board would be handed to somebody else');
T('…and carries the position the pilot picked it at', [at('T7').lat, at('T7').lon], [19.5, -99.1]);
T('nothing else is invented', board.length, 4);

const emptyBoard = E.buildGateBoard(osmGates, []);
OK('with nobody signed up, every stand is free', emptyBoard.every((g) => !g.taken));
T('a board with no OSM data is still the claimed stands',
    E.buildGateBoard([], [{ _id: 's1', gate: 'A1', pilotName: 'Jo', status: 'going' }]).map((g) => g.ref), ['A1']);

console.log('• what an event says to the world');
const raw = {
    _id: 'ev1', title: 'Transcon', origin: 'CYYZ', destination: 'KLAX',
    slots: 3, minRank: '', status: 'published', gatesOpen: true, gatesLocked: false,
};
const uncounted = E.publicEvent(raw, {});
T('attendance is null when nobody counted it — never 0',
    [uncounted.going, uncounted.waitlisted, uncounted.seatsLeft], [null, null, null]);
T('…and the event is not claimed to be full either', uncounted.full, false);

const counted = E.publicEvent(raw, {
    signups: [
        { status: 'going' }, { status: 'going' },
        { status: 'waitlist' },
    ],
});
T('going counts only those who are going', counted.going, 2);
T('the waitlist is counted apart', counted.waitlisted, 1);
T('seats left comes off the cap', counted.seatsLeft, 1);
T('and it is not full yet', counted.full, false);

const fullEvent = E.publicEvent(raw, { signups: [{ status: 'going' }, { status: 'going' }, { status: 'going' }] });
T('a full event says so', [fullEvent.full, fullEvent.seatsLeft], [true, 0]);

console.log('• rank gating works the way a locked route does');
const LADDER = [{ name: 'Cadet', minHours: 0 }, { name: 'Captain', minHours: 300 }];
const meetsRank = (ranks, hours, name) => {
    const rung = (ranks || []).find((r) => r.name === name);
    return !rung || hours >= rung.minHours;
};
const gated = { ...raw, minRank: 'Captain' };
T('a pilot below the bar sees it locked, not hidden',
    E.publicEvent(gated, { ranks: LADDER, viewer: { hours: 42 }, meetsRank }).locked, true);
T('a pilot above it sees it open',
    E.publicEvent(gated, { ranks: LADDER, viewer: { hours: 400 }, meetsRank }).locked, false);
T('staff and the public are never marked locked',
    E.publicEvent(gated, { ranks: LADDER, viewer: null, meetsRank }).locked, false);
T('a gate on a rank that no longer exists lapses open',
    E.publicEvent({ ...raw, minRank: 'Flight Engineer' }, { ranks: LADDER, viewer: { hours: 0 }, meetsRank }).locked, false);

console.log('• the waitlist');
const capped = { slots: 2 };
T('under the cap you are simply going', E.isWaitlisted(capped, [{ status: 'going' }]), false);
T('at the cap the next pilot waits', E.isWaitlisted(capped, [{ status: 'going' }, { status: 'going' }]), true);
T('an uncapped event never waitlists anyone',
    E.isWaitlisted({ slots: 0 }, Array.from({ length: 500 }, () => ({ status: 'going' }))), false);
T('people already waiting do not count toward the cap',
    E.isWaitlisted(capped, [{ status: 'going' }, { status: 'waitlist' }]), false);

const queue = [
    { _id: 'g1', status: 'going', createdAt: '2026-07-01T00:00:00Z' },
    { _id: 'w2', status: 'waitlist', createdAt: '2026-07-03T00:00:00Z' },
    { _id: 'w1', status: 'waitlist', createdAt: '2026-07-02T00:00:00Z' },
];
T('the seat goes to whoever has waited longest', E.nextOffWaitlist(capped, queue)._id, 'w1');
T('nobody is promoted while the event is still full',
    E.nextOffWaitlist({ slots: 1 }, queue), null);
T('an uncapped event has no waitlist to drain', E.nextOffWaitlist({ slots: 0 }, queue), null);

console.log('• what a pilot may change about their own place');
const own = E.sanitizeSignupPatch({ pilotName: 'Somebody Else', status: 'going', gate: 'c7', aircraft: 'B789' });
OK('a pilot cannot rename themselves', own.pilotName === undefined,
    'the name is their roster row’s, not a free-text field on the board');
OK('…nor promote themselves off the waitlist', own.status === undefined,
    'waitlist position is the event’s cap talking, not a preference');
T('a stand is upper-cased to match the index', own.gate, 'C7');
T('and the aircraft goes through', own.aircraft, 'B789');

const byStaff = E.sanitizeSignupPatch({ pilotName: 'Guest Pilot', status: 'waitlist' }, { allowIdentity: true });
T('staff may name a guest and set their position',
    [byStaff.pilotName, byStaff.status], ['Guest Pilot', 'waitlist']);

const cleared = E.sanitizeSignupPatch({ gate: '', gateLat: 19.4, gateLon: -99.1 });
T('giving up a stand gives up its position too',
    [cleared.gate, cleared.gateLat, cleared.gateLon], ['', null, null]);

console.log('• reading OpenStreetMap');
const parsed = E.parseOverpassGates([
    { type: 'node', lat: 1, lon: 2, tags: { aeroway: 'gate', ref: 'A1' } },
    // A polygon stand: `out center` is what gives it a point to pin.
    { type: 'way', center: { lat: 3, lon: 4 }, tags: { aeroway: 'stand', ref: 'A2' } },
    // Same ref twice — the real gate node must win over the parking position,
    // whichever order Overpass returns them in.
    { type: 'node', lat: 9, lon: 9, tags: { aeroway: 'parking_position', ref: 'A1' } },
    // No ref, no marker: this would otherwise pin every nameless apron.
    { type: 'way', center: { lat: 5, lon: 6 }, tags: { aeroway: 'apron' } },
    // No position at all.
    { type: 'node', tags: { aeroway: 'gate', ref: 'A9' } },
]);
T('only referenced, placeable stands survive', parsed.map((g) => g.ref).sort(), ['A1', 'A2']);
T('a way is placed at its centre', parsed.find((g) => g.ref === 'A2').lat, 3);
T('a real gate beats a parking position of the same name',
    parsed.find((g) => g.ref === 'A1').kind, 'gate');

const q = E.gateQuery('MMMX', [19.436, -99.07]);
OK('with coordinates, the query searches around them', q.includes('around:7000,19.436,-99.07'));
const q2 = E.gateQuery('MMXX', null);
OK('without them, it finds the aerodrome by ICAO first',
    q2.includes('"icao"="MMXX"') && q2.includes('around.apt:7000'),
    'a field the coordinate set has never heard of must still get a board');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll crew events checks passed ✅');
process.exit(failures ? 1 : 0);

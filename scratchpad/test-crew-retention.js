'use strict';
// Conformance test for crewRetention — the rules that decide who is still on
// the roster.
//
// This is the one module in the crew center whose output DELETES PEOPLE, so the
// cases here are weighted towards the ways it could take somebody it should
// not:
//
//   * off is off. A VA that has never touched these settings sweeps nobody,
//     however old their roster is
//   * a pilot on leave of absence is never swept — that is what the status is
//     for, and removing somebody for being away is the outcome it exists to
//     prevent
//   * a pilot already marked inactive is not then removed on the next run:
//     "mark inactive" must not quietly become "delete" six hours later
//   * staff are exempt while the VA leaves exemptStaff on
//   * only APPROVED flight reports stop a clock — a pending one is a claim
//     nobody has checked, and letting it count would let a pilot hold their
//     place by filing something and never being reviewed
//   * a flight captured automatically against an IF user id counts, even when
//     the report is not linked to the member row
//   * probation and inactivity are exclusive: a pilot who has never flown is on
//     probation, not "inactive", and is counted once
//   * a warning fires once per silence, and again after the pilot flies and
//     goes quiet a second time — the anchor comparison, which is the subtlest
//     thing in the file
//   * a member with no join date is left alone rather than swept on a null
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const R = require(path.join('..', 'crewRetention.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-06-01T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const member = (o = {}) => ({
    _id: o.id || 'm1', id: o.id || 'm1', name: o.name || 'Rae Okafor', callsign: 'TVA101',
    status: o.status || 'active', role: o.role || '', hours: o.hours || 0,
    ifUserId: o.ifUserId || '', retentionWarnedAt: o.retentionWarnedAt || null,
    createdAt: o.createdAt !== undefined ? o.createdAt : ago(30),
});
const pirep = (o = {}) => ({
    memberId: o.memberId || null, ifUserId: o.ifUserId || '',
    status: o.status || 'approved', flownAt: o.flownAt || ago(1),
});

// Both rules on, with the numbers the request asked for.
const ON = {
    enabled: true,
    firstFlight: true, firstFlightDays: 7, firstFlightAction: 'remove', firstFlightWarnDays: 2,
    inactivity: true, inactivityDays: 30, inactivityAction: 'inactive', inactivityWarnDays: 7,
};
const names = (list) => list.map((x) => x.member.name);
const run = (members, pireps, rules = ON) => R.assess({ members, pireps, rules, now: NOW });

console.log('\ncrewRetention — the defaults are inert');

const off = R.normalizeRules(undefined);
T('a VA who has never opened these settings has it off', off.enabled, false);
T('…and both rules off inside that', [off.firstFlight, off.inactivity], [false, false]);
T('off means nobody is even looked at',
    run([member({ createdAt: ago(400) })], [], {}).checked, 0);
// The request: 7 days to a first flight, 30 days of silence after that.
T('the shipped windows are 7 and 30', [off.firstFlightDays, off.inactivityDays], [7, 30]);
T('a never-flown account is removed; an established pilot is only marked',
    [off.firstFlightAction, off.inactivityAction], ['remove', 'inactive']);
T('staff are exempt unless the VA says otherwise', off.exemptStaff, true);

console.log('\nbounds');
const clamped = R.normalizeRules({ firstFlightDays: 900, inactivityDays: 1, firstFlightWarnDays: -5, inactivityAction: 'explode' });
T('a first-flight window is capped at 90 days', clamped.firstFlightDays, 90);
T('an inactivity window has a 7-day floor', clamped.inactivityDays, 7);
T('a negative warning becomes no warning', clamped.firstFlightWarnDays, 0);
T('an unknown action falls back, it does not throw', clamped.inactivityAction, 'inactive');

console.log('\nprobation — the first flight');

T('a recruit inside the window is left alone',
    names(run([member({ createdAt: ago(3) })], []).probationDue), []);
T('…and is warned when the deadline is near',
    names(run([member({ createdAt: ago(6) })], []).probationWarn), ['Rae Okafor']);
T('a recruit past the window is due',
    names(run([member({ createdAt: ago(8) })], []).probationDue), ['Rae Okafor']);
T('…and the action is the VA’s choice, carried through',
    run([member({ createdAt: ago(8) })], []).probationDue[0].action, 'remove');
T('one logged flight is all it takes',
    names(run([member({ createdAt: ago(8) })], [pirep({ memberId: 'm1', flownAt: ago(2) })]).probationDue), []);

// The rule the request is actually about: no check-ride, no sign-off, no staff
// action. A flight arrives and the pilot is safe.
T('a flight captured against the IF id counts, unlinked report or not',
    names(run([member({ createdAt: ago(8), ifUserId: 'if-99' })], [pirep({ ifUserId: 'if-99', flownAt: ago(2) })]).probationDue), []);
T('a PENDING report does not stop the clock',
    names(run([member({ createdAt: ago(8) })], [pirep({ memberId: 'm1', status: 'pending' })]).probationDue), ['Rae Okafor']);
T('a rejected report does not either',
    names(run([member({ createdAt: ago(8) })], [pirep({ memberId: 'm1', status: 'rejected' })]).probationDue), ['Rae Okafor']);
T('somebody else’s flight does not save them',
    names(run([member({ createdAt: ago(8) })], [pirep({ memberId: 'm2' })]).probationDue), ['Rae Okafor']);
T('a member with no join date is left alone rather than swept on a null',
    names(run([member({ createdAt: null })], []).probationDue), []);

console.log('\ninactivity — the long silence');

const flew = (days) => [pirep({ memberId: 'm1', flownAt: ago(days) })];
T('a pilot who flew last week is fine',
    names(run([member()], flew(7)).inactivityDue), []);
T('…is warned as 30 days approaches',
    names(run([member()], flew(24)).inactivityWarn), ['Rae Okafor']);
T('…and is due once 30 days pass',
    names(run([member()], flew(31)).inactivityDue), ['Rae Okafor']);
T('the default action marks rather than removes',
    run([member()], flew(31)).inactivityDue[0].action, 'inactive');
T('a VA that wants removal gets removal',
    run([member()], flew(31), { ...ON, inactivityAction: 'remove' }).inactivityDue[0].action, 'remove');
T('the most recent flight is the one that counts',
    names(run([member()], [pirep({ memberId: 'm1', flownAt: ago(100) }), pirep({ memberId: 'm1', flownAt: ago(2) })]).inactivityDue), []);

console.log('\nthe two rules do not overlap');

// A pilot who has never flown and joined 40 days ago is ON PROBATION. Counting
// them as inactive as well would remove them under one rule and mark them under
// the other, in the same pass.
const neverFlown = run([member({ createdAt: ago(40) })], []);
T('a never-flown recruit is on probation, not inactive',
    [names(neverFlown.probationDue), names(neverFlown.inactivityDue)], [['Rae Okafor'], []]);
T('…and is counted exactly once', neverFlown.checked, 1);

console.log('\nwho is never swept');

T('a pilot on leave of absence is exempt',
    names(run([member({ status: 'loa', createdAt: ago(400) })], []).probationDue), []);
T('…and is reported as exempt, not silently dropped',
    run([member({ status: 'loa' })], []).exempt[0].reason, 'loa');
T('a pilot already inactive is not then removed',
    names(run([member({ status: 'inactive', createdAt: ago(400) })], [], { ...ON, firstFlightAction: 'remove' }).probationDue), []);
T('staff are exempt while exemptStaff is on',
    names(run([member({ role: 'Director of Events', createdAt: ago(400) })], []).probationDue), []);
T('…and are swept when a VA turns that off',
    names(run([member({ role: 'Director of Events', createdAt: ago(400) })], [], { ...ON, exemptStaff: false }).probationDue), ['Rae Okafor']);
T('an empty role is a pilot, not staff', R.isStaff(member({ role: '' })), false);

console.log('\nwarnings fire once per silence');

// Warned yesterday, last flew 24 days ago: the warning is newer than the
// anchor, so this cycle has already been announced.
T('a pilot warned this cycle is not warned again',
    names(run([member({ retentionWarnedAt: ago(1) })], flew(24)).inactivityWarn), []);
// Warned 40 days ago, then flew 24 days ago, now quiet again: the warning
// predates the anchor, so it belonged to a cycle that ended when they flew.
T('…but is warned afresh after flying and going quiet again',
    names(run([member({ retentionWarnedAt: ago(40) })], flew(24)).inactivityWarn), ['Rae Okafor']);
T('a warning never blocks the deadline itself',
    names(run([member({ retentionWarnedAt: ago(1) })], flew(31)).inactivityDue), ['Rae Okafor']);
T('warnings can be switched off without switching the rule off',
    names(run([member()], flew(24), { ...ON, inactivityWarnDays: 0 }).inactivityWarn), []);

console.log('\none rule at a time');

T('probation alone leaves the quiet veteran alone',
    names(run([member()], flew(90), { ...ON, inactivity: false }).inactivityDue), []);
T('inactivity alone leaves the new recruit alone',
    names(run([member({ createdAt: ago(20) })], [], { ...ON, firstFlight: false }).probationDue), []);

console.log('\nsummaries');
T('a sweep that did nothing says so', R.summarize(run([member()], flew(1))), '1 checked');
T('a sweep that did something itemises it',
    R.summarize(run([member({ createdAt: ago(8) })], [])), '1 checked · 1 due (first flight)');

console.log(failures ? `\n${failures} failed.\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

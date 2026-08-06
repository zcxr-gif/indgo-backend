'use strict';
// Conformance test for crewInbox — who a message reaches, and what it says.
//
// An inbox send is the first thing in the crew center that writes one row per
// pilot, so the cases checked here are the ones that would either miss the pilot
// the message was for or tell the wrong people:
//
//   * 'active' (the default) leaves out pilots on declared leave — messaging
//     somebody on LOA about signing up for Thursday is the noise they asked not
//     to get — while 'all' deliberately includes them
//   * 'rank' means AT OR ABOVE the rung, which is the audience Discord cannot
//     express and the reason this exists
//   * a pilot with no account yet is still a recipient: the row is addressed by
//     member_id and found when they first sign in, and dropping it would lose
//     the message for exactly the pilot it was most for
//   * staff may only send 'message' — a hand-written 'promotion' would be
//     indistinguishable from a real one, and a forgeable inbox is not a record
//   * a repeated automatic send is deduped by recipient + kind + ref + subject,
//     so approving twice on a slow connection does not tell a pilot twice
//   * duplicates WITHIN one send are dropped too (a repeated memberId)
//   * the unread badge counts unread only, and caps at 99
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const I = require(path.join('..', 'crewInbox.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const ranks = [
    { name: 'Cadet', minHours: 0 },
    { name: 'First Officer', minHours: 25 },
    { name: 'Captain', minHours: 100 },
];

// A roster with every case on it: a Captain, a mid-rung pilot, a newcomer with
// no login yet, somebody on leave and somebody gone quiet.
const roster = [
    { _id: 'm1', name: 'Cap',      hours: 140, status: 'active',   accountId: 'a1' },
    { _id: 'm2', name: 'Fo',       hours: 60,  status: 'active',   accountId: 'a2' },
    { _id: 'm3', name: 'Newcomer', hours: 0,   status: 'active',   accountId: null },
    { _id: 'm4', name: 'Away',     hours: 200, status: 'loa',      accountId: 'a4' },
    { _id: 'm5', name: 'Quiet',    hours: 30,  status: 'inactive', accountId: 'a5' },
];
const names = (list) => list.map((m) => m.name);

console.log('\ncrewInbox — who it reaches');

T('active is the default, and leaves out LOA and inactive',
    names(I.resolveAudience(roster, {}, ranks)), ['Cap', 'Fo', 'Newcomer']);
T('active, asked for explicitly',
    names(I.resolveAudience(roster, { audience: 'active' }, ranks)), ['Cap', 'Fo', 'Newcomer']);
T('all includes the pilot on leave and the quiet one',
    names(I.resolveAudience(roster, { audience: 'all' }, ranks)),
    ['Cap', 'Fo', 'Newcomer', 'Away', 'Quiet']);

T('rank means at or above the rung',
    names(I.resolveAudience(roster, { audience: 'rank', minRank: 'Captain' }, ranks)), ['Cap', 'Away']);
T('a lower rung catches more of the roster',
    names(I.resolveAudience(roster, { audience: 'rank', minRank: 'First Officer' }, ranks)),
    ['Cap', 'Fo', 'Away', 'Quiet']);
T('the entry rung catches everybody',
    names(I.resolveAudience(roster, { audience: 'rank', minRank: 'Cadet' }, ranks)).length, 5);

T('member picks exactly the pilots named',
    names(I.resolveAudience(roster, { audience: 'member', memberIds: ['m2', 'm5'] }, ranks)), ['Fo', 'Quiet']);
T('an unknown member id matches nobody rather than everybody',
    I.resolveAudience(roster, { audience: 'member', memberIds: ['nope'] }, ranks), []);
T('an empty roster is not an error',
    I.resolveAudience([], { audience: 'all' }, ranks), []);

console.log('\ncrewInbox — the rows written');

const rows = I.rowsFor(roster, { title: 'New fuel policy', body: 'Read it.', senderName: 'Ops' },
    { audience: 'active' }, ranks);

T('one row per recipient', rows.length, 3);
T('each carries both ids we know the pilot by',
    rows.map((r) => [r.memberId, r.accountId]),
    [['m1', 'a1'], ['m2', 'a2'], ['m3', null]]);
T('the pilot with no login yet is still written to',
    rows.some((r) => r.memberId === 'm3' && r.accountId === null), true);
T('the message itself is on every row',
    rows.every((r) => r.title === 'New fuel policy' && r.senderName === 'Ops'), true);

console.log('\ncrewInbox — what staff may claim to be sending');

T('staff sending a plain message is fine',
    I.normalizeMessage({ title: 'T', kind: 'message' }, { allowKinds: I.STAFF_KINDS }).kind, 'message');
T('staff cannot hand-post a promotion',
    I.normalizeMessage({ title: 'T', kind: 'promotion' }, { allowKinds: I.STAFF_KINDS }).kind, 'message');
T('the crew center itself may write one',
    I.normalizeMessage({ title: 'T', kind: 'promotion' }).kind, 'promotion');
T('an unrecognised kind falls back rather than being stored',
    I.normalizeMessage({ title: 'T', kind: 'telepathy' }).kind, 'message');
T('an empty refId is stored as null, not as a blank uuid',
    I.normalizeMessage({ title: 'T', refId: '' }).refId, null);

console.log('\ncrewInbox — refusing a send that cannot go');

T('no subject',            !!I.sendProblem({ audience: 'all', title: '' }), true);
T('no audience',           !!I.sendProblem({ audience: '', title: 'T' }), true);
T('a rank send with no rank', !!I.sendProblem({ audience: 'rank', title: 'T', minRank: '' }), true);
T('a member send with nobody picked', !!I.sendProblem({ audience: 'member', title: 'T', memberIds: [] }), true);
T('a complete send is allowed',
    I.sendProblem({ audience: 'rank', title: 'T', minRank: 'Captain' }), '');

console.log('\ncrewInbox — telling a pilot once');

const promo = { accountId: 'a1', memberId: 'm1', kind: 'promotion', refId: null, title: 'You made Captain' };

T('the same promotion twice is written once',
    I.withoutDuplicates([promo], [promo]).length, 0);
T('a different pilot is not a duplicate',
    I.withoutDuplicates([{ ...promo, accountId: 'a2', memberId: 'm2' }], [promo]).length, 1);
T('a different subject is not a duplicate',
    I.withoutDuplicates([{ ...promo, title: 'You made Senior Captain' }], [promo]).length, 1);
T('the same subject about a DIFFERENT thing is not a duplicate',
    I.withoutDuplicates([{ ...promo, kind: 'booking', refId: 'sch1', title: 'You are on Thursday' },
                         { ...promo, kind: 'booking', refId: 'sch2', title: 'You are on Thursday' }], []).length, 2);
T('a repeat within one send is dropped too',
    I.withoutDuplicates([promo, promo], []).length, 1);
T('case is not a way round the dedupe',
    I.withoutDuplicates([{ ...promo, title: 'you made captain' }], [promo]).length, 0);
T('nothing already sent means everything goes',
    I.withoutDuplicates([promo], []).length, 1);

console.log('\ncrewInbox — the badge');

const inbox = [
    { readAt: null, createdAt: '2026-08-01T10:00:00Z', title: 'Older unread' },
    { readAt: '2026-08-02T10:00:00Z', createdAt: '2026-08-02T09:00:00Z', title: 'Read' },
    { readAt: null, createdAt: '2026-08-03T10:00:00Z', title: 'Newest unread' },
];

T('unread is counted, read is not',
    (() => { const s = I.unreadSummary(inbox); return [s.total, s.unread]; })(), [3, 2]);
T('the latest unread is found whatever order the list arrived in',
    I.unreadSummary(inbox).latest.title, 'Newest unread');
T('an all-read inbox has no latest',
    I.unreadSummary([{ readAt: 'x', createdAt: 'y' }]).latest, null);
T('an empty inbox is zero, not a crash',
    (() => { const s = I.unreadSummary([]); return [s.total, s.unread, s.badge, s.latest]; })(), [0, 0, 0, null]);
T('the badge caps at 99',
    I.unreadSummary(Array.from({ length: 250 }, () => ({ readAt: null, createdAt: '2026-08-01T10:00:00Z' }))).badge, 99);

console.log(failures ? `\n${failures} failed ❌\n` : '\nAll good ✅\n');
process.exit(failures ? 1 : 0);

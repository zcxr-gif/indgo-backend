'use strict';
// Conformance test for the crew center's staff permissions.
//
// This is the thing that decides what a VA's staff can do to a VA's airline, so
// the cases checked here are the ones where getting it wrong either hands
// somebody a power their owner did not grant, or silently takes one away:
//
//   * an owner and Inflight oversight hold everything, always
//   * a pilot holds nothing, whatever roles happen to exist
//   * a staff member with a role holds THAT ROLE and nothing else
//   * a staff member with NO role keeps full access — the deliberate
//     non-breaking default, and the reason "see everything, change nothing" has
//     to be an Observer role with nothing ticked rather than the absence of one
//   * an assignment pointing at a role that has been deleted grants NOTHING,
//     rather than falling back to the unassigned default and quietly promoting
//     somebody the owner had just restricted
//   * a capability split in two does not downgrade the roles that already held
//     the original (announcements.manage out of roster.manage)
//   * every preset names capabilities that actually exist, and none of them
//     quietly grants the lot
//
// Pure module test — no network, no database. mongoose is stubbed because
// crewAuth pulls it in at require time for its models.

const path = require('path');
const Module = require('module');

// crewAuth requires mongoose (and, through crewStore, axios) at load time but
// nothing under test touches either. Stub the resolver rather than installing
// a database driver to read a pure function.
const realResolve = Module._resolveFilename;
const STUBS = {
    mongoose: { model: () => ({}), models: {}, Schema: function Schema() {} },
};
Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return request;
    return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return realLoad.call(this, request, ...rest);
};

const A = require(path.join('..', 'crewAuth.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const has = (caps, id) => caps.includes(id);

// A VA with two roles and two people in them.
const VA = {
    staffRoles: [
        { id: 'r-pirep', name: 'PIREP manager', permissions: ['flights.review'] },
        { id: 'r-roster', name: 'Roster manager', permissions: ['roster.manage'] },
        { id: 'r-none', name: 'Observer', permissions: [] },
    ],
    staffAssignments: [
        { username: 'jo', roleId: 'r-pirep' },
        { username: 'sam', roleId: 'r-roster' },
        { username: 'obs', roleId: 'r-none' },
        { username: 'ghost', roleId: 'r-deleted' },
    ],
};

const staff = (uname) => ({ kind: 'va', role: 'staff', uname });

console.log('\ncrewAuth — who holds what');

T('an owner holds everything',
    A.effectiveCaps(VA, { kind: 'va', role: 'owner', uname: 'boss' }).length, A.CREW_CAP_IDS.length);
T('Inflight oversight holds everything',
    A.effectiveCaps(VA, { kind: 'inflight', role: 'inflight', uname: 'staffer' }).length, A.CREW_CAP_IDS.length);
T('a pilot holds nothing',
    A.effectiveCaps(VA, { kind: 'crew', role: 'pilot', uname: 'rae' }), []);
T('nobody at all holds nothing', A.effectiveCaps(VA, null), []);

const jo = A.effectiveCaps(VA, staff('jo'));
T('a PIREP manager can review flights', has(jo, 'flights.review'), true);
T('…and cannot touch the roster', has(jo, 'roster.manage'), false);
T('…and cannot rebrand the crew center', has(jo, 'settings.branding'), false);
// The whole point of the split: reviewing flights is not permission to write to
// the crew in the airline's name.
T('…and cannot post to the noticeboard', has(jo, 'announcements.manage'), false);

// The deliberate non-breaking default. Turning the system on must not lock out
// a team the owner has not got round to assigning yet.
T('an unassigned staff member keeps full access',
    A.effectiveCaps(VA, staff('nobody-assigned')).length, A.CREW_CAP_IDS.length);
// …which is exactly why "watch and change nothing" needs a real empty role.
T('an Observer role holds nothing at all', A.effectiveCaps(VA, staff('obs')), []);
// An assignment left pointing at a deleted role must NOT fall through to the
// unassigned default — that would promote the person the owner had restricted.
T('an assignment to a role that no longer exists grants nothing',
    A.effectiveCaps(VA, staff('ghost')), []);

// Usernames are matched case-insensitively; a login is not case-sensitive and
// a role that stopped applying because somebody typed "Jo" would be a puzzle.
T('the assignment matches regardless of case',
    A.effectiveCaps(VA, staff('JO')), jo);

console.log('\ncrewAuth — splitting a capability in two');

// announcements.manage was carved out of roster.manage. A VA who ticked "add,
// edit & remove pilots" last month had also been given the noticeboard without
// being asked — and must not lose it overnight with nothing to explain it.
const sam = A.effectiveCaps(VA, staff('sam'));
T('a role holding the old capability keeps the new one',
    has(sam, 'announcements.manage'), true);
T('…and still holds the original', has(sam, 'roster.manage'), true);
// The inheritance is one-way. Being allowed to post notices is not a route into
// the roster.
T('the inheritance does not run backwards',
    has(A.effectiveCaps({
        staffRoles: [{ id: 'r', name: 'Comms', permissions: ['announcements.manage'] }],
        staffAssignments: [{ username: 'c', roleId: 'r' }],
    }, staff('c')), 'roster.manage'), false);
T('every heir is a real capability',
    Object.values(A.CAPABILITY_HEIRS).flat().every((c) => A.CREW_CAP_IDS.includes(c)), true);
T('every heir has a real ancestor',
    Object.keys(A.CAPABILITY_HEIRS).every((c) => A.CREW_CAP_IDS.includes(c)), true);

console.log('\ncrewAuth — a capability nobody defined');

// A role carrying a capability id this build has never heard of (an older
// deploy's, or a hand-edited document) must be ignored rather than trusted.
T('an unknown capability on a role is dropped',
    A.effectiveCaps({
        staffRoles: [{ id: 'r', name: 'Odd', permissions: ['flights.review', 'server.reboot'] }],
        staffAssignments: [{ username: 'x', roleId: 'r' }],
    }, staff('x')), ['flights.review']);

console.log('\ncrewAuth — the presets');

T('there are presets to offer', A.CREW_ROLE_PRESETS.length > 0, true);
T('every preset has a name and a description',
    A.CREW_ROLE_PRESETS.every((p) => p.name && p.description), true);
T('every preset id is unique',
    new Set(A.CREW_ROLE_PRESETS.map((p) => p.id)).size, A.CREW_ROLE_PRESETS.length);
// A preset naming a capability that does not exist would silently grant less
// than its description promises.
T('every preset names only real capabilities',
    A.CREW_ROLE_PRESETS.every((p) => (p.permissions || []).every((c) => A.CREW_CAP_IDS.includes(c))), true);
// Deliberately no "deputy owner" preset. An owner who wants to hand over
// everything can tick everything, having read each line.
T('no preset quietly grants everything',
    A.CREW_ROLE_PRESETS.every((p) => (p.permissions || []).length < A.CREW_CAP_IDS.length), true);
T('there is a preset that grants nothing, for watching',
    A.CREW_ROLE_PRESETS.some((p) => (p.permissions || []).length === 0), true);
T('the PIREP job is exactly flight review',
    (A.CREW_ROLE_PRESETS.find((p) => p.id === 'pirep-manager') || {}).permissions, ['flights.review']);

console.log('\ncrewAuth — the catalogue itself');

T('every capability id is unique',
    new Set(A.CREW_CAP_IDS).size, A.CREW_CAP_IDS.length);
T('every capability has a group and a label',
    A.CREW_CAPABILITIES.every((c) => c.id && c.group && c.label), true);
T('the noticeboard is its own capability',
    A.CREW_CAP_IDS.includes('announcements.manage'), true);
T('the partnership is its own capability',
    A.CREW_CAP_IDS.includes('partnership.view'), true);

Module._resolveFilename = realResolve;
Module._load = realLoad;

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

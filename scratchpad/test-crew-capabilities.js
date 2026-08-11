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
//   * a staff member with NO role keeps the day-to-day default — the
//     deliberate non-breaking rule, and the reason "see everything, change
//     nothing" has to be an Observer role with nothing ticked rather than the
//     absence of one — while the owner-grade powers stay out of it, so that
//     adding a row to the catalogue never grants one to everybody at once
//   * a delegate holding team.manage cannot use it to grant themselves more
//     than they hold, by editing a role OR by stepping into a richer one
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
    // crewAuth pulls these in at require time and crewStore adds axios. None is
    // touched by anything under test, and stubbing them means this file runs
    // without node_modules installed — which is the difference between a check
    // somebody runs and one they mean to.
    bcryptjs: { hashSync: () => '', compareSync: () => false, genSaltSync: () => '' },
    jsonwebtoken: { sign: () => '', verify: () => ({}) },
    axios: { get: async () => ({}), post: async () => ({}), create: () => ({}) },
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
//
// "Full" now means the day-to-day catalogue and not the owner-grade three. The
// default is a kindness to teams that predate the permission system; it is not
// a licence to disconnect the airline's Infinite Flight account, rewrite the
// team's permissions or start deleting pilots, and adding a row to a catalogue
// must never hand those to everybody at once.
T('an unassigned staff member keeps the day-to-day default',
    A.effectiveCaps(VA, staff('nobody-assigned')).length, A.CREW_DEFAULT_STAFF_CAPS.length);
T('…which is everything except the owner-grade powers',
    A.CREW_OWNER_GRADE_CAPS.some((c) => has(A.effectiveCaps(VA, staff('nobody-assigned')), c)), false);
T('…and still includes the ordinary jobs',
    has(A.effectiveCaps(VA, staff('nobody-assigned')), 'roster.manage'), true);
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
T('the owner-grade powers are all real capabilities',
    A.CREW_OWNER_GRADE_CAPS.every((c) => A.CREW_CAP_IDS.includes(c)), true);
T('no owner-grade power is in the unassigned default',
    A.CREW_OWNER_GRADE_CAPS.some((c) => A.CREW_DEFAULT_STAFF_CAPS.includes(c)), false);
T('the default and the owner-grade set account for the whole catalogue',
    A.CREW_DEFAULT_STAFF_CAPS.length + A.CREW_OWNER_GRADE_CAPS.length, A.CREW_CAP_IDS.length);

/* ===========================================================================
 * Delegating an owner-grade power
 *
 * team.manage lets somebody who is not the owner build the airline's roles and
 * decide who is in them. That is only safe because of one rule — you may grant
 * what you hold, and nothing else — and there are two ways through it, not one:
 *
 *   1. edit a role and tick a capability you do not hold
 *   2. leave the roles alone and assign yourself to a richer one
 *
 * The second is the one that is easy to miss, and the one that needs no
 * permission edit at all. Both are checked, along with the case that would make
 * the whole feature unusable if it were judged wrong: every save re-sends the
 * WHOLE team config, so a role richer than the saver is in every payload they
 * will ever send, and refusing on that would refuse everything.
 * ======================================================================== */

console.log('\ncrewAuth — delegating the team, without handing over the airline');

// The chief of staff: runs the people side, holds no owner-grade power except
// the one that lets them build the team.
const COO = ['team.manage', 'roster.manage', 'applications.review', 'announcements.manage', 'members.message'];
const BEFORE = {
    roles: [
        { id: 'r-recruit', name: 'Recruiter', permissions: ['applications.review', 'roster.manage'] },
        { id: 'r-tech', name: 'Technical manager', permissions: ['integrations.manage', 'schedules.manage'] },
    ],
    assignments: [{ username: 'bob', roleId: 'r-tech' }],
};
const clean = (next) => A.teamSaveFailure(next, BEFORE, COO) === '';
const refused = (next) => A.teamSaveFailure(next, BEFORE, COO) !== '';

T('a delegate may edit a role within their own permissions',
    clean({ roles: [{ id: 'r-recruit', name: 'Recruiter', permissions: ['applications.review'] }] }), true);
T('a delegate may NOT tick a capability they do not hold',
    refused({ roles: [{ id: 'r-recruit', name: 'Recruiter', permissions: ['applications.review', 'integrations.manage'] }] }), true);
T('a delegate may NOT invent an all-powerful role',
    refused({ roles: [{ id: 'r-new', name: 'Everything', permissions: A.CREW_CAP_IDS }] }), true);
T('a delegate may NOT grant the roster sweep',
    refused({ roles: [{ id: 'r-new', name: 'Sweeper', permissions: ['retention.manage'] }] }), true);
// The regression that would make team.manage useless: the whole config is
// re-sent on every save, richer roles included.
T('a delegate may save an unrelated change while a richer role exists',
    clean({ roles: JSON.parse(JSON.stringify(BEFORE.roles)) }), true);
T('an owner is not constrained by any of it',
    A.teamSaveFailure({ roles: [{ id: 'r', name: 'R', permissions: A.CREW_CAP_IDS }] }, BEFORE, A.CREW_CAP_IDS), '');

T('a delegate may NOT assign themselves to a richer role',
    refused({ assignments: [{ username: 'coo', roleId: 'r-tech' }] }), true);
T('…nor anybody else',
    refused({ assignments: [{ username: 'mallory', roleId: 'r-tech' }] }), true);
T('a delegate may assign somebody to a role within their permissions',
    clean({ assignments: [{ username: 'carol', roleId: 'r-recruit' }] }), true);
T('an assignment that already existed passes through',
    clean({ assignments: JSON.parse(JSON.stringify(BEFORE.assignments)) }), true);
T('removing an assignment is always allowed',
    clean({ assignments: [] }), true);
// Create-and-assign in one payload: the role is not in the previous config, so
// a check that only consulted the old roles would find nothing to object to.
T('a delegate may NOT create a rich role and step into it in one save',
    refused({
        roles: [...BEFORE.roles, { id: 'r-new', name: 'New', permissions: ['integrations.manage'] }],
        assignments: [{ username: 'coo', roleId: 'r-new' }],
    }), true);

console.log('\ncrewAuth — the delegation presets');

const preset = (id) => A.CREW_ROLE_PRESETS.find((p) => p.id === id) || { permissions: [] };
T('the chief of staff can build the team',
    preset('chief-of-staff').permissions.includes('team.manage'), true);
T('…but cannot touch the integrations',
    preset('chief-of-staff').permissions.includes('integrations.manage'), false);
T('the technical manager can manage the integrations',
    preset('technical-manager').permissions.includes('integrations.manage'), true);
T('…but cannot rewrite the team',
    preset('technical-manager').permissions.includes('team.manage'), false);
// The sweep removes pilots. It stays something an owner ticks by hand, having
// read the line — never something a preset hands over as part of a job.
T('no preset grants the roster sweep',
    A.CREW_ROLE_PRESETS.every((p) => !(p.permissions || []).includes('retention.manage')), true);

Module._resolveFilename = realResolve;
Module._load = realLoad;

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

'use strict';
// Conformance test for promoting a roster pilot to staff.
//
// THE PROBLEM THIS ENDPOINT SOLVES
//
// "Why would I make a whole team thing but I can give it to no one
// individually — I have 3 people in the roster and only I appear in it."
//
// Staff logins (VaPortalAccount, role 'staff') and roster pilots (CrewMember in
// the VA's own store) were two unrelated identities in two different places,
// and only the first could hold a role. An owner with three pilots opened a
// screen full of permissions with nobody to give them to.
//
// WHAT MUST HOLD, AND WHY EACH ONE IS HERE
//
//   * OWNER ONLY. Not delegable to team.manage like the read is: an unassigned
//     staff account inherits CREW_DEFAULT_STAFF_CAPS (everything bar the
//     owner-grade set), so minting one is a bigger power than assigning a role
//     and the no-escalation rule does not cover it.
//   * A ROLE OR A TICK IS REQUIRED, and the assignment is written with the
//     account. Without it the new person lands on that permissive default —
//     the owner would have "restricted" somebody into near-full access.
//   * THE PILOT'S OWN LOGIN IS TAKEN OVER, not shadowed. The login cascade
//     tries the VA's pilot store first, so a staff account minted under a name
//     that pilot already signs in with is unreachable behind their pilot row.
//     Same username, same bcrypt hash, pilot row stood down.
//   * crewMemberId POINTS BACK AT THE ROSTER ROW, which is what keeps a
//     promoted pilot able to fly (the `kind === 'va'` branch of the pilot
//     resolver in server.js reads exactly this field).
//   * A CLASHING USERNAME FALLS BACK cleanly to a fresh login with a generated
//     password, rather than failing or silently colliding — portal usernames
//     are globally unique, so somebody else's VA can hold the name.
//
// Pure route test — no network, no database. mongoose and the crew store are
// stubbed; the handler is pulled off a fake Express app.

const path = require('path');
const Module = require('module');

// Declared up here because the jwt stub below closes over it.
let IDENTITY = null;

const realResolve = Module._resolveFilename;
const STUBS = {
    // verifyCrewRequest is module-local, so the identity is injected the only
    // way that reaches it: through the token it verifies.
    jsonwebtoken: { sign: () => 'tok', verify: () => (IDENTITY ? { ...IDENTITY, typ: 'crew' } : null) },
    axios: { get: async () => ({}), post: async () => ({}), create: () => ({}) },
    // Stubbed so this runs without node_modules, like its sibling tests. The
    // hash is only ever compared to itself here; what matters is WHICH hash the
    // promotion stores — the pilot's own, or a freshly made one.
    bcryptjs: {
        hash: async (pw) => `hashed:${pw}`,
        hashSync: (pw) => `hashed:${pw}`,
        compare: async () => false,
        compareSync: () => false,
        genSaltSync: () => '',
    },
};
Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return request;
    return realResolve.call(this, request, ...rest);
};

// --- The fake database -----------------------------------------------------
let ACCOUNTS = [];      // VaPortalAccount rows
let AD = null;          // the VirtualAirlineAd doc (with a save())
let CREATED = null;     // the last account create() payload

const VaPortalAccount = {
    find: () => ({ select: () => ({ sort: () => ({ lean: async () => ACCOUNTS }) }) }),
    findOne: (q) => ({ select: () => ({ lean: async () => ACCOUNTS.find(a => matches(a, q)) || null }) }),
    findById: async () => null,
    exists: async (q) => !!ACCOUNTS.find(a => matches(a, q)),
    create: async (doc) => { CREATED = doc; ACCOUNTS.push(doc); return doc; },
};
const matches = (a, q) => Object.entries(q || {}).every(([k, v]) => String(a[k]) === String(v));

const MODELS = {
    VaPortalAccount,
    VirtualAirlineAd: {
        findById: (id) => {
            const doc = AD;
            const chain = { select: () => chain, lean: async () => doc, then: undefined };
            // findById(...) is awaited directly in the promote path and
            // .select().lean()'d in the read path, so support both shapes.
            return Object.assign(Promise.resolve(doc), chain);
        },
    },
};
STUBS.mongoose = {
    model: (n) => MODELS[n] || {},
    models: {},
    Schema: function Schema() {},
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return realLoad.call(this, request, ...rest);
};

const crewStore = require(path.join('..', 'crewStore.js'));
const A = require(path.join('..', 'crewAuth.js'));

// --- The fake crew store ---------------------------------------------------
let MEMBERS = [];
let PILOT_ACCOUNTS = [];
let STOOD_DOWN = [];
crewStore.forVa = async () => ({
    listMembers: async () => MEMBERS,
    getMember: async (id) => MEMBERS.find(m => String(m._id) === String(id)) || null,
    getAccountByMember: async (id) => PILOT_ACCOUNTS.find(a => String(a.memberId) === String(id)) || null,
    updateAccount: async (id, patch) => { STOOD_DOWN.push({ id, patch }); },
});

// --- The fake Express app --------------------------------------------------
const ROUTES = {};
const app = {
    get: (p, h) => { ROUTES[`GET ${p}`] = h; },
    post: (p, h) => { ROUTES[`POST ${p}`] = h; },
    patch: (p, h) => { ROUTES[`PATCH ${p}`] = h; },
    delete: (p, h) => { ROUTES[`DELETE ${p}`] = h; },
    put: (p, h) => { ROUTES[`PUT ${p}`] = h; },
};
A.registerCrewAuthRoutes(app);


async function call(route, { body = {}, as = null } = {}) {
    IDENTITY = as;
    const handler = ROUTES[route];
    if (!handler) throw new Error(`no handler for ${route}`);
    const res = {
        code: 200, body: null, headers: {},
        status(c) { this.code = c; return this; },
        json(b) { this.body = b; return this; },
        set(k, v) { this.headers[k] = v; return this; },
    };
    await handler({
        params: { slug: 'testva' },
        body,
        headers: { authorization: 'Bearer tok' },
        get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer tok' : ''),
    }, res);
    return res;
}

let failures = 0;
const T = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { console.log('  ✓', label); return; }
    failures += 1;
    console.log('  ✗', label, '\n      got: ', JSON.stringify(got), '\n      want:', JSON.stringify(want));
};

function reset() {
    ACCOUNTS = [{ username: 'boss', role: 'owner', active: true, vaAdId: 'va1', crewMemberId: null }];
    PILOT_ACCOUNTS = [];
    STOOD_DOWN = [];
    CREATED = null;
    MEMBERS = [
        { _id: 'm1', name: 'Ana Reyes', callsign: 'AMV101', hours: 40 },
        { _id: 'm2', name: 'Beto Cruz', callsign: 'AMV102', hours: 12 },
        { _id: 'm3', name: 'Cami Diaz', callsign: 'AMV103', hours: 3 },
    ];
    AD = {
        _id: 'va1',
        staffRoles: [{ id: 'r-pirep', name: 'PIREP manager', permissions: ['flights.review'] }],
        staffAssignments: [],
        save: async () => {},
    };
}

const OWNER = { kind: 'va', role: 'owner', uname: 'boss', slug: 'testva', vaId: 'va1', name: 'Boss' };
const DELEGATE = { kind: 'va', role: 'staff', uname: 'jo', slug: 'testva', vaId: 'va1' };

(async () => {
    // resolveVa reads the VA out of mongoose; give it one.
    MODELS.VirtualAirlineAd.findOne = () => ({
        select: () => ({ lean: async () => ({ _id: 'va1', slug: 'testva', name: 'Test VA', staffRoles: AD.staffRoles, staffAssignments: AD.staffAssignments }) }),
    });

    console.log('\nWho may promote somebody');
    reset();
    let r = await call('POST /api/crew/:slug/staff-accounts', { as: null, body: { memberId: 'm1', roleId: 'r-pirep' } });
    T('a stranger is refused', r.code, 401);

    reset();
    r = await call('POST /api/crew/:slug/staff-accounts', { as: DELEGATE, body: { memberId: 'm1', roleId: 'r-pirep' } });
    T('a staff delegate is refused — minting a login is not team.manage', r.code, 403);

    console.log('\nA promotion has to say what the person may do');
    reset();
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'm1' } });
    T('no role and no ticks is refused', r.code, 400);
    T('…and says why, rather than "that didn’t work"', r.body.code, 'role_required');
    T('…and no account was created', CREATED, null);

    reset();
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'm1', roleId: 'r-gone' } });
    T('a role that does not exist is refused', r.code, 400);

    reset();
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'nope', roleId: 'r-pirep' } });
    T('somebody who is not on the roster is refused', r.code, 404);

    console.log('\nPromoting a pilot who already has a login');
    reset();
    PILOT_ACCOUNTS = [{ _id: 'pa1', username: 'anareyes', passwordHash: '$2a$hash', memberId: 'm1' }];
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'm1', roleId: 'r-pirep' } });
    T('it succeeds', r.code, 201);
    T('they keep the username they already sign in with', CREATED.username, 'anareyes');
    T('…and the password they already know', CREATED.passwordHash, '$2a$hash');
    T('…so nothing is issued to pass on', r.body.password, null);
    T('…and they are not nagged to change a password they chose', CREATED.mustChangePassword, false);
    T('the pilot row is stood down, or the cascade would never reach them',
        STOOD_DOWN.map(s => [s.id, s.patch.active]), [['pa1', false]]);
    T('they are linked back to their roster row, so they can still fly', CREATED.crewMemberId, 'm1');
    T('they are staff, never an owner', CREATED.role, 'staff');
    T('the response says their login was kept', r.body.keptTheirLogin, true);

    console.log('\n…and the assignment lands with the account');
    T('the role is assigned in the same breath',
        AD.staffAssignments.map(a => [a.username, a.roleId]), [['anareyes', 'r-pirep']]);
    T('so they never sit on the permissive unassigned default',
        A.effectiveCaps(AD, { kind: 'va', role: 'staff', uname: 'anareyes' }), ['flights.review']);

    console.log('\nPromoting a pilot with no login of their own');
    reset();
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'm2', permissions: ['flights.review'] } });
    T('it succeeds', r.code, 201);
    // baseUsername() dot-separates, the same shape the pilot store issues.
    T('a username is derived from their name', CREATED.username, 'beto.cruz');
    T('a password is issued once', typeof r.body.password, 'string');
    T('…and they are asked to change it', CREATED.mustChangePassword, true);
    T('nothing was stood down — there was no pilot login', STOOD_DOWN, []);
    T('the response says the login is new', r.body.keptTheirLogin, false);
    T('a bare tick with no role still pins them',
        A.effectiveCaps(AD, { kind: 'va', role: 'staff', uname: 'beto.cruz' }), ['flights.review']);

    console.log('\nWhen the username is already taken somewhere else');
    reset();
    // Their pilot username is taken by another VA, AND so is the name we would
    // derive — so this exercises the numeric suffix too.
    ACCOUNTS.push({ username: 'anareyes', role: 'staff', active: true, vaAdId: 'other-va' });
    ACCOUNTS.push({ username: 'ana.reyes', role: 'staff', active: true, vaAdId: 'other-va' });
    PILOT_ACCOUNTS = [{ _id: 'pa1', username: 'anareyes', passwordHash: '$2a$hash', memberId: 'm1' }];
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'm1', roleId: 'r-pirep' } });
    T('it still succeeds', r.code, 201);
    T('under a name that is free', CREATED.username, 'ana.reyes2');
    T('with a password of its own', typeof r.body.password, 'string');
    T('and the pilot login is left alone, because it was not taken over', STOOD_DOWN, []);
    T('…which the response says, so the owner knows to pass the password on', r.body.keptTheirLogin, false);

    console.log('\nPromoting somebody twice');
    reset();
    ACCOUNTS.push({ username: 'anareyes', role: 'staff', active: true, vaAdId: 'va1', crewMemberId: 'm1' });
    r = await call('POST /api/crew/:slug/staff-accounts', { as: OWNER, body: { memberId: 'm1', roleId: 'r-pirep' } });
    T('is refused rather than making a second login', r.code, 409);

    console.log(`\n${failures ? failures + ' failed' : 'all passed'}\n`);
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

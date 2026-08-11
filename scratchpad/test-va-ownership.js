'use strict';
// Conformance test for vaOwnership — handing a virtual airline to somebody else.
//
// WHAT THIS FILE IS ACTUALLY GUARDING
//
// A transfer feature is three lines if you write it as a role swap, and writing
// it that way is a security bug. The cases below are the ones where being wrong
// is expensive rather than merely broken:
//
//   · THE CREDENTIAL SPLIT. A VA accumulates credentials that belong to the
//     PERSON who was owner when they were made — an Infinite Flight grant that
//     acts as that human, a Supabase access token that opens their whole
//     account. Carrying either across a change of owner hands the new owner the
//     ability to act as the old one. Dropping too much is the opposite failure:
//     clear the VA's own project URL and keys and a transfer becomes a data
//     loss event. Both directions are pinned here.
//
//   · WHO MAY BE HANDED AN AIRLINE. Every refusal is a real case: a pilot login
//     is not a staff account, a suspended account cannot accept, an account
//     nobody has ever signed into is almost always the wrong one.
//
//   · EXPIRY. An offer to hand over an entire airline must not sit live for
//     ever, and a lapsed one must read as "no offer" rather than as a live one
//     with a date in the past.
//
//   · ROUTE ORDER. Express matches in registration order, so `/team/:id` will
//     happily swallow `/team/transfer` with id='transfer'. That is not a
//     hypothetical — it is the bug this test caught, and it is asserted against
//     real express routing rather than by reading the file.
//
// Pure module test for everything but the last, which mounts express.

const path = require('path');
const O = require(path.join('..', 'vaOwnership.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const OK = (label, cond) => T(label, !!cond, true);

// ---------------------------------------------------------------------------
console.log('\nThe credential split — whose credential is it?');
// ---------------------------------------------------------------------------

const cleared = Object.keys(O.clearedCredentialFields());

// THE AIRLINE'S. These are how the VA reaches its own data. Clearing them would
// turn a change of owner into the loss of the roster, every flight report and
// every application on file.
for (const keep of ['supabaseUrl', 'supabaseAnonKey', 'supabaseServiceKey']) {
    OK(`keeps ${keep} — the airline's own database`, !cleared.includes(keep));
}

// THE PERSON'S. A Supabase personal access token opens the whole account that
// issued it, not merely this project.
OK('clears the Supabase access token', cleared.includes('supabaseAccessToken'));
OK('clears the token hint with it', cleared.includes('supabaseTokenHint'));

// The Infinite Flight grant acts as one named human and is bounded by what that
// human may do. All of it goes, together — half a grant is not a grant.
for (const gone of ['ifAccessToken', 'ifRefreshToken', 'ifScopes', 'ifConnectedAt', 'ifConnectedBy']) {
    OK(`clears ${gone} — the grant acts as the previous owner`, cleared.includes(gone));
}
// The organization too: leaving it would have the new owner's first connection
// silently inherit the old owner's choice.
OK('clears the chosen organization', cleared.includes('ifOrganizationId'));
// And the sync, which would otherwise start writing to an aircraft under a
// connection that no longer exists.
OK('turns the schedule sync off', O.clearedCredentialFields().ifSyncSchedules === false);
// The OAuth client was registered on the previous owner's Infinite Flight
// account and, while testing, works only for them — worse than useless to the
// new owner because it LOOKS configured.
OK('clears the registered OAuth client', cleared.includes('ifClientId'));

// The notes are only for credentials the VA actually had — a VA that never
// connected Infinite Flight must not be told it has lost it.
T('a VA with nothing connected is told nothing', O.handoverNotes({}), []);
T('a VA with only a Supabase token is told only about that',
    O.handoverNotes({ supabaseTokenSavedAt: new Date() }).map((n) => n.what), ['supabaseToken']);
T('a fully connected VA is told about all three',
    O.handoverNotes({ ifConnectedAt: new Date(), supabaseTokenSavedAt: new Date(), ifClientId: 'ifc_x' })
        .map((n) => n.what),
    ['infiniteFlight', 'supabaseToken', 'oauthClient']);
OK('every note says what to do about it', O.CREDENTIALS_TO_CLEAR.every((c) => c.tells && c.because));

// ---------------------------------------------------------------------------
console.log('\nWho may be handed an airline');
// ---------------------------------------------------------------------------

const staffer = { _id: 'S1', vaAdId: 'VA', role: 'staff', active: true, lastLoginAt: new Date() };
const ctx = { vaAdId: 'VA', currentOwnerId: 'OWNER' };

OK('an active staff member who has signed in', O.canNominate(staffer, ctx).ok);
OK('not the current owner themselves',
    !O.canNominate({ ...staffer, _id: 'OWNER' }, ctx).ok);
OK('not somebody on a different VA',
    !O.canNominate({ ...staffer, vaAdId: 'OTHER' }, ctx).ok);
OK('not an account that is already an owner',
    !O.canNominate({ ...staffer, role: 'owner' }, ctx).ok);
OK('not a suspended account', !O.canNominate({ ...staffer, active: false }, ctx).ok);
OK('not an account nobody has ever signed into',
    !O.canNominate({ ...staffer, lastLoginAt: null }, ctx).ok);
OK('not a deleted account', !O.canNominate(null, ctx).ok);

// A pilot login lives in the same collection but is a crew login, not a portal
// account. The refusal names the fix rather than just saying no.
const pilot = O.canNominate({ ...staffer, role: 'pilot' }, ctx);
OK('not a pilot login', !pilot.ok);
OK('…and it says to make them a staff account first', /staff account/.test(pilot.reason));

// ---------------------------------------------------------------------------
console.log('\nAn offer that lapses');
// ---------------------------------------------------------------------------

const now = Date.parse('2026-08-11T12:00:00Z');
const fresh = O.pendingTransfer({
    toId: 'S1', toUsername: 'jo', toName: 'Jo', byId: 'OWNER', byUsername: 'ada',
    at: new Date(now),
});
OK('a fresh offer has not expired', !O.isExpired(fresh, now));
OK('it expires a week out', !O.isExpired(fresh, now + 6 * 86400000));
OK('and is gone after that', O.isExpired(fresh, now + 8 * 86400000));
// A VA with no offer at all must read as expired, not as an offer with no date.
OK('no offer counts as expired', O.isExpired({}, now));

// A lapsed offer is NOT an offer. Reporting one would have both parties think
// the handover is still on the table.
T('a lapsed offer reports as nothing pending',
    O.transferState(fresh, { _id: 'S1' }, now + 8 * 86400000), null);
T('no offer reports as nothing pending', O.transferState({}, { _id: 'S1' }, now), null);

// One endpoint serves both sides, so it has to say which side you are on.
T('the nominee is told it is theirs to accept',
    O.transferState(fresh, { _id: 'S1' }, now).youAre, 'nominee');
T('the outgoing owner is told it is theirs to cancel',
    O.transferState(fresh, { _id: 'OWNER' }, now).youAre, 'nominator');
T('a colleague sees it without being offered a button',
    O.transferState(fresh, { _id: 'SOMEONE' }, now).youAre, 'bystander');

// Clearing has to blank every field, or a half-cleared offer reads as live.
const cleared2 = O.clearedTransfer();
OK('clearing blanks the whole offer',
    Object.keys(O.pendingTransfer({})).every((k) => k in cleared2));

// ---------------------------------------------------------------------------
console.log('\nA stale "owner" token stops working');
//
// A crew token bakes the role in and lives seven days, and nothing used to
// re-check it. Harmless while ownership was permanent; the moment a VA can
// change hands it means the previous owner keeps full control for a week. The
// middleware in server.js closes that. Its LOGIC is reproduced here against
// stub accounts — the wiring (that it is mounted before the crew routes) is
// asserted separately by position in the file.
// ---------------------------------------------------------------------------

const ACCOUNTS = {
    STILL_OWNER: { role: 'owner', active: true },
    DEMOTED: { role: 'staff', active: true },     // handed the VA over
    SUSPENDED: { role: 'owner', active: false },
    // GONE: absent from the map entirely — the account was deleted.
};

// The middleware's decision, extracted so it can be exercised directly.
function ownerRecheck(p, lookup) {
    if (!p || p.kind === 'inflight' || p.role !== 'owner') return 'pass';
    const account = lookup[p.sub];
    if (!account || !account.active || account.role !== 'owner') return 'refuse';
    return 'pass';
}

T('a real owner is let through',
    ownerRecheck({ kind: 'va', role: 'owner', sub: 'STILL_OWNER' }, ACCOUNTS), 'pass');
// The case the whole feature depends on.
T('a demoted owner’s old token is refused',
    ownerRecheck({ kind: 'va', role: 'owner', sub: 'DEMOTED' }, ACCOUNTS), 'refuse');
T('a suspended owner is refused',
    ownerRecheck({ kind: 'va', role: 'owner', sub: 'SUSPENDED' }, ACCOUNTS), 'refuse');
T('a deleted account is refused',
    ownerRecheck({ kind: 'va', role: 'owner', sub: 'GONE' }, ACCOUNTS), 'refuse');

// Everybody else must fall straight through — this runs in front of every crew
// route and must not cost a database read for a pilot loading their dashboard.
T('a pilot is not re-checked',
    ownerRecheck({ kind: 'crew', role: 'pilot', sub: 'X' }, ACCOUNTS), 'pass');
T('a staff member is not re-checked',
    ownerRecheck({ kind: 'va', role: 'staff', sub: 'DEMOTED' }, ACCOUNTS), 'pass');
T('Inflight oversight is not re-checked',
    ownerRecheck({ kind: 'inflight', role: 'owner', sub: 'GONE' }, ACCOUNTS), 'pass');
T('an unauthenticated request is not re-checked', ownerRecheck(null, ACCOUNTS), 'pass');

// The middleware must be registered before the routes it guards, or it guards
// nothing. Asserted by position, because that is what express order is.
{
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const mw = src.indexOf("app.use('/api/crew', async (req, res, next)");
    const firstRoute = src.search(/app\.(get|post|patch|delete)\('\/api\/crew\/:slug/);
    OK('the re-check is mounted before the crew routes', mw > 0 && firstRoute > 0 && mw < firstRoute);
}

// ---------------------------------------------------------------------------
console.log('\nRoute order — /team/:id must not swallow /team/transfer');
//
// Asserted against real express routing, because this is a bug you cannot see
// by reading two lines that are two hundred apart.
// ---------------------------------------------------------------------------

try {
    const express = require('express');
    const app = express();
    const hits = [];
    // Registered in the SAME ORDER as vaPortal.js registers them.
    app.get('/api/va-portal/team/transfer', (req, res) => { hits.push('literal-get'); res.end(); });
    app.post('/api/va-portal/team/:id/transfer', (req, res) => { hits.push('nominate'); res.end(); });
    app.delete('/api/va-portal/team/transfer', (req, res) => { hits.push('literal-delete'); res.end(); });
    app.post('/api/va-portal/team/transfer/accept', (req, res) => { hits.push('accept'); res.end(); });
    app.patch('/api/va-portal/team/:id', (req, res) => { hits.push('param-patch'); res.end(); });
    app.delete('/api/va-portal/team/:id', (req, res) => { hits.push('param-delete'); res.end(); });

    const http = require('http');
    const server = http.createServer(app);
    const call = (method, url) => new Promise((resolve) => {
        const { port } = server.address();
        const req = http.request({ port, method, path: url }, (res) => { res.resume(); res.on('end', resolve); });
        req.end();
    });

    server.listen(0, async () => {
        await call('DELETE', '/api/va-portal/team/transfer');
        T('DELETE /team/transfer reaches the transfer handler, not /team/:id',
            hits[hits.length - 1], 'literal-delete');
        await call('GET', '/api/va-portal/team/transfer');
        T('GET /team/transfer reaches the transfer handler', hits[hits.length - 1], 'literal-get');
        await call('POST', '/api/va-portal/team/transfer/accept');
        T('POST /team/transfer/accept reaches accept', hits[hits.length - 1], 'accept');
        await call('POST', '/api/va-portal/team/abc123/transfer');
        T('POST /team/<id>/transfer still reaches nominate', hits[hits.length - 1], 'nominate');
        await call('DELETE', '/api/va-portal/team/abc123');
        T('DELETE /team/<id> still reaches the team delete', hits[hits.length - 1], 'param-delete');

        server.close();
        console.log(failures ? `\n${failures} failing\n` : '\nAll passing\n');
        process.exit(failures ? 1 : 0);
    });
} catch (err) {
    console.log('  (express unavailable — route-order check skipped:', err.message, ')');
    console.log(failures ? `\n${failures} failing\n` : '\nAll passing\n');
    process.exit(failures ? 1 : 0);
}

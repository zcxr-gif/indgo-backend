// test-if-fleet.js
//
// The Infinite Flight PublicApi v3 OAuth client (ifOauth.js) and the fleet
// mapper on top of it (ifFleet.js).
//
// Two things here are worth testing hard, because both fail silently.
//
// The first is token rotation. IF rotates refresh tokens: every refresh
// invalidates the one it was spent on. Persist the wrong one and nothing breaks
// today — the call in flight succeeds — and the connection dies at the *next*
// refresh, half an hour later, with no obvious cause. So the tests assert on
// what gets handed to the persister, not just on the call returning.
//
// The second is the id join. v3 aircraft carry `id` (the persistent org
// aircraft id) and `aircraftId` (the content id for the model or livery). They
// are both UUIDs and mixing them up produces a fleet that looks populated and
// matches nothing. The mapper renames the second to `contentId` for exactly
// that reason, and the tests pin the distinction.
//
// Node builtins only — global fetch is stubbed, so nothing here touches the
// network or needs an OAuth client to exist.
//
// Run:  node tools/test-if-fleet.js
'use strict';
const path = require('path');
const crypto = require('crypto');

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { console.log(`  ✓ ${name}`); pass++; }
    else { console.log(`  ✗ ${name}${extra ? `  (${extra})` : ''}`); fail++; }
};
const head = (s) => console.log(`\n${s}`);

// Configure before requiring: ifOauth reads env lazily, but setting it up front
// keeps every test looking at the same client.
process.env.IF_OAUTH_CLIENT_ID = 'ifc_test_client';
process.env.IF_OAUTH_CLIENT_SECRET = 'test_secret';
process.env.PUBLIC_BASE_URL = 'https://example.com/';

const ifOauth = require(path.resolve(__dirname, '..', 'ifOauth.js'));
const ifFleet = require(path.resolve(__dirname, '..', 'ifFleet.js'));

// --- fetch stub -------------------------------------------------------------
// Records every request and replies from a queue of canned responses.
let calls = [];
let queue = [];
global.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return {
        ok: next.status === undefined ? true : next.status >= 200 && next.status < 300,
        status: next.status === undefined ? 200 : next.status,
        json: async () => next.body,
    };
};
const reset = () => { calls = []; queue = []; };
const tokenBody = (over) => Object.assign(
    { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 1800, token_type: 'Bearer' }, over);
const envelope = (result) => ({ errorCode: 0, result });
const form = (i) => Object.fromEntries(new URLSearchParams(calls[i].init.body));

(async () => {

// ---------------------------------------------------------------------------
head('Configuration');

{
    ok('a fully configured client reports ready', ifOauth.configured());
    ok('the redirect URI hangs off PUBLIC_BASE_URL with no double slash',
        ifOauth.redirectUri() === 'https://example.com/api/crew/if-org/callback', ifOauth.redirectUri());

    const saved = process.env.IF_OAUTH_CLIENT_SECRET;
    delete process.env.IF_OAUTH_CLIENT_SECRET;
    ok('a missing secret makes the feature unavailable', !ifOauth.configured());
    ok('...and says which variable is missing',
        /IF_OAUTH_CLIENT_SECRET/.test(ifOauth.unavailableReason()), ifOauth.unavailableReason());
    process.env.IF_OAUTH_CLIENT_SECRET = saved;

    ok('we do not ask for schedule write access',
        !ifOauth.SCOPES.includes('live:schedules.write'), ifOauth.SCOPES.join(' '));
    ok('we do ask for offline_access, or the connection dies in 30 minutes',
        ifOauth.SCOPES.includes('offline_access'));
}

// ---------------------------------------------------------------------------
head('PKCE and the authorization request');

{
    const a = ifOauth.createPkce();
    const b = ifOauth.createPkce();

    ok('the verifier is inside the spec length range',
        a.verifier.length >= 43 && a.verifier.length <= 128, String(a.verifier.length));
    ok('the verifier is base64url with no padding', /^[A-Za-z0-9\-_]+$/.test(a.verifier));
    ok('two pairs never repeat', a.verifier !== b.verifier && a.state !== b.state);

    // The whole security property: the challenge really is S256(verifier).
    const expect = crypto.createHash('sha256').update(a.verifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ok('the challenge is the S256 hash of the verifier', a.challenge === expect);

    const url = new URL(ifOauth.authorizeUrl({ challenge: a.challenge, state: a.state }));
    ok('it points at the IF authorization endpoint',
        url.origin + url.pathname === 'https://api.infiniteflight.com/auth/v2/connect/authorize',
        url.origin + url.pathname);
    ok('response_type is code', url.searchParams.get('response_type') === 'code');
    ok('the challenge method is declared S256', url.searchParams.get('code_challenge_method') === 'S256');
    ok('the verifier never appears in the URL', !url.search.includes(a.verifier));
    ok('the client secret never appears in the URL', !url.search.includes('test_secret'));
    ok('the redirect URI is sent for the server to check',
        url.searchParams.get('redirect_uri') === ifOauth.redirectUri());
    ok('scopes are space-delimited', url.searchParams.get('scope') === ifOauth.SCOPES.join(' '));
    ok('prompt is absent unless asked for', !url.searchParams.has('prompt'));

    const forced = new URL(ifOauth.authorizeUrl({ challenge: a.challenge, state: a.state, prompt: 'consent' }));
    ok('prompt=consent is passed through when requested', forced.searchParams.get('prompt') === 'consent');
}

// ---------------------------------------------------------------------------
head('Token exchange');

{
    reset();
    queue.push({ body: tokenBody() });
    const t = await ifOauth.exchangeCode({ code: 'abc', verifier: 'ver_123' });

    ok('it posts to the token endpoint',
        calls[0].url === 'https://api.infiniteflight.com/auth/v2/connect/token', calls[0].url);
    ok('the body is form-encoded, not JSON',
        calls[0].init.headers['Content-Type'] === 'application/x-www-form-urlencoded');

    const f = form(0);
    ok('grant_type is authorization_code', f.grant_type === 'authorization_code');
    ok('the PKCE verifier is revealed here and only here', f.code_verifier === 'ver_123');
    ok('a confidential client sends its secret', f.client_secret === 'test_secret');
    ok('redirect_uri is repeated at exchange', f.redirect_uri === ifOauth.redirectUri());

    ok('the access token comes back', t.accessToken === 'at_1');
    ok('the refresh token comes back', t.refreshToken === 'rt_1');
    ok('expiry is stored absolute, not as a duration',
        t.expiresAt > Date.now() + 1700 * 1000 && t.expiresAt <= Date.now() + 1800 * 1000, String(t.expiresAt));
}

{
    reset();
    queue.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Code already redeemed.' } });
    let msg = '';
    try { await ifOauth.exchangeCode({ code: 'x', verifier: 'y' }); } catch (e) { msg = e.message; }
    ok('an OAuth error surfaces its description, not just the code',
        msg.includes('Code already redeemed'), msg);
}

{
    reset();
    queue.push({ status: 200, body: { token_type: 'Bearer' } });   // no access_token
    let threw = false;
    try { await ifOauth.exchangeCode({ code: 'x', verifier: 'y' }); } catch (_) { threw = true; }
    ok('a 200 with no access token is still a failure', threw);
}

// ---------------------------------------------------------------------------
head('Refresh token rotation');

{
    reset();
    queue.push({ body: tokenBody({ access_token: 'at_2', refresh_token: 'rt_2' }) });
    const t = await ifOauth.refreshTokens('rt_1');
    ok('refresh sends grant_type=refresh_token', form(0).grant_type === 'refresh_token');
    ok('the rotated refresh token is returned for storage', t.refreshToken === 'rt_2');
}

{
    // Defensive: if a response ever omits a refresh token, keeping the one we
    // spent beats returning nothing and silently dropping the connection.
    reset();
    queue.push({ body: { access_token: 'at_2', expires_in: 1800 } });
    const t = await ifOauth.refreshTokens('rt_1');
    ok('a response with no refresh token keeps the existing one', t.refreshToken === 'rt_1');
}

{
    // An expired access token must be refreshed BEFORE the call, and the new
    // pair handed to the persister. Losing this write kills the connection one
    // refresh later, which is the failure this whole test file exists for.
    reset();
    queue.push({ body: tokenBody({ access_token: 'at_2', refresh_token: 'rt_2' }) });
    queue.push({ body: envelope([{ id: 'org-1', name: 'PacificJet' }]) });

    const saved = [];
    const conn = { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() - 1000 };
    const result = await ifOauth.callWithConnection(conn, '/live/organizations', (t) => { saved.push(t); });

    ok('an expired token is refreshed before the call', calls.length === 2);
    ok('the rotated pair is handed to the persister', saved.length === 1 && saved[0].refreshToken === 'rt_2',
        JSON.stringify(saved));
    ok('the API call uses the NEW access token',
        calls[1].init.headers.Authorization === 'Bearer at_2', calls[1].init.headers.Authorization);
    ok('the envelope is unwrapped to its result',
        Array.isArray(result) && result[0].name === 'PacificJet');
}

{
    // A token that looks live but is rejected: refresh once, retry once, stop.
    reset();
    queue.push({ status: 401, body: {} });
    queue.push({ body: tokenBody({ access_token: 'at_3', refresh_token: 'rt_3' }) });
    queue.push({ body: envelope({ id: 'org-1' }) });

    const saved = [];
    const conn = { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 600000 };
    const result = await ifOauth.callWithConnection(conn, '/live/organizations/org-1', (t) => { saved.push(t); });
    ok('a surprise 401 triggers one refresh and retry', calls.length === 3);
    ok('the retry persists the rotated token too', saved.length === 1 && saved[0].refreshToken === 'rt_3');
    ok('the retried call succeeds', result && result.id === 'org-1');
}

{
    reset();
    queue.push({ status: 401, body: {} });
    queue.push({ body: tokenBody({ access_token: 'at_3', refresh_token: 'rt_3' }) });
    queue.push({ status: 401, body: {} });
    const conn = { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 600000 };
    let msg = '';
    try { await ifOauth.callWithConnection(conn, '/x', () => {}); } catch (e) { msg = e.message; }
    ok('a second 401 gives up rather than looping', calls.length === 3, String(calls.length));
    ok('...and says the connection needs remaking', /expired|[Rr]econnect/.test(msg), msg);
}

{
    reset();
    const conn = { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 600000 };
    let msg = '';
    try { await ifOauth.callWithConnection(conn, '/x'); } catch (e) { msg = e.message; }
    ok('refusing to call without a token persister', /onTokens/.test(msg), msg);
    ok('...before making any request', calls.length === 0);
}

{
    reset();
    let msg = '';
    try { await ifOauth.callWithConnection(null, '/x', () => {}); } catch (e) { msg = e.message; }
    ok('an absent connection fails cleanly', /not connected/i.test(msg), msg);
}

// ---------------------------------------------------------------------------
head('The v3 response envelope');

{
    ok('errorCode 0 unwraps to the result', ifOauth.unwrap({ errorCode: 0, result: { a: 1 } }).a === 1);
    let code = null;
    try { ifOauth.unwrap({ errorCode: 7, result: null }); } catch (e) { code = e.ifErrorCode; }
    ok('a non-zero errorCode throws even on HTTP 200', code === 7, String(code));
    ok('an empty body throws', (() => { try { ifOauth.unwrap(null); return false; } catch { return true; } })());
    ok('403 is explained as testing/scope/access rather than a bare status',
        /testing|scope|access/i.test(ifOauth.describeStatus(403)), ifOauth.describeStatus(403));
    ok('429 is explained as rate limiting', /rate limit/i.test(ifOauth.describeStatus(429)));
}

// ---------------------------------------------------------------------------
head('Enums');

{
    ok('a known organization type resolves',
        ifOauth.enumName(ifOauth.ORGANIZATION_TYPE, 3) === 'Invite only');
    ok('schedule status skips 5 without breaking',
        ifOauth.enumName(ifOauth.SCHEDULE_STATUS, 6) === 'In flight');
    // IF say enum values may be adjusted during the preview, so an unknown
    // number has to stay printable rather than rendering as blank or throwing.
    ok('an unknown value stays printable',
        ifOauth.enumName(ifOauth.WORLD_TYPE, 99) === 'Unknown (99)',
        ifOauth.enumName(ifOauth.WORLD_TYPE, 99));
    ok('null resolves to empty, not "Unknown (null)"',
        ifOauth.enumName(ifOauth.WORLD_TYPE, null) === '');
    ok('value 0 is not mistaken for absent',
        ifOauth.enumName(ifOauth.OPERATION_TYPE, 0) === 'Undefined');
}

// ---------------------------------------------------------------------------
head('Resolving content ids to canonical names');

// The shape loadAircraftMetadata() produces.
const META = {
    acById: new Map([
        ['aaaa0000-0000-0000-0000-000000000001', 'Boeing 777-300ER'],
        ['aaaa0000-0000-0000-0000-000000000002', 'Airbus A320'],
    ]),
    livById: new Map([
        ['bbbb0000-0000-0000-0000-000000000001',
            { liveryName: 'British Airways', aircraftName: 'Boeing 777-300ER' }],
    ]),
};

{
    const liv = ifFleet.resolveNames('bbbb0000-0000-0000-0000-000000000001', META);
    ok('a livery id yields both the livery and its parent type',
        liv.type === 'Boeing 777-300ER' && liv.livery === 'British Airways', JSON.stringify(liv));

    const ac = ifFleet.resolveNames('aaaa0000-0000-0000-0000-000000000002', META);
    ok('an aircraft id yields the type with no livery',
        ac.type === 'Airbus A320' && ac.livery === '', JSON.stringify(ac));

    ok('ids are matched case-insensitively',
        ifFleet.resolveNames('AAAA0000-0000-0000-0000-000000000002', META).type === 'Airbus A320');
    ok('an id the catalogue has never seen resolves to nothing',
        ifFleet.resolveNames('cccc0000-0000-0000-0000-000000000009', META).type === '');
    ok('missing metadata does not throw',
        ifFleet.resolveNames('aaaa0000-0000-0000-0000-000000000001', null).type === '');
}

// ---------------------------------------------------------------------------
head('Mapping aircraft');

{
    const raw = {
        id: '28fb4508-9eca-4120-abe4-3c4f06f6e71c',
        aircraftId: 'bbbb0000-0000-0000-0000-000000000001',
        organizationId: '1337830a-abf9-4315-9488-e8cebd7f485a',
        registration: 'N682XL', status: 0, visibility: 1,
        fleetPriority: 1000, fleetRank: 1, isFleetActiveSlot: true,
        createdAt: '2026-07-03T12:00:00Z',
    };
    const ac = ifFleet.mapAircraft(raw, META);

    // The distinction the docs call out, and the one most likely to be fumbled.
    ok('id stays the persistent organization aircraft id',
        ac.id === '28fb4508-9eca-4120-abe4-3c4f06f6e71c', ac.id);
    ok('the content id is renamed so it cannot be mistaken for it',
        ac.contentId === 'bbbb0000-0000-0000-0000-000000000001' && ac.aircraftId === undefined);

    ok('the registration carries over', ac.registration === 'N682XL');
    ok('the canonical type is resolved', ac.type === 'Boeing 777-300ER', ac.type);
    ok('the livery is resolved', ac.livery === 'British Airways', ac.livery);
    ok('active-slot state is a real boolean', ac.isFleetActiveSlot === true);

    ok('a record with no id is rejected', ifFleet.mapAircraft({ registration: 'X' }, META) === null);
    ok('a non-object is rejected', ifFleet.mapAircraft(null, META) === null);
    ok('isFleetActiveSlot is never truthy-by-accident',
        ifFleet.mapAircraft({ id: 'a', isFleetActiveSlot: 'yes' }, META).isFleetActiveSlot === false);
}

// ---------------------------------------------------------------------------
head('Mapping a whole fleet');

const RAW_FLEET = [
    { id: 'a3', aircraftId: 'aaaa0000-0000-0000-0000-000000000002', registration: 'G-CCC', status: 0, visibility: 1, fleetRank: 3, isFleetActiveSlot: false },
    { id: 'a1', aircraftId: 'bbbb0000-0000-0000-0000-000000000001', registration: 'G-AAA', status: 0, visibility: 1, fleetRank: 2, isFleetActiveSlot: true },
    { id: 'a2', aircraftId: 'aaaa0000-0000-0000-0000-000000000002', registration: 'G-BBB', status: 0, visibility: 2, fleetRank: 1, isFleetActiveSlot: true },
    { id: 'a4', aircraftId: 'cccc0000-0000-0000-0000-000000000009', registration: 'G-DDD', status: 0, visibility: 1, fleetRank: 4, isFleetActiveSlot: false },
    { id: 'a5', aircraftId: 'aaaa0000-0000-0000-0000-000000000002', registration: 'G-GONE', status: 1, visibility: 1, fleetRank: 5, isFleetActiveSlot: false },
];

{
    const fleet = ifFleet.mapFleet(RAW_FLEET, META);
    ok('deleted records are dropped', !fleet.some(a => a.registration === 'G-GONE'));
    ok('the rest survive', fleet.length === 4, String(fleet.length));
    ok('active slots sort ahead of storage',
        fleet.slice(0, 2).every(a => a.isFleetActiveSlot) && fleet.slice(2).every(a => !a.isFleetActiveSlot),
        fleet.map(a => `${a.registration}:${a.isFleetActiveSlot}`).join(' '));
    ok('within a group, fleet rank orders them',
        fleet[0].registration === 'G-BBB' && fleet[1].registration === 'G-AAA',
        fleet.map(a => a.registration).join(' '));
    ok('a non-array is handled', ifFleet.mapFleet(null, META).length === 0);
}

{
    const fleet = ifFleet.mapFleet(RAW_FLEET, META);
    const types = ifFleet.syncedTypes(fleet);
    ok('distinct canonical types are extracted',
        types.join('|') === 'Airbus A320|Boeing 777-300ER', types.join('|'));
    // A blank type would match a leg with a blank aircraft name — the opposite
    // of what a fleet filter is for.
    ok('the unresolvable aircraft contributes no empty type', !types.includes(''));
}

// ---------------------------------------------------------------------------
head('The fleet PIREP matching actually uses');

{
    const manual = [
        { type: 'Boeing 777-300ER', name: 'B77W', image: 'https://img/77w.png' },
        { type: 'Boeing 787-9', name: 'B789', image: '' },
    ];
    const combined = ifFleet.combinedTypes(manual, ifFleet.mapFleet(RAW_FLEET, META));

    ok('hand-built entries are all still there',
        combined.some(c => c.type === 'Boeing 787-9'));
    ok('synced types are added', combined.some(c => c.type === 'Airbus A320'));
    ok('a type in both lists appears once',
        combined.filter(c => c.type === 'Boeing 777-300ER').length === 1);
    // A VA who set a livery image on a type should not lose it because the sync
    // reported the same type.
    ok('the manual entry wins a collision, keeping its image',
        combined.find(c => c.type === 'Boeing 777-300ER').image === 'https://img/77w.png');
    ok('every entry keeps the crewFleet shape',
        combined.every(c => typeof c.type === 'string' && typeof c.name === 'string'));
    ok('entries say where they came from',
        combined.find(c => c.type === 'Airbus A320').source === 'infinite-flight');

    ok('no fleet at all yields nothing', ifFleet.combinedTypes([], []).length === 0);
    ok('nulls are tolerated', ifFleet.combinedTypes(null, null).length === 0);
    ok('a manual entry with only a name still counts',
        ifFleet.combinedTypes([{ name: 'Cessna 172' }], []).length === 1);
    ok('a blank manual entry is dropped', ifFleet.combinedTypes([{ type: '  ' }], []).length === 0);
}

{
    // Case-insensitive de-dupe: "boeing 777-300er" and "Boeing 777-300ER" are
    // one aircraft, and aircraftMatches would treat them as one anyway.
    const combined = ifFleet.combinedTypes(
        [{ type: 'boeing 777-300er' }],
        [{ type: 'Boeing 777-300ER' }],
    );
    ok('de-dupe ignores case', combined.length === 1, JSON.stringify(combined));
    ok('the spelling the VA chose is the one kept', combined[0].type === 'boeing 777-300er');
}

// ---------------------------------------------------------------------------
head('Fleet summary');

{
    const s = ifFleet.summarize(ifFleet.mapFleet(RAW_FLEET, META));
    ok('the total counts live aircraft only', s.total === 4, String(s.total));
    ok('active slots are counted', s.activeSlots === 2, String(s.activeSlots));
    ok('storage is the remainder', s.storage === 2, String(s.storage));
    ok('hangared is counted separately from storage', s.hangared === 1, String(s.hangared));
    // Silently short fleets are the failure a VA cannot diagnose; this is how
    // they find out four of their aircraft were not identified.
    ok('unidentifiable aircraft are surfaced, not hidden', s.unresolved === 1, String(s.unresolved));
    ok('types are ranked by count',
        s.types[0].type === 'Airbus A320' && s.types[0].count === 2, JSON.stringify(s.types));
    ok('an empty fleet summarises to zeroes',
        ifFleet.summarize([]).total === 0 && ifFleet.summarize([]).types.length === 0);
    ok('a null fleet does not throw', ifFleet.summarize(null).total === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch((err) => {
    console.error(err);
    process.exit(1);
});

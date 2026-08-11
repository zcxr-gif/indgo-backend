'use strict';
// Conformance test for WHICH OAuth client a crew center signs in with.
//
// The rule changed. It used to be "the VA's own if they registered one, ours
// otherwise" — a workaround for a platform client that Infinite Flight had not
// approved yet, which made every VA register an application before they could
// press a sign-in button. It is now ours first: one client for the platform,
// the VA carried in the `state`, nothing to register.
//
// The dangerous part is not the preference, it is the grants already in flight.
// A refresh token can only be redeemed by the client it was issued to, and
// getting that wrong does not fail at the moment of the mistake — it fails at
// the next refresh, up to an hour later, as "your connection stopped working".
// So a live grant keeps the client that minted it, read from ifGrantClientId
// rather than guessed from what the VA happens to have saved.
//
// The case that made recording it necessary: a VA who HAS their own client id
// saved but signed in on the PLATFORM one. Inferring "they have their own, so
// they must be on it" would hand every refresh the wrong credentials.
//
// Run:  node scratchpad/test-if-client-choice.js

const PLATFORM = { id: 'platform-abc123', secret: 's3cret', type: 'confidential' };
const NO_PLATFORM = { id: '', secret: '', type: 'public' };

// ifClientFor's rules, transcribed. server.js is not requireable (it opens a
// database and a port) and this helper closes over crewSecrets and ifOAuth, so
// the decision is mirrored here rather than lifted. Kept deliberately literal
// so a divergence is visible side by side with the original.
function chooseClient(ad, platform) {
    const own = String((ad && ad.ifClientId) || '').trim();
    const ownClient = () => ({ id: own, source: 'va' });

    if (ad && ad.ifConnectedAt) {
        const grantClient = String(ad.ifGrantClientId || '').trim();
        if (grantClient) {
            if (own && grantClient === own) return ownClient();
            if (platform.id && grantClient === platform.id) return { id: platform.id, source: 'platform' };
        } else if (own) {
            return ownClient();
        }
    }
    if (platform.id) return { id: platform.id, source: 'platform' };
    if (own) return ownClient();
    return { id: '', source: '' };
}

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const source = (ad, platform = PLATFORM) => chooseClient(ad, platform).source;
const id = (ad, platform = PLATFORM) => chooseClient(ad, platform).id;

console.log('\nA VA with nothing set up — the normal case now');
T('signs in on the platform client', source({}), 'platform');
T('…and that is the id used', id({}), PLATFORM.id);

console.log('\nA VA who registered their own but is not connected');
// The reversal. This used to be 'va'.
T('still gets the platform client', source({ ifClientId: 'va-own-999' }), 'platform');

console.log('\nA live grant keeps the client that minted it');
T('a grant made on their own client stays on it',
    source({ ifClientId: 'va-own-999', ifGrantClientId: 'va-own-999', ifConnectedAt: new Date() }), 'va');
// The case that required recording it: they hold their own id, but signed in
// on ours. Inferring from ifClientId alone would refresh with the wrong client.
T('a grant made on the platform client stays on it, even though they own one',
    source({ ifClientId: 'va-own-999', ifGrantClientId: PLATFORM.id, ifConnectedAt: new Date() }), 'platform');
T('…and uses the platform id, not theirs',
    id({ ifClientId: 'va-own-999', ifGrantClientId: PLATFORM.id, ifConnectedAt: new Date() }), PLATFORM.id);

console.log('\nGrants made before ifGrantClientId existed');
// Those were made under the old rule, where the VA's own always won.
T('an old grant with their own client is read as theirs',
    source({ ifClientId: 'va-own-999', ifConnectedAt: new Date() }), 'va');
T('an old grant with no client of their own is the platform’s',
    source({ ifConnectedAt: new Date() }), 'platform');

console.log('\nDisconnecting is how a VA moves to the platform client');
// ifClearConnection wipes ifGrantClientId and ifConnectedAt together.
const afterDisconnect = { ifClientId: 'va-own-999', ifGrantClientId: '', ifConnectedAt: null };
T('a disconnected VA who still has their own id goes to the platform',
    source(afterDisconnect), 'platform');

console.log('\nA deployment with no platform client');
T('falls back to the VA’s own', source({ ifClientId: 'va-own-999' }, NO_PLATFORM), 'va');
T('a VA with neither has no client at all', source({}, NO_PLATFORM), '');
T('a live grant on their own client is unaffected',
    source({ ifClientId: 'va-own-999', ifGrantClientId: 'va-own-999', ifConnectedAt: new Date() }, NO_PLATFORM), 'va');

console.log('\nThe platform client changed under a live grant');
// The stored grant belongs to a client this deployment no longer has. Nothing
// here can refresh it; the honest outcome is to fall through to the current
// platform client so the connect route can refuse — and the VA reconnects —
// rather than silently presenting credentials the token was not issued to.
T('a grant on a retired platform client falls through to the current one',
    source({ ifGrantClientId: 'platform-OLD', ifConnectedAt: new Date() }), 'platform');
T('…and to the VA’s own when that is all there is',
    source({ ifClientId: 'va-own-999', ifGrantClientId: 'platform-OLD', ifConnectedAt: new Date() }, NO_PLATFORM), 'va');

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

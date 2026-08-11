'use strict';
// Conformance test for reading an Infinite Flight OAuth refusal.
//
// The token endpoint answers RFC 6749 style at the top level:
//
//     { "error": "invalid_grant", "error_description": "…" }
//
// …but the same host also wraps things in the PublicApi envelope, and when it
// does the whole OAuth error moves one level down:
//
//     { "errorCode": 12, "result": { "error": "invalid_request",
//       "errorDescription": "The specified 'client_id' is invalid." } }
//
// Only the top level was read. Against the second shape that yields code "12" —
// the envelope's numeric code, which says nothing — and NO description, so the
// one sentence explaining the failure was dropped and the VA was told to
// reconnect. Reconnecting cannot fix a client id, so the advice sent them back
// through consent to arrive at the identical refusal.
//
// Checked here:
//   * both shapes, and both spellings of the description field
//   * a client fault is told apart from a dead grant, because only one of them
//     is worth a "connect the account again" button
//   * the client-id sanity check refuses what cannot be an id under any format,
//     and nothing else — a format guess that rejected a real id would be worse
//     than the error it prevents
//
// Run:  node scratchpad/test-if-oauth-errors.js

const path = require('path');
const H = require(path.join(__dirname, '..', 'ifOAuth.js'));

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// The body that was actually reported.
const REPORTED = {
    errorCode: 12,
    result: {
        error: 'invalid_request',
        errorDescription: "The specified 'client_id' is invalid.",
        errorUri: 'https://documentation.openiddict.com/errors/ID2052',
    },
};

console.log('\noauthFailure — reading a refusal');
T('the reported envelope yields the real code and reason', H.oauthFailure(REPORTED), {
    code: 'invalid_request',
    description: "The specified 'client_id' is invalid.",
});
T('a plain RFC 6749 body still works',
    H.oauthFailure({ error: 'invalid_grant', error_description: 'The refresh token is no longer valid.' }),
    { code: 'invalid_grant', description: 'The refresh token is no longer valid.' });
T('an envelope using snake_case inside is read too',
    H.oauthFailure({ errorCode: 9, result: { error: 'invalid_client', error_description: 'Client authentication failed.' } }),
    { code: 'invalid_client', description: 'Client authentication failed.' });
// The numeric envelope code is a last resort, never a winner over a real one.
T('the numeric code is used only when there is no OAuth code',
    H.oauthFailure({ errorCode: 7, result: {} }), { code: '7', description: '' });
T('an empty body yields nothing to claim', H.oauthFailure({}), { code: '', description: '' });
T('null is handled', H.oauthFailure(null), { code: '', description: '' });

console.log('\nclient fault vs dead grant — which advice to give');
// Mirrors the branch in tokenRequest.
const advice = (json) => {
    const { code, description } = H.oauthFailure(json);
    const clientFault = H.CLIENT_FAULT_CODES.has(code) || /client_id|client_secret/i.test(description);
    if (clientFault) return 'check the client';
    return (code === 'invalid_grant') ? 'reconnect' : 'other';
};
T('the reported error asks the VA to check the client', advice(REPORTED), 'check the client');
T('a dead refresh token still asks them to reconnect',
    advice({ error: 'invalid_grant', error_description: 'The refresh token is no longer valid.' }), 'reconnect');
T('invalid_client is a client fault',
    advice({ error: 'invalid_client', error_description: 'Client authentication failed.' }), 'check the client');
// Caught by the description even when the code alone would not say so.
T('a grant error that names client_id is a client fault',
    advice({ error: 'invalid_grant', error_description: 'The client_id does not match the authorization code.' }),
    'check the client');

console.log('\nclientIdProblem — refusing only what cannot be an id');
T('a normal-looking id passes', H.clientIdProblem('7f3a91c2-55de-4b0e-9a11-2c8f6d4e77b0'), '');
T('an opaque token passes', H.clientIdProblem('IFOAUTH_live_9aQ2xR7bT'), '');
T('a short id passes', H.clientIdProblem('abc123'), '');
T('empty is refused', H.clientIdProblem('') !== '', true);
T('inner whitespace is refused', H.clientIdProblem('7f3a91c2 55de4b0e') !== '', true);
T('wrapping quotes are refused', H.clientIdProblem('"7f3a91c2-55de"') !== '', true);
T('single quotes too', H.clientIdProblem("'7f3a91c2'") !== '', true);
T('placeholder text is refused', H.clientIdProblem('your-client-id') !== '', true);
T('angle-bracket placeholder is refused', H.clientIdProblem('<client id>') !== '', true);
T('xxxx is refused', H.clientIdProblem('xxxxxxxx') !== '', true);
// Surrounding whitespace is the caller's to trim and must not be a refusal on
// its own — the save path trims before asking.
T('leading/trailing space alone is not a refusal', H.clientIdProblem('  7f3a91c2  '), '');

console.log('\nredactClientId — enough to compare, not enough to fill a log');
T('a long id keeps both ends',
    H.redactClientId('7f3a91c2-55de-4b0e-9a11-2c8f6d4e77b0'), '7f3a91…77b0 (36 chars)');
T('a short id is shown whole', H.redactClientId('abc123'), 'abc123');
T('nothing reads as none', H.redactClientId(''), '(none)');
T('null reads as none', H.redactClientId(null), '(none)');

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

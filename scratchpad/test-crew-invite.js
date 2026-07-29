'use strict';
// Conformance test for crewInvite — the invitation an accepted applicant is
// handed, and the rules that stop it outliving its usefulness.
//
// This module exists because we chose to store a readable password, which is a
// real cost. Everything below is a check on the things that keep that bounded,
// so a regression here is a security regression rather than a cosmetic one:
//
//   * a claimed, revoked or expired invitation NEVER yields its password, to
//     staff or to the holder of a status link, even while the column still
//     physically holds one
//   * claiming and revoking actually blank the stored value rather than only
//     flagging it
//   * a reissue clears the previous outcome, or the new invitation would read
//     as already spent
//   * the applicant's view is strictly narrower than the staff view
//   * every channel renders the same message from the same builder
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const crewInvite = require(path.join('..', 'crewInvite.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const CTX = {
    vaName: 'Aeromexico Virtual',
    ifcName: 'anap',
    callsign: 'AMX101',
    signInUrl: 'https://inflight.info/crew/aeromexico-virtual',
    discordInvite: 'https://discord.gg/abc123',
};

const NOW = new Date('2026-07-01T12:00:00Z');
const live = (over = {}) => ({
    inviteUsername: 'anap',
    invitePassword: 'Kf3xR9pQmT2w',
    inviteIssuedAt: new Date('2026-07-01T09:00:00Z'),
    inviteClaimedAt: null,
    inviteRevokedAt: null,
    inviteAccountId: 'acct-1',
    ...over,
});

console.log('\ncrewInvite\n');

// --- States -----------------------------------------------------------------
console.log(' states');
T('a fresh invitation is live', crewInvite.inviteState(live(), NOW), 'live');
T('no application at all is “none”', crewInvite.inviteState(null, NOW), 'none');
T('an application with no invitation is “none”', crewInvite.inviteState({}, NOW), 'none');
T('a blank password is “none”', crewInvite.inviteState(live({ invitePassword: '' }), NOW), 'none');
T('signed in is “claimed”',
    crewInvite.inviteState(live({ inviteClaimedAt: new Date('2026-07-01T10:00:00Z') }), NOW), 'claimed');
T('thrown away is “revoked”',
    crewInvite.inviteState(live({ inviteRevokedAt: new Date('2026-07-01T10:00:00Z') }), NOW), 'revoked');

// Claimed and revoked are recorded even after the password is gone, so staff can
// see what became of an invitation instead of watching it disappear.
T('claimed still reads as claimed once the password is cleared',
    crewInvite.inviteState(live({ invitePassword: '', inviteClaimedAt: NOW }), NOW), 'claimed');

const old = live({ inviteIssuedAt: new Date('2026-01-01T00:00:00Z') });
T('an unused invitation past its TTL is “expired”', crewInvite.inviteState(old, NOW), 'expired');
T('  …and expiry is measured from when it was issued',
    crewInvite.inviteExpiresAt(live()).toISOString().slice(0, 10), '2026-07-31');

// --- The password is only ever handed out in one state ----------------------
console.log('\n who gets the password');
const staffOf = (app) => crewInvite.staffInvite(app, CTX, NOW);
T('staff see it while live', staffOf(live()).password, 'Kf3xR9pQmT2w');
T('staff do NOT see an expired one', staffOf(old).password, '');
T('staff do NOT see a claimed one',
    staffOf(live({ inviteClaimedAt: NOW })).password, '');
T('staff do NOT see a revoked one',
    staffOf(live({ inviteRevokedAt: NOW })).password, '');
T('a dead invitation carries no ready-made message either', staffOf(old).message, '');
T('but staff still see what happened to it',
    staffOf(live({ invitePassword: '', inviteClaimedAt: NOW })).state, 'claimed');
T('  …and when', !!staffOf(live({ invitePassword: '', inviteClaimedAt: NOW })).claimedAt, true);

const applicantOf = (app) => crewInvite.applicantCredentials(app, CTX, NOW);
T('the applicant sees it while live', applicantOf(live()).password, 'Kf3xR9pQmT2w');
T('the applicant sees nothing at all once expired', applicantOf(old), null);
T('  …once claimed', applicantOf(live({ inviteClaimedAt: NOW })), null);
T('  …and once revoked', applicantOf(live({ inviteRevokedAt: NOW })), null);
T('the applicant view carries no issuing history',
    Object.keys(applicantOf(live())).sort().join(','),
    'expiresAt,message,mustChange,password,signInUrl,username');
T('the applicant is told they must change it', applicantOf(live()).mustChange, true);

// --- Patches actually clear things ------------------------------------------
console.log('\n patches');
T('claiming blanks the password', crewInvite.claimPatch(NOW).invitePassword, '');
T('  …and records when', crewInvite.claimPatch(NOW).inviteClaimedAt, NOW);
T('revoking blanks the password', crewInvite.revokePatch(NOW).invitePassword, '');
T('expiring blanks the password and says nothing else',
    Object.keys(crewInvite.expirePatch()), ['invitePassword']);

const reissue = crewInvite.issuePatch({ username: 'anap', password: 'NEWpass123456', accountId: 'acct-1' }, NOW);
T('a reissue clears the previous claim', reissue.inviteClaimedAt, null);
T('  …and the previous revocation', reissue.inviteRevokedAt, null);
T('  …and restarts the clock', reissue.inviteIssuedAt, NOW);
// Without this, reissuing to a pilot who had already signed in would produce an
// invitation that reads as claimed the moment it is written.
T('a reissued invitation is live again',
    crewInvite.inviteState({ ...live({ inviteClaimedAt: new Date('2026-06-01') }), ...reissue }, NOW), 'live');
T('an account id is stored as given', reissue.inviteAccountId, 'acct-1');
T('  …and a missing one does not become the string “null”',
    crewInvite.issuePatch({ username: 'x', password: 'y' }, NOW).inviteAccountId, '');

// --- The message ------------------------------------------------------------
console.log('\n the message');
const msg = crewInvite.buildInviteMessage({ ...CTX, username: 'anap', password: 'Kf3xR9pQmT2w' });
T('names the VA and the pilot', msg.includes('Welcome to Aeromexico Virtual, anap'), true);
T('states the callsign', msg.includes('AMX101'), true);
T('carries the sign-in link', msg.includes(CTX.signInUrl), true);
T('labels the username', msg.includes('Username: anap'), true);
T('labels the temporary password', msg.includes('Temporary password: Kf3xR9pQmT2w'), true);
T('warns that it must be changed', /choose your own password/i.test(msg), true);
T('includes the Discord invite', msg.includes('https://discord.gg/abc123'), true);
T('is plain text, so it survives a paste into the IFC', /<[a-z]/i.test(msg), false);
T('puts the two credentials on separate lines',
    msg.split('\n').filter((l) => /Username:|Temporary password:/.test(l)).length, 2);

const staffMsg = crewInvite.buildInviteMessage({ ...CTX, username: 'a', password: 'b', staffMessage: 'See you on Sunday.' });
T('a reviewer’s note is included when there is one', staffMsg.includes('See you on Sunday.'), true);

const noCreds = crewInvite.buildInviteMessage({ ...CTX });
T('with no credentials it still points at the crew center', noCreds.includes(CTX.signInUrl), true);
T('  …and invents no password', /Temporary password/.test(noCreds), false);

// The staff clipboard and the applicant's page must never disagree about what
// the pilot was told — they are the same builder, given the same context.
T('staff and applicant render the identical message',
    staffOf(live()).message === applicantOf(live()).message, true);

console.log(failures ? `\n${failures} failing check(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);

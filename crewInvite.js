'use strict';

/*
 * crewInvite.js
 * The invitation an accepted applicant is handed: a username, a temporary
 * password, and the message a staff member pastes to them.
 *
 * WHY AN INVITATION IS A THING WITH A LIFETIME
 * -------------------------------------------
 * Accepting a pilot used to produce a password that existed for exactly one
 * HTTP response. It went into the acceptance email and onto the reviewer's
 * screen, and after that it was gone in every sense — nothing stored it, in any
 * form. That is the right shape for a password and the wrong shape for an
 * invitation, because an invitation is not delivered the moment it is created:
 *
 *   * an applicant who gave no email address has no copy at all unless the
 *     reviewer transcribed it before the dialog closed;
 *   * most of these pilots are reached on the IFC or on Discord, by hand, some
 *     time later — which is a different session, often a different person;
 *   * a status link the applicant already holds is the one channel we know
 *     reaches them, and it had nothing to show.
 *
 * The old answer to every miss was to reset the password and try again, which
 * teaches staff that credentials are cheap and leaves a trail of live ones.
 *
 * So an invitation is now a small state machine that outlives the request:
 *
 *   live      issued, not yet used. The password is readable — by staff, and by
 *             whoever holds the applicant's status link.
 *   claimed   the pilot signed in. Cleared automatically, at that moment.
 *   revoked   staff threw it away. Cleared.
 *   expired   nobody used it within CREW_INVITE_TTL_DAYS. Treated as gone, and
 *             cleared on the next read.
 *   none      never issued, or already cleared.
 *
 * WHAT THIS COSTS, STATED PLAINLY
 * -------------------------------
 * A live invitation is a readable password sitting in a row. That is a real
 * cost and it is the reason for everything below: it is bounded to one account
 * that must change the password on first use, it is bounded in time, and it
 * deletes itself at the first sign that it is no longer needed. It is never
 * where the account's actual credential lives — that is the bcrypt hash in
 * crew_accounts, which this module never touches.
 *
 * Anything reading the raw column MUST go through inviteState() first. A
 * password that is still physically present but claimed, revoked or expired is
 * not an invitation and must not be shown to anyone.
 *
 * Env:
 *   CREW_INVITE_TTL_DAYS   how long an unused invitation stays valid (default 30).
 */

const TTL_DAYS = (() => {
    const n = parseInt(process.env.CREW_INVITE_TTL_DAYS, 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
})();

const DAY_MS = 24 * 60 * 60 * 1000;

const asDate = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * When an invitation stops being usable. Measured from when it was issued, not
 * from when the application was created — a reissued invitation gets a full
 * fresh window rather than inheriting the dead one's.
 */
function inviteExpiresAt(app) {
    const issued = asDate(app && app.inviteIssuedAt);
    return issued ? new Date(issued.getTime() + TTL_DAYS * DAY_MS) : null;
}

/**
 * The only correct way to ask "is there an invitation here?".
 *
 * @returns {'none'|'live'|'claimed'|'revoked'|'expired'}
 */
function inviteState(app, now = new Date()) {
    if (!app) return 'none';
    // Claimed and revoked are recorded even after the password is cleared, so
    // staff can see what became of an invitation rather than watching it vanish.
    if (asDate(app.inviteClaimedAt)) return 'claimed';
    if (asDate(app.inviteRevokedAt)) return 'revoked';
    if (!app.invitePassword) return 'none';
    const expires = inviteExpiresAt(app);
    if (expires && now.getTime() >= expires.getTime()) return 'expired';
    return 'live';
}

const isLive = (app, now) => inviteState(app, now) === 'live';

// ---------------------------------------------------------------------------
// Patches. Returned rather than applied so the caller decides when to write and
// can fold them into an update it was making anyway.
// ---------------------------------------------------------------------------

/** Record a freshly issued invitation. */
const issuePatch = ({ username, password, accountId = null }, now = new Date()) => ({
    inviteUsername: String(username || ''),
    invitePassword: String(password || ''),
    inviteIssuedAt: now,
    inviteAccountId: accountId ? String(accountId) : '',
    // A reissue must clear the outcome of the previous one, or the new
    // invitation would read as already claimed the moment it is written.
    inviteClaimedAt: null,
    inviteRevokedAt: null,
});

/** The pilot signed in. The password goes; the fact that it was used stays. */
const claimPatch = (now = new Date()) => ({ invitePassword: '', inviteClaimedAt: now });

/** Staff threw it away. Same deal. */
const revokePatch = (now = new Date()) => ({ invitePassword: '', inviteRevokedAt: now });

/** Aged out. Nothing to record beyond dropping the dead credential. */
const expirePatch = () => ({ invitePassword: '' });

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/**
 * The one place the wording of an invitation lives.
 *
 * Every channel renders from this: the acceptance email, the applicant's status
 * page, and the button that puts it on a staff member's clipboard to paste into
 * an IFC message. They said different things when they were written separately,
 * which is how a pilot ends up with a password and no idea where to type it.
 *
 * Plain text with blank lines between blocks. The IFC is a Discourse forum and
 * Discord is Discord, so plain text pastes correctly into both; anything
 * cleverer (tables, HTML) does not survive either.
 */
function buildInviteMessage({
    vaName = '', ifcName = '', callsign = '',
    username = '', password = '', signInUrl = '',
    discordInvite = '', staffMessage = '',
} = {}) {
    const who = String(ifcName || '').trim();
    const va = String(vaName || '').trim() || 'the crew';
    const lines = [];

    lines.push(who ? `Welcome to ${va}, ${who} — you're in.` : `Welcome to ${va} — you're in.`);
    if (callsign) lines.push('', `You're flying as ${callsign}.`);
    if (staffMessage) lines.push('', String(staffMessage).trim());

    // The credentials block is the point of the message; keep it visually
    // separate and keep the two values on their own lines so a copy-paste out of
    // a forum post cannot run them together.
    if (username && password) {
        lines.push('', 'Your crew center login:');
        if (signInUrl) lines.push(`  ${signInUrl}`);
        lines.push(`  Username: ${username}`);
        lines.push(`  Temporary password: ${password}`);
        lines.push('', 'You\'ll be asked to choose your own password the first time you sign in. This temporary one stops working the moment you do.');
    } else if (signInUrl) {
        lines.push('', `Sign in to the crew center: ${signInUrl}`);
    }

    if (discordInvite) lines.push('', `Join the crew on Discord: ${discordInvite}`);

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shapes handed out
// ---------------------------------------------------------------------------

/**
 * What a staff member with applications.review sees about an invitation.
 *
 * The password is included only while the invitation is live — that is the
 * whole feature, and it is why this function exists rather than handlers
 * reaching into the row. Everything else is present in every state so the
 * dashboard can say "signed in on the 4th" instead of showing nothing.
 */
function staffInvite(app, ctx = {}, now = new Date()) {
    const state = inviteState(app, now);
    const live = state === 'live';
    const username = app ? (app.inviteUsername || '') : '';
    const password = live ? (app.invitePassword || '') : '';
    return {
        state,
        username,
        password,
        // Prebuilt so the dashboard's copy button cannot drift from the email.
        message: live ? buildInviteMessage({ ...ctx, username, password }) : '',
        signInUrl: ctx.signInUrl || '',
        issuedAt: asDate(app && app.inviteIssuedAt),
        claimedAt: asDate(app && app.inviteClaimedAt),
        revokedAt: asDate(app && app.inviteRevokedAt),
        expiresAt: live ? inviteExpiresAt(app) : null,
    };
}

/**
 * What the holder of the applicant's status link sees.
 *
 * Narrower than the staff shape on purpose: no issuing history, and nothing at
 * all unless the invitation is live. The status token is the applicant's own
 * secret, so this is a credential shown to the person it belongs to — but it is
 * still a link that can be forwarded, which is the other reason the invitation
 * expires and dies on first use.
 */
function applicantCredentials(app, ctx = {}, now = new Date()) {
    if (!isLive(app, now)) return null;
    return {
        username: app.inviteUsername || '',
        password: app.invitePassword || '',
        signInUrl: ctx.signInUrl || '',
        mustChange: true,
        expiresAt: inviteExpiresAt(app),
        message: buildInviteMessage({
            ...ctx, username: app.inviteUsername || '', password: app.invitePassword || '',
        }),
    };
}

module.exports = {
    inviteState,
    inviteExpiresAt,
    isLive,
    issuePatch,
    claimPatch,
    revokePatch,
    expirePatch,
    buildInviteMessage,
    staffInvite,
    applicantCredentials,
    TTL_DAYS,
};

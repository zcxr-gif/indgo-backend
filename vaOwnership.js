'use strict';

/*
 * vaOwnership.js
 * Handing a virtual airline to somebody else.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now a VA's owner account was permanent. provisionOwnerAccount creates
 * exactly one per VA and the portal refuses to edit or delete it — "The owner
 * account cannot be edited here", "The owner account cannot be removed" — which
 * is the right instinct (the owner is not a row a staff member should be able
 * to tamper with) applied so absolutely that the ordinary thing became
 * impossible. VAs change hands. People leave the community, hand a project to a
 * co-founder, or simply lose the account they signed up with. Every one of
 * those was a support ticket, and the only fix was an Inflight staff member
 * editing the database by hand.
 *
 * WHAT LIVES HERE
 * ---------------
 * The decisions, and nothing else. Who may be nominated (eligibility), what a
 * pending transfer is and when it lapses (pendingTransfer / isExpired), and —
 * the part worth reading before anything else — WHICH CREDENTIALS MUST NOT
 * SURVIVE THE HANDOVER (CREDENTIALS_TO_CLEAR).
 *
 * Pure. No mongoose, no express, no network. vaPortal.js holds the I/O.
 *
 * THE CENTRAL IDEA: OWNERSHIP MOVES, CREDENTIALS DO NOT
 * ----------------------------------------------------
 * This is the part that makes a transfer feature dangerous if it is written as
 * a one-line role swap, which is how it is usually written.
 *
 * A VA accumulates credentials that are not the VA's at all — they belong to
 * the PERSON who happened to be the owner when they were created:
 *
 *   · the Infinite Flight OAuth grant, which was consented to by one named
 *     human, acts as that human, and is bounded by what that human is allowed
 *     to do in their own Live organization;
 *   · the Supabase personal access token, which opens the whole Supabase
 *     ACCOUNT it was minted from, not merely the one project.
 *
 * Move the owner role without touching those and you have handed the new owner
 * the ability to act as the old one — against their Infinite Flight
 * organization, and across their entire Supabase account. That is not a
 * handover, it is a credential theft with a confirmation dialog.
 *
 * It is also unreliable in the other direction. The departing owner can revoke
 * either credential from their own account at any moment, without telling
 * anybody here, so a VA that kept running on them is a VA waiting to break in a
 * way its new owner cannot diagnose.
 *
 * So the rule is absolute and stated once: **a transfer clears every credential
 * that belongs to a person, and keeps every credential that belongs to the
 * airline.** The VA's own Supabase project URL and its anon/service keys are
 * the airline's — the data is the airline's, and losing access to it would make
 * a transfer a data loss event. The personal tokens above are not, and go.
 */

/**
 * How long a nominated transfer waits before it lapses.
 *
 * Long enough that a nominee who is asleep, or who only opens the portal at
 * weekends, still gets to accept. Short enough that a nomination somebody
 * thought better of does not sit there indefinitely as a live handover of an
 * entire airline. Seven days is the shape of "I'll do it this week".
 */
const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The roles a transfer may be offered to.
 *
 * 'staff' only. A 'pilot' portal account is a crew login that happens to live
 * in this collection — it has no portal access to speak of and handing it an
 * airline would be a category error. An owner who wants to hand over to
 * somebody not yet on the team creates them a staff account first, which is one
 * extra step and makes "who am I giving this to?" an explicit choice rather
 * than a username typed into a box.
 */
const NOMINABLE_ROLES = ['staff'];

/**
 * Fields on the VirtualAirlineAd that a change of owner must clear, and why.
 *
 * Written as data rather than as a sequence of assignments so that the reason
 * travels with the field. The next person to add a stored credential to a VA
 * has to decide which side of this line it falls on, and the list is where that
 * decision gets recorded.
 *
 * `tells` is shown to the new owner: a transfer that silently disconnects
 * things leaves somebody wondering why their fleet board is empty, which is a
 * worse outcome than the disconnection itself.
 */
const CREDENTIALS_TO_CLEAR = [
    {
        what: 'infiniteFlight',
        // Every one of these, together: half a grant is not a grant, and
        // leaving the organization id behind would have the new owner's first
        // connection silently inherit the old owner's choice of organization.
        fields: {
            ifAccessToken: '', ifRefreshToken: '', ifTokenExpiresAt: null, ifScopes: [],
            ifConnectedAt: null, ifConnectedBy: '', ifLastUsedAt: null,
            ifOrganizationId: '', ifOrganizationName: '', ifOrganizationWorld: null,
            ifTokenFailedAt: null, ifTokenError: '',
            ifSyncSchedules: false, ifSyncAircraftId: '', ifSyncedAt: null,
        },
        because: 'The Infinite Flight connection was made with the previous owner’s account and acts as them.',
        tells: 'Reconnect Infinite Flight with your own account to see the fleet again.',
    },
    {
        what: 'supabaseToken',
        // NOT supabaseUrl, supabaseAnonKey or supabaseServiceKey. Those are the
        // airline's own database and its keys; clearing them would turn a
        // change of owner into a loss of the roster, the flight reports and
        // every application on file.
        fields: {
            supabaseAccessToken: '', supabaseTokenHint: '', supabaseTokenSavedAt: null,
            supabaseTokenUsedAt: null, supabaseTokenFailedAt: null, supabaseTokenError: '',
        },
        because: 'A Supabase access token opens the whole account that issued it, not just this project.',
        tells: 'Your crew data is untouched. Save your own Supabase token if you want one-click database updates.',
    },
    {
        what: 'oauthClient',
        // The VA's registered Infinite Flight OAuth client. Registered by the
        // outgoing owner on their own Infinite Flight account, and — while it
        // is testing — usable only by them and their invited testers, so it is
        // worse than useless to the new owner: it looks configured and refuses
        // everyone.
        fields: {
            ifClientId: '', ifClientSecret: '', ifClientSecretHint: '', ifClientType: '',
        },
        because: 'The OAuth client was registered on the previous owner’s Infinite Flight account.',
        tells: 'Register your own OAuth client at infiniteflight.com/account/api-keys before reconnecting.',
    },
];

/** Everything the above clears, flattened into one $set. */
function clearedCredentialFields() {
    return CREDENTIALS_TO_CLEAR.reduce((out, c) => Object.assign(out, c.fields), {});
}

/**
 * What the new owner is told, in the order they will need to act on it.
 *
 * Only for credentials the VA actually had. A VA that never connected Infinite
 * Flight should not be handed a note about reconnecting it — that reads as a
 * feature they have lost rather than one they never had.
 */
function handoverNotes(ad) {
    const had = {
        infiniteFlight: !!(ad && ad.ifConnectedAt),
        supabaseToken: !!(ad && ad.supabaseTokenSavedAt),
        oauthClient: !!(ad && ad.ifClientId),
    };
    return CREDENTIALS_TO_CLEAR
        .filter((c) => had[c.what])
        .map((c) => ({ what: c.what, because: c.because, tells: c.tells }));
}

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * May this account be handed the airline?
 *
 * Returns { ok } or { ok: false, reason } — a sentence for the person choosing,
 * because every one of these refusals is something they can act on.
 */
function canNominate(candidate, { vaAdId, currentOwnerId } = {}) {
    if (!candidate) return { ok: false, reason: 'That team member no longer exists.' };
    if (String(candidate._id) === String(currentOwnerId || '')) {
        return { ok: false, reason: 'You already own this VA.' };
    }
    if (String(candidate.vaAdId || '') !== String(vaAdId || '')) {
        return { ok: false, reason: 'That account belongs to a different VA.' };
    }
    if (candidate.role === 'owner') {
        return { ok: false, reason: 'That account is already an owner.' };
    }
    if (!NOMINABLE_ROLES.includes(candidate.role)) {
        return {
            ok: false,
            reason: candidate.role === 'pilot'
                // Named precisely, because the fix is a specific action.
                ? 'That is a pilot login, not a staff account. Give them a staff account first, then transfer to it.'
                : 'Only a staff account can be made the owner.',
        };
    }
    if (!candidate.active) {
        return { ok: false, reason: 'That account is suspended. Restore it before transferring.' };
    }
    // A person who has never signed in cannot accept, and an owner nominating
    // an account nobody has ever used is usually nominating the wrong one.
    if (!candidate.lastLoginAt) {
        return { ok: false, reason: 'They have never signed in. Ask them to sign in once, then transfer.' };
    }
    return { ok: true };
}

/** The pending transfer, as stored on the VA. */
function pendingTransfer({ toId, toUsername, toName, byId, byUsername, at = new Date() } = {}) {
    return {
        ownerTransferToId: String(toId || ''),
        ownerTransferToUsername: str(toUsername, 60),
        ownerTransferToName: str(toName, 80),
        ownerTransferById: String(byId || ''),
        ownerTransferByUsername: str(byUsername, 60),
        ownerTransferAt: at,
        ownerTransferExpiresAt: new Date(at.getTime() + TRANSFER_TTL_MS),
    };
}

/** Clearing it — declined, cancelled, completed or lapsed. All the same shape. */
const clearedTransfer = () => ({
    ownerTransferToId: '', ownerTransferToUsername: '', ownerTransferToName: '',
    ownerTransferById: '', ownerTransferByUsername: '',
    ownerTransferAt: null, ownerTransferExpiresAt: null,
});

const isExpired = (ad, now = Date.now()) => {
    const at = ad && ad.ownerTransferExpiresAt ? new Date(ad.ownerTransferExpiresAt).getTime() : 0;
    return !at || at <= now;
};

/**
 * Is there a live transfer, and what should this viewer be told about it?
 *
 * Returns null when there is nothing pending or it has lapsed — a lapsed
 * transfer is not a transfer, and showing one would have both parties think the
 * handover is still on the table.
 *
 * `youAre` is what makes one endpoint serve both sides: the outgoing owner sees
 * a nomination they can cancel, the nominee sees one they can accept, and
 * anybody else on the team sees that the VA is changing hands without being
 * offered a button that is not theirs.
 */
function transferState(ad, viewer, now = Date.now()) {
    if (!ad || !ad.ownerTransferToId) return null;
    if (isExpired(ad, now)) return null;
    const viewerId = String((viewer && viewer._id) || '');
    return {
        toUsername: ad.ownerTransferToUsername || '',
        toName: ad.ownerTransferToName || '',
        byUsername: ad.ownerTransferByUsername || '',
        at: ad.ownerTransferAt || null,
        expiresAt: ad.ownerTransferExpiresAt || null,
        youAre: viewerId && String(ad.ownerTransferToId) === viewerId ? 'nominee'
            : viewerId && String(ad.ownerTransferById) === viewerId ? 'nominator'
                : 'bystander',
    };
}

module.exports = {
    TRANSFER_TTL_MS,
    NOMINABLE_ROLES,
    CREDENTIALS_TO_CLEAR,
    clearedCredentialFields,
    handoverNotes,
    canNominate,
    pendingTransfer,
    clearedTransfer,
    isExpired,
    transferState,
};

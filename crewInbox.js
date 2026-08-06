'use strict';

/*
 * crewInbox.js
 * Messages addressed to one pilot — who gets them, and what they say.
 *
 * WHAT LIVES HERE
 * ---------------
 * The decisions. Given a roster and an instruction like "tell everyone above
 * Senior First Officer", this returns the list of rows to write. It does not
 * write them, does not know the time unless told, and has never heard of
 * Postgres. Same split as crewRetention and crewSchedules.
 *
 * WHY NOT THE NOTICEBOARD
 * -----------------------
 * crew_announcements is the airline talking to everybody at once, and it is the
 * wrong shape for the half of VA communication that is addressed:
 *
 *     "Your application was accepted."
 *     "You're on Thursday's LHR–JFK, seat 1."
 *     "Your Captain check-ride is booked for Sunday."
 *
 * Put those on a board and you either tell the whole roster somebody else's
 * business or — what actually happened before this file — do not say them at
 * all. The pilot found out by noticing. So: one row per pilot per thing.
 *
 * WHY NOT DISCORD
 * ---------------
 * Most VAs do reach their pilots on Discord, and the crew center still posts
 * there. But a Discord message cannot be addressed to a rank band, is gone in a
 * week, and is invisible to a pilot who joined afterwards. This is the durable,
 * addressable copy, and it lives in the VA's own project with the rest of their
 * operational record. The two are complements: the webhook is the nudge, the
 * inbox is the record.
 *
 * FOUR AUDIENCES, AND WHY THAT IS THE WHOLE LIST
 * ---------------------------------------------
 *   'all'      every pilot on the roster, LOA and inactive included. Used for
 *              the things that are true regardless of whether somebody is
 *              currently flying — a policy change, an ownership change.
 *   'active'   pilots with status 'active'. The default for most staff sends,
 *              because messaging a pilot on declared leave about signing up for
 *              Thursday is noise they asked not to get.
 *   'rank'     everyone at or above a rung. The one audience Discord cannot
 *              express, and the reason staff asked for this: "Captains, the new
 *              long-haul SOP is up."
 *   'member'   named pilots. Powers both the individual message and every
 *              automatic notification, because "your application was accepted"
 *              is a send to an audience of one and should not be a second
 *              code path.
 *
 * There is deliberately no 'inactive' or 'loa' audience. Messaging the people
 * who have stopped flying to ask why is a retention feature with a consent
 * question attached, and it is not this one.
 */

const crewRanks = require('./crewRanks');

/**
 * What a message is about. `kind` drives the icon and, for the automatic ones,
 * which table `refId` points into — see the schema's note on why that reference
 * is untyped.
 */
const KINDS = [
    'message',      // a person wrote it
    'application',  // accepted, declined, or a question about one
    'promotion',    // a rung reached
    'booking',      // a departure assigned or released
    'event',        // signed up, promoted off the waitlist, cancelled
    'document',     // a manual published or revised
    'checkride',    // due, booked, passed
    'system',       // the crew center itself: account created, password reset
];

/** Who a send goes to. See the header for why this list is closed. */
const AUDIENCES = ['all', 'active', 'rank', 'member'];

/**
 * The kinds a HUMAN may send. Everything else is the crew center's to write, and
 * letting staff hand-post one would make the inbox forgeable in exactly the way
 * crewNotices refuses for the noticeboard: a hand-written 'promotion' is
 * indistinguishable from a real one, and an inbox that can be forged is not a
 * record. Staff send 'message'; the rest are earned.
 */
const STAFF_KINDS = ['message'];

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

/**
 * A message, cleaned.
 *
 * `senderName` is denormalised on purpose, the same way a PIREP keeps its
 * pilot's name: the message should still read correctly after the staff member
 * who sent it has left the team, and "sent by (deleted)" is a worse record than
 * a name.
 */
function normalizeMessage(input, { allowKinds = KINDS } = {}) {
    const m = input || {};
    return {
        title: str(m.title, 160),
        body: str(m.body, 4000),
        kind: oneOf(str(m.kind, 20), allowKinds, allowKinds[0] || 'message'),
        refId: str(m.refId, 64) || null,
        linkUrl: str(m.linkUrl, 600),
        senderName: str(m.senderName, 80),
    };
}

/** Why this send cannot go, in words staff can act on. '' when it can. */
function sendProblem({ audience, minRank, memberIds, title } = {}) {
    if (!str(title, 160)) return 'Give the message a subject.';
    if (!AUDIENCES.includes(audience)) return 'Choose who this goes to.';
    if (audience === 'rank' && !str(minRank, 40)) return 'Choose the rank this goes to.';
    if (audience === 'member' && !(Array.isArray(memberIds) && memberIds.length)) {
        return 'Choose at least one pilot.';
    }
    return '';
}

/**
 * Which pilots does this send reach?
 *
 * Takes the roster and returns the subset, each already carrying the ids the row
 * needs. A member with no account is INCLUDED: the row is addressed by
 * `member_id` and picked up when they first sign in, which is the behaviour a VA
 * wants for "your invitation is waiting" — the alternative silently drops the
 * message for exactly the pilot it was most for.
 *
 * `ranks` is the VA's ladder, needed only for the 'rank' audience, and read
 * through crewRanks so the gate here and the gate on a document agree.
 */
function resolveAudience(members, { audience = 'active', minRank = '', memberIds = [] } = {}, ranks = []) {
    const roster = Array.isArray(members) ? members.filter(Boolean) : [];

    if (audience === 'member') {
        const wanted = new Set((Array.isArray(memberIds) ? memberIds : []).map((id) => String(id)));
        return roster.filter((m) => wanted.has(String(m._id)));
    }
    if (audience === 'rank') {
        // At or above the rung. meetsRank is open when the rung is not on the
        // ladder any more (a VA renamed it) — which for a GATE is the safe
        // direction, and for a SEND means everybody gets it. That is loud rather
        // than silent, and sendProblem has already refused an empty rank, so the
        // only way here is a rung that existed when the form was drawn.
        return roster.filter((m) => crewRanks.meetsRank(ranks, m.hours, minRank));
    }
    if (audience === 'all') return roster;
    return roster.filter((m) => (m.status || 'active') === 'active');
}

/**
 * The rows to write for one send.
 *
 * One per recipient, each stamped with both ids we know them by — `accountId` so
 * their inbox query finds it on the indexed path, `memberId` so it follows them
 * off the roster (and cascades if they are removed, per the schema).
 *
 * CALLER CONTRACT: a roster row does NOT carry `accountId` — the link runs the
 * other way (crew_accounts.member_id points at the pilot), so nothing in
 * crew_members knows which login belongs to it. The caller is expected to have
 * annotated each member with the account id it resolved, which is an I/O job and
 * therefore not this file's. A member left unannotated still gets a usable row:
 * `account_id` is null and the inbox finds it by `member_id`, which is why the
 * store matches on either. It just misses the partial unread index, so annotate.
 */
function rowsFor(members, message, opts = {}, ranks = []) {
    const clean = normalizeMessage(message, opts);
    return resolveAudience(members, opts, ranks).map((m) => ({
        ...clean,
        accountId: m.accountId || null,
        memberId: m._id || null,
    }));
}

/**
 * How many unread, and the newest thing waiting.
 *
 * Counted from a list rather than asked of the database because the caller has
 * just fetched the inbox anyway, and a second round trip for a number already on
 * the wire is the kind of thing that makes a pilot's dashboard slow.
 */
function unreadSummary(list) {
    const rows = Array.isArray(list) ? list.filter(Boolean) : [];
    const unread = rows.filter((n) => !n.readAt);
    // Newest first is how the inbox is queried, but a caller may hand us any
    // order, so the latest is taken rather than assumed.
    const latest = unread.reduce((best, n) => {
        const t = n.createdAt ? new Date(n.createdAt).getTime() : 0;
        return t > best.t ? { t, row: n } : best;
    }, { t: -1, row: null });
    return {
        total: rows.length,
        unread: unread.length,
        // What the badge shows. Capped because "99+" is the honest rendering of
        // a number nobody acts on, and it keeps the pill one width.
        badge: Math.min(unread.length, 99),
        latest: latest.row,
    };
}

/**
 * Is this automatic notification a duplicate of one already sent?
 *
 * The automatic sends fire from the same places that post a noticeboard row, and
 * some of those run more than once — a sweep that re-checks, a webhook retried,
 * staff pressing approve twice on a slow connection. A pilot told three times
 * that they made Captain stops trusting the inbox.
 *
 * So: same recipient, same kind, same subject is the same event unless it is
 * about a different thing (`refId`). Deliberately NOT time-boxed — a promotion
 * to Captain happens once, and a window would let a retry an hour later through
 * for no benefit. A VA that genuinely wants to re-send says something different.
 */
function dedupeKey(row) {
    const r = row || {};
    return [
        String(r.accountId || r.memberId || ''),
        String(r.kind || 'message'),
        String(r.refId || ''),
        str(r.title, 160).toLowerCase(),
    ].join('|');
}

/** The rows from `candidates` that `existing` does not already contain. */
function withoutDuplicates(candidates, existing) {
    const seen = new Set((Array.isArray(existing) ? existing : []).map(dedupeKey));
    const out = [];
    for (const row of (Array.isArray(candidates) ? candidates : [])) {
        const key = dedupeKey(row);
        // Guards against duplicates WITHIN one send too: a pilot who appears on
        // the roster twice, or a memberIds list with a repeat in it.
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

module.exports = {
    KINDS,
    AUDIENCES,
    STAFF_KINDS,
    normalizeMessage,
    sendProblem,
    resolveAudience,
    rowsFor,
    unreadSummary,
    dedupeKey,
    withoutDuplicates,
};

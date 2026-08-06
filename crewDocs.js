'use strict';

/*
 * crewDocs.js
 * The VA's document library — what is in it, and who may read what.
 *
 * WHAT LIVES HERE
 * ---------------
 * The decisions, and nothing else. This file reads a set of documents and a
 * viewer and returns what that viewer may see; it does not talk to a database,
 * upload a file or know what time it is unless told. Same split crewRetention
 * and crewSchedules follow, and for the same reason — the rules that are
 * ENFORCED live beside the rules that are EXPLAINED, so the two cannot
 * disagree. A pilot told "unlocks at Captain" by the library and then handed
 * the file by the API would be a bug this shape makes hard to write.
 *
 * WHY A LIBRARY IS NOT A NOTICEBOARD
 * ----------------------------------
 * A notice is news: it is written once, read once, and stops mattering. A
 * document is standing: it is the thing a pilot goes looking for six months
 * later, it gets revised rather than replaced, and knowing WHICH revision you
 * read is the whole point. So the two are separate tables and separate panels,
 * and the noticeboard is the right place to ANNOUNCE that a document changed —
 * which is why publishing a revision posts a notice rather than the library
 * trying to be a feed.
 *
 * THE THREE SOURCES
 * -----------------
 * A document's words are in exactly one place, and `source` says which:
 *
 *   'text'  written in the crew center, in `body`.
 *   'link'  somewhere else already — a Doc, a Notion page, a drive.
 *   'file'  uploaded to us and hosted, in `fileUrl`.
 *
 * normalizeDocument keeps that promise by CLEARING the other two. A VA that
 * pastes a link into a document they had been writing inline should not leave
 * the half-written body behind as a second, invisible version of the manual —
 * whichever one the reader got would be a coin toss, and the wrong one is the
 * out-of-date one.
 *
 * THE GATE
 * --------
 * `minRank` is a rung on the VA's own ladder, read through crewRanks so the
 * arithmetic is not written twice. It is enforced in three places and this file
 * is the innermost of them:
 *
 *   1. RLS refuses a gated row to a browser key outright (see the schema).
 *   2. This module decides, for a signed-in pilot, whether the content goes.
 *   3. The panel draws the lock.
 *
 * The layering matters because a document's CONTENT is the gated thing, which is
 * the opposite of a route. A locked route is still drawn — "the airline flies
 * this, Captains only" is not a secret. A locked document is drawn as a TITLE
 * and a reason, and `visibleTo` strips the body, the link and the file URL
 * before it ever reaches a response. Withholding the row entirely would be
 * worse than a lock: a pilot cannot work towards a document they cannot see
 * exists, and "there is a Captain's SOP and you are 38 hours off it" is the
 * useful answer.
 */

const crewRanks = require('./crewRanks');

/** What a document is. Presentational, but stored, so the list can group. */
const KINDS = ['manual', 'sop', 'handbook', 'policy', 'briefing', 'form', 'document'];

/** Where its words actually are. */
const SOURCES = ['text', 'link', 'file'];

/**
 * Draft is staff's working copy. Published is the crew's. Archived is the
 * superseded revision kept on purpose — a pilot who asks why they were told
 * something different last month is owed an answer, and deleting the old manual
 * is how a VA loses it.
 */
const STATUSES = ['draft', 'published', 'archived'];

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

/**
 * Which source did the caller actually mean?
 *
 * Taken from `source` when it is a real one, and INFERRED otherwise — because
 * the front-end sends the field but a CSV import, a bot or an older client may
 * not, and guessing well is better than defaulting everything to an empty text
 * document. A file wins over a link and a link over a body: that is most
 * specific first, so a document with both an upload and a body is the upload
 * with a stale draft beside it, not the other way round.
 */
function resolveSource(input) {
    const claimed = str(input && input.source, 10);
    if (SOURCES.includes(claimed)) return claimed;
    if (str(input && input.fileUrl, 600)) return 'file';
    if (str(input && input.linkUrl, 600)) return 'link';
    return 'text';
}

/**
 * A document, cleaned, with exactly one source populated.
 *
 * Length caps match the columns. `body` is generous (200k) because an ops manual
 * written inline is a genuinely long thing and a truncated one is a dangerous
 * one — a fuel policy that stops mid-sentence is worse than no fuel policy.
 */
function normalizeDocument(input) {
    const d = input || {};
    const source = resolveSource(d);
    return {
        title: str(d.title, 160),
        summary: str(d.summary, 400),
        kind: oneOf(str(d.kind, 20), KINDS, 'document'),
        source,
        // Only the field this source uses survives. See the header.
        body: source === 'text' ? str(d.body, 200000) : '',
        linkUrl: source === 'link' ? str(d.linkUrl, 600) : '',
        fileUrl: source === 'file' ? str(d.fileUrl, 600) : '',
        fileName: source === 'file' ? str(d.fileName, 200) : '',
        fileSize: source === 'file' ? Math.max(0, Math.min(1e11, Number(d.fileSize) || 0)) : 0,
        minRank: str(d.minRank, 40),
        pinned: !!d.pinned,
        status: oneOf(str(d.status, 20), STATUSES, 'draft'),
        revision: str(d.revision, 40),
    };
}

/**
 * Is this document ready to be published?
 *
 * Separate from normalizeDocument because a DRAFT is allowed to be incomplete —
 * that is what a draft is — and the check only bites at the moment staff try to
 * make it the crew's. Returns a reason rather than a boolean so the panel can
 * say which field is missing instead of refusing with a shrug.
 */
function publishProblem(doc) {
    const d = doc || {};
    if (!str(d.title, 160)) return 'Give the document a title before publishing it.';
    if (d.source === 'text' && !str(d.body, 10)) {
        return 'This document has no content yet. Write it, attach a file, or link to it.';
    }
    if (d.source === 'link' && !str(d.linkUrl, 600)) {
        return 'This document links somewhere, but the link is empty.';
    }
    if (d.source === 'file' && !str(d.fileUrl, 600)) {
        return 'This document is a file, but nothing has been uploaded yet.';
    }
    return '';
}

/**
 * Should `revisedAt` move?
 *
 * The pair (`revision`, `revisedAt`) is what makes a library trustworthy, and it
 * only works if it means something. `updated_at` moves on every save — a fixed
 * comma, a retitled heading — and treating that as a revision would mark the
 * manual unread for the whole roster over punctuation, which trains pilots to
 * ignore the marker. So this returns true only when the CONTENT moved, or when
 * staff typed a new revision label, which is them saying so explicitly.
 *
 * Called with the row as it was and the patch going in.
 */
function isSubstantiveChange(before, after) {
    const a = before || {};
    const b = after || {};
    // Staff naming a new revision is a declaration; take it at face value.
    if (b.revision !== undefined && str(b.revision, 40) && str(b.revision, 40) !== str(a.revision, 40)) {
        return true;
    }
    // Switching where the words live is always substantive: it is a different
    // document to read even when it says the same thing.
    if (b.source !== undefined && b.source !== a.source) return true;
    for (const field of ['body', 'linkUrl', 'fileUrl']) {
        if (b[field] !== undefined && str(b[field], 200000) !== str(a[field], 200000)) return true;
    }
    return false;
}

/**
 * What one viewer may see of one document.
 *
 * `viewer` is null for the public and for staff — see crewViewer() in server.js,
 * which returns a viewer only for a signed-in PILOT. The two nulls mean
 * different things and are handled differently:
 *
 *   staff      pass `staff: true`. They see everything, gated or not, draft or
 *              not. Marking the ops manager's own document locked because they
 *              have not flown enough would be nonsense.
 *   the public  no viewer, no staff flag. They get published, ungated documents
 *              only — the same line RLS draws, restated here because a request
 *              through the backend uses the service key and RLS is not in the
 *              way. This is the one place where forgetting a check would leak a
 *              gated body, so it is checked at the innermost layer too.
 *   a pilot    a viewer with `hours`. Gated documents above their rung come back
 *              LOCKED: title, summary and how far off they are, with every
 *              content field stripped.
 *
 * Returns null when the document should not appear at all.
 */
function visibleTo(doc, { viewer = null, staff = false, ranks = [] } = {}) {
    if (!doc) return null;

    if (staff) return { ...doc, locked: false, hoursUntilUnlock: 0 };

    // Nobody but staff sees a working copy or a superseded revision.
    if (doc.status !== 'published') return null;

    if (!doc.minRank) return { ...doc, locked: false, hoursUntilUnlock: 0 };

    // Gated, and nobody is signed in as a pilot: the public does not get it.
    // Deliberately not "locked" — a stranger has no rung to be short of, and
    // telling the internet the titles of a VA's internal SOPs is not this
    // feature's job.
    if (!viewer) return null;

    const hours = Math.max(0, Number(viewer.hours) || 0);
    if (crewRanks.meetsRank(ranks, hours, doc.minRank)) {
        return { ...doc, locked: false, hoursUntilUnlock: 0 };
    }

    // Locked. Everything that carries the content goes, including the file's
    // name and size — those describe the document, and a pilot who cannot read
    // it does not need to know it is 4.2 MB.
    return {
        ...doc,
        body: '',
        linkUrl: '',
        fileUrl: '',
        fileName: '',
        fileSize: 0,
        locked: true,
        hoursUntilUnlock: crewRanks.hoursUntilRank(ranks, hours, doc.minRank),
    };
}

/**
 * The whole library as one viewer sees it.
 *
 * Sorted here rather than in SQL because the order wanted is not an index's
 * order: pinned first, then by kind in the order a VA thinks about them (the
 * manual before the forms), then by title. Doing it in the query would need a
 * CASE over `kind` that has to be kept in step with KINDS anyway.
 */
function libraryFor(docs, opts = {}) {
    const kindOrder = new Map(KINDS.map((k, i) => [k, i]));
    return (Array.isArray(docs) ? docs : [])
        .map((d) => visibleTo(d, opts))
        .filter(Boolean)
        .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            const ka = kindOrder.has(a.kind) ? kindOrder.get(a.kind) : KINDS.length;
            const kb = kindOrder.has(b.kind) ? kindOrder.get(b.kind) : KINDS.length;
            if (ka !== kb) return ka - kb;
            return String(a.title || '').localeCompare(String(b.title || ''));
        });
}

/**
 * A count for the dashboard tile, taken from a list libraryFor has ALREADY
 * resolved.
 *
 * Split from librarySummary so a caller that needs both the list and the counts —
 * which the library endpoint does — resolves the gate once instead of walking
 * every document twice. On a VA with a large archive that second pass was pure
 * waste, and the two could in principle disagree.
 *
 * `locked` counts what is shut to the pilot ASKING, the same way routeSummary's
 * lockedRoutes does, so a tile can say "3 documents, 1 opens at Captain" without
 * the caller re-deriving the gate.
 */
function summarize(visible) {
    const list = Array.isArray(visible) ? visible : [];
    return {
        total: list.length,
        open: list.filter((d) => !d.locked).length,
        locked: list.filter((d) => d.locked).length,
        pinned: list.filter((d) => d.pinned).length,
    };
}

/** The counts, straight from unresolved rows. Convenience over summarize(). */
function librarySummary(docs, opts = {}) {
    return summarize(libraryFor(docs, opts));
}

module.exports = {
    KINDS,
    SOURCES,
    STATUSES,
    resolveSource,
    normalizeDocument,
    publishProblem,
    isSubstantiveChange,
    visibleTo,
    libraryFor,
    summarize,
    librarySummary,
};

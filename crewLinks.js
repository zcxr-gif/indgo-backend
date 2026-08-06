'use strict';

/*
 * crewLinks.js
 * The VA's quick links — where the crew is sent, and whether a URL is safe to
 * send them there.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Every VA has a handful of places their pilots need constantly: the Discord,
 * the IFC thread, SimBrief, the charts site, the livery pack, the leave form.
 * Today that lives in a Discord pinned message, which means it is invisible to
 * anyone who has not joined Discord, invisible to a pilot on the web, scrolled
 * away within a week, and maintained by hand — or by a bot the VA has to run.
 *
 * A crew center already IS the place pilots go. So the links belong here, with
 * no bot, no pinned message and nothing to keep in sync.
 *
 * WHY THIS IS NOT THE DOCUMENT LIBRARY
 * ------------------------------------
 * A document is something to READ: it has revisions, it is long, and knowing
 * which version you read is the point. A link is somewhere to GO: it is one
 * line, it does not get revised, and the only questions about it are "is it
 * still the right address" and "does anybody actually use it".
 *
 * Collapsing them would mean either a library full of one-line rows that need a
 * reader, or a link list carrying revision machinery it never uses. They stay
 * apart, and a link CAN point at a document — that is what `linkUrl` on a
 * document is for, from the other direction.
 *
 * WHAT LIVES HERE
 * ---------------
 * The decisions, and nothing else: no database, no HTTP, no clock unless told.
 * Same split as crewRetention, crewSchedules and crewDocs.
 *
 * THE PART THAT MATTERS
 * ---------------------
 * `safeUrl`. Everything else in this file is arranging tiles; that function is
 * the only thing standing between a staff member with `links.manage` and a
 * `javascript:` URL rendered as an <a href> on every pilot's dashboard. It is
 * strict by construction rather than by blocklist:
 *
 *   * the URL is PARSED, and what comes back out is the parser's own
 *     normalised `href` — never the string that went in. A blocklist of bad
 *     schemes can be defeated by spelling ("java\nscript:", "JaVaScRiPt:",
 *     "%6aavascript:"); an allowlist checked against a parsed protocol cannot,
 *     because the parser has already resolved all of that.
 *   * only http and https are allowed. Not mailto, not tel, not data, not
 *     file — a quick link is a place on the web, and each of the others is
 *     either a different feature or an attack.
 *   * control characters come off first, because browsers strip them from URLs
 *     and a validator that does not is validating a different string from the
 *     one that will be navigated to.
 */

const crewRanks = require('./crewRanks');

/**
 * What a link is for. Presentational — it groups the board and picks a default
 * icon — but stored, because a VA with thirty links wants them in sections and
 * re-deriving the section from the URL every render would be both slow and
 * wrong for anything self-hosted.
 */
const CATEGORIES = [
    'community',   // Discord, the IFC thread, the forum
    'tools',       // SimBrief, a fuel planner, a callsign generator
    'charts',      // Navigraph, chart sites, airport diagrams
    'downloads',   // livery packs, liveries, the fleet's textures
    'training',    // guides, a training server, a checkride booking form
    'forms',       // leave of absence, transfer requests, feedback
    'social',      // YouTube, Twitch, Instagram
    'other',
];

const STATUSES = ['published', 'draft'];

/** Only these two. See the header for why this is an allowlist over a parsed
 *  protocol rather than a blocklist over a string. */
const SAFE_PROTOCOLS = ['http:', 'https:'];

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

/**
 * Does this string already name a scheme?
 *
 * RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). Used only to
 * decide whether to ASSUME https for a bare "example.com" — never to decide
 * whether a scheme is acceptable. That question is answered after parsing.
 */
const hasScheme = (s) => /^[a-z][a-z0-9+.-]*:/i.test(s);

/**
 * Is this a URL we are willing to send a pilot to, and what is its canonical
 * form?
 *
 * Returns `{ ok, url, reason }`. `url` is the PARSER's normalised href, so the
 * value stored is never the raw string a staff member typed.
 */
function safeUrl(raw) {
    // Control characters first. The WHATWG URL parser -- i.e. every browser --
    // removes ASCII tab, LF and CR from a URL before doing anything else, so
    // "java\tscript:alert(1)" IS a javascript: URL once it reaches navigation,
    // while a validator that skipped this step sees an unrecognised scheme and
    // waves it through. That gap is how blocklists get beaten, and stripping the
    // whole C0 range plus DEL closes it with room to spare.
    //
    // Interior SPACES are deliberately left alone: they are not stripped by the
    // parser (they get percent-encoded), and removing them would silently change
    // the address of a legitimate link with a space in its path.
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!s) return { ok: false, url: '', reason: 'Paste a link.' };
    if (s.length > 2000) return { ok: false, url: '', reason: 'That link is too long.' };

    // "//example.com" is protocol-relative; "example.com/x" has no scheme at
    // all. Both mean "the web", and a VA pasting either should not have to know
    // the difference.
    if (s.startsWith('//')) s = 'https:' + s;
    else if (!hasScheme(s)) s = 'https://' + s;

    let parsed;
    try { parsed = new URL(s); } catch { return { ok: false, url: '', reason: 'That doesn’t look like a link.' }; }

    if (!SAFE_PROTOCOLS.includes(parsed.protocol)) {
        return { ok: false, url: '', reason: 'Links have to start with http:// or https://.' };
    }
    // A URL with no host is not somewhere to send anybody. `new URL('https:x')`
    // parses and yields an empty hostname, so this is a real case and not
    // defensive noise.
    if (!parsed.hostname) return { ok: false, url: '', reason: 'That link has no website in it.' };

    return { ok: true, url: parsed.href, reason: '' };
}

/** The bit of a URL a human recognises: "discord.gg", "simbrief.com". */
function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

/*
 * Guessing the category and the icon from the address.
 *
 * A VA adding twelve links should not have to answer two dropdowns twelve
 * times. These are the places virtual airlines actually send people, so the
 * common case is one paste and done — and every guess is only ever a DEFAULT.
 * Staff override it and the override is what is stored, because a VA who
 * self-hosts their charts knows better than a hostname table does.
 */
const DOMAIN_HINTS = [
    [/(^|\.)discord\.(gg|com)$/i,        { category: 'community', icon: 'message-circle' }],
    [/(^|\.)community\.infiniteflight\.com$/i, { category: 'community', icon: 'users' }],
    [/(^|\.)infiniteflight\.com$/i,      { category: 'community', icon: 'plane' }],
    [/(^|\.)simbrief\.com$/i,            { category: 'tools',     icon: 'route' }],
    [/(^|\.)navigraph\.com$/i,           { category: 'charts',    icon: 'map' }],
    [/(^|\.)chartfox\.org$/i,            { category: 'charts',    icon: 'map' }],
    [/(^|\.)flightaware\.com$/i,         { category: 'tools',     icon: 'radar' }],
    [/(^|\.)metar/i,                     { category: 'tools',     icon: 'cloud-sun' }],
    [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, { category: 'social', icon: 'youtube' }],
    [/(^|\.)twitch\.tv$/i,               { category: 'social',    icon: 'twitch' }],
    [/(^|\.)instagram\.com$/i,           { category: 'social',    icon: 'instagram' }],
    [/(^|\.)x\.com$|(^|\.)twitter\.com$/i, { category: 'social',  icon: 'twitter' }],
    [/(^|\.)tiktok\.com$/i,              { category: 'social',    icon: 'music' }],
    [/(^|\.)docs\.google\.com$/i,        { category: 'forms',     icon: 'file-text' }],
    [/(^|\.)forms\.gle$|(^|\.)forms\.office\.com$/i, { category: 'forms', icon: 'clipboard-pen' }],
    [/(^|\.)notion\.(so|site)$/i,        { category: 'training',  icon: 'book-open' }],
    [/(^|\.)drive\.google\.com$/i,       { category: 'downloads', icon: 'hard-drive-download' }],
    [/(^|\.)dropbox\.com$|(^|\.)mediafire\.com$/i, { category: 'downloads', icon: 'hard-drive-download' }],
    [/(^|\.)github\.com$/i,              { category: 'tools',     icon: 'code' }],
];

/** The default icon for a category, when the domain says nothing. */
const CATEGORY_ICONS = {
    community: 'users',
    tools: 'wrench',
    charts: 'map',
    downloads: 'download',
    training: 'graduation-cap',
    forms: 'clipboard-pen',
    social: 'share-2',
    other: 'link',
};

/** What this address looks like it is, before staff say otherwise. */
function guess(url) {
    const host = hostOf(url);
    if (host) {
        for (const [pattern, hint] of DOMAIN_HINTS) {
            if (pattern.test(host)) return { ...hint };
        }
    }
    return { category: 'other', icon: CATEGORY_ICONS.other };
}

/**
 * A link, cleaned.
 *
 * Returns `{ ok, link, reason }` rather than throwing, because the one way this
 * fails — a URL that is not one — is a thing to SAY to the person who pasted it.
 */
function normalizeLink(input) {
    const l = input || {};
    const checked = safeUrl(l.url);
    if (!checked.ok) return { ok: false, link: null, reason: checked.reason };

    const hint = guess(checked.url);
    const category = oneOf(str(l.category, 20), CATEGORIES, hint.category);
    return {
        ok: true,
        reason: '',
        link: {
            // A link with no label is shown by its host, which is better than an
            // empty tile and is what a VA pasting a bare URL clearly meant.
            title: str(l.title, 80) || hostOf(checked.url),
            url: checked.url,
            description: str(l.description, 240),
            category,
            // Staff's icon, else the domain's, else the category's.
            icon: str(l.icon, 40) || hint.icon || CATEGORY_ICONS[category] || CATEGORY_ICONS.other,
            minRank: str(l.minRank, 40),
            pinned: !!l.pinned,
            status: oneOf(str(l.status, 20), STATUSES, 'published'),
            // Where staff dragged it. Sparse on purpose — see orderedFor.
            sortOrder: Math.max(0, Math.min(9999, Math.round(Number(l.sortOrder) || 0))),
        },
    };
}

/**
 * What one viewer may see of one link.
 *
 * Same three-way shape as crewDocs.visibleTo, and the same reasoning: a gated
 * link's URL IS the thing being gated, so a pilot below the rung gets the tile
 * and the reason with the address REMOVED, and the public does not get a gated
 * tile at all.
 *
 * A locked link keeps its title and description. "There is a staff ops toolkit
 * and it opens at Captain" is a thing worth knowing; the address is not.
 */
function visibleTo(link, { viewer = null, staff = false, ranks = [] } = {}) {
    if (!link) return null;
    if (staff) return { ...link, locked: false, hoursUntilUnlock: 0 };
    if (link.status !== 'published') return null;
    if (!link.minRank) return { ...link, locked: false, hoursUntilUnlock: 0 };
    if (!viewer) return null;

    const hours = Math.max(0, Number(viewer.hours) || 0);
    if (crewRanks.meetsRank(ranks, hours, link.minRank)) {
        return { ...link, locked: false, hoursUntilUnlock: 0 };
    }
    return {
        ...link,
        url: '',
        locked: true,
        hoursUntilUnlock: crewRanks.hoursUntilRank(ranks, hours, link.minRank),
    };
}

/**
 * The board, in the order it is drawn.
 *
 * Pinned first, then the tiles staff have deliberately arranged in their chosen
 * order, then everything else alphabetically.
 *
 * `sortOrder` 0 is the column default and means NEVER ARRANGED — so it sorts
 * LAST, not first. That distinction is the whole reason this is here rather than
 * in an ORDER BY: a VA who has dragged three tiles and left twenty alone has
 * twenty rows sitting at 0, and a plain ascending sort would put all twenty
 * ABOVE the three they explicitly positioned. Ordering is 1-based for the same
 * reason, so "first" is expressible.
 *
 * The alphabetical fallback is what stops those twenty shuffling between reads,
 * which Postgres is entitled to do for rows a query cannot distinguish.
 */
function boardFor(links, opts = {}) {
    const rank = (l) => (Number(l.sortOrder) > 0 ? Number(l.sortOrder) : Infinity);
    return (Array.isArray(links) ? links : [])
        .map((l) => visibleTo(l, opts))
        .filter(Boolean)
        .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            const ra = rank(a);
            const rb = rank(b);
            if (ra !== rb) return ra - rb;
            return String(a.title || '').localeCompare(String(b.title || ''));
        });
}

/**
 * The board split into the sections it is drawn in.
 *
 * Category order is CATEGORIES' order — community first, because the Discord is
 * what most pilots are looking for, and 'other' last. Empty sections are
 * dropped rather than rendered as a heading over nothing.
 */
function sectionsFor(links, opts = {}) {
    const board = boardFor(links, opts);
    return CATEGORIES
        .map((category) => ({ category, links: board.filter((l) => l.category === category) }))
        .filter((s) => s.links.length);
}

/**
 * Counts for a tile, from an already-resolved board.
 *
 * `opens` is the sum of how often the crew has actually used these — the number
 * that tells a VA their charts link is dead weight and their leave form is not.
 * It is a usage HINT and is documented as one: the increment is not
 * authenticated (a pilot opening a link is not a session-bearing act), so it is
 * good for "which of these matters" and not for anything that has to be exact.
 */
function summarize(visible) {
    const list = Array.isArray(visible) ? visible : [];
    return {
        total: list.length,
        locked: list.filter((l) => l.locked).length,
        pinned: list.filter((l) => l.pinned).length,
        opens: list.reduce((n, l) => n + (Number(l.opens) || 0), 0),
    };
}

module.exports = {
    CATEGORIES,
    STATUSES,
    CATEGORY_ICONS,
    SAFE_PROTOCOLS,
    safeUrl,
    hostOf,
    guess,
    normalizeLink,
    visibleTo,
    boardFor,
    sectionsFor,
    summarize,
};

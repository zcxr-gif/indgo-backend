'use strict';

/*
 * vaSites.js
 * Hosting a virtual airline's own website, written by the virtual airline.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A VA that wants a public website has had three options and all of them are
 * bad. Embed our iframe, and the site is our markup in their page. Use
 * crew-feed.js on a site they host themselves, which is right but assumes they
 * have somewhere to host it and someone who knows how. Or type their fleet and
 * their destinations into Wix by hand, and be wrong about their own airline
 * from the following week.
 *
 * So: they write the site, we serve it, and the figures on it come from their
 * crew center over crew-feed.js — one place to change them, and the website
 * cannot disagree with the airline.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT
 * -------------------------------------------
 * A VA writes JavaScript here and we run it in a browser. That is the whole
 * feature and it is also the whole risk, and there is exactly one defence that
 * actually works: THEIR CODE MUST NOT SHARE AN ORIGIN WITH OURS. Not a
 * sanitiser, not a script allow-list, not a review queue. A separate origin,
 * enforced by the browser.
 *
 * Every VA site is served from `<slug>.<VA_SITES_DOMAIN>` and nothing is served
 * from there but VA sites. On that origin their script has no reach into
 * inflight.info: it cannot read our localStorage or sessionStorage (where the
 * crew center's session token lives), cannot touch our DOM, cannot call our
 * authenticated endpoints as a signed-in staff member, and cannot be handed a
 * cookie of ours — every session cookie this platform sets is `__Host-`
 * prefixed (see setAuthCookie in vaPortal.js and staffAuth.js), which the
 * browser will only accept host-only, so none of them is sent to a subdomain
 * and none of them can be set FROM one.
 *
 * ON OUR OWN DOMAIN, WITH THEIR NAME IN IT
 * ----------------------------------------
 * That is the decision: a VA's site lives at `<their slug>.<our domain>` —
 * `ba.vasites.inflight.info` — and the airline's name is the part that
 * identifies it. It is the right product answer (a VA gets an address with
 * their name on it, on a domain whose certificate and uptime are ours) and it
 * costs two things, both of which are dealt with HERE rather than left as
 * warnings.
 *
 * ONE: COOKIE TOSSING. A separate origin is not a separate SITE when the
 * registrable domain is shared. A VA's own script can write
 * `document.cookie = 'x=1; domain=inflight.info'` and have it sent to
 * inflight.info on every later request. It can never READ one of our cookies —
 * they are httpOnly, and a shadowing cookie does not reveal the one it shadows
 * — but an unprefixed name is one it can SHADOW, which is enough to make a
 * session behave strangely.
 *
 * The fix is not a second domain, it is the `__Host-` cookie prefix, and the
 * browser enforces it: a cookie whose name begins `__Host-` is accepted ONLY
 * when it is Secure, path=/ and carries NO Domain attribute, so no page on any
 * subdomain of ours can set one that reaches the platform. Both session
 * cookies this product issues are prefixed — see setAuthCookie in vaPortal.js
 * and staffAuth.js. That turns "we are careful never to scope a cookie to the
 * parent domain" into something a VA's JavaScript cannot get around.
 *
 * TWO: LABEL COLLISION. On our own domain, a VA slug is a hostname of ours.
 * `www`, `api`, `login`, `mail` and their kind must never become a VA site, or
 * the airline whose slug is `login` is handed a page at a name our own users
 * read as ours. RESERVED_LABELS below refuses them at the host, and the editor
 * refuses to give such a slug an address at all.
 *
 * WHAT IS LEFT. A VA's script still shares a registrable domain with us, so it
 * can still set NON-prefixed cookies at the parent for anything of ours that
 * reads one in future. The rule that keeps this closed is simple and it is the
 * reason this paragraph exists: every session-bearing cookie this platform
 * issues, now or later, is `__Host-` prefixed.
 *
 * WHAT A HOSTED SITE CAN REACH OF OURS
 * ------------------------------------
 * The public crew endpoints for ITS OWN VA, and that is the entire list. Those
 * are the same URLs any visitor to the crew center reads: routes, network,
 * stats, published events, the noticeboard, the Instagram wall. Rosters,
 * applications, applicant emails, flight reports, staff logins, our Mongo, the
 * VA's Supabase service key — none of it is on a public endpoint, so none of it
 * is reachable from here, and the CSP below is not the thing keeping it that
 * way. There is no key in a hosted site and nothing to leak by publishing one,
 * which is why the editor never has to warn a VA about what they paste.
 *
 * WHAT WE STORE, AND WHY IT IS OURS AND NOT THEIRS
 * ------------------------------------------------
 * crewStore.js's rule is that a VA's operational data lives in the VA's own
 * Supabase project, never ours. Site source is the deliberate exception, and it
 * is not a weakening of that rule: the rule is about data ABOUT PEOPLE — who is
 * on the roster, who applied, what they flew, what their email is. A homepage
 * is a thing whose entire purpose is to be published to strangers. Putting it
 * in the VA's project would also mean every page view of every VA site waits on
 * that VA's database, which is a serving story we would regret at the first
 * outage that is not ours.
 *
 * Text only, and small. See the caps below.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

// The designs a VA picks from, and the blocks they are built out of. Kept in
// its own module because the catalogue grows and this file does not need to:
// nothing here knows what a template looks like, only how to store one.
const templates = require('./vaSiteTemplates');

// The block model a VA arranges in the crew centre, and the renderer that turns
// it into the files below. This file stays the storage: it asks vaSiteBuilder
// for a file list exactly as it asks vaSiteTemplates for one, and everything
// downstream — the caps, the preview, the publish, the history — is shared.
const builder = require('./vaSiteBuilder');

/* ===========================================================================
 * CAPS
 *
 * Deliberately small. This hosts an airline's website — a homepage, a fleet
 * page, an about page, a stylesheet — not an application. A VA that needs more
 * than this needs a host, and crew-feed.js already works on one.
 *
 * Images are NOT stored here on purpose. A VA's logo and banner already live in
 * our uploads, event banners already have their own endpoint, and everything
 * else can be an https URL. Accepting binaries would turn a 2 MB text quota
 * into an image host with none of an image host's answers about takedowns.
 * ======================================================================== */
const MAX_FILES = 60;
const MAX_FILE_BYTES = 256 * 1024;        // 256 KB — a very large page
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;  // 2 MB across the whole site
const MAX_PATH_LEN = 120;
const MAX_VERSIONS = 10;                  // published snapshots kept for revert
const PREVIEW_TTL_MS = 30 * 60 * 1000;    // a preview token lasts half an hour

// What a VA may write. Text formats only, and every one of them is something a
// browser renders as itself rather than sniffs into something else.
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/* ===========================================================================
 * PATHS
 *
 * A path is a relative POSIX path of ordinary characters with a known
 * extension. The refusals are the point:
 *
 *   - no leading '/', so a path cannot be read as absolute;
 *   - no '..' segment ANYWHERE, so nothing can climb out of the site;
 *   - no backslash, so a Windows-style separator cannot smuggle a segment past
 *     a check written in terms of '/';
 *   - no space or control character, which is how a checked string becomes a
 *     different string by the time something else reads it;
 *   - no leading '__', reserved for our own routes on the site host (see
 *     PREVIEW_PREFIX) — a VA that could publish '__preview/x' could shadow one.
 *
 * Nothing here is ever joined to a filesystem path — files live in Mongo as
 * strings keyed by this path — so this is not a traversal defence in the usual
 * sense. It is a defence against two paths that a person reads as one file and
 * the code reads as two.
 * ======================================================================== */
const PREVIEW_PREFIX = '__preview';
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
// `/__preview/<token>/<path>` on a site host. Built once: it is matched on
// every request to a VA site, preview or not.
const PREVIEW_RE = new RegExp('^/' + PREVIEW_PREFIX + '/([A-Za-z0-9_-]{16,80})(/.*)?$');

function extOf(p) {
    const i = String(p).lastIndexOf('.');
    return i < 0 ? '' : String(p).slice(i).toLowerCase();
}

/** A cleaned path. Returns { path } or { error } — never throws. */
function cleanPath(input) {
    let p = String(input == null ? '' : input).trim();
    if (!p) return { error: 'Give the file a name.' };
    p = p.replace(/^\/+/, '');
    if (p.length > MAX_PATH_LEN) return { error: `File names stop at ${MAX_PATH_LEN} characters.` };
    if (!PATH_RE.test(p)) return { error: 'Use letters, numbers, dots, dashes, underscores and / only — no spaces.' };
    const segs = p.split('/');
    if (segs.some(s => s === '' || s === '.' || s === '..')) return { error: 'That path does not point anywhere.' };
    if (segs.length > 6) return { error: 'Six folders deep is as far as this goes.' };
    if (segs[0].startsWith('__')) return { error: 'Names starting with __ are reserved.' };
    if (!TYPES[extOf(p)]) {
        return { error: `Only ${Object.keys(TYPES).join(', ')} files can be hosted. Images belong on an https:// URL.` };
    }
    return { path: p };
}

const bytesOf = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');

/* ===========================================================================
 * THE MODEL
 *
 * Two file sets, deliberately. `draft` is what the editor writes to and what
 * preview serves; `published` is what the world gets. They are separate rather
 * than a per-file flag because the question a VA asks is "what is live right
 * now", and a per-file flag answers it only by scanning.
 *
 * `versions` keeps the last MAX_VERSIONS published snapshots, so a VA who
 * publishes something broken on a Friday can put Thursday back without us.
 * ======================================================================== */
const SiteFileSchema = new mongoose.Schema({
    path: { type: String, required: true },
    content: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
}, { _id: false });

const CrewSiteSchema = new mongoose.Schema({
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, unique: true, index: true },
    // Mirrored from the VA record so a request for a host is one indexed
    // lookup. Re-synced on every authoring call, so a slug changed in the Crew
    // Centers tool moves the site with it rather than stranding it.
    slug: { type: String, lowercase: true, trim: true, index: true },

    draft: { files: { type: [SiteFileSchema], default: [] }, updatedAt: Date, updatedBy: String },
    published: {
        files: { type: [SiteFileSchema], default: [] },
        at: Date, by: String,
        version: { type: Number, default: 0 },
    },
    versions: {
        type: [{
            _id: false,
            version: Number, at: Date, by: String,
            files: { type: [SiteFileSchema], default: [] },
        }],
        default: [],
    },

    // The VA's own switch. Off means the host answers 404 exactly as if nothing
    // had ever been published — not a "this site is disabled" page, which is a
    // sentence about a VA that the VA did not ask us to publish.
    enabled: { type: Boolean, default: true },

    // Inflight's switch, for moderation. Separate from `enabled` so a site
    // turned off for cause cannot be turned back on by the VA flipping their
    // own switch, and so the reason survives.
    blocked: { type: Boolean, default: false },
    blockedReason: { type: String, default: '' },
    blockedAt: Date,

    /* HOW THIS SITE IS AUTHORED.
     *
     * 'design' — the VA arranges blocks in the crew centre's builder and we
     *            render the files from `builder` on every save. The files are
     *            still the only thing served: the document is an input to them,
     *            never a second source of truth.
     * 'code'   — the VA writes the files themselves. `builder` is left where it
     *            is but nothing reads it.
     *
     * A site moves from 'design' to 'code' once, on purpose, through
     * /site/eject. It does not move back, and that is not a limitation we could
     * remove by trying harder: once somebody has hand-edited the markup, the
     * document no longer describes their site, and re-rendering from it would
     * quietly delete their work. Ejecting says that out loud instead.
     */
    mode: { type: String, enum: ['design', 'code'], default: 'design' },

    // The site document — pages, and the ordered blocks on each. Mixed because
    // its shape is vaSiteBuilder's business and validating it twice, in two
    // vocabularies, is how the two get to disagree. normaliseDoc is the schema.
    builder: { type: mongoose.Schema.Types.Mixed, default: null },

    // Which design the draft was laid out from, and the theme on top of it.
    //
    // Stored rather than inferred from the files, because it cannot be inferred:
    // a VA who has edited style.css has a site that is still Concourse in every
    // way that matters to them, and re-deriving "which template is this" from
    // markup would be a guess that goes wrong exactly when somebody has done
    // the most work. It is what the picker highlights and what the theme
    // controls write against.
    template: { type: String, default: '' },
    theme: {
        _id: false,
        accent: { type: String, default: '' },
        font: { type: String, default: '' },
        mode: { type: String, default: '' },
    },

    // Short-lived preview credential. The site host has no session — that is
    // the point of it — so a token in the URL is the only way to show a VA
    // their unpublished draft on the origin it will actually run on.
    previewToken: { type: String, default: '' },
    previewExpires: Date,

    createdAt: { type: Date, default: Date.now },
}, { minimize: false });

const CrewSite = mongoose.models.CrewSite || mongoose.model('CrewSite', CrewSiteSchema);

/* ===========================================================================
 * LAYING OUT A DESIGN
 *
 * The catalogue lives in vaSiteTemplates.js. This file's only interest in it is
 * that a template produces a list of {path, content} and that every path it
 * produces is one a VA would have been allowed to write by hand — checked
 * below, not assumed, because a template that shipped a path cleanPath refuses
 * would create a file the editor could never save again.
 * ======================================================================== */
function layOutTemplate(templateId, va, theme) {
    const files = templates.renderTemplate(templateId, va, {
        feedSrc: `${CREW_BASE}/crew-feed.js`,
        crewBase: CREW_BASE,
        theme,
    });
    const bad = files.find(f => !cleanPath(f.path).path);
    if (bad) throw new Error(`Template "${templateId}" produced an unusable path: ${bad.path}`);
    return files;
}

/* ===========================================================================
 * WHERE A SITE LIVES
 *
 * VA_SITES_DOMAIN is the whole switch. Unset, this feature does not exist: no
 * host is claimed, no route is mounted, and the authoring API answers with a
 * clear "hosting is not configured on this deployment" rather than letting a
 * VA write a site nobody can reach.
 * ======================================================================== */
const DOMAIN = String(process.env.VA_SITES_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');

// Where a hosted site's `crew-feed.js` and its public crew endpoints live.
// Split, because they are two services: the script is served with the tracker,
// the endpoints by this backend.
const CREW_BASE = String(process.env.PUBLIC_SITE_ORIGIN || 'https://inflight.info').replace(/\/+$/, '');
const BACKEND_ORIGIN = String(
    process.env.PUBLIC_BACKEND_ORIGIN || 'https://site--indgo-backend--6dmjph8ltlhv.code.run'
).replace(/\/+$/, '');

// Script CDNs a hosted site may pull from. This is not a control that protects
// US — origin separation does that, and a VA's script is already running on the
// VA's own origin whatever it loads. It is here so a site that has been
// tampered with has fewer places to phone home from, and so the default answer
// to "can I use Tailwind" is yes rather than a support ticket.
const SCRIPT_CDNS = String(
    process.env.VA_SITES_SCRIPT_CDNS
    || 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com'
).trim();

// Frames a hosted site may open. The social embeds a VA actually uses.
const FRAME_SRC = String(
    process.env.VA_SITES_FRAME_SRC
    || 'https://www.instagram.com https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://discord.com'
).trim();

const hostLabelRe = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/* ---------------------------------------------------------------------------
 * LABELS A VA SITE MAY NOT HAVE
 *
 * VA sites are served under a domain of ours, so a VA's slug becomes one of our
 * hostnames. These are the ones that must stay ours: the names our own services
 * use or will use, the names mail and DNS use, and the names a person reads as
 * "this is Inflight" rather than "this is an airline on Inflight". An airline
 * whose slug is `login` would otherwise be handed `login.<our domain>`, which is
 * a phishing page we built for them.
 *
 * Refused at the HOST, not just at sign-up: a slug can be changed by staff in
 * the Crew Centers tool long after the site exists, and the check that matters
 * is the one on the request.
 *
 * `xn--` is in here as a prefix rule rather than a name: a punycode label is
 * how a homograph of one of these gets written, and no VA slug can produce one
 * (slugs are a-z, 0-9 and dashes), so nothing legitimate is lost.
 * ------------------------------------------------------------------------ */
const RESERVED_LABELS = new Set([
    // Us.
    'www', 'www2', 'inflight', 'app', 'apps', 'api', 'backend', 'server', 'origin',
    'admin', 'administrator', 'root', 'staff', 'internal', 'private', 'portal',
    'crew', 'crews', 'account', 'accounts', 'auth', 'oauth', 'sso', 'login',
    'signin', 'signup', 'register', 'id', 'my', 'me', 'user', 'users',
    // The product's own words, so a VA cannot take the name of a feature.
    'flight', 'flights', 'live', 'map', 'maps', 'track', 'tracker', 'events',
    'event', 'pilot', 'pilots', 'va', 'vas', 'sites', 'site', 'website',
    // Infrastructure and the things scanners look for.
    'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'uploads',
    'download', 'downloads', 'docs', 'doc', 'help', 'support', 'status',
    'blog', 'news', 'shop', 'store', 'pay', 'billing', 'checkout',
    'dev', 'test', 'testing', 'stage', 'staging', 'beta', 'preview', 'demo',
    'git', 'ci', 'build', 'deploy', 'vpn', 'proxy', 'gateway', 'edge',
    'db', 'sql', 'redis', 'cache', 'queue', 'metrics', 'grafana', 'kibana',
    'localhost', 'local', 'ipv4', 'ipv6',
    // Mail and DNS. A label here is not a website, it is a delivery failure.
    'mail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'webmail', 'exchange',
    'ns', 'ns1', 'ns2', 'ns3', 'ns4', 'dns', 'dmarc', 'dkim', 'spf',
    'autodiscover', 'autoconfig', 'cpanel', 'whm', 'ftp', 'sftp', 'ssh',
    // The addresses a certificate authority will mail to prove ownership.
    'postmaster', 'hostmaster', 'webmaster', 'abuse', 'security', 'noc',
    'ssl', 'tls', 'secure', 'acme',
]);

/** Is this label one a VA site may not occupy? */
function reservedLabel(label) {
    const l = String(label || '').toLowerCase();
    return RESERVED_LABELS.has(l) || l.startsWith('xn--');
}

/**
 * The VA label out of a Host header, or null when the request is not for a VA
 * site at all.
 *
 * Case-folded and de-ported first, because Host is attacker-controlled and
 * `EXAMPLE.VASITES.INFLIGHT.INFO:443` must not read as a different host from
 * the one the router matched. A label with a dot in it is refused rather than
 * flattened: `a.b.vasites.example` is somebody probing for a wildcard, not a
 * VA, and treating it as `a.b` would serve one VA's site under another's name.
 */
function parseSiteHost(rawHost, domain) {
    const d = String(domain || DOMAIN);
    if (!d) return null;
    let host = String(rawHost || '').trim().toLowerCase();
    if (!host) return null;
    host = host.replace(/:\d+$/, '');           // strip the port
    host = host.replace(/\.$/, '');             // and a fully-qualified trailing dot
    if (host === d) return '';                  // the apex — ours, but no VA
    if (!host.endsWith('.' + d)) return null;   // not our domain at all
    const label = host.slice(0, -(d.length + 1));
    if (!hostLabelRe.test(label)) return null;
    // Reserved reads as "not a VA host" rather than as "no such VA": a request
    // for www.<our domain> that reached this process is ours to answer, and
    // 404ing it here would take a platform hostname off the air the moment
    // somebody pointed it at this backend.
    if (reservedLabel(label)) return null;
    return label;
}

/** The public address of a VA's site, or '' when hosting is not configured. */
function siteUrlFor(slug) {
    const s = String(slug || '').trim().toLowerCase();
    if (!DOMAIN || !s || !hostLabelRe.test(s) || reservedLabel(s)) return '';
    return `https://${s}.${DOMAIN}`;
}

/* ---------------------------------------------------------------------------
 * The boot-time check.
 *
 * Both of these are decisions somebody makes in an environment file months
 * after reading the comment at the top of this module, so they are printed
 * rather than assumed.
 * ------------------------------------------------------------------------ */
function registrableGuess(host) {
    // Not a public-suffix list — this only has to be right enough to compare
    // two hosts we own. Last two labels, or three for the common two-part TLDs.
    const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
    if (parts.length < 2) return parts.join('.');
    const twoPart = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/;
    const lastTwo = parts.slice(-2).join('.');
    return twoPart.test(lastTwo) && parts.length >= 3 ? parts.slice(-3).join('.') : lastTwo;
}

function announceHostingConfig() {
    if (!DOMAIN) {
        console.log('ℹ️  VA site hosting is off (VA_SITES_DOMAIN unset).');
        return;
    }
    let platformHost = '';
    try { platformHost = new URL(CREW_BASE).hostname; } catch { /* leave blank */ }
    const shared = platformHost && registrableGuess(platformHost) === registrableGuess(DOMAIN);
    console.log(`✅ VA site hosting on *.${DOMAIN}`);

    // Sharing a registrable domain with the platform is the intended shape — a
    // VA gets an address with their own name on it, on a domain we run. What it
    // requires is that the session cookies carry the `__Host-` prefix, and that
    // prefix requires Secure, which this process only sets in production. So an
    // environment hosting VA sites without it is one where a VA's own script
    // could shadow a platform cookie, and that is worth a line at boot rather
    // than a paragraph in a file nobody opens.
    if (shared && process.env.NODE_ENV !== 'production') {
        console.warn(
            `⚠️  VA_SITES_DOMAIN (${DOMAIN}) shares the registrable domain `
            + `${registrableGuess(DOMAIN)} with the platform (${platformHost}), and NODE_ENV is not `
            + `"production", so session cookies are not Secure and cannot carry the __Host- prefix `
            + `that stops a VA's script setting a cookie at the parent domain. Fine on a laptop; `
            + `not fine anywhere a real VA can publish.`
        );
    }
    if (shared) {
        console.log(
            `   VA sites share ${registrableGuess(DOMAIN)} with the platform by design. `
            + `Cookie tossing is closed by the __Host- prefix on every session cookie, and platform `
            + `hostnames (www, api, login, mail…) are refused as VA labels.`
        );
    }
}

/* ===========================================================================
 * SERVING A HOSTED SITE
 *
 * Mounted BEFORE every other route, and it never calls next() once it has
 * recognised the host. That is not tidiness — this backend ends with
 * `app.use(express.static(__dirname))`, so a request on a VA host that fell
 * through would be answered out of the repository directory. Everything on a
 * VA host is answered here or 404s here.
 *
 * Nothing in this path reads a cookie, a session or an Authorization header. A
 * hosted site has no identity to us and there is nothing for it to be
 * authenticated as; the only credential that exists on this host is a preview
 * token in the URL, and it grants exactly one thing — the draft of the site
 * whose label is already in the Host header.
 * ======================================================================== */
function securityHeaders(res, { preview } = {}) {
    res.set('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        // 'self' rather than 'none': a VA framing their own pages is ordinary.
        // Nothing of ours can frame them and nothing of theirs can frame us.
        //
        // The exception is a PREVIEW, which the website builder shows in a
        // panel beside the editor — a VA arranging their homepage has to be
        // able to see it, and a design you have to open in another tab to look
        // at is a design nobody looks at while they work. Only the draft is
        // framed, never the published site: a preview URL carries a token that
        // expires in half an hour and is only ever handed to the VA who owns it,
        // whereas the live site stays unframeable by us or anyone.
        preview ? `frame-ancestors 'self' ${CREW_BASE}` : "frame-ancestors 'self'",
        "form-action 'self' https:",
        `script-src 'self' 'unsafe-inline' ${CREW_BASE} ${BACKEND_ORIGIN} ${SCRIPT_CDNS}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com " + SCRIPT_CDNS,
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' https: data: blob:",
        "media-src 'self' https:",
        `connect-src 'self' ${BACKEND_ORIGIN} ${CREW_BASE}`,
        `frame-src ${FRAME_SRC} ${CREW_BASE}`,
    ].join('; '));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()');
    // A hosted site is not part of the platform's CORS surface. Whatever the
    // app-wide `cors()` decided upstream, a VA site answers to its own origin
    // and nobody else's.
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    if (preview) res.set('X-Robots-Tag', 'noindex, nofollow');
}

const NOT_FOUND_HTML = (title, line) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1014;color:#eef1f6;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:2rem}
p{color:#9aa4b2;max-width:36ch}</style></head>
<body><div><h1>${title}</h1><p>${line}</p></div></body></html>`;

/**
 * The file a request path asks for.
 *
 * Static-host conventions, in one place so preview and published cannot drift:
 * '/' is index.html, a trailing slash is that folder's index.html, and an
 * extensionless path tries the file, then `.html`, then the folder's index.
 */
function pickFile(files, rawPath) {
    let p = String(rawPath || '/');
    try { p = decodeURIComponent(p); } catch { /* keep it as sent */ }
    p = p.replace(/^\/+/, '');
    const byPath = new Map(files.map(f => [f.path, f]));

    if (p === '' || p.endsWith('/')) return byPath.get(p + 'index.html') || null;
    if (byPath.has(p)) return byPath.get(p);
    if (!extOf(p)) {
        return byPath.get(p + '.html') || byPath.get(p + '/index.html') || null;
    }
    return null;
}

function sendFile(res, file, { preview } = {}) {
    securityHeaders(res, { preview });
    res.set('Content-Type', TYPES[extOf(file.path)] || 'text/plain; charset=utf-8');
    // Published files are cached briefly and revalidated; a draft never is.
    res.set('Cache-Control', preview ? 'no-store' : 'public, max-age=60, must-revalidate');
    res.send(file.content || '');
}

function mountVaSiteHost(app) {
    announceHostingConfig();
    if (!DOMAIN) return;

    app.use(async (req, res, next) => {
        const label = parseSiteHost(req.headers && req.headers.host);
        if (label === null) return next();     // not a VA host — the platform's own routes

        // From here down the request is answered, never forwarded.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            securityHeaders(res);
            return res.status(405).type('text/plain').send('This host only serves pages.');
        }
        if (label === '') {
            securityHeaders(res);
            return res.status(404).type('html')
                .send(NOT_FOUND_HTML('Nothing here', 'Virtual airline websites live on their own address under this domain.'));
        }

        try {
            const path0 = String(req.path || '/');
            const previewMatch = path0.match(PREVIEW_RE);

            const site = await CrewSite.findOne({ slug: label }).lean();
            if (!site) return notFound(res);

            if (previewMatch) {
                const token = previewMatch[1];
                const fresh = site.previewToken
                    && site.previewExpires && new Date(site.previewExpires) > new Date()
                    // Fixed-length compare: both sides come from the same
                    // alphabet and the same generator, so a length mismatch is
                    // a wrong token, not a reason to skip the constant-time
                    // path.
                    && token.length === site.previewToken.length
                    && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(site.previewToken));
                if (!fresh) {
                    securityHeaders(res, { preview: true });
                    return res.status(404).type('html')
                        .send(NOT_FOUND_HTML('Preview expired', 'Open a fresh preview from the Website tab of your VA portal.'));
                }
                const file = pickFile((site.draft && site.draft.files) || [], previewMatch[2] || '/');
                if (!file) return notFound(res, { preview: true });
                return sendFile(res, file, { preview: true });
            }

            // A site that is off, blocked, or has never been published answers
            // identically. "This site is disabled" is a sentence about a VA
            // that the VA did not ask us to publish on their own address.
            if (!site.enabled || site.blocked) return notFound(res);
            const files = (site.published && site.published.files) || [];
            if (!files.length) return notFound(res);

            const file = pickFile(files, path0);
            if (!file) {
                // A VA's own 404.html, if they wrote one.
                const own = files.find(f => f.path === '404.html');
                if (own) {
                    securityHeaders(res);
                    res.status(404).set('Content-Type', TYPES['.html']).set('Cache-Control', 'no-store');
                    return res.send(own.content || '');
                }
                return notFound(res);
            }
            return sendFile(res, file);
        } catch (err) {
            console.error('VA site serve error:', err && err.message);
            securityHeaders(res);
            return res.status(500).type('html')
                .send(NOT_FOUND_HTML('Temporarily unavailable', 'This is on our side, not the airline’s. Try again shortly.'));
        }
    });

    function notFound(res, opts) {
        securityHeaders(res, opts);
        res.set('Cache-Control', 'no-store');
        return res.status(404).type('html')
            .send(NOT_FOUND_HTML('Page not found', 'There is no page at this address.'));
    }
}

/* ===========================================================================
 * THE AUTHORING API
 *
 * Reads are open to any portal account; every write is owner-only, matching
 * every other mutation in vaPortal.js. A VA's website is the VA's public face
 * and publishing it is not a thing a representative account does by accident.
 * ======================================================================== */
const notConfigured = (res) => res.status(503).json({
    error: 'Website hosting is not switched on for this deployment.',
    code: 'hosting_off',
});

function publicFile(f) {
    return { path: f.path, bytes: f.bytes || bytesOf(f.content), updatedAt: f.updatedAt || null };
}

/** Draft and published, as the editor sees them. Content is included for the
 *  draft only: the editor edits the draft, and shipping both would double a
 *  response that is already the size of a website. */
function publicSite(site, va) {
    const draft = (site.draft && site.draft.files) || [];
    const published = (site.published && site.published.files) || [];
    const same = draft.length === published.length
        && draft.every((d) => {
            const p = published.find(x => x.path === d.path);
            return p && p.content === d.content;
        });
    return {
        url: siteUrlFor(site.slug || (va && va.slug)),
        slug: site.slug || (va && va.slug) || '',
        // Which design is laid out, and the theme on top of it — so the picker
        // can highlight the current one and the theme controls can open on the
        // values actually in force rather than on a design's defaults.
        template: site.template || '',
        theme: templates.normaliseTheme(site.theme, site.template || templates.DEFAULT_TEMPLATE),
        // How this site is authored, and the document behind it when it is
        // built rather than written. Sent on every read so the builder never
        // has to ask a second time for the thing it exists to edit.
        mode: site.mode === 'code' ? 'code' : 'design',
        builder: site.builder || null,
        enabled: !!site.enabled,
        blocked: !!site.blocked,
        blockedReason: site.blocked ? (site.blockedReason || '') : '',
        draft: {
            files: draft.map(f => ({ ...publicFile(f), content: f.content || '' })),
            updatedAt: (site.draft && site.draft.updatedAt) || null,
            updatedBy: (site.draft && site.draft.updatedBy) || '',
        },
        published: {
            files: published.map(publicFile),
            at: (site.published && site.published.at) || null,
            by: (site.published && site.published.by) || '',
            version: (site.published && site.published.version) || 0,
        },
        // The one thing the editor's Publish button needs to know.
        hasUnpublishedChanges: !same,
        versions: (site.versions || []).map(v => ({ version: v.version, at: v.at, by: v.by, files: (v.files || []).length })),
        limits: {
            files: MAX_FILES,
            fileBytes: MAX_FILE_BYTES,
            totalBytes: MAX_TOTAL_BYTES,
            types: Object.keys(TYPES),
            versions: MAX_VERSIONS,
        },
        usage: { files: draft.length, bytes: draft.reduce((n, f) => n + (f.bytes || 0), 0) },
    };
}

function registerVaSiteRoutes(app, { VirtualAirlineAd, requirePortal, requirePortalOwner, requireAuth, requireCap, logActivity }) {

    /* -----------------------------------------------------------------------
     * TWO DOORS, ONE IMPLEMENTATION
     *
     * A VA's website is edited in their crew centre, which is a different
     * front end signed in with a different session system: a bearer token from
     * crewAuth.js rather than the portal's cookie. The obvious way to serve it
     * is a second set of routes, and the obvious way is wrong — two copies of
     * publish, revert, restore and the limits is two copies that drift, and the
     * first thing to drift is a check.
     *
     * So there is one set of handlers, and the crew centre reaches them by
     * having its request REWRITTEN onto them once the crew token has been
     * checked. `/api/crew/<slug>/site/publish` becomes `/api/va-portal/site/
     * publish` with `req.siteActor` set, and everything after that point is the
     * same code answering the same way.
     *
     * Two details make it safe rather than clever:
     *
     *   - The rewrite happens ONLY after requireCap has passed, and requireCap
     *     resolves the VA from the slug in the URL and the vaId in the token —
     *     so the actor cannot be pointed at somebody else's site by editing the
     *     path.
     *   - req.siteActor is what the guards below skip on. Nothing else in this
     *     process sets it, and a request that arrives from the outside cannot:
     *     it is a property of the request object, not a header.
     * -------------------------------------------------------------------- */
    const CREW_SITE_RE = /^\/api\/crew\/([^/]+)\/site(\/.*)?$/;

    /** Whoever is editing: the portal account, or the crew-centre identity. */
    const actorOf = (req) => req.siteActor || req.portal || {};
    const actorName = (req) => {
        const a = actorOf(req);
        return a.username || a.name || '';
    };

    // The portal's own guards, skipped for a request that came through the crew
    // door — it was authenticated before it got here, by the other system.
    const anyEditor = (req, res, next) => (req.siteActor ? next() : requirePortal(req, res, next));
    const siteOwner = (req, res, next) => (req.siteActor ? next() : requirePortalOwner(req, res, next));

    if (typeof requireCap === 'function') {
        app.use(async (req, res, next) => {
            const cut = String(req.url || '').indexOf('?');
            const path0 = cut < 0 ? String(req.url || '') : String(req.url).slice(0, cut);
            const qs = cut < 0 ? '' : String(req.url).slice(cut);
            const m = CREW_SITE_RE.exec(path0);
            if (!m) return next();
            if (!DOMAIN) return notConfigured(res);

            let gate;
            try {
                gate = await requireCap(req, decodeURIComponent(m[1]), 'site.manage');
            } catch (err) {
                console.error('VA site crew gate error:', err && err.message);
                return res.status(500).json({ error: 'Could not check your access.' });
            }
            if (gate.error) {
                return res.status(gate.error).json({
                    error: gate.error === 401
                        ? 'Sign in to your crew centre.'
                        : 'Only an owner, or somebody they have given the website permission to, can edit the website.',
                });
            }
            req.siteActor = {
                vaAdId: gate.p.vaId,
                username: gate.p.name || gate.p.uname || '',
                name: gate.p.name || '',
                role: gate.p.role || 'owner',
                via: 'crew',
            };
            req.url = '/api/va-portal/site' + (m[2] || '') + qs;
            next();
        });
    }

    /* The VA behind a portal session, and its site row — created empty on
     * first look rather than by a separate "set up hosting" step nobody would
     * find. An empty row publishes nothing, so creating one costs a document
     * and changes what the world sees not at all. */
    async function siteFor(account) {
        const va = await VirtualAirlineAd.findById(account.vaAdId).select('name slug callsign status').lean();
        if (!va) return { error: 404, message: 'VA not found.' };
        if (!va.slug) {
            return {
                error: 409,
                message: 'Your crew centre does not have an address yet, and your website is served from it. Ask Inflight to set one.',
            };
        }
        // A website lives at <slug>.<our domain>, so a slug that is one of our
        // own hostnames cannot have one. Rare, fixable, and far better said here
        // than discovered as a site that will not load.
        if (reservedLabel(va.slug)) {
            return {
                error: 409,
                message: `Your crew centre's address is "${va.slug}", which is a name Inflight reserves for its own — so it cannot be a website address. Ask Inflight to change it and your site can go up.`,
            };
        }
        let site = await CrewSite.findOne({ vaAdId: va._id });
        if (!site) site = new CrewSite({ vaAdId: va._id, slug: va.slug });
        // The slug is the address. If staff moved it, the site moves with it.
        if (site.slug !== va.slug) site.slug = va.slug;
        return { va, site };
    }

    const fail = (res, r) => res.status(r.error).json({ error: r.message });

    // Mongoose gives a brand-new document its `draft` from the schema, but a
    // row written before this field existed has none. Every path that touches
    // the draft goes through here first so none of them has to remember.
    const ensureDraft = (site) => {
        if (!site.draft) site.draft = { files: [] };
        if (!Array.isArray(site.draft.files)) site.draft.files = [];
        return site.draft.files;
    };

    /* A site being built in the crew centre is rendered from its document on
     * every save, so a file written by hand would live until the next one and
     * then vanish. Refused rather than accepted-and-lost, and the code says
     * which route to use instead. */
    const designedSite = (site, res) => {
        if (site.mode === 'code') return false;
        res.status(409).json({
            error: 'This site is built in the website builder. Edit it there, or eject to files first.',
            code: 'designed',
        });
        return true;
    };

    const touchDraft = (site, account) => {
        site.draft = site.draft || {};
        site.draft.updatedAt = new Date();
        site.draft.updatedBy = account.username || account.name || '';
    };

    // --- Read ---------------------------------------------------------------
    app.get('/api/va-portal/site', anyEditor, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            if (r.site.isNew) await r.site.save();
            res.set('Cache-Control', 'no-store');
            res.json(publicSite(r.site.toObject ? r.site.toObject() : r.site, r.va));
        } catch (err) {
            console.error('VA site read error:', err);
            res.status(500).json({ error: 'Could not load your website.' });
        }
    });

    // --- Write one file -----------------------------------------------------
    app.put('/api/va-portal/site/file', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const named = cleanPath(req.body && req.body.path);
        if (named.error) return res.status(400).json({ error: named.error });
        const content = String((req.body && req.body.content) || '');
        const bytes = bytesOf(content);
        if (bytes > MAX_FILE_BYTES) {
            return res.status(413).json({ error: `That file is ${Math.round(bytes / 1024)} KB. The limit is ${Math.round(MAX_FILE_BYTES / 1024)} KB.` });
        }
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (designedSite(site, res)) return;
            const files = ensureDraft(site);
            const at = files.findIndex(f => f.path === named.path);

            if (at < 0 && files.length >= MAX_FILES) {
                return res.status(413).json({ error: `A site holds up to ${MAX_FILES} files.` });
            }
            const total = files.reduce((n, f) => n + (f.path === named.path ? 0 : (f.bytes || 0)), 0) + bytes;
            if (total > MAX_TOTAL_BYTES) {
                return res.status(413).json({ error: `That would take the site over ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB.` });
            }

            const row = { path: named.path, content, bytes, updatedAt: new Date() };
            if (at < 0) files.push(row); else files[at] = row;
            site.draft.files = files;
            touchDraft(site, actorOf(req));
            await site.save();
            res.json({ ok: true, file: publicFile(row), usage: { files: files.length, bytes: total } });
        } catch (err) {
            console.error('VA site write error:', err);
            res.status(500).json({ error: 'Could not save that file.' });
        }
    });

    // --- Delete one file ----------------------------------------------------
    app.delete('/api/va-portal/site/file', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const named = cleanPath(req.query && req.query.path);
        if (named.error) return res.status(400).json({ error: named.error });
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (designedSite(site, res)) return;
            const files = ensureDraft(site).filter(f => f.path !== named.path);
            site.draft.files = files;
            touchDraft(site, actorOf(req));
            await site.save();
            res.json({ ok: true, usage: { files: files.length, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0) } });
        } catch (err) {
            console.error('VA site delete error:', err);
            res.status(500).json({ error: 'Could not delete that file.' });
        }
    });

    /* --- The catalogue -----------------------------------------------------
     * What the picker draws. No file is rendered to answer this — it is names,
     * blurbs and a small drawn SVG of each layout, so the gallery costs one
     * request whatever a VA does next.
     *
     * On the portal session rather than public: it is a product surface, not a
     * fact about a VA, and there is no reason for it to be a URL anybody can
     * enumerate our designs from.
     * --------------------------------------------------------------------- */
    app.get('/api/va-portal/site/templates', anyEditor, (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        res.set('Cache-Control', 'private, max-age=300');
        // The designs AND the block vocabulary in one response: the builder
        // needs both before it can draw anything, and two requests to render
        // one screen is one request too many.
        res.json({ ...templates.catalogue(), builder: builder.catalogue() });
    });

    // --- Lay out a design ---------------------------------------------------
    app.post('/api/va-portal/site/starter', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const body = req.body || {};
        const wanted = String(body.template || '').trim();
        if (wanted && !templates.TEMPLATES[wanted]) {
            return res.status(400).json({ error: 'No such design.' });
        }
        const templateId = wanted || templates.DEFAULT_TEMPLATE;
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (designedSite(site, res)) return;
            const existing = ensureDraft(site);
            // Refuse to overwrite work. The editor asks first and sends
            // `replace` only once somebody has said yes out loud.
            if (existing.length && !(body.replace === true)) {
                return res.status(409).json({
                    error: 'Your draft already has files. Send replace:true to lay this design out over them.',
                    code: 'draft_not_empty',
                });
            }
            // A theme sent with the design wins; otherwise the design's own
            // accent, type and mode are used, which is what makes picking one a
            // single click rather than a form.
            const theme = templates.normaliseTheme(body.theme, templateId);
            site.draft.files = layOutTemplate(templateId, r.va, theme);
            site.template = templateId;
            site.theme = theme;
            touchDraft(site, actorOf(req));
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site starter error:', err);
            res.status(500).json({ error: 'Could not lay out that design.' });
        }
    });

    /* =====================================================================
     * THE BUILDER
     *
     * Everything above this point treats a site as files, because that is what
     * it is. These three routes are the other end of the same object: the
     * document a VA arranges in the crew centre, and the rule that the files
     * are rendered from it rather than edited alongside it.
     *
     * There is one invariant and it is worth stating plainly: IN DESIGN MODE
     * THE DOCUMENT IS THE SITE. Every save re-renders every page from it. So
     * nothing else may write to draft.files while a site is in design mode —
     * the file editor is refused below, not merely hidden in the UI — because a
     * hand edit that survived one save and vanished on the next is the worst
     * behaviour this feature could have.
     * ================================================================== */

    /** Render the document into the draft, with the same caps a hand-written
     *  site is held to. Returns an error object rather than throwing: a VA who
     *  has built a site too large for the quota needs to be told which limit,
     *  not handed a 500. */
    function applyBuilder(site, va, doc) {
        const files = builder.renderSite(doc, {
            va,
            templateId: site.template || templates.DEFAULT_TEMPLATE,
            theme: site.theme,
            feedSrc: `${CREW_BASE}/crew-feed.js`,
            crewBase: CREW_BASE,
        });
        if (files.length > MAX_FILES) {
            return { error: 413, message: `That is ${files.length} pages and files. A site holds up to ${MAX_FILES}.` };
        }
        const total = files.reduce((n, f) => n + f.bytes, 0);
        if (total > MAX_TOTAL_BYTES) {
            return { error: 413, message: `That would take the site over ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB. Shorten a page or use fewer of them.` };
        }
        const big = files.find(f => f.bytes > MAX_FILE_BYTES);
        if (big) {
            return { error: 413, message: `"${big.path}" is ${Math.round(big.bytes / 1024)} KB. One page can be ${Math.round(MAX_FILE_BYTES / 1024)} KB.` };
        }
        site.draft = site.draft || {};
        site.draft.files = files;
        return { files };
    }

    /* --- Save the document -------------------------------------------------
     * The whole document every time, not a patch. A page of blocks is small
     * (kilobytes), a VA edits one thing at a time, and the alternative —
     * per-block PATCH routes — buys nothing and costs an ordering bug the first
     * time somebody drags a section while a save is in flight.
     * --------------------------------------------------------------------- */
    app.put('/api/va-portal/site/builder', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (site.mode === 'code') {
                return res.status(409).json({
                    error: 'This site is edited as files now. The builder cannot write over them.',
                    code: 'ejected',
                });
            }
            ensureDraft(site);
            const ctx = builder.contextFor(r.va, { crewBase: CREW_BASE });
            const doc = builder.normaliseDoc(req.body && req.body.doc, ctx);
            if (!site.template) site.template = templates.DEFAULT_TEMPLATE;

            const applied = applyBuilder(site, r.va, doc);
            if (applied.error) return res.status(applied.error).json({ error: applied.message });

            site.builder = doc;
            site.mode = 'design';
            touchDraft(site, actorOf(req));
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site builder save error:', err);
            res.status(500).json({ error: 'Could not save your website.' });
        }
    });

    /* --- Pick a design -----------------------------------------------------
     * The reason the document holds no markup. Changing the design changes
     * style.css and re-renders the pages; every word the VA has written is in
     * the document and comes through untouched. A VA can try all six in a
     * minute and lose nothing, which is the difference between a design picker
     * and a decision.
     *
     * A site with no document yet gets the design's own starter content, so
     * picking one produces a page that already says something about this
     * airline rather than a blank canvas and an instruction.
     * --------------------------------------------------------------------- */
    app.post('/api/va-portal/site/design', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const body = req.body || {};
        const wanted = String(body.template || '').trim();
        if (wanted && !templates.TEMPLATES[wanted]) return res.status(400).json({ error: 'No such design.' });
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (site.mode === 'code') {
                return res.status(409).json({
                    error: 'This site is edited as files now. Changing the design here would overwrite them.',
                    code: 'ejected',
                });
            }
            ensureDraft(site);
            const templateId = wanted || site.template || templates.DEFAULT_TEMPLATE;
            site.template = templateId;
            // A design brings its own accent, type and mode. Sending a theme
            // with it keeps the VA's — which is what the theme controls do when
            // somebody changes design after having chosen a colour.
            site.theme = templates.normaliseTheme(
                body.keepTheme && site.theme && site.theme.accent ? site.theme : body.theme,
                templateId,
            );

            const doc = site.builder && Array.isArray(site.builder.pages) && site.builder.pages.length
                ? builder.normaliseDoc(site.builder, builder.contextFor(r.va, { crewBase: CREW_BASE }))
                : builder.starterDoc(templateId, r.va, { crewBase: CREW_BASE });

            const applied = applyBuilder(site, r.va, doc);
            if (applied.error) return res.status(applied.error).json({ error: applied.message });

            site.builder = doc;
            site.mode = 'design';
            touchDraft(site, actorOf(req));
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site design error:', err);
            res.status(500).json({ error: 'Could not switch to that design.' });
        }
    });

    /* --- Eject to the files ------------------------------------------------
     * One way, and said so before it happens. After this the document is dead
     * weight — kept, because throwing away the only record of what a VA built
     * to save a few kilobytes would be indefensible, but never rendered again.
     *
     * What a VA gets is exactly what was already live: the rendered files, now
     * theirs to edit. Nothing about their site changes at the moment they
     * eject, which is what makes it a safe thing to try.
     * --------------------------------------------------------------------- */
    app.post('/api/va-portal/site/eject', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (site.mode === 'code') return res.json(publicSite(site.toObject(), r.va));
            if (!ensureDraft(site).length) {
                return res.status(400).json({ error: 'There is nothing to edit yet — pick a design first.' });
            }
            if (req.body && req.body.confirm !== true) {
                return res.status(409).json({
                    error: 'Ejecting cannot be undone: the builder stops working on this site. Send confirm:true.',
                    code: 'confirm_required',
                });
            }
            site.mode = 'code';
            touchDraft(site, actorOf(req));
            await site.save();
            if (typeof logActivity === 'function') {
                logActivity({
                    vaAdId: r.va._id, vaName: r.va.name,
                    actorName: actorName(req), actorRole: actorOf(req).role,
                    action: 'Switched their website to files',
                    detail: 'The builder no longer writes this site.',
                });
            }
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site eject error:', err);
            res.status(500).json({ error: 'Could not switch to files.' });
        }
    });

    /* --- The theme ---------------------------------------------------------
     * Rewrites theme.css and nothing else. That is the whole reason the
     * templates keep every colour and family in one small file of custom
     * properties: recolouring a site is one file replaced, not a search and
     * replace across five, and a VA who has rewritten their markup completely
     * still gets working theme controls.
     *
     * It deliberately does NOT touch style.css or any page. A VA who has edited
     * their theme.css by hand loses those edits and is told so by the editor
     * before the request is sent — that is the trade for a picker that cannot
     * half-apply.
     * --------------------------------------------------------------------- */
    app.post('/api/va-portal/site/theme', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            const files = ensureDraft(site);
            if (!files.length) {
                return res.status(400).json({ error: 'Lay out a design first — there is nothing to re-colour yet.' });
            }
            const theme = templates.normaliseTheme(
                { ...(site.theme || {}), ...(req.body || {}) },
                site.template || templates.DEFAULT_TEMPLATE,
            );
            const content = templates.renderThemeCss(theme);
            const row = { path: 'theme.css', content, bytes: bytesOf(content), updatedAt: new Date() };
            const at = files.findIndex(f => f.path === 'theme.css');
            if (at < 0) files.push(row); else files[at] = row;

            site.draft.files = files;
            site.theme = theme;
            touchDraft(site, actorOf(req));
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site theme error:', err);
            res.status(500).json({ error: 'Could not change the theme.' });
        }
    });

    /* --- One block's markup ------------------------------------------------
     * For the editor's "Insert a section". Returns the HTML rather than writing
     * it: where it goes in the open file is the editor's business and the
     * cursor's, and a server that inserted it would have to guess.
     *
     * Every design uses the same class names, so a block rendered here looks
     * right in any of them — which is the point of the blocks being shared.
     * --------------------------------------------------------------------- */
    app.get('/api/va-portal/site/block/:id', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const html = templates.renderBlock(req.params.id, r.va, { crewBase: CREW_BASE });
            if (!html) return res.status(404).json({ error: 'No such section.' });
            res.json({ id: req.params.id, html });
        } catch (err) {
            console.error('VA site block error:', err);
            res.status(500).json({ error: 'Could not build that section.' });
        }
    });

    // --- Preview: a token, and the address to open it at ---------------------
    app.post('/api/va-portal/site/preview', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (!ensureDraft(site).length) {
                return res.status(400).json({ error: 'There is nothing in your draft to preview yet.' });
            }
            // A fresh token every time, so a preview link pasted in a Discord
            // channel a month ago is not a way into an unpublished draft.
            site.previewToken = crypto.randomBytes(24).toString('base64url');
            site.previewExpires = new Date(Date.now() + PREVIEW_TTL_MS);
            await site.save();
            res.set('Cache-Control', 'no-store');
            res.json({
                url: `${siteUrlFor(site.slug)}/${PREVIEW_PREFIX}/${site.previewToken}/`,
                expiresAt: site.previewExpires,
                minutes: Math.round(PREVIEW_TTL_MS / 60000),
            });
        } catch (err) {
            console.error('VA site preview error:', err);
            res.status(500).json({ error: 'Could not open a preview.' });
        }
    });

    // --- Publish ------------------------------------------------------------
    app.post('/api/va-portal/site/publish', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            if (site.blocked) {
                return res.status(403).json({ error: site.blockedReason || 'This website is on hold. Contact Inflight.' });
            }
            const draft = ensureDraft(site);
            if (!draft.some(f => f.path === 'index.html')) {
                return res.status(400).json({ error: 'A site needs an index.html — that is the page a visitor gets first.' });
            }

            const version = ((site.published && site.published.version) || 0) + 1;
            const snapshot = JSON.parse(JSON.stringify(draft));
            site.published = {
                files: snapshot,
                at: new Date(),
                by: actorName(req),
                version,
            };
            // Newest first, capped. A VA that publishes daily still has last
            // week, and the document does not grow without limit.
            site.versions = [{ version, at: site.published.at, by: site.published.by, files: snapshot }]
                .concat(site.versions || []).slice(0, MAX_VERSIONS);
            await site.save();

            if (typeof logActivity === 'function') {
                logActivity({
                    vaAdId: r.va._id, vaName: r.va.name,
                    actorName: actorName(req), actorRole: actorOf(req).role,
                    action: 'Published website',
                    detail: `${siteUrlFor(site.slug)} — v${version}, ${snapshot.length} file(s)`,
                });
            }
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site publish error:', err);
            res.status(500).json({ error: 'Could not publish.' });
        }
    });

    // --- Put the draft back to what is live ---------------------------------
    app.post('/api/va-portal/site/revert', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            const live = (site.published && site.published.files) || [];
            if (!live.length) return res.status(400).json({ error: 'Nothing has been published yet, so there is nothing to go back to.' });
            ensureDraft(site);
            site.draft.files = JSON.parse(JSON.stringify(live));
            touchDraft(site, actorOf(req));
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site revert error:', err);
            res.status(500).json({ error: 'Could not put the draft back.' });
        }
    });

    // --- Restore an older published version into the draft -------------------
    app.post('/api/va-portal/site/restore', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const version = Number(req.body && req.body.version);
        if (!isFinite(version)) return res.status(400).json({ error: 'Say which version.' });
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            const site = r.site;
            const snap = (site.versions || []).find(v => v.version === version);
            if (!snap) return res.status(404).json({ error: 'That version is no longer kept.' });
            ensureDraft(site);
            // Into the DRAFT, not straight to live. Restoring is an edit like
            // any other; making it a publish would mean a mis-click changes
            // what the world sees with nothing in between.
            site.draft.files = JSON.parse(JSON.stringify(snap.files || []));
            touchDraft(site, actorOf(req));
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site restore error:', err);
            res.status(500).json({ error: 'Could not restore that version.' });
        }
    });

    // --- The VA's own on/off switch -----------------------------------------
    app.post('/api/va-portal/site/enabled', siteOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(actorOf(req));
            if (r.error) return fail(res, r);
            r.site.enabled = !!(req.body && req.body.enabled);
            await r.site.save();
            res.json(publicSite(r.site.toObject(), r.va));
        } catch (err) {
            console.error('VA site toggle error:', err);
            res.status(500).json({ error: 'Could not change that.' });
        }
    });

    /* ---------------------------------------------------------------------
     * Inflight-side moderation.
     *
     * We serve these pages on our own domain, so "the VA wrote it" is not an
     * answer we can give anybody about what is on one. `blocked` is the switch
     * that takes a site down and keeps it down: it outranks the VA's own
     * `enabled`, refuses further publishing, and records why.
     * ------------------------------------------------------------------- */
    app.get('/api/crew-admin/sites', requireAuth, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const rows = await CrewSite.find({})
                .select('vaAdId slug enabled blocked blockedReason published.at published.version draft.updatedAt')
                .sort({ 'published.at': -1 }).limit(500).lean();
            const ads = await VirtualAirlineAd.find({ _id: { $in: rows.map(r => r.vaAdId) } })
                .select('name callsign').lean();
            const named = new Map(ads.map(a => [String(a._id), a]));
            res.json({
                domain: DOMAIN,
                sites: rows.map(r => {
                    const a = named.get(String(r.vaAdId)) || {};
                    return {
                        id: r._id, vaAdId: r.vaAdId, name: a.name || '', callsign: a.callsign || '',
                        slug: r.slug, url: siteUrlFor(r.slug),
                        enabled: !!r.enabled, blocked: !!r.blocked, blockedReason: r.blockedReason || '',
                        publishedAt: (r.published && r.published.at) || null,
                        version: (r.published && r.published.version) || 0,
                        draftUpdatedAt: (r.draft && r.draft.updatedAt) || null,
                    };
                }),
            });
        } catch (err) {
            console.error('VA sites list error:', err);
            res.status(500).json({ error: 'Could not list the websites.' });
        }
    });

    app.patch('/api/crew-admin/sites/:id', requireAuth, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const site = await CrewSite.findById(req.params.id);
            if (!site) return res.status(404).json({ error: 'No such website.' });
            if (req.body && req.body.blocked !== undefined) {
                site.blocked = !!req.body.blocked;
                site.blockedReason = site.blocked ? String((req.body && req.body.reason) || '').slice(0, 300) : '';
                site.blockedAt = site.blocked ? new Date() : null;
            }
            await site.save();
            res.json({ ok: true, blocked: site.blocked, blockedReason: site.blockedReason });
        } catch (err) {
            console.error('VA site moderate error:', err);
            res.status(500).json({ error: 'Could not change that.' });
        }
    });
}

module.exports = {
    CrewSite,
    MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_VERSIONS, PREVIEW_TTL_MS,
    TYPES, PREVIEW_PREFIX, DOMAIN,
    cleanPath, extOf, bytesOf, layOutTemplate,
    parseSiteHost, siteUrlFor, pickFile, registrableGuess,
    RESERVED_LABELS, reservedLabel,
    mountVaSiteHost, registerVaSiteRoutes,
};

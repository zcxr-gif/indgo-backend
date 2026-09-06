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
 * cookie of ours — every cookie this platform sets is host-only (no `Domain`
 * attribute; see setAuthCookie in vaPortal.js and staffAuth.js), so none of
 * them is sent to a subdomain.
 *
 * WHY A SEPARATE DOMAIN WOULD STILL BE BETTER
 * -------------------------------------------
 * `<slug>.vasites.inflight.info` is a separate ORIGIN but not a separate SITE:
 * it shares the registrable domain inflight.info. That leaves one real gap.
 * A VA's script can write `document.cookie = 'x=1; domain=inflight.info'` and
 * have it sent to inflight.info on every subsequent request — cookie tossing.
 * It cannot READ our cookies (they are httpOnly, and a shadowing cookie does
 * not reveal the one it shadows), but it can shadow one and make a session
 * behave oddly.
 *
 * The fix is a VA_SITES_DOMAIN on a registrable domain we own that is NOT the
 * platform's, e.g. `inflightva.site`. Point VA_SITES_DOMAIN at one and nothing
 * in this file changes. Until then announceHostingConfig() says so at
 * boot, once, loudly, because a warning nobody prints is a decision nobody made.
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

    // Short-lived preview credential. The site host has no session — that is
    // the point of it — so a token in the URL is the only way to show a VA
    // their unpublished draft on the origin it will actually run on.
    previewToken: { type: String, default: '' },
    previewExpires: Date,

    createdAt: { type: Date, default: Date.now },
}, { minimize: false });

const CrewSite = mongoose.models.CrewSite || mongoose.model('CrewSite', CrewSiteSchema);

/* ===========================================================================
 * THE STARTER
 *
 * A VA that opens an empty editor writes nothing. This is a working airline
 * homepage — a hero, a figures band, a network list, a noticeboard and events —
 * with every live number already wired to crew-feed.js, so the first thing a VA
 * does is change the words rather than work out the plumbing.
 *
 * Plain HTML and CSS, no build step and no framework, on purpose. A VA staff
 * member with an afternoon and a search engine can edit it; a VA with a
 * developer can throw it away.
 * ======================================================================== */
function starterFiles(va, feedSrc, crewBase) {
    const name = String((va && va.name) || 'Our Virtual Airline');
    const slug = String((va && va.slug) || '');
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const crew = `${crewBase}/crew/${esc(slug)}`;

    const index = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>

<header class="bar">
  <b>${esc(name)}</b>
  <nav>
    <a href="/fleet.html">Fleet</a>
    <a href="${crew}">Crew centre</a>
    <a class="cta" href="${crew}/join">Apply</a>
  </nav>
</header>

<main>

  <section class="hero">
    <h1>Fly with ${esc(name)}.</h1>
    <p>Write the sentence here that says what your airline is for. One sentence.
       The numbers below look after themselves.</p>
    <a class="cta" href="${crew}/join">Apply to fly</a>
  </section>

  <!-- FIGURES.
       Each number is written into the page by crew-feed.js from your crew
       centre. Type a true fallback between the tags: if the feed is quiet the
       page keeps what you wrote, and a figure the crew centre does not have is
       REMOVED along with its label rather than printed as 0. -->
  <section class="figures">
    <div data-crew-figure><b data-crew-stat="pilots">&mdash;</b><span>pilots</span></div>
    <div data-crew-figure><b data-crew-stat="hours" data-crew-suffix="+">&mdash;</b><span>hours flown</span></div>
    <div data-crew-figure><b data-crew-stat="destinations">&mdash;</b><span>destinations</span></div>
    <div data-crew-figure><b data-crew-stat="routesActive">&mdash;</b><span>routes</span></div>
  </section>

  <!-- THE NETWORK. One copy of the <template> per row, filled from your
       published routes. Anything in {{ }} is escaped on the way in, so a note
       somebody typed in the crew centre can never write HTML into this page. -->
  <section>
    <h2>Where we fly</h2>
    <ul class="rows" data-crew-list="routes" data-crew-limit="12">
      <template><li><b>{{from}} &rarr; {{to}}</b> <span>{{flight}} &middot; {{ac}}</span></li></template>
      <li>Add your sectors in the crew centre and they appear here.</li>
    </ul>
  </section>

  <!-- WHAT WE HAVE BEEN DOING. The rows your crew centre writes by itself —
       a pilot joined, somebody was promoted, an event went up. -->
  <section>
    <h2>Lately</h2>
    <ul class="rows" data-crew-list="activity" data-crew-limit="6">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>

  <!-- THE NOTICEBOARD, the written half only. Drop data-crew-written to get
       the whole board including the automatic rows above. -->
  <section>
    <h2>Notices</h2>
    <ul class="rows" data-crew-list="notices" data-crew-written="on" data-crew-limit="4">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>

  <!-- THE NEXT DEPARTURES. -->
  <section>
    <h2>Events</h2>
    <ul class="rows" data-crew-list="events" data-crew-limit="4">
      <template><li><b>{{title}}</b> <span>{{from}} &rarr; {{to}}</span></li></template>
    </ul>
  </section>

</main>

<footer>
  <p>${esc(name)} is a virtual airline on Infinite Flight. Not affiliated with any real-world carrier.</p>
  <p>Crew centre hosted by <a href="${crewBase}">Inflight</a>.</p>
</footer>

<!-- The feed. One line: it reads your crew centre and fills in everything
     marked up above. No key, nothing to keep secret, and every endpoint it
     reads is the same public one a visitor to your crew centre reads. -->
<script src="${feedSrc}" data-va="${esc(slug)}"></script>
</body>
</html>
`;

    const fleet = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet &mdash; ${esc(name)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="bar">
  <b><a href="/">${esc(name)}</a></b>
  <nav><a href="/">Home</a></nav>
</header>
<main>
  <section class="hero"><h1>The fleet</h1></section>
  <section>
    <!-- Your fleet, written here. It is the one list the crew centre does not
         publish on a public endpoint, so it stays yours to keep true. -->
    <ul class="rows">
      <li><b>Aircraft type</b> <span>What you use it for</span></li>
    </ul>
  </section>
</main>
<footer><p><a href="/">Back</a></p></footer>
<script src="${feedSrc}" data-va="${esc(slug)}"></script>
</body>
</html>
`;

    const css = `/* ${name} — everything the pages look like, in one file.
   Plain CSS on purpose: no build step, no framework, nothing to install. */

:root {
  --ink: #16181d;
  --muted: #5c6470;
  --line: #e4e7ec;
  --bg: #ffffff;
  --accent: #14375e;      /* change this one line to re-colour the whole site */
}
@media (prefers-color-scheme: dark) {
  :root { --ink:#eef1f6; --muted:#9aa4b2; --line:#272b33; --bg:#0e1014; --accent:#7fa6e8; }
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--accent); }

.bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 1rem clamp(1rem, 4vw, 3rem);
  border-bottom: 1px solid var(--line);
}
.bar b a { text-decoration: none; color: inherit; }
.bar nav { display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: center; }
.bar nav a { text-decoration: none; font-size: .92rem; }

main { max-width: 62rem; margin: 0 auto; padding: 0 clamp(1rem, 4vw, 3rem); }
section { padding: clamp(2.5rem, 6vw, 4.5rem) 0; border-bottom: 1px solid var(--line); }
h1 { font-size: clamp(2rem, 6vw, 3.4rem); line-height: 1.1; margin: 0 0 1rem; letter-spacing: -.02em; }
h2 { font-size: 1.25rem; margin: 0 0 1.2rem; letter-spacing: -.01em; }
.hero p { color: var(--muted); max-width: 48ch; font-size: 1.1rem; }

.cta {
  display: inline-block; margin-top: 1.4rem; padding: .8rem 1.4rem;
  background: var(--accent); color: var(--bg); border-radius: 8px;
  text-decoration: none; font-weight: 600;
}
.bar .cta { margin: 0; padding: .45rem .9rem; font-size: .88rem; }

/* The figures band. A figure the crew centre did not send takes its whole
   block with it, which is why the label lives inside the same element. */
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1.5rem; }
.figures > div { display: grid; gap: .2rem; }
.figures b { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1; letter-spacing: -.03em; }
.figures span { color: var(--muted); font-size: .9rem; }

.rows { list-style: none; margin: 0; padding: 0; }
.rows li {
  display: flex; flex-wrap: wrap; gap: .2rem 1rem; align-items: baseline;
  padding: .85rem 0; border-top: 1px solid var(--line);
}
.rows li:last-child { border-bottom: 1px solid var(--line); }
.rows span { color: var(--muted); font-size: .92rem; }

footer {
  max-width: 62rem; margin: 0 auto; padding: 2.5rem clamp(1rem, 4vw, 3rem) 4rem;
  color: var(--muted); font-size: .86rem;
}
footer p { margin: .3rem 0; }
`;

    const readme = `# ${name} — your website

You write this site. We serve it. The numbers come from your crew centre.

## The files

- \`index.html\` — the homepage
- \`fleet.html\` — a second page, as an example of adding one
- \`style.css\` — everything the pages look like

Add files in the editor. \`index.html\` is what a visitor gets at \`/\`, and a
folder's \`index.html\` is what they get at that folder.

## Where the numbers come from

The last line of each page loads \`crew-feed.js\` with your VA's address. It
reads your crew centre's public endpoints and fills in anything marked up with
\`data-crew-*\`:

- \`<b data-crew-stat="pilots">\` — a figure. Wrap it and its label in
  \`data-crew-figure\` and the whole block disappears when the figure does not
  arrive, rather than leaving a dash next to a label.
- \`<ul data-crew-list="routes">\` with a \`<template>\` inside — a list, one
  copy of the template per row. Lists available: \`routes\`, \`events\`,
  \`schedule\`, \`notices\`, \`activity\`, \`posts\`.
- \`data-crew-limit\` caps how many rows. \`data-crew-written="on"\` narrows
  \`notices\` to what a person actually typed.

Write a true fallback inside the markup. If the feed is quiet the page keeps
what you wrote — it never goes blank because a request timed out.

You can read the feed yourself too: \`await CrewFeed.routes()\`,
\`CrewFeed.stats()\`, \`CrewFeed.posts()\`. Every one resolves to \`null\`
rather than throwing, and \`null\` means "leave the page alone".

## What you can put here

Text files: \`.html\`, \`.css\`, \`.js\`, \`.json\`, \`.svg\`, \`.txt\`,
\`.md\`, \`.xml\`, \`.webmanifest\`. Up to ${MAX_FILES} files,
${Math.round(MAX_FILE_BYTES / 1024)} KB each, ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB in total.

Images are not stored here — put them on an \`https://\` URL and link to them.
Your logo and banner already have URLs; the VA Profile tab shows them.

## What your code can reach

Your site runs on its own address, separate from ours. Your JavaScript can call
your own VA's public crew endpoints — the same ones any visitor to your crew
centre reads — and nothing else of ours. There is no key in this site and
nothing in it is secret, so you can paste it anywhere.

## Publishing

**Save** writes to your draft. **Preview** shows the draft on the real address.
**Publish** makes the draft live. The last ${MAX_VERSIONS} published versions are kept, so
publishing something broken is not a disaster.
`;

    return [
        { path: 'index.html', content: index },
        { path: 'fleet.html', content: fleet },
        { path: 'style.css', content: css },
        { path: 'README.md', content: readme },
    ].map(f => ({ path: f.path, content: f.content, bytes: bytesOf(f.content), updatedAt: new Date() }));
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
    return label;
}

/** The public address of a VA's site, or '' when hosting is not configured. */
function siteUrlFor(slug) {
    const s = String(slug || '').trim().toLowerCase();
    if (!DOMAIN || !s || !hostLabelRe.test(s)) return '';
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
    if (shared) {
        console.warn(
            `⚠️  VA_SITES_DOMAIN (${DOMAIN}) shares a registrable domain with the platform `
            + `(${platformHost}). VA sites are still a separate ORIGIN — their script cannot read `
            + `our storage, our DOM or our cookies (every cookie here is host-only). But a VA's `
            + `script CAN set a cookie scoped to ${registrableGuess(DOMAIN)} and have it sent to `
            + `the platform: cookie tossing. Moving VA_SITES_DOMAIN to a registrable domain we own `
            + `that is not the platform's closes that, and needs no code change.`
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
        "frame-ancestors 'self'",
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

function registerVaSiteRoutes(app, { VirtualAirlineAd, requirePortal, requirePortalOwner, requireAuth, logActivity }) {

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

    const touchDraft = (site, account) => {
        site.draft = site.draft || {};
        site.draft.updatedAt = new Date();
        site.draft.updatedBy = account.username || account.name || '';
    };

    // --- Read ---------------------------------------------------------------
    app.get('/api/va-portal/site', requirePortal, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(req.portal);
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
    app.put('/api/va-portal/site/file', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const named = cleanPath(req.body && req.body.path);
        if (named.error) return res.status(400).json({ error: named.error });
        const content = String((req.body && req.body.content) || '');
        const bytes = bytesOf(content);
        if (bytes > MAX_FILE_BYTES) {
            return res.status(413).json({ error: `That file is ${Math.round(bytes / 1024)} KB. The limit is ${Math.round(MAX_FILE_BYTES / 1024)} KB.` });
        }
        try {
            const r = await siteFor(req.portal);
            if (r.error) return fail(res, r);
            const site = r.site;
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
            touchDraft(site, req.portal);
            await site.save();
            res.json({ ok: true, file: publicFile(row), usage: { files: files.length, bytes: total } });
        } catch (err) {
            console.error('VA site write error:', err);
            res.status(500).json({ error: 'Could not save that file.' });
        }
    });

    // --- Delete one file ----------------------------------------------------
    app.delete('/api/va-portal/site/file', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const named = cleanPath(req.query && req.query.path);
        if (named.error) return res.status(400).json({ error: named.error });
        try {
            const r = await siteFor(req.portal);
            if (r.error) return fail(res, r);
            const site = r.site;
            const files = ensureDraft(site).filter(f => f.path !== named.path);
            site.draft.files = files;
            touchDraft(site, req.portal);
            await site.save();
            res.json({ ok: true, usage: { files: files.length, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0) } });
        } catch (err) {
            console.error('VA site delete error:', err);
            res.status(500).json({ error: 'Could not delete that file.' });
        }
    });

    // --- Seed the starter ---------------------------------------------------
    app.post('/api/va-portal/site/starter', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(req.portal);
            if (r.error) return fail(res, r);
            const site = r.site;
            const existing = ensureDraft(site);
            // Refuse to overwrite work. The editor asks first and sends
            // `replace` only once somebody has said yes out loud.
            if (existing.length && !(req.body && req.body.replace === true)) {
                return res.status(409).json({
                    error: 'Your draft already has files. Send replace:true to start it over from the template.',
                    code: 'draft_not_empty',
                });
            }
            site.draft.files = starterFiles(r.va, `${CREW_BASE}/crew-feed.js`, CREW_BASE);
            touchDraft(site, req.portal);
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site starter error:', err);
            res.status(500).json({ error: 'Could not lay out the template.' });
        }
    });

    // --- Preview: a token, and the address to open it at ---------------------
    app.post('/api/va-portal/site/preview', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(req.portal);
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
    app.post('/api/va-portal/site/publish', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(req.portal);
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
                by: req.portal.username || req.portal.name || '',
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
                    actorName: req.portal.username, actorRole: req.portal.role,
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
    app.post('/api/va-portal/site/revert', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(req.portal);
            if (r.error) return fail(res, r);
            const site = r.site;
            const live = (site.published && site.published.files) || [];
            if (!live.length) return res.status(400).json({ error: 'Nothing has been published yet, so there is nothing to go back to.' });
            ensureDraft(site);
            site.draft.files = JSON.parse(JSON.stringify(live));
            touchDraft(site, req.portal);
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site revert error:', err);
            res.status(500).json({ error: 'Could not put the draft back.' });
        }
    });

    // --- Restore an older published version into the draft -------------------
    app.post('/api/va-portal/site/restore', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        const version = Number(req.body && req.body.version);
        if (!isFinite(version)) return res.status(400).json({ error: 'Say which version.' });
        try {
            const r = await siteFor(req.portal);
            if (r.error) return fail(res, r);
            const site = r.site;
            const snap = (site.versions || []).find(v => v.version === version);
            if (!snap) return res.status(404).json({ error: 'That version is no longer kept.' });
            ensureDraft(site);
            // Into the DRAFT, not straight to live. Restoring is an edit like
            // any other; making it a publish would mean a mis-click changes
            // what the world sees with nothing in between.
            site.draft.files = JSON.parse(JSON.stringify(snap.files || []));
            touchDraft(site, req.portal);
            await site.save();
            res.json(publicSite(site.toObject(), r.va));
        } catch (err) {
            console.error('VA site restore error:', err);
            res.status(500).json({ error: 'Could not restore that version.' });
        }
    });

    // --- The VA's own on/off switch -----------------------------------------
    app.post('/api/va-portal/site/enabled', requirePortalOwner, async (req, res) => {
        if (!DOMAIN) return notConfigured(res);
        try {
            const r = await siteFor(req.portal);
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
    cleanPath, extOf, bytesOf, starterFiles,
    parseSiteHost, siteUrlFor, pickFile, registrableGuess,
    mountVaSiteHost, registerVaSiteRoutes,
};

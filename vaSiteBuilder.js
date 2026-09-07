'use strict';

/*
 * vaSiteBuilder.js
 * The visual half of a virtual airline's website: what a VA arranges, as
 * opposed to what we serve.
 *
 * WHY THIS EXISTS
 * ---------------
 * vaSites.js stores and serves FILES, and vaSiteTemplates.js writes a set of
 * them from a design. That is the whole product for a VA who can write HTML,
 * and it is nothing at all for one who cannot — which is most of them. A VA
 * that wants a website is not asking to author a document; they are asking for
 * their airline to have a page with their words on it.
 *
 * So this file adds the layer above the files: a SITE DOCUMENT — pages, and on
 * each page an ordered list of blocks with the VA's own text in them — plus a
 * renderer that turns that document into exactly the files vaSites.js already
 * knows how to store, preview, publish and roll back. Nothing downstream of
 * here learns that the builder exists.
 *
 * THE THREE RULES
 * ---------------
 * 1. CONTENT AND DESIGN ARE SEPARATE. The document holds words and choices; the
 *    template holds the look. That is what makes "try another design" keep every
 *    word a VA has written instead of asking them to type it again — the single
 *    most useful thing about building a site this way, and the reason the
 *    document does not contain a byte of HTML.
 *
 * 2. THE MARKUP IS THE TEMPLATES' MARKUP. Every block here renders the same
 *    class names and the same data-crew-* hooks as its counterpart in
 *    vaSiteTemplates.js. Six stylesheets already produce six designs over that
 *    markup, and crew-feed.js already fills it in. A second vocabulary would
 *    mean a block that looks right in the builder and wrong in the design.
 *
 * 3. NOTHING A VA TYPES REACHES A PAGE UNESCAPED. A builder block is text in a
 *    form, not markup — so every value goes through esc() on the way out and
 *    every link through linkUrl(). A VA who wants to write real HTML ejects to
 *    the file editor, which is a decision they make out loud.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Anything that reads the database, the clock or the network. Same split as
 * crewLinks.js and crewDocs.js: this file makes decisions and strings, its
 * caller does the I/O, and its tests need neither.
 */

const templates = require('./vaSiteTemplates');

/* ---------------------------------------------------------------------------
 * LIMITS
 *
 * Not arbitrary: a page of thirty sections is a page nobody scrolls, and a
 * document that can grow without limit is a document that eventually will not
 * save. Every one of these is checked here rather than trusted from the editor.
 * ------------------------------------------------------------------------ */
const MAX_PAGES = 12;
const MAX_BLOCKS = 30;
const MAX_ITEMS = 24;
const MAX_LINE = 200;
const MAX_TEXT = 4000;

const PAGE_PATH_RE = /^[a-z0-9][a-z0-9-]{0,40}\.html$/;

/* Control characters, stripped from everything on the way in. A tab or a
 * carriage return inside a URL is removed by the browser before it navigates,
 * so "java\tscript:x" IS a javascript: URL by the time it matters — a check
 * that ran before this one would see an unrecognised scheme and wave it past.
 * The same range is stripped from single-line text so a label cannot carry a
 * newline into an attribute. */
const CONTROL = /[\x00-\x1F\x7F]/g;

const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const line = (v, max) => String(v == null ? '' : v).replace(CONTROL, ' ').trim().slice(0, max || MAX_LINE);
const text = (v) => String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
    .trim().slice(0, MAX_TEXT);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const num = (v, lo, hi, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const pick = (v, list, fallback) => (list.includes(String(v)) ? String(v) : fallback);

/**
 * A link we are willing to put in an href.
 *
 * Relative paths stay relative — a builder site links to its own other pages
 * constantly and forcing those absolute would break the moment a VA's slug
 * changes. Everything else must parse as http(s) with a host, which is the
 * same bar crewLinks.safeUrl sets and for the same reason: the string in an
 * href is typed by a person, and `javascript:` is a valid thing to type.
 */
function linkUrl(raw, fallback) {
    const s = String(raw == null ? '' : raw).replace(CONTROL, '').trim();
    if (!s) return fallback || '';
    if (s.length > 2000) return fallback || '';
    // In-site links are kept RELATIVE, never rooted at "/".
    //
    // The same rendered file is served at two addresses — the airline's own
    // subdomain and inflight.info/va/<slug>/ — and a link to "/fleet.html"
    // means the platform's root at the second one. A relative "fleet.html"
    // resolves under whichever address the page was opened at, so a VA typing
    // either form gets the one that works in both places.
    if (/^#[^\s]*$/.test(s)) return s;
    if (s === '/') return './';
    if (s.startsWith('/') && !s.startsWith('//')) return s.replace(/^\/+/, '');
    let parsed;
    try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s); } catch { return fallback || ''; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback || '';
    if (!parsed.hostname) return fallback || '';
    return parsed.href;
}

/** An image address. Same rules as a link, minus the relative case — an image
 *  is not stored with the site (there is no upload here), so it is somewhere
 *  else on the web or it is nothing. */
function imageUrl(raw) {
    const s = String(raw == null ? '' : raw).replace(CONTROL, '').trim();
    if (!s) return '';
    let parsed;
    try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s); } catch { return ''; }
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname ? parsed.href : '';
}

/** Paragraphs out of a textarea. A blank line starts a new one; a single
 *  newline is a line break inside one, because that is what people mean when
 *  they press return once. */
function prose(body, cls) {
    return String(body || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        .map(p => `    <p class="${cls || 'prose'}">${esc(p).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

/* ===========================================================================
 * THE BLOCK VOCABULARY
 *
 * Each entry is four things: what to call it in the picker, the fields the
 * editor draws a form from, what a fresh one contains, and how it renders.
 *
 * `fields` is the whole reason the editor has no per-block code. A new block
 * type is a row in this object — the crew centre's builder grows a form for it
 * with no change on the front end at all. That is the same trick
 * CREW_CAPABILITIES plays in crewAuth.js, and it is worth the discipline of
 * keeping every block describable that way.
 *
 * FIELD TYPES
 *   line     one line of text
 *   text     several lines; a blank line starts a paragraph
 *   url      a link; relative paths kept, everything else must be http(s)
 *   image    an https image address
 *   bool     a switch
 *   number   a whole number between min and max
 *   select   one of `options`
 *   list     repeatable rows of `of` (which is itself a field list)
 *
 * LIVE BLOCKS vs WRITTEN BLOCKS. A block marked `live: true` is filled in from
 * the crew centre by crew-feed.js — the VA chooses the heading and how many
 * rows, and never types the rows. That distinction is surfaced in the editor,
 * because "why can't I edit this list" is the first question a VA asks about
 * one, and the answer — it is your crew centre, change it there and it changes
 * here — is the entire point of the feature.
 * ======================================================================== */
const BLOCKS = {

    hero: {
        label: 'Hero',
        note: 'The top of the page: a headline, one sentence, and the apply button.',
        icon: 'panel-top',
        fields: [
            { key: 'eyebrow', label: 'Small line above', type: 'line', placeholder: 'BAW · Infinite Flight' },
            { key: 'headline', label: 'Headline', type: 'line', placeholder: 'Fly with us.' },
            { key: 'lede', label: 'One sentence', type: 'text', help: 'What your airline is for, in your own words.' },
            { key: 'ctaLabel', label: 'Button', type: 'line', placeholder: 'Apply to fly' },
            { key: 'ctaHref', label: 'Button goes to', type: 'url', help: 'Left empty, it goes to your join page.' },
            { key: 'banner', label: 'Use your banner as the background', type: 'bool' },
        ],
        defaults: (c) => ({
            eyebrow: `${c.callsign || 'Virtual airline'} · Infinite Flight`,
            headline: `Fly with ${c.name}.`,
            lede: 'One sentence about what your airline is for. The numbers underneath look after themselves.',
            ctaLabel: 'Apply to fly',
            ctaHref: '',
            banner: true,
        }),
        render: (p, c) => `
  <section class="hero">${p.banner ? `
    <div class="hero__bg" data-crew-figure hidden>
      <img data-crew-brand="banner" alt="" loading="eager" decoding="async">
    </div>` : ''}
    <div class="hero__in">${p.eyebrow ? `
      <p class="eyebrow">${esc(p.eyebrow)}</p>` : ''}
      <h1>${esc(p.headline)}</h1>${p.lede ? `
${prose(p.lede, 'lede')}` : ''}${p.ctaLabel ? `
      <a class="cta" href="${esc(linkUrl(p.ctaHref, c.join))}">${esc(p.ctaLabel)}</a>` : ''}
    </div>
  </section>`,
    },

    figures: {
        label: 'Live figures',
        note: 'Pilots, hours, destinations — read from your crew centre, never typed.',
        icon: 'bar-chart-3',
        live: true,
        fields: [
            {
                key: 'items', label: 'Figures', type: 'list', max: 4, of: [
                    {
                        key: 'stat', label: 'Figure', type: 'select', options: [
                            { value: 'pilots', label: 'Pilots' },
                            { value: 'hours', label: 'Hours flown' },
                            { value: 'flights', label: 'Flights' },
                            { value: 'destinations', label: 'Destinations' },
                            { value: 'routesActive', label: 'Active routes' },
                            { value: 'aircraft', label: 'Aircraft types' },
                        ],
                    },
                    { key: 'label', label: 'Called', type: 'line' },
                    { key: 'suffix', label: 'After the number', type: 'line', placeholder: '+' },
                ],
            },
        ],
        defaults: () => ({
            items: [
                { stat: 'pilots', label: 'pilots', suffix: '' },
                { stat: 'hours', label: 'hours flown', suffix: '+' },
                { stat: 'destinations', label: 'destinations', suffix: '' },
                { stat: 'routesActive', label: 'routes', suffix: '' },
            ],
        }),
        render: (p) => `
  <!-- Every number here is written in by crew-feed.js from the crew centre. A
       figure it does not have is removed with its label rather than shown as 0. -->
  <section class="figures">
${(p.items || []).map(i => `    <div data-crew-figure><b data-crew-stat="${esc(i.stat)}"${i.suffix ? ` data-crew-suffix="${esc(i.suffix)}"` : ''}>&mdash;</b><span>${esc(i.label)}</span></div>`).join('\n')}
  </section>`,
    },

    network: {
        label: 'Where we fly',
        note: 'Your published sectors, as a list. From the crew centre.',
        icon: 'route',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 40 },
            { key: 'empty', label: 'If there are none yet', type: 'line' },
        ],
        defaults: () => ({ heading: 'Where we fly', limit: 12, empty: 'They appear here as soon as they are in the crew centre.' }),
        render: (p) => `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
    <ul class="rows" data-crew-list="routes" data-crew-limit="${p.limit}">
      <template><li><b>{{from}} &rarr; {{to}}</b> <span>{{flight}} &middot; {{ac}}</span></li></template>
      <li><b>Add your sectors</b> <span>${esc(p.empty)}</span></li>
    </ul>
  </section>`,
    },

    fleet: {
        label: 'Fleet',
        note: 'The aircraft and liveries you declared in the crew centre.',
        icon: 'plane',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'note', label: 'Under the heading', type: 'line' },
            { key: 'cards', label: 'Show each aircraft as a picture card', type: 'bool', help: 'Off, it is a compact list. Every card gets an image even where you have not uploaded one.' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 40 },
        ],
        defaults: () => ({ heading: 'The fleet', note: '', limit: 16, cards: true }),
        /* Two shapes, because a fleet of four and a fleet of forty want
         * different pages. Cards give every airframe a picture — the VA's own
         * livery shot, or the silhouette crew-feed.js draws for the type, so
         * there is never a hole in the grid. Rows are the compact form for a
         * long fleet, and both carry {{credit}}: where a picture is somebody
         * else's it says whose and links back, and crew-feed.js removes the
         * line when there is nothing to attribute. */
        render: (p) => (p.cards ? `
  <section class="block">
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="cards" data-crew-list="fleet" data-crew-limit="${p.limit}">
      <template>
        <li class="card">
          <span class="card__media"><img src="{{image}}" data-fit="{{fit}}" data-crew-fallback="{{fallback}}" alt="{{aircraft}}" loading="lazy" decoding="async"></span>
          <span class="card__body">
            <b>{{aircraft}}</b>
            <span>{{livery}}</span>
            <span class="card__credit">{{credit}}</span>
          </span>
        </li>
      </template>
      <li class="card"><span class="card__body"><b>Add your fleet in the crew centre</b><span>Aircraft and liveries appear here as soon as they are in the fleet editor.</span></span></li>
    </ul>
  </section>` : `
  <section class="block">
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="rows" data-crew-list="fleet" data-crew-limit="${p.limit}">
      <template><li><span class="badge"><img src="{{image}}" alt="" loading="lazy" decoding="async"></span><b>{{aircraft}}</b> <span>{{livery}}</span></li></template>
      <li><b>Add your fleet in the crew centre</b> <span>Aircraft and liveries appear here as soon as they are in the fleet editor.</span></li>
    </ul>
  </section>`),
    },

    /* ---- The airline as an airline, not as a dataset --------------------
     *
     * The five blocks below are the ones a VA kept asking for and had to fake
     * with a paragraph of prose: where we are based, what we are like, who runs
     * it, who we fly with, and what actually happens when you apply.
     *
     * Two of them read from the crew centre and three are the VA's own words,
     * and the split is deliberate. Hubs and codeshares are FACTS the crew
     * centre already holds — a route map knows which airports carry the most
     * sectors and which of them are flown with somebody else, so typing either
     * by hand is typing something that will be wrong by next month. A culture
     * is not a fact and there is no field for one, which is exactly why it is
     * the thing missing from every VA website on the platform.
     * ------------------------------------------------------------------ */

    hubs: {
        label: 'Hubs',
        note: 'The airports you fly most out of, worked out from your route map.',
        icon: 'building-2',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'note', label: 'Under the heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 12 },
        ],
        defaults: () => ({ heading: 'Where we are based', note: 'The airports we fly most of our sectors out of.', limit: 6 }),
        render: (p) => `
  <section class="block" data-crew-section>
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="tiles" data-crew-list="hubs" data-crew-limit="${p.limit}">
      <template><li class="tile"><b class="code">{{icao}}</b><span>{{routes}} routes &middot; {{departures}} departures</span></li></template>
    </ul>
  </section>`,
    },

    values: {
        label: 'How we fly',
        note: 'The three or four things that make your airline itself. Nothing here is fed from anywhere.',
        icon: 'heart',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'note', label: 'Under the heading', type: 'line' },
            {
                key: 'items', label: 'Things', type: 'list', max: 8, of: [
                    { key: 'title', label: 'Called', type: 'line' },
                    { key: 'body', label: 'One sentence', type: 'line' },
                ],
            },
        ],
        defaults: () => ({
            heading: 'How we fly', note: '',
            items: [
                { title: 'We fly together', body: 'A group flight every week, on the same day, whoever turns up.' },
                { title: 'Nobody is chased', body: 'Fly when you want to. There is no monthly minimum and no leaderboard.' },
                { title: 'Realistic, not strict', body: 'Real routes and real liveries. Nobody is told off for a hard landing.' },
            ],
        }),
        render: (p) => `
  <section class="block" data-motif>
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="tiles">
${(p.items || []).map(i => `      <li class="tile"><b>${esc(i.title)}</b><span>${esc(i.body)}</span></li>`).join('\n')}
    </ul>
  </section>`,
    },

    /* Roles, never names. A staff list on a public page goes out of date the
     * week somebody steps down, and it puts real people's handles somewhere
     * anybody can scrape. The departments are the useful half and the half that
     * stays true. */
    staff: {
        label: 'Who runs it',
        note: 'Your crew centre roles, as a row of labels. Roles only — never who holds one.',
        icon: 'users',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'note', label: 'Under the heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 20 },
        ],
        defaults: () => ({ heading: 'Who runs the airline', note: 'The teams behind the operation.', limit: 14 }),
        render: (p) => `
  <section class="block" data-crew-section>
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="pills" data-crew-list="roles" data-crew-limit="${p.limit}">
      <template><li class="pill"><span class="dot" style="background:{{color}}"></span>{{name}}</li></template>
    </ul>
  </section>`,
    },

    partners: {
        label: 'Codeshares',
        note: 'The airlines you share sectors with, read off your route map.',
        icon: 'handshake',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 20 },
        ],
        defaults: () => ({ heading: 'We fly with', limit: 12 }),
        render: (p) => `
  <section class="block" data-crew-section>
    <div class="block__head"><h2>${esc(p.heading)}</h2></div>
    <ul class="pills" data-crew-list="partners" data-crew-limit="${p.limit}">
      <template><li class="pill">{{name}}</li></template>
    </ul>
  </section>`,
    },

    /* The numbers are drawn by a CSS counter rather than typed, so reordering
     * the steps in the editor cannot leave a 3 above a 2. */
    joining: {
        label: 'What happens when you apply',
        note: 'Numbered steps. The question every applicant has and almost no VA answers.',
        icon: 'list-ordered',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'note', label: 'Under the heading', type: 'line' },
            {
                key: 'items', label: 'Steps', type: 'list', max: 8, of: [
                    { key: 'title', label: 'Called', type: 'line' },
                    { key: 'body', label: 'One sentence', type: 'line' },
                ],
            },
            { key: 'ctaLabel', label: 'Link under the steps', type: 'line' },
            { key: 'ctaHref', label: 'That link goes to', type: 'url', help: 'Left empty, it goes to your join page.' },
        ],
        defaults: () => ({
            heading: 'What happens when you apply', note: '',
            items: [
                { title: 'You send the form', body: 'A few minutes, in the crew centre. No essay.' },
                { title: 'A person reads it', body: 'Usually within a day or two. You get a real answer either way.' },
                { title: 'You get your callsign', body: 'And the crew centre account that goes with it.' },
                { title: 'You fly', body: 'Pick any sector on the schedule. Nobody minds where you start.' },
            ],
            ctaLabel: 'Start an application', ctaHref: '',
        }),
        render: (p, ctx) => `
  <section class="block">
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="tiles tiles--numbered">
${(p.items || []).map(i => `      <li class="tile"><b>${esc(i.title)}</b><span>${esc(i.body)}</span></li>`).join('\n')}
    </ul>${p.ctaLabel ? `\n    <p class="more"><a href="${esc(linkUrl(p.ctaHref, ctx.join))}">${esc(p.ctaLabel)} &rarr;</a></p>` : ''}
  </section>`,
    },

    quote: {
        label: 'A quote',
        note: 'One line, set large. Worth having once on a site and nothing twice.',
        icon: 'quote',
        fields: [
            { key: 'body', label: 'What was said', type: 'text' },
            { key: 'by', label: 'Who said it', type: 'line' },
        ],
        defaults: () => ({
            body: 'A line from one of your pilots about their first week is worth more than a paragraph you wrote about yourselves.',
            by: 'A pilot, somewhere over the Atlantic',
        }),
        render: (p) => `
  <section class="block">
    <figure class="quote">
      <p>&ldquo;${esc(p.body)}&rdquo;</p>${p.by ? `\n      <figcaption class="by">${esc(p.by)}</figcaption>` : ''}
    </figure>
  </section>`,
    },

    /* The Discord invite comes from the crew centre rather than from a field
     * here, so it cannot rot into a dead link the week the server is remade. */
    contact: {
        label: 'Talk to us',
        note: 'Discord, the crew centre and the application, in three tiles.',
        icon: 'message-circle',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'note', label: 'Under the heading', type: 'line' },
            { key: 'showDiscord', label: 'Show your Discord invite', type: 'bool', help: 'The one in your crew centre. The tile goes if you have not set one.' },
        ],
        defaults: () => ({ heading: 'Talk to us', note: 'Before you apply, or after. Either is fine.', showDiscord: true }),
        render: (p, ctx) => `
  <section class="block">
    <div class="block__head">
      <h2>${esc(p.heading)}</h2>${p.note ? `\n      <p>${esc(p.note)}</p>` : ''}
    </div>
    <ul class="tiles">${p.showDiscord ? `
      <li class="tile" data-crew-figure><b>Discord</b><span>Where the airline actually lives. <a data-crew-brand="discord" href="#">Join the server</a></span></li>` : ''}
      <li class="tile"><b>The crew centre</b><span>Schedules, reports and the noticeboard. <a href="${esc(ctx.crew)}">Open it</a></span></li>
      <li class="tile"><b>Apply</b><span>A few minutes, and a human answer. <a href="${esc(ctx.join)}">Start</a></span></li>
    </ul>
  </section>`,
    },

    ranks: {
        label: 'Ranks',
        note: 'Your rank ladder. The most persuasive list on a VA website, and the one nobody updates by hand.',
        icon: 'trending-up',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 20 },
        ],
        defaults: () => ({ heading: 'How you move up', limit: 10 }),
        render: (p) => `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
    <ol class="steps" data-crew-list="ranks" data-crew-limit="${p.limit}">
      <template><li><span class="badge"><img src="{{image}}" alt="" loading="lazy" decoding="async"></span><b>{{name}}</b> <span>{{from}}</span></li></template>
      <li><b>Set your rank ladder</b> <span>Add it in the crew centre and it appears here.</span></li>
    </ol>
  </section>`,
    },

    events: {
        label: 'Events',
        note: 'The next departures on your calendar.',
        icon: 'calendar',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 12 },
            { key: 'moreLabel', label: 'Link under the list', type: 'line' },
            { key: 'moreHref', label: 'That link goes to', type: 'url', help: 'Left empty, it goes to your crew centre.' },
        ],
        defaults: () => ({ heading: 'Next departures', limit: 4, moreLabel: 'See the full calendar →', moreHref: '' }),
        render: (p, c) => `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
    <ul class="rows" data-crew-list="events" data-crew-limit="${p.limit}">
      <template><li><b>{{title}}</b> <span>{{from}} &rarr; {{to}}</span></li></template>
      <li><b>Nothing on the calendar yet</b> <span>Publish an event in the crew centre.</span></li>
    </ul>${p.moreLabel ? `
    <p class="more"><a href="${esc(linkUrl(p.moreHref, c.crew))}">${esc(p.moreLabel)}</a></p>` : ''}
  </section>`,
    },

    notices: {
        label: 'Notices',
        note: 'What your staff have written on the noticeboard.',
        icon: 'megaphone',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 12 },
            { key: 'writtenOnly', label: 'Written notices only', type: 'bool', help: 'Off, the automatic rows (joins, promotions) come through too.' },
        ],
        defaults: () => ({ heading: 'Notices', limit: 4, writtenOnly: true }),
        render: (p) => `
  <section class="block" data-crew-section>
    <h2>${esc(p.heading)}</h2>
    <ul class="rows" data-crew-list="notices"${p.writtenOnly ? ' data-crew-written="on"' : ''} data-crew-limit="${p.limit}">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>`,
    },

    activity: {
        label: 'Lately',
        note: 'Joins, promotions and published events — the only lines on the page that cannot go stale.',
        icon: 'activity',
        live: true,
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'limit', label: 'How many', type: 'number', min: 1, max: 12 },
        ],
        defaults: () => ({ heading: 'Lately', limit: 6 }),
        render: (p) => `
  <section class="block" data-crew-section>
    <h2>${esc(p.heading)}</h2>
    <ul class="rows" data-crew-list="activity" data-crew-limit="${p.limit}">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>`,
    },

    wall: {
        label: 'Instagram wall',
        note: 'The posts your staff pinned in the crew centre. Disappears if there are none.',
        icon: 'instagram',
        live: true,
        fields: [{ key: 'heading', label: 'Heading', type: 'line' }],
        defaults: () => ({ heading: 'The airline, photographed' }),
        // The id and the empty grid are what site.js looks for. Rename either
        // and this block renders and never fills.
        render: (p) => `
  <section class="block" id="wall" hidden>
    <h2>${esc(p.heading)}</h2>
    <div class="wall" id="wallGrid"></div>
    <p class="more" id="wallHandle" hidden></p>
  </section>`,
    },

    about: {
        label: 'About the airline',
        note: 'Two or three paragraphs. Nothing in it is fed from anywhere.',
        icon: 'text',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'body', label: 'Words', type: 'text', help: 'Leave a blank line between paragraphs.' },
        ],
        defaults: (c) => ({
            heading: `About ${c.name}`,
            body: 'Say who runs the airline, how it is organised, and what it expects of a pilot.\n\nSay what a new pilot’s first week looks like. That is the question every applicant actually has, and almost no virtual airline answers it on its homepage.',
        }),
        render: (p) => `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
${prose(p.body)}
  </section>`,
    },

    text: {
        label: 'Your own words',
        note: 'A heading and paragraphs, exactly as you type them.',
        icon: 'pilcrow',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'body', label: 'Words', type: 'text', help: 'Leave a blank line between paragraphs.' },
        ],
        defaults: () => ({ heading: 'A heading you write', body: 'And the words under it.' }),
        render: (p) => `
  <section class="block">${p.heading ? `
    <h2>${esc(p.heading)}</h2>` : ''}
${prose(p.body)}
  </section>`,
    },

    gallery: {
        label: 'Pictures',
        note: 'Screenshots, on a grid. Paste the address of each one.',
        icon: 'image',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            {
                key: 'items', label: 'Pictures', type: 'list', max: 12, of: [
                    { key: 'url', label: 'Image address', type: 'image', placeholder: 'https://…' },
                    { key: 'caption', label: 'Caption', type: 'line' },
                    { key: 'href', label: 'Links to', type: 'url' },
                ],
            },
        ],
        defaults: () => ({ heading: 'On the line', items: [] }),
        render: (p) => {
            const tiles = (p.items || []).filter(i => i.url).map((i) => {
                const img = `<img src="${esc(i.url)}" alt="${esc(i.caption)}" loading="lazy" decoding="async">`;
                const inner = i.caption ? `${img}<span>${esc(i.caption)}</span>` : img;
                return i.href
                    ? `      <a class="shot" href="${esc(linkUrl(i.href, ''))}" target="_blank" rel="noopener">${inner}</a>`
                    : `      <figure class="shot">${inner}</figure>`;
            }).join('\n');
            if (!tiles) return '';
            return `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
    <div class="shots">
${tiles}
    </div>
  </section>`;
        },
    },

    faq: {
        label: 'Questions',
        note: 'The five things every applicant asks before they apply.',
        icon: 'help-circle',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            {
                key: 'items', label: 'Questions', type: 'list', max: 15, of: [
                    { key: 'q', label: 'Question', type: 'line' },
                    { key: 'a', label: 'Answer', type: 'text' },
                ],
            },
        ],
        defaults: () => ({
            heading: 'Before you apply',
            items: [
                { q: 'How many hours do I need?', a: 'Say the real number, or say none.' },
                { q: 'Do I have to fly a minimum?', a: 'Say what happens if somebody does not.' },
            ],
        }),
        render: (p) => {
            const rows = (p.items || []).filter(i => i.q)
                .map(i => `      <li><b>${esc(i.q)}</b> <span>${esc(i.a).replace(/\n/g, '<br>')}</span></li>`).join('\n');
            if (!rows) return '';
            return `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
    <ul class="rows">
${rows}
    </ul>
  </section>`;
        },
    },

    links: {
        label: 'Links',
        note: 'The Discord, the IFC thread, the livery pack.',
        icon: 'link',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            {
                key: 'items', label: 'Links', type: 'list', max: 15, of: [
                    { key: 'label', label: 'Called', type: 'line' },
                    { key: 'href', label: 'Goes to', type: 'url' },
                    { key: 'note', label: 'Note', type: 'line' },
                ],
            },
        ],
        defaults: () => ({ heading: 'Elsewhere', items: [] }),
        render: (p) => {
            const rows = (p.items || []).filter(i => i.label && linkUrl(i.href, ''))
                .map(i => `      <li><b><a href="${esc(linkUrl(i.href, ''))}" target="_blank" rel="noopener">${esc(i.label)}</a></b> <span>${esc(i.note)}</span></li>`).join('\n');
            if (!rows) return '';
            return `
  <section class="block">
    <h2>${esc(p.heading)}</h2>
    <ul class="rows">
${rows}
    </ul>
  </section>`;
        },
    },

    embed: {
        label: 'Something embedded',
        note: 'A YouTube video, a Discord widget, a Twitch stream.',
        icon: 'monitor-play',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'src', label: 'Embed address', type: 'url', help: 'The src of the embed, not the page it is on.' },
            {
                key: 'ratio', label: 'Shape', type: 'select', options: [
                    { value: 'wide', label: 'Wide (16:9)' },
                    { value: 'tall', label: 'Tall' },
                    { value: 'square', label: 'Square' },
                ],
            },
        ],
        defaults: () => ({ heading: '', src: '', ratio: 'wide' }),
        // Which hosts may actually appear is the Content-Security-Policy's
        // decision (frame-src, in vaSites.js), not this block's. Duplicating
        // that list here would give a VA a section that renders in the editor
        // and is blank on their site, which is worse than a clear refusal from
        // the browser.
        render: (p) => {
            const src = linkUrl(p.src, '');
            if (!src || src.startsWith('/') || src.startsWith('#')) return '';
            return `
  <section class="block">${p.heading ? `
    <h2>${esc(p.heading)}</h2>` : ''}
    <div class="frame frame--${esc(p.ratio)}">
      <iframe src="${esc(src)}" loading="lazy" allowfullscreen title="${esc(p.heading || 'Embedded')}"></iframe>
    </div>
  </section>`;
        },
    },

    cta: {
        label: 'Apply band',
        note: 'A full-width band with the apply button. Put it at the bottom.',
        icon: 'flag',
        fields: [
            { key: 'heading', label: 'Heading', type: 'line' },
            { key: 'sub', label: 'Under it', type: 'line' },
            { key: 'ctaLabel', label: 'Button', type: 'line' },
            { key: 'ctaHref', label: 'Button goes to', type: 'url', help: 'Left empty, it goes to your join page.' },
        ],
        defaults: () => ({
            heading: 'There is a seat for you.',
            sub: 'Applications take a few minutes and get a human answer.',
            ctaLabel: 'Apply to fly',
            ctaHref: '',
        }),
        render: (p, c) => `
  <section class="band">
    <h2>${esc(p.heading)}</h2>${p.sub ? `
    <p>${esc(p.sub)}</p>` : ''}${p.ctaLabel ? `
    <a class="cta" href="${esc(linkUrl(p.ctaHref, c.join))}">${esc(p.ctaLabel)}</a>` : ''}
  </section>`,
    },
};

const BLOCK_IDS = Object.keys(BLOCKS);

/* ---------------------------------------------------------------------------
 * The few shapes the block vocabulary needs that BASE_CSS does not already
 * carry. Appended after the template's own CSS so a design can still override
 * it, and written in the same custom properties so it inherits the theme.
 * ------------------------------------------------------------------------ */
const BUILDER_CSS = `
/* ---- Blocks added by the builder ------------------------------------- */
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: .8rem; }
.shot { margin: 0; display: block; border-radius: var(--radius); overflow: hidden; background: var(--surface); border: 1px solid var(--line); }
.shot img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }
.shot span { display: block; padding: .55rem .7rem; font-size: .82rem; color: var(--muted); }
a.shot { text-decoration: none; }
a.shot:hover { border-color: var(--accent); }
.frame { position: relative; width: 100%; border-radius: var(--radius); overflow: hidden; background: var(--surface); border: 1px solid var(--line); }
.frame--wide { aspect-ratio: 16 / 9; }
.frame--square { aspect-ratio: 1 / 1; }
.frame--tall { aspect-ratio: 3 / 4; max-width: 26rem; }
.frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
`;

/* ===========================================================================
 * VALIDATION
 *
 * Everything below runs on what the editor sent, which is to say on a JSON
 * document a person can put anything in. A block type that is not in the
 * vocabulary is dropped rather than rejected: a document that fails to save
 * because of one stale row is a VA losing an afternoon's work over a field
 * they cannot see.
 * ======================================================================== */

let idSeq = 0;
function newId() {
    idSeq = (idSeq + 1) % 1e6;
    return 'b' + Date.now().toString(36) + idSeq.toString(36);
}

/** One field's value, cleaned to its declared type. */
function cleanValue(field, raw) {
    switch (field.type) {
        case 'text': return text(raw);
        case 'url': return linkUrl(raw, '');
        case 'image': return imageUrl(raw);
        case 'bool': return bool(raw);
        case 'number': return num(raw, field.min == null ? 0 : field.min, field.max == null ? 100 : field.max, field.min || 1);
        case 'select': return pick(raw, (field.options || []).map(o => o.value), ((field.options || [])[0] || {}).value || '');
        case 'list': {
            const rows = Array.isArray(raw) ? raw : [];
            return rows.slice(0, Math.min(field.max || MAX_ITEMS, MAX_ITEMS)).map((row) => {
                const out = {};
                (field.of || []).forEach((f) => { out[f.key] = cleanValue(f, row && row[f.key]); });
                return out;
            });
        }
        default: return line(raw, field.max);
    }
}

/** A block, cleaned. Unknown type → null, and the caller drops it. */
function cleanBlock(raw, ctx) {
    const type = raw && String(raw.type || '');
    const def = BLOCKS[type];
    if (!def) return null;
    const defaults = def.defaults(ctx);
    const props = {};
    def.fields.forEach((f) => {
        const given = raw.props ? raw.props[f.key] : undefined;
        props[f.key] = given === undefined ? defaults[f.key] : cleanValue(f, given);
    });
    return { id: line(raw.id, 40) || newId(), type, props };
}

/**
 * A whole document, cleaned.
 *
 * index.html is not optional and is not negotiable — it is the page a visitor
 * gets at the bare address, and vaSites.js refuses to publish a site without
 * one. A document that arrives without it gets an empty one rather than an
 * error, so the editor can never write a site into a state it cannot publish.
 */
function normaliseDoc(raw, ctx) {
    const doc = (raw && typeof raw === 'object') ? raw : {};
    const seen = new Set();
    let pages = (Array.isArray(doc.pages) ? doc.pages : []).slice(0, MAX_PAGES).map((p) => {
        const path = String((p && p.path) || '').trim().toLowerCase();
        if (!PAGE_PATH_RE.test(path) || seen.has(path)) return null;
        seen.add(path);
        return {
            path,
            title: line(p.title, 80),
            nav: p.nav === undefined ? true : bool(p.nav),
            navLabel: line(p.navLabel, 40),
            blocks: (Array.isArray(p.blocks) ? p.blocks : [])
                .slice(0, MAX_BLOCKS)
                .map(b => cleanBlock(b, ctx))
                .filter(Boolean),
        };
    }).filter(Boolean);

    if (!pages.some(p => p.path === 'index.html')) {
        pages = [{ path: 'index.html', title: '', nav: true, navLabel: 'Home', blocks: [] }].concat(pages).slice(0, MAX_PAGES);
    }
    // index.html first, so the editor's page list opens on the homepage.
    pages.sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)));

    const nav = (doc.nav && typeof doc.nav === 'object') ? doc.nav : {};
    return {
        version: 1,
        nav: {
            showApply: nav.showApply === undefined ? true : bool(nav.showApply),
            applyLabel: line(nav.applyLabel, 30) || 'Apply',
            showCrew: nav.showCrew === undefined ? true : bool(nav.showCrew),
            crewLabel: line(nav.crewLabel, 30) || 'Crew centre',
        },
        footer: { note: line(doc.footer && doc.footer.note, 300) },
        pages,
    };
}

/* ===========================================================================
 * RENDERING
 * ======================================================================== */

/** The context every block renders against: who the airline is and where its
 *  crew centre lives. Never a request, a session or a database row. */
function contextFor(va, { crewBase } = {}) {
    const base = String(crewBase || 'https://inflight.info').replace(/\/+$/, '');
    const slug = String((va && va.slug) || '');
    return {
        name: String((va && va.name) || 'Our Virtual Airline'),
        callsign: String((va && va.callsign) || ''),
        slug,
        crewBase: base,
        crew: `${base}/crew/${encodeURIComponent(slug)}`,
        join: `${base}/crew/${encodeURIComponent(slug)}/join`,
    };
}

function navHtml(doc, ctx) {
    const links = doc.pages.filter(p => p.nav).map((p) => {
        const label = p.navLabel || p.title || (p.path === 'index.html' ? 'Home' : p.path.replace(/\.html$/, ''));
        return `      <a href="${p.path === 'index.html' ? './' : esc(p.path)}">${esc(label)}</a>`;
    });
    if (doc.nav.showCrew) links.push(`      <a href="${esc(ctx.crew)}">${esc(doc.nav.crewLabel)}</a>`);
    const apply = doc.nav.showApply ? `\n      <a class="cta" href="${esc(ctx.join)}">${esc(doc.nav.applyLabel)}</a>` : '';
    /* The same header a template renders, down to the attribute names — see
     * BLOCKS.nav in vaSiteTemplates.js. The burger ships HIDDEN and site.js
     * reveals it, so a builder page with no JavaScript is a plain wrapping row
     * of links rather than a button that does nothing over a panel that never
     * opens. The scrim is a <button> so that tapping outside the open panel is
     * a real, announced way to close it. */
    return `<header class="bar" data-bar>
  <div class="bar__in">
    <a class="mark" href="./">
      <span class="logo" data-crew-figure hidden><img data-crew-brand="logo" alt=""></span>
      <span data-crew-brand="name">${esc(ctx.name)}</span>
    </a>
    <button class="bar__burger" type="button" aria-expanded="false" aria-controls="siteNav" aria-label="Menu" hidden><i></i></button>
    <nav class="bar__nav" id="siteNav">
${links.join('\n')}${apply}
    </nav>
  </div>
</header>
<button class="bar__scrim" type="button" tabindex="-1" aria-label="Close the menu" hidden></button>`;
}

function footerHtml(doc, ctx) {
    const note = doc.footer.note
        || `${ctx.name} is a virtual airline on Infinite Flight. Not affiliated with any real-world carrier.`;
    const links = doc.pages.filter(p => p.nav).map((p) => {
        const label = p.navLabel || p.title || (p.path === 'index.html' ? 'Home' : p.path.replace(/\.html$/, ''));
        return `      <a href="${p.path === 'index.html' ? './' : esc(p.path)}">${esc(label)}</a>`;
    });
    links.push(`      <a href="${esc(ctx.crew)}">Crew centre</a>`);
    links.push(`      <a href="${esc(ctx.join)}">Apply</a>`);
    return `<footer>
  <div class="foot__in">
    <div>
      <p>${esc(note)}</p>
      <p>Crew centre hosted by <a href="${esc(ctx.crewBase)}">Inflight</a>.</p>
    </div>
    <div class="foot__links">
${links.join('\n')}
    </div>
  </div>
</footer>`;
}

/** One page, as a whole HTML file. Same head, same script order and same
 *  stylesheet names as vaSiteTemplates.pageHtml — a builder page and a
 *  hand-written one are the same kind of file, which is what makes ejecting
 *  from one to the other a no-op for the visitor. */
function pageHtml(doc, page, ctx) {
    const title = page.title ? `${page.title} — ${ctx.name}` : ctx.name;
    const body = page.blocks.map((b) => {
        const def = BLOCKS[b.type];
        return def ? def.render(b.props, ctx) : '';
    }).filter(Boolean).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(ctx.name)} — a virtual airline on Infinite Flight.">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="style.css">
</head>
<body>
${navHtml(doc, ctx)}

<main>
${body}
</main>

${footerHtml(doc, ctx)}

<!-- crew-feed.js fills in everything marked data-crew-*; site.js hangs the
     Instagram wall and clears away a section that turned out to be empty.
     No key in either, and every endpoint they read is public. -->
<script src="${esc(ctx.feedSrc || '')}" data-va="${esc(ctx.slug)}" data-auto="off"></script>
<script src="site.js"></script>
</body>
</html>
`;
}

/**
 * The document, as the file list vaSites.js stores.
 *
 * Deliberately the same shape renderTemplate returns, including the byte count
 * — the storage, the limits, the preview, the publish and the version history
 * are all shared, and none of them has a branch for "this one came from the
 * builder".
 */
function renderSite(doc, { va, templateId, theme, feedSrc, crewBase } = {}) {
    const tpl = templates.TEMPLATES[templateId] || templates.TEMPLATES[templates.DEFAULT_TEMPLATE];
    const id = templates.TEMPLATES[templateId] ? templateId : templates.DEFAULT_TEMPLATE;
    const ctx = Object.assign(contextFor(va, { crewBase }), {
        feedSrc: String(feedSrc || 'https://inflight.info/crew-feed.js'),
    });
    const clean = normaliseDoc(doc, ctx);
    const th = templates.normaliseTheme(theme, id);

    const files = clean.pages.map(p => ({ path: p.path, content: pageHtml(clean, p, ctx) }));
    files.push({ path: 'theme.css', content: templates.renderThemeCss(th) });
    files.push({
        path: 'style.css',
        content: `${templates.BASE_CSS}\n/* ---- ${tpl.name} ---------------------------------------------------- */\n${tpl.css}${BUILDER_CSS}`,
    });
    files.push({ path: 'site.js', content: templates.SITE_JS });

    return files.map(f => ({
        path: f.path,
        content: f.content,
        bytes: Buffer.byteLength(f.content, 'utf8'),
        updatedAt: new Date(),
    }));
}

/**
 * A starting document for a design.
 *
 * The template says which blocks its pages are made of; this fills each one
 * with its default copy. So "pick a design" produces a site that is already
 * about this airline and already says something, rather than a blank page and
 * an instruction to start typing.
 */
function starterDoc(templateId, va, { crewBase } = {}) {
    const tpl = templates.TEMPLATES[templateId] || templates.TEMPLATES[templates.DEFAULT_TEMPLATE];
    const ctx = contextFor(va, { crewBase });
    return normaliseDoc({
        version: 1,
        pages: tpl.pages.map(p => ({
            path: p.path,
            title: p.title || '',
            nav: true,
            navLabel: p.title || 'Home',
            blocks: p.blocks.filter(id => BLOCKS[id]).map(id => ({ id: newId(), type: id, props: BLOCKS[id].defaults(ctx) })),
        })),
    }, ctx);
}

/** An empty document — one page, nothing on it. For a VA who would rather
 *  start from nothing than from a design. */
function blankDoc(va, { crewBase } = {}) {
    const ctx = contextFor(va, { crewBase });
    return normaliseDoc({ pages: [{ path: 'index.html', title: '', nav: true, navLabel: 'Home', blocks: [] }] }, ctx);
}

/** One fresh block of a type, with its defaults filled in. */
function newBlock(type, va, { crewBase } = {}) {
    const def = BLOCKS[type];
    if (!def) return null;
    return { id: newId(), type, props: def.defaults(contextFor(va, { crewBase })) };
}

/** What the editor draws its palette and its forms from. Content-free. */
function catalogue() {
    return {
        blocks: BLOCK_IDS.map(id => ({
            type: id,
            label: BLOCKS[id].label,
            note: BLOCKS[id].note,
            icon: BLOCKS[id].icon || 'square',
            live: !!BLOCKS[id].live,
            fields: BLOCKS[id].fields,
        })),
        limits: { pages: MAX_PAGES, blocks: MAX_BLOCKS, items: MAX_ITEMS },
    };
}

module.exports = {
    BLOCKS, BLOCK_IDS, BUILDER_CSS,
    MAX_PAGES, MAX_BLOCKS, MAX_ITEMS,
    esc, linkUrl, imageUrl, prose, newId,
    cleanValue, cleanBlock, normaliseDoc,
    contextFor, navHtml, footerHtml, pageHtml,
    renderSite, starterDoc, blankDoc, newBlock, catalogue,
};

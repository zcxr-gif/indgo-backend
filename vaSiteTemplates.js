'use strict';

/*
 * vaSiteTemplates.js
 * The designs a virtual airline picks from, and the parts they are built out of.
 *
 * WHY A CATALOGUE AND NOT ONE STARTER
 * -----------------------------------
 * The first version of hosting laid out a single starter page. That is enough
 * to prove the plumbing and not enough to be used: a VA opening the editor to
 * one fixed design either takes it as-is — so every hosted airline looks the
 * same, which is the opposite of the point — or throws it away and is back to a
 * blank file. What a VA actually wants is the thing every site builder sells:
 * pick a look, see your own airline in it, then change the words.
 *
 * THE ONE INVARIANT ACROSS ALL SIX
 * --------------------------------
 * Every template is a different design and NONE of them is a different data
 * wiring. The 'data-crew-*' markup that pulls an airline's real figures out of
 * its crew centre is written ONCE, in BLOCKS below, and every template composes
 * the same blocks. That is the whole reason this file is arranged this way.
 *
 * If each template carried its own copy of the markup, then the day
 * 'data-crew-stat' gains a field or 'activity' changes shape, five of the six
 * would quietly stop showing a number and nobody would find out until a VA
 * asked why their pilot count was missing. The variety belongs in the CSS,
 * where being wrong is visible; the wiring belongs in one place, where being
 * wrong is not.
 *
 * WHAT MAKES A TEMPLATE DIFFERENT
 * -------------------------------
 *   tokens   the colour and type variables, written to theme.css — the file the
 *            theme picker rewrites, and the only file a VA edits to recolour a
 *            whole site
 *   css      the personality: layout, density, rules, how a heading sits
 *   pages    which blocks, in what order, on which pages
 *   thumb    a small SVG of its own layout in its own colours, for the picker.
 *            Drawn rather than screenshotted so it cannot go stale, costs no
 *            binary, and works in both themes
 *
 * A template is NOT a colour swap. Concourse is a departure board and Terminal
 * is a page of rules and monospace; swapping their accents leaves two designs
 * that are still nothing like each other. That is the bar for adding a seventh.
 */

/* ===========================================================================
 * TYPE
 *
 * Four pairings, offered to every template. Google Fonts is the only external
 * stylesheet a hosted site may load (see the CSP in vaSites.js), so these are
 * the families a VA can reach without hosting a font file themselves — and
 * every stack ends in a real system fallback, because a page that waits on a
 * font it cannot fetch is a page of invisible text.
 * ======================================================================== */
const FONTS = {
    grotesk: {
        label: 'Grotesk',
        note: 'Neutral and modern. The safe one.',
        google: 'Space+Grotesk:wght@400;500;700&family=Inter:wght@400;500;600',
        display: "'Space Grotesk', 'Inter', system-ui, sans-serif",
        body: "'Inter', system-ui, -apple-system, sans-serif",
        mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace",
    },
    editorial: {
        label: 'Editorial',
        note: 'A serif headline over a plain body. Reads like an airline that has been around.',
        google: 'Fraunces:opsz,wght@9..144,400;9..144,700&family=Inter:wght@400;500;600',
        display: "'Fraunces', 'Iowan Old Style', Georgia, serif",
        body: "'Inter', system-ui, -apple-system, sans-serif",
        mono: "ui-monospace, 'SF Mono', Menlo, monospace",
    },
    technical: {
        label: 'Technical',
        note: 'Monospace throughout. Flight-deck rather than brochure.',
        google: 'JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600',
        display: "'JetBrains Mono', ui-monospace, monospace",
        body: "'Inter', system-ui, -apple-system, sans-serif",
        mono: "'JetBrains Mono', ui-monospace, monospace",
    },
    humanist: {
        label: 'Humanist',
        note: 'Warm and rounded. Good for a smaller crew.',
        google: 'Outfit:wght@400;500;700&family=Karla:wght@400;500;700',
        display: "'Outfit', system-ui, sans-serif",
        body: "'Karla', system-ui, -apple-system, sans-serif",
        mono: "ui-monospace, Menlo, monospace",
    },
};

const MODES = {
    light: { label: 'Light' },
    dark: { label: 'Dark' },
    auto: { label: 'Follow the visitor', note: 'Light or dark, whichever their device is set to.' },
};

const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A hex colour, or null. Never trust one into a stylesheet unchecked: a token
 *  file is CSS, and an unvalidated value there closes a declaration and opens
 *  whatever the author fancies. */
function hex(v, fallback) {
    const s = String(v == null ? '' : v).trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fallback;
}

/* ===========================================================================
 * THE BLOCKS
 *
 * The section vocabulary. Every template composes these and no template writes
 * its own version of one, so the data wiring is in exactly one place.
 *
 * Class names are semantic and shared ('.hero', '.figures', '.rows', '.wall'),
 * which is what lets six stylesheets produce six designs over identical markup
 * — and what lets a VA lift a block out of the library and paste it into a page
 * from a different template and have it look right.
 *
 * EVERY BLOCK CARRIES ITS OWN FALLBACK. What is between the tags is what a
 * visitor sees when the crew centre is unreachable, so a block is correct
 * before any fetch resolves. That is the rule crew-feed.js is built around and
 * it has to hold in the markup, not just in the reader.
 * ======================================================================== */
const BLOCKS = {

    // The inner wrapper is not decoration: the bar has to be able to run full
    // width (Livery paints it) while its CONTENTS line up with every section
    // under it. Those are two different boxes, so there are two elements.
    nav: (c) => `
<header class="bar">
  <div class="bar__in">
    <a class="mark" href="/">
      <!-- The logo the VA already uploaded to their Inflight profile. The
           wrapper is [data-crew-figure] so that a VA WITHOUT one gets a
           wordmark rather than a broken-image icon: crew-feed.js removes the
           whole holder, not just the img. -->
      <span class="logo" data-crew-figure hidden><img data-crew-brand="logo" alt=""></span>
      <span data-crew-brand="name">${esc(c.name)}</span>
    </a>
    <nav>
      <a href="/fleet.html">Fleet</a>
      <a href="${c.crew}">Crew centre</a>
      <a class="cta" href="${c.crew}/join">Apply</a>
    </nav>
  </div>
</header>`,

    // The banner sits BEHIND the words rather than above them, and is removed
    // entirely when the VA has not uploaded one — a hero with no photograph is
    // a design; a hero with a gap where one should be is a fault. The scrim in
    // style.css is not optional either: white text over an unknown photograph
    // is unreadable often enough to be a rule.
    hero: (c) => `
  <section class="hero">
    <div class="hero__bg" data-crew-figure hidden>
      <img data-crew-brand="banner" alt="" loading="eager" decoding="async">
    </div>
    <div class="hero__in">
      <p class="eyebrow">${esc(c.callsign || 'Virtual airline')} &middot; Infinite Flight</p>
      <h1>Fly with ${esc(c.name)}.</h1>
      <p class="lede">Write the sentence here that says what your airline is for.
         One sentence, in your own words. The numbers underneath look after themselves.</p>
      <a class="cta" href="${c.crew}/join">Apply to fly</a>
    </div>
  </section>`,

    // A section of the VA's own words. Nothing in it is fed from anywhere —
    // that is the point of it. Every other block on this page is the crew
    // centre talking; this is the airline.
    text: () => `
  <section class="block">
    <h2>A heading you write</h2>
    <p class="prose">And the words under it. This section is yours — nothing
       here is filled in from the crew centre, so whatever you type stays
       exactly as you typed it.</p>
    <p class="prose">Add as many of these as you like from Insert a section, or
       just copy this block and change the words.</p>
  </section>`,

    figures: () => `
  <!-- FIGURES. Each number is written in by crew-feed.js from your crew centre.
       Type a TRUE fallback between the tags: if the feed is quiet the page keeps
       what you wrote. A figure the crew centre does not have is removed along
       with its label rather than printed as 0. -->
  <section class="figures">
    <div data-crew-figure><b data-crew-stat="pilots">&mdash;</b><span>pilots</span></div>
    <div data-crew-figure><b data-crew-stat="hours" data-crew-suffix="+">&mdash;</b><span>hours flown</span></div>
    <div data-crew-figure><b data-crew-stat="destinations">&mdash;</b><span>destinations</span></div>
    <div data-crew-figure><b data-crew-stat="routesActive">&mdash;</b><span>routes</span></div>
  </section>`,

    network: () => `
  <!-- THE NETWORK. One copy of the <template> per sector. Everything in {{ }} is
       escaped on the way in, so a note typed in the crew centre can never write
       HTML into this page. -->
  <section class="block">
    <h2>Where we fly</h2>
    <ul class="rows" data-crew-list="routes" data-crew-limit="12">
      <template><li><b>{{from}} &rarr; {{to}}</b> <span>{{flight}} &middot; {{ac}}</span></li></template>
      <li><b>Add your sectors</b> <span>They appear here as soon as they are in the crew centre.</span></li>
    </ul>
  </section>`,

    activity: () => `
  <!-- WHAT WE HAVE BEEN DOING. The rows your crew centre writes by itself — a
       pilot joined, somebody was promoted, an event went up. These are the only
       lines on the page that cannot go stale. -->
  <section class="block" data-crew-section>
    <h2>Lately</h2>
    <ul class="rows" data-crew-list="activity" data-crew-limit="6">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>`,

    notices: () => `
  <!-- THE NOTICEBOARD, the written half only. Drop data-crew-written to get the
       automatic rows in here too. -->
  <section class="block" data-crew-section>
    <h2>Notices</h2>
    <ul class="rows" data-crew-list="notices" data-crew-written="on" data-crew-limit="4">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>`,

    events: (c) => `
  <section class="block">
    <h2>Next departures</h2>
    <ul class="rows" data-crew-list="events" data-crew-limit="4">
      <template><li><b>{{title}}</b> <span>{{from}} &rarr; {{to}}</span></li></template>
      <li><b>Nothing on the calendar yet</b> <span>Publish an event in the crew centre.</span></li>
    </ul>
    <p class="more"><a href="${c.crew}">See the full calendar &rarr;</a></p>
  </section>`,

    wall: () => `
  <!-- THE WALL. The Instagram posts your staff hung on the crew centre. Each
       tile stays a button until it is scrolled to — nine Instagram embeds is
       several megabytes, and most visitors never reach the bottom of a page.
       site.js removes this whole section if there is no wall. -->
  <section class="block" id="wall" hidden>
    <h2>The airline, photographed</h2>
    <div class="wall" id="wallGrid"></div>
    <p class="more" id="wallHandle" hidden></p>
  </section>`,

    // THE FLEET, from the crew centre's own fleet editor. It used to be three
    // invented aircraft a VA had to overwrite; it is the aircraft and liveries
    // they actually declared, which is also what the tracker matches their live
    // flights against — so the website and the flight log cannot disagree.
    fleet: () => `
  <section class="block">
    <h2>The fleet</h2>
    <ul class="rows" data-crew-list="fleet" data-crew-limit="16">
      <template><li><span class="badge"><img src="{{image}}" alt="" loading="lazy" decoding="async"></span><b>{{aircraft}}</b> <span>{{livery}}</span></li></template>
      <li><b>Add your fleet in the crew centre</b> <span>Aircraft and liveries appear here as soon as they are in the fleet editor.</span></li>
    </ul>
  </section>`,

    about: (c) => `
  <section class="block">
    <h2>About ${esc(c.name)}</h2>
    <p class="prose">Say who runs the airline, how it is organised, and what it
       expects of a pilot. Two or three short paragraphs is plenty — anybody who
       wants the detail will read your operations manual.</p>
    <p class="prose">Say what a new pilot's first week looks like. That is the
       question every applicant actually has, and almost no virtual airline
       answers it on its homepage.</p>
  </section>`,

    // THE LADDER, from the crew centre. The single most persuasive list on a
    // virtual airline's website to somebody deciding whether to apply, and the
    // one nobody remembers to update by hand. Sorted by the hours each rung
    // asks for, so it reads upward however it happens to be stored.
    ranks: () => `
  <section class="block">
    <h2>How you move up</h2>
    <ol class="steps" data-crew-list="ranks" data-crew-limit="10">
      <template><li><span class="badge"><img src="{{image}}" alt="" loading="lazy" decoding="async"></span><b>{{name}}</b> <span>{{from}}</span></li></template>
      <li><b>Set your rank ladder</b> <span>Add it in the crew centre and it appears here.</span></li>
    </ol>
  </section>`,

    cta: (c) => `
  <section class="band">
    <h2>There is a seat for you.</h2>
    <p>Applications take a few minutes and get a human answer.</p>
    <a class="cta" href="${c.crew}/join">Apply to fly</a>
  </section>`,

    footer: (c) => `
<footer>
  <p>${esc(c.name)} is a virtual airline on Infinite Flight. Not affiliated with any real-world carrier.</p>
  <p>Crew centre hosted by <a href="${c.crewBase}">Inflight</a>.</p>
</footer>`,
};

// What the editor offers under "Insert a section". `nav` and `footer` are left
// out on purpose: a page has one of each and they are already in every
// template, so offering them is offering a way to end up with two.
const INSERTABLE = [
    { id: 'hero', label: 'Hero', note: 'Headline, one sentence, and the apply button.' },
    { id: 'figures', label: 'Live figures', note: 'Pilots, hours, destinations, routes — from your crew centre.' },
    { id: 'network', label: 'Network', note: 'Your published sectors, as a list.' },
    { id: 'activity', label: 'Lately', note: 'Joins, promotions and published events, written by your crew centre.' },
    { id: 'notices', label: 'Notices', note: 'What your staff have written on the noticeboard.' },
    { id: 'events', label: 'Events', note: 'The next departures on your calendar.' },
    { id: 'wall', label: 'Instagram wall', note: 'The posts your staff chose in the crew centre.' },
    { id: 'fleet', label: 'Fleet', note: 'The aircraft and liveries you declared in the crew centre.' },
    { id: 'about', label: 'About', note: 'Two paragraphs about the airline.' },
    { id: 'ranks', label: 'Ranks', note: 'Your rank ladder, from the crew centre.' },
    { id: 'text', label: 'Your own words', note: 'A heading and paragraphs. Nothing in it is fed from anywhere.' },
    { id: 'cta', label: 'Apply band', note: 'A full-width band with the apply button.' },
];

/* ===========================================================================
 * THE BASE STYLESHEET
 *
 * Reset, the shared block shapes, and nothing with a personality. Everything
 * that makes a template look like itself is in that template's own 'css', so
 * this file is the same in all six and a VA who edits it is editing plumbing
 * rather than design.
 *
 * Every colour and every family is a var() defined in theme.css. That is what
 * makes the theme picker a rewrite of one small file rather than a search and
 * replace across a site.
 * ======================================================================== */
const BASE_CSS = `/* Base — shared by every template. Colour and type live in theme.css. */

*, *::before, *::after { box-sizing: border-box; }
html {
  -webkit-text-size-adjust: 100%;
  scroll-behavior: smooth;
  /* The hero banner bleeds past the measure with a vw-based margin, and vw
     counts the scrollbar. Clipping swallows the couple of pixels that costs
     without making the page a scroll container the way overflow:hidden does. */
  overflow-x: clip;
}
/* Anybody who has asked their system for less movement gets none of ours. */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
img { max-width: 100%; height: auto; }
a { color: var(--accent); transition: color .15s ease, opacity .15s ease; }
/* A visible focus ring on everything reachable by keyboard. The browser's own
   is removed by enough resets that it is worth stating rather than assuming. */
:where(a, button, input, select, textarea):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px;
}
h1, h2, h3 { font-family: var(--font-display); line-height: 1.15; letter-spacing: -.02em; }

/* Header.
   The bar itself runs the full width of the window so a template can paint it.
   Its CONTENTS are held to the same box as everything in <main>: main is capped
   at --measure, centred, and THEN padded, so its text starts at
   (gutter + pad) — a bar padded by --pad alone lands short of that on any
   window wider than the measure. Hence the inner element and the subtracted
   measure. */
.bar { padding-inline: var(--pad); }
.bar__in {
  max-width: calc(var(--measure) - 2 * var(--pad));
  margin-inline: auto;
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding-block: 1rem;
}
.bar .mark {
  font-family: var(--font-display); font-weight: 700; text-decoration: none;
  color: var(--ink); display: inline-flex; align-items: center; gap: .6rem;
}
/* The VA's uploaded logo. Capped by HEIGHT, never width: a wordmark logo is
   five times wider than a roundel, and a width cap makes one of the two
   illegible. */
.logo img { height: 1.75rem; width: auto; display: block; }
.bar nav { display: flex; gap: 1.1rem; align-items: center; flex-wrap: wrap; }
.bar nav a { text-decoration: none; font-size: .9rem; color: var(--muted); }
.bar nav a:hover { color: var(--ink); }

/* Layout */
main { max-width: var(--measure); margin: 0 auto; padding: 0 var(--pad); }
.hero, .figures { padding-block: var(--gap); }
/* Blocks get a little over half, because two of them stacked contribute a
   bottom AND a top: a full --gap each puts eleven rems between two headings,
   which reads as a missing section rather than as space. */
.block { padding-block: calc(var(--gap) * .56); }

/* The hero's banner.
   Behind the words, not above them, and always under a scrim. White text over
   an unknown photograph is unreadable often enough that the scrim is a rule
   rather than a taste: the VA chose the image, and nobody checked it against
   the text that would sit on it. */
.hero { position: relative; isolation: isolate; }
/* Edge to edge. A hero photograph inset to the text measure reads as a picture
   somebody dropped in the page; the same photograph running to the window
   reads as the top of a website. The margin pulls each side out to the
   viewport from whatever box the hero happens to sit in, so it works the same
   in a centred 'main' and in Livery's full-width one. */
.hero__bg {
  position: absolute; inset: 0; z-index: -1; overflow: hidden;
  margin-inline: calc(50% - 50vw);
}
.hero__bg img { width: 100%; height: 100%; object-fit: cover; }
.hero__bg::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(to right, var(--bg) 0%, color-mix(in srgb, var(--bg) 82%, transparent) 45%, color-mix(in srgb, var(--bg) 40%, transparent) 100%);
}
/* color-mix is recent. Where it is missing the scrim falls back to a flat wash,
   which is less pretty and equally legible — the property that matters. */
@supports not (background: color-mix(in srgb, red 50%, transparent)) {
  .hero__bg::after { background: var(--bg); opacity: .82; }
}
.hero__in { position: relative; }
/* A hero carrying a photograph needs room the plain one does not. */
.hero:has(.hero__bg:not([hidden])) { padding-block: clamp(3.5rem, 9vw, 7rem); }
h1 { font-size: clamp(2.1rem, 6vw, 3.8rem); margin: 0 0 1rem; }
h2 { font-size: clamp(1.15rem, 2.4vw, 1.5rem); margin: 0 0 1.4rem; }
.eyebrow {
  font-family: var(--font-mono); font-size: .75rem; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted); margin: 0 0 1rem;
}
.lede { color: var(--muted); font-size: 1.12rem; max-width: 48ch; }
.prose { max-width: 62ch; color: var(--muted); }

/* The apply button */
.cta {
  display: inline-block; margin-top: 1.5rem; padding: .8rem 1.5rem;
  background: var(--accent); color: var(--on-accent);
  border-radius: var(--radius); text-decoration: none; font-weight: 600;
}
.cta {
  transition: filter .15s ease, transform .15s ease;
}
.cta:hover { filter: brightness(1.08); transform: translateY(-1px); }
.cta:active { transform: translateY(0); }
.bar .cta { margin: 0; padding: .45rem .95rem; font-size: .85rem; color: var(--on-accent); }

/* Figures. The label lives inside the same element as the number so that a
   figure the crew centre did not send takes its whole block with it. */
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 1.6rem; }
.figures > div { display: grid; gap: .15rem; }
.figures b { font-size: clamp(1.9rem, 5vw, 3rem); line-height: 1; letter-spacing: -.04em; font-family: var(--font-display); }
.figures span { color: var(--muted); font-size: .88rem; }

/* Lists */
.rows, .steps { list-style: none; margin: 0; padding: 0; }
.rows li, .steps li {
  display: flex; flex-wrap: wrap; gap: .15rem 1rem; align-items: baseline;
  padding: .9rem 0; border-top: 1px solid var(--line);
}
.rows li:last-child, .steps li:last-child { border-bottom: 1px solid var(--line); }
.rows span, .steps span { color: var(--muted); font-size: .92rem; }
/* Rank badges and aircraft photographs, inside a row. An image that never
   arrived is removed by crew-feed.js rather than drawn as a broken icon, so
   this only ever styles one that is really there. */
/* Rank badges and aircraft photographs.

   crew-feed.js removes an <img> whose src never arrived, because an empty src
   is a broken-image icon. That leaves the .badge span behind, and the span is
   why the words in a list stay in one column when only SOME rows have a
   picture: an empty badge holds the same width as a full one.

   And when no row in the list has a picture at all, the column is pointless —
   :has(img) is what tells the two cases apart. A browser without :has falls
   back to a ragged left edge, which is untidy and still legible. */
.rows .badge, .steps .badge { flex: none; display: none; }
/* ONE width for the whole column, not per row. Sizing each badge to its own
   picture staggers the text again — a wide aircraft photo pushes only its own
   row across, which is the same ragged edge in a different place. The picture
   fits the column; the column does not fit the picture. */
.rows:has(img) .badge, .steps:has(img) .badge {
  display: block; width: 2.5rem; height: 1.8rem;
}
.rows .badge img, .steps .badge img {
  width: 100%; height: 100%; object-fit: contain; object-position: left center;
  border-radius: 4px; display: block;
}
.steps { counter-reset: step; }
.steps li::before {
  counter-increment: step; content: counter(step);
  font-family: var(--font-mono); font-size: .75rem; color: var(--accent);
  min-width: 1.4rem;
}
.more { margin-top: 1.2rem; font-size: .9rem; }
.more a { text-decoration: none; font-weight: 600; }

/* The apply band */
.band {
  background: var(--accent); color: var(--on-accent);
  padding: var(--gap) var(--pad); margin-top: var(--gap); text-align: center;
}
.band h2 { color: inherit; }
.band p { color: inherit; opacity: .85; margin: 0; }
.band .cta { background: var(--on-accent); color: var(--accent); }

/* The Instagram wall. 326x470 is the only size Instagram's embed lays out at
   and a cross-origin frame cannot be measured, so a tile holds that ratio and
   site.js scales the frame into it. */
.wall { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); }
.wall__tile {
  position: relative; overflow: hidden; padding: 0; aspect-ratio: 326 / 470;
  display: grid; place-items: center; cursor: pointer;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); color: var(--muted);
  font: inherit; font-size: .8rem;
}
.wall__tile:hover { border-color: var(--accent); }
.wall__tile iframe { position: absolute; top: 0; left: 0; width: 326px; height: 470px; border: 0; transform-origin: top left; }

footer {
  max-width: var(--measure); margin: 0 auto;
  padding: 2.5rem var(--pad) 4rem; color: var(--muted); font-size: .85rem;
}
footer p { margin: .3rem 0; }

@media (max-width: 34rem) {
  .bar__in { flex-direction: column; align-items: flex-start; gap: .6rem; }
}
`;

/* ===========================================================================
 * SITE.JS
 *
 * The two things markup alone cannot do, shipped with every template:
 * mounting the Instagram wall, and removing a section that turned out to have
 * nothing in it.
 *
 * crew-feed.js fills in figures and lists by itself. It deliberately does NOT
 * remove a list that came back empty, because on most pages an empty list still
 * has a fallback row worth showing. A section marked [data-crew-section] is
 * saying the opposite — it only makes sense with real rows in it — so this
 * takes those away.
 * ======================================================================== */
const SITE_JS = `/* Your site's own script. Two jobs, both about what to do when the crew
   centre has nothing to say.

   Nothing here is required for the page to be correct — crew-feed.js has
   already filled in every figure and list by the time this runs, and every
   block ships with a true fallback in the markup. */
(function () {
  'use strict';
  if (!window.CrewFeed) return;

  /* 1. Sections that only make sense with real rows in them.
        A block marked [data-crew-section] is removed when its list came back
        with nothing — "Lately" over an empty space says less than no heading. */
  function pruneEmpty() {
    document.querySelectorAll('[data-crew-section]').forEach(function (el) {
      var list = el.querySelector('[data-crew-list]');
      if (!list) return;
      if (list.getAttribute('data-crew-filled') === null) el.remove();
    });
  }

  /* 2. The Instagram wall.

        THE ADDRESS IS BUILT HERE, from the shortcode, after checking it against
        [A-Za-z0-9_-]. crew-feed.js already did the same thing, and this does it
        again anyway: a src is the one attribute on this page where being wrong
        means somebody else's script runs on your domain. */
  var KINDS = { p: 1, reel: 1, tv: 1 };

  function fit(tile) {
    var frame = tile.querySelector('iframe');
    if (frame && tile.clientWidth) frame.style.transform = 'scale(' + (tile.clientWidth / 326) + ')';
  }

  function mount(tile) {
    if (tile.dataset.mounted) return;
    tile.dataset.mounted = '1';
    var frame = document.createElement('iframe');
    frame.src = tile.dataset.embed;
    frame.title = 'Instagram post';
    frame.loading = 'lazy';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    tile.innerHTML = '';
    tile.appendChild(frame);
    fit(tile);
  }

  function paintWall(data) {
    var section = document.getElementById('wall');
    if (!section) return;
    var posts = (data && data.posts ? data.posts : []).filter(function (p) {
      return p && KINDS[p.kind] && /^[A-Za-z0-9_-]{1,64}$/.test(String(p.code || ''));
    });
    if (!posts.length) { section.remove(); return; }

    var grid = document.getElementById('wallGrid');
    grid.innerHTML = posts.map(function (p) {
      var src = 'https://www.instagram.com/' + p.kind + '/' + p.code + '/embed/';
      return '<button class="wall__tile" type="button" data-embed="' + src + '" aria-label="Open an Instagram post">View post</button>';
    }).join('');

    var tiles = Array.prototype.slice.call(grid.querySelectorAll('.wall__tile'));
    grid.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.wall__tile') : null;
      if (t) mount(t);
    });

    // A tile stays a button until it is scrolled to. Nine Instagram embeds is
    // several megabytes for a section most visitors never reach.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          mount(en.target); io.unobserve(en.target);
        });
      }, { rootMargin: '200px' });
      tiles.forEach(function (t) { io.observe(t); });
    } else {
      tiles.forEach(mount);
    }

    var timer = null;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { tiles.forEach(fit); }, 150);
    });

    if (data.handle) {
      var h = document.getElementById('wallHandle');
      if (h) {
        h.innerHTML = '<a href="https://www.instagram.com/' + data.handle + '/" rel="noopener" target="_blank">@' + data.handle + '</a>';
        h.hidden = false;
      }
    }
    section.hidden = false;
  }

  // CrewFeed.mount() has already run by the time this file executes, but the
  // lists it filled resolve on the network. Wait for its pass to settle.
  CrewFeed.mount().then(function () {
    pruneEmpty();
    return CrewFeed.posts().then(function (posts) {
      return posts ? { posts: posts, handle: posts[0] && posts[0].handle } : null;
    });
  }).then(paintWall).catch(function () { /* the page was already correct */ });
})();
`;

/* ===========================================================================
 * THE TEMPLATES
 *
 * Six. Each is its own design, not a recolour: swap any two accents and you
 * still have two pages nothing like each other.
 * ======================================================================== */
const TEMPLATES = {

    flightline: {
        name: 'Flightline',
        blurb: 'Editorial and confident. A big serif headline over a band of live figures.',
        tags: ['Editorial', 'Light', 'Most popular'],
        font: 'editorial',
        mode: 'auto',
        accent: '#14375e',
        css: `/* Flightline — editorial. Wide measure, generous air, a rule under every
   heading so the page reads as sections rather than one long column. */
:root { --measure: 64rem; --gap: clamp(3rem, 7vw, 5.5rem); }
.hero { padding-top: clamp(3.5rem, 9vw, 7rem); }
h1 { font-weight: 700; font-variation-settings: 'SOFT' 40, 'WONK' 1; }
h2 { padding-bottom: .7rem; border-bottom: 2px solid var(--ink); display: inline-block; }
.block { border-top: 1px solid var(--line); }
.figures { border-top: 3px solid var(--accent); }
.figures b { color: var(--accent); }
.bar { border-bottom: 1px solid var(--line); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'activity', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fff"/>
<rect x="0" y="0" width="160" height="14" fill="#f3f4f7"/>
<rect x="10" y="26" width="86" height="9" rx="1" fill="#14375e"/>
<rect x="10" y="39" width="62" height="5" rx="1" fill="#c9cfda"/>
<rect x="10" y="56" width="140" height="2" fill="#14375e"/>
<g fill="#14375e"><rect x="10" y="64" width="18" height="10" rx="1"/><rect x="45" y="64" width="18" height="10" rx="1"/><rect x="80" y="64" width="18" height="10" rx="1"/><rect x="115" y="64" width="18" height="10" rx="1"/></g>
<g fill="#e4e7ec"><rect x="10" y="88" width="140" height="4"/><rect x="10" y="97" width="140" height="4"/><rect x="10" y="106" width="110" height="4"/></g>`,
    },

    concourse: {
        name: 'Concourse',
        blurb: 'A departure board. Dark, dense, monospaced — the airline as an operation.',
        tags: ['Dark', 'Technical', 'Dense'],
        font: 'technical',
        mode: 'dark',
        accent: '#f2a03d',
        css: `/* Concourse — a departure board. Tight leading, mono everywhere, the accent
   used the way a board uses amber: for the live numbers and nothing else. */
:root { --measure: 68rem; --gap: clamp(2.2rem, 5vw, 3.6rem); --radius: 2px; }
body { font-size: 15px; }
h1 { font-weight: 700; letter-spacing: -.03em; text-transform: uppercase; }
h2 {
  font-family: var(--font-mono); font-size: .82rem; letter-spacing: .18em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 1rem;
}
.bar { border-bottom: 1px solid var(--line); font-family: var(--font-mono); }
.block { border-top: 1px solid var(--line); }
.figures { gap: 1rem; }
.figures b { color: var(--accent); font-family: var(--font-mono); letter-spacing: -.02em; }
.figures span { font-family: var(--font-mono); font-size: .7rem; letter-spacing: .12em; text-transform: uppercase; }
/* The rows are the board: fixed columns, a rule between every one. */
.rows li, .steps li { padding: .55rem 0; font-family: var(--font-mono); font-size: .84rem; }
.rows li b { color: var(--accent); }
.rows span, .steps span { font-family: var(--font-body); }
.band { background: var(--surface); color: var(--ink); border-top: 2px solid var(--accent); }
.band .cta { background: var(--accent); color: #12141a; }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'activity', 'network', 'events', 'notices', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks'] },
        ],
        thumb: `<rect width="160" height="120" fill="#12141a"/>
<rect x="0" y="0" width="160" height="12" fill="#1b1e26"/>
<rect x="10" y="22" width="70" height="8" rx="1" fill="#e8eaf0"/>
<g fill="#f2a03d"><rect x="10" y="40" width="14" height="8" rx="1"/><rect x="42" y="40" width="14" height="8" rx="1"/><rect x="74" y="40" width="14" height="8" rx="1"/><rect x="106" y="40" width="14" height="8" rx="1"/></g>
<g fill="#2a2e38"><rect x="10" y="60" width="140" height="1"/><rect x="10" y="70" width="140" height="1"/><rect x="10" y="80" width="140" height="1"/><rect x="10" y="90" width="140" height="1"/><rect x="10" y="100" width="140" height="1"/></g>
<g fill="#f2a03d"><rect x="10" y="63" width="22" height="4"/><rect x="10" y="73" width="22" height="4"/><rect x="10" y="83" width="22" height="4"/><rect x="10" y="93" width="22" height="4"/></g>
<g fill="#4a505e"><rect x="40" y="63" width="60" height="4"/><rect x="40" y="73" width="72" height="4"/><rect x="40" y="83" width="52" height="4"/><rect x="40" y="93" width="66" height="4"/></g>`,
    },

    horizon: {
        name: 'Horizon',
        blurb: 'Airy and modern. Lots of white, a wide hero, everything given room.',
        tags: ['Light', 'Spacious', 'Modern'],
        font: 'grotesk',
        mode: 'light',
        accent: '#1b5fc1',
        css: `/* Horizon — air. The design decision here is restraint: one accent, one
   weight of rule, and a great deal of space doing the work a border would. */
:root { --measure: 70rem; --gap: clamp(4rem, 10vw, 8rem); --radius: 14px; }
.hero { padding-top: clamp(4rem, 12vw, 9rem); text-align: center; }
.hero .lede { margin-left: auto; margin-right: auto; }
h1 { font-weight: 500; letter-spacing: -.035em; }
h2 { text-align: center; color: var(--muted); font-weight: 500; }
.figures { text-align: center; gap: 2.5rem; }
.figures b { font-weight: 500; }
/* Centred as a block, left-aligned as text. A paragraph set centre-aligned is
   hard to read; one hanging off the left under a centred heading looks like a
   mistake. Centring the column and not the lines is the way out of both. */
.prose { margin-inline: auto; }
.rows li, .steps li { border-top: 0; border-bottom: 1px solid var(--line); }
.rows li:last-child { border-bottom: 1px solid var(--line); }
.more { text-align: center; }
.band { border-radius: var(--radius); margin-left: var(--pad); margin-right: var(--pad); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'about', 'network', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fff"/>
<circle cx="14" cy="10" r="3" fill="#1b5fc1"/>
<rect x="34" y="24" width="92" height="9" rx="2" fill="#20242c"/>
<rect x="48" y="39" width="64" height="4" rx="2" fill="#c9cfda"/>
<rect x="60" y="51" width="40" height="10" rx="5" fill="#1b5fc1"/>
<g fill="#1b5fc1"><rect x="20" y="76" width="16" height="9" rx="1"/><rect x="58" y="76" width="16" height="9" rx="1"/><rect x="96" y="76" width="16" height="9" rx="1"/></g>
<g fill="#eef1f5"><rect x="20" y="100" width="120" height="3" rx="1.5"/><rect x="20" y="109" width="90" height="3" rx="1.5"/></g>`,
    },

    terminal: {
        name: 'Terminal',
        blurb: 'Nothing but type and rules. Loads instantly, works anywhere, ages well.',
        tags: ['Minimal', 'Fast', 'Technical'],
        font: 'technical',
        mode: 'auto',
        accent: '#0e8c5a',
        css: `/* Terminal — a document, not a brochure. No cards, no shadows, no images.
   A narrow measure and one rule weight, because the only thing on this page is
   what the airline actually says. */
:root { --measure: 44rem; --gap: clamp(2rem, 5vw, 3rem); --radius: 0; }
body { font-size: 15px; }
h1 { font-size: clamp(1.5rem, 4vw, 2.1rem); font-weight: 700; }
h2 { font-size: .95rem; text-transform: uppercase; letter-spacing: .1em; color: var(--accent); }
.bar { border-bottom: 2px solid var(--ink); }
.block { border-top: 1px solid var(--line); }
.lede { font-size: 1rem; }
.figures { display: block; }
.figures > div { display: flex; gap: .6rem; align-items: baseline; padding: .35rem 0; }
.figures b { font-size: 1.1rem; font-family: var(--font-mono); min-width: 5rem; }
.figures span { font-size: .9rem; }
.rows li, .steps li { padding: .5rem 0; }
.cta { background: none; color: var(--accent); border: 1px solid currentColor; }
/* This design is a document. A banner running to the window belongs on a
   brochure; here it stays inside the measure with the words. */
.hero__bg { margin-inline: 0; }
.band { background: none; color: var(--ink); border-top: 2px solid var(--ink); text-align: left; padding-left: 0; padding-right: 0; max-width: var(--measure); margin: var(--gap) auto 0; }
.band .cta { background: none; color: var(--accent); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'activity', 'notices', 'events', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks'] },
            { path: 'about.html', title: 'About', blocks: ['about'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fbfbfa"/>
<rect x="14" y="14" width="132" height="2" fill="#1a1c1e"/>
<rect x="14" y="26" width="66" height="7" rx="1" fill="#1a1c1e"/>
<rect x="14" y="39" width="94" height="3" fill="#b8bdc4"/>
<g fill="#0e8c5a"><rect x="14" y="54" width="10" height="4"/><rect x="14" y="62" width="10" height="4"/><rect x="14" y="70" width="10" height="4"/></g>
<g fill="#c9cdd3"><rect x="30" y="54" width="46" height="4"/><rect x="30" y="62" width="38" height="4"/><rect x="30" y="70" width="52" height="4"/></g>
<rect x="14" y="86" width="132" height="1" fill="#dfe2e6"/>
<g fill="#dfe2e6"><rect x="14" y="93" width="132" height="3"/><rect x="14" y="101" width="132" height="3"/><rect x="14" y="109" width="100" height="3"/></g>`,
    },

    cabin: {
        name: 'Cabin',
        blurb: 'Warm and friendly. Rounded, card-based — good for a crew that is still small.',
        tags: ['Light', 'Friendly', 'Cards'],
        font: 'humanist',
        mode: 'light',
        accent: '#c05a2e',
        css: `/* Cabin — warm. Everything sits in a card with a soft edge; the point is that
   a small airline looks deliberate rather than sparse. */
:root { --measure: 60rem; --gap: clamp(2.5rem, 6vw, 4rem); --radius: 18px; }
h1 { font-weight: 700; letter-spacing: -.025em; }
.bar { padding-top: 1.4rem; }
.hero { text-align: center; }
.hero .lede { margin-inline: auto; }
.block, .figures {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: clamp(1.5rem, 4vw, 2.4rem);
  margin-bottom: 1.2rem;
}
.figures { text-align: center; }
.figures b { color: var(--accent); }
.rows li, .steps li { border-top: 1px dashed var(--line); }
.rows li:first-child, .steps li:first-child { border-top: 0; }
.rows li:last-child, .steps li:last-child { border-bottom: 0; }
.band { border-radius: var(--radius); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'about', 'activity', 'network', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fdf8f4"/>
<rect x="10" y="8" width="140" height="16" rx="8" fill="#fff" stroke="#eadfd6"/>
<rect x="52" y="34" width="56" height="8" rx="2" fill="#2a221d"/>
<rect x="10" y="52" width="140" height="26" rx="10" fill="#fff" stroke="#eadfd6"/>
<g fill="#c05a2e"><rect x="26" y="60" width="14" height="9" rx="2"/><rect x="62" y="60" width="14" height="9" rx="2"/><rect x="98" y="60" width="14" height="9" rx="2"/></g>
<rect x="10" y="84" width="140" height="28" rx="10" fill="#fff" stroke="#eadfd6"/>
<g fill="#e8dcd2"><rect x="24" y="92" width="112" height="3" rx="1.5"/><rect x="24" y="101" width="86" height="3" rx="1.5"/></g>`,
    },

    livery: {
        name: 'Livery',
        blurb: 'Colour-forward. Your accent used in full-width blocks, like a poster.',
        tags: ['Bold', 'Colour', 'Poster'],
        font: 'grotesk',
        mode: 'light',
        accent: '#d8102f',
        css: `/* Livery — the accent as the design. The hero is a full block of it and the
   figures sit on it, which is only legible because --on-accent is part of the
   theme rather than assumed to be white. */
:root { --measure: 66rem; --gap: clamp(3rem, 7vw, 5rem); --radius: 0; }
h1 { font-weight: 700; letter-spacing: -.04em; text-transform: uppercase; }
h2 { font-weight: 700; text-transform: uppercase; letter-spacing: -.01em; }
.bar { background: var(--accent); color: var(--on-accent); }
.bar .mark, .bar nav a { color: var(--on-accent); }
.bar .cta { background: var(--on-accent); color: var(--accent); }
/* The hero and the figures are one block of colour, EDGE TO EDGE.

   Full bleed by restructuring rather than by negative margins. A block inside a
   centred main cannot escape it with "margin: 0 -pad": that cancels the padding
   and leaves the centring gutter, so the colour stops short of the viewport on
   any screen wider than the measure — which is every desktop. So main gives up
   its own width here, every block takes the measure back, and the bleeding ones
   keep their text on the same left edge with a padding that grows to fill the
   gutter. No vw units, so a scrollbar cannot cause a horizontal overflow. */
main { max-width: none; padding: 0; }
main > * { max-width: var(--measure); margin-inline: auto; }
/* A class, not a child selector: BASE's own .block rule outranks a type
   selector and would zero this out. */
.block { padding-inline: var(--pad); }
.hero, .figures, .band {
  max-width: none; color: var(--on-accent); background: var(--accent);
  padding-inline: max(var(--pad), calc((100% - var(--measure)) / 2 + var(--pad)));
}
.hero { padding-top: clamp(3rem, 8vw, 6rem); padding-bottom: 0; }
.hero .eyebrow, .hero .lede { color: inherit; opacity: .8; }
.hero .cta { background: var(--on-accent); color: var(--accent); }
.figures { padding-block: clamp(2rem, 5vw, 3.5rem); }
.band { margin-top: 0; }
.figures span { color: inherit; opacity: .75; }
.block { border-top: 4px solid var(--ink); }
.rows li b, .steps li b { text-transform: uppercase; letter-spacing: -.01em; }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'activity', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fff"/>
<rect x="0" y="0" width="160" height="12" fill="#d8102f"/>
<rect x="0" y="12" width="160" height="58" fill="#d8102f"/>
<rect x="12" y="24" width="80" height="11" rx="1" fill="#fff"/>
<rect x="12" y="41" width="56" height="4" rx="1" fill="#ffb3bf"/>
<g fill="#fff"><rect x="12" y="54" width="16" height="9" rx="1"/><rect x="48" y="54" width="16" height="9" rx="1"/><rect x="84" y="54" width="16" height="9" rx="1"/><rect x="120" y="54" width="16" height="9" rx="1"/></g>
<rect x="12" y="80" width="136" height="3" fill="#16181d"/>
<g fill="#e4e7ec"><rect x="12" y="92" width="136" height="4"/><rect x="12" y="101" width="136" height="4"/><rect x="12" y="110" width="104" height="4"/></g>`,
    },
};

const DEFAULT_TEMPLATE = 'flightline';

/* ===========================================================================
 * THEME
 *
 * One small file of custom properties, and the only thing the theme picker
 * writes. Every template's CSS reads through these, so changing an accent is
 * one file and no search-and-replace.
 *
 * --on-accent is derived rather than assumed white: Livery puts body text on a
 * block of the accent, and a VA who picks a pale yellow would otherwise get a
 * page of invisible words.
 * ======================================================================== */

/** Perceived luminance, for deciding what to put ON a colour. */
function luminance(hexColor) {
    let h = String(hexColor).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    // Rec. 601 — close enough for "is this dark", and cheap.
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function normaliseTheme(raw, template) {
    const t = TEMPLATES[template] || TEMPLATES[DEFAULT_TEMPLATE];
    const o = (raw && typeof raw === 'object') ? raw : {};
    return {
        accent: hex(o.accent, t.accent),
        font: FONTS[o.font] ? o.font : t.font,
        mode: MODES[o.mode] ? o.mode : t.mode,
    };
}

function renderThemeCss(theme) {
    const f = FONTS[theme.font];
    const onAccent = luminance(theme.accent) > 0.62 ? '#16181d' : '#ffffff';

    // The two palettes, written once each. `auto` emits the light palette and a
    // prefers-color-scheme block; the fixed modes emit only their own, so a VA
    // who chose dark gets dark on a device set to light.
    const light = [
        `  --bg: #ffffff;`,
        `  --surface: #f8f9fb;`,
        `  --ink: #16181d;`,
        `  --muted: #5c6470;`,
        `  --line: #e4e7ec;`,
    ].join('\n');
    const dark = [
        `  --bg: #0e1014;`,
        `  --surface: #171a20;`,
        `  --ink: #eef1f6;`,
        `  --muted: #98a2b0;`,
        `  --line: #272b33;`,
    ].join('\n');

    let palette;
    if (theme.mode === 'dark') {
        palette = `:root {\n${dark}\n}`;
    } else if (theme.mode === 'light') {
        palette = `:root {\n${light}\n}`;
    } else {
        palette = `:root {\n${light}\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n${dark.replace(/^ {2}/gm, '    ')}\n  }\n}`;
    }

    return `/* theme.css — the colours and type for this whole site.
   Change a value here and every page follows. The Website tab's theme controls
   rewrite this file, so if you edit it by hand, expect the picker to overwrite
   your changes next time somebody uses it.

   Accent: ${theme.accent}   Type: ${FONTS[theme.font].label}   Mode: ${MODES[theme.mode].label} */

@import url('https://fonts.googleapis.com/css2?family=${f.google}&display=swap');

:root {
  --accent: ${theme.accent};
  /* What text on a block of the accent should be. Worked out from the accent's
     own brightness, so a pale accent gets dark text rather than white on white. */
  --on-accent: ${onAccent};

  --font-display: ${f.display};
  --font-body: ${f.body};
  --font-mono: ${f.mono};

  /* Spacing and shape. A template overrides these in style.css. */
  --pad: clamp(1.2rem, 5vw, 3rem);
  --measure: 64rem;
  --gap: clamp(3rem, 7vw, 5rem);
  --radius: 10px;

  color-scheme: ${theme.mode === 'auto' ? 'light dark' : theme.mode};
}

${palette}
`;
}

/* ===========================================================================
 * RENDERING
 * ======================================================================== */

function pageHtml(tpl, page, ctx) {
    const title = page.title ? `${page.title} — ${ctx.name}` : ctx.name;
    const body = page.blocks.map((id) => {
        const block = BLOCKS[id];
        return block ? block(ctx) : `  <!-- unknown block: ${esc(id)} -->`;
    }).join('\n');

    // nav and footer are outside <main> on every page and are not composable
    // blocks, because a page has exactly one of each.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(ctx.name)} — a virtual airline on Infinite Flight.">
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/style.css">
</head>
<body>
${BLOCKS.nav(ctx)}

<main>
${body}
</main>

${BLOCKS.footer(ctx)}

<!-- The feed, then your site's own script. crew-feed.js reads your crew centre
     and fills in everything marked data-crew-*; site.js hangs the Instagram
     wall and clears away a section that turned out to be empty. No key in
     either, and every endpoint they read is public. -->
<script src="${ctx.feedSrc}" data-va="${esc(ctx.slug)}" data-auto="off"></script>
<script src="/site.js"></script>
</body>
</html>
`;
}

function readme(tpl, ctx) {
    return `# ${ctx.name} — your website

Design: **${tpl.name}**. ${tpl.blurb}

## The files

${tpl.pages.map(p => `- \`${p.path}\` — ${p.title || 'the homepage'}`).join('\n')}
- \`theme.css\` — colours and type. The theme controls in the Website tab rewrite this.
- \`style.css\` — the layout and personality of this design.
- \`site.js\` — hangs the Instagram wall and removes a section with nothing in it.

Add a page in the editor. \`index.html\` is what a visitor gets at \`/\`, and a
folder's \`index.html\` is what they get at that folder.

## Where the numbers come from

Every page loads \`crew-feed.js\` with your airline's address. It fills in
anything marked up with \`data-crew-*\`:

- \`<b data-crew-stat="pilots">\` — a figure. Wrap it and its label in
  \`data-crew-figure\` and the whole block goes when the figure does not arrive,
  rather than leaving a dash next to a label.
- \`<ul data-crew-list="routes">\` with a \`<template>\` inside — a list, one
  copy of the template per row. Lists: \`routes\`, \`events\`, \`schedule\`,
  \`notices\`, \`activity\`, \`posts\`.
- \`data-crew-limit\` caps the rows. \`data-crew-written="on"\` narrows
  \`notices\` to what a person actually typed.
- \`<img data-crew-brand="logo">\` — your identity. \`logo\`, \`banner\`,
  \`name\`, \`tagline\`, \`code\`. On an image it fills the \`src\`; on
  anything else it fills the text. **A field you have not set removes the
  element** rather than leaving a broken image, so wrap one in
  \`data-crew-figure\` when the frame around it should go too.

## What is already yours, without typing it again

Your **logo** and **banner** are the ones on your Inflight VA profile. Your
**rank ladder** and your **fleet** are the ones in your crew centre. Change any
of them there and this site follows — there is nothing to re-upload and nothing
to keep in step by hand.

The lists that read from your crew centre: \`routes\`, \`events\`,
\`schedule\`, \`notices\`, \`activity\`, \`posts\`, \`ranks\`,
\`fleet\`, \`roles\`.

**Write a true fallback inside the markup.** If the crew centre is unreachable
the page keeps what you wrote — it never goes blank because a request timed out.
That is why every list in this template ships with a real row already in it.

Reading the feed yourself works too: \`await CrewFeed.routes()\`,
\`CrewFeed.stats()\`, \`CrewFeed.posts()\`. Each resolves to \`null\` rather
than throwing, and \`null\` means "leave the page alone".

## Changing how it looks

Almost everything is a variable in \`theme.css\`. Change \`--accent\` and the
buttons, links and figures all follow. Use the theme controls in the Website tab
and it will be rewritten for you.

The layout lives in \`style.css\`. The top half is shared by every design; the
part below the template's name is what makes this one look like itself.

## Adding a section

The Website tab's **Insert a section** menu drops a ready-made block into the
file you have open — a fleet list, an events list, the Instagram wall. Every
design uses the same class names, so a block from one looks right in another.

## What you can put here

Text files only: \`.html .css .js .json .svg .txt .md .xml .webmanifest\`.
Images are not stored here — put them on an \`https://\` address and link to
them. Your logo and banner already have addresses; the VA Profile tab shows them.

## Your site's address

It runs on its own address, separate from ours. Its JavaScript can read your own
airline's public crew endpoints and nothing else of ours — there is no key in
this site and nothing in it is secret, so you can paste it anywhere.
`;
}

const bytesOf = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');

/**
 * A whole site, laid out.
 *
 * 'theme' is optional — a template's own accent, type and mode are used when it
 * is absent, which is what makes picking a design a single click.
 */
function renderTemplate(templateId, va, { feedSrc, crewBase, theme } = {}) {
    const tpl = TEMPLATES[templateId] || TEMPLATES[DEFAULT_TEMPLATE];
    const id = TEMPLATES[templateId] ? templateId : DEFAULT_TEMPLATE;
    const slug = String((va && va.slug) || '');
    const ctx = {
        name: String((va && va.name) || 'Our Virtual Airline'),
        callsign: String((va && va.callsign) || ''),
        slug,
        crewBase: String(crewBase || 'https://inflight.info'),
        crew: `${String(crewBase || 'https://inflight.info')}/crew/${esc(slug)}`,
        feedSrc: String(feedSrc || 'https://inflight.info/crew-feed.js'),
    };

    const th = normaliseTheme(theme, id);
    const files = tpl.pages.map(p => ({ path: p.path, content: pageHtml(tpl, p, ctx) }));
    files.push({ path: 'theme.css', content: renderThemeCss(th) });
    files.push({ path: 'style.css', content: `${BASE_CSS}\n/* ---- ${tpl.name} ---------------------------------------------------- */\n${tpl.css}` });
    files.push({ path: 'site.js', content: SITE_JS });
    files.push({ path: 'README.md', content: readme(tpl, ctx) });

    return files.map(f => ({
        path: f.path,
        content: f.content,
        bytes: bytesOf(f.content),
        updatedAt: new Date(),
    }));
}

/** One block's markup, for the editor's "Insert a section" menu. */
function renderBlock(blockId, va, { crewBase } = {}) {
    const block = BLOCKS[blockId];
    if (!block) return null;
    const slug = String((va && va.slug) || '');
    const base = String(crewBase || 'https://inflight.info');
    return block({
        name: String((va && va.name) || 'Our Virtual Airline'),
        callsign: String((va && va.callsign) || ''),
        slug,
        crewBase: base,
        crew: `${base}/crew/${esc(slug)}`,
    }).trim();
}

/** The picker's catalogue. Content-free — no file is rendered to build it. */
function catalogue() {
    return {
        templates: Object.keys(TEMPLATES).map(id => ({
            id,
            name: TEMPLATES[id].name,
            blurb: TEMPLATES[id].blurb,
            tags: TEMPLATES[id].tags,
            accent: TEMPLATES[id].accent,
            font: TEMPLATES[id].font,
            mode: TEMPLATES[id].mode,
            pages: TEMPLATES[id].pages.map(p => p.path),
            thumb: TEMPLATES[id].thumb,
        })),
        fonts: Object.keys(FONTS).map(id => ({ id, label: FONTS[id].label, note: FONTS[id].note })),
        modes: Object.keys(MODES).map(id => ({ id, label: MODES[id].label, note: MODES[id].note || '' })),
        blocks: INSERTABLE,
        default: DEFAULT_TEMPLATE,
    };
}

module.exports = {
    TEMPLATES, FONTS, MODES, BLOCKS, INSERTABLE, DEFAULT_TEMPLATE,
    // The two shared assets a builder site needs as much as a hand-written one:
    // the base stylesheet every design is layered on, and the script that hangs
    // the Instagram wall. Exported so vaSiteBuilder.js emits the same style.css
    // and site.js rather than a second copy that drifts.
    BASE_CSS, SITE_JS,
    renderTemplate, renderBlock, renderThemeCss, normaliseTheme, catalogue,
    luminance, hex,
};

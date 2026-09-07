'use strict';
// Conformance test for VA website hosting.
//
// This feature runs a virtual airline's own JavaScript in a browser. The thing
// that makes that safe is not any check in this file — it is that their code
// is served from a different ORIGIN from ours, which the browser enforces. What
// IS in this file are the decisions that would quietly undo that, and the ones
// that would let one VA's address serve another VA's site:
//
//   * a Host header is attacker-controlled. Case, a port, a trailing dot and a
//     look-alike domain must all resolve the same way a router does, or two
//     spellings of one host become two different sites;
//   * a label with a dot in it is somebody probing a wildcard, not a VA, and
//     flattening it would serve one airline's site under another's name;
//   * a file path must not climb, must not smuggle a segment past a check
//     written in terms of '/', and must not shadow our own /__preview route;
//   * only text types are hostable — a binary uploaded as text is an image host
//     we did not agree to run;
//   * path resolution ('/' → index.html, extensionless → .html) is written once
//     so preview and published cannot drift apart;
//   * and the registrable-domain warning has to actually fire for the shared
//     -domain case, because it is the one thing standing between a deployment
//     choice and cookie tossing.
//
// Pure module test — no network, no database, no browser. mongoose is stubbed
// because vaSites pulls it in at require time for its model.

const path = require('path');
const Module = require('module');

const realResolve = Module._resolveFilename;
const STUBS = {
    mongoose: {
        model: () => ({}),
        models: {},
        Schema: function Schema() { this.index = () => {}; },
    },
};
STUBS.mongoose.Schema.Types = { ObjectId: String };
Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return request;
    return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return realLoad.call(this, request, ...rest);
};

const S = require(path.join('..', 'vaSites.js'));
const TPL = require(path.join('..', 'vaSiteTemplates.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) { failures++; console.log(`  FAIL  ${label}\n        got      ${JSON.stringify(got)}\n        expected ${JSON.stringify(expected)}`); }
    else console.log(`  ok    ${label}`);
};

const D = 'vasites.example';

console.log('\nparseSiteHost — which requests belong to a VA');
T('the plain form', S.parseSiteHost('ocean.' + D, D), 'ocean');
T('case folded — Host is attacker-controlled', S.parseSiteHost('OCEAN.VASITES.EXAMPLE', D), 'ocean');
T('a port is not part of the host', S.parseSiteHost('ocean.' + D + ':443', D), 'ocean');
T('a fully-qualified trailing dot is the same host', S.parseSiteHost('ocean.' + D + '.', D), 'ocean');
T('the apex is ours but is no VA', S.parseSiteHost(D, D), '');
T('a hyphenated label is fine', S.parseSiteHost('ocean-virtual.' + D, D), 'ocean-virtual');

console.log('\nparseSiteHost — which do not');
T('the platform itself', S.parseSiteHost('inflight.info', D), null);
T('a look-alike domain', S.parseSiteHost('ocean.vasites.example.evil.test', D), null);
T('a suffix that merely ends the same', S.parseSiteHost('ocean.notvasites.example', D), null);
T('a nested label is a wildcard probe, not a VA', S.parseSiteHost('a.b.' + D, D), null);
T('a label that starts with a hyphen', S.parseSiteHost('-x.' + D, D), null);
T('…or ends with one', S.parseSiteHost('x-.' + D, D), null);
T('an underscore is not a host label', S.parseSiteHost('oce_an.' + D, D), null);
T('no host at all', S.parseSiteHost('', D), null);
T('no domain configured means no VA hosts exist', S.parseSiteHost('ocean.' + D, ''), null);

console.log('\ncleanPath — what a VA may write');
T('a page', S.cleanPath('index.html'), { path: 'index.html' });
T('a leading slash is trimmed, not refused', S.cleanPath('/style.css'), { path: 'style.css' });
T('a folder', S.cleanPath('about/index.html'), { path: 'about/index.html' });

console.log('\ncleanPath — what it refuses');
const refused = (label, input) => {
    const r = S.cleanPath(input);
    T(label, !!r.error && !r.path, true);
};
refused('climbing out with ..', '../../server.js');
refused('a .. buried mid-path', 'a/../../b.html');
refused('a backslash separator', 'a\\..\\server.js');
refused('an absolute path after the trim', '//etc/passwd');
refused('a space', 'my page.html');
refused('shadowing our preview route', '__preview/x.html');
refused('an unknown extension', 'index.php');
refused('no extension at all', 'index');
refused('a binary we do not host', 'logo.png');
refused('empty', '');
refused('too deep', 'a/b/c/d/e/f/g.html');
T('the type list in the error is the real one',
    /\.html/.test(S.cleanPath('x.php').error), true);

console.log('\npickFile — static-host conventions, written once');
const FILES = [
    { path: 'index.html', content: 'home' },
    { path: 'fleet.html', content: 'fleet' },
    { path: 'about/index.html', content: 'about' },
    { path: 'style.css', content: 'css' },
];
const at = (p) => { const f = S.pickFile(FILES, p); return f ? f.content : null; };
T('/ is index.html', at('/'), 'home');
T('a named file', at('/style.css'), 'css');
T('extensionless falls to .html', at('/fleet'), 'fleet');
T('a folder falls to its index', at('/about/'), 'about');
T('…and without the slash too', at('/about'), 'about');
T('a percent-encoded path is decoded', at('/style%2Ecss'), 'css');
T('a page nobody wrote is null, not the homepage', at('/nope.html'), null);
T('a directory that is not there', at('/nope/'), null);

console.log('\nsiteUrlFor');
T('a slug becomes an address', !!S.siteUrlFor('ocean'), !!S.DOMAIN);
T('a slug that is not a host label gets no address', S.siteUrlFor('not a slug'), '');
T('no slug, no address', S.siteUrlFor(''), '');

console.log('\nregistrableGuess — the cookie-tossing warning has to fire');
T('platform and sites domain shared',
    S.registrableGuess('vasites.inflight.info') === S.registrableGuess('inflight.info'), true);
T('a genuinely separate domain is not',
    S.registrableGuess('inflightva.site') === S.registrableGuess('inflight.info'), false);
T('a two-part TLD is not split down the middle',
    S.registrableGuess('sites.example.co.uk'), 'example.co.uk');

console.log('\nthe catalogue — a VA opens the editor to a choice, not a blank file');
const cat = T.catalogue ? T.catalogue() : require(path.join('..', 'vaSiteTemplates.js')).catalogue();
T('there is more than one design to pick from', cat.templates.length >= 4, true);
T('every design names itself and says what it is for',
    cat.templates.every(t => t.id && t.name && t.blurb && t.thumb), true);
T('the default is one of them', !!cat.templates.find(t => t.id === cat.default), true);
T('no two designs share an accent — a catalogue of recolours is not a catalogue',
    new Set(cat.templates.map(t => t.accent)).size, cat.templates.length);
T('there is more than one typeface pairing', cat.fonts.length >= 3, true);
T('and sections a VA can drop in', cat.blocks.length >= 8, true);

// The inside of one <ul data-crew-list="x">, or null if this page has no such
// list. Written as a scan rather than one regex: a lazy [\s\S]*? backtracks
// across a </ul> and happily pairs one list's opening tag with a later list's
// closing one, which is exactly how a broken assertion passes.
function listBody(html, list) {
    const open = html.indexOf(`data-crew-list="${list}"`);
    if (open < 0) return null;
    const from = html.indexOf('>', open);
    const to = html.indexOf('</ul>', from);
    return (from < 0 || to < 0) ? null : html.slice(from + 1, to);
}

console.log('\nevery design lays out a site a VA could actually have written');
const VA = { name: 'Ocean Virtual', slug: 'ocean', callsign: 'OCN' };
const ctx = { feedSrc: 'https://inflight.info/crew-feed.js', crewBase: 'https://inflight.info' };
cat.templates.forEach((meta) => {
    const files = TPL.renderTemplate(meta.id, VA, ctx);
    const named = Object.fromEntries(files.map(f => [f.path, f.content]));
    const total = files.reduce((n, f) => n + f.bytes, 0);

    T(`${meta.id}: every path is one the editor would accept`,
        files.every(f => !!S.cleanPath(f.path).path), true);
    T(`${meta.id}: there is a homepage`, !!named['index.html'], true);
    T(`${meta.id}: it fits the caps`,
        files.length <= S.MAX_FILES && total <= S.MAX_TOTAL_BYTES
        && files.every(f => f.bytes <= S.MAX_FILE_BYTES), true);
    // THE INVARIANT THE WHOLE MODULE IS ARRANGED AROUND. The variety is in the
    // CSS; the wiring is written once. A design that grew its own copy of the
    // markup is a design that will silently stop showing a figure one day.
    T(`${meta.id}: the feed is wired to this VA`,
        /data-va="ocean"/.test(named['index.html']), true);
    T(`${meta.id}: figures are marked up, not typed in`,
        /data-crew-stat="pilots"/.test(named['index.html']), true);
    T(`${meta.id}: lists are marked up too`,
        /data-crew-list="routes"/.test(named['index.html']), true);
    // The rule crew-feed.js is built around, held in the MARKUP: a list a
    // visitor should always see something in carries a real row between the
    // tags, so the page is correct before any fetch resolves. `activity` and
    // `notices` are deliberately exempt — they are marked [data-crew-section]
    // and removed wholesale when the crew centre has nothing, because "Lately"
    // over an empty space says less than no heading at all.
    ['routes', 'events'].forEach((list) => {
        const inner = listBody(named['index.html'], list);
        if (inner === null) return;               // this design does not use it
        T(`${meta.id}: the ${list} list ships a true fallback row`,
            /<li[\s>]/.test(inner.replace(/<template>[\s\S]*?<\/template>/g, '')), true);
    });
    T(`${meta.id}: colour and type are in theme.css, not the pages`,
        !!named['theme.css'] && /--accent:/.test(named['theme.css'])
        && !/--accent:/.test(named['index.html']), true);
    T(`${meta.id}: the design's own look is in style.css`,
        !!named['style.css'] && named['style.css'].includes(meta.name), true);
});

// A backtick anywhere in the CSS or the shipped JS ends the template literal it
// is written in and the whole module stops parsing. It cost two rounds of stale
// screenshots before it was noticed, so it is a check rather than a habit.
console.log('\nno stray backticks in anything written inside a template literal');
T('every design’s CSS', Object.keys(TPL.TEMPLATES).filter(id => TPL.TEMPLATES[id].css.includes('`')), []);
{
    const seed = TPL.renderTemplate(TPL.DEFAULT_TEMPLATE, VA, ctx);
    // style.css carries the shared BASE_CSS and site.js ships verbatim. Both are
    // written as template literals in the module; either would take it down.
    T('the shared stylesheet and site.js',
        seed.filter(f => /\.(css|js)$/.test(f.path) && f.content.includes('`')).map(f => f.path), []);
}

console.log('\nthe airline’s own identity reaches every design');
cat.templates.forEach((meta) => {
    const files = TPL.renderTemplate(meta.id, VA, ctx);
    const named = Object.fromEntries(files.map(f => [f.path, f.content]));
    const all = files.filter(f => f.path.endsWith('.html')).map(f => f.content).join('');

    T(`${meta.id}: the logo the VA already uploaded is on the page`,
        /data-crew-brand="logo"/.test(named['index.html']), true);
    T(`${meta.id}: …inside a holder, so a VA without one gets a wordmark`,
        /data-crew-figure[^>]*>\s*<img data-crew-brand="logo"/.test(named['index.html']), true);
    T(`${meta.id}: the banner is behind the hero, not a gap when absent`,
        /class="hero__bg" data-crew-figure hidden/.test(named['index.html']), true);
    // The two lists that used to be three invented aircraft and three invented
    // ranks. A hard-coded fleet on a hosted site is a website that disagrees
    // with the airline from the day it is published.
    if (/data-crew-list="fleet"/.test(all)) {
        T(`${meta.id}: the fleet is fed, not typed in`,
            !/Boeing 737-800|Airbus A350-900/.test(all), true);
    }
    if (/data-crew-list="ranks"/.test(all)) {
        T(`${meta.id}: the ladder is fed too`,
            !/<b>First Officer<\/b> <span>Long haul opens up/.test(all), true);
    }
});

console.log('\nthe VA’s own words are the one thing nothing writes over');
const textBlock = TPL.renderBlock('text', VA, {});
T('the custom-text block exists', !!textBlock, true);
T('…and nothing in it is fed from anywhere',
    /data-crew-/.test(textBlock), false);
T('…and it is offered in the insert menu',
    cat.blocks.some(b => b.id === 'text'), true);

console.log('\nan image the crew centre does not hold must not become a broken icon');
T('a rank template asks for a badge by field, not by a fixed URL',
    /<img src="\{\{image\}\}"/.test(TPL.renderBlock('ranks', VA, {})), true);
T('the fleet does the same',
    /<img src="\{\{image\}\}"/.test(TPL.renderBlock('fleet', VA, {})), true);

console.log('\nthe VA name is content, not markup');
const hostile = TPL.renderTemplate('flightline', { name: '<script>x</script>', slug: 'x' }, ctx);
T('a name with a tag in it cannot write HTML into any page',
    hostile.filter(f => f.path.endsWith('.html')).every(f => !/<script>x<\/script>/.test(f.content)), true);
T('…it is escaped instead',
    /&lt;script&gt;/.test(hostile.find(f => f.path === 'index.html').content), true);

console.log('\nthe theme — one small file, and what goes on the accent is worked out');
T('a hex accent is kept', TPL.normaliseTheme({ accent: '#ff0055' }, 'flightline').accent, '#ff0055');
T('anything that is not a colour falls back to the design\'s own',
    TPL.normaliseTheme({ accent: 'red; } body { display:none' }, 'flightline').accent,
    TPL.TEMPLATES.flightline.accent);
T('an unknown typeface falls back too',
    TPL.normaliseTheme({ font: 'comic' }, 'flightline').font, TPL.TEMPLATES.flightline.font);
T('an unknown design falls back to the default',
    TPL.normaliseTheme({}, 'nope').accent, TPL.TEMPLATES[TPL.DEFAULT_TEMPLATE].accent);

const paleCss = TPL.renderThemeCss({ accent: '#ffe680', font: 'grotesk', mode: 'light' });
T('a pale accent gets dark text on it, not white on white',
    /--on-accent: #16181d/.test(paleCss), true);
/* WHAT GOES ON THE ACCENT IS MEASURED, NOT GUESSED.
 *
 * A brightness threshold gets the two ends right and the middle wrong: a
 * mid-tone blue used to fall just under it and be given white text at about
 * 2.6:1, which is a button whose label you have to lean in to read. Every
 * design's own accent has to clear the WCAG large-text bar with whichever ink
 * it was given, or the button that says "Apply to fly" is the least readable
 * thing on the page. */
T('every design\'s own accent gets readable text on it',
    Object.keys(TPL.TEMPLATES).filter((id) => {
        const a = TPL.TEMPLATES[id].accent;
        return TPL.contrast(a, TPL.onAccentFor(a)) < 3;
    }), []);
T('a mid-tone accent is given the ink that can actually be read on it',
    TPL.onAccentFor('#4da3ff'), '#16181d');
T('…and a dark one still gets white', TPL.onAccentFor('#14375e'), '#ffffff');
const darkCss = TPL.renderThemeCss({ accent: '#14375e', font: 'grotesk', mode: 'light' });
T('a dark accent gets white', /--on-accent: #ffffff/.test(darkCss), true);
T('a light-mode theme does not also ship a dark palette',
    /prefers-color-scheme/.test(darkCss), false);
T('an auto theme does', /prefers-color-scheme: dark/.test(
    TPL.renderThemeCss({ accent: '#14375e', font: 'grotesk', mode: 'auto' })), true);
T('theme.css is a file the editor would accept', !!S.cleanPath('theme.css').path, true);

console.log('\nblocks — the same section, right in any design');
T('a known block renders', /data-crew-list="activity"/.test(TPL.renderBlock('activity', VA, {})), true);
T('an unknown one is null, not an empty section', TPL.renderBlock('nope', VA, {}), null);
T('every offered block actually exists',
    cat.blocks.every(b => !!TPL.renderBlock(b.id, VA, {})), true);
T('nav and footer are not offered — a page has one of each',
    cat.blocks.some(b => b.id === 'nav' || b.id === 'footer'), false);


/* ===========================================================================
 * THE DESIGN SYSTEM
 *
 * Eight designs, one stylesheet, one set of blocks. What is worth testing is
 * not that any of them looks good — that is not a thing a test can see — but
 * the invariants that make eight designs cheaper to keep than one:
 *
 *   every design's pages are made of blocks that exist;
 *   every design fits the storage caps a hosted site is held to;
 *   every asset a page asks for is RELATIVE, because the same bytes are served
 *     at two addresses and a rooted path is only right at one of them;
 *   the header works without JavaScript, and the menu works with it;
 *   and the airline's own motif reaches the stylesheet.
 * ======================================================================== */
console.log('\neight designs, one set of parts');
{
    const ids = Object.keys(TPL.TEMPLATES);
    T('there is more than one design to choose from', ids.length >= 6, true);
    T('every page of every design is made of blocks that exist',
        ids.every(id => TPL.TEMPLATES[id].pages.every(pg => pg.blocks.every(b => !!TPL.BLOCKS[b]))), true);
    T('every design has a homepage',
        ids.every(id => TPL.TEMPLATES[id].pages.some(pg => pg.path === 'index.html')), true);
    T('every design carries a thumbnail for the picker',
        ids.every(id => typeof TPL.TEMPLATES[id].thumb === 'string' && TPL.TEMPLATES[id].thumb.length > 40), true);

    // The caps in vaSites.js: 256 KB a file, 2 MB a site, 60 files.
    const sizes = ids.map(id => TPL.renderTemplate(id, VA, ctx));
    T('no design writes a file too big to store',
        sizes.every(fs => fs.every(f => f.bytes <= 256 * 1024)), true);
    T('no design is too big to store whole',
        sizes.every(fs => fs.reduce((a, f) => a + f.bytes, 0) <= 2 * 1024 * 1024), true);
    T('every file a design writes is one the editor would accept',
        sizes.every(fs => fs.every(f => !!S.cleanPath(f.path).path)), true);
}

console.log('\nthe same bytes, served at two addresses');
{
    // A hosted site is reachable at the airline's own subdomain AND at
    // inflight.info/va/<slug>/. A stylesheet asked for at "/theme.css" is the
    // platform's root at the second address, which is a 404 — so nothing a page
    // asks for may start with a slash.
    const pages = TPL.renderTemplate('flightline', VA, ctx).filter(f => /\.html$/.test(f.path));
    const rooted = [];
    pages.forEach((f) => {
        const re = /(?:href|src)="(\/[^\/][^"]*)"/g;
        let m; while ((m = re.exec(f.content))) rooted.push(f.path + ' -> ' + m[1]);
    });
    T('no page asks for anything at a rooted path', rooted, []);
    T('the stylesheet is asked for relatively',
        /<link rel="stylesheet" href="theme\.css">/.test(pages[0].content), true);
}

console.log('\nthe header — a menu on a phone, and links without JavaScript');
{
    const home = TPL.renderTemplate('horizon', VA, ctx).find(f => f.path === 'index.html').content;
    T('there is a burger', /class="bar__burger"/.test(home), true);
    // The whole no-JavaScript story hangs on this one attribute: the button
    // ships hidden and site.js reveals it, so a page whose script never loads
    // has a plain row of links rather than a control that does nothing.
    T('…and it ships hidden, for site.js to reveal', /class="bar__burger"[^>]*\shidden>/.test(home), true);
    T('it says what it controls', /aria-controls="siteNav"/.test(home) && /id="siteNav"/.test(home), true);
    T('it says whether it is open', /aria-expanded="false"/.test(home), true);
    T('the scrim is a button, not an unfocusable div', /<button class="bar__scrim"/.test(home), true);
    T('…and ships hidden too', /class="bar__scrim"[^>]*\shidden>/.test(home), true);

    // A design that produces a join page must link it, and one that does not
    // must not — a header naming a page the design never writes is a 404 on
    // every site using it.
    const paths = (html) => (html.match(/<nav class="bar__nav"[\s\S]*?<\/nav>/) || [''])[0];
    const nav = paths(home);
    const written = TPL.TEMPLATES.horizon.pages.map(p => p.path);
    T('the header links every page the design writes',
        written.every(p => nav.includes(p === 'index.html' ? 'href="./"' : 'href="' + p + '"')), true);
    const terminalNav = paths(TPL.renderTemplate('terminal', VA, ctx).find(f => f.path === 'index.html').content);
    T('…and links no page it does not', terminalNav.includes('join.html'), false);

    const js = TPL.SITE_JS;
    T('the script marks the document so CSS knows JavaScript ran',
        /setAttribute\('data-js'/.test(js), true);
    T('the menu can be closed with Escape', /key === 'Escape'/.test(js), true);
    T('…and by the scrim behind it', /scrim\.addEventListener\('click'/.test(js), true);
    T('…and the page does not scroll behind it', /data-nav-open/.test(js), true);
    T('…and Tab is held inside it while it is open', /e\.key !== 'Tab'/.test(js), true);
}

console.log('\nthe motif — the half of a brand a colour picker cannot reach');
{
    const withMotif = TPL.renderThemeCss(TPL.normaliseTheme({ pattern: 'chevron' }, 'livery'));
    T('the motif reaches the stylesheet', /--motif-image: linear-gradient/.test(withMotif), true);
    // currentColor is what makes ONE declaration correct behind dark text on
    // the page and light text on a block of the accent. A fixed ink would be
    // invisible on one of the two.
    T('…drawn from currentColor, so it works on the page and on the accent',
        /color-mix\(in srgb, currentColor/.test(withMotif), true);
    T('none is a real answer, not a broken one',
        /--motif-image: none/.test(TPL.renderThemeCss(TPL.normaliseTheme({ pattern: 'none' }, 'livery'))), true);
    T('a motif nobody has heard of falls back to the design\'s own',
        TPL.normaliseTheme({ pattern: 'tartan' }, 'livery').pattern, TPL.TEMPLATES.livery.pattern);

    T('the corner is one number a VA moves', TPL.normaliseTheme({ radius: 20 }, 'cabin').radius, 20);
    // A site stored before this field existed reads back null, and Number(null)
    // is 0 — which would square off every corner on every site that had never
    // been asked. Absence has to be tested before the number is.
    T('a corner nobody chose is the design\'s, not zero',
        TPL.normaliseTheme({ radius: null }, 'cabin').radius, TPL.TEMPLATES.cabin.radius);
    T('…and a corner somebody chose to be zero stays zero',
        TPL.normaliseTheme({ radius: 0 }, 'cabin').radius, 0);
    T('…clamped, so a site cannot be all circles', TPL.normaliseTheme({ radius: 900 }, 'cabin').radius, 28);
    T('…and a small element is rounded less than a large one',
        /--radius: 20px;/.test(TPL.renderThemeCss({ radius: 20 })) && /--radius-sm: 11px;/.test(TPL.renderThemeCss({ radius: 20 })), true);

    // This is an export. A stored theme from before motifs existed, or a
    // caller handing over three fields, must get a stylesheet, not a crash.
    T('a partial theme still renders a stylesheet',
        /--accent:/.test(TPL.renderThemeCss({ accent: '#123456' })), true);
    T('…and an empty one does too', /--accent:/.test(TPL.renderThemeCss({})), true);

    const cat2 = TPL.catalogue();
    T('the picker is offered every motif', cat2.patterns.length, Object.keys(TPL.PATTERNS).length);
    T('…each carrying the real CSS, so a swatch is the pattern it offers',
        cat2.patterns.every(p => typeof p.image === 'string' && p.image.length > 0), true);
    T('…and every design names one it has', cat2.templates.every(t => !!TPL.PATTERNS[t.pattern]), true);
}

console.log('\nthe fleet — a picture for every aircraft, and whose it is');
{
    const fleetPage = TPL.renderTemplate('skyline', VA, ctx).find(f => f.path === 'fleet.html').content;
    // A section that fades in when it is scrolled to has never been scrolled to
    // on paper. Printing must not hand somebody a page of blanks.
    T('a section waiting to be scrolled to still prints',
        /@media print[\s\S]*\[data-reveal\][^}]*opacity: 1 !important/.test(TPL.BASE_CSS), true);
    T('the fleet asks the feed for its rows', /data-crew-list="fleet"/.test(fleetPage), true);
    T('every card has a picture well', /class="card__media"/.test(fleetPage), true);
    // The credit is part of the template, not something a VA has to remember.
    T('…and a credit line under it', /class="card__credit">\{\{credit\}\}/.test(fleetPage), true);
    T('a drawn outline is contained, not cropped', /data-fit="\{\{fit\}\}"/.test(fleetPage), true);
}

console.log(failures ? `\n${failures} failing\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

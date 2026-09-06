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

console.log('\nstarterFiles — a VA opens the editor to something that works');
const files = S.starterFiles({ name: 'Ocean Virtual', slug: 'ocean' }, 'https://inflight.info/crew-feed.js', 'https://inflight.info');
const named = Object.fromEntries(files.map(f => [f.path, f.content]));
T('there is a homepage', Object.keys(named).includes('index.html'), true);
T('every starter file is one a VA is allowed to write',
    files.every(f => !!S.cleanPath(f.path).path), true);
T('the feed is wired to the right VA',
    /data-va="ocean"/.test(named['index.html']), true);
T('the figures are marked up, not typed in',
    /data-crew-stat="pilots"/.test(named['index.html']), true);
T('the new feeds are demonstrated',
    /data-crew-list="activity"/.test(named['index.html']) && /data-crew-written/.test(named['index.html']), true);
T('a VA name with markup in it cannot write HTML into its own starter',
    /&lt;script&gt;/.test(S.starterFiles({ name: '<script>x</script>', slug: 'x' }, 'f.js', 'https://i')[0].content), true);
T('every file is sized', files.every(f => f.bytes > 0), true);
T('the starter fits the caps',
    files.length <= S.MAX_FILES && files.every(f => f.bytes <= S.MAX_FILE_BYTES), true);

console.log(failures ? `\n${failures} failing\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

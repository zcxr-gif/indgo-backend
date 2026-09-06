'use strict';
// The VA site host, end to end, over a real HTTP server.
//
// test-va-sites.js checks the pure functions. This checks the middleware they
// are wired into, because the middleware is the security boundary and its
// failure modes are not visible from the functions:
//
//   * a request on a VA's address must NEVER fall through to the platform's
//     routes. This backend ends with `app.use(express.static(__dirname))`, so a
//     fall-through on an unmatched path serves the repository directory — this
//     test stands a decoy route and a static mount behind the middleware and
//     proves neither is ever reached;
//   * a request that is NOT on a VA host must fall through untouched, or
//     mounting this takes the platform down;
//   * a draft is only reachable with a live preview token, and an expired or
//     wrong one is a 404, not a hint;
//   * one VA's token must not open another VA's draft;
//   * a site that is off, blocked, or never published answers identically —
//     "this site is disabled" is a sentence about a VA we were not asked to
//     publish on their own address;
//   * every response carries the CSP and nosniff, including the 404s, and the
//     app-wide Access-Control-Allow-Origin does not survive onto a VA host.
//
// Needs express (and vaSites' mongoose stub). No database: CrewSite.findOne is
// replaced with a lookup over an object literal.
//
// Run:  node scratchpad/test-va-sites-serving.js

const path = require('path');
const http = require('http');
const Module = require('module');

process.env.VA_SITES_DOMAIN = 'vasites.example';
process.env.PUBLIC_SITE_ORIGIN = 'https://inflight.info';

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

const express = require('express');
const S = require(path.join('..', 'vaSites.js'));

const soon = new Date(Date.now() + 60000);
const past = new Date(Date.now() - 60000);

const SITES = {
    ocean: {
        slug: 'ocean', enabled: true, blocked: false,
        previewToken: 'oceantoken0123456789ab', previewExpires: soon,
        draft: { files: [{ path: 'index.html', content: 'DRAFT OCEAN' }] },
        published: { files: [
            { path: 'index.html', content: 'LIVE OCEAN' },
            { path: 'style.css', content: 'body{}' },
            { path: 'about/index.html', content: 'ABOUT' },
            { path: '404.html', content: 'OCEAN LOST' },
        ], version: 3 },
    },
    // Published, but the VA switched it off.
    quiet: {
        slug: 'quiet', enabled: false, blocked: false,
        draft: { files: [] },
        published: { files: [{ path: 'index.html', content: 'LIVE QUIET' }], version: 1 },
    },
    // Published, but Inflight took it down.
    held: {
        slug: 'held', enabled: true, blocked: true, blockedReason: 'impersonation',
        draft: { files: [] },
        published: { files: [{ path: 'index.html', content: 'LIVE HELD' }], version: 1 },
    },
    // A draft and an EXPIRED preview token.
    stale: {
        slug: 'stale', enabled: true, blocked: false,
        previewToken: 'staletoken0123456789ab', previewExpires: past,
        draft: { files: [{ path: 'index.html', content: 'DRAFT STALE' }] },
        published: { files: [], version: 0 },
    },
};

S.CrewSite.findOne = (q) => ({ lean: async () => SITES[q && q.slug] || null });

const app = express();
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
S.mountVaSiteHost(app);
// Everything below stands in for the platform. If a VA-host request reaches any
// of it, the middleware has leaked and this test says so.
app.get('/', (_req, res) => res.send('PLATFORM ROOT'));
app.get('/index.html', (_req, res) => res.send('PLATFORM INDEX'));
app.use(express.static(path.join(__dirname, '..')));
app.use((_req, res) => res.status(404).send('PLATFORM 404'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) { failures++; console.log(`  FAIL  ${label}\n        got      ${JSON.stringify(got)}\n        expected ${JSON.stringify(expected)}`); }
    else console.log(`  ok    ${label}`);
};

function req(server, host, url) {
    return new Promise((resolve) => {
        const r = http.request({
            host: '127.0.0.1', port: server.address().port, path: url, method: 'GET',
            headers: { Host: host },
        }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
        r.end();
    });
}

(async () => {
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const get = (host, url) => req(server, host, url);
    const D = 'vasites.example';

    console.log('\nThe platform is untouched');
    {
        const r = await get('inflight.info', '/');
        T('a request that is not on a VA host falls through', r.body, 'PLATFORM ROOT');
    }

    console.log('\nA published site');
    {
        T('/ is the homepage', (await get('ocean.' + D, '/')).body, 'LIVE OCEAN');
        T('a named file', (await get('ocean.' + D, '/style.css')).body, 'body{}');
        T('a folder falls to its index', (await get('ocean.' + D, '/about/')).body, 'ABOUT');
        const css = await get('ocean.' + D, '/style.css');
        T('…with its own content type', /text\/css/.test(css.headers['content-type']), true);
    }

    console.log('\nThe fall-through that would serve our repository');
    {
        // '/index.html' and '/' both have a platform route behind this
        // middleware, and express.static would answer '/server.js'.
        const r1 = await get('ocean.' + D, '/index.html');
        T('the platform route is not reached even where the path matches one', r1.body, 'LIVE OCEAN');
        const r2 = await get('ocean.' + D, '/server.js');
        T('express.static never sees a VA host', /PLATFORM|use strict|require\(/.test(r2.body), false);
        T('…it is the VA’s own 404', r2.body, 'OCEAN LOST');
        T('…with a 404 status', r2.status, 404);
        const r3 = await get('ocean.' + D, '/vaSites.js');
        T('nor for a source file the VA did not write', /module\.exports/.test(r3.body), false);
        const r4 = await get('nosuchva.' + D, '/anything');
        T('a VA host with no site is still ours to answer', /PLATFORM/.test(r4.body), false);
        T('…and it 404s', r4.status, 404);
    }

    console.log('\nPreview');
    {
        const ok = await get('ocean.' + D, '/__preview/oceantoken0123456789ab/');
        T('a live token opens the draft', ok.body, 'DRAFT OCEAN');
        T('…and it is told not to be indexed', ok.headers['x-robots-tag'], 'noindex, nofollow');
        T('…and never cached', ok.headers['cache-control'], 'no-store');

        const wrong = await get('ocean.' + D, '/__preview/wrongtoken0123456789/');
        T('a wrong token is a 404', wrong.status, 404);
        T('…and says nothing about the draft', /DRAFT/.test(wrong.body), false);

        const expired = await get('stale.' + D, '/__preview/staletoken0123456789ab/');
        T('an expired token is a 404', expired.status, 404);
        T('…and the draft does not leak', /DRAFT STALE/.test(expired.body), false);

        const crossed = await get('stale.' + D, '/__preview/oceantoken0123456789ab/');
        T('one VA’s token does not open another VA’s draft', /DRAFT/.test(crossed.body), false);

        const noToken = await get('stale.' + D, '/');
        T('a site with only a draft publishes nothing', noToken.status, 404);
        T('…and the draft is not it', /DRAFT STALE/.test(noToken.body), false);
    }

    console.log('\nOff, and held');
    {
        const off = await get('quiet.' + D, '/');
        T('a site switched off is a 404', off.status, 404);
        T('…and does not say so', /LIVE QUIET|off|disabled/i.test(off.body), false);

        const held = await get('held.' + D, '/');
        T('a blocked site is a 404 too', held.status, 404);
        T('…and never names the reason to the public', /impersonation/.test(held.body), false);
        T('…and its pages are gone with it', /LIVE HELD/.test(held.body), false);
    }

    console.log('\nHeaders');
    {
        for (const [label, r] of [
            ['a page', await get('ocean.' + D, '/')],
            ['a 404', await get('ocean.' + D, '/nope.html')],
            ['a preview', await get('ocean.' + D, '/__preview/oceantoken0123456789ab/')],
        ]) {
            const csp = r.headers['content-security-policy'] || '';
            T(`${label} carries a CSP`, /default-src 'self'/.test(csp), true);
            T(`${label} is nosniff`, r.headers['x-content-type-options'], 'nosniff');
            T(`${label} drops the app-wide CORS header`, r.headers['access-control-allow-origin'], undefined);
        }
        const csp = (await get('ocean.' + D, '/')).headers['content-security-policy'];
        T('the feed’s origin can serve scripts', /script-src[^;]*inflight\.info/.test(csp), true);
        T('objects are refused outright', /object-src 'none'/.test(csp), true);
        T('nothing else may frame a VA site', /frame-ancestors 'self'/.test(csp), true);
    }

    console.log('\nMethods');
    {
        const r = await new Promise((resolve) => {
            const q = http.request({
                host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST',
                headers: { Host: 'ocean.' + D, 'Content-Length': '0' },
            }, (res) => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
            q.end();
        });
        T('a VA host serves pages and nothing else', r.status, 405);
        T('…and a POST does not reach the platform', /PLATFORM/.test(r.body), false);
    }

    server.close();
    console.log(failures ? `\n${failures} failing\n` : '\nAll good.\n');
    process.exit(failures ? 1 : 0);
})();

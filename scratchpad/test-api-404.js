'use strict';
// Conformance test for what happens to an /api path that matches no route.
//
// Until there was a guard for it, the answer was "the Aircraft Database".
// Nothing matched, express.static found no file, and the SPA catch-all answered
// with index.html — status 200, content-type text/html, a page about aeroplanes.
// A caller asking for JSON had to work out for itself that the URL was wrong.
//
// That is not a hypothetical. An Infinite Flight OAuth client was registered
// with a redirect URI of /api/crew/if-org/callback — one hyphenated word away
// from the real /api/crew/if/callback — and the consequence was a sign-in that
// simply did not happen, whose only visible symptom was a page of plane
// pictures where a crew center should have been.
//
// So the cases here are the ones where getting it wrong is invisible:
//
//   * every real route still resolves — the guard must not shadow one
//   * a near-miss callback path is a JSON 404 that NAMES the correct URI
//   * any other mistyped /api path is an honest JSON 404, not a page
//   * a non-/api path still reaches the SPA, exactly as before
//   * a path that merely starts with the letters "api" is not swallowed
//
// This one needs real Express, because what is being tested IS the route
// matching — Express 5 changed it, and a hand-rolled matcher would prove
// nothing about the server this runs in.
//
// Run:  node scratchpad/test-api-404.js

const http = require('http');

let express;
try {
    express = require('express');
} catch {
    console.log('\ntest-api-404: express is not installed — run `npm install` first. Skipping.\n');
    process.exit(0);
}

const app = express();

// A representative slice of the real route table, in the real order: a crew
// route with a :slug, the OAuth callback (a LITERAL where other routes have a
// parameter, which is the interesting part), and two more with the same prefix.
app.get('/api/crew/:slug/roster', (req, res) => res.json({ hit: 'roster', slug: req.params.slug }));
app.get('/api/crew/if/callback', (req, res) => res.json({ hit: 'if-callback' }));
app.get('/api/crew/:slug/if', (req, res) => res.json({ hit: 'if-status', slug: req.params.slug }));
app.post('/api/crew/:slug/if/connect', (req, res) => res.json({ hit: 'if-connect' }));
app.get('/api/if-card/:file', (req, res) => res.json({ hit: 'if-card' }));

app.use(express.static(__dirname));

// The guard under test, in the same shape and position as in server.js.
app.use('/api', (req, res) => {
    const attempted = String(req.originalUrl || '').split('?')[0];
    if (/^\/api\/crew\/[^/]+\/callback$/.test(attempted) && attempted !== '/api/crew/if/callback') {
        const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
        const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
        const correct = host ? `${proto}://${host}/api/crew/if/callback` : '/api/crew/if/callback';
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({
            error: 'That is not the Infinite Flight callback address.',
            code: 'wrong_callback_path', attempted, expected: correct,
        });
    }
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'No such API endpoint.', code: 'not_found', attempted });
});

// The SPA catch-all. Sends a marker rather than a file so a test failure reads
// as "this got the aircraft app" instead of as a missing-file error.
app.get(/(.*)/, (req, res) => res.type('html').send('<html>AIRCRAFT DATABASE SPA</html>'));

const server = http.createServer(app);

let failures = 0;
const check = (name, cond, extra = '') => {
    if (cond) { console.log('  ✓', name); return; }
    failures++;
    console.log('  ✗', name, extra ? `\n      ${extra}` : '');
};

const req = (path, method = 'GET') => new Promise((resolve) => {
    const r = http.request({ port: server.address().port, path, method }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    });
    r.end();
});

const isSpa = (r) => /AIRCRAFT DATABASE/.test(r.body);

server.listen(0, async () => {
    console.log('\napi 404 — the real routes still resolve');
    let r = await req('/api/crew/if/callback');
    check('the OAuth callback resolves', r.status === 200 && /if-callback/.test(r.body), `${r.status} ${r.body.slice(0, 80)}`);
    r = await req('/api/crew/britishairways/roster');
    check('an ordinary crew route resolves', r.status === 200 && /roster/.test(r.body));
    r = await req('/api/crew/britishairways/if');
    check('the IF status route resolves', r.status === 200 && /if-status/.test(r.body));
    r = await req('/api/crew/britishairways/if/connect', 'POST');
    check('a POST route resolves', r.status === 200 && /if-connect/.test(r.body));
    r = await req('/api/if-card/abcd.png');
    check('a route whose prefix looks similar resolves', r.status === 200 && /if-card/.test(r.body));

    console.log('\napi 404 — the near miss that caused this');
    r = await req('/api/crew/if-org/callback');
    check('it is a 404, not a 200', r.status === 404, `got ${r.status}`);
    check('it is JSON, not the aircraft app', /json/.test(r.type) && !isSpa(r), r.body.slice(0, 120));
    check('it names the correct URI in full', /\/api\/crew\/if\/callback/.test(r.body), r.body.slice(0, 200));
    check('it repeats what was attempted', /if-org/.test(r.body));
    check('it is flagged as the callback mistake specifically', /wrong_callback_path/.test(r.body));

    console.log('\napi 404 — other ways to get the callback wrong');
    for (const p of ['/api/crew/if_org/callback', '/api/crew/oauth/callback', '/api/crew/ifcallback/callback']) {
        r = await req(p);
        check(`${p} is told the right one`, r.status === 404 && /wrong_callback_path/.test(r.body), r.body.slice(0, 100));
    }
    // Express matches routes case-insensitively, so this reaches the REAL
    // handler rather than the guard. Asserted rather than left to chance: it is
    // the correct outcome (the callback works), and if a future Express or a
    // `caseSensitive` setting changed it, the flow would start 404ing for
    // anybody whose dashboard has a capital in it.
    r = await req('/api/crew/IF/callback');
    check('a capitalised callback still reaches the real handler',
        r.status === 200 && /if-callback/.test(r.body), `${r.status} ${r.body.slice(0, 80)}`);

    console.log('\napi 404 — every other mistyped path');
    r = await req('/api/crew/britishairways/rostr');
    check('a typo in a real route gets an honest JSON 404',
        r.status === 404 && /not_found/.test(r.body) && !isSpa(r));
    r = await req('/api/nonsense');
    check('an unknown API root gets one too', r.status === 404 && /not_found/.test(r.body));
    r = await req('/api/crew/britishairways/roster', 'DELETE');
    check('a method nothing implements gets one too',
        r.status === 404 && /not_found/.test(r.body) && !isSpa(r));

    console.log('\napi 404 — the SPA is untouched');
    r = await req('/some/app/route');
    check('a non-API path still gets the SPA', r.status === 200 && isSpa(r));
    r = await req('/');
    check('the root still gets the SPA', r.status === 200 && isSpa(r));
    // The guard is mounted at /api. A path that merely BEGINS with those three
    // letters is a different path and must fall through untouched.
    r = await req('/apiary/notes');
    check('/apiary is not treated as /api', r.status === 200 && isSpa(r), `${r.status} ${r.body.slice(0, 60)}`);

    console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
    server.close();
    process.exit(failures ? 1 : 0);
});

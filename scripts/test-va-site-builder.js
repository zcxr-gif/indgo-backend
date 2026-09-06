/*
 * scripts/test-va-site-builder.js — `npm run test:sites`
 *
 * The website builder end to end, with Mongo replaced by an object in memory:
 * who may reach the crew centre's door onto the site routes, what a VA can and
 * cannot type into a published page, that changing the design keeps their
 * words, and that a site ejected to files stops being written by the builder.
 *
 * No test framework and no database on purpose — it is `node scripts/...`, it
 * exits non-zero on a failure, and it needs nothing running.
 */
process.env.VA_SITES_DOMAIN = 'inflightva.site';
process.env.PUBLIC_SITE_ORIGIN = 'https://inflight.info';

const express = require('express');
const vaSites = require('../vaSites');
const builder = require('../vaSiteBuilder');

const VA = { _id: 'va1', name: 'British Airways Virtual', slug: 'ba', callsign: 'BAW', status: 'approved' };

// One in-memory site row with just enough of a mongoose document on it.
function fakeSite() {
    const doc = {
        _id: 's1', vaAdId: 'va1', slug: 'ba', mode: 'design', builder: null,
        draft: { files: [] }, published: { files: [], version: 0 }, versions: [],
        enabled: true, blocked: false, template: '', theme: {},
        isNew: false,
        async save() { this.saved = (this.saved || 0) + 1; return this; },
        toObject() { const { save, toObject, ...rest } = this; return rest; },
    };
    return doc;
}
let SITE = fakeSite();
vaSites.CrewSite.findOne = () => SITE;

const VirtualAirlineAd = {
    findById: () => ({ select: () => ({ lean: async () => VA }) }),
};

// The crew gate: whatever the test puts in x-test-role decides.
async function requireCap(req, slug, capability) {
    const role = req.headers['x-test-role'];
    if (!role) return { error: 401 };
    if (role === 'pilot') return { error: 403 };
    if (role === 'staff-without') return { error: 403 };
    if (slug !== 'ba') return { error: 403 };
    return { p: { vaId: 'va1', role: role === 'owner' ? 'owner' : 'staff', name: 'Ada', slug: 'ba', kind: 'crew', cap: capability } };
}

const app = express();
app.use(express.json({ limit: '2mb' }));
vaSites.registerVaSiteRoutes(app, {
    VirtualAirlineAd,
    requirePortal: (req, res) => res.status(401).json({ error: 'portal session required' }),
    requirePortalOwner: (req, res) => res.status(401).json({ error: 'portal session required' }),
    requireAuth: (req, res) => res.status(401).json({ error: 'staff session required' }),
    requireCap,
    logActivity: () => {},
});

const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    let failures = 0;
    const check = (name, cond, extra) => {
        if (cond) { console.log('  ok   ' + name); }
        else { failures++; console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
    };
    const call = async (path, opts = {}) => {
        const res = await fetch(base + path, {
            method: opts.method || 'GET',
            headers: Object.assign({ 'Content-Type': 'application/json' }, opts.role ? { 'x-test-role': opts.role } : {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* not json */ }
        return { status: res.status, json };
    };

    console.log('the door');
    check('no crew token → 401', (await call('/api/crew/ba/site')).status === 401);
    check('a pilot → 403', (await call('/api/crew/ba/site', { role: 'pilot' })).status === 403);
    check('staff without the permission → 403', (await call('/api/crew/ba/site', { role: 'staff-without' })).status === 403);
    check('the portal door still wants a portal session', (await call('/api/va-portal/site')).status === 401);

    console.log('reading');
    const read = await call('/api/crew/ba/site', { role: 'owner' });
    check('owner reads their site', read.status === 200, read.json);
    check('the address is their slug on the sites domain', read.json && read.json.url === 'https://ba.inflightva.site', read.json && read.json.url);
    check('a fresh site is in design mode', read.json && read.json.mode === 'design');

    console.log('picking a design');
    const design = await call('/api/crew/ba/site/design', { role: 'owner', method: 'POST', body: { template: 'concourse' } });
    check('design applied', design.status === 200, design.json);
    check('the draft has files', design.json && design.json.draft.files.length >= 4, design.json && design.json.draft.files.map(f => f.path));
    check('index.html is one of them', design.json && design.json.draft.files.some(f => f.path === 'index.html'));
    check('the document came back', design.json && design.json.builder && design.json.builder.pages.length >= 1);
    check('the design is remembered', design.json && design.json.template === 'concourse');

    console.log('editing the words');
    const doc = design.json.builder;
    doc.pages[0].blocks[0].props.headline = 'Fly the flag.';
    doc.pages[0].blocks.push({ type: 'text', props: { heading: 'Us', body: 'One line.\n\nAnd another.' } });
    const saved = await call('/api/crew/ba/site/builder', { role: 'owner', method: 'PUT', body: { doc } });
    check('the document saved', saved.status === 200, saved.json);
    const index = saved.json.draft.files.find(f => f.path === 'index.html');
    check('the headline is on the page', index.content.includes('Fly the flag.'));
    check('the added section is on the page', index.content.includes('<h2>Us</h2>') && index.content.includes('<p class="prose">And another.</p>'));

    console.log('what a VA cannot type into a page');
    doc.pages[0].blocks.find(b => b.type === 'text').props.heading = '<script>alert(1)</script>';
    doc.pages[0].blocks.push({ type: 'links', props: { heading: 'Elsewhere', items: [{ label: 'Bad', href: 'javascript:alert(1)' }, { label: 'Discord', href: 'discord.gg/x' }] } });
    const hostile = await call('/api/crew/ba/site/builder', { role: 'owner', method: 'PUT', body: { doc } });
    const page = hostile.json.draft.files.find(f => f.path === 'index.html').content;
    check('a typed <script> is escaped', !page.includes('<script>alert(1)') && page.includes('&lt;script&gt;'), page.slice(page.indexOf('&lt;script') - 40, page.indexOf('&lt;script') + 40));
    check('a javascript: link is dropped', !page.includes('javascript:'));
    check('a real link survives', page.includes('https://discord.gg/x'));

    console.log('switching design keeps the words');
    const reskin = await call('/api/crew/ba/site/design', { role: 'owner', method: 'POST', body: { template: 'livery', keepTheme: false } });
    const after = reskin.json.draft.files.find(f => f.path === 'index.html').content;
    check('still their headline', after.includes('Fly the flag.'), reskin.json && reskin.json.error);
    check('style.css changed design', reskin.json.draft.files.find(f => f.path === 'style.css').content.includes('Livery'));

    console.log('the file editor is refused while designed');
    const write = await call('/api/crew/ba/site/file', { role: 'owner', method: 'PUT', body: { path: 'index.html', content: '<h1>by hand</h1>' } });
    check('PUT /site/file → 409 designed', write.status === 409 && write.json.code === 'designed', write.json);

    console.log('publishing');
    const pub = await call('/api/crew/ba/site/publish', { role: 'owner', method: 'POST' });
    check('published', pub.status === 200 && pub.json.published.version === 1, pub.json);
    check('nothing left unpublished', pub.json.hasUnpublishedChanges === false);

    console.log('ejecting');
    const noConfirm = await call('/api/crew/ba/site/eject', { role: 'owner', method: 'POST', body: {} });
    check('eject asks first', noConfirm.status === 409 && noConfirm.json.code === 'confirm_required', noConfirm.json);
    const ejected = await call('/api/crew/ba/site/eject', { role: 'owner', method: 'POST', body: { confirm: true } });
    check('ejected', ejected.status === 200 && ejected.json.mode === 'code', ejected.json);
    const write2 = await call('/api/crew/ba/site/file', { role: 'owner', method: 'PUT', body: { path: 'index.html', content: '<h1>by hand</h1>' } });
    check('now files can be written', write2.status === 200, write2.json);
    const builderAfter = await call('/api/crew/ba/site/builder', { role: 'owner', method: 'PUT', body: { doc } });
    check('and the builder is refused', builderAfter.status === 409 && builderAfter.json.code === 'ejected', builderAfter.json);

    console.log('the catalogue');
    const cat = await call('/api/crew/ba/site/templates', { role: 'owner' });
    check('six designs and the block vocabulary', cat.status === 200 && cat.json.templates.length === 6 && cat.json.builder.blocks.length >= 12, cat.json && Object.keys(cat.json));

    console.log('another VA cannot reach this one');
    check('slug mismatch → 403', (await call('/api/crew/other/site', { role: 'owner' })).status === 403);

    /* VA sites are served under a domain of ours, so a VA slug is one of our
     * hostnames. These are the names that have to stay ours. */
    console.log('labels a VA site may not have');
    const D = process.env.VA_SITES_DOMAIN;
    const host = (h) => vaSites.parseSiteHost(h, D);
    check('an airline gets its own label', host(`ba.${D}`) === 'ba');
    check('a port and a case difference change nothing', host(`BA.${D}:443`) === 'ba');
    ['www', 'api', 'login', 'admin', 'mail', 'ns1', 'postmaster', 'staff', 'crew', 'cdn']
        .forEach(l => check(`${l} is not a VA site`, host(`${l}.${D}`) === null));
    check('a punycode label is refused', host(`xn--80ak6aa92e.${D}`) === null);
    check('a nested label is refused', host(`a.b.${D}`) === null);
    check('another domain entirely is not ours to answer', host('ba.example.com') === null);
    check('the apex is ours, not a VA\'s', host(D) === '');
    check('a reserved slug is given no address', vaSites.siteUrlFor('www') === '');
    check('an ordinary slug is', vaSites.siteUrlFor('ba') === `https://ba.${D}`);

    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    server.close();
    process.exit(failures ? 1 : 0);
});

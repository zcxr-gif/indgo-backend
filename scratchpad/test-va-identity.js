'use strict';
// The airline's mark, next to the airline's name.
//
// Two pieces are under test, and they meet at one shape:
//
//   vaIdentity.js       resolves { id, name, code, slug, logoUrl } for a set of
//                       listing ids, batched and cached, and stamps it onto rows
//                       that until now carried only a denormalized `vaName`.
//   assets/va-chip.js   turns that shape into the inline mark + name that the
//                       staff feed, the leaderboard, the submissions queue and
//                       the embed picker all render.
//
// The cases below are the ones where "just show the logo" quietly goes wrong:
// a listing that has been deleted, a VA that never uploaded a mark, a URL that
// is no longer a URL, a name made of punctuation, and a poll that would
// otherwise re-query the same twenty airlines every few seconds.
//
// Run:  node scratchpad/test-va-identity.js

const path = require('path');
const Module = require('module');

// A stand-in for the VirtualAirlineAd model. Counts queries, because the whole
// point of identityMap is that a list of 200 rows costs ONE of them.
const listings = new Map();
let queries = 0;
let failQuery = false;

const fakeModel = {
    find(filter) {
        queries++;
        const ids = ((filter._id && filter._id.$in) || []).map(String);
        return {
            select() { return this; },
            lean() {
                if (failQuery) return Promise.reject(new Error('database is down'));
                return Promise.resolve(ids.filter(id => listings.has(id)).map(id => listings.get(id)));
            },
        };
    },
};

const mongooseStub = { models: {}, Schema: function () { this.index = () => {}; }, model: () => ({}) };
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'mongoose') return mongooseStub;
    return origLoad.call(this, req, ...rest);
};

const VI = require(path.join(__dirname, '..', 'vaIdentity.js'));

// va-chip.js is a browser file that installs itself on a global. Give it one.
global.window = {};
require(path.join(__dirname, '..', 'assets', 'va-chip.js'));
const VaChip = global.window.VaChip;

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n     want:', JSON.stringify(expected));
};
const OK = (label, cond, note) => {
    if (cond) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, note ? `\n      ${note}` : '');
};

const seed = () => {
    listings.clear();
    listings.set('aaa', { _id: 'aaa', name: 'Ocean Virtual', callsign: 'OCN', slug: 'ocean', logoUrl: 'https://cdn/ocean.png' });
    listings.set('bbb', { _id: 'bbb', name: 'Rednose Virtual', callsign: 'RNV', slug: '', logoUrl: '' });
    queries = 0;
    failQuery = false;
    VI.forgetVaIdentity();
};

(async () => {

console.log('\nResolving an identity');
{
    seed();
    mongooseStub.models.VirtualAirlineAd = fakeModel;
    const map = await VI.identityMap(['aaa', 'bbb', 'zzz']);
    T('a listing resolves to its identity, nothing more',
        map.get('aaa'), { id: 'aaa', name: 'Ocean Virtual', code: 'OCN', slug: 'ocean', logoUrl: 'https://cdn/ocean.png' });
    T('a VA with no mark yet still resolves — the name is the part that matters',
        map.get('bbb').logoUrl, '');
    T('an id with no listing behind it resolves to null, not an exception',
        map.get('zzz'), null);
    T('the whole list cost one query', queries, 1);
}

console.log('\nThe cache');
{
    seed();
    await VI.identityMap(['aaa', 'bbb']);
    await VI.identityMap(['aaa', 'bbb']);
    T('a repeat lookup is free — a dashboard polling every few seconds must not re-query', queries, 1);

    await VI.identityMap(['zzz']);
    const before = queries;
    await VI.identityMap(['zzz']);
    T('a MISS is cached too — a feed full of a deleted VA does not re-query it', queries, before);

    listings.set('aaa', { ...listings.get('aaa'), logoUrl: 'https://cdn/ocean-v2.png' });
    const stale = await VI.identityMap(['aaa']);
    T('without an invalidation the old mark is still served (that is the deal)',
        stale.get('aaa').logoUrl, 'https://cdn/ocean.png');

    VI.forgetVaIdentity('aaa');
    const fresh = await VI.identityMap(['aaa']);
    T('a VA that uploads a logo sees it immediately, not at the end of the TTL',
        fresh.get('aaa').logoUrl, 'https://cdn/ocean-v2.png');
}

console.log('\nStamping rows');
{
    seed();
    const rows = [
        { vaAdId: 'aaa', vaName: 'Ocean Virtual', takeoffs: 4 },
        { vaAdId: 'ccc', vaName: 'Gone Virtual', takeoffs: 2 },   // listing deleted
        { vaAdId: null, vaName: '', takeoffs: 1 },                 // never attributed
    ];
    await VI.attachVaIdentity(rows);
    T('a matched row gets the live branding', rows[0].va.logoUrl, 'https://cdn/ocean.png');
    T('a row whose listing is gone keeps the name the feed recorded',
        rows[1].va, { id: '', name: 'Gone Virtual', code: '', slug: '', logoUrl: '' });
    T('an unattributed row gets null, so the UI can say so', rows[2].va, null);
    T('the recorded vaName is never rewritten — a mismatch is what staff watch for',
        rows[1].vaName, 'Gone Virtual');
}

console.log('\nWhen the lookup cannot answer');
{
    seed();
    failQuery = true;
    const rows = [{ vaAdId: 'aaa', vaName: 'Ocean Virtual' }];
    await VI.attachVaIdentity(rows);
    T('a database failure costs the picture, not the page',
        rows[0].va, { id: '', name: 'Ocean Virtual', code: '', slug: '', logoUrl: '' });

    seed();
    delete mongooseStub.models.VirtualAirlineAd;
    const rows2 = [{ vaAdId: 'aaa', vaName: 'Ocean Virtual' }];
    await VI.attachVaIdentity(rows2);
    T('so does there being no model registered at all', rows2[0].va.name, 'Ocean Virtual');
    mongooseStub.models.VirtualAirlineAd = fakeModel;
}

console.log('\nThe chip');
{
    const withLogo = VaChip.html({ name: 'Ocean Virtual', code: 'OCN', slug: 'ocean', logoUrl: 'https://cdn/ocean.png' }, { size: 20, link: true });
    OK('a mark is an <img>, not a background — it prints and it scales',
        withLogo.includes('<img class="va-chip-mark"'));
    OK('height is what the caller sets; width follows the artwork',
        withLogo.includes('--va-chip-h:20px'), withLogo);
    OK('a chip with a slug links to that VA\'s crew center',
        withLogo.includes('href="/crew/ocean"'), withLogo);
    OK('a dead URL swaps itself for the monogram rather than a broken-image glyph',
        withLogo.includes('onerror='), withLogo);

    const noLogo = VaChip.html({ name: 'Rednose Virtual', slug: '' });
    OK('no mark on file falls back to a monogram of the same height',
        noLogo.includes('va-chip-mono') && noLogo.includes('>RV<'), noLogo);
    OK('and without a slug it is not a link', !noLogo.includes('<a '), noLogo);

    const hostile = VaChip.html({ name: '<img src=x onerror=alert(1)>', logoUrl: 'javascript:alert(1)' });
    OK('a non-http logo is refused — an <img src> is not a place to put a scheme we did not check',
        !hostile.includes('javascript:'), hostile);
    OK('and the name is escaped', !hostile.includes('<img src=x'), hostile);

    T('a name with no letters in it still monograms', VaChip.initials('!!!'), 'VA');
    T('punctuation does not become an initial', VaChip.initials('A&B Virtual'), 'AB');
    T('accents survive', VaChip.initials('Aeroméxico Virtual'), 'AV');

    T('a bare name string is accepted, for callers whose API has not caught up yet',
        VaChip.html('Legacy Name').includes('>LN<'), true);
    T('nothing at all prints the caller\'s placeholder, not an empty row',
        VaChip.html(null, { mono: 'Unattributed' }), '<span class="va-chip-name">Unattributed</span>');
}

console.log(failures ? `\n${failures} failure(s).\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

})();

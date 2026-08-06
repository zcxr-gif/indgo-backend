'use strict';
// Conformance test for the IFC card's failure rendering.
//
// WHY THIS EXISTS. The card is an <img src> on a public Discourse profile, and
// IFC hotlinks it — every reader's browser fetches it directly on every view. So
// the only thing anybody ever sees of a failure is whatever the response body
// renders as, and while that body was JSON, all four ways of failing (no such
// slug, renderer busy, render threw, database unreachable) arrived at the browser
// as one identical broken-image icon. A card that had been fine for hours just
// "disappeared", with no way from the outside to tell which fault it was or
// whether it was even ours.
//
// So failures render a card. The cases checked here are the ones that would put
// us back where we started:
//
//   * every failure produces a REAL, decodable PNG — an error card that cannot
//     itself be drawn is the one outcome worse than the JSON it replaced
//   * it is the same width as the real card, so it sits on a profile as a status
//     rather than as debris
//   * the pilot's own theme is honoured, so a daylight card does not become a
//     black rectangle dropped into their profile
//   * an unknown theme, and no theme at all, still render (a slug that does not
//     exist has no theme to read)
//   * the reason actually reaches the picture rather than being swallowed
//   * absurd input does not throw — this runs on the failure path, where
//     throwing means the browser gets nothing at all
//
// Pure module test: sharp only, no network, no database, no express.

const path = require('path');
const sharp = require('sharp');
const { renderIfCardError } = require(path.join('..', 'ifProfileCard.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// The four reasons the route actually sends, kept in step with server.js by
// being written the same way here.
const REASONS = [
    ['a slug that is not a card address', { status: 404, title: 'That isn’t a card address', detail: 'Check the link in your profile — it should end in .png.' }],
    ['a card that has been deleted',      { status: 404, title: 'This card no longer exists', detail: 'It may have been deleted. Make a new one at inflight.info/card.', theme: 'midnight' }],
    ['the renderer shedding load',        { status: 503, title: 'Busy right now', detail: 'Too many cards being drawn at once.', theme: 'aurora' }],
    ['something structural on our side',  { status: 500, title: 'Stats are unavailable right now', detail: 'This is on our side, not yours.' }],
];

(async () => {
    console.log('\nIFC card errors — every failure is a real image');

    for (const [label, opts] of REASONS) {
        let meta = null;
        let err = null;
        try {
            const png = await renderIfCardError(opts);
            meta = await sharp(png).metadata();
            // PNG magic bytes. `sharp` reporting format:'png' is not quite the
            // same claim as the bytes on the wire being a PNG, and it is the
            // bytes a browser gets.
            meta.magic = png.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
        } catch (e) { err = e.message; }
        T(label, err ? `threw: ${err}` : [meta.format, meta.width, meta.magic], ['png', 1200, true]);
    }

    console.log('\nIFC card errors — themes');

    const themed = async (theme) => {
        const png = await renderIfCardError({ title: 'T', detail: 'D', theme });
        const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        // The middle of the card, which is background in every theme. Read from
        // the raw pixels rather than trusted from the palette, so this fails if
        // the theme stops being applied at all.
        const x = Math.floor(info.width / 2);
        const y = Math.floor(info.height / 2);
        const i = (y * info.width + x) * info.channels;
        return { r: data[i], g: data[i + 1], b: data[i + 2] };
    };

    const midnight = await themed('midnight');
    const daylight = await themed('daylight');
    T('midnight renders dark', midnight.r < 60 && midnight.g < 60 && midnight.b < 60, true);
    T('daylight renders light — not a black box in a light profile',
        daylight.r > 200 && daylight.g > 200 && daylight.b > 200, true);
    T('the two themes are genuinely different',
        midnight.r !== daylight.r, true);

    T('an unknown theme falls back rather than throwing',
        (await sharp(await renderIfCardError({ title: 'T', theme: 'nonsense' })).metadata()).width, 1200);
    T('no theme at all still renders — a missing card has none to read',
        (await sharp(await renderIfCardError({ title: 'T' })).metadata()).width, 1200);

    console.log('\nIFC card errors — the reason reaches the picture');

    // Rendered at two different lengths: if the text were being dropped, both
    // would produce byte-identical images.
    const short = await renderIfCardError({ title: 'Busy', detail: 'Soon.', theme: 'carbon' });
    const long = await renderIfCardError({
        title: 'Stats are unavailable right now',
        detail: 'This is on our side, not yours — your card and its settings are safe.',
        theme: 'carbon',
    });
    T('a different reason produces a different picture',
        short.equals(long), false);

    console.log('\nIFC card errors — nothing on this path may throw');

    const hostile = [
        ['no arguments at all', undefined],
        ['an empty object', {}],
        ['nulls', { title: null, detail: null, theme: null }],
        ['markup in the reason', { title: '<script>alert(1)</script>', detail: '</text><rect/>' }],
        ['an ampersand', { title: 'Fish & Chips', detail: 'a < b > c' }],
        ['something absurdly long', { title: 'x'.repeat(5000), detail: 'y'.repeat(5000) }],
        ['a number where a string goes', { title: 42, detail: 7 }],
    ];
    for (const [label, opts] of hostile) {
        let out = null;
        try {
            const png = await renderIfCardError(opts);
            out = (await sharp(png).metadata()).format;
        } catch (e) { out = `threw: ${e.message}`; }
        T(label, out, 'png');
    }

    console.log(failures ? `\n${failures} failed ❌\n` : '\nAll good ✅\n');
    process.exit(failures ? 1 : 0);
})();

'use strict';
// Offline conformance test: builds cards via the REAL module and validates them
// against Discord's documented webhook/embed limits. No DB, no network.
const path = require('path');
const {
    buildVaEventPayload, isHttpUrl, flightMapImageUrl, normalizeCardOptions,
    resolveAccent, eteTextFor, routeDistanceNm, DEFAULT_CARD_FIELDS,
} = require(path.join('..', 'vaEventCard.js'));

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('  ❌', msg); } };

// Discord limits (https://discord.com/developers/docs/resources/channel#embed-limits)
const LIM = { title: 256, desc: 4096, fields: 25, fname: 256, fval: 1024, author: 256, footer: 2048, total: 6000 };

function validateEmbedPayload(payload, label) {
    console.log('•', label);
    // Top-level webhook shape: must carry at least embeds (we only send embeds).
    check(payload && Array.isArray(payload.embeds) && payload.embeds.length >= 1, 'has embeds[]');
    check(payload.embeds.length <= 10, '≤ 10 embeds');
    const em = payload.embeds[0];

    // Must JSON-serialize cleanly (axios will JSON.stringify it).
    let json;
    try { json = JSON.stringify(payload); } catch (e) { check(false, 'JSON-serializable: ' + e.message); return; }
    check(typeof json === 'string', 'serialized');

    // Length limits.
    if (em.title) check(em.title.length <= LIM.title, `title ≤ ${LIM.title} (got ${em.title.length})`);
    if (em.description) check(em.description.length <= LIM.desc, `description ≤ ${LIM.desc}`);
    check(em.fields.length <= LIM.fields, `≤ ${LIM.fields} fields`);
    check(typeof em.color === 'number' && em.color >= 0 && em.color <= 0xFFFFFF, 'color is a 24-bit int');
    if (em.author) check(em.author.name && em.author.name.length <= LIM.author, 'author.name present & ≤ 256');
    // The Inflight brand mark ALWAYS rides in the footer (text + icon) — never customizable.
    check(em.footer && em.footer.text === 'Powered by Inflight', 'footer = Powered by Inflight (always)');
    check(em.footer && isHttpUrl(em.footer.icon_url), 'footer carries the Inflight logo icon (always)');
    if (em.footer) check(em.footer.text.length <= LIM.footer, 'footer.text ≤ 2048');

    // Fields: non-empty name/value within limits (Discord 400s on empty values).
    let total = (em.title || '').length + (em.description || '').length + (em.author ? em.author.name.length : 0) + (em.footer ? em.footer.text.length : 0);
    for (const f of em.fields) {
        check(typeof f.name === 'string' && f.name.length >= 1 && f.name.length <= LIM.fname, `field name ok: ${f.name}`);
        check(typeof f.value === 'string' && f.value.length >= 1 && f.value.length <= LIM.fval, `field value non-empty ≤ 1024: ${f.name}`);
        total += f.name.length + f.value.length;
    }
    check(total <= LIM.total, `total chars ≤ ${LIM.total} (got ${total})`);

    // Every URL handed to Discord's proxy must be a valid http(s) URL.
    const urls = [];
    if (em.url) urls.push(['title.url', em.url]);
    if (em.image) urls.push(['image.url', em.image.url]);
    if (em.thumbnail) urls.push(['thumbnail.url', em.thumbnail.url]);
    if (em.author && em.author.icon_url) urls.push(['author.icon_url', em.author.icon_url]);
    if (em.footer && em.footer.icon_url) urls.push(['footer.icon_url', em.footer.icon_url]);
    for (const [where, u] of urls) check(isHttpUrl(u), `${where} is valid http(s): ${u}`);

    // timestamp must be ISO-8601.
    check(!em.timestamp || !isNaN(Date.parse(em.timestamp)), 'timestamp is ISO-8601');
    return em;
}

console.log('=== buildVaEventPayload conformance ===\n');

// 1. Full takeoff with all data.
const full = {
    event: 'takeoff', flightId: 'f1', va: { code: 'OCEAN', name: 'Ocean Virtual' },
    callsign: 'Ocean 001VA', username: 'Jane Pilot', server: 'Expert',
    aircraft: { aircraftName: 'Boeing 737-800', liveryName: 'Ocean' },
    departure: 'EGLL', arrival: 'KJFK',
    position: { lat: 43.6777, lon: -79.6248, alt_ft: 4200, gs_kt: 250 }, timestamp: Date.now(),
};
let em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: 'https://cdn.example.com/b738.jpg', vaLogoUrl: 'https://cdn.example.com/ocean.png' }), 'full takeoff + media');
check(em.image && em.image.url === 'https://cdn.example.com/b738.jpg', 'big image = aircraft photo');
check(em.author && em.author.icon_url === 'https://cdn.example.com/ocean.png', 'author icon = VA logo');
check(em.fields.some(f => /ETE/.test(f.name)), 'takeoff shows ETE field');
check(em.fields.some(f => /Distance/.test(f.name)), 'takeoff shows Distance field');

// 2. Landing → gold, and NO ETE (look-ahead only).
em = validateEmbedPayload(buildVaEventPayload({ ...full, event: 'landing' }, {}), 'landing (no media)');
check(em.color === 0xf1c40f, 'landing color = gold');
check(!em.fields.some(f => /ETE/.test(f.name)), 'landing has no ETE field');

// 3. No position at all → no image, still valid.
em = validateEmbedPayload(buildVaEventPayload({ event: 'takeoff', callsign: 'X 1', username: 'P', server: 'Casual' }, {}), 'no coordinates');
check(!em.image, 'no aircraft image when none supplied');

// 4. Malformed media URLs (relative path, empty, non-url) must be dropped, not 400.
em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: '/uploads/x.jpg', vaLogoUrl: '' }), 'malformed media URLs dropped');
check(!em.image || isHttpUrl(em.image.url), 'no malformed image leaks through');

// 5. Hostile/overlong input must be clipped, never empty.
const longName = 'A'.repeat(5000);
em = validateEmbedPayload(buildVaEventPayload({ event: 'takeoff', callsign: longName, username: longName, server: longName,
    aircraft: { aircraftName: longName, liveryName: longName }, position: { lat: 1, lon: 1 }, timestamp: Date.now() }, {}), 'overlong fields clipped');

// 6. Empty/garbage event object — must not throw and still be valid.
em = validateEmbedPayload(buildVaEventPayload({}, {}), 'empty event object');
em = validateEmbedPayload(buildVaEventPayload(undefined, undefined), 'undefined args');

// 7. Customization: accent, custom title, compact field selection, photo off.
const opts = normalizeCardOptions({ accent: '1e90ff', title: 'Ocean Ops', showPhoto: false, fields: ['ete', 'pilot', 'callsign'] });
em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: 'https://cdn.example.com/b738.jpg' }, opts), 'customized takeoff');
check(em.color === 0x1e90ff, 'custom accent honoured');
check(em.title === 'Ocean Ops', 'custom title honoured');
check(!em.image, 'showPhoto:false drops the aircraft image');
const names = em.fields.map(f => f.name).join(' ');
check(/Departure/.test(names) && /Arrival/.test(names), 'route always shown even when not in field list');
check(/ETE/.test(names) && /Pilot/.test(names) && /Callsign/.test(names), 'only chosen fields present');
check(!/Server/.test(names) && !/Aircraft/.test(names), 'unchosen fields absent');

// 8. normalizeCardOptions hardening.
check(JSON.stringify(normalizeCardOptions({}).fields) === JSON.stringify(DEFAULT_CARD_FIELDS), 'empty opts → default field set');
check(normalizeCardOptions({ accent: 'nope' }).accent === '', 'invalid accent → empty (default colour)');
check(normalizeCardOptions({ fields: ['bogus', 'pilot', 'pilot'] }).fields.join() === 'pilot', 'fields deduped & filtered');
check(normalizeCardOptions({ layout: 'weird' }).layout === 'card', 'unknown layout → card');

// 9. Derived route figures.
check(routeDistanceNm('EGLL', 'KJFK') > 2500, 'EGLL→KJFK distance resolves (>2500 NM)');
check(/h/.test(eteTextFor(full) || ''), 'takeoff ETE resolves to an h/m string');
check(eteTextFor({ ...full, event: 'landing' }) === null, 'no ETE for landing');
check(eteTextFor({ ...full, position: { gs_kt: 5 } }) === null, 'no ETE when on the ground (gs<40)');

// 10. resolveAccent.
check(resolveAccent(full, normalizeCardOptions({})).int === 0x2ecc71, 'default takeoff accent = green');
check(resolveAccent(full, normalizeCardOptions({ accent: '#ff0000' })).int === 0xff0000, 'accent override wins');

// 11. isHttpUrl unit checks
check(isHttpUrl('https://a.com/x.png'), 'isHttpUrl https ok');
check(isHttpUrl('http://a.com'), 'isHttpUrl http ok');
check(!isHttpUrl('/relative.png'), 'isHttpUrl rejects relative');
check(!isHttpUrl(''), 'isHttpUrl rejects empty');
check(!isHttpUrl('ftp://a.com'), 'isHttpUrl rejects ftp');
check(!isHttpUrl(null), 'isHttpUrl rejects null');

// 12. Coordinate ordering sanity (lon,lat for mapbox; lat,lon for OSM).
process.env.MAPBOX_STATIC_TOKEN = 'pk.test';
check(flightMapImageUrl(43.6777, -79.6248, true).includes('(-79.6248,43.6777)'), 'mapbox marker = lon,lat');
delete process.env.MAPBOX_STATIC_TOKEN;
check(flightMapImageUrl(43.6777, -79.6248, true).includes('center=43.6777,-79.6248'), 'OSM center = lat,lon');
check(flightMapImageUrl(NaN, 5, true) === null, 'no map for NaN coords');

// 13. Isolation: one VA's customization must never bleed into another's card,
// nor mutate the shared defaults. This is the "each embed doesn't take the
// other's style" guarantee — every call resolves its own options object.
console.log('• isolation between VAs / the shared defaults');
const optsA = normalizeCardOptions({ accent: '#ff0000', title: 'VA A', fields: ['pilot'] });
const optsB = normalizeCardOptions({ accent: '#0000ff', title: 'VA B', fields: ['server', 'ete'] });
// Interleave builds; each must reflect ONLY its own options.
const a1 = buildVaEventPayload(full, {}, optsA).embeds[0];
const b1 = buildVaEventPayload(full, {}, optsB).embeds[0];
const a2 = buildVaEventPayload(full, {}, optsA).embeds[0];
check(a1.color === 0xff0000 && a1.title === 'VA A', 'VA A keeps its own accent/title');
check(b1.color === 0x0000ff && b1.title === 'VA B', 'VA B keeps its own accent/title');
check(JSON.stringify(a1) === JSON.stringify(a2), 'VA A card is identical before/after a B render (no bleed)');
check(a1.fields.some(f => /Pilot/.test(f.name)) && !a1.fields.some(f => /Server/.test(f.name)), 'VA A shows only its fields');
check(b1.fields.some(f => /Server/.test(f.name)) && !b1.fields.some(f => /Pilot/.test(f.name)), 'VA B shows only its fields');
// A default render sitting between two custom ones (mirrors central feed +
// partner) must stay default — proving customization can't leak onto it.
const centralMid = buildVaEventPayload(full, {}, normalizeCardOptions({})).embeds[0];
check(centralMid.color === 0x2ecc71, 'default (central-feed) card stays default amid custom renders');
// normalizeCardOptions returns fresh, independent objects; the frozen default
// is never handed out or mutated.
const n1 = normalizeCardOptions({}), n2 = normalizeCardOptions({});
check(n1 !== n2 && n1.fields !== n2.fields, 'each normalize call yields independent objects');
try { n1.fields.push('server'); } catch (e) { /* ignore */ }
check(normalizeCardOptions({}).fields.length === DEFAULT_CARD_FIELDS.length, 'mutating a result never affects future defaults');
check(Object.isFrozen(require(path.join('..', 'vaEventCard.js')).DEFAULT_CARD_OPTIONS), 'DEFAULT_CARD_OPTIONS is frozen');

console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED ✅' : failures + ' CHECK(S) FAILED ❌') + ' ===');
process.exit(failures === 0 ? 0 : 1);

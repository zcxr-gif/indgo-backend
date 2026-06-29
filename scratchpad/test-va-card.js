'use strict';
// Offline conformance test: builds cards via the REAL module and validates them
// against Discord's documented webhook/embed limits. No DB, no network.
const path = require('path');
const { buildVaEventPayload, isHttpUrl, flightMapImageUrl } = require(path.join('..', 'vaEventCard.js'));

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

// 1. Full takeoff with all data (no map token → OSM fallback).
delete process.env.MAPBOX_STATIC_TOKEN; delete process.env.MAPBOX_TOKEN;
const full = {
    event: 'takeoff', flightId: 'f1', va: { code: 'OCEAN', name: 'Ocean Virtual' },
    callsign: 'Ocean 001VA', username: 'Jane Pilot', server: 'Expert',
    aircraft: { aircraftName: 'Boeing 737-800', liveryName: 'Ocean' },
    position: { lat: 43.6777, lon: -79.6248, alt_ft: 4200, gs_kt: 250 }, timestamp: Date.now(),
};
let em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: 'https://cdn.example.com/b738.jpg', vaLogoUrl: 'https://cdn.example.com/ocean.png' }), 'full takeoff + media (OSM map)');
check(em.image && /staticmap\.openstreetmap\.de/.test(em.image.url), 'uses OSM fallback map');
check(em.thumbnail && em.thumbnail.url === 'https://cdn.example.com/b738.jpg', 'thumbnail = aircraft photo');

// 2. Landing with Mapbox token → mapbox map + plane pin.
process.env.MAPBOX_STATIC_TOKEN = 'pk.test';
em = validateEmbedPayload(buildVaEventPayload({ ...full, event: 'landing' }, {}), 'landing (Mapbox map, no media)');
check(em.image && /api\.mapbox\.com/.test(em.image.url) && /pin-l-airport/.test(em.image.url), 'mapbox map w/ plane pin');
check(em.color === 0xf1c40f, 'landing color = gold');
delete process.env.MAPBOX_STATIC_TOKEN;

// 3. No position at all → no image, no title url, still valid.
em = validateEmbedPayload(buildVaEventPayload({ event: 'takeoff', callsign: 'X 1', username: 'P', server: 'Casual' }, {}), 'no coordinates');
check(!em.image, 'no map image when no coords');
check(!em.url, 'no title url when no coords');

// 4. Malformed media URLs (relative path, empty, non-url) must be dropped, not 400.
em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: '/uploads/x.jpg', vaLogoUrl: '' }), 'malformed media URLs dropped');
check(!em.thumbnail || isHttpUrl(em.thumbnail.url), 'no malformed thumbnail leaks through');

// 5. Hostile/overlong input must be clipped, never empty.
const longName = 'A'.repeat(5000);
em = validateEmbedPayload(buildVaEventPayload({ event: 'takeoff', callsign: longName, username: longName, server: longName,
    aircraft: { aircraftName: longName, liveryName: longName }, position: { lat: 1, lon: 1 }, timestamp: Date.now() }, {}), 'overlong fields clipped');

// 6. Empty/garbage event object — must not throw and still be valid.
em = validateEmbedPayload(buildVaEventPayload({}, {}), 'empty event object');
em = validateEmbedPayload(buildVaEventPayload(undefined, undefined), 'undefined args');

// 7. isHttpUrl unit checks
check(isHttpUrl('https://a.com/x.png'), 'isHttpUrl https ok');
check(isHttpUrl('http://a.com'), 'isHttpUrl http ok');
check(!isHttpUrl('/relative.png'), 'isHttpUrl rejects relative');
check(!isHttpUrl(''), 'isHttpUrl rejects empty');
check(!isHttpUrl('ftp://a.com'), 'isHttpUrl rejects ftp');
check(!isHttpUrl(null), 'isHttpUrl rejects null');

// 8. Coordinate ordering sanity (lon,lat for mapbox; lat,lon for OSM).
process.env.MAPBOX_STATIC_TOKEN = 'pk.test';
check(flightMapImageUrl(43.6777, -79.6248, true).includes('(-79.6248,43.6777)'), 'mapbox marker = lon,lat');
delete process.env.MAPBOX_STATIC_TOKEN;
check(flightMapImageUrl(43.6777, -79.6248, true).includes('center=43.6777,-79.6248'), 'OSM center = lat,lon');
check(flightMapImageUrl(NaN, 5, true) === null, 'no map for NaN coords');

console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED ✅' : failures + ' CHECK(S) FAILED ❌') + ' ===');
process.exit(failures === 0 ? 0 : 1);

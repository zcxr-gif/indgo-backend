'use strict';
// Offline conformance test: builds cards via the REAL module and validates them
// against Discord's documented webhook/embed limits. No DB, no network.
const path = require('path');
const { buildVaEventPayload, isHttpUrl, flightRouteMapUrl } = require(path.join('..', 'vaEventCard.js'));

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('  ❌', msg); } };

const LIM = { title: 256, desc: 4096, fields: 25, fname: 256, fval: 1024, author: 256, footer: 2048, total: 6000 };

function validate(payload, label) {
    console.log('•', label);
    check(payload && Array.isArray(payload.embeds) && payload.embeds.length >= 1, 'has embeds[]');
    check(payload.embeds.length <= 10, '≤ 10 embeds');
    const em = payload.embeds[0];
    try { JSON.stringify(payload); } catch (e) { check(false, 'JSON-serializable: ' + e.message); return em; }
    if (em.title) check(em.title.length <= LIM.title, `title ≤ 256 (${em.title.length})`);
    if (em.description) check(em.description.length <= LIM.desc, 'description ≤ 4096');
    check(em.fields.length <= LIM.fields, `≤ 25 fields (${em.fields.length})`);
    check(typeof em.color === 'number' && em.color >= 0 && em.color <= 0xFFFFFF, 'color 24-bit int');
    if (em.author) check(em.author.name && em.author.name.length <= LIM.author, 'author.name ≤ 256');
    if (em.footer) check(em.footer.text.length <= LIM.footer, 'footer.text ≤ 2048');
    let total = (em.title || '').length + (em.description || '').length + (em.author ? em.author.name.length : 0) + (em.footer ? em.footer.text.length : 0);
    for (const fl of em.fields) {
        check(typeof fl.name === 'string' && fl.name.length >= 1 && fl.name.length <= LIM.fname, `field name ok: ${fl.name}`);
        check(typeof fl.value === 'string' && fl.value.length >= 1 && fl.value.length <= LIM.fval, `field value non-empty ≤ 1024: ${fl.name}`);
        total += fl.name.length + fl.value.length;
    }
    check(total <= LIM.total, `total chars ≤ 6000 (${total})`);
    const urls = [];
    if (em.url) urls.push(['title.url', em.url]);
    if (em.image) urls.push(['image.url', em.image.url]);
    if (em.thumbnail) urls.push(['thumbnail.url', em.thumbnail.url]);
    if (em.author && em.author.icon_url) urls.push(['author.icon_url', em.author.icon_url]);
    if (em.footer && em.footer.icon_url) urls.push(['footer.icon_url', em.footer.icon_url]);
    for (const [where, u] of urls) check(isHttpUrl(u), `${where} valid http(s): ${u}`);
    check(!em.timestamp || !isNaN(Date.parse(em.timestamp)), 'timestamp ISO-8601');
    return em;
}
const field = (em, name) => em.fields.find(f => f.name === name);

console.log('=== buildVaEventPayload conformance ===\n');

// Coordinates resolved as if server.js did the ICAO lookup.
const CYYZ = { icao: 'CYYZ', lat: 43.6772, lon: -79.6306, name: 'Toronto Pearson Intl' };
const EGLL = { icao: 'EGLL', lat: 51.4706, lon: -0.461941, name: 'London Heathrow' };

// 1. Full takeoff with route + media, OSM fallback map (no token).
delete process.env.MAPBOX_STATIC_TOKEN; delete process.env.MAPBOX_TOKEN;
const full = {
    event: 'takeoff', flightId: 'f1', va: { code: 'STARLUX', name: 'Starlux Virtual' },
    callsign: 'Starlux 42EX', username: 'Jane Pilot', server: 'Expert Server',
    departureIcao: 'CYYZ', arrivalIcao: 'EGLL',
    aircraft: { aircraftName: 'Boeing 737-800', liveryName: 'Starlux' },
    position: { lat: 44.0, lon: -78.0, alt_ft: 4200, gs_kt: 250 }, timestamp: Date.now(),
};
let em = validate(buildVaEventPayload(full, { departure: CYYZ, arrival: EGLL, aircraftImageUrl: 'https://cdn.x/b738.jpg', vaLogoUrl: 'https://cdn.x/sl.png' }), 'full takeoff + route + media (OSM)');
check(em.image && /staticmap\.openstreetmap\.de/.test(em.image.url), 'uses OSM fallback');
check(/CYYZ → EGLL/.test(em.description), 'description shows route A→B');
check(field(em, '🛫 Departure') && /CYYZ/.test(field(em, '🛫 Departure').value) && /Toronto/.test(field(em, '🛫 Departure').value), 'Departure field shows code + name');
check(field(em, '🛬 Arrival') && /Heathrow/.test(field(em, '🛬 Arrival').value), 'Arrival field shows name');
check(em.thumbnail && em.thumbnail.url === 'https://cdn.x/b738.jpg', 'thumbnail = aircraft photo');

// 2. Mapbox token → LIGHT route map with line + A/B pins, auto-framed.
process.env.MAPBOX_STATIC_TOKEN = 'pk.test';
em = validate(buildVaEventPayload(full, { departure: CYYZ, arrival: EGLL }), 'route map (Mapbox light)');
check(/api\.mapbox\.com/.test(em.image.url), 'mapbox host');
check(/light-v11/.test(em.image.url), 'LIGHT map style');
check(/geojson\(/.test(em.image.url), 'has route line (geojson)');
check(/pin-s-a%2B22c55e|pin-s-a\+22c55e/.test(em.image.url), 'green A pin (departure)');
check(/pin-s-b%2Bef4444|pin-s-b\+ef4444/.test(em.image.url), 'red B pin (arrival)');
check(/\/auto\//.test(em.image.url), 'auto-framed');
delete process.env.MAPBOX_STATIC_TOKEN;

// 3. New nullable fields: no flight plan (both ICAO null) → no Departure/Arrival fields.
em = validate(buildVaEventPayload({ ...full, departureIcao: null, arrivalIcao: null }, { plane: full.position }), 'no flight plan (null ICAOs)');
check(!field(em, '🛫 Departure') && !field(em, '🛬 Arrival'), 'no dep/arr fields when no plan');
check(!/→/.test(em.description), 'no route arrow in description');

// 4. Partial plan: only departure known.
em = validate(buildVaEventPayload({ ...full, arrivalIcao: null }, { departure: CYYZ }), 'departure only');
check(/from \*\*CYYZ\*\*/.test(em.description), 'description: "from CYYZ"');
check(field(em, '🛬 Arrival') && field(em, '🛬 Arrival').value === '—', 'arrival field is — when unknown');

// 5. null username / server (allowed per new contract) — must not break.
em = validate({ ...buildVaEventPayload({ event: 'landing', callsign: 'X 1', username: null, server: null, departureIcao: 'KLAX', arrivalIcao: 'KSFO' }, { departure: { icao: 'KLAX', lat: 33.94, lon: -118.4 }, arrival: { icao: 'KSFO', lat: 37.62, lon: -122.4 } }) }, 'null username/server');
check(field(em, '👤 Pilot').value === '—', 'null username → —');
check(field(em, '🌐 Server').value === '—', 'null server → —');

// 6. No coordinates anywhere (no position, ICAOs unresolved) → no map, still valid.
em = validate(buildVaEventPayload({ event: 'takeoff', callsign: 'Y 2', departureIcao: 'ZZZZ', arrivalIcao: 'ZZZZ' }, {}), 'no coords at all');
check(!em.image, 'no map image when no coords');
check(!em.url, 'no title url when no coords');
check(/ZZZZ/.test(field(em, '🛫 Departure').value), 'ICAO still shown even when coords unresolved');

// 7. Malformed media URLs dropped (not a 400).
em = validate(buildVaEventPayload(full, { departure: CYYZ, arrival: EGLL, aircraftImageUrl: '/uploads/x.jpg', vaLogoUrl: '' }), 'malformed media dropped');
check(!em.thumbnail || isHttpUrl(em.thumbnail.url), 'no malformed thumbnail leaks');

// 8. Overlong/garbage input clipped, total under budget.
const big = 'A'.repeat(5000);
em = validate(buildVaEventPayload({ event: 'takeoff', callsign: big, username: big, server: big, departureIcao: big, arrivalIcao: big, aircraft: { aircraftName: big, liveryName: big }, position: { lat: 1, lon: 1 }, timestamp: Date.now() }, { departure: { icao: big, lat: 1, lon: 1, name: big }, arrival: { icao: big, lat: 2, lon: 2, name: big } }), 'overlong input clipped');

// 9. Empty / undefined args don't throw.
em = validate(buildVaEventPayload({}, {}), 'empty event');
em = validate(buildVaEventPayload(undefined, undefined), 'undefined args');

// 10. flightRouteMapUrl unit checks.
delete process.env.MAPBOX_STATIC_TOKEN;
check(flightRouteMapUrl({}) === null, 'no points → null map');
const osm = flightRouteMapUrl({ dep: CYYZ, arr: EGLL });
check(/markers=43.6772,-79.6306/.test(osm) && /markers=51.4706,-0.4619/.test(osm), 'OSM markers lat,lon for both airports');
process.env.MAPBOX_STATIC_TOKEN = 'pk.t';
const mb = flightRouteMapUrl({ dep: CYYZ, arr: EGLL, plane: { lat: 48, lon: -40 } });
check(/pin-l-airport/.test(mb), 'mapbox plane pin present');
check(mb.indexOf('-79.6306,43.6772') > -1 || mb.indexOf('-79.6306%2C43.6772') > -1, 'mapbox uses lon,lat order');
delete process.env.MAPBOX_STATIC_TOKEN;

console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED ✅' : failures + ' CHECK(S) FAILED ❌') + ' ===');
process.exit(failures === 0 ? 0 : 1);

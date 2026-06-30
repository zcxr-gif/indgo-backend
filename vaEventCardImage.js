'use strict';

/*
 * Renders the VA takeoff/landing card as a single composite PNG (via sharp),
 * which is then attached to the Discord webhook message. We do our own image so
 * the layout isn't boxed in by Discord's rigid embed slots: a wide HORIZONTAL
 * card with a big aircraft photo, the VA's full (un-cropped) wide logo, a
 * departure -> arrival route + map, and a "Powered by Inflight" footer.
 *
 * Everything is best-effort and degrades gracefully: any image we can't fetch is
 * replaced by a styled placeholder, and if rendering throws the caller falls
 * back to the plain Discord embed (buildVaEventPayload). Pure layout/text is an
 * SVG; fetched bitmaps (photo, logo, map) are composited on top.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const { extractRoute, isHttpUrl } = require('./vaEventCard');

const WIDTH = 1200;
const HEIGHT = 600;

// --- Airport coordinates (for the A->B route map) ---------------------------
// Optional bundled ICAO -> [lat, lon] table. Seeded with major hubs; extend
// data/airport-coords.json to cover more. Loaded once, tolerant of absence.
let AIRPORT_COORDS = {};
try {
    AIRPORT_COORDS = require('./data/airport-coords.json') || {};
} catch { AIRPORT_COORDS = {}; }
const airportCoord = (icao) => {
    const c = AIRPORT_COORDS[String(icao || '').trim().toUpperCase()];
    return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null;
};

// --- Brand logo (local asset, loaded once) ----------------------------------
let BRAND_LOGO_BUF = null;
try {
    BRAND_LOGO_BUF = fs.readFileSync(path.join(__dirname, 'assets', 'brand', 'inflight-logo.png'));
} catch { BRAND_LOGO_BUF = null; }

// XML-escape text destined for the SVG.
const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Trim a string to fit roughly `max` characters, adding an ellipsis. Rough (we
// don't measure glyphs) but enough to keep values from overrunning their column.
const clipText = (s, max, fallback = '—') => {
    const str = (s == null ? '' : String(s)).trim() || fallback;
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
};

// Fetch a remote image into a Buffer. Best-effort: returns null on any failure,
// non-image content-type, or oversize body, so a bad URL never breaks the card.
const fetchImage = async (url) => {
    if (!isHttpUrl(url)) return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 6000,
            maxContentLength: 8 * 1024 * 1024,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        const ct = String(res.headers['content-type'] || '');
        if (ct && !/^image\//i.test(ct)) return null;
        return Buffer.from(res.data);
    } catch { return null; }
};

// Resize to exactly w*h (cover), with rounded corners, returning a PNG buffer.
const coverRounded = async (buf, w, h, r = 14) => {
    try {
        const base = await sharp(buf).resize(w, h, { fit: 'cover', position: 'attention' }).png().toBuffer();
        const mask = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
        return await sharp(base).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    } catch { return null; }
};

// Resize to fit inside w*h (contain) on a transparent canvas — for wide logos
// that must NOT be cropped.
const contain = async (buf, w, h) => {
    try {
        return await sharp(buf)
            .resize(w, h, { fit: 'inside', withoutEnlargement: false })
            .png().toBuffer();
    } catch { return null; }
};

// --- Route map --------------------------------------------------------------
// Encode a list of [lat,lon] points as a Google/Mapbox polyline (precision 5).
const encodePolyline = (pts) => {
    let last = [0, 0], out = '';
    const enc = (v) => {
        v = v < 0 ? ~(v << 1) : (v << 1);
        let s = '';
        while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        s += String.fromCharCode(v + 63);
        return s;
    };
    for (const p of pts) {
        const lat = Math.round(p[0] * 1e5), lon = Math.round(p[1] * 1e5);
        out += enc(lat - last[0]) + enc(lon - last[1]);
        last = [lat, lon];
    }
    return out;
};

// Pick an OSM static-map zoom that fits both endpoints in a w*h viewport.
const fitZoom = (a, b, w, h) => {
    const GLOBE = 256, PAD = 0.78;
    const mercY = (lat) => {
        const s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
        return Math.log((1 + s) / (1 - s)) / 2;
    };
    const latFrac = (Math.abs(mercY(a[0]) - mercY(b[0])) / Math.PI) / 2 || 1e-6;
    let lonDiff = Math.abs(a[1] - b[1]); if (lonDiff > 180) lonDiff = 360 - lonDiff;
    const lonFrac = (lonDiff / 360) || 1e-6;
    const z = Math.min(
        Math.log2((h * PAD) / GLOBE / latFrac),
        Math.log2((w * PAD) / GLOBE / lonFrac),
    );
    return Math.max(2, Math.min(11, Math.floor(z)));
};

// Build a static-map URL showing the flight. Prefers a dep->arr ROUTE (two pins
// + a line) when we know both airports' coordinates; otherwise falls back to the
// live aircraft position as a single marker. Mapbox (token) draws the route
// line; the key-less OSM renderer shows the two pins.
const routeMapUrl = (dep, arr, isTakeoff, livePos) => {
    const depC = airportCoord(dep), arrC = airportCoord(arr);
    const token = process.env.MAPBOX_STATIC_TOKEN || process.env.MAPBOX_TOKEN;
    const W = 688, H = 232; // 2x of the 344x116 slot
    if (depC && arrC) {
        if (token) {
            const line = `path-4+38bdf8-0.9(${encodeURIComponent(encodePolyline([depC, arrC]))})`;
            const pinA = `pin-s-a+2ecc71(${depC[1]},${depC[0]})`;
            const pinB = `pin-s-b+f1c40f(${arrC[1]},${arrC[0]})`;
            return `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${line}/${pinA}/${pinB}/auto/${W}x${H}@2x?padding=40&access_token=${encodeURIComponent(token)}`;
        }
        const cLat = (depC[0] + arrC[0]) / 2, cLon = (depC[1] + arrC[1]) / 2;
        const zoom = fitZoom(depC, arrC, W, H);
        const markers = `${depC[0]},${depC[1]},lightgreen|${arrC[0]},${arrC[1]},orange`;
        return `https://staticmap.openstreetmap.de/staticmap.php?center=${cLat.toFixed(4)},${cLon.toFixed(4)}&zoom=${zoom}&size=${W}x${H}&maptype=mapnik&markers=${encodeURIComponent(markers)}`;
    }
    // No route coords — show where the aircraft currently is, if we know.
    if (livePos && Number.isFinite(livePos.lat) && Number.isFinite(livePos.lon)) {
        const la = livePos.lat.toFixed(4), lo = livePos.lon.toFixed(4);
        if (token) {
            const color = isTakeoff ? '2ecc71' : 'f1c40f';
            return `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/pin-l-airport+${color}(${lo},${la})/${lo},${la},5,0/${W}x${H}@2x?access_token=${encodeURIComponent(token)}`;
        }
        return `https://staticmap.openstreetmap.de/staticmap.php?center=${la},${lo}&zoom=5&size=${W}x${H}&maptype=mapnik&markers=${la},${lo},lightblue1`;
    }
    return null;
};

// --- Card geometry ----------------------------------------------------------
const LOGO = { x: 28, y: 24, w: 320, h: 52 };
const PHOTO = { x: 488, y: 116, w: 688, h: 300 };
const MAP = { x: 488, y: 432, w: 688, h: 116 };
const BRAND = { x: 28, y: 560, h: 26 };

// Build the background/text SVG. `has` flags which bitmaps will be composited so
// we draw placeholders only where an image is missing.
const buildBaseSvg = (e, route, has) => {
    const isTakeoff = e.event === 'takeoff';
    const accent = isTakeoff ? '#2ecc71' : '#f1c40f';
    const va = e.va || {};
    const ac = e.aircraft || {};
    const pos = e.position || {};
    const vaName = clipText(va.name || va.code || 'Virtual Airline', 34);
    const eventWord = isTakeoff ? 'DEPARTURE' : 'ARRIVAL';
    const depTxt = route.dep || '????';
    const arrTxt = route.arr || '????';
    const aircraftLine = ac.aircraftName
        ? (ac.liveryName ? `${ac.aircraftName} · ${ac.liveryName}` : ac.aircraftName) : '—';
    const altGs = [
        Number.isFinite(pos.alt_ft) ? `${Math.round(pos.alt_ft).toLocaleString()} ft` : null,
        Number.isFinite(pos.gs_kt) ? `${Math.round(pos.gs_kt)} kt` : null,
    ].filter(Boolean).join('  ·  ') || '—';

    // Left-column detail rows: [label, value]
    const rows = [
        ['PILOT', clipText(e.username, 26)],
        ['CALLSIGN', clipText(e.callsign, 26)],
        ['AIRCRAFT', clipText(aircraftLine, 30)],
        ['SERVER', clipText(e.server, 26)],
        ['ALT · SPEED', altGs],
    ];
    let rowsSvg = '';
    let ry = 300;
    for (const [label, value] of rows) {
        rowsSvg += `
            <text x="28" y="${ry}" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold" letter-spacing="1.5" fill="#7a8699">${esc(label)}</text>
            <text x="28" y="${ry + 26}" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="bold" fill="#eef2f7">${esc(value)}</text>`;
        ry += 56;
    }

    const photoPlaceholder = has.photo ? '' : `
        <rect x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}" rx="14" fill="#161b22" stroke="#262d38"/>
        <text x="${PHOTO.x + PHOTO.w / 2}" y="${PHOTO.y + PHOTO.h / 2 - 6}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="64" fill="#2b3340">✈</text>
        <text x="${PHOTO.x + PHOTO.w / 2}" y="${PHOTO.y + PHOTO.h / 2 + 34}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" fill="#3a4452">Aircraft image unavailable</text>`;
    const mapPlaceholder = has.map ? '' : `
        <rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" rx="14" fill="#161b22" stroke="#262d38"/>
        <text x="${MAP.x + MAP.w / 2}" y="${MAP.y + MAP.h / 2 + 6}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" fill="#3a4452">Route map unavailable</text>`;
    // VA name shown in the header only when we have no logo bitmap to composite.
    const logoText = has.logo ? '' : `
        <text x="${LOGO.x}" y="${LOGO.y + 38}" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" font-weight="bold" fill="#eef2f7">${esc(vaName)}</text>`;
    // Footer: "Powered by" + the Inflight wordmark (composited separately when
    // the asset is present); without the asset, fall back to plain text.
    const footerText = has.brand ? 'Powered by' : 'Powered by Inflight';

    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#0d1117"/>
                <stop offset="1" stop-color="#11161f"/>
            </linearGradient>
        </defs>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
        <rect x="0" y="0" width="8" height="${HEIGHT}" fill="${accent}"/>
        <!-- header -->
        ${logoText}
        <rect x="980" y="30" width="192" height="42" rx="21" fill="${accent}"/>
        <text x="1076" y="58" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="bold" fill="#0d1117">${eventWord}</text>
        <line x1="28" y1="96" x2="1172" y2="96" stroke="#222a35" stroke-width="2"/>
        <!-- route (horizontal A -> B) -->
        <text x="28" y="150" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold" letter-spacing="2" fill="#7a8699">ROUTE</text>
        <text x="28" y="212" font-family="DejaVu Sans, Arial, sans-serif" font-size="52" font-weight="bold" fill="#eef2f7">${esc(depTxt)}</text>
        <text x="232" y="208" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="${accent}">→</text>
        <text x="296" y="212" font-family="DejaVu Sans, Arial, sans-serif" font-size="52" font-weight="bold" fill="#eef2f7">${esc(arrTxt)}</text>
        <line x1="28" y1="244" x2="456" y2="244" stroke="#222a35" stroke-width="2"/>
        ${rowsSvg}
        ${photoPlaceholder}
        ${mapPlaceholder}
        <!-- footer -->
        <text x="${BRAND.x}" y="${BRAND.y + 20}" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" font-weight="bold" fill="#9aa6b4">${footerText}</text>
    </svg>`);
};

// Render the composite PNG for one event. Returns a Buffer, or null if rendering
// failed (caller then falls back to the plain embed).
const renderVaEventCard = async (e = {}, media = {}) => {
    try {
        const isTakeoff = e.event === 'takeoff';
        const route = extractRoute(e);
        const mapUrl = routeMapUrl(route.dep, route.arr, isTakeoff, e.position || {});

        // Fetch the three remote bitmaps in parallel; each is independently
        // optional. The brand wordmark is a local asset.
        const [photoRaw, logoRaw, mapRaw] = await Promise.all([
            fetchImage(media.aircraftImageUrl),
            fetchImage(media.vaLogoUrl),
            fetchImage(mapUrl),
        ]);

        const [photo, logo, map, brand] = await Promise.all([
            photoRaw ? coverRounded(photoRaw, PHOTO.w, PHOTO.h) : null,
            logoRaw ? contain(logoRaw, LOGO.w, LOGO.h) : null,
            mapRaw ? coverRounded(mapRaw, MAP.w, MAP.h) : null,
            BRAND_LOGO_BUF ? contain(BRAND_LOGO_BUF, 104, BRAND.h) : null,
        ]);

        const has = { photo: !!photo, logo: !!logo, map: !!map, brand: !!brand };
        const baseSvg = buildBaseSvg(e, route, has);

        const layers = [];
        if (logo) {
            const meta = await sharp(logo).metadata();
            // Vertically centre the contained logo inside its header box.
            const top = LOGO.y + Math.max(0, Math.round((LOGO.h - (meta.height || LOGO.h)) / 2));
            layers.push({ input: logo, left: LOGO.x, top });
        }
        if (photo) layers.push({ input: photo, left: PHOTO.x, top: PHOTO.y });
        if (map) layers.push({ input: map, left: MAP.x, top: MAP.y });
        if (brand) {
            const meta = await sharp(brand).metadata();
            const top = BRAND.y + Math.max(0, Math.round((BRAND.h - (meta.height || BRAND.h)) / 2));
            // Sits right after the "Powered by" text.
            layers.push({ input: brand, left: BRAND.x + 124, top });
        }

        return await sharp(baseSvg).composite(layers).png().toBuffer();
    } catch (err) {
        console.error('[va-events] card render failed:', err.message);
        return null;
    }
};

module.exports = { renderVaEventCard, routeMapUrl, airportCoord, encodePolyline, fitZoom };

'use strict';

/*
 * Renders the VA takeoff/landing card as a single composite PNG (via sharp),
 * which is then attached to the Discord webhook message. We do our own image so
 * the layout isn't boxed in by Discord's rigid embed slots: a wide HORIZONTAL
 * card whose right half is a BIG aircraft photo, with the Inflight logo top-left,
 * a Departure/Arrival badge, a DEP -> ARR route and the flight details.
 *
 * Branding split: this IMAGE carries the Inflight (our) logo; the VA's own logo
 * lives in the Discord message embed around it (see buildVaEventPayload /
 * postVaEventCard). No "Powered by Inflight" footer on the card.
 *
 * Route map: rendered as its OWN image (renderVaRouteMapImage), posted as a
 * second attachment below the card so neither visual gets squeezed. Offline
 * only — land silhouettes from data/world-land.json, great-circle arc, DEP/ARR
 * markers, live aircraft position; no map provider, key or network call, so it
 * can never 400 or leak a token. Unknown airports → null → the message simply
 * carries the card alone.
 *
 * Everything is best-effort and degrades gracefully: any image we can't fetch is
 * replaced by a styled placeholder, and if rendering throws the caller falls
 * back to the plain Discord embed (buildVaEventPayload). Pure layout/text is an
 * SVG; the fetched aircraft photo is composited on top.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const {
    extractRoute, isHttpUrl, resolveAccent, resolveMapLine, normalizeCardOptions,
    routeDistanceNm, eteTextFor,
} = require('./vaEventCard');

const WIDTH = 1200;
const HEIGHT = 600;

// --- Route-map basemap palettes ----------------------------------------------
// Each map style is just a set of fill/stroke colours; the geometry is identical.
// `ocean` is the panel background, `land`/`landStroke` the continents, `grid`
// the graticule, and `label`/`labelShadow` the ICAO endpoint labels. Callers
// pick a style by key (validated in normalizeCardOptions); unknown keys fall
// back to 'dark'.
const MAP_PALETTES = {
    dark:     { ocean: '#0c1420', land: '#1b2739', landStroke: '#2b3a52', grid: '#1a2332', frame: '#2a3342', label: '#dfe6f0', labelShadow: '#0d1117', chipBg: '#0d1117', chipText: '#dfe6f0' },
    midnight: { ocean: '#0a1a2f', land: '#123a5e', landStroke: '#1e5a8a', grid: '#123048', frame: '#1e4a6e', label: '#eaf4ff', labelShadow: '#04101f', chipBg: '#041020', chipText: '#eaf4ff' },
    light:    { ocean: '#dbe7f2', land: '#f4f7fa', landStroke: '#b8c6d6', grid: '#c6d4e2', frame: '#a9bacb', label: '#1f2d3d', labelShadow: '#ffffff', chipBg: '#ffffff', chipText: '#1f2d3d' },
    mono:     { ocean: '#111315', land: '#26292d', landStroke: '#3a3f45', grid: '#1c1f22', frame: '#3a3f45', label: '#e8eaed', labelShadow: '#0a0b0c', chipBg: '#0a0b0c', chipText: '#e8eaed' },
};
const paletteFor = (style) => MAP_PALETTES[style] || MAP_PALETTES.dark;

// --- Brand logo (local asset, loaded once) ----------------------------------
// This is OUR logo, shown top-left of the card. The VA's logo goes in the
// Discord message, not here.
let BRAND_LOGO_BUF = null;
try {
    BRAND_LOGO_BUF = fs.readFileSync(path.join(__dirname, 'assets', 'brand', 'inflight-logo.png'));
} catch { BRAND_LOGO_BUF = null; }

// --- Route distance (great-circle) -------------------------------------------
// data/airport-coords.json maps uppercase ICAO -> [lat, lon] for the majors, so
// the card can show an approximate leg length. A miss just hides the figure.
let AIRPORT_COORDS = {};
try {
    AIRPORT_COORDS = require('./data/airport-coords.json');
} catch { AIRPORT_COORDS = {}; }

const coordsOf = (icao) => {
    const v = icao ? AIRPORT_COORDS[String(icao).toUpperCase()] : null;
    return (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) ? v : null;
};

// Leg distance (nm) is computed by the shared vaEventCard module so the image
// card and the JSON embed can never disagree; `routeDistanceNm` is imported above.

// --- World land rings (offline basemap for the route map) --------------------
// data/world-land.json holds simplified Natural Earth land outlines as
// [lon, lat] rings. Ring bounding boxes are precomputed once so a render only
// projects the rings that actually intersect the cropped view.
let LAND_RINGS = [];
try {
    const land = require('./data/world-land.json');
    LAND_RINGS = (land.rings || []).map((ring) => {
        let minLon = 999, maxLon = -999, minLat = 999, maxLat = -999;
        for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        }
        return { ring, minLon, maxLon, minLat, maxLat };
    });
} catch { LAND_RINGS = []; }

// "14:32 UTC · 6 JUL 2026" for the card header — the embed's own timestamp is
// rendered in the viewer's local time, so the card pins the aviation-standard Z.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const utcStamp = (ts) => {
    const t = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC · ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
};

// Rough per-glyph width estimate (em) for DejaVu Sans Bold caps/digits, so the
// route line can size itself: a wide ICAO like OMDB must not overflow the left
// column into the photo. Estimates err wide, which only shortens the dashes.
const CHAR_W = {
    I: 0.34, J: 0.55, L: 0.60, F: 0.62, T: 0.64, M: 0.98, W: 0.98,
    // Chip text mixes in digits, spaces and symbols — size those too instead of
    // papering over them with a blanket fudge factor.
    ' ': 0.32, '·': 0.34, '≈': 0.60, '→': 0.98, ',': 0.32,
    0: 0.64, 1: 0.64, 2: 0.64, 3: 0.64, 4: 0.64, 5: 0.64, 6: 0.64, 7: 0.64, 8: 0.64, 9: 0.64,
};
const estTextW = (s, font) =>
    Array.from(String(s)).reduce((w, ch) => w + (CHAR_W[ch] || 0.74), 0) * font;

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
const coverRounded = async (buf, w, h, r = 16) => {
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

// --- Card geometry ----------------------------------------------------------
// Left column = brand + route + details; right column = the aircraft photo,
// kept at its original 688x300 size (the bigger version read as too large) and
// vertically centred in the right column. The route map is deliberately NOT on
// this card — it renders as its own image so neither visual gets squeezed.
const LOGO = { x: 28, y: 28, w: 300, h: 56 };       // OUR brand logo (top-left)
const PHOTO = { x: 488, y: 184, w: 688, h: 300 };   // aircraft photo (original size, centred)

// Standalone route-map image dimensions (a wide banner that sits below the
// card in the same Discord message).
const MAP_IMG = { w: 1200, h: 420 };

// --- Route map (offline SVG mini-map) ----------------------------------------
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;
const toVec = (lat, lon) => {
    const p = rad(lat), l = rad(lon);
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};

// Great-circle between two [lat, lon] points as `n` interpolated points
// (inclusive), with longitudes unwrapped into a continuous sequence so a
// dateline crossing doesn't fold the arc back across the map.
const greatCirclePoints = (a, b, n = 64) => {
    const v1 = toVec(a[0], a[1]), v2 = toVec(b[0], b[1]);
    const dot = Math.min(1, Math.max(-1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    const w = Math.acos(dot);
    // Same point (w≈0) or antipodal (w≈π): SLERP divides by sin(w)≈0 and
    // produces garbage coordinates. There's no single great circle for an
    // antipodal pair anyway, so fall back to plain lat/lon interpolation.
    const degenerate = w < 1e-6 || Math.PI - w < 1e-4;
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        if (degenerate) {
            pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            continue;
        }
        const s = Math.sin(w);
        const v = [0, 1, 2].map(k => (Math.sin((1 - t) * w) * v1[k] + Math.sin(t * w) * v2[k]) / s);
        let lat = deg(Math.asin(Math.max(-1, Math.min(1, v[2]))));
        let lon = deg(Math.atan2(v[1], v[0]));
        if (pts.length) {
            const prev = pts[pts.length - 1][1];
            while (lon - prev > 180) lon -= 360;
            while (lon - prev < -180) lon += 360;
        }
        pts.push([lat, lon]);
    }
    return pts;
};

// Build the route-map SVG fragment for the given panel rect, or null when
// either endpoint is missing from the coords index. Pure string building.
const buildRouteMapSvg = (route, pos, lineColor, pal, MAP) => {
    const a = coordsOf(route.dep), b = coordsOf(route.arr);
    if (!a || !b) return null;

    const arc = greatCirclePoints(a, b);

    // Aircraft position, unwrapped near the arc's longitude domain.
    let posPt = null;
    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
        let lon = pos.lon;
        const ref = arc[Math.floor(arc.length / 2)][1];
        while (lon - ref > 180) lon -= 360;
        while (lon - ref < -180) lon += 360;
        posPt = [pos.lat, lon];
    }

    // View box over the arc (+ position), padded, with minimum spans so a
    // short hop still shows some geography.
    const all = posPt ? arc.concat([posPt]) : arc;
    let minLat = 90, maxLat = -90, minLon = Infinity, maxLon = -Infinity;
    for (const [lat, lon] of all) {
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    }
    let latSpan = Math.max(maxLat - minLat, 0.1) * 1.45;
    let lonSpan = Math.max(maxLon - minLon, 0.1) * 1.35;
    latSpan = Math.max(latSpan, 4);
    lonSpan = Math.max(lonSpan, 8);
    const midLat = (minLat + maxLat) / 2, midLon = (minLon + maxLon) / 2;

    // Equirectangular with the standard parallel at mid-latitude, then widen
    // whichever span is short so the view fills the panel's aspect ratio.
    const k = Math.max(0.25, Math.cos(rad(Math.min(80, Math.abs(midLat)))));
    const panelAspect = MAP.w / MAP.h;
    if ((lonSpan * k) / latSpan < panelAspect) lonSpan = latSpan * panelAspect / k;
    else latSpan = (lonSpan * k) / panelAspect;

    let latMin = midLat - latSpan / 2, latMax = midLat + latSpan / 2;
    if (latMax > 88) { latMax = 88; latMin = latMax - latSpan; }
    if (latMin < -88) { latMin = -88; latMax = latMin + latSpan; }
    const lonMin = midLon - lonSpan / 2, lonMax = midLon + lonSpan / 2;
    const scale = MAP.h / latSpan; // px per degree (same for x via k)

    const px = (lat, lon) =>
        [MAP.x + (lon - lonMin) * k * scale, MAP.y + (latMax - lat) * scale];
    const fmt = (n) => Math.round(n * 10) / 10;

    // Land: draw every ring (tried at -360/0/+360 shifts) that intersects the
    // view. even-odd fill keeps any lake holes honest.
    let landPath = '';
    for (const { ring, minLon: rMinLon, maxLon: rMaxLon, minLat: rMinLat, maxLat: rMaxLat } of LAND_RINGS) {
        if (rMaxLat < latMin || rMinLat > latMax) continue;
        for (const off of [-360, 0, 360]) {
            if (rMaxLon + off < lonMin || rMinLon + off > lonMax) continue;
            let d = '';
            for (const [lon, lat] of ring) {
                const [x, y] = px(lat, lon + off);
                d += (d ? 'L' : 'M') + fmt(x) + ' ' + fmt(y);
            }
            landPath += d + 'Z';
        }
    }

    // Graticule: pick a step that yields a handful of lines, not a grid soup.
    const gStep = [1, 2, 5, 10, 15, 30, 45].find(s => lonSpan / s <= 9) || 60;
    let grid = '';
    for (let lon = Math.ceil(lonMin / gStep) * gStep; lon <= lonMax; lon += gStep) {
        const [x] = px(0, lon);
        grid += `<line x1="${fmt(x)}" y1="${MAP.y}" x2="${fmt(x)}" y2="${MAP.y + MAP.h}" stroke="${pal.grid}" stroke-width="1"/>`;
    }
    for (let lat = Math.ceil(latMin / gStep) * gStep; lat <= latMax; lat += gStep) {
        const [, y] = px(lat, lonMin);
        grid += `<line x1="${MAP.x}" y1="${fmt(y)}" x2="${MAP.x + MAP.w}" y2="${fmt(y)}" stroke="${pal.grid}" stroke-width="1"/>`;
    }

    // Route arc: soft glow underlay + crisp accent line.
    let arcD = '';
    for (const [lat, lon] of arc) {
        const [x, y] = px(lat, lon);
        arcD += (arcD ? 'L' : 'M') + fmt(x) + ' ' + fmt(y);
    }

    // Marks/labels scale continuously with panel height (≈1.4 on the 420px
    // standalone banner) instead of flipping at a magic threshold.
    const S = Math.min(1.5, Math.max(1, MAP.h / 300));

    // Endpoint markers + ICAO labels (label flips to the left near the right
    // edge; a dark shadow copy keeps it readable over land or ocean).
    const marker = (pt, icao, filled) => {
        const [x, y] = px(pt[0], pt[1]);
        const flip = x > MAP.x + MAP.w - 90 * S;
        const lx = flip ? x - 12 * S : x + 12 * S;
        const anchor = flip ? 'end' : 'start';
        const label = (dx, dy, fill) =>
            `<text x="${fmt(lx + dx)}" y="${fmt(y + 5 * S + dy)}" text-anchor="${anchor}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(16 * S)}" font-weight="bold" fill="${fill}">${esc(icao)}</text>`;
        return (filled
            ? `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${6 * S}" fill="${lineColor}"/>`
            : `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${6 * S}" fill="${pal.ocean}" stroke="${lineColor}" stroke-width="${3 * S}"/>`)
            + label(1.5, 1.5, pal.labelShadow) + label(0, 0, pal.label);
    };
    // Anchor markers to the arc's own (longitude-unwrapped) endpoints — the raw
    // a/b lons can sit a full world away from the view after dateline handling.
    let markers = marker(arc[0], clipText(route.dep, 5), false)
        + marker(arc[arc.length - 1], clipText(route.arr, 5), true);
    if (posPt) {
        const [x, y] = px(posPt[0], posPt[1]);
        markers += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${8 * S}" fill="${lineColor}" fill-opacity="0.25"/>`
            + `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${3.5 * S}" fill="${pal.label}"/>`;
    }

    return `
        <clipPath id="mapClip"><rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" rx="16"/></clipPath>
        <rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" rx="16" fill="${pal.ocean}"/>
        <g clip-path="url(#mapClip)">
            ${grid}
            <path d="${landPath}" fill="${pal.land}" fill-rule="evenodd" stroke="${pal.landStroke}" stroke-width="1"/>
            <path d="${arcD}" fill="none" stroke="${lineColor}" stroke-width="${7 * S}" stroke-opacity="0.22" stroke-linecap="round"/>
            <path d="${arcD}" fill="none" stroke="${lineColor}" stroke-width="${2.5 * S}" stroke-linecap="round"/>
            ${markers}
        </g>
        <rect x="${MAP.x + 1}" y="${MAP.y + 1}" width="${MAP.w - 2}" height="${MAP.h - 2}" rx="15" fill="none" stroke="${pal.frame}" stroke-width="2"/>`;
};

// Render the route map as its OWN wide-banner PNG (posted as a second image
// below the card). Returns a Buffer, or null when the route can't be mapped —
// the message then just carries the card, exactly as before.
// Logo box on the route map (top-left corner). Sits over a rounded pill so the
// brand mark reads on any basemap style.
const MAP_LOGO = { x: 20, y: 16, w: 150, h: 40 };

const renderVaRouteMapImage = async (e = {}, opts) => {
    try {
        const o = normalizeCardOptions(opts || {});
        const route = extractRoute(e);
        const line = resolveMapLine(e, o);
        const pal = paletteFor(o.mapStyle);
        const inner = buildRouteMapSvg(route, e.position, line, pal, { x: 0, y: 0, w: MAP_IMG.w, h: MAP_IMG.h });
        if (!inner) return null;

        // Corner chip: DEP → ARR plus the leg distance when we know it.
        const distNm = routeDistanceNm(route.dep, route.arr);
        const chipTxt = `${clipText(route.dep, 5)} → ${clipText(route.arr, 5)}`
            + (distNm == null ? '' : `  ·  ≈ ${distNm.toLocaleString('en-US')} NM`);
        const chipW = Math.round(estTextW(chipTxt, 20)) + 44;
        const chip = `
            <rect x="${MAP_IMG.w - chipW - 20}" y="20" width="${chipW}" height="40" rx="20" fill="${pal.chipBg}" fill-opacity="0.82"/>
            <text x="${MAP_IMG.w - 20 - chipW / 2}" y="46" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" font-weight="bold" fill="${pal.chipText}">${esc(chipTxt)}</text>`;

        // Inflight logo, top-left, on a translucent pill (always shown — the map
        // is branded just like the card). Falls back to a wordmark if the asset
        // is missing. The pill is ALWAYS dark (never the map palette's chip
        // colour): the brand mark is light, so a white pill on the 'light' style
        // would hide it. The brand bitmap is composited after the SVG rasterizes.
        const brand = BRAND_LOGO_BUF ? await contain(BRAND_LOGO_BUF, MAP_LOGO.w, MAP_LOGO.h) : null;
        const pillW = MAP_LOGO.w + 24;
        const pill = `<rect x="${MAP_LOGO.x - 12}" y="${MAP_LOGO.y - 8}" width="${pillW}" height="${MAP_LOGO.h + 16}" rx="20" fill="#0d1117" fill-opacity="0.82"/>`;
        const wordmark = brand ? '' :
            `<text x="${MAP_LOGO.x}" y="${MAP_LOGO.y + 28}" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="bold" fill="#eef2f7">Inflight</text>`;

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_IMG.w}" height="${MAP_IMG.h}">${inner}${pill}${wordmark}${chip}</svg>`;
        const base = await sharp(Buffer.from(svg)).png().toBuffer();
        if (!brand) return base;
        const meta = await sharp(brand).metadata();
        const top = MAP_LOGO.y + Math.max(0, Math.round((MAP_LOGO.h - (meta.height || MAP_LOGO.h)) / 2));
        return await sharp(base).composite([{ input: brand, left: MAP_LOGO.x, top }]).png().toBuffer();
    } catch (err) {
        console.error('[va-events] route map render failed:', err.message);
        return null;
    }
};

// Which detail keys render as a detail-column row on the card. `distance` is
// shown in the route header (as "≈ N NM"), not as a row, so it's excluded here.
const CARD_ROW_KEYS = new Set(['pilot', 'callsign', 'aircraft', 'server', 'altspeed', 'ete', 'position']);
const MAX_CARD_ROWS = 6; // more than this crowds the fixed-height detail column

// Resolve the horizontal layout for a card. The text/route/detail column keeps
// the SAME width either way (so text metrics don't change); only its x-origin
// and the photo's x-origin swap when the VA puts the photo on the left. When no
// photo is shown, the content always sits on the left (the classic layout).
const cardLayout = (o) => {
    const photoLeft = o.showPhoto && o.photoSide === 'left';
    return photoLeft
        ? { photoLeft: true, photoX: 24, cx: 740, cxR: 1168 }
        : { photoLeft: false, photoX: PHOTO.x, cx: 28, cxR: 456 };
};

// Build the background/text SVG. `has` flags which bitmaps will be composited so
// we draw placeholders only where an image is missing. `opts` is a (normalized)
// VA card customization — accent colour, which fields to show, photo on/off.
const buildBaseSvg = (e, route, has, opts) => {
    const o = normalizeCardOptions(opts || {});
    const { photoX, cx, cxR } = cardLayout(o);
    const isTakeoff = e.event === 'takeoff';
    const accent = resolveAccent(e, o).hex;
    const ac = e.aircraft || {};
    const pos = e.position || {};
    const eventWord = isTakeoff ? 'DEPARTURE' : 'ARRIVAL';
    // Real ICAOs are 4 chars; clip malformed longer input so it can't spill
    // across the route line into the photo column.
    const depTxt = clipText(route.dep || '????', 5);
    const arrTxt = clipText(route.arr || '????', 5);
    const aircraftLine = ac.aircraftName
        ? (ac.liveryName ? `${ac.aircraftName} · ${ac.liveryName}` : ac.aircraftName) : '—';
    const altGs = [
        Number.isFinite(pos.alt_ft) ? `${Math.round(pos.alt_ft).toLocaleString()} ft` : null,
        Number.isFinite(pos.gs_kt) ? `${Math.round(pos.gs_kt)} kt` : null,
    ].filter(Boolean).join('  ·  ') || '—';
    const posTxt = (Number.isFinite(pos.lat) && Number.isFinite(pos.lon))
        ? `${pos.lat.toFixed(2)}, ${pos.lon.toFixed(2)}` : null;

    // Left-column detail rows in the VA's chosen order, skipping fields with no
    // value and any that don't render as a row. [label, value] pairs.
    const ROW_VALUE = {
        pilot: clipText(e.username, 26),
        callsign: clipText(e.callsign, 26),
        aircraft: clipText(aircraftLine, 30),
        server: clipText(e.server, 26),
        altspeed: altGs,
        ete: eteTextFor(e),
        position: posTxt,
    };
    const ROW_LABEL = {
        pilot: 'PILOT', callsign: 'CALLSIGN', aircraft: 'AIRCRAFT',
        server: 'SERVER', altspeed: 'ALT · SPEED', ete: 'ETE', position: 'POSITION',
    };
    const rows = [];
    for (const key of o.fields) {
        if (!CARD_ROW_KEYS.has(key)) continue;
        const value = ROW_VALUE[key];
        if (value == null || value === '') continue;
        rows.push([ROW_LABEL[key], value]);
        if (rows.length >= MAX_CARD_ROWS) break;
    }
    // Spacing compresses gracefully as rows are added so a full column still
    // fits inside the fixed card height (rows run from y=300 to ~y=560).
    const rowStep = rows.length > 1 ? Math.min(56, Math.round((560 - 300) / (rows.length - 1))) : 56;
    let rowsSvg = '';
    let ry = 300;
    for (const [label, value] of rows) {
        rowsSvg += `
            <text x="${cx}" y="${ry}" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold" letter-spacing="1.5" fill="#7a8699">${esc(label)}</text>
            <text x="${cx}" y="${ry + 26}" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="bold" fill="#eef2f7">${esc(value)}</text>`;
        ry += rowStep;
    }

    const distNm = routeDistanceNm(route.dep, route.arr);
    const distSvg = (distNm == null || !o.fields.includes('distance')) ? '' : `
        <text x="${cxR}" y="150" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold" letter-spacing="1.5" fill="#7a8699">≈ ${distNm.toLocaleString('en-US')} NM</text>`;

    // Route line: departure left-anchored, arrival right-anchored against the
    // column's right edge (cxR) so wide glyphs can never spill into the photo. The
    // dashed flight path + plane fill whatever room is left between the two,
    // degrading to just the plane (or nothing) when the ICAOs crowd it out.
    const ROUTE_FONT = 48;
    const routeText = (x, anchor, txt) =>
        `<text x="${x}" y="212"${anchor === 'end' ? ' text-anchor="end"' : ''} font-family="DejaVu Sans, Arial, sans-serif" font-size="${ROUTE_FONT}" font-weight="bold" fill="#eef2f7">${esc(txt)}</text>`;
    const gapL = cx + estTextW(depTxt, ROUTE_FONT) + 16;    // path start
    const gapR = cxR - estTextW(arrTxt, ROUTE_FONT) - 16;   // path end
    const mid = (gapL + gapR) / 2;
    let pathSvg = '';
    if (gapR - gapL >= 120) {
        pathSvg = `
        <line x1="${gapL}" y1="195" x2="${mid - 24}" y2="195" stroke="${accent}" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>
        <text x="${mid}" y="206" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" fill="${accent}">✈</text>
        <line x1="${mid + 24}" y1="195" x2="${gapR - 12}" y2="195" stroke="${accent}" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>
        <circle cx="${gapR - 4}" cy="195" r="5" fill="${accent}"/>`;
    } else if (gapR - gapL >= 44) {
        pathSvg = `
        <text x="${mid}" y="206" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" fill="${accent}">✈</text>`;
    }
    const routeSvg = routeText(cx, 'start', depTxt) + routeText(cxR, 'end', arrTxt) + pathSvg;

    // Placeholder only when a photo was wanted but couldn't be shown. A VA that
    // turned the photo OFF gets a clean column, not an "unavailable" box.
    const photoPlaceholder = (has.photo || !o.showPhoto) ? '' : `
        <rect x="${photoX}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}" rx="16" fill="#161b22" stroke="#262d38"/>
        <text x="${photoX + PHOTO.w / 2}" y="${PHOTO.y + PHOTO.h / 2 - 6}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="84" fill="#2b3340">✈</text>
        <text x="${photoX + PHOTO.w / 2}" y="${PHOTO.y + PHOTO.h / 2 + 44}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" fill="#3a4452">Aircraft image unavailable</text>`;
    // Header logo is OUR brand bitmap; without the asset, fall back to wordmark text.
    const logoText = has.brand ? '' : `
        <text x="${LOGO.x}" y="${LOGO.y + 42}" font-family="DejaVu Sans, Arial, sans-serif" font-size="34" font-weight="bold" fill="#eef2f7">Inflight</text>`;

    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#0d1117"/>
                <stop offset="1" stop-color="#11161f"/>
            </linearGradient>
            <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stop-color="${accent}" stop-opacity="0.12"/>
                <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
        <!-- soft accent glow behind the header so the card isn't a flat slab -->
        <circle cx="1020" cy="60" r="520" fill="url(#glow)"/>
        <rect x="0" y="0" width="8" height="${HEIGHT}" fill="${accent}"/>
        <!-- header -->
        ${logoText}
        <text x="956" y="58" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" font-weight="bold" letter-spacing="1" fill="#7a8699">${esc(utcStamp(e.timestamp))}</text>
        <rect x="980" y="30" width="192" height="42" rx="21" fill="${accent}"/>
        <text x="1076" y="58" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="bold" fill="#0d1117">${eventWord}</text>
        <line x1="28" y1="96" x2="1172" y2="96" stroke="#222a35" stroke-width="2"/>
        <!-- route (horizontal A -> B with a dashed flight path + leg distance) -->
        <text x="${cx}" y="150" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold" letter-spacing="2" fill="#7a8699">ROUTE</text>
        ${distSvg}
        ${routeSvg}
        <line x1="${cx}" y1="244" x2="${cxR}" y2="244" stroke="#222a35" stroke-width="2"/>
        ${rowsSvg}
        ${photoPlaceholder}
    </svg>`);
};

// Render the composite PNG for one event. Returns a Buffer, or null if rendering
// failed (caller then falls back to the plain embed).
const renderVaEventCard = async (e = {}, media = {}, opts) => {
    try {
        const o = normalizeCardOptions(opts || {});
        const route = extractRoute(e);

        // The aircraft photo is the only remote bitmap; the brand logo is local.
        // Skip the photo fetch entirely when the VA turned the photo off. The
        // brand logo is ALWAYS drawn — it's not customizable.
        const photoRaw = o.showPhoto ? await fetchImage(media.aircraftImageUrl) : null;
        const [photo, brand] = await Promise.all([
            photoRaw ? coverRounded(photoRaw, PHOTO.w, PHOTO.h) : null,
            BRAND_LOGO_BUF ? contain(BRAND_LOGO_BUF, LOGO.w, LOGO.h) : null,
        ]);

        const has = { photo: !!photo, brand: !!brand };
        const { photoX } = cardLayout(o);
        const baseSvg = buildBaseSvg(e, route, has, o);

        const layers = [];
        if (brand) {
            const meta = await sharp(brand).metadata();
            // Vertically centre the contained logo inside its header box.
            const top = LOGO.y + Math.max(0, Math.round((LOGO.h - (meta.height || LOGO.h)) / 2));
            layers.push({ input: brand, left: LOGO.x, top });
        }
        if (photo) {
            layers.push({ input: photo, left: photoX, top: PHOTO.y });
            // Thin frame over the photo so it sits in the card instead of
            // floating on it (the placeholder already draws its own stroke).
            layers.push({
                input: Buffer.from(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO.w}" height="${PHOTO.h}"><rect x="1" y="1" width="${PHOTO.w - 2}" height="${PHOTO.h - 2}" rx="15" fill="none" stroke="#2a3342" stroke-width="2"/></svg>`),
                left: photoX, top: PHOTO.y,
            });
        }

        return await sharp(baseSvg).composite(layers).png().toBuffer();
    } catch (err) {
        console.error('[va-events] card render failed:', err.message);
        return null;
    }
};

module.exports = { renderVaEventCard, renderVaRouteMapImage };

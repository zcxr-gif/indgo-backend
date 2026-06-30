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
 * postVaEventCard). No route map and no "Powered by Inflight" footer on the card.
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
const { extractRoute, isHttpUrl } = require('./vaEventCard');

const WIDTH = 1200;
const HEIGHT = 600;

// --- Brand logo (local asset, loaded once) ----------------------------------
// This is OUR logo, shown top-left of the card. The VA's logo goes in the
// Discord message, not here.
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
// vertically centred in the right column so removing the map leaves no gap.
const LOGO = { x: 28, y: 28, w: 300, h: 56 };       // OUR brand logo (top-left)
const PHOTO = { x: 488, y: 184, w: 688, h: 300 };   // aircraft photo (original size, centred)

// Build the background/text SVG. `has` flags which bitmaps will be composited so
// we draw placeholders only where an image is missing.
const buildBaseSvg = (e, route, has) => {
    const isTakeoff = e.event === 'takeoff';
    const accent = isTakeoff ? '#2ecc71' : '#f1c40f';
    const ac = e.aircraft || {};
    const pos = e.position || {};
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
        <rect x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}" rx="16" fill="#161b22" stroke="#262d38"/>
        <text x="${PHOTO.x + PHOTO.w / 2}" y="${PHOTO.y + PHOTO.h / 2 - 6}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="84" fill="#2b3340">✈</text>
        <text x="${PHOTO.x + PHOTO.w / 2}" y="${PHOTO.y + PHOTO.h / 2 + 44}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" fill="#3a4452">Aircraft image unavailable</text>`;
    // Header logo is OUR brand bitmap; without the asset, fall back to wordmark text.
    const logoText = has.brand ? '' : `
        <text x="${LOGO.x}" y="${LOGO.y + 42}" font-family="DejaVu Sans, Arial, sans-serif" font-size="34" font-weight="bold" fill="#eef2f7">Inflight</text>`;

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
    </svg>`);
};

// Render the composite PNG for one event. Returns a Buffer, or null if rendering
// failed (caller then falls back to the plain embed).
const renderVaEventCard = async (e = {}, media = {}) => {
    try {
        const route = extractRoute(e);

        // The aircraft photo is the only remote bitmap; the brand logo is local.
        const photoRaw = await fetchImage(media.aircraftImageUrl);
        const [photo, brand] = await Promise.all([
            photoRaw ? coverRounded(photoRaw, PHOTO.w, PHOTO.h) : null,
            BRAND_LOGO_BUF ? contain(BRAND_LOGO_BUF, LOGO.w, LOGO.h) : null,
        ]);

        const has = { photo: !!photo, brand: !!brand };
        const baseSvg = buildBaseSvg(e, route, has);

        const layers = [];
        if (brand) {
            const meta = await sharp(brand).metadata();
            // Vertically centre the contained logo inside its header box.
            const top = LOGO.y + Math.max(0, Math.round((LOGO.h - (meta.height || LOGO.h)) / 2));
            layers.push({ input: brand, left: LOGO.x, top });
        }
        if (photo) layers.push({ input: photo, left: PHOTO.x, top: PHOTO.y });

        return await sharp(baseSvg).composite(layers).png().toBuffer();
    } catch (err) {
        console.error('[va-events] card render failed:', err.message);
        return null;
    }
};

module.exports = { renderVaEventCard };

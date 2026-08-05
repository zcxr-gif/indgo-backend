'use strict';

/*
 * Builds the Discord webhook embed for a VA takeoff/landing event.
 *
 * Kept as its own module (no DB / no network) so the card can be unit-tested in
 * isolation and so every delivery path — central feed, per-VA partner webhook,
 * and the staff "send test" button — renders an identical, Discord-valid card.
 *
 * Discord webhook/embed constraints this module is careful to honour:
 *   - A malformed image/icon URL makes Discord reject the WHOLE POST (HTTP 400),
 *     silently dropping the notification → every URL is gated through isHttpUrl().
 *   - Per-embed limits (title ≤ 256, description ≤ 4096, field value ≤ 1024 and
 *     non-empty, ≤ 25 fields) AND a 6000-char total budget across the embed.
 *     We clip well under the per-element caps (values ≤ 256, description ≤ 2048)
 *     so even pathologically long input can't push the total past 6000.
 */

// Public origin used to reference our own static assets (e.g. the brand logo in
// the embed footer). Override with PUBLIC_BASE_URL if the site isn't on the
// default host; trailing slashes are trimmed so we can append paths safely.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://inflight.info').replace(/\/+$/, '');

// Where "Track on Inflight" links send people: ALWAYS the public tracker site,
// never this backend. PUBLIC_BASE_URL often points at the backend host (that's
// where /assets lives), which used to leak into the card's click-through link.
// Override with TRACK_BASE_URL only if the tracker itself moves.
const TRACK_BASE_URL = (process.env.TRACK_BASE_URL || 'https://inflight.info').replace(/\/+$/, '');

// Event accent colours, shared by every renderer so the embed stripe, card
// artwork and route map can't drift apart. Discord wants the int form; SVG
// wants the hex string.
const EVENT_ACCENT = {
    takeoff: { hex: '#2ecc71', int: 0x2ecc71 }, // green
    landing: { hex: '#f1c40f', int: 0xf1c40f }, // gold
};
const accentFor = (e) => EVENT_ACCENT[e && e.event === 'takeoff' ? 'takeoff' : 'landing'];

// ---------------------------------------------------------------------------
// Per-VA card customization (colours / layout / which fields to show).
// A VA can override the card without breaking the shared, Discord-valid render:
// every knob is optional and falls back to the default look, and the Inflight
// brand mark is deliberately NOT customizable (it's always drawn on the image
// card and always rides in the embed footer — see buildVaEventPayload).
// ---------------------------------------------------------------------------

// The detail fields a VA may show and re-order. `route` (DEP → ARR) is always
// shown and so is intentionally NOT in this list. Kept as an ordered array so
// the UI, normalizer and both renderers share ONE source of truth.
const CARD_FIELD_KEYS = ['pilot', 'callsign', 'aircraft', 'server', 'altspeed', 'distance', 'ete', 'position'];
// Default selection + order when a VA hasn't customized the field list.
const DEFAULT_CARD_FIELDS = ['pilot', 'callsign', 'aircraft', 'server', 'altspeed', 'distance', 'ete'];
// Card layouts: 'card' = the rendered composite PNG (+ optional route map);
// 'compact' = the plain Discord embed only (no image upload), for VAs who want
// a lighter post.
const CARD_LAYOUTS = ['card', 'compact'];
// How the rendered card/map images sit in the Discord message:
//   'embed' = boxed inside the embed (Discord's default, constrained width);
//   'large' = posted as standalone attachments so Discord shows them at full
//             message width (bigger, and not framed by the embed container).
// Only affects the 'card' layout — 'compact' has no image either way.
const CARD_IMAGE_STYLES = ['embed', 'large'];
// Which side of the card the aircraft photo sits on.
const PHOTO_SIDES = ['right', 'left'];
// Route-map basemap looks. The concrete colour palettes live in the image
// renderer; here we only validate the chosen key.
const MAP_STYLES = ['dark', 'midnight', 'light', 'mono'];
// Output shapes for the standalone route-map image. `banner` is the wide strip
// posted under the Discord card and stays the default, so nothing about webhook
// delivery changes. `og` is the 1.91:1 rectangle link-preview crawlers expect,
// so a shared flight can unfurl as its own route.
const MAP_SIZES = ['banner', 'og'];

// A validated "#rrggbb" hex or '' (meaning: use the event's default colour).
// Accepts "#rgb"/"#rrggbb" with or without the leading '#'.
const normalizeHex = (raw) => {
    let v = String(raw == null ? '' : raw).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map(c => c + c).join('');
    return /^[0-9a-fA-F]{6}$/.test(v) ? '#' + v.toLowerCase() : '';
};

// Like normalizeHex but also accepts a small set of colour names (so a VA can
// ask for e.g. a plain white route line). '' means "fall back to the accent".
const NAMED_COLORS = {
    white: '#ffffff', black: '#000000', red: '#ff4d4f', orange: '#ff9800',
    amber: '#ffc107', yellow: '#ffd400', lime: '#84cc16', green: '#2ecc71',
    teal: '#14b8a6', cyan: '#22d3ee', sky: '#38bdf8', blue: '#3b82f6',
    indigo: '#6366f1', violet: '#8b5cf6', purple: '#a855f7', pink: '#ec4899',
    gray: '#9ca3af', grey: '#9ca3af', silver: '#cbd5e1',
};
const normalizeColor = (raw) => {
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!v) return '';
    return NAMED_COLORS[v] || normalizeHex(v);
};

// Coerce arbitrary stored/posted input into a safe card-options object. Unknown
// keys are dropped, unknown/duplicate field names are filtered, and an empty
// field list falls back to the default set — so a half-filled config can never
// produce an invalid or empty card.
const normalizeCardOptions = (raw = {}) => {
    const o = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const fields = (Array.isArray(o.fields) ? o.fields : [])
        .map(k => String(k || '').trim().toLowerCase())
        .filter(k => CARD_FIELD_KEYS.includes(k) && !seen.has(k) && seen.add(k));
    return {
        accent: normalizeHex(o.accent),
        layout: CARD_LAYOUTS.includes(o.layout) ? o.layout : 'card',
        imageStyle: CARD_IMAGE_STYLES.includes(o.imageStyle) ? o.imageStyle : 'embed',
        showMap: o.showMap === undefined ? true : !!o.showMap,
        showPhoto: o.showPhoto === undefined ? true : !!o.showPhoto,
        photoSide: PHOTO_SIDES.includes(o.photoSide) ? o.photoSide : 'right',
        mapStyle: MAP_STYLES.includes(o.mapStyle) ? o.mapStyle : 'dark',
        mapSize: MAP_SIZES.includes(o.mapSize) ? o.mapSize : 'banner',
        mapLine: normalizeColor(o.mapLine),
        title: String(o.title == null ? '' : o.title).trim().slice(0, 240),
        fields: fields.length ? fields : DEFAULT_CARD_FIELDS.slice(),
    };
};

// The default (uncustomized) card options, frozen so callers can pass it around
// without accidentally mutating a shared object.
const DEFAULT_CARD_OPTIONS = Object.freeze(normalizeCardOptions({}));

// Resolve the accent an event should render with: a VA's hex override when set,
// otherwise the event-type default (green takeoff / gold landing). Returns both
// forms so SVG (hex) and Discord (int) callers agree.
const resolveAccent = (e, opts) => {
    const hex = opts && normalizeHex(opts.accent);
    if (hex) return { hex, int: parseInt(hex.slice(1), 16) };
    return accentFor(e);
};

// The colour of the route line + endpoint markers on the map: an explicit
// mapLine override when set, otherwise the resolved accent. Returns a hex string.
const resolveMapLine = (e, opts) => {
    const hex = opts && normalizeColor(opts.mapLine);
    return hex || resolveAccent(e, opts).hex;
};

// Only well-formed http(s) URLs may be handed to Discord's image proxy; anything
// else (null, '', a relative path stored in the DB) is omitted rather than risk
// a 400 that would drop the entire webhook message.
const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim());

// Clip a string to a Discord field/title limit, never returning empty (Discord
// rejects empty field values), so callers can pass possibly-overlong input.
const clip = (s, max, fallback = '—') => {
    const str = (s == null ? '' : String(s)).trim() || fallback;
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
};

// The "Track on Inflight" link shown on every card. No per-flight deep link
// exists yet, so this points at the tracker home.
const trackUrl = () => TRACK_BASE_URL;

// ---------------------------------------------------------------------------
// Derived route figures (leg distance + estimated time enroute), shared by the
// image card and the JSON embed so the two surfaces never disagree.
// data/airport-coords.json maps uppercase ICAO -> [lat, lon] for the majors; a
// miss just hides the figure (never an error).
// ---------------------------------------------------------------------------
let AIRPORT_COORDS = {};
try { AIRPORT_COORDS = require('./data/airport-coords.json'); } catch { AIRPORT_COORDS = {}; }

const airportCoords = (icao) => {
    const v = icao ? AIRPORT_COORDS[String(icao).toUpperCase()] : null;
    return (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) ? v : null;
};

// Great-circle leg distance in nautical miles between two ICAOs, or null when
// either end is unknown or it rounds to 0 (same-airport pattern work is noise).
const routeDistanceNm = (dep, arr) => {
    const a = airportCoords(dep), b = airportCoords(arr);
    if (!a || !b) return null;
    const rad = (d) => d * Math.PI / 180;
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    const nm = Math.round(3440.065 * 2 * Math.asin(Math.sqrt(h)));
    return nm > 0 ? nm : null;
};

// Estimated time enroute in whole minutes = leg distance ÷ current groundspeed.
// Only meaningful once the aircraft is actually moving (gs ≥ 40 kt), so a
// still-on-the-ground reading can't produce an absurd multi-day figure.
const eteMinutes = (distNm, gsKt) =>
    (Number.isFinite(distNm) && Number.isFinite(gsKt) && gsKt >= 40)
        ? Math.round((distNm / gsKt) * 60) : null;

// "1h 24m" / "45m" from a minute count, or null for null input.
const formatDuration = (mins) => {
    if (mins == null || !Number.isFinite(mins) || mins < 0) return null;
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
};

// The ETE string for an event, or null when it can't/shouldn't be shown. ETE is
// a look-ahead figure, so it's only meaningful on a DEPARTURE — a landing card
// showing "time to go" would be nonsense.
const eteTextFor = (e = {}) => {
    if (e.event !== 'takeoff') return null;
    const { dep, arr } = extractRoute(e);
    const gs = e.position && e.position.gs_kt;
    return formatDuration(eteMinutes(routeDistanceNm(dep, arr), gs));
};

// Build a static map image URL with a plane marker at the flight's position, so
// the card literally shows WHERE the aircraft is. Prefers Mapbox (set
// MAPBOX_STATIC_TOKEN) for a clean dark map + plane pin; falls back to the
// key-less OpenStreetMap static renderer when no token is configured. Returns
// null when we don't have usable coordinates.
const flightMapImageUrl = (lat, lon, isTakeoff) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const la = lat.toFixed(4), lo = lon.toFixed(4);
    const zoom = 6;
    const token = process.env.MAPBOX_STATIC_TOKEN || process.env.MAPBOX_TOKEN;
    if (token) {
        // Mapbox expects lon,lat ordering. The maki "airport" glyph is a plane
        // silhouette, so the marker itself reads as an aircraft on the map.
        const color = accentFor({ event: isTakeoff ? 'takeoff' : 'landing' }).hex.slice(1);
        const marker = `pin-l-airport+${color}(${lo},${la})`;
        return `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${marker}/${lo},${la},${zoom},0/640x320@2x?access_token=${encodeURIComponent(token)}`;
    }
    // Key-less fallback (OSM static map service uses lat,lon ordering).
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${la},${lo}&zoom=${zoom}&size=640x320&maptype=mapnik&markers=${la},${lo},lightblue1`;
};

// Pull a single ICAO out of whatever shape a value arrives in — a bare string,
// or an object keyed by icao/code/ident. Upper-cased; '' when nothing usable.
const icaoOf = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (typeof v === 'object') {
        return String(v.icao || v.code || v.ident || v.ICAO || v.airport || '')
            .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
    return '';
};
const firstIcao = (...vals) => {
    for (const v of vals) { const s = icaoOf(v); if (s) return s; }
    return '';
};

// Extract departure/arrival ICAO from an event, tolerant of the field names an
// ACARS sender might use (flat strings, nested {icao}/{code}/{ident}, or a
// route/flightPlan object). Returns { dep, arr } as ICAO strings ('' if absent).
// Exported so both the image card and the JSON-embed fallback read the route the
// same way.
const extractRoute = (e = {}) => {
    const r = e.route || e.flightPlan || e.fpl || e.fp || {};
    const dep = firstIcao(
        e.departure, e.depIcao, e.dep, e.origin, e.from, e.originIcao, e.fromIcao,
        e.departureAirport, e.departureIcao, e.depAirport,
        r.departure, r.dep, r.origin, r.from,
    );
    const arr = firstIcao(
        e.arrival, e.arrIcao, e.arr, e.destination, e.dest, e.to, e.destinationIcao, e.toIcao,
        e.arrivalAirport, e.arrivalIcao, e.arrAirport,
        r.arrival, r.arr, r.destination, r.dest, r.to,
    );
    return { dep, arr };
};

// Field builders keyed by the vocabulary in CARD_FIELD_KEYS. Each returns an
// array (possibly empty, when the datum is missing) so the caller can honour a
// VA's chosen field list AND order while silently skipping fields with no value.
const EMBED_FIELD_BUILDERS = {
    pilot:    (c) => [{ name: '👤 Pilot', value: clip(c.e.username, 256), inline: true }],
    callsign: (c) => [{ name: '📡 Callsign', value: clip(c.e.callsign, 256), inline: true }],
    server:   (c) => [{ name: '🌐 Server', value: clip(c.e.server, 256), inline: true }],
    aircraft: (c) => c.aircraftLine ? [{ name: '✈️ Aircraft', value: clip(c.aircraftLine, 256), inline: true }] : [],
    altspeed: (c) => c.altSpeed ? [{ name: '📈 Alt · Speed', value: c.altSpeed, inline: true }] : [],
    distance: (c) => c.distNm != null ? [{ name: '📏 Distance', value: `≈ ${c.distNm.toLocaleString('en-US')} NM`, inline: true }] : [],
    ete:      (c) => c.eteText ? [{ name: '⏱️ ETE', value: c.eteText, inline: true }] : [],
    // Plain coordinates — NOT a masked link. Raw URLs don't auto-linkify inside
    // embed fields and masked links can be stripped by clients/AutoMod, leaving
    // ugly `[..](..)` markdown. The map stays reachable via the clickable title.
    position: (c) => c.coords ? [{ name: '📍 Position', value: c.coords, inline: true }] : [],
};

// Build the Discord embed payload for one takeoff/landing. `media` carries the
// (already-resolved) aircraft photo + VA logo URLs; `opts` is a (normalized) VA
// card customization. Pure & synchronous. Used both for the 'compact' layout and
// as the fallback when the composite image card can't be rendered.
const buildVaEventPayload = (e = {}, media = {}, opts) => {
    const o = normalizeCardOptions(opts || {});
    const isTakeoff = e.event === 'takeoff';
    const va = e.va || {};
    const pos = e.position || {};
    const ac = e.aircraft || {};
    const accent = resolveAccent(e, o).int;

    const hasCoords = Number.isFinite(pos.lat) && Number.isFinite(pos.lon);
    const coords = hasCoords ? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` : null;
    const track = trackUrl();

    const aircraftLine = ac.aircraftName
        ? (ac.liveryName ? `${ac.aircraftName} · ${ac.liveryName}` : ac.aircraftName)
        : null;
    const altSpeed = [
        Number.isFinite(pos.alt_ft) ? `${Math.round(pos.alt_ft).toLocaleString()} ft` : null,
        Number.isFinite(pos.gs_kt) ? `${Math.round(pos.gs_kt)} kt` : null,
    ].filter(Boolean).join(' · ') || null;

    const { dep, arr } = extractRoute(e);
    const ctx = { e, aircraftLine, altSpeed, coords, distNm: routeDistanceNm(dep, arr), eteText: eteTextFor(e) };

    const fields = [];
    // Route first, laid out horizontally (two inline fields side by side) so
    // departure → arrival reads across, not stacked. Route is always shown.
    if (dep || arr) {
        fields.push({ name: '🛫 Departure', value: clip(dep || '—', 256), inline: true });
        fields.push({ name: '🛬 Arrival', value: clip(arr || '—', 256), inline: true });
    }
    // Then the VA's chosen fields, in their chosen order (Discord caps at 25).
    for (const key of o.fields) {
        const build = EMBED_FIELD_BUILDERS[key];
        if (build) for (const f of build(ctx)) { if (fields.length < 25) fields.push(f); }
    }

    const brandIcon = `${PUBLIC_BASE_URL}/assets/brand/inflight-logo.png`;
    const embed = {
        author: {
            name: clip(`${va.name || va.code || 'Virtual Airline'} · ${isTakeoff ? 'Departure' : 'Arrival'}`, 256),
            ...(isHttpUrl(media.vaLogoUrl) ? { icon_url: media.vaLogoUrl } : {}),
        },
        title: clip(o.title
            || `${isTakeoff ? '🛫' : '🛬'}  ${e.callsign || 'Unknown flight'}${(dep || arr) ? `  ·  ${dep || '????'} → ${arr || '????'}` : ''}`, 256),
        ...(isHttpUrl(track) ? { url: track } : {}),
        description: clip(
            `**${e.username || 'A pilot'}** ${isTakeoff ? 'just departed' : 'just landed'} on **${e.server || 'unknown'}**`
            + (aircraftLine ? ` flying the **${ac.aircraftName}**.` : '.')
            + (isHttpUrl(track) ? `\n[🔭 Track on Inflight](${track})` : ''),
            2048),
        color: accent,
        fields,
        timestamp: new Date(Number(e.timestamp) || Date.now()).toISOString(),
        // The Inflight brand mark ALWAYS rides in the footer — this is not
        // customizable, so every card is attributable to Inflight.
        footer: {
            text: 'Powered by Inflight',
            ...(isHttpUrl(brandIcon) ? { icon_url: brandIcon } : {}),
        },
    };

    // Big image: a real photo of the flown aircraft, unless the VA turned the
    // photo off. The VA's logo rides in the author icon above, not here.
    if (o.showPhoto && isHttpUrl(media.aircraftImageUrl)) embed.image = { url: media.aircraftImageUrl };

    return { embeds: [embed] };
};

module.exports = {
    buildVaEventPayload, extractRoute, flightMapImageUrl, isHttpUrl, clip, trackUrl,
    accentFor, PUBLIC_BASE_URL,
    // Derived route figures (shared with the image renderer).
    routeDistanceNm, eteMinutes, formatDuration, eteTextFor,
    // Card customization vocabulary + helpers (shared with the API/UI/renderer).
    CARD_FIELD_KEYS, DEFAULT_CARD_FIELDS, CARD_LAYOUTS, CARD_IMAGE_STYLES, PHOTO_SIDES, MAP_STYLES, MAP_SIZES,
    DEFAULT_CARD_OPTIONS, normalizeCardOptions, resolveAccent, resolveMapLine,
    normalizeHex, normalizeColor,
};

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

// Build the Discord embed payload for one takeoff/landing. `media` carries the
// (already-resolved) aircraft photo + VA logo URLs. Pure & synchronous. Used as
// the fallback when the composite image card can't be rendered.
const buildVaEventPayload = (e = {}, media = {}) => {
    const isTakeoff = e.event === 'takeoff';
    const va = e.va || {};
    const pos = e.position || {};
    const ac = e.aircraft || {};
    const accent = accentFor(e).int;

    const hasCoords = Number.isFinite(pos.lat) && Number.isFinite(pos.lon);
    const coords = hasCoords ? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` : null;
    const track = trackUrl();

    const aircraftLine = ac.aircraftName
        ? (ac.liveryName ? `${ac.aircraftName} · ${ac.liveryName}` : ac.aircraftName)
        : null;

    const { dep, arr } = extractRoute(e);
    const fields = [];
    // Route first, laid out horizontally (two inline fields sitting side by side)
    // so departure → arrival reads across, not stacked.
    if (dep || arr) {
        fields.push({ name: '🛫 Departure', value: clip(dep || '—', 256), inline: true });
        fields.push({ name: '🛬 Arrival', value: clip(arr || '—', 256), inline: true });
    }
    fields.push(
        { name: '👤 Pilot', value: clip(e.username, 256), inline: true },
        { name: '📡 Callsign', value: clip(e.callsign, 256), inline: true },
        { name: '🌐 Server', value: clip(e.server, 256), inline: true },
    );
    if (aircraftLine) fields.push({ name: '✈️ Aircraft', value: clip(aircraftLine, 256), inline: true });
    if (Number.isFinite(pos.alt_ft)) fields.push({ name: '📈 Altitude', value: `${Math.round(pos.alt_ft).toLocaleString()} ft`, inline: true });
    if (Number.isFinite(pos.gs_kt)) fields.push({ name: '💨 Ground speed', value: `${Math.round(pos.gs_kt)} kt`, inline: true });
    // Plain coordinates — NOT a masked link. Raw URLs don't auto-linkify inside
    // embed fields and masked links can be stripped by clients/AutoMod, which
    // would leave ugly `[..](..)` markdown. The map stays reachable two ways that
    // never depend on field-link support: the clickable title `url` and the map
    // image itself.
    if (coords) fields.push({ name: '📍 Position', value: coords, inline: true });

    const brandIcon = `${PUBLIC_BASE_URL}/assets/brand/inflight-logo.png`;
    const embed = {
        author: {
            name: clip(`${va.name || va.code || 'Virtual Airline'} · ${isTakeoff ? 'Departure' : 'Arrival'}`, 256),
            ...(isHttpUrl(media.vaLogoUrl) ? { icon_url: media.vaLogoUrl } : {}),
        },
        title: clip(`${isTakeoff ? '🛫' : '🛬'}  ${e.callsign || 'Unknown flight'}${(dep || arr) ? `  ·  ${dep || '????'} → ${arr || '????'}` : ''}`, 256),
        ...(isHttpUrl(track) ? { url: track } : {}),
        description: clip(
            `**${e.username || 'A pilot'}** ${isTakeoff ? 'just departed' : 'just landed'} on **${e.server || 'unknown'}**`
            + (aircraftLine ? ` flying the **${ac.aircraftName}**.` : '.')
            + (isHttpUrl(track) ? `\n[🔭 Track on Inflight](${track})` : ''),
            2048),
        color: accent,
        fields,
        timestamp: new Date(Number(e.timestamp) || Date.now()).toISOString(),
        footer: {
            text: 'Powered by Inflight',
            ...(isHttpUrl(brandIcon) ? { icon_url: brandIcon } : {}),
        },
    };

    // Big image: a real photo of the flown aircraft (the map has been removed).
    // The VA's logo rides in the author icon above, not as a thumbnail here.
    if (isHttpUrl(media.aircraftImageUrl)) embed.image = { url: media.aircraftImageUrl };

    return { embeds: [embed] };
};

module.exports = { buildVaEventPayload, extractRoute, flightMapImageUrl, isHttpUrl, clip, trackUrl, accentFor, PUBLIC_BASE_URL };

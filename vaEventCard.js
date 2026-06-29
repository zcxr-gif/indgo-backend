'use strict';

/*
 * Builds the Discord webhook embed for a VA takeoff/landing event.
 *
 * Kept as its own module (no DB / no network) so the card can be unit-tested in
 * isolation and so every delivery path — central feed, per-VA partner webhook,
 * and the staff "send test" button — renders an identical, Discord-valid card.
 * The async airport/photo lookups that feed it live in server.js and are passed
 * in via `media`.
 *
 * Discord webhook/embed constraints honoured here:
 *   - A malformed image/icon URL makes Discord reject the WHOLE POST (HTTP 400),
 *     silently dropping the notification → every URL is gated through isHttpUrl().
 *   - Per-embed limits (title <= 256, description <= 4096, field value <= 1024 and
 *     non-empty, <= 25 fields) AND a 6000-char total budget across the embed.
 *     We clip well under the per-element caps so even pathologically long input
 *     can't push the total past 6000.
 */

// Public origin used to reference our own static assets (e.g. the brand logo in
// the embed footer). Override with PUBLIC_BASE_URL if the site isn't on the
// default host; trailing slashes are trimmed so we can append paths safely.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://inflight.info').replace(/\/+$/, '');

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

const isPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

// Build a LIGHT static map showing the flight: departure (A) → arrival (B) with
// a route line, plus the live aircraft position when known. Prefers Mapbox
// (light-v11) for a clean line + pins, auto-framed to fit; falls back to the
// key-less OpenStreetMap renderer (mapnik is itself a light map) with markers.
// Accepts any subset of { dep, arr, plane } points; returns null if none usable.
const SIZE = '640x320';
const flightRouteMapUrl = ({ dep, arr, plane } = {}) => {
    const D = isPoint(dep) ? dep : null;
    const A = isPoint(arr) ? arr : null;
    const P = isPoint(plane) ? plane : null;
    const pts = [D, A, P].filter(Boolean);
    if (!pts.length) return null;

    const f = (n) => Number(n).toFixed(4);
    const token = process.env.MAPBOX_STATIC_TOKEN || process.env.MAPBOX_TOKEN;

    if (token) {
        const overlays = [];
        // Route line first so the pins draw on top of it.
        if (D && A) {
            const line = {
                type: 'Feature',
                properties: { stroke: '#2563eb', 'stroke-width': 3, 'stroke-opacity': 0.85 },
                geometry: { type: 'LineString', coordinates: [[+f(D.lon), +f(D.lat)], [+f(A.lon), +f(A.lat)]] },
            };
            overlays.push('geojson(' + encodeURIComponent(JSON.stringify(line)) + ')');
        }
        if (D) overlays.push(`pin-s-a+22c55e(${f(D.lon)},${f(D.lat)})`); // green "A" = departure
        if (A) overlays.push(`pin-s-b+ef4444(${f(A.lon)},${f(A.lat)})`); // red "B" = arrival
        if (P) overlays.push(`pin-l-airport+2563eb(${f(P.lon)},${f(P.lat)})`); // blue plane = live position
        // Auto-fit when we have a span to frame; otherwise centre on the one point.
        const view = pts.length >= 2 ? 'auto' : `${f(pts[0].lon)},${f(pts[0].lat)},6,0`;
        return `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/${overlays.join(',')}/${view}/${SIZE}@2x?padding=50&access_token=${encodeURIComponent(token)}`;
    }

    // Key-less fallback. The OSM static service can't draw a route line, so we
    // place markers and frame them with a computed centre + zoom. (lat,lon order.)
    const markers = pts.map((p) => `markers=${f(p.lat)},${f(p.lon)},lightblue1`);
    const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    let zoom = 6;
    if (pts.length >= 2) {
        const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons));
        zoom = span > 60 ? 2 : span > 30 ? 3 : span > 15 ? 4 : span > 7 ? 5 : span > 3 ? 6 : span > 1 ? 7 : 8;
    }
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${cLat.toFixed(4)},${cLon.toFixed(4)}&zoom=${zoom}&size=${SIZE}&maptype=mapnik&${markers.join('&')}`;
};

// A bold airport code over its (clipped) name, for the Departure/Arrival fields.
const airportField = (icao, name) => `**${clip(icao, 8)}**` + (name ? `\n${clip(name, 60, '')}` : '');

// Build the Discord embed payload for one takeoff/landing. `media` carries the
// already-resolved aircraft photo, VA logo and airport points/names. Pure & sync.
const buildVaEventPayload = (e = {}, media = {}) => {
    const isTakeoff = e.event === 'takeoff';
    const va = e.va || {};
    const pos = e.position || {};
    const ac = e.aircraft || {};
    const accent = isTakeoff ? 0x2ecc71 : 0xf1c40f; // green takeoff / gold landing

    const plane = isPoint(pos) ? { lat: pos.lat, lon: pos.lon } : null;
    const dep = media.departure || null; // { icao, lat, lon, name } | null
    const arr = media.arrival || null;
    const depIcao = (e.departureIcao || dep?.icao || '').toUpperCase().trim() || null;
    const arrIcao = (e.arrivalIcao || arr?.icao || '').toUpperCase().trim() || null;
    const hasRoute = Boolean(depIcao || arrIcao);

    const mapUrl = flightRouteMapUrl({ dep, arr, plane });

    const coords = plane ? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` : null;
    const geoLink = plane
        ? `https://www.google.com/maps?q=${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`
        : null;

    const aircraftLine = ac.aircraftName
        ? (ac.liveryName ? `${ac.aircraftName} · ${ac.liveryName}` : ac.aircraftName)
        : null;

    // Headline route in the description: codes only, so it reads at a glance.
    const verb = isTakeoff ? 'departed' : 'landed';
    let routePhrase = '';
    if (depIcao && arrIcao) routePhrase = ` **${depIcao} → ${arrIcao}**`;
    else if (depIcao) routePhrase = ` from **${depIcao}**`;
    else if (arrIcao) routePhrase = ` to **${arrIcao}**`;

    const fields = [
        { name: '👤 Pilot', value: clip(e.username, 256), inline: true },
        { name: '📡 Callsign', value: clip(e.callsign, 256), inline: true },
        { name: '🌐 Server', value: clip(e.server, 256), inline: true },
    ];
    // Departure / Arrival pair — only when there's a plan, with the missing side
    // shown as — so the A→B framing still lines up. Names enrich when resolved.
    if (hasRoute) {
        fields.push({ name: '🛫 Departure', value: depIcao ? airportField(depIcao, dep?.name) : '—', inline: true });
        fields.push({ name: '🛬 Arrival', value: arrIcao ? airportField(arrIcao, arr?.name) : '—', inline: true });
    }
    if (aircraftLine) fields.push({ name: '✈️ Aircraft', value: clip(aircraftLine, 256), inline: true });
    if (Number.isFinite(pos.alt_ft)) fields.push({ name: '📈 Altitude', value: `${Math.round(pos.alt_ft).toLocaleString()} ft`, inline: true });
    if (Number.isFinite(pos.gs_kt)) fields.push({ name: '💨 Ground speed', value: `${Math.round(pos.gs_kt)} kt`, inline: true });
    // Plain coordinates — NOT a masked link. Raw URLs don't auto-linkify inside
    // embed fields and masked links can be stripped by clients/AutoMod, leaving
    // ugly `[..](..)` markdown. The position stays reachable via the title `url`.
    if (coords) fields.push({ name: '📍 Position', value: coords, inline: true });

    const brandIcon = `${PUBLIC_BASE_URL}/assets/brand/inflight-logo.png`;
    const embed = {
        author: {
            name: clip(`${va.name || va.code || 'Virtual Airline'} · ${isTakeoff ? 'Departure' : 'Arrival'}`, 256),
            ...(isHttpUrl(media.vaLogoUrl) ? { icon_url: media.vaLogoUrl } : {}),
        },
        title: clip(`${isTakeoff ? '🛫' : '🛬'}  ${e.callsign || 'Unknown flight'}`, 256),
        ...(isHttpUrl(geoLink) ? { url: geoLink } : {}),
        description: clip(
            `**${e.username || 'A pilot'}** just ${verb}${routePhrase} on **${e.server || 'unknown'}**.`,
            2048),
        color: accent,
        fields,
        timestamp: new Date(Number(e.timestamp) || Date.now()).toISOString(),
        footer: {
            text: 'Inflight · VA Flight Events',
            ...(isHttpUrl(brandIcon) ? { icon_url: brandIcon } : {}),
        },
    };

    // Big image: the light A→B route map (with the live aircraft position).
    if (isHttpUrl(mapUrl)) embed.image = { url: mapUrl };
    // Thumbnail: a real photo of the aircraft when we have one, else the VA logo.
    const thumb = [media.aircraftImageUrl, media.vaLogoUrl].find(isHttpUrl) || null;
    if (thumb) embed.thumbnail = { url: thumb };

    return { embeds: [embed] };
};

module.exports = { buildVaEventPayload, flightRouteMapUrl, isHttpUrl, PUBLIC_BASE_URL };

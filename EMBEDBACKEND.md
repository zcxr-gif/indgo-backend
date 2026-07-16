# Inflight Embed — Backend & Distribution Guide

The embed widget lives at:

```
https://inflight.info/embed.html
```

There are **two ways** to drive it:

1. **Preview links** — everything is passed in the URL. No backend needed.
   Good for testing or for VAs you trust with the raw config.
2. **Token links** — the URL carries only an opaque `?token=…`. The widget
   calls your backend (`GET /api/embed/resolve`) to fetch the real config.
   This is what you distribute in production: the VA never sees the Mapbox
   token, you can restrict a token to specific websites, and you can revoke it.

---

## 1. Quick start — preview links (no backend)

Hand a VA a URL like this (URL-encode spaces as `%20`):

```
https://inflight.info/embed.html?va=OCEAN&name=Ocean%20Virtual&mode=map
```

To embed it on their site, they paste this iframe:

```html
<iframe
  src="https://inflight.info/embed.html?va=OCEAN&name=Ocean%20Virtual&mode=map"
  style="width:100%;height:520px;border:0;border-radius:12px;overflow:hidden"
  loading="lazy"
  title="Ocean Virtual — Live Flights">
</iframe>
```

### Supported URL parameters

| Param        | Example                                  | Notes |
|--------------|------------------------------------------|-------|
| `va`         | `OCEAN`                                   | **Required.** VA callsign code. |
| `name`       | `Ocean%20Virtual`                         | Display name. Defaults to the code. |
| `logo`       | `https://…/logo.png`                      | Optional. Auto-resolved from the VA-Ads roster if omitted. |
| `mode`       | `map` or `roster`                         | Defaults to `roster`. |
| `prefixes`   | `Air%20Canada,United`                     | **Full airline name(s)** you fly under (see Callsign matching). Defaults to `[va]`. |
| `suffixes`   | `VA,EX`                                    | Your trailing tag(s) (see Callsign matching). |
| `regulars`   | `OCEAN%20STAFF,Shamrock`                  | Untagged callsigns, prefix-only, always included (alias `callsigns`). See §2. |
| `hubs`       | `CYYZ,CYUL,CYVR`                          | Hub ICAOs. Each becomes a map marker listing your inbound pilots. |
| `provider`   | `mapbox` or `free`                        | Auto: `free` when no Mapbox token. |
| `mapboxToken`| `pk.eyJ…`                                 | The VA's own Mapbox token (mapbox provider only). |
| `mapStyle`   | `mapbox://styles/mapbox/dark-v11`         | Mapbox style URL (mapbox provider). |
| `freeStyle`  | `dark` \| `liberty` \| `bright` \| `positron` \| URL | Free style (free provider). Defaults to `dark`. |
| `theme`      | `dark` or `light`                         | UI chrome theme. |
| `color`      | `%230ea5e9,%238b5cf6`                     | Header colour(s) — see §1.1. Supersedes `brandColor`. |
| `brandColor` | `%231d4ed8`                               | **Legacy** single header colour (encode `#` as `%23`). Still works; prefer `color`. |
| `header`     | `off`                                     | Hide the header bar — see §1.1. |
| `headerPos`  | `top` \| `bottom` \| `left` \| `right`    | Header placement — see §1.1. |
| `gradient`   | `off`                                     | Keep a single colour flat (no auto companion). |
| `angle`      | `90`                                      | Gradient direction in degrees (default 120). |
| `compact`    | `1`                                       | Slimmer header (smaller logo, tighter padding). |
| `radius`     | `0`                                       | Widget corner radius in px, 0–32 (0 = square). |
| `servers`    | `Expert`                                  | IF session names to scan (substring match). Empty = all. |
| `cardColor`  | `%230b1220`                               | Flight-card surface colour (alias `cardBg`) — see §1.2. |
| `cardText`   | `white`                                   | Flight-card text colour (alias `textColor`) — see §1.2. |
| `cardOpacity`| `0.6`                                     | Flight-card opacity, 0–1 or 0–100 (alias `opacity`) — see §1.2. |
| `cardBlur`   | `14`                                      | Flight-card backdrop blur px, 0–40 — see §1.2. |

> **Free vs Mapbox:** if you don't pass a `mapboxToken`, the map automatically
> uses the free, key-less OpenFreeMap source (flat map). Pass a token to get the
> Mapbox globe.

### 1.1 Header & appearance customization

All of these work **both** as query params (preview links) and as fields in the
token config returned by `/api/embed/resolve` (see §3).

**Header visibility**

- `header=off` — hide the header bar entirely. The "Powered by Inflight"
  attribution then floats over the widget as a pill with the live pilot count
  (bottom-right in roster mode, bottom-left in map mode). It is always
  rendered — the attribution can never be fully removed.

**Header placement**

- `headerPos=top` — default, classic top bar.
- `headerPos=bottom` — bar sits under the content.
- `headerPos=left` — vertical brand rail on the left (bigger logo, wrapping VA
  name, Powered-by pinned at the rail's foot).
- `headerPos=right` — same rail, on the right.
- Rails auto-collapse to the top bar under ~560px wide.

**Header colours & gradients**

- `color=#1e3a8a` — one brand colour. Auto-expands into a rich two-stop
  gradient using a derived companion shade.
- `color=#0ea5e9,#8b5cf6` — two (up to three) comma-separated colours →
  multi-stop gradient header.
- `gradient=off` — keep a single colour flat (no auto companion).
- `angle=90` — gradient direction in degrees (default 120).
- Omit `color` entirely → auto: the widget samples the VA logo's most vivid
  colours; two-tone logos gradient their own two colours. Text, borders and
  the wordmark are contrast-computed (WCAG) against the blend of all stops.

**Density & shape**

- `compact=1` — slimmer header (smaller logo, tighter padding).
- `radius=0` — widget corner radius in px, 0–32 (0 = square corners).

Examples:

```
https://inflight.info/embed.html?va=OCEAN&color=%230ea5e9,%238b5cf6&angle=90
https://inflight.info/embed.html?va=OCEAN&header=off
https://inflight.info/embed.html?va=OCEAN&headerPos=left&compact=1&radius=0
```

### 1.2 Flight-card customization (map mode)

Controls the look of the tap/detail flight card. Purely cosmetic → CSS only.
All optional; omit to keep the widget defaults.

In the resolve payload, nest them under `card`:

```jsonc
{
  "card": {
    "opacity": 0.6,        // 0–1 OR 0–100. How see-through the card is.
                           //   below ~0.9 auto-frosts the map behind it.
    "color":   "#0b1220",  // card surface colour: hex, rgb(), or a name ("navy")
    "text":    "white",    // card text colour: hex, rgb(), or a name ("red","white")
    "blur":    14          // optional backdrop blur in px (0–40). Auto when translucent.
  }
}
```

**Accepted colour names** (besides hex / `rgb()`): white, black, red, crimson,
orange, amber, yellow, gold, lime, green, emerald, teal, cyan, sky, blue, navy,
indigo, violet, purple, magenta, pink, rose, slate, gray/grey, silver.

**Flat aliases** (if you don't want a nested object) are accepted in the resolve
payload too: `cardColor` (or `cardBg`), `cardText` (or `textColor`),
`cardOpacity` (or `opacity`), `cardBlur`.

Preview params: `&cardOpacity=0.6 &cardColor=%230b1220 &cardText=white &cardBlur=14`

---

## 2. Callsign matching (important)

A flight counts as yours only when it matches the **full airline name** you fly
under — and, *if* you use a tag, also carries that tag. This stops the embed from
grabbing every callsign that merely ends in a common tag like `VA`.

- **Prefix rule** (`callsignPrefixes`) — the airline / base callsigns the VA
  flies under. Each is the *complete* airline name, e.g. `"Air Canada"` (not the
  ICAO code `ACA`). The widget compacts it (removes spaces/separators) and
  matches it against the START of the flight's compacted callsign, so it matches
  the whole airline — `"Air Canada"` matches `Air Canada 001VA` and **only** Air
  Canada, never Air France or AirAsia. Defaults to `[va]` when omitted.
- **Suffix rule** (`callsignSuffixes`) — optional tags (tag mode). When set, a
  flight must match a declared prefix **and** carry one of these tags on
  **either of the callsign's last two tokens** — so a pilot may append a second
  trailing tag and still match. One configured tag is enough. A bare tag never
  matches on its own. To run a tag across several airlines, list each airline in
  `callsignPrefixes`.
- **Regular callsigns** (`regularCallsigns`) — untagged callsigns matched by
  **prefix only** (never require a suffix tag) and **always included**, even when
  the prefixes above are running in tag mode. Use for staff / charter / plain
  airline callsigns alongside your tagged members. Alias in preview URLs:
  `callsigns`.

**How they combine (per flight):**

1. If it prefix-matches any `regularCallsigns` → **included** (no tag needed).
2. Else if it prefix-matches any `callsignPrefixes`:
   - no `callsignSuffixes` set → **included** (prefix-only mode)
   - `callsignSuffixes` set → included **only** if a tag is on one of the last
     two tokens.
3. Otherwise → not this VA.

Suffix examples (`prefixes: ["Air Canada"]`, `suffixes: ["VA"]`):

- `Air Canada 001VA` ✓ · `Air Canada 001VA CX` ✓ (extra trailing tag) ·
  `Air Canada 001 VA EX` ✓ · `Air Canada 001` ✗ (no tag)

Examples (`prefixes: ["Air Canada"]`, `suffixes: ["VA"]`):

| Callsign            | Result                       |
|---------------------|------------------------------|
| `Air Canada 001VA`  | ✅ match                     |
| `Air Canada 001`    | ❌ missing tag               |
| `Air France 045VA`  | ❌ airline not declared      |

Fly one tag across several airlines → list each full name:

```
prefixes=Air Canada,United,Lufthansa  &  suffixes=VA
→ matches "Air Canada 001VA", "United 045VA", "Lufthansa 12VA"
→ not     "Delta 010VA"  (Delta not declared)
```

> Use the full airline name and keep its spaces/case (encode spaces as `%20` in
> URLs). ICAO codes like `ACA` will **not** match the in-game callsign.

Example URL using a name + tag:

```
https://inflight.info/embed.html?va=Air%20Canada%20Virtual&name=Air%20Canada%20Virtual&prefixes=Air%20Canada&suffixes=VA&mode=map
```

### Hubs + inbound VA pilots

Pass `hubs` (comma-separated ICAOs in a preview URL, or a `hubs` array in the
resolve payload). Each hub becomes a map marker; tapping it opens an airport
window listing your pilots inbound to that airport (callsign · route · pilot
name) plus a live "VA Inbound" count. No extra backend endpoint is needed.

---

## 3. Token links — backend `/api/embed/resolve`

The widget calls:

```
GET https://<your-backend>/api/embed/resolve?token=<token>&origin=<embedding-site-origin>
```

`origin` is the website the iframe is embedded on (taken from the referrer),
so you can lock a token to one or more domains.

### Response contract

**Success — HTTP 200:**

```json
{
  "ok": true,
  "va":   { "code": "Air Canada Virtual", "name": "Air Canada Virtual", "logo": "https://…/logo.png" },
  "callsignPrefixes": ["Air Canada"],
  "callsignSuffixes": ["VA"],
  "regularCallsigns": ["OCEAN STAFF", "Shamrock"],
  "hubs": ["CYYZ", "CYUL", "CYVR"],
  "mode": "map",
  "provider": "mapbox",
  "mapboxToken": "pk.eyJ…",
  "mapStyle": "mapbox://styles/mapbox/dark-v11",
  "freeStyle": "dark",
  "theme": "dark",
  "brandColor": "#1d4ed8",
  "servers": ["Expert"],

  "header": "off",             // hide the header bar
  "headerPos": "left",         // top | bottom | left | right
  "accent": "#0ea5e9,#8b5cf6", // string, CSV, or array — 2+ = gradient
  "gradient": "auto",          // "off" = flat single colour
  "gradientAngle": 120,        // degrees
  "compact": true,
  "radius": 14,                // corner radius px 0–32; omit = widget default

  "vaAdId": "5f…a001",         // the VA-Ads id — lets the events widget fetch events (see §6)
  "events": "on",             // "on" if the VA opted into the events companion widget
  "eventsTemplate": 1,         // 1–10 layout preset for the events widget (see §6)

  "card": {                    // flight-card styling (map mode) — see §1.2
    "opacity": 0.6,            //   0–1 or 0–100; <0.9 auto-frosts the map
    "color": "#0b1220",        //   hex, rgb(), or a colour name
    "text": "white",
    "blur": 14                 //   backdrop blur px 0–40; omit = auto
  }
}
```

`accent` supersedes `brandColor` (the widget's legacy single header colour) and
accepts a plain string, a CSV string, or an array of up to three hex stops.
When you serve `accent`, keep mirroring its first stop into `brandColor` so
older cached widget builds still get a header colour — the built-in resolver
does this automatically.

`hubs` also accepts the alternate keys `icao` or `hub`. Prefixes are full airline
names (case preserved); suffixes are tags; `regularCallsigns` (alias `callsigns`)
are untagged, prefix-only, always-included names (see §2).

`card` is optional and cosmetic (see §1.2). Serve it as a nested object, or use
the flat aliases `cardColor`/`cardBg`, `cardText`/`textColor`,
`cardOpacity`/`opacity`, `cardBlur`. Colours accept hex, `rgb()`, or a name.

Every field except `va.code` is optional and falls back to a sensible default.
Omit `mapboxToken` (or set `provider:"free"`) to serve the free map.

**Failure — return the right status so the widget shows a clear message:**

| Status        | Meaning shown to the user                              |
|---------------|--------------------------------------------------------|
| `401` / `403` | "invalid or not allowed on this site"                  |
| `404` / `410` | "expired or been revoked"                              |
| other / 5xx   | "couldn't reach the embed service"                     |

You may also return `200 { "ok": false, "error": "…" }` for a soft failure.

### CORS

The widget runs in the VA's browser on *their* domain, so the resolve endpoint
**must send CORS headers**:

```
Access-Control-Allow-Origin: *
```

(or echo back the request `Origin` if you prefer to restrict it).

> The same applies to the live-data endpoints the widget already calls
> (`/flights/*`, `/api/flights/*/history`, `/if-sessions`, `/api/va-ads`,
> `/api/aircraft/lookup`). They must allow cross-origin GETs from the VA's site.

### Copy-paste Express implementation

```js
// routes/embedResolve.js
const express = require('express');
const router = express.Router();

// Your VA embed configs, keyed by opaque token. Store these in a DB in prod.
// Generate tokens with e.g. crypto.randomUUID() or crypto.randomBytes(16).hex.
const EMBED_CONFIGS = {
  'tok_aircanada_a1b2c3': {
    va: { code: 'Air Canada Virtual', name: 'Air Canada Virtual', logo: 'https://cdn.example.com/acav.png' },
    callsignPrefixes: ['Air Canada'], // full airline name(s), case preserved
    callsignSuffixes: ['VA'],
    regularCallsigns: ['OCEAN STAFF'], // untagged, prefix-only, always included
    hubs: ['CYYZ', 'CYUL', 'CYVR'],   // hub ICAOs → markers + inbound pilots
    mode: 'map',
    provider: 'mapbox',
    mapboxToken: 'pk.eyJ...the-vas-own-token...',
    mapStyle: 'mapbox://styles/mapbox/dark-v11',
    theme: 'dark',
    brandColor: '#1d4ed8',            // legacy single header colour (see accent)
    servers: ['Expert'],
    // Header & appearance customization (all optional — see §1.1)
    header: 'on',                     // 'off' hides the bar (Powered-by floats as a pill)
    headerPos: 'top',                 // top | bottom | left | right
    accent: ['#0ea5e9', '#8b5cf6'],   // up to 3 stops; 2+ = gradient; empty = sample the logo
    gradient: 'auto',                 // 'off' = flat single colour
    gradientAngle: 120,               // degrees
    compact: false,                   // slimmer header
    radius: 14,                       // corner radius px 0–32; omit = widget default
    // Flight-card styling (map mode, all optional — see §1.2)
    card: { opacity: 0.6, color: '#0b1220', text: 'white', blur: 14 },
    // Optional allow-list of sites that may embed this token. Empty/undefined = any.
    allowedOrigins: ['https://oceanva.org', 'https://www.oceanva.org'],
    revoked: false,
    expiresAt: null, // e.g. '2026-12-31T00:00:00Z'
  },
};

router.get('/api/embed/resolve', (req, res) => {
  // CORS — the widget calls this from the VA's domain.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');

  const token = String(req.query.token || '');
  const origin = String(req.query.origin || '');

  const cfg = EMBED_CONFIGS[token];
  if (!cfg)            return res.status(404).json({ ok: false, error: 'unknown token' });
  if (cfg.revoked)     return res.status(410).json({ ok: false, error: 'revoked' });
  if (cfg.expiresAt && Date.now() > Date.parse(cfg.expiresAt))
                       return res.status(410).json({ ok: false, error: 'expired' });

  // Optional per-token origin lock.
  if (Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.length &&
      origin && !cfg.allowedOrigins.includes(origin)) {
    return res.status(403).json({ ok: false, error: 'origin not allowed' });
  }

  return res.json({
    ok: true,
    va: cfg.va,
    callsignPrefixes: cfg.callsignPrefixes || [cfg.va.code],
    callsignSuffixes: cfg.callsignSuffixes || [],
    regularCallsigns: cfg.regularCallsigns || [],
    hubs: cfg.hubs || [],
    mode: cfg.mode || 'roster',
    provider: cfg.provider || (cfg.mapboxToken ? 'mapbox' : 'free'),
    mapboxToken: cfg.mapboxToken || '',
    mapStyle: cfg.mapStyle || 'mapbox://styles/mapbox/dark-v11',
    freeStyle: cfg.freeStyle || 'dark',
    theme: cfg.theme || 'dark',
    // Legacy single colour — mirror accent's first stop for older widget builds.
    brandColor: cfg.brandColor || (Array.isArray(cfg.accent) ? cfg.accent[0] : '') || '',
    servers: cfg.servers || [],
    // Header & appearance customization (§1.1)
    header: cfg.header || 'on',
    headerPos: cfg.headerPos || 'top',
    accent: Array.isArray(cfg.accent) ? cfg.accent.join(',') : (cfg.accent || ''),
    gradient: cfg.gradient || 'auto',
    gradientAngle: cfg.gradientAngle == null ? 120 : cfg.gradientAngle,
    compact: !!cfg.compact,
    ...(cfg.radius == null ? {} : { radius: cfg.radius }),
    // Flight-card styling (map mode) — serve only when set (see §1.2).
    ...(cfg.card && Object.keys(cfg.card).length ? { card: cfg.card } : {}),
  });
});

module.exports = router;
```

### The iframe you hand the VA (token version)

```html
<iframe
  src="https://inflight.info/embed.html?token=tok_ocean_a1b2c3"
  style="width:100%;height:520px;border:0;border-radius:12px;overflow:hidden"
  loading="lazy"
  title="Ocean Virtual — Live Flights">
</iframe>
```

When a `token` is present it always wins; any other URL params are ignored.

---

## 4. Map data endpoints (gates + airport)

The map-mode features (gates-by-terminal list, gate-occupant usernames, the
flight card's "Departed Gate X", the airport-window aerial hero + hub pins +
on-map runway/taxiway layout) call two more backend endpoints. Both are the same
ones the main tracker uses, and both must be CORS-open to the embed origin (the
built-in resolver serves `Access-Control-Allow-Origin: *` globally).

### `GET /api/gates/{ICAO}`  — gate features

Powers the airport-window "Gates by terminal" list, gate-occupant usernames, and
the flight card's "Departed Gate X". Returns an **array** (or
`{ "gates": [ … ] }`). Each gate object — any one of the listed field aliases
works:

```jsonc
{
  "name":      "A12",          // or "ident" / "gateName" / "id"  (the label)
  "latitude":  40.6413,        // or "lat" / "location.lat"  / "location.latitude"
  "longitude": -73.7781,       // or "lon" / "location.lon"  / "location.longitude"
  "terminal":  "A"             // OPTIONAL. or "concourse" / "pier". If omitted the
                               //   terminal is inferred from the gate-name prefix
                               //   ("A12" → Terminal A; numeric-only → "Gates").
}
```

Latitude/longitude are **required per gate** for occupant + departure-gate
matching.

### `GET /api/airport/{ICAO}`  — airport coordinates

The airport window's aerial hero, hub pins and on-map runway/taxiway layout all
need the field's coordinates:

```jsonc
{ "latitude": 40.63, "longitude": -73.77, "name": "…", "elevation": 13 }
```

Aliases `lat`/`lon` are also accepted. Runways/taxiways, takeoff/landing pins
and the aerial image itself are fully client-side (OSM + Esri imagery) and need
**no** backend work beyond these coordinates.

---

## 5. Distribution checklist

1. Create a config entry for the VA (code, name, logo, prefixes/suffixes,
   Mapbox token or free provider, allowed origins). Tip: in the staff embed
   manager, use **Connect to a VA** at the top of the form to search the VA
   directory and auto-fill the code, name, logo and callsign — no need to type
   them by hand.
2. Generate an opaque token and store it against that config.
3. Send the VA the **iframe snippet** with their token.
4. (Optional) Lock the token to their domain via `allowedOrigins`.
5. To turn a VA off, set `revoked: true` (or delete the entry) — the widget
   immediately shows "expired or revoked".

---

## 6. Events + Calendar companion widget

Alongside the live map, a VA can surface an **Events + Calendar** widget. Unlike
the map embed (which is fronted by the Netlify site at `inflight.info`), this
widget is served **directly by this backend**, so its URL points at the backend's
own public origin (configurable via `EMBED_EVENTS_BASE_URL`):

```
https://<backend-host>/embed-events.html
```

Serving it from the backend means its relative `/api/embed/resolve`,
`/api/public/va/:id/events` and `/assets/…` calls resolve straight to the
backend — no Netlify forwarding rule needed for the new path.

It renders the VA's upcoming events (a month calendar + an upcoming list) and
styles itself with the **same** appearance the map embed uses (accent, theme,
gradient, radius, header) so the two sit together and match. It's the VA's
choice — off by default; the VA turns it on from their portal (Embed tab →
Customize → *Events + calendar*), or staff enable it in the embed manager.

### Driving it (same two ways as the map widget)

1. **Token** — `?token=…`. The widget calls `/api/embed/resolve`, reads the
   appearance, the chosen template, and `vaAdId`, then fetches the events from
   the public endpoint below. This is what you distribute:

   ```html
   <iframe
     src="https://<backend-host>/embed-events.html?token=THE_SAME_TOKEN"
     style="width:100%;height:720px;border:0;border-radius:16px;overflow:hidden"
     loading="lazy" title="Ocean Virtual — Events & Calendar"></iframe>
   ```

   The events widget reuses the **same token** as the map embed — one token
   drives both.

2. **Preview** — no token. Pass everything on the URL:

   ```
   embed-events.html?va=<vaAdId>&template=3&theme=dark&accent=%230ea5e9,%238b5cf6&name=Ocean%20Virtual&logo=…
   ```

### Extra URL / resolve fields

| Param / field    | Example        | Notes |
|------------------|----------------|-------|
| `va` / `vaAdId`  | `5f…a001`      | **Required in preview.** The VA-Ads id (the same id `GET /api/va-ads` returns). Token mode gets it from `resolve`. |
| `template`       | `1`–`10`       | Layout preset (see below). A `?template=` query always overrides the resolved `eventsTemplate`. |
| `events`         | `on` / `off`   | Resolve-only: whether the VA opted in. |

It also honours `theme`, `accent`/`color`, `gradient`, `angle`, `radius`,
`header`, `compact`, `name`, `logo` exactly like the map widget.

**Live preview / overrides:** in **token** mode these same params, when present
on the URL, are layered *on top of* the resolved config. A distributed link
(`?token=…` only) is unaffected, but the portal and staff embed managers append
them so their in-editor preview reflects unsaved template/appearance edits
without having to save first.

### Templates

Ten presets vary size, layout, and which elements show (banners / logos /
country flags derived from the departure ICAO):

| # | Name | Size | Layout | Banners | Logo | Flags |
|---|------|------|--------|---------|------|-------|
| 1 | Classic | md | calendar + list | ✅ | ✅ | — |
| 2 | Compact list | sm | list | — | ✅ | — |
| 3 | Big banners | lg | list | ✅ | ✅ | ✅ |
| 4 | Calendar focus | lg | calendar | — | ✅ | ✅ |
| 5 | Minimal | sm | list | — | — | — |
| 6 | Card grid | md | grid | ✅ | ✅ | ✅ |
| 7 | Rail | sm | list | — | ✅ | ✅ |
| 8 | Wide board | lg | calendar + list side-by-side | ✅ | ✅ | ✅ |
| 9 | Flags & logos | md | calendar + list | — | ✅ | ✅ |
| 10 | Poster | lg | featured hero + list | ✅ | ✅ | ✅ |

### Events data source (public, no auth)

The widget reads events from the existing public endpoint:

```
GET /api/public/va/<vaAdId>/events
→ { va:{id,name}, events:[ { id, title, description, link, departureIcao, bannerUrl, startsAt, createdAt } ] }
```

Upcoming = anything starting later than 12h ago, soonest first (max 50),
cacheable 60s. Events (with their optional banner + departure ICAO) are created
by the VA in the portal's **Events** tab. `bannerUrl` is always a `.webp`;
animated uploads (GIF / animated WebP) are preserved as **animated WebP**, so a
banner may move — the widget renders it in a plain `<img>`, which plays it.

---

## Partner aircraft submission API

Our front-end site can submit community aircraft photos without a staff session.
Submissions do **not** write to the database directly — each photo is optimized,
stored in S3, and posted into the **same Discord admin review flow** that pilot
DM submissions use. Staff approve or reject it there with the existing
Approve / Replace / Reject buttons, and only an **approval** creates the record.
A **rejection** deletes the stored S3 object so nothing is orphaned.

### Endpoint

```
POST /api/community/aircraft/submit
Content-Type: multipart/form-data
```

CORS is open (`Access-Control-Allow-Origin: *`), so the site can call it directly
from the browser. Access is gated by the request's **Origin** — no shared secret:
the allow-list is `COMMUNITY_SUBMIT_ORIGINS` (comma-separated, defaults to
`https://inflight.info` plus `PUBLIC_BASE_URL`; `*` accepts any origin). A request
whose Origin/Referer isn't allow-listed gets `403`. Because a browser sets the
Origin header and page JS can't forge it, this trusts submissions from our own
site without a token.

### Fields (multipart form)

| Field | Required | Notes |
|-------|----------|-------|
| `images` | ✅ (1–3) | The photo file(s). A single legacy `image` field is also accepted. |
| `aircraftType` *(or `model`)* | ✅ | e.g. `A320neo`. |
| `liveryName` *(or `livery`)* | ✅ | e.g. `IndiGo`. |
| `tailNumber` *(or `registration`)* | — | Optional; staff can set it during review. |
| `collaboratorId` | — | The collaborator's **Discord user id** if the partner site has a linked account. When present, credit + the contributor role + the leaderboard all work natively. |
| `collaboratorName` *(or `collaborator`)* | — | Display name to credit when there's no linked Discord id. Defaults to `Anonymous`. |
| `sourceSite` | — | Free-text label for where the submission came from (shown on the review card). Falls back to the request `Origin`. |

The **collaborator** is taken from the submitting site's identity rather than a
Discord DM author: pass `collaboratorId` when the user has linked Discord,
otherwise pass `collaboratorName`.

### Responses

| Status | Meaning |
|--------|---------|
| `202 Accepted` | `{ message, images }` — routed to review. |
| `400` | Missing image or required type/livery. |
| `403` | Origin not on the `COMMUNITY_SUBMIT_ORIGINS` allow-list. |
| `503` | Discord bot not ready — retry shortly. |

### Example

```bash
curl -X POST https://<backend>/api/community/aircraft/submit \
  -H "Origin: https://inflight.info" \
  -F "aircraftType=A320neo" \
  -F "liveryName=IndiGo" \
  -F "tailNumber=VT-IZA" \
  -F "collaboratorId=123456789012345678" \
  -F "collaboratorName=SkySpotter" \
  -F "sourceSite=partner-gallery" \
  -F "images=@/path/to/photo.jpg"
```

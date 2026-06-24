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
| `hubs`       | `CYYZ,CYUL,CYVR`                          | Hub ICAOs. Each becomes a map marker listing your inbound pilots. |
| `provider`   | `mapbox` or `free`                        | Auto: `free` when no Mapbox token. |
| `mapboxToken`| `pk.eyJ…`                                 | The VA's own Mapbox token (mapbox provider only). |
| `mapStyle`   | `mapbox://styles/mapbox/dark-v11`         | Mapbox style URL (mapbox provider). |
| `freeStyle`  | `dark` \| `liberty` \| `bright` \| `positron` \| URL | Free style (free provider). Defaults to `dark`. |
| `theme`      | `dark` or `light`                         | UI chrome theme. |
| `servers`    | `Expert`                                  | IF session names to scan (substring match). Empty = all. |

> **Free vs Mapbox:** if you don't pass a `mapboxToken`, the map automatically
> uses the free, key-less OpenFreeMap source (flat map). Pass a token to get the
> Mapbox globe.

---

## 2. Callsign matching (important)

A flight counts as yours only when it matches the **full airline name** you fly
under — and, *if* you use a tag, also carries that tag. This stops the embed from
grabbing every callsign that merely ends in a common tag like `VA`.

- **Prefix rule** — `prefixes` are the *complete* airline name, e.g.
  `"Air Canada"` (not the ICAO code `ACA`). `"Air Canada"` matches
  `Air Canada 001VA` and **only** Air Canada — never Air France or AirAsia.
- **Suffix rule** — `suffixes` are your tag(s), e.g. `"VA"`, `"EX"`. A bare tag
  never matches on its own.

Combining them:

- `prefixes` only → matches any callsign starting with that full airline name.
- `prefixes` + `suffixes` → must match the airline **and** carry the tag.

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
  "hubs": ["CYYZ", "CYUL", "CYVR"],
  "mode": "map",
  "provider": "mapbox",
  "mapboxToken": "pk.eyJ…",
  "mapStyle": "mapbox://styles/mapbox/dark-v11",
  "freeStyle": "dark",
  "theme": "dark",
  "servers": ["Expert"]
}
```

`hubs` also accepts the alternate keys `icao` or `hub`. Prefixes are full airline
names (case preserved); suffixes are tags.

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
    hubs: ['CYYZ', 'CYUL', 'CYVR'],   // hub ICAOs → markers + inbound pilots
    mode: 'map',
    provider: 'mapbox',
    mapboxToken: 'pk.eyJ...the-vas-own-token...',
    mapStyle: 'mapbox://styles/mapbox/dark-v11',
    theme: 'dark',
    servers: ['Expert'],
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
    hubs: cfg.hubs || [],
    mode: cfg.mode || 'roster',
    provider: cfg.provider || (cfg.mapboxToken ? 'mapbox' : 'free'),
    mapboxToken: cfg.mapboxToken || '',
    mapStyle: cfg.mapStyle || 'mapbox://styles/mapbox/dark-v11',
    freeStyle: cfg.freeStyle || 'dark',
    theme: cfg.theme || 'dark',
    servers: cfg.servers || [],
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

## 4. Distribution checklist

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

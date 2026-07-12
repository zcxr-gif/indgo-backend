# Live Aircraft Images — Backend Guide

This backend owns the **images**. Your other (IF / ACARS) backend owns the
**live flights**. This guide is the contract between them: given a flight's
aircraft **type** and **livery** (as they come out of Infinite Flight), these
endpoints return the best available photo.

## Where the images come from

Two sources are searched together, best match wins:

1. **Community uploads** — the `CommunityAircraft` collection (photos people
   upload through the site/bot, hosted on S3). Curated, so it wins ties.
2. **Static registry** — `aircraft.json`, ~1,000 curated aircraft renders keyed
   by manufacturer / model / livery / registration.

Matching is fuzzy (exact → substring → Levenshtein similarity), the same scoring
the Discord bot uses, so IF's slightly-different type/livery strings still land
on the right photo.

> **Give it the resolved names, not ICAO codes.** IF's live API exposes
> human-readable names once you resolve a flight through the aircraft/livery
> endpoints (e.g. `Airbus A321neo`, `Air Canada`), and that's what matches.
> Raw codes like `A21N` won't match — resolve them first (your backend already
> does this to show type/livery).

---

## Endpoint 1 — one flight

```
GET /api/aircraft/image?type=<type>&livery=<livery>&tail=<registration?>
```

| Query | Required | Notes |
|-------|----------|-------|
| `type`  | yes* | Aircraft type/model. Alias: `model`. |
| `livery`| yes* | Livery / airline name. Alias: `liveryName`. |
| `tail`  | no   | Registration. Alias: `registration`. An exact tail hit in the community DB short-circuits to that photo. |

\* `type` + `livery` are required to fuzzy-match. `tail` alone can still hit an
exact community upload.

**Example**

```
GET /api/aircraft/image?type=Airbus%20A220-300&livery=Air%20Canada
```

```json
{
  "ok": true,
  "found": true,
  "imageUrl": "https://…/Airbus-A220-300-Air-Canada.png",
  "imageUrls": ["https://…/Airbus-A220-300-Air-Canada.png"],
  "aircraftType": "Airbus A220-300",
  "liveryName": "Air Canada",
  "registration": "C-GNAM",
  "source": "registry",     // "community" | "registry" | "none"
  "matchScore": 80,
  "isPlaceholder": false
}
```

When nothing clears the confidence floor you get `found: false`,
`isPlaceholder: true`, `imageUrl: null` — render your own fallback silhouette.

Successful matches send `Cache-Control: public, max-age=300`; placeholders are
`no-store`.

---

## Endpoint 2 — a whole live board (batch)

A live server can have hundreds of flights. Resolve them all in one round-trip:

```
POST /api/aircraft/images/batch
Content-Type: application/json

{
  "flights": [
    { "id": "abc123", "type": "Airbus A220-300", "livery": "Air Canada" },
    { "id": "def456", "type": "Boeing 777-300ER", "livery": "Emirates", "tail": "A6-EPH" }
  ]
}
```

Each flight accepts `type`/`model`/`aircraftType`, `livery`/`liveryName`, and
`tail`/`registration`/`tailNumber`. Give each flight an `id` (the IF flight id
is ideal) so you can line results back up; without one the array index is used.

**Response** — keyed by `id` (or index). Identical type/livery/tail triples are
de-duped internally, so a server full of the same jet costs one lookup:

```json
{
  "ok": true,
  "count": 2,
  "results": {
    "abc123": { "imageUrl": "https://…", "source": "registry",  "matchScore": 80, "isPlaceholder": false, "...": "…" },
    "def456": { "imageUrl": "https://…", "source": "community", "matchScore": 100, "isPlaceholder": false, "...": "…" }
  }
}
```

Max 500 flights per request (`413` over that).

---

## Wiring it into your IF backend

For each live flight you already have `type` and `livery`. Two options:

- **Per flight (simplest):** call `GET /api/aircraft/image` and attach
  `imageUrl` to the flight object you send to your frontend.
- **Per poll (recommended for live maps/boards):** collect the whole flight
  list and `POST /api/aircraft/images/batch` once, then merge `results[id]`
  back onto each flight.

Minimal batch example:

```js
const base = 'https://<this-backend>';        // e.g. inflight.info API host
const flights = liveFlights.map(f => ({ id: f.flightId, type: f.aircraft, livery: f.livery }));

const { data } = await axios.post(`${base}/api/aircraft/images/batch`, { flights });
for (const f of liveFlights) {
  const img = data.results[f.flightId];
  f.imageUrl = img && !img.isPlaceholder ? img.imageUrl : null;
}
```

CORS is open (`Access-Control-Allow-Origin: *`), so a browser widget can also
call these directly if you'd rather resolve images client-side.

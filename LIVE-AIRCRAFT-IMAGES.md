# Live Aircraft Images — Backend Guide

This backend owns the **images**. Your other (IF / ACARS) backend owns the
**live flights**. This guide is the contract between them: given a flight's
aircraft **type** and **livery** (as they come out of Infinite Flight), these
endpoints return the best available photo.

## Where the images come from

Three sources, in priority order — the first that matches wins:

0. **The pilot's own live photo** — an ephemeral shot the pilot uploaded for
   *this specific flight* (see [Live per-flight uploads](#live-per-flight-uploads-ephemeral)).
   Beats everything; disappears when the flight ends.
1. **Community uploads** — the `CommunityAircraft` collection (photos people
   upload through the site/bot, hosted on S3). Curated, so it wins ties.
2. **Static registry** — `aircraft.json`, ~1,000 curated aircraft renders keyed
   by manufacturer / model / livery / registration.

Sources 1–2 are matched by type+livery; source 0 is matched by flight id.

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
| `flightId`| no | IF flight id. If the pilot uploaded a live photo for this flight, it's returned (`source: "live"`) ahead of any library match. Alias: `id`. |

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
`tail`/`registration`/`tailNumber`. Give each flight an `id` (**use the IF flight
id**) so you can line results back up — and because that same `id` is what
matches a pilot's live photo for the flight. Without an `id` the array index is
used and live photos can't be matched.

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

## Live per-flight uploads (ephemeral)

Lets a pilot upload a photo of the aircraft they're flying **right now**. It
shows on that flight only, overrides the library match, and is deleted once the
flight ends. Stored under the `live-flights/` S3 prefix, tracked in the
`LiveFlightImage` collection.

### Upload

```
POST /api/aircraft/live-image          (multipart/form-data)
```

| Field | Required | Notes |
|-------|----------|-------|
| `flightId` | yes | The IF flight id. One photo per flight — re-uploading replaces the old one (old S3 object deleted). |
| `image`    | yes | The photo file. Re-encoded to WebP, max 1600px wide. |
| `aircraftType`, `liveryName`, `tailNumber`, `callsign`, `pilotName` | no | Optional context stored alongside (handy for the board / moderation). |

Response: `{ "ok": true, "flightId": "...", "imageUrl": "https://…", "expiresAt": "..." }`

**Auth:** if `LIVE_IMAGE_UPLOAD_TOKEN` is set in this backend's env, every upload
and delete must present it — header `x-upload-token: <token>` (or `token` in the
body/query). If it's unset, the endpoints are open and you rely on your front
end to show the upload button only to the signed-in pilot on their own flight.

### How deletion works ("delete right after the end")

You don't have to detect flight-end yourself. Each time a flight's image is
resolved (your per-poll `batch` call), its expiry is pushed out by
`LIVE_IMAGE_TTL_MS` (default 15 min). So:

- **While the flight is live** → you keep polling it → expiry keeps moving → the
  photo stays.
- **Flight ends** → you stop polling it → expiry lapses → a sweeper
  (every `LIVE_IMAGE_SWEEP_MS`, default 5 min) deletes the S3 object **and** the
  row. Nothing is orphaned.

Want it gone the instant the flight drops off your tracker? Call:

```
DELETE /api/aircraft/live-image/:flightId      (same token rule as upload)
```

You can also fetch one flight's live photo directly (this also keeps it alive):

```
GET /api/aircraft/live-image/:flightId   →  200 {…}  or  404 { found:false }
```

### Front-end upload snippet

On your live-flight UI, show this only to the signed-in pilot viewing their own
flight:

```html
<input type="file" accept="image/*" id="flightPhoto">
```

```js
const IMAGES_API = 'https://<this-backend>';
document.getElementById('flightPhoto').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('flightId', currentFlight.id);   // the IF flight id
  fd.append('image', file);
  fd.append('aircraftType', currentFlight.aircraft);
  fd.append('liveryName', currentFlight.livery);
  fd.append('callsign', currentFlight.callsign);
  fd.append('pilotName', currentFlight.pilotName);
  const res = await fetch(`${IMAGES_API}/api/aircraft/live-image`, {
    method: 'POST',
    // headers: { 'x-upload-token': UPLOAD_TOKEN },  // only if you set the env token
    body: fd,
  });
  const data = await res.json();
  if (data.ok) currentFlight.imageUrl = data.imageUrl; // shows immediately
});
```

Because the batch resolver checks live uploads first, the pilot's photo
automatically appears for everyone else on the next poll — no extra wiring.

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

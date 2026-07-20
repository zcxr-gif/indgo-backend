// routes/mapLoads.js
//
// Mapbox map-load quota guard. The flight tracker (flight.js -> fetchApiKeys)
// calls POST /api/maploads/hit?limit=<n>&pro=<0|1> once per page-session to
// decide whether to render with billed Mapbox GL or the free MapLibre +
// OpenFreeMap engine. This route keeps a running count per calendar month and
// returns whether the ceiling has been reached, so we never bill past Mapbox's
// free web tier (50k map loads/month).
//
// If this endpoint is unreachable the frontend fails open and stays on Mapbox,
// so the counter can never break the map.
const express = require('express');
const router = express.Router();

// In-memory counter. Fine for a single instance; use Redis/DB if the backend
// runs more than one replica so the count is shared (see note below).
const counts = new Map(); // "YYYY-MM" -> number
const DEFAULT_LIMIT = 40000;
const HARD_CAP = 50000; // never let a client push the threshold above the free tier

// Hard override: force the free map on EVERYONE, including Pro users. Toggle it
// with the FORCE_FREE_MAP env var (or wire it to an admin endpoint / DB flag).
function forceFreeMap() {
  return String(process.env.FORCE_FREE_MAP || '').toLowerCase() === 'true';
}

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function handleHit(req, res) {
  // CORS — the tracker calls this from inflight.info (browser).
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');

  const limit = Math.min(
    HARD_CAP,
    Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
  );
  const pro = String(req.query.pro || '') === '1';
  const month = monthKey();
  const current = counts.get(month) || 0;

  // Hard override — stop everyone, Pro included. Not a billed load, don't count.
  if (forceFreeMap()) {
    return res.json({ ok: true, month, count: current, limit, pro, forced: true, useFreeMap: true });
  }

  // At/over the ceiling and NOT Pro: serve the free map, don't count.
  if (current >= limit && !pro) {
    return res.json({ ok: true, month, count: current, limit, pro, forced: false, useFreeMap: true });
  }

  // Otherwise this session uses Mapbox (under the ceiling, or Pro is exempt) —
  // it's a real billed load, so count it.
  const next = current + 1;
  counts.set(month, next);
  return res.json({ ok: true, month, count: next, limit, pro, forced: false, useFreeMap: false });
}

router.post('/api/maploads/hit', handleHit);
router.get('/api/maploads/hit', handleHit); // handy for eyeballing in a browser

// Optional: read-only status without incrementing.
router.get('/api/maploads/status', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  const month = monthKey();
  const count = counts.get(month) || 0;
  const limit = DEFAULT_LIMIT;
  const forced = forceFreeMap();
  // Reflects the non-Pro outcome; Pro users are exempt unless `forced`.
  res.json({ ok: true, month, count, limit, forced, useFreeMap: forced || count >= limit });
});

module.exports = router;

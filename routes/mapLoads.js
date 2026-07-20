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
//
// The switches (force-free-map, monthly limit) are controlled from the Staff
// Hub's /map-usage console via the admin endpoints server.js registers with
// the `admin` helpers exported below. Overrides persist in Mongo so they
// survive restarts, but are cached in memory so the hot /hit path never waits
// on the DB.
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// The counter is kept in memory (the hot /hit path never waits on the DB) and
// write-through persisted to Mongo, one doc per month, so it survives restarts
// and redeploys. Single-instance only: with more than one replica the memory
// caches would race — move the threshold check itself into the DB if that
// ever happens.
const counts = new Map(); // "YYYY-MM" -> number
const DEFAULT_LIMIT = 40000;
const HARD_CAP = 50000; // never let a client push the threshold above the free tier

const MapLoadCounterSchema = new mongoose.Schema({
    _id: { type: String }, // "YYYY-MM" — old months stay behind as history
    count: { type: Number, default: 0 },
}, { timestamps: true, minimize: false });
const MapLoadCounter = mongoose.models.MapLoadCounter
    || mongoose.model('MapLoadCounter', MapLoadCounterSchema);

// ---------------------------------------------------------------------------
// Admin-adjustable settings (Staff Hub -> /map-usage)
// ---------------------------------------------------------------------------
// forceFreeMap: null = follow the FORCE_FREE_MAP env var; true/false = override.
// limitOverride: null = honour the client's ?limit= (or DEFAULT_LIMIT);
//                a number = pin the ceiling regardless of what clients ask for.
const MapLoadSettingsSchema = new mongoose.Schema({
    _id: { type: String, default: 'maploads' },
    forceFreeMap: { type: Boolean, default: null },
    limitOverride: { type: Number, default: null },
}, { minimize: false });
const MapLoadSettings = mongoose.models.MapLoadSettings
    || mongoose.model('MapLoadSettings', MapLoadSettingsSchema);

let settings = { forceFreeMap: null, limitOverride: null };

// Pull persisted overrides once the DB is up. Best-effort: if Mongo is down the
// guard still runs on env/defaults, same as before the switches existed.
function loadSettings() {
    MapLoadSettings.findById('maploads').lean()
        .then(doc => {
            if (!doc) return;
            settings = {
                forceFreeMap: typeof doc.forceFreeMap === 'boolean' ? doc.forceFreeMap : null,
                limitOverride: Number.isFinite(doc.limitOverride) ? doc.limitOverride : null,
            };
        })
        .catch(err => console.warn('maploads: could not load persisted settings:', err.message));
}
// Bring the persisted count for the current month back into memory. Until this
// completes, hits count in memory only (no DB writes), so the two can't drift;
// the first sync folds any pre-connect hits into the persisted total. On
// RE-connects the in-memory count is authoritative (it kept counting while the
// DB was away), so it's pushed back out instead.
let counterSynced = false;

function persistCount(month, count) {
    if (mongoose.connection.readyState !== 1) return;
    MapLoadCounter.updateOne({ _id: month }, { $set: { count } }, { upsert: true })
        .catch(err => console.warn('maploads: could not persist counter:', err.message));
}

function syncCounter() {
    const month = monthKey();
    if (counterSynced) { persistCount(month, counts.get(month) || 0); return; }
    MapLoadCounter.findById(month).lean()
        .then(doc => {
            const bootHits = counts.get(month) || 0; // counted before the DB was up
            const total = ((doc && doc.count) || 0) + bootHits;
            counts.set(month, total);
            counterSynced = true;
            persistCount(month, total);
        })
        .catch(err => console.warn('maploads: could not load persisted counter:', err.message));
}

// Settings load once (after that, memory is the live truth and every change
// writes through); the counter re-syncs on every (re)connect.
let settingsLoadStarted = false;
function boot() {
    if (!settingsLoadStarted) { settingsLoadStarted = true; loadSettings(); }
    syncCounter();
}
if (mongoose.connection.readyState === 1) boot();
mongoose.connection.on('connected', boot);

function envForceFreeMap() {
    return String(process.env.FORCE_FREE_MAP || '').toLowerCase() === 'true';
}

// Hard override: force the free map on EVERYONE, including Pro users. The env
// var is the baseline; the Staff Hub switch (settings.forceFreeMap) wins when set.
function forceFreeMap() {
    return settings.forceFreeMap === null ? envForceFreeMap() : settings.forceFreeMap;
}

function clampLimit(n) {
    return Math.min(HARD_CAP, Math.max(1, n));
}

// The ceiling for this request: an admin-pinned limit beats whatever the client
// asked for; otherwise the client's ?limit= (or the default) applies as before.
function effectiveLimit(requested) {
    if (settings.limitOverride !== null) return clampLimit(settings.limitOverride);
    return clampLimit(requested || DEFAULT_LIMIT);
}

function monthKey(d = new Date()) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function handleHit(req, res) {
    // CORS — the tracker calls this from inflight.info (browser).
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');

    const limit = effectiveLimit(parseInt(req.query.limit, 10));
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
    // it's a real billed load, so count it. Write-through to Mongo (fire and
    // forget — the response never waits) so the count survives restarts; before
    // the first sync the hit stays memory-only and gets folded in by syncCounter.
    const next = current + 1;
    counts.set(month, next);
    if (counterSynced && mongoose.connection.readyState === 1) {
        MapLoadCounter.updateOne({ _id: month }, { $inc: { count: 1 } }, { upsert: true })
            .catch(err => console.warn('maploads: could not persist counter:', err.message));
    }
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
    const limit = effectiveLimit(null);
    const forced = forceFreeMap();
    // Reflects the non-Pro outcome; Pro users are exempt unless `forced`.
    res.json({ ok: true, month, count, limit, forced, useFreeMap: forced || count >= limit });
});

// ---------------------------------------------------------------------------
// Admin helpers — consumed by server.js under /api/admin/maploads (requireAdmin)
// ---------------------------------------------------------------------------
const admin = {
    // Full picture for the /map-usage console.
    state() {
        const month = monthKey();
        const count = counts.get(month) || 0;
        const limit = effectiveLimit(null);
        const forced = forceFreeMap();
        return {
            ok: true,
            month,
            count,
            limit,
            defaultLimit: DEFAULT_LIMIT,
            hardCap: HARD_CAP,
            limitOverride: settings.limitOverride,
            forceFreeMapOverride: settings.forceFreeMap,
            envForceFreeMap: envForceFreeMap(),
            forced,
            useFreeMap: forced || count >= limit,
        };
    },

    // Apply switch changes. Accepts { forceFreeMap: true|false|null,
    // limit: number|null } — null clears the override back to env/default.
    // Applies to memory immediately and persists best-effort.
    update({ forceFreeMap, limit } = {}) {
        if (forceFreeMap !== undefined) {
            if (forceFreeMap !== null && typeof forceFreeMap !== 'boolean') {
                throw new Error('forceFreeMap must be true, false or null.');
            }
            settings.forceFreeMap = forceFreeMap;
        }
        if (limit !== undefined) {
            if (limit === null) {
                settings.limitOverride = null;
            } else {
                const n = parseInt(limit, 10);
                if (!Number.isFinite(n) || n < 1) throw new Error('limit must be a positive number or null.');
                if (n > HARD_CAP) throw new Error(`limit cannot exceed the ${HARD_CAP.toLocaleString()} free-tier hard cap.`);
                settings.limitOverride = n;
            }
        }
        if (mongoose.connection.readyState === 1) {
            MapLoadSettings.findByIdAndUpdate(
                'maploads',
                { forceFreeMap: settings.forceFreeMap, limitOverride: settings.limitOverride },
                { upsert: true }
            ).catch(err => console.warn('maploads: could not persist settings:', err.message));
        } else {
            console.warn('maploads: DB not connected — settings applied in memory only (lost on restart).');
        }
        return admin.state();
    },

    // Zero the current month's counter (e.g. after a bug inflated it) — in
    // memory and in the persisted doc.
    resetMonth() {
        const month = monthKey();
        counts.delete(month);
        persistCount(month, 0);
        return admin.state();
    },
};

module.exports = router;
module.exports.admin = admin;

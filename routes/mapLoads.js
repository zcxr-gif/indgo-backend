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

// In-memory counter. Fine for a single instance; use Redis/DB if the backend
// runs more than one replica so the count is shared (see note below).
const counts = new Map(); // "YYYY-MM" -> number
const DEFAULT_LIMIT = 40000;
const HARD_CAP = 50000; // never let a client push the threshold above the free tier

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
if (mongoose.connection.readyState === 1) loadSettings();
else mongoose.connection.once('connected', loadSettings);

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

    // Zero the current month's counter (e.g. after a bug inflated it).
    resetMonth() {
        counts.delete(monthKey());
        return admin.state();
    },
};

module.exports = router;
module.exports.admin = admin;

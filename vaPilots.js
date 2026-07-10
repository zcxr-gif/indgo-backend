'use strict';

/*
 * Shared helpers for VA pilot rosters — the list of Infinite Flight usernames a
 * VA hands us for their pilots.
 *
 * Kept as its own module (like vaEventCard.js) so BOTH delivery surfaces treat a
 * roster identically:
 *   - the staff Webhooks Manager API (server.js), and
 *   - the VA self-service portal (vaPortal.js).
 *
 * Two layers live here:
 *   1. Pure parsing/normalization (no DB) — de-dupes and cleans whatever a VA
 *      pastes (a textarea, a CSV dump, a JSON array) into canonical usernames.
 *   2. Thin DB helpers that take the VaPilot mongoose model as their first arg,
 *      so the model can be defined once (server.js) and shared without this
 *      module importing the app's DB wiring.
 *
 * Storage note: usernames are tiny text, so a roster lives comfortably in the
 * existing MongoDB — no separate/metered datastore is needed. We keep the
 * original casing for display and a lowercased key for matching/de-dupe, since
 * IFC usernames are case-insensitive.
 */

const mongoose = require('mongoose');

// A single IFC username can't sensibly be longer than this; clip rather than
// reject so a stray long paste still lands as *something* recognizable.
const MAX_USERNAME_LEN = 80;
// Upper bound on how many usernames one bulk add will accept, so a giant paste
// (or a pasted essay) can't balloon a single request.
const MAX_BULK = 5000;

// Normalize one raw value into { username, usernameLower }, or null when it
// isn't a usable username. Tolerates a pasted leading '@' and surrounding
// whitespace; collapses internal runs of whitespace to single spaces.
const normalizePilotUsername = (raw) => {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    s = s.replace(/^@+/, '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (s.length > MAX_USERNAME_LEN) s = s.slice(0, MAX_USERNAME_LEN).trim();
    return { username: s, usernameLower: s.toLowerCase() };
};

// Parse whatever a VA submits — an array, a JSON-array string, or a free blob
// (textarea paste / CSV) separated by newlines, commas, semicolons or tabs —
// into a de-duplicated list of normalized usernames in first-seen order.
const parsePilotUsernames = (value) => {
    let parts = [];
    if (Array.isArray(value)) {
        parts = value.map((v) => String(v));
    } else {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return [];
        if (raw.startsWith('[')) {
            try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) parts = arr.map((v) => String(v));
            } catch { /* not JSON — fall through to delimiter split */ }
        }
        if (!parts.length) parts = raw.split(/[\n,;\t]+/);
    }
    const seen = new Set();
    const out = [];
    for (const p of parts) {
        const n = normalizePilotUsername(p);
        if (!n || seen.has(n.usernameLower)) continue;
        seen.add(n.usernameLower);
        out.push(n);
        if (out.length >= MAX_BULK) break;
    }
    return out;
};

// --- DB helpers (VaPilot model passed in) -----------------------------------
// Each takes the mongoose model first so this module never touches the app's DB
// connection directly. vaAdId is always an ObjectId (or a value mongoose can
// cast); callers have already authorized access to that VA.

// Count the roster size for one VA.
const countPilots = (VaPilot, vaAdId) => VaPilot.countDocuments({ vaAdId });

// List a VA's roster, newest first, with an optional case-insensitive search on
// the username and simple skip/limit paging. Returns lean rows plus the total.
const listPilots = async (VaPilot, vaAdId, { q = '', limit = 500, skip = 0 } = {}) => {
    const filter = { vaAdId };
    const term = String(q || '').trim();
    if (term) {
        // Escape regex metacharacters — a search box must never be a regex hole.
        filter.usernameLower = { $regex: term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    }
    const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
    const sk = Math.max(0, Number(skip) || 0);
    const [rows, total, rosterTotal] = await Promise.all([
        VaPilot.find(filter).sort({ addedAt: -1, _id: -1 }).skip(sk).limit(lim)
            .select('username addedAt addedBy').lean(),
        VaPilot.countDocuments(filter),
        VaPilot.countDocuments({ vaAdId }),
    ]);
    return {
        total,                       // matches for the current search
        rosterTotal,                 // whole roster, ignoring search
        pilots: rows.map((r) => ({
            id: String(r._id),
            username: r.username,
            addedAt: r.addedAt,
            addedBy: r.addedBy || '',
        })),
    };
};

// Add one or many usernames to a VA's roster. Accepts the same shapes as
// parsePilotUsernames. De-dupes against what's already stored (the unique index
// is the real guard; the pre-check just yields exact added/skipped counts).
// Returns { added, skipped, total }.
const addPilots = async (VaPilot, vaAdId, rawUsernames, addedBy = '') => {
    const parsed = parsePilotUsernames(rawUsernames);
    if (!parsed.length) return { added: 0, skipped: 0, total: await countPilots(VaPilot, vaAdId) };

    const keys = parsed.map((p) => p.usernameLower);
    const existing = new Set(
        (await VaPilot.find({ vaAdId, usernameLower: { $in: keys } }).select('usernameLower').lean())
            .map((d) => d.usernameLower),
    );
    const docs = parsed
        .filter((p) => !existing.has(p.usernameLower))
        .map((p) => ({ vaAdId, username: p.username, usernameLower: p.usernameLower, addedBy: String(addedBy || '').slice(0, 120) }));

    if (docs.length) {
        try {
            // ordered:false so a race that duplicates a key inserts the rest
            // instead of aborting the whole batch.
            await VaPilot.insertMany(docs, { ordered: false });
        } catch (err) {
            // A concurrent add can still trip the unique index (E11000); that's
            // benign — the row is already there. Re-throw anything else.
            if (!(err && (err.code === 11000 || err.writeErrors))) throw err;
        }
    }
    return {
        added: docs.length,
        skipped: parsed.length - docs.length,
        total: await countPilots(VaPilot, vaAdId),
    };
};

// Remove one roster entry by its id, scoped to the VA so one VA can't delete
// another's pilot. Returns { removed, total }.
const removePilot = async (VaPilot, vaAdId, pilotId) => {
    if (!mongoose.Types.ObjectId.isValid(String(pilotId || ''))) {
        return { removed: 0, total: await countPilots(VaPilot, vaAdId) };
    }
    const r = await VaPilot.deleteOne({ _id: pilotId, vaAdId });
    return { removed: r.deletedCount || 0, total: await countPilots(VaPilot, vaAdId) };
};

// Wipe a VA's whole roster. Returns { removed }.
const clearPilots = async (VaPilot, vaAdId) => {
    const r = await VaPilot.deleteMany({ vaAdId });
    return { removed: r.deletedCount || 0 };
};

module.exports = {
    normalizePilotUsername, parsePilotUsernames,
    countPilots, listPilots, addPilots, removePilot, clearPilots,
    MAX_USERNAME_LEN, MAX_BULK,
};

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

// Object keys we treat as "this field holds the username", best first — used
// when a VA hands us an array of objects (JSON export, spreadsheet-as-JSON).
const USERNAME_KEYS = ['username', 'user', 'ifc', 'ifn', 'ign', 'pilot', 'callsign', 'name'];

// A column header (or object key) that marks the username column. Substring
// match so "IFC Username", "Pilot Name", "Display name" all qualify.
const HEADER_RE = /(user\s*name|username|\buser\b|\bifc\b|\bifn\b|\bign\b|pilot|callsign|display\s*name|\bname\b)/i;
// Strict, whole-cell header — used only to drop a lone header line ("username"
// on its own) from an otherwise plain single-column list.
const LONE_HEADER_RE = /^(user\s*names?|usernames?|users?|pilots?|ifc|ifn|ign|callsigns?|display\s*names?|names?)$/i;

// Pull the username out of one object (a row from a JSON/records export),
// preferring the most username-y key. Keys are matched case/space/underscore-
// insensitively so "IFC_Username" and "ifc username" both resolve.
const pickFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    const norm = {};
    for (const k of Object.keys(obj)) norm[k.toLowerCase().replace(/[\s_]+/g, '')] = obj[k];
    for (const key of USERNAME_KEYS) {
        if (norm[key] != null && String(norm[key]).trim()) return String(norm[key]);
    }
    for (const k of Object.keys(norm)) {
        if (/(user|name|ifc|ifn|ign|callsign|pilot)/.test(k) && String(norm[k]).trim()) return String(norm[k]);
    }
    return '';
};

// Quote-aware split of one delimited line (handles "Doe, John" and "" escapes),
// so a comma inside a quoted CSV field doesn't spawn a phantom column.
const splitDelimited = (line, delim) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += ch;
        } else if (ch === '"') { q = true; }
        else if (ch === delim) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
};

// Turn a free-text blob (textarea paste / uploaded CSV/TSV) into a flat list of
// raw username strings. A single line, or multi-line text with no recognizable
// header, is treated as a plain list split on commas/semicolons/tabs — so
// "JohnDoe, Jane_Doe" stays two pilots. Only a genuine multi-column table with
// a header row (e.g. a spreadsheet export) is read column-wise, keeping just the
// username column and dropping the header.
const partsFromBlob = (raw) => {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    if (lines.length === 1) return lines[0].split(/[,;\t]+/);

    const sample = lines.slice(0, 5).join('\n');
    const delim = /\t/.test(sample) ? '\t' : (/;/.test(sample) && !/,/.test(sample) ? ';' : ',');
    const rows = lines.map((l) => splitDelimited(l, delim));
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

    if (maxCols > 1 && rows[0].some((c) => HEADER_RE.test(c))) {
        const header = rows[0];
        const score = (c) => {
            const s = c.toLowerCase().replace(/[\s_]+/g, '');
            if (s.includes('username')) return 6;
            if (s === 'ifc' || s === 'ifn' || s === 'ign') return 5;
            if (s.includes('user')) return 4;
            if (s.includes('pilot')) return 3;
            if (s.includes('callsign')) return 2;
            if (s.includes('name')) return 1;
            return 0;
        };
        let idx = 0;
        let best = -1;
        header.forEach((c, i) => { const sc = score(c); if (sc > best) { best = sc; idx = i; } });
        return rows.slice(1).map((r) => r[idx] || '');
    }
    // Not tabular — a plain list. Drop a lone header line ("username" on its own)
    // before flattening the rest on commas/semicolons/tabs.
    const list = LONE_HEADER_RE.test(lines[0]) ? lines.slice(1) : lines;
    return list.flatMap((l) => l.split(/[,;\t]+/));
};

// Parse whatever a VA submits into a de-duplicated list of normalized usernames
// in first-seen order. Accepts, in order of precedence:
//   - an array (of strings, or of record objects like {username: "..."}),
//   - a JSON string (array of strings/objects, or a single object),
//   - a free blob: a plain list, or a CSV/TSV/semicolon table with a header.
// A UTF-8 BOM (common on Excel exports) is stripped so it can't corrupt the
// first username or header cell.
const parsePilotUsernames = (value) => {
    let parts = [];
    if (Array.isArray(value)) {
        parts = value.map((v) => (v && typeof v === 'object') ? pickFromObject(v) : String(v));
    } else {
        const raw = String(value == null ? '' : value).replace(/^\uFEFF/, '').trim();
        if (!raw) return [];
        if (raw[0] === '[' || raw[0] === '{') {
            try {
                const data = JSON.parse(raw);
                if (Array.isArray(data)) {
                    parts = data.map((v) => (v && typeof v === 'object') ? pickFromObject(v) : String(v));
                } else if (data && typeof data === 'object') {
                    const u = pickFromObject(data);
                    if (u) parts = [u];
                }
            } catch { /* not JSON — fall through to blob parsing */ }
        }
        if (!parts.length) parts = partsFromBlob(raw);
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

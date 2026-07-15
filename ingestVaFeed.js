'use strict';

/*
 * Pure (no DB, no network) normalizers for the OPTIONAL `events` and `pilots` a
 * VA attaches to its feed. Loose in, strict out: a VA's payload is untrusted, so
 * every field is coerced/validated/clipped here and nothing downstream has to
 * second-guess it.
 *
 * The accepted input mirrors the public contract (aliases in parentheses):
 *   events (alias: calendar) — [{
 *     title (name)            required
 *     startsAt (start, date)  required — ISO string OR epoch ms
 *     endsAt (end)            optional — ISO string OR epoch ms
 *     type                    optional — one of EVENT_TYPES, else "other"
 *     route                   optional
 *     server                  optional
 *     description (desc)      optional
 *     link                    optional — http(s) only, else dropped
 *   }]
 *   pilots (aliases: roster, newPilots) — [{
 *     username (name)         required
 *     rank                    optional
 *     joinedAt (joined)       optional — ISO string OR epoch ms
 *     isNew                   optional — else derived from joinedAt at read time
 *   }]
 *
 * Persistence lives in the callers (VaEvent in vaPortal.js, VaPilot roster
 * helpers in vaPilots.js) so this file imports no DB wiring and stays unit
 * -testable in isolation.
 */

const vaPilots = require('./vaPilots');

// The event categories a VA may tag an event with. Kept here as the single
// source of truth so the schema enum (vaPortal.js) and this normalizer agree.
const EVENT_TYPES = ['group-flight', 'training', 'exam', 'social', 'flyout', 'other'];

// Hard caps so one feed post can't balloon a VA's collections. Events also has a
// soft cap enforced at persist time (MAX_EVENTS_PER_VA); this is just an upper
// bound on how much of a single payload we'll even look at.
const MAX_EVENTS = 100;
const MAX_PILOTS = 5000;

// Trim + clip any value to a string (never throws, never returns null).
const clip = (v, max) => {
    const s = String(v == null ? '' : v).trim();
    return s.length > max ? s.slice(0, max).trim() : s;
};

// http(s) URLs only — anything else (javascript:, data:, relative, junk) → ''.
// A bad link would otherwise render on the VA's site and, for Discord posts,
// makes the platform reject the whole embed.
const httpUrl = (v) => {
    try {
        const u = new URL(clip(v, 2048));
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href.slice(0, 300) : '';
    } catch { return ''; }
};

// ISO string OR epoch ms → Date, or null. A numeric value (or all-digit string)
// is treated as epoch milliseconds; everything else goes through Date parsing.
const toDate = (v) => {
    if (v == null || v === '') return null;
    const d = (typeof v === 'number' || /^\d+$/.test(String(v).trim()))
        ? new Date(Number(v))
        : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
};

// First present (non-empty) alias wins.
const pick = (o, ...keys) => {
    if (!o || typeof o !== 'object') return undefined;
    for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
    return undefined;
};

// data.events (alias: calendar) → rows ready to persist as VaEvent. Any item
// missing a required column (title, startsAt) is dropped rather than stored
// half-formed. Returned soonest-first.
function normalizeEvents(data) {
    const raw = pick(data, 'events', 'calendar');
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const e of raw) {
        if (!e || typeof e !== 'object') continue;
        const title = clip(pick(e, 'title', 'name'), 120);
        const startsAt = toDate(pick(e, 'startsAt', 'start', 'date'));
        if (!title || !startsAt) continue;
        const endsAt = toDate(pick(e, 'endsAt', 'end'));
        const typeRaw = clip(e.type, 40).toLowerCase();
        out.push({
            title,
            startsAt,
            endsAt: (endsAt && endsAt.getTime() >= startsAt.getTime()) ? endsAt : null,
            type: EVENT_TYPES.includes(typeRaw) ? typeRaw : 'other',
            route: clip(e.route, 120),
            server: clip(e.server, 60),
            description: clip(pick(e, 'description', 'desc'), 1000),
            link: httpUrl(e.link),
        });
        if (out.length >= MAX_EVENTS) break;
    }
    out.sort((a, b) => a.startsAt - b.startsAt);
    return out;
}

// data.pilots (aliases: roster, newPilots) → rows ready for the roster. Reuses
// vaPilots.normalizePilotUsername for the username cleaning/keying so the feed,
// the staff paste, and the portal paste all canonicalize usernames identically.
// De-dupes case-insensitively (first entry wins). `isNew` is kept only when the
// VA sent an explicit boolean; otherwise it's left null and derived from
// joinedAt at read time (see vaPilots.resolvePilotIsNew).
function normalizePilots(data) {
    const raw = pick(data, 'pilots', 'roster', 'newPilots');
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const p of raw) {
        const rawName = (p && typeof p === 'object') ? pick(p, 'username', 'name') : p;
        const norm = vaPilots.normalizePilotUsername(rawName);
        if (!norm) continue;
        if (seen.has(norm.usernameLower)) continue;
        seen.add(norm.usernameLower);
        const meta = (p && typeof p === 'object') ? p : {};
        out.push({
            username: norm.username,
            usernameLower: norm.usernameLower,
            rank: clip(meta.rank, 60),
            joinedAt: toDate(pick(meta, 'joinedAt', 'joined')),
            isNew: typeof meta.isNew === 'boolean' ? meta.isNew : null,
        });
        if (out.length >= MAX_PILOTS) break;
    }
    return out;
}

module.exports = { EVENT_TYPES, normalizeEvents, normalizePilots, MAX_EVENTS, MAX_PILOTS };

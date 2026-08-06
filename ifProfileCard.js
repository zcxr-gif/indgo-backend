'use strict';

/*
 * ifProfileCard.js — the pilot stats card that lives on an Infinite Flight
 * Community profile.
 *
 * IFC is a Discourse forum, and the only thing a Discourse bio can carry is
 * markdown. So the card is a PNG at a stable URL: the pilot pastes
 * `![](https://…/api/if-card/<slug>.png)` into their About Me and the picture
 * IS the stats block. Nothing to install, nothing to keep in sync by hand.
 *
 * WHAT IT SHOWS IS THE PILOT'S CHOICE. The card carries only the fields they
 * ticked, in the order they ticked them (see FIELDS below for the catalogue).
 * A pilot who only wants grade and landings gets a two-tile card, not a
 * nine-tile card with seven blanks — the layout reflows to the selection
 * rather than reserving space for stats nobody asked for.
 *
 * FREE IS A SNAPSHOT, PRO IS KEPT CURRENT. A free card renders the stats as
 * they stood when it was made and says so on its face ("as of 5 Aug 2026") —
 * honest, and still the thing most pilots want. Pro members can switch on the
 * monthly refresh, and then the numbers re-read themselves from the Infinite
 * Flight API at the turn of each month. That refresh is lazy: it happens on the
 * first request for the image after the month rolls over, so there is no
 * scheduler to run, nothing to back-fill, and a card nobody looks at costs
 * nothing. See refreshDueAt().
 *
 * Rendering is SVG → PNG through sharp, the same path the VA event cards take,
 * and it borrows their font stack (DejaVu is what the container actually has)
 * and their single-slot render queue discipline. The palette is month.html's,
 * so a pilot's card and their monthly report read as one product.
 */

const sharp = require('sharp');
const axios = require('axios');

const ACARS_BACKEND_URL = (process.env.ACARS_BACKEND_URL || 'https://site--acars-backend--6dmjph8ltlhv.code.run').replace(/\/+$/, '');

// The font actually present in the container. Arial/sans-serif are there as the
// usual belt and braces for a machine that has neither.
const FONT = 'DejaVu Sans, Arial, sans-serif';

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const fmtInt = (n) => Number(n).toLocaleString('en-US');

/* ---------------------------------------------------------------------------
 * Themes
 *
 * IFC renders profiles on both a light and a dark forum theme, and a card is a
 * flat PNG that cannot adapt. So the pilot picks. Every theme is a full set —
 * no theme inherits another's colours — because a half-specified palette is how
 * you end up with grey text on a grey tile.
 * ------------------------------------------------------------------------- */
const THEMES = {
    midnight: {
        bg: '#0b0d12', glowA: '#1d4ed8', glowB: '#7c3aed',
        tile: '#12151d', tileLine: 'rgba(255,255,255,0.09)',
        ink: '#f2f4f8', muted: '#8b93a7', faint: '#5d6478',
        accent: '#38bdf8', accentInk: '#04121c',
    },
    aurora: {
        bg: '#0a1120', glowA: '#0891b2', glowB: '#a78bfa',
        tile: '#101a2e', tileLine: 'rgba(148,197,255,0.14)',
        ink: '#eaf2ff', muted: '#8ea6c8', faint: '#5f79ab',
        accent: '#34d399', accentInk: '#03271b',
    },
    carbon: {
        bg: '#0d0d0f', glowA: '#3f3f46', glowB: '#57534e',
        tile: '#17171a', tileLine: 'rgba(255,255,255,0.08)',
        ink: '#f4f4f5', muted: '#8b8b93', faint: '#5c5c64',
        accent: '#fbbf24', accentInk: '#241a02',
    },
    daylight: {
        bg: '#f4f6fa', glowA: '#bfdbfe', glowB: '#ddd6fe',
        tile: '#ffffff', tileLine: 'rgba(15,23,42,0.10)',
        ink: '#0f172a', muted: '#5a6478', faint: '#8a94a6',
        accent: '#2563eb', accentInk: '#ffffff',
    },
};
const THEME_KEYS = Object.keys(THEMES);
const DEFAULT_THEME = 'midnight';

const themeFor = (key) => THEMES[key] || THEMES[DEFAULT_THEME];

/* ---------------------------------------------------------------------------
 * The stat catalogue
 *
 * Every key a pilot can put on their card. `get` returns the display string, or
 * null when the account simply has no such number — a stat the API did not give
 * us is DROPPED from the layout rather than drawn as "—", because a card full
 * of dashes looks broken in a way an absent tile does not.
 * ------------------------------------------------------------------------- */
const FIELDS = {
    // The tile is already captioned GRADE, so the value is the numeral alone —
    // "Grade 5" under a GRADE label just says it twice.
    grade:      { label: 'GRADE',      accent: true, get: (s) => (s.grade == null ? null : String(s.grade)) },
    xp:         { label: 'XP',                       get: (s) => (s.xp == null ? null : fmtInt(s.xp)) },
    hours:      { label: 'FLIGHT TIME',              get: (s) => (s.minutes == null ? null : `${fmtInt(Math.floor(s.minutes / 60))}h`),
                                                     sub: (s) => (s.minutes == null ? null : `${Math.round(s.minutes % 60)}m`) },
    landings:   { label: 'LANDINGS',                 get: (s) => (s.landings == null ? null : fmtInt(s.landings)) },
    flights:    { label: 'ONLINE FLIGHTS',           get: (s) => (s.flights == null ? null : fmtInt(s.flights)) },
    violations: { label: 'VIOLATIONS',               get: (s) => (s.violations == null ? null : fmtInt(s.violations)) },
    atcOps:     { label: 'ATC OPERATIONS',           get: (s) => (s.atcOperations == null ? null : fmtInt(s.atcOperations)) },
    atcRank:    { label: 'ATC RANK',                 get: (s) => s.atcRank || null },
    org:        { label: 'ORGANISATION',             get: (s) => s.virtualOrganization || null },
};
const FIELD_KEYS = Object.keys(FIELDS);
const DEFAULT_FIELDS = ['grade', 'xp', 'landings', 'hours'];
// Nine tiles is already a wall of numbers; past that the card stops being
// glanceable, which is the only thing it is for.
const MAX_FIELDS = 9;

/**
 * The caller's field list, reduced to keys we know, de-duplicated, capped, and
 * left in THEIR order — the pilot chose which stat leads, so we do not sort it
 * back into our own preference. Falls back to a sensible four.
 */
function normalizeFields(input) {
    const raw = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    const out = [];
    for (const item of raw) {
        const key = String(item || '').trim();
        if (FIELDS[key] && !out.includes(key)) out.push(key);
        if (out.length >= MAX_FIELDS) break;
    }
    return out.length ? out : [...DEFAULT_FIELDS];
}

const normalizeTheme = (t) => (THEMES[String(t || '').trim()] ? String(t).trim() : DEFAULT_THEME);

/* ---------------------------------------------------------------------------
 * Reading the account
 * ------------------------------------------------------------------------- */

/**
 * The pilot's Infinite Flight account, by community username.
 *
 * Two calls, because the two endpoints know different things and neither is
 * reliably complete: /users resolves the name and carries the live stat block,
 * /api/users/:id/stats carries the grade detail. Whatever the second one adds
 * is merged over the first; whatever it doesn't, the first already answered.
 *
 * Returns null only when the account cannot be found or the service is down —
 * both of which the caller must treat as "do not overwrite what we already
 * have", never as "this pilot now has zero landings".
 */
async function fetchIfStats(username) {
    const name = String(username || '').trim();
    if (!name) return null;

    let user = null;
    try {
        const lookup = await axios.post(`${ACARS_BACKEND_URL}/users`,
            { discourseNames: [name], userHashes: [name] },
            { timeout: 9000, headers: { 'Content-Type': 'application/json' } });
        user = lookup?.data?.users?.[0] || null;
    } catch (err) {
        console.error('[if-card] user lookup failed:', err?.message || err);
        return null;
    }
    if (!user || !user.userId) return null;

    let detail = {};
    try {
        const resp = await axios.get(
            `${ACARS_BACKEND_URL}/api/users/${encodeURIComponent(user.userId)}/stats`,
            { timeout: 9000 });
        detail = resp?.data?.stats || resp?.data?.gradeInfo || resp?.data || {};
    } catch (_) { /* the lookup block is enough on its own */ }

    const pick = (...vals) => {
        for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
        return null;
    };
    const numOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    // Violations come either pre-summed or split by level, depending on which
    // endpoint answered. Summing the levels is only correct when at least one
    // of them is present — otherwise an account with no violation data would
    // report a confident zero.
    const byLevel = detail?.violationCountByLevel || user?.violationCountByLevel || null;
    const levelSum = byLevel
        ? (Number(byLevel.level1) || 0) + (Number(byLevel.level2) || 0) + (Number(byLevel.level3) || 0)
        : null;

    return {
        userId: String(user.userId),
        username: String(user.discourseUsername || name),
        grade: numOrNull(pick(detail?.gradeDetails?.gradeIndex, detail?.grade, user?.grade)),
        xp: numOrNull(pick(detail?.totalXP, detail?.xp, user?.totalXP, user?.xp)),
        minutes: numOrNull(pick(detail?.flightTime, user?.flightTime)),
        landings: numOrNull(pick(detail?.landingCount, user?.landingCount)),
        flights: numOrNull(pick(detail?.onlineFlights, user?.onlineFlights)),
        violations: numOrNull(pick(detail?.violations, user?.violations, levelSum)),
        atcOperations: numOrNull(pick(detail?.atcOperations, user?.atcOperations)),
        atcRank: pick(detail?.atcRankName, detail?.atcRank, user?.atcRankName, user?.atcRank),
        virtualOrganization: pick(detail?.virtualOrganization, user?.virtualOrganization),
    };
}

/* ---------------------------------------------------------------------------
 * Layout
 * ------------------------------------------------------------------------- */
const WIDTH = 1200;
const PAD = 44;
const HEADER_H = 132;
const TILE_H = 146;
const TILE_GAP = 18;
const FOOTER_H = 66;
// Shared by every value in every tile — see the note at the draw site.
const VALUE_BASELINE = 102;

/**
 * How many tiles per row, for a given number of them.
 *
 * Hand-picked rather than computed: the arithmetic answer (fill each row, remainder
 * on the last) leaves a lonely orphan tile for 5 and 7, which reads as a mistake.
 * These shapes always come out even or top-heavy, which reads as a design.
 */
function columnsFor(n) {
    if (n <= 4) return n;          // 1–4: a single row, tiles as wide as they come
    if (n === 5 || n === 6) return 3;
    if (n === 7 || n === 8) return 4;
    return 3;                       // 9: a clean 3×3
}

/**
 * A value's font size, stepped down as the string gets longer.
 *
 * "Grade 3" and "1,204,880" want very different sizes, and a virtual
 * organisation name can be longer than both. Measuring properly would mean
 * shipping font metrics; stepping on character count gets the same result for
 * the strings this card can actually hold.
 */
function valueFontSize(text, tileW) {
    const len = String(text).length;
    const roomy = tileW >= 260;
    if (len <= 6) return roomy ? 54 : 46;
    if (len <= 9) return roomy ? 46 : 38;
    if (len <= 13) return roomy ? 36 : 30;
    if (len <= 20) return 26;
    return 21;
}

/** Long single-line strings get an ellipsis rather than overrunning the tile. */
function clamp(text, max) {
    const s = String(text);
    return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

const STAMP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (d) => {
    const dt = (d instanceof Date && !Number.isNaN(d.getTime())) ? d : new Date();
    return `${dt.getUTCDate()} ${STAMP_MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
};

/**
 * The card, as a PNG buffer.
 *
 * @param {object}   card
 * @param {object}   card.stats     a block from fetchIfStats
 * @param {string[]} card.fields    which stats to draw, in order
 * @param {string}   card.theme     palette key
 * @param {boolean}  card.pro       drives the "updated monthly" footer line
 * @param {Date}     card.statsAt   when the numbers were read
 */
async function renderIfProfileCardImpl({ stats, fields, theme, pro, statsAt } = {}) {
    const s = stats || {};
    const pal = themeFor(normalizeTheme(theme));
    const keys = normalizeFields(fields);

    // Resolve to drawable tiles first: the grid is sized from what SURVIVES,
    // not from what was asked for, so a missing stat costs no empty square.
    const tiles = [];
    for (const key of keys) {
        const spec = FIELDS[key];
        const value = spec.get(s);
        if (value == null || value === '') continue;
        tiles.push({
            label: spec.label,
            value: String(value),
            sub: spec.sub ? spec.sub(s) : null,
            accent: !!spec.accent,
        });
    }
    // Nothing resolved (a brand-new account, or a stats block we failed to
    // read) still has to produce a picture — a broken image on someone's
    // profile is the one outcome worth avoiding at any cost.
    if (!tiles.length) {
        tiles.push({ label: 'INFINITE FLIGHT', value: 'No stats yet', sub: null, accent: false });
    }

    const cols = columnsFor(tiles.length);
    const rows = Math.ceil(tiles.length / cols);
    const gridW = WIDTH - PAD * 2;
    const tileW = Math.floor((gridW - TILE_GAP * (cols - 1)) / cols);
    const height = HEADER_H + rows * TILE_H + (rows - 1) * TILE_GAP + FOOTER_H + PAD;

    const parts = [];

    // --- Background: flat fill, then two soft colour fields. The same ambient
    // wash month.html drifts behind the report, held still. ---
    parts.push(`<rect width="${WIDTH}" height="${height}" fill="${pal.bg}"/>`);
    parts.push(`
        <g opacity="0.34">
          <circle cx="120" cy="40" r="330" fill="url(#glowA)"/>
          <circle cx="${WIDTH - 90}" cy="${height - 40}" r="300" fill="url(#glowB)"/>
        </g>`);

    // --- Header: who this is, and whose product it is ---
    const handle = clamp(s.username || 'Unknown pilot', 26);
    parts.push(`
        <text x="${PAD}" y="${52}" font-family="${FONT}" font-size="17" font-weight="bold"
              letter-spacing="3.4" fill="${pal.faint}">INFLIGHT</text>
        <text x="${PAD}" y="${104}" font-family="${FONT}" font-size="44" font-weight="bold"
              fill="${pal.ink}">${esc(handle)}</text>`);

    // Grade rides in the top-right as a pill whenever the pilot did not already
    // put it in the grid — it is the one number every IFC reader looks for, and
    // duplicating it would just spend a tile.
    if (s.grade != null && !keys.includes('grade')) {
        const txt = `GRADE ${s.grade}`;
        const pillW = 34 + txt.length * 13;
        parts.push(`
            <rect x="${WIDTH - PAD - pillW}" y="62" width="${pillW}" height="46" rx="23" fill="${pal.accent}"/>
            <text x="${WIDTH - PAD - pillW / 2}" y="92" text-anchor="middle" font-family="${FONT}"
                  font-size="21" font-weight="bold" letter-spacing="1.4" fill="${pal.accentInk}">${esc(txt)}</text>`);
    }

    // --- Tiles ---
    tiles.forEach((tile, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = PAD + col * (tileW + TILE_GAP);
        const y = HEADER_H + row * (TILE_H + TILE_GAP);
        const cx = x + tileW / 2;

        const valueTxt = clamp(tile.value, 24);
        const size = valueFontSize(valueTxt, tileW);
        const valueFill = tile.accent ? pal.accent : pal.ink;

        // Values sit on a FIXED baseline rather than one derived from their own
        // font size. Tiles in a row rarely hold strings of the same length, so
        // a size-relative baseline drops "1,893" and lifts "Officer" by
        // different amounts and the row visibly stops being a row. Sharing the
        // baseline lets each value keep the size its length earned while the
        // line they sit on stays straight.
        parts.push(`
            <rect x="${x}" y="${y}" width="${tileW}" height="${TILE_H}" rx="20"
                  fill="${pal.tile}" stroke="${pal.tileLine}" stroke-width="1.5"/>
            <text x="${cx}" y="${y + 42}" text-anchor="middle" font-family="${FONT}" font-size="14"
                  font-weight="bold" letter-spacing="2.2" fill="${pal.muted}">${esc(clamp(tile.label, 20))}</text>
            <text x="${cx}" y="${y + VALUE_BASELINE}" text-anchor="middle" font-family="${FONT}"
                  font-size="${size}" font-weight="bold" fill="${valueFill}">${esc(valueTxt)}</text>`);

        if (tile.sub) {
            parts.push(`
                <text x="${cx}" y="${y + TILE_H - 18}" text-anchor="middle" font-family="${FONT}"
                      font-size="17" font-weight="bold" fill="${pal.faint}">${esc(clamp(tile.sub, 18))}</text>`);
        }
    });

    // --- Footer: where it came from, and how honest the numbers are ---
    const footY = height - FOOTER_H + 34;
    parts.push(`
        <text x="${PAD}" y="${footY}" font-family="${FONT}" font-size="17" fill="${pal.faint}">
            inflight.info</text>
        <text x="${WIDTH - PAD}" y="${footY}" text-anchor="end" font-family="${FONT}" font-size="17"
              fill="${pal.faint}">${esc(pro ? `Updated monthly · ${stamp(statsAt)}` : `As of ${stamp(statsAt)}`)}</text>`);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
        <defs>
          <radialGradient id="glowA"><stop offset="0%" stop-color="${pal.glowA}" stop-opacity="0.85"/><stop offset="100%" stop-color="${pal.glowA}" stop-opacity="0"/></radialGradient>
          <radialGradient id="glowB"><stop offset="0%" stop-color="${pal.glowB}" stop-opacity="0.85"/><stop offset="100%" stop-color="${pal.glowB}" stop-opacity="0"/></radialGradient>
        </defs>
        ${parts.join('\n')}
    </svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
}

/* ---------------------------------------------------------------------------
 * Render serialization
 *
 * sharp renders allocate large native buffers, and these cards are fetched by
 * whatever Discourse/CDN does when a profile is viewed — bursty, and sharing a
 * container with VA webhook delivery. One at a time, for the reasons written up
 * at length in vaEventCardImage.js.
 * ------------------------------------------------------------------------- */
let renderTail = Promise.resolve();
const renderIfProfileCard = (card) => {
    const result = renderTail.then(() => renderIfProfileCardImpl(card));
    renderTail = result.then(() => {}, () => {});
    return result;
};

/**
 * When a Pro card's numbers next go stale: the first instant of the next UTC
 * month after they were read.
 *
 * Monthly is what was promised and monthly is what this returns — a card read
 * on the 31st refreshes the next day, not thirty days later, because "up to
 * date" to a pilot means "it says August because it is August".
 */
function refreshDueAt(statsAt) {
    const d = (statsAt instanceof Date && !Number.isNaN(statsAt.getTime())) ? statsAt : new Date(0);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/** Is this card due a re-read right now? Free cards never are — that is the split. */
function needsRefresh(card, now = Date.now()) {
    if (!card || !card.pro || !card.autoRefresh) return false;
    return refreshDueAt(card.statsAt).getTime() <= now;
}

module.exports = {
    renderIfProfileCard,
    fetchIfStats,
    normalizeFields,
    normalizeTheme,
    refreshDueAt,
    needsRefresh,
    FIELDS,
    FIELD_KEYS,
    DEFAULT_FIELDS,
    MAX_FIELDS,
    THEME_KEYS,
    DEFAULT_THEME,
};

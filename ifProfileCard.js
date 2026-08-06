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
const { resolveGrade } = require('./ifGrade');

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
    // The two the pilot tells us rather than the two we can measure. They ride
    // on the stat block under `fav` so a tile is still a tile — the renderer
    // does not care where a value came from, only that there is one.
    favAirport: { label: 'FAVOURITE AIRPORT', accent: true,
                  get: (s) => s.fav?.airport || null,
                  sub: (s) => s.fav?.airportName || null },
    favAircraft:{ label: 'FAVOURITE AIRCRAFT',
                  get: (s) => s.fav?.aircraft || null,
                  sub: (s) => s.fav?.livery || null },
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
 * Favourites
 *
 * These are the only things on the card the pilot asserts rather than the
 * Infinite Flight API reporting. That is the point — "favourite" means the one
 * you love, which is not always the one you grind — but it does mean the values
 * arrive as free text and have to be treated as such: length-capped, stripped
 * of anything that isn't plausibly a name, and never trusted into markup.
 * ------------------------------------------------------------------------- */
const ICAO_RE = /^[A-Z0-9]{3,4}$/;
// Deliberately permissive: aircraft and livery names in the wild carry digits,
// hyphens, slashes, apostrophes and dots (`A350-900`, `787-9`, `Boeing House`,
// `TAP Air Portugal`). Anything outside that is dropped rather than rejected,
// so a stray character costs a character and not the whole field.
const NAME_SAFE_RE = /[^A-Za-z0-9 .\-/'&()+]/g;

const cleanName = (v, max) => String(v == null ? '' : v)
    .replace(NAME_SAFE_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * The pilot's favourites, normalized. Any field that does not survive comes
 * back absent, and an absent favourite simply has no tile — the same contract
 * every other stat has.
 */
function normalizeFavourites(input) {
    const src = input || {};
    const airport = String(src.airport || '').trim().toUpperCase();
    return {
        airport: ICAO_RE.test(airport) ? airport : null,
        airportName: cleanName(src.airportName, 28) || null,
        aircraft: cleanName(src.aircraft, 28) || null,
        livery: cleanName(src.livery, 28) || null,
    };
}

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
        grade: numOrNull(pick(resolveGrade(detail), user?.grade)),
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
// The card's own corner radius. The PNG is transparent outside it, so the
// rounding is real rather than painted-on — on IFC the forum background shows
// through the corners whatever theme the reader is using, which a card faking
// round corners with its own background colour cannot do.
const CARD_RADIUS = 28;
// The favourite-aircraft photo. It is a PANEL, inset to the same margins as the
// tiles and rounded to the same radius, so it reads as one more thing in the
// grid rather than as a picture the card happens to end on. Wide and shallow
// because that is the shape an aircraft is; a squarer crop spends its height on
// sky and tarmac.
//
// The height was raised from 268: at that depth a 3:2 photograph cropped to the
// panel's 4.1:1 was throwing away most of the aircraft, and the band read as a
// stripe rather than as a picture. 330 is about 3.4:1 — still the shape an
// airliner is, with enough room to actually see one.
const PHOTO_H = 330;
const PHOTO_RADIUS = 20;
// It sits in the grid, so it is exactly as wide as the grid.
const PHOTO_W = WIDTH - PAD * 2;
// The VA badge's mark. Height is fixed; width follows the logo's aspect up to
// the ceiling, so a wordmark gets room and a roundel stays square.
const VA_LOGO_H = 62;
const VA_LOGO_MAX_W = 160;
// A pilot flying for several VAs gets a row of marks instead of one mark and a
// name, so each is allowed less width — three 160px wordmarks would run into
// the pilot's own name.
const VA_LOGO_MULTI_MAX_W = 118;
const VA_BADGE_GAP = 12;
// What the badge row may take out of the header. The rest is the pilot's name,
// which is the thing the card is actually about.
const VA_ROW_MAX_W = 560;
// Past three the header stops being a header. The API enforces the same ceiling.
const MAX_VAS = 3;

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
 * @param {string}   [card.photoUrl] community photo of the favourite aircraft.
 *                                   The CALLER resolves this — the renderer has
 *                                   no database and should not grow one.
 * @param {object[]} [card.vas]     the VAs the pilot flies for, in their chosen
 *                                   order. The CALLER has already verified each
 *                                   against the roster — this function has no
 *                                   database and takes the claim as settled.
 */
async function renderIfProfileCardImpl({ stats, fields, theme, pro, statsAt, photoUrl, vas, va } = {}) {
    const s = stats || {};
    const pal = themeFor(normalizeTheme(theme));
    const keys = normalizeFields(fields);

    // The photo is fetched BEFORE the layout is sized, because a photo we cannot
    // get is a band we must not leave a gap for. Everything downstream keys off
    // `photo` being non-null rather than off the URL having been supplied.
    const photo = photoUrl ? await fetchImage(photoUrl) : null;

    // `va` is the single-VA shape the first version of this card took. Folded in
    // rather than dropped so an older caller still renders a badge.
    const wearing = (Array.isArray(vas) ? vas : (va ? [va] : []))
        .filter((v) => v && v.name)
        .slice(0, MAX_VAS);

    // The badges are resolved up front — a logo we cannot fetch still leaves the
    // VA's NAME, which is the part that matters, so a badge falls back to its
    // initial rather than disappearing with the picture.
    //
    // Each plate takes its logo's shape rather than forcing the logo into a
    // square. VA marks are wordmarks about as often as they are roundels, and a
    // 3:1 wordmark letterboxed into 62x62 renders about a fifth of the plate
    // with the airline's name too small to read. Height is fixed so a row of
    // them still lines up whatever shapes arrive.
    const badges = [];
    for (const v of wearing) {
        const logo = v.logoUrl ? await fetchImage(v.logoUrl) : null;
        let w = VA_LOGO_H;
        if (logo) {
            try {
                const meta = await sharp(logo).metadata();
                if (meta.width && meta.height) {
                    const ceiling = wearing.length > 1 ? VA_LOGO_MULTI_MAX_W : VA_LOGO_MAX_W;
                    const aspect = meta.width / meta.height;
                    w = Math.round(Math.min(Math.max(VA_LOGO_H * aspect, VA_LOGO_H), ceiling));
                }
            } catch (_) { /* undecodable; the fallback plate is drawn below */ }
        }
        badges.push({ name: clamp(v.name, 26), logo, w });
    }

    // Laid out right-aligned in the header, and any badge that would push the
    // row past its budget is dropped rather than allowed to collide with the
    // pilot's name. Wide wordmarks are the case this is guarding against.
    const worn = [];
    let rowW = 0;
    for (const b of badges) {
        const need = worn.length ? rowW + VA_BADGE_GAP + b.w : b.w;
        if (need > VA_ROW_MAX_W) break;
        rowW = need;
        worn.push(b);
    }
    // One badge keeps the VA's name beside its mark; several share the corner as
    // marks alone under a single caption, because three names do not fit and a
    // logo is what a VA is recognised by anyway.
    const vaY = worn.length > 1 ? 56 : 46;
    let vaX = WIDTH - PAD - rowW;
    for (const b of worn) {
        b.x = vaX;
        b.y = vaY;
        vaX += b.w + VA_BADGE_GAP;
    }

    // Resolve to drawable tiles first: the grid is sized from what SURVIVES,
    // not from what was asked for, so a missing stat costs no empty square.
    const tiles = [];
    for (const key of keys) {
        // The photo band already names the favourite aircraft, in 40px over its
        // own picture. A tile repeating it underneath spends a slot saying the
        // same thing worse, so the band wins and the tile stands down — the
        // same trade the grade pill makes in the header.
        if (key === 'favAircraft' && photo) continue;
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

    // The photo panel is just another row of the grid: same left/right margins,
    // same gap above it, and the footer sits below it in its own strip exactly
    // as it does on a card that has no photo at all.
    const gridBottom = HEADER_H + rows * TILE_H + (rows - 1) * TILE_GAP;
    const photoTop = photo ? gridBottom + TILE_GAP : 0;
    const contentBottom = photo ? photoTop + PHOTO_H : gridBottom;
    const height = contentBottom + FOOTER_H + PAD;

    const parts = [];

    // --- Background: flat fill, then two soft colour fields. The same ambient
    // wash month.html drifts behind the report, held still.
    //
    // Everything is inside a rounded clip so the PNG's corners come out
    // TRANSPARENT. That is what makes the card sit on an IFC profile as a card
    // rather than as a rectangle with a painted-on radius that only matches one
    // forum theme. ---
    parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${height}" rx="${CARD_RADIUS}" fill="${pal.bg}"/>`);
    parts.push(`
        <g opacity="0.34" clip-path="url(#cardClip)">
          <circle cx="120" cy="40" r="330" fill="url(#glowA)"/>
          <circle cx="${WIDTH - 90}" cy="${height - 40}" r="300" fill="url(#glowB)"/>
        </g>`);

    // --- Header: who this is, and whose product it is ---
    // The handle is clamped to whatever the badges have left it, rather than to
    // a fixed count: one roundel and three wordmarks take very different
    // amounts of the header, and a single figure is either too generous for the
    // wide case (name and logos meet in the middle) or too mean for the narrow
    // one. Measuring properly would mean shipping font metrics; the per-
    // character estimate below is the same trick valueFontSize plays, with a
    // gutter that absorbs its error.
    const CHAR_W = 29;             // 44px DejaVu Sans Bold, mixed case, generous
    const HEADER_GUTTER = 24;      // the gap the name must never close
    const vaBlockW = worn.length === 1
        // One badge also prints the VA's NAME to its left, at 22px.
        ? rowW + 18 + worn[0].name.length * 12
        : rowW;
    const handleRoom = WIDTH - PAD * 2 - vaBlockW - (worn.length ? HEADER_GUTTER : 0);
    const handleMax = Math.max(8, Math.min(26, Math.floor(handleRoom / CHAR_W)));
    const handle = clamp(s.username || 'Unknown pilot', handleMax);
    parts.push(`
        <text x="${PAD}" y="${52}" font-family="${FONT}" font-size="17" font-weight="bold"
              letter-spacing="3.4" fill="${pal.faint}">INFLIGHT</text>
        <text x="${PAD}" y="${104}" font-family="${FONT}" font-size="44" font-weight="bold"
              fill="${pal.ink}">${esc(handle)}</text>`);

    // --- The VA badges ---
    // Top-right, because a VA is who the pilot flies FOR — identity, alongside
    // their name, rather than a statistic among statistics. Only ever drawn from
    // VAs the caller has already confirmed the pilot is on the roster of; this
    // function has no database and takes the claim as settled.
    if (worn.length === 1) {
        // The name is right-aligned into the gap left of the logo, so a long VA
        // name grows leftwards into empty header rather than into the mark.
        const [b] = worn;
        const nameRight = b.x - 18;
        parts.push(`
            <text x="${nameRight}" y="${b.y + 26}" text-anchor="end" font-family="${FONT}" font-size="13"
                  font-weight="bold" letter-spacing="2.4" fill="${pal.faint}">FLIES FOR</text>
            <text x="${nameRight}" y="${b.y + 52}" text-anchor="end" font-family="${FONT}" font-size="22"
                  font-weight="bold" fill="${pal.ink}">${esc(b.name)}</text>`);
    } else if (worn.length > 1) {
        // One caption over the row rather than one per mark: the marks are the
        // content, and repeating "flies for" three times is noise.
        parts.push(`
            <text x="${WIDTH - PAD}" y="44" text-anchor="end" font-family="${FONT}" font-size="13"
                  font-weight="bold" letter-spacing="2.4" fill="${pal.faint}">FLIES FOR</text>`);
    }
    // The plates are drawn ALWAYS, not just when a logo is missing. A logo is
    // letterboxed onto its plate (see below), and drawing them unconditionally
    // also means a logo that fetches but fails to decode still leaves a badge
    // rather than a hole. Only the initial is conditional.
    for (const b of worn) {
        parts.push(`
            <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${VA_LOGO_H}" rx="16"
                  fill="${pal.tile}" stroke="${pal.tileLine}" stroke-width="1.5"/>`);
        if (!b.logo) {
            parts.push(`
                <text x="${b.x + b.w / 2}" y="${b.y + 42}" text-anchor="middle" font-family="${FONT}"
                      font-size="28" font-weight="bold" fill="${pal.muted}">${esc(b.name.charAt(0).toUpperCase())}</text>`);
        }
    }

    // Grade rides in the top-right as a pill whenever the pilot did not already
    // put it in the grid — it is the one number every IFC reader looks for, and
    // duplicating it would just spend a tile. The VA badges hold that corner
    // when there are any, and identity beats a number the grid can carry.
    if (s.grade != null && !keys.includes('grade') && !worn.length) {
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

    // --- Footer ---
    // Always its own strip on the card's background, in theme ink — the photo
    // is a panel, so nothing is ever printed over a photograph and the footer
    // can stay the same line on every card.
    const footY = height - FOOTER_H + 34;
    parts.push(`
        <text x="${PAD}" y="${footY}" font-family="${FONT}" font-size="17" fill="${pal.faint}">
            inflight.info</text>
        <text x="${WIDTH - PAD}" y="${footY}" text-anchor="end" font-family="${FONT}" font-size="17"
              fill="${pal.faint}">${esc(pro ? `Updated monthly · ${stamp(statsAt)}` : `As of ${stamp(statsAt)}`)}</text>`);

    // The plate the photo is composited onto. Drawn even though the picture
    // covers it, so a photo that fetches but fails to decode leaves a tile-shaped
    // panel rather than a hole in the grid.
    if (photo) {
        parts.push(`
            <rect x="${PAD}" y="${photoTop}" width="${PHOTO_W}" height="${PHOTO_H}" rx="${PHOTO_RADIUS}"
                  fill="${pal.tile}" stroke="${pal.tileLine}" stroke-width="1.5"/>`);
    }

    const defs = `
        <defs>
          <radialGradient id="glowA"><stop offset="0%" stop-color="${pal.glowA}" stop-opacity="0.85"/><stop offset="100%" stop-color="${pal.glowA}" stop-opacity="0"/></radialGradient>
          <radialGradient id="glowB"><stop offset="0%" stop-color="${pal.glowB}" stop-opacity="0.85"/><stop offset="100%" stop-color="${pal.glowB}" stop-opacity="0"/></radialGradient>
          <clipPath id="cardClip"><rect x="0" y="0" width="${WIDTH}" height="${height}" rx="${CARD_RADIUS}"/></clipPath>
        </defs>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
        ${defs}
        ${parts.join('\n')}
    </svg>`;

    let out = sharp(Buffer.from(svg));

    // --- The VA logos ---
    // `contain` rather than `cover`: VA logos are wordmarks as often as they are
    // roundels, and cropping one to fill its plate cuts the airline's name in
    // half. Letterboxed onto a transparent background each keeps its aspect and
    // sits inside its rounded plate.
    //
    // Collected into ONE composite rather than one per badge, so three VAs cost
    // a single re-encode of the card rather than three.
    const marks = [];
    for (const b of worn) {
        if (!b.logo) continue;
        try {
            marks.push({
                input: await sharp(b.logo)
                    .resize(b.w, VA_LOGO_H, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .composite([{
                        input: Buffer.from(
                            `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${VA_LOGO_H}"><rect width="${b.w}" height="${VA_LOGO_H}" rx="16" fill="#fff"/></svg>`),
                        blend: 'dest-in',
                    }])
                    .png().toBuffer(),
                left: b.x,
                top: b.y,
            });
        } catch (err) {
            // A logo sharp cannot decode is not worth losing the card over — the
            // SVG already drew the fallback plate underneath.
            console.error('[if-card] VA logo render failed:', err?.message || err);
        }
    }
    if (marks.length) out = sharp(await out.png().toBuffer()).composite(marks);

    // --- The favourite aircraft, photographed ---
    // Three layers, in order: the photo itself (rounded to the panel's corners),
    // a scrim so text on top of an arbitrary photograph is readable, then the
    // aircraft name and the panel's hairline border.
    if (photo) {
        const band = await sharp(photo)
            .resize(PHOTO_W, PHOTO_H, { fit: 'cover', position: 'attention' })
            .composite([{ input: panelMask(), blend: 'dest-in' }])
            .png().toBuffer();

        const label = s.fav?.aircraft ? clamp(s.fav.aircraft, 30) : null;
        const sub = s.fav?.livery ? clamp(s.fav.livery, 34) : null;
        // Text is inset from the PANEL's edge, not the card's, so the caption
        // has the same breathing room inside its container that a tile's label
        // has inside its own.
        const textX = PAD + 30;
        const overlay = Buffer.from(`
            <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">
              <defs>
                <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#000" stop-opacity="0.68"/>
                  <stop offset="60%" stop-color="#000" stop-opacity="0.16"/>
                  <stop offset="100%" stop-color="#000" stop-opacity="0.34"/>
                </linearGradient>
                <clipPath id="photoClip">
                  <rect x="${PAD}" y="${photoTop}" width="${PHOTO_W}" height="${PHOTO_H}" rx="${PHOTO_RADIUS}"/>
                </clipPath>
              </defs>
              <g clip-path="url(#photoClip)">
                <rect x="${PAD}" y="${photoTop}" width="${PHOTO_W}" height="${PHOTO_H}" fill="url(#scrim)"/>
                ${label ? `<text x="${textX}" y="${photoTop + 48}" font-family="${FONT}" font-size="15"
                        font-weight="bold" letter-spacing="2.2" fill="rgba(255,255,255,0.66)">FAVOURITE AIRCRAFT</text>
                    <text x="${textX}" y="${photoTop + 96}" font-family="${FONT}" font-size="40"
                        font-weight="bold" fill="#ffffff">${esc(label)}</text>` : ''}
                ${label && sub ? `<text x="${textX}" y="${photoTop + 128}" font-family="${FONT}" font-size="20"
                        fill="rgba(255,255,255,0.80)">${esc(sub)}</text>` : ''}
              </g>
              <rect x="${PAD}" y="${photoTop}" width="${PHOTO_W}" height="${PHOTO_H}" rx="${PHOTO_RADIUS}"
                    fill="none" stroke="${pal.tileLine}" stroke-width="1.5"/>
            </svg>`);

        out = sharp(await out.png().toBuffer())
            .composite([{ input: band, left: PAD, top: photoTop }, { input: overlay, left: 0, top: 0 }]);
    }

    return out.png().toBuffer();
}

/**
 * An alpha mask that rounds all four corners of the photo panel.
 *
 * The SVG clip path cannot reach the photo, because the photo is composited as
 * a raster layer after the SVG has already been rasterized — so the rounding
 * has to be cut out of the pixels themselves.
 */
function panelMask() {
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W}" height="${PHOTO_H}">
           <rect x="0" y="0" width="${PHOTO_W}" height="${PHOTO_H}" rx="${PHOTO_RADIUS}" fill="#fff"/>
         </svg>`);
}

/**
 * The bytes behind a remote image URL, or null.
 *
 * Used for both the aircraft photo and the VA logos. Best-effort in every
 * direction: a timeout, a size ceiling, and a content-type check, because these
 * URLs come out of database rows that a contributor or a VA filled in, and the
 * renderer must not be the thing that hangs on one. Null simply means that
 * element is absent, and the card is complete without any of them.
 */
async function fetchImage(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return null;
    try {
        const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 6000,
            maxContentLength: 8 * 1024 * 1024,
            maxRedirects: 3,
        });
        const type = String(resp.headers?.['content-type'] || '');
        if (!/^image\//i.test(type)) return null;
        return Buffer.from(resp.data);
    } catch (err) {
        console.error(`[if-card] image fetch failed (${url}):`, err?.message || err);
        return null;
    }
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
    normalizeFavourites,
    refreshDueAt,
    needsRefresh,
    FIELDS,
    FIELD_KEYS,
    DEFAULT_FIELDS,
    MAX_FIELDS,
    MAX_VAS,
    THEME_KEYS,
    DEFAULT_THEME,
};

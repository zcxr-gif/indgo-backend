'use strict';

/*
 * crewCsv.js
 * Getting a roster or a route network out of a crew center, and back in.
 *
 * WHY
 * ---
 * "Your data is yours" is only true if you can pick it up and carry it. The
 * crew center already keeps a VA's roster and routes in the VA's own Postgres,
 * which settles the ownership question, but a Postgres table is not a form a
 * volunteer airline manager can actually use — they want the roster in a
 * spreadsheet, and they arrive with one. Most VAs on the platform were running
 * on a spreadsheet the day before they signed up.
 *
 * So: export the exact columns import accepts, and accept the exact columns
 * export produces. A file that goes out and comes back unedited must be a no-op.
 * That symmetry is the whole design, and it is why the id column is exported —
 * a row that carries its id updates precisely, with no guessing.
 *
 * MATCHING, WHEN THERE IS NO ID
 * -----------------------------
 * A file typed from scratch has no ids, so each spec below names the fields
 * that identify a row instead, tried in order. The first one that hits wins.
 * Nothing matches on a field a VA is likely to edit in bulk (a rename, a mass
 * re-assignment of ranks), because a match that breaks when someone fixes a
 * typo silently duplicates their whole roster.
 *
 * IMPORT NEVER DELETES
 * --------------------
 * A row present in the crew center and absent from the file is left alone. This
 * is not a sync: a VA importing a partial file — the twelve pilots they just
 * recruited, an updated set of hours for one wing — must not lose the rest,
 * and there is no way for us to tell that file apart from a complete one.
 * Removing a pilot is its own deliberate action on the roster screen.
 */

const Papa = require('papaparse');

// Excel on Windows reads a UTF-8 file as its own legacy code page unless the
// byte-order mark is there. Without this, every non-ASCII pilot name in an
// exported roster opens as mojibake — and these are airlines with pilots called
// Müller and Peña.
const BOM = '﻿';

// Cap the work a single import can ask for. A roster is hundreds of rows; a
// file with a hundred thousand is a mistake or an attack, and either way the
// answer is to refuse it rather than to spend ten minutes finding out.
const MAX_ROWS = 5000;

const trim = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Header matching is forgiving on purpose. The file that comes back may have
// been through Excel, Numbers and a hand edit, and "Flight Number",
// "flight_number" and "flightNumber" are all obviously the same column to
// everyone except a strict parser.
const normalizeHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const TRUEISH = new Set(['1', 'true', 'yes', 'y', 't', 'active', 'on']);
const FALSEISH = new Set(['0', 'false', 'no', 'n', 'f', 'draft', 'inactive', 'off']);

// ---------------------------------------------------------------------------
// Column specs
//
// `key`      the field name on our own objects
// `header`   what it is called in the file
// `aliases`  other spellings accepted on the way in
// `type`     text | number | list | bool | enum
// ---------------------------------------------------------------------------

const ROSTER_SPEC = {
    name: 'roster',
    // The id goes first so it is the leftmost column in a spreadsheet, where it
    // is least likely to be in the way of the columns people actually edit.
    columns: [
        { key: 'id', header: 'id', type: 'text', readOnly: true },
        { key: 'name', header: 'name', type: 'text', max: 60, required: true },
        { key: 'callsign', header: 'callsign', type: 'text', max: 20 },
        { key: 'hours', header: 'hours', type: 'number', min: 0, max: 1e6 },
        { key: 'role', header: 'role', type: 'text', max: 40 },
        // Semicolons, not commas — a comma inside a CSV cell means quoting, and
        // quoting is exactly what gets mangled by the round trip through a
        // spreadsheet and a hand edit.
        { key: 'aircraft', header: 'aircraft', type: 'list', max: 40, maxItems: 40 },
        { key: 'status', header: 'status', type: 'enum', values: ['active', 'loa', 'inactive'], default: 'active' },
        { key: 'ifcName', header: 'ifcName', aliases: ['ifc', 'ifcusername', 'communityname'], type: 'text', max: 60 },
        { key: 'ifUserId', header: 'ifUserId', aliases: ['ifuserid', 'ifid'], type: 'text', max: 40 },
    ],
    // Callsign before name: an airline reassigns a callsign far less often than
    // it corrects the spelling of somebody's name.
    matchOn: ['callsign', 'name'],
};

const ROUTES_SPEC = {
    name: 'routes',
    columns: [
        { key: 'id', header: 'id', type: 'text', readOnly: true },
        { key: 'flightNumber', header: 'flightNumber', aliases: ['flightno', 'flight', 'number'], type: 'text', max: 12 },
        { key: 'origin', header: 'origin', aliases: ['from', 'dep', 'departure'], type: 'icao', required: true },
        { key: 'destination', header: 'destination', aliases: ['to', 'arr', 'arrival', 'dest'], type: 'icao', required: true },
        { key: 'aircraft', header: 'aircraft', type: 'text', max: 60 },
        { key: 'distanceNm', header: 'distanceNm', aliases: ['distance', 'nm', 'distancenm'], type: 'number', min: 0, max: 20000 },
        { key: 'notes', header: 'notes', type: 'text', max: 500 },
        { key: 'active', header: 'active', aliases: ['published', 'live'], type: 'bool', default: true },
        // v5. A VA building a network in a spreadsheet is exactly the VA who
        // wants to mark half of it as codeshare and gate the long-haul on a
        // rank, so these belong in the file rather than being twenty clicks
        // afterwards.
        { key: 'kind', header: 'kind', aliases: ['type'], type: 'enum', values: ['own', 'codeshare'], default: 'own' },
        { key: 'partnerName', header: 'partnerName', aliases: ['partner', 'operator'], type: 'text', max: 60 },
        { key: 'partnerLogo', header: 'partnerLogo', aliases: ['partnerlogourl', 'logo'], type: 'text', max: 600 },
        // Named, not numeric: the VA's own rank names are what they think in,
        // and the hours behind them are set once on the ladder.
        { key: 'minRank', header: 'minRank', aliases: ['rank', 'opensat', 'requiredrank'], type: 'text', max: 40 },
    ],
    // A flight number is the airline's own identifier for a leg, so it wins.
    // Falling back to the city pair is right for the many VAs that do not
    // number their routes at all, and wrong only for one that flies the same
    // pair under two numbers — which is why the number is tried first.
    matchOn: ['flightNumber', 'origin+destination'],
};

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

const cellFor = (col, value) => {
    if (col.type === 'list') return (Array.isArray(value) ? value : []).join('; ');
    if (col.type === 'bool') return value ? 'true' : 'false';
    if (col.type === 'number') return value == null || value === '' ? '' : String(value);
    return value == null ? '' : String(value);
};

/**
 * Rows → a CSV file. Always writes every column, including empty ones, so the
 * file that comes back has somewhere to put a value that was blank when it left.
 */
function toCsv(spec, rows) {
    const data = (rows || []).map((row) => {
        const out = {};
        for (const col of spec.columns) out[col.header] = cellFor(col, row[col.key]);
        return out;
    });
    return BOM + Papa.unparse({
        fields: spec.columns.map((c) => c.header),
        data,
    }, { newline: '\r\n' });
}

// ---------------------------------------------------------------------------
// In
// ---------------------------------------------------------------------------

/** Map the file's headers onto our columns, tolerating spelling and case. */
function mapHeaders(spec, fields) {
    const byNorm = new Map();
    for (const col of spec.columns) {
        byNorm.set(normalizeHeader(col.header), col);
        for (const a of col.aliases || []) byNorm.set(normalizeHeader(a), col);
    }
    const found = new Map();   // column key -> the header as written in the file
    for (const f of fields || []) {
        const col = byNorm.get(normalizeHeader(f));
        if (col && !found.has(col.key)) found.set(col.key, f);
    }
    return found;
}

function coerce(col, raw) {
    const text = String(raw == null ? '' : raw).trim();
    switch (col.type) {
        case 'number': {
            if (text === '') return { value: 0 };
            const n = Number(text.replace(/,/g, ''));
            if (!Number.isFinite(n)) return { error: `${col.header} must be a number` };
            return { value: Math.max(col.min ?? -Infinity, Math.min(col.max ?? Infinity, n)) };
        }
        case 'bool': {
            if (text === '') return { value: col.default };
            const t = text.toLowerCase();
            if (TRUEISH.has(t)) return { value: true };
            if (FALSEISH.has(t)) return { value: false };
            return { error: `${col.header} should be true or false` };
        }
        case 'list':
            return {
                value: text.split(/[;|]/).map((s) => s.trim().slice(0, col.max || 40))
                    .filter(Boolean).slice(0, col.maxItems || 40),
            };
        case 'enum': {
            if (text === '') return { value: col.default };
            const t = text.toLowerCase();
            if (!col.values.includes(t)) {
                return { error: `${col.header} must be one of ${col.values.join(', ')}` };
            }
            return { value: t };
        }
        case 'icao': {
            const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
            if (text && code.length < 3) return { error: `${col.header} “${text}” is not an airport code` };
            return { value: code };
        }
        default:
            return { value: text.slice(0, col.max || 200) };
    }
}

const matchKey = (rule, obj) => {
    if (!obj) return '';
    const parts = rule.split('+').map((f) => String(obj[f] == null ? '' : obj[f]).trim().toLowerCase());
    return parts.every((p) => p) ? parts.join(' ') : '';
};

/**
 * Work out what an uploaded file would do, without doing any of it.
 *
 * The dashboard runs this first and shows the result — "12 new, 3 updated, 40
 * unchanged, 2 rows we couldn't read" — because an import that silently
 * rewrites a live roster is not something anyone should trigger blind. The
 * commit step then replays exactly this plan.
 *
 * @returns {{create: Object[], update: Object[], unchanged: number,
 *            errors: {line: number, message: string}[], matchedOn: string,
 *            columns: string[], missing: string[]}}
 */
function planImport(spec, csvText, existing) {
    const text = String(csvText || '').replace(/^﻿/, '');
    if (!text.trim()) return { error: 'That file is empty.' };

    const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
    const headers = mapHeaders(spec, parsed.meta && parsed.meta.fields);
    if (!headers.size) {
        return { error: `We couldn't find any recognisable columns. The first row should name them: ${spec.columns.map((c) => c.header).join(', ')}.` };
    }
    if ((parsed.data || []).length > MAX_ROWS) {
        return { error: `That file has more than ${MAX_ROWS} rows. Split it and import in parts.` };
    }

    // Index what is already there, by id and by each fallback rule.
    const byId = new Map();
    const byRule = new Map(spec.matchOn.map((r) => [r, new Map()]));
    for (const row of existing || []) {
        if (row.id) byId.set(String(row.id), row);
        for (const rule of spec.matchOn) {
            const k = matchKey(rule, row);
            // First writer wins: if a VA already has two pilots sharing a
            // callsign, an ambiguous file row should land on neither of them
            // rather than on whichever we happened to see last.
            if (k && !byRule.get(rule).has(k)) byRule.get(rule).set(k, row);
        }
    }

    const create = [];
    const update = [];
    const errors = [];
    let unchanged = 0;
    let matchedOn = 'id';
    // Rows created earlier in this same file, so a file that lists the same
    // pilot twice updates them rather than inserting a second copy.
    const staged = new Map(spec.matchOn.map((r) => [r, new Map()]));

    (parsed.data || []).forEach((raw, i) => {
        const line = i + 2;   // +1 for zero-index, +1 for the header row
        const values = {};
        let bad = null;
        for (const col of spec.columns) {
            if (col.readOnly) continue;
            if (!headers.has(col.key)) continue;
            const got = coerce(col, raw[headers.get(col.key)]);
            if (got.error) { bad = got.error; break; }
            values[col.key] = got.value;
        }
        if (bad) { errors.push({ line, message: bad }); return; }

        // Find it: by id if the file carried one, else by each rule in turn.
        const id = headers.has('id') ? trim(raw[headers.get('id')], 64) : '';
        let target = id ? byId.get(id) : null;
        if (id && !target) {
            errors.push({ line, message: `No pilot or route here with id ${id}. Clear the id column to add it as new.` });
            return;
        }
        // A row this same file already asked us to create. It has no id yet —
        // it does not exist — so it cannot be an update; fold the later line's
        // values into the pending create instead. Emitting an update against an
        // empty id was the old behaviour, and it failed at commit time and
        // reported the VA's own file back to them as a broken row.
        if (!target) {
            for (const rule of spec.matchOn) {
                const k = matchKey(rule, values);
                if (!k) continue;
                const pending = staged.get(rule).get(k);
                if (!pending) continue;
                Object.assign(pending.values, values);
                for (const r2 of spec.matchOn) {
                    const k2 = matchKey(r2, pending.values);
                    if (k2 && !staged.get(r2).has(k2)) staged.get(r2).set(k2, pending);
                }
                return;
            }
        }

        if (!target) {
            for (const rule of spec.matchOn) {
                const k = matchKey(rule, values);
                if (!k) continue;
                const hit = byRule.get(rule).get(k);
                if (hit) { target = hit; matchedOn = rule; break; }
            }
        }

        if (target) {
            // Only mention what actually differs, so "3 updated" means three
            // rows really changed rather than three rows were re-saved.
            const diff = {};
            for (const [key, v] of Object.entries(values)) {
                const before = target[key];
                const same = Array.isArray(v)
                    ? Array.isArray(before) && v.length === before.length && v.every((x, n) => x === before[n])
                    : String(before == null ? '' : before) === String(v == null ? '' : v);
                if (!same) diff[key] = v;
            }
            if (!Object.keys(diff).length) { unchanged++; return; }
            update.push({ id: String(target.id), line, values: diff, before: target });
        } else {
            // `required` is a rule about creating something, not about the file:
            // a VA correcting hours for existing pilots sends two columns and
            // should not be told their file needs a name column. It only has to
            // be there when there is no existing row to fall back on.
            const missingRequired = spec.columns.find(
                (c) => c.required && !String(values[c.key] || '').trim());
            if (missingRequired) {
                errors.push({
                    line,
                    message: headers.has(missingRequired.key)
                        ? `${missingRequired.header} is required to add a new ${spec.name === 'roster' ? 'pilot' : 'route'}`
                        : `this row is new, so it needs a ${missingRequired.header} column`,
                });
                return;
            }
            const row = { line, values };
            create.push(row);
            // Register the create row ITSELF, not a copy of its values, so a
            // later duplicate line merges into the thing that will actually be
            // written rather than into a snapshot nobody reads again.
            for (const rule of spec.matchOn) {
                const k = matchKey(rule, values);
                if (k && !staged.get(rule).has(k)) staged.get(rule).set(k, row);
            }
        }
    });

    return {
        create, update, unchanged, errors, matchedOn,
        columns: [...headers.keys()],
        missing: spec.columns.filter((c) => !c.readOnly && !headers.has(c.key)).map((c) => c.header),
    };
}

module.exports = {
    ROSTER_SPEC,
    ROUTES_SPEC,
    toCsv,
    planImport,
    normalizeHeader,
    MAX_ROWS,
    BOM,
};

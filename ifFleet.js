'use strict';

/*
 * ifFleet.js
 * Turns Infinite Flight PublicApi v3 Live organization aircraft into the fleet
 * shape the crew center already understands.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A VA's fleet has always been typed in by hand: someone opens the fleet
 * builder and lists the aircraft they operate. That list is what
 * `pirepInFleet` matches a flown leg against, so it only works when the strings
 * a VA typed are the same canonical strings the live API reports — which is why
 * the builder offers autocomplete off /api/metadata rather than free text.
 *
 * v3 gives us the real thing: the actual aircraft in a VA's Live organization,
 * with registrations, fleet order and which of them are in active slots. What
 * it does *not* give us is the aircraft's name. Each record carries an
 * `aircraftId`, described as "the Infinite Flight aircraft or livery content
 * identifier" — a UUID, not "Boeing 777-300ER".
 *
 * So the join here is: v3 `aircraftId` → the id maps that loadAircraftMetadata
 * already builds from /api/metadata → canonical type and livery names. Those
 * are the same strings the manual builder produces, which means a synced fleet
 * drops straight into PIREP matching with no second matching path.
 *
 * The id may be either an aircraft or a livery, so liveries are tried first:
 * a livery resolves to both its own name and its parent type, which is strictly
 * more information than an aircraft id gives.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not replace the hand-built fleet. v3 is a preview that Infinite
 * Flight say may change without deprecation, and a VA who loses their fleet
 * because an upstream enum moved would rightly be furious. The synced fleet is
 * a mirror that sits alongside `crewFleet`; `combinedTypes` is what PIREP
 * matching should consult, and it is the union of the two. Disconnecting throws
 * away only the mirror.
 */

/** First non-empty trimmed string among the arguments. */
function firstStr() {
    for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Resolves a v3 content id to canonical Infinite Flight names.
 *
 * @param {string} contentId  v3 `aircraftId`
 * @param {Object} meta       loadAircraftMetadata() output — { acById, livById }
 * @returns {{ type: string, livery: string }} empty strings when unresolved
 */
function resolveNames(contentId, meta) {
    const id = String(contentId || '').toLowerCase();
    if (!id || !meta) return { type: '', livery: '' };

    // Liveries first: a livery id yields the type as well, an aircraft id can't
    // yield the livery.
    const liv = meta.livById && meta.livById.get(id);
    if (liv) return { type: firstStr(liv.aircraftName), livery: firstStr(liv.liveryName) };

    const ac = meta.acById && meta.acById.get(id);
    if (ac) return { type: firstStr(ac), livery: '' };

    return { type: '', livery: '' };
}

/**
 * Maps one v3 aircraft record into our shape.
 *
 * `id` and `aircraftId` are easy to confuse and the docs call it out: `id` is
 * the persistent organization aircraft id — the one that goes in
 * /live/aircraft/{aircraftId} and the schedule endpoints — while `aircraftId`
 * is the content identifier for the model or livery. We keep the first as `id`
 * and rename the second to `contentId` so nothing downstream can mix them up.
 */
function mapAircraft(raw, meta) {
    if (!raw || typeof raw !== 'object') return null;
    const id = firstStr(raw.id);
    if (!id) return null;

    const contentId = firstStr(raw.aircraftId);
    const { type, livery } = resolveNames(contentId, meta);

    return {
        id,
        contentId,
        organizationId: firstStr(raw.organizationId),
        registration: firstStr(raw.registration),
        // Canonical IF names, or '' when the catalogue doesn't know this id —
        // which happens for content shipped after our metadata was last cached.
        type,
        livery,
        status: num(raw.status),
        visibility: num(raw.visibility),
        fleetPriority: num(raw.fleetPriority),
        fleetRank: num(raw.fleetRank),
        // Aircraft outside the org's active slots show as storage in the Live
        // portal even when visibility says Visible. The two are separate and
        // both are kept, because a fleet page wants to show the distinction.
        isFleetActiveSlot: raw.isFleetActiveSlot === true,
        createdAt: firstStr(raw.createdAt),
    };
}

/**
 * Maps a whole /live/organizations/{id}/aircraft response.
 *
 * Ordered the way the Live portal orders a fleet: active slots first, then by
 * fleet rank, then by registration so the order is stable when ranks tie.
 * Deleted records (status 1) are dropped — the endpoint returns active aircraft,
 * but the mirror should not resurrect one if that ever changes.
 */
function mapFleet(rawList, meta) {
    const out = [];
    for (const raw of (Array.isArray(rawList) ? rawList : [])) {
        const ac = mapAircraft(raw, meta);
        if (!ac) continue;
        if (ac.status === 1) continue;
        out.push(ac);
    }
    out.sort((a, b) => {
        if (a.isFleetActiveSlot !== b.isFleetActiveSlot) return a.isFleetActiveSlot ? -1 : 1;
        const ar = a.fleetRank == null ? Infinity : a.fleetRank;
        const br = b.fleetRank == null ? Infinity : b.fleetRank;
        if (ar !== br) return ar - br;
        return a.registration.localeCompare(b.registration);
    });
    return out;
}

/**
 * The distinct aircraft types in a synced fleet, in the canonical spelling.
 * Unresolved records contribute nothing — a blank type would match every leg
 * with a blank aircraft name, which is the opposite of what a fleet filter is
 * for.
 */
function syncedTypes(fleet) {
    const seen = new Set();
    for (const ac of (fleet || [])) {
        const t = firstStr(ac && ac.type);
        if (t) seen.add(t);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The fleet PIREP matching should actually use: the hand-built list plus
 * anything the sync found, de-duplicated case-insensitively.
 *
 * Entries keep the `{ type, name, image }` shape `crewFleet` uses, so callers
 * — `pirepInFleet` above all — need no special case for a synced entry. Manual
 * entries win a collision: a VA who set a livery image on a type should keep it
 * when the same type arrives from the sync.
 *
 * @param {Array} manual  crewFleet
 * @param {Array} synced  mapFleet() output
 */
function combinedTypes(manual, synced) {
    const out = [];
    const seen = new Set();

    const add = (type, name, image, source) => {
        const t = firstStr(type, name);
        if (!t) return;
        const key = t.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ type: t, name: firstStr(name, type), image: firstStr(image), source });
    };

    for (const m of (Array.isArray(manual) ? manual : [])) {
        if (m) add(m.type, m.name, m.image, 'manual');
    }
    for (const t of syncedTypes(synced)) add(t, t, '', 'infinite-flight');

    return out;
}

/**
 * Headline numbers for a fleet page.
 *
 * `unresolved` matters more than it looks: it counts aircraft whose content id
 * our catalogue could not name, and those contribute nothing to PIREP matching.
 * A VA seeing "4 aircraft couldn't be identified" can tell us; a VA seeing a
 * silently short fleet cannot.
 */
function summarize(fleet) {
    const list = Array.isArray(fleet) ? fleet : [];
    const byType = new Map();
    let active = 0, hangared = 0, unresolved = 0;

    for (const ac of list) {
        if (ac.isFleetActiveSlot) active++;
        if (ac.visibility === 2) hangared++;
        if (!ac.type) unresolved++;
        const t = firstStr(ac.type) || 'Unidentified';
        byType.set(t, (byType.get(t) || 0) + 1);
    }

    const types = [...byType.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type));

    return {
        total: list.length,
        activeSlots: active,
        storage: list.length - active,
        hangared,
        unresolved,
        distinctTypes: types.length,
        types,
    };
}

module.exports = { mapAircraft, mapFleet, syncedTypes, combinedTypes, summarize, resolveNames };

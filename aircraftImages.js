/**
 * aircraftImages.js — live aircraft image resolver.
 *
 * The IF/ACARS backend knows, for every live flight, the aircraft **type** and
 * **livery** name (as they come out of Infinite Flight). This module turns that
 * pair into the best available photo, searching two sources:
 *
 *   1. The static `aircraft.json` registry (1000+ curated renders, keyed by
 *      manufacturer / model / livery / registration).
 *   2. The community-contributed images (passed in from the Mongo collection).
 *
 * Matching is fuzzy on purpose: IF's type/livery strings ("A21N", "Airbus
 * A321neo", "oneworld") rarely equal the stored names character-for-character,
 * so we score candidates (exact > substring > Levenshtein similarity) and keep
 * the best one above a confidence floor. The scoring mirrors the logic the
 * Discord bot already uses in `bot.js` (lookupRegistration) so both surfaces
 * agree on what "the right photo" is.
 */

'use strict';

const registry = require('./aircraft.json');

/** Strip everything but [a-z0-9] and lowercase — "A320-200" -> "a320200". */
const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Levenshtein edit distance. TypedArray + shorter-string iteration keeps it
 * cheap enough to run across the whole registry per lookup.
 */
const levenshteinDistance = (s, t) => {
    if (s === t) return 0;
    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    if (s.length > t.length) [s, t] = [t, s];

    const v0 = new Uint16Array(t.length + 1);
    const v1 = new Uint16Array(t.length + 1);

    for (let i = 0; i < v0.length; i++) v0[i] = i;

    for (let i = 0; i < s.length; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < t.length; j++) {
            const cost = s[i] === t[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
        }
        for (let j = 0; j < v0.length; j++) v0[j] = v1[j];
    }
    return v1[t.length];
};

/** Similarity in [0,1]; 1.0 == identical. */
const getSimilarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
};

/**
 * Score one candidate against the target type + livery.
 *
 * @param {string} targetType   cleaned incoming aircraft type
 * @param {string} targetLivery cleaned incoming livery name
 * @param {object} cand         { manufacturer, model, livery } (already cleaned)
 * @param {boolean} useFuzzy    allow Levenshtein fallback (both strings long enough)
 * @returns {number} score; 0 means "not a match".
 */
const scoreCandidate = (targetType, targetLivery, cand, useFuzzy) => {
    const { manufacturer: man = '', model: mod = '', livery: liv = '' } = cand;
    const fullPlane = man + mod;

    // --- Livery gate: a candidate must plausibly share the livery. -----------
    let liveryScore = 0;
    if (targetLivery && liv) {
        if (targetLivery === liv) liveryScore = 20;
        else if (targetLivery.includes(liv) || liv.includes(targetLivery)) liveryScore = 15;
        else if (useFuzzy) {
            const sim = getSimilarity(targetLivery, liv);
            if (sim > 0.8) liveryScore = 10 * sim;
        }
    }
    if (liveryScore < 5) return 0;

    // --- Aircraft type. ------------------------------------------------------
    let typeScore = 0;
    if (mod && targetType === mod) typeScore = 50;
    else if (fullPlane && targetType === fullPlane) typeScore = 60;
    else if (mod && targetType.includes(mod)) {
        typeScore = 40;
        if (man && targetType.includes(man)) typeScore += 10;
    } else if (fullPlane && fullPlane.includes(targetType)) typeScore = 20;
    else if (useFuzzy) {
        const modSim = mod ? getSimilarity(targetType, mod) : 0;
        const fullSim = fullPlane ? getSimilarity(targetType, fullPlane) : 0;
        if (modSim > 0.85) typeScore = 30 * modSim;
        else if (fullSim > 0.85) typeScore = 35 * fullSim;
    }
    if (typeScore === 0) return 0;

    return liveryScore + typeScore;
};

// Minimum score before we trust a match. Mirrors bot.js (> 15).
const MATCH_FLOOR = 15;

/**
 * Best match from the static aircraft.json registry.
 * @returns {{ entry: object, score: number } | null}
 */
const matchRegistry = (aircraftType, liveryName) => {
    if (!Array.isArray(registry)) return null;

    const targetType = clean(aircraftType);
    const targetLivery = clean(liveryName);
    if (!targetType || !targetLivery) return null;

    const useFuzzy = targetType.length > 3 && targetLivery.length > 3;

    let best = null;
    let bestScore = MATCH_FLOOR;

    for (const entry of registry) {
        const score = scoreCandidate(targetType, targetLivery, {
            manufacturer: clean(entry.manufacturer),
            model: clean(entry.model),
            livery: clean(entry.livery),
        }, useFuzzy);
        if (score > bestScore) {
            bestScore = score;
            best = entry;
        }
    }

    return best ? { entry: best, score: bestScore } : null;
};

/**
 * Best match from a list of community-aircraft docs (plain objects with
 * aircraftType / liveryName / imageUrl / imageUrls / tailNumber).
 * @returns {{ doc: object, score: number } | null}
 */
const matchCommunity = (docs, aircraftType, liveryName) => {
    if (!Array.isArray(docs) || docs.length === 0) return null;

    const targetType = clean(aircraftType);
    const targetLivery = clean(liveryName);
    if (!targetType || !targetLivery) return null;

    const useFuzzy = targetType.length > 3 && targetLivery.length > 3;

    let best = null;
    let bestScore = MATCH_FLOOR;

    for (const doc of docs) {
        // Only consider docs that actually carry an image.
        const hasImage = doc.imageUrl || (Array.isArray(doc.imageUrls) && doc.imageUrls.length);
        if (!hasImage) continue;

        const score = scoreCandidate(targetType, targetLivery, {
            manufacturer: '', // community docs store a combined type only
            model: clean(doc.aircraftType),
            livery: clean(doc.liveryName),
        }, useFuzzy);
        if (score > bestScore) {
            bestScore = score;
            best = doc;
        }
    }

    return best ? { doc: best, score: bestScore } : null;
};

/** Normalize a registry entry into the shared response shape. */
const registryToResult = (entry, score) => ({
    imageUrl: entry.image || null,
    imageUrls: entry.image ? [entry.image] : [],
    aircraftType: [entry.manufacturer, entry.model].filter(Boolean).join(' ').trim() || entry.model || '',
    liveryName: entry.livery || '',
    registration: entry.registration || null,
    source: 'registry',
    matchScore: Math.round(score),
    isPlaceholder: false,
});

/** Normalize a community doc into the shared response shape. */
const communityToResult = (doc, score) => {
    const imageUrls = (Array.isArray(doc.imageUrls) && doc.imageUrls.length)
        ? doc.imageUrls
        : (doc.imageUrl ? [doc.imageUrl] : []);
    return {
        imageUrl: doc.imageUrl || imageUrls[0] || null,
        imageUrls,
        aircraftType: doc.aircraftType || '',
        liveryName: doc.liveryName || '',
        registration: doc.tailNumber || null,
        contributorName: doc.contributorName || 'System',
        source: 'community',
        matchScore: Math.round(score),
        isPlaceholder: false,
    };
};

module.exports = {
    clean,
    getSimilarity,
    matchRegistry,
    matchCommunity,
    registryToResult,
    communityToResult,
    MATCH_FLOOR,
};

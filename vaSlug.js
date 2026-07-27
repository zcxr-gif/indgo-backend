// vaSlug.js
// The rules for a VA's Crew Center handle — inflight.info/crew/<slug>.
//
// Extracted from the model so the pre-save hook and the backfill script derive
// handles the same way. If these ever disagree, a VA's crew center address
// changes underneath its members, so there is deliberately one copy.
//
// Treat slugifyVaName as frozen: every stored slug is a live URL, and any
// change to these rules silently re-points existing crew centers the next time
// their VA is saved.

'use strict';

// Turn a VA name (or a staff-typed handle) into a URL-safe Crew Center slug:
// lowercase, accents stripped, non-alphanumerics collapsed to single hyphens.
// "Air Canada Virtual" -> "air-canada-virtual".
function slugifyVaName(s) {
    return String(s || '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .toLowerCase()
        .replace(/[’'".]/g, '')        // drop apostrophes / quotes / dots outright
        .replace(/[^a-z0-9]+/g, '-')   // any other run of non-alnum -> one hyphen
        .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
        .slice(0, 40);
}

/**
 * The handle a VA should own: its staff-set slug if it has one, otherwise one
 * derived from its name, suffixed -2, -3, … until it is free.
 *
 * @param {string} preferred  a staff-typed handle, or '' to derive from the name
 * @param {string} name       the VA's name
 * @param {(slug: string) => Promise<boolean>} isTaken  true if another VA holds it
 * @returns {Promise<string|null>} the free handle, or null if nothing usable
 */
async function deriveUniqueVaSlug(preferred, name, isTaken) {
    let base = preferred ? slugifyVaName(preferred) : '';
    if (!base && name) base = slugifyVaName(name);
    if (!base) return null;
    let candidate = base;
    for (let n = 2; await isTaken(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
}

module.exports = { slugifyVaName, deriveUniqueVaSlug };

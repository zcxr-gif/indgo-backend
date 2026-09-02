'use strict';

/*
 * vaIdentity.js
 * Who an airline is, in the smallest shape a page needs to SHOW one.
 *
 * WHY THIS EXISTS
 * ---------------
 * A dozen surfaces name a VA — the staff leaderboard, the submissions queue,
 * the activity feed, the warnings list, what's airborne right now — and every
 * one of them had learned the same lazy habit: store a `vaName` string on the
 * row at write time and print it. That is fine until you want to show the
 * airline's MARK next to its name, at which point every one of those surfaces
 * needs a logo it never carried and a lookup it never did.
 *
 * So the lookup lives here, once, batched. Rows keep their denormalized
 * `vaName` (it is the honest record of what the feed called this VA at the
 * time, and it survives a listing being deleted); this module adds a `va`
 * object alongside it with the CURRENT branding, or leaves it null when the
 * listing is gone. A name that no longer resolves still prints — see the
 * monogram fallback in assets/va-chip.js — it just prints without a picture.
 *
 * THE SHAPE
 * ---------
 *   { id, name, code, slug, logoUrl }
 *
 * `code` is the primary callsign (BAW, IGO) because that is what fits in a
 * badge; `slug` is there so a chip can link to the VA's crew center without
 * the caller doing a second lookup. Nothing else belongs in here — this is the
 * identity, not the listing. Anything that needs hubs or a description should
 * fetch the listing.
 *
 * NO REQUIRES BEYOND MONGOOSE. Read the model off mongoose.models the way
 * vaStats.js does, so this file can be pulled into server.js, vaPortal.js and
 * vaStats.js without any of them having to hand it a model — and so requiring
 * it before the schemas are registered is not a crash.
 */

const mongoose = require('mongoose');

// The only fields an identity is made of. Kept as a projection string so every
// caller fetches exactly this much and no more.
const IDENTITY_SELECT = '_id name callsign slug logoUrl';

/* ---------------------------------------------------------------------------
 * The cache
 * -------------------------------------------------------------------------
 * Logos change roughly never, and the staff dashboard re-polls its lists every
 * few seconds. Holding identities for a few minutes turns that into one query
 * per VA per TTL instead of one per poll. Writes that change branding call
 * forgetVaIdentity() so the change is visible immediately rather than at the
 * end of the TTL — a VA that uploads a logo and doesn't see it is a support
 * ticket.
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // id -> { at, identity|null }

function forgetVaIdentity(id) {
    if (id) cache.delete(String(id));
    else cache.clear();
}

/**
 * A listing (lean doc or mongoose doc) as an identity. Returns null for
 * anything that isn't one, so callers can pass a possibly-missing doc straight
 * in.
 */
function vaIdentity(ad) {
    if (!ad || !ad._id) return null;
    return {
        id: String(ad._id),
        name: ad.name || '',
        code: ad.callsign || '',
        slug: ad.slug || '',
        logoUrl: ad.logoUrl || '',
    };
}

/**
 * Identities for a set of listing ids, in one query. Ids already cached are
 * not re-fetched; ids with no listing are cached as a miss so a feed full of
 * references to a deleted VA doesn't re-query on every poll.
 *
 * @param {Array} ids  anything stringifiable; duplicates and blanks are fine
 * @returns {Promise<Map<string, object|null>>}
 */
async function identityMap(ids) {
    const out = new Map();
    const wanted = new Set();
    const now = Date.now();

    for (const raw of ids || []) {
        if (!raw) continue;
        const id = String(raw);
        const hit = cache.get(id);
        if (hit && now - hit.at < TTL_MS) out.set(id, hit.identity);
        else wanted.add(id);
    }
    if (!wanted.size) return out;

    const Model = mongoose.models.VirtualAirlineAd;
    // No model registered (or no database) is not an error here — it means
    // every chip falls back to its monogram, which is exactly what should
    // happen when we cannot answer the question.
    if (!Model) {
        for (const id of wanted) out.set(id, null);
        return out;
    }

    let docs = [];
    try {
        docs = await Model.find({ _id: { $in: [...wanted] } }).select(IDENTITY_SELECT).lean();
    } catch (err) {
        // A bad ObjectId in the list, or the database being down, must not take
        // a page with it. Same reasoning as above: no logo, name still prints.
        console.error('[va-identity] lookup failed:', err.message);
        for (const id of wanted) out.set(id, null);
        return out;
    }

    for (const doc of docs) {
        const identity = vaIdentity(doc);
        cache.set(identity.id, { at: now, identity });
        out.set(identity.id, identity);
        wanted.delete(identity.id);
    }
    // Whatever is left had no listing. Cache the miss.
    for (const id of wanted) {
        cache.set(id, { at: now, identity: null });
        out.set(id, null);
    }
    return out;
}

/**
 * Stamp `va` onto every row that names a VA, in one query for the whole list.
 *
 * @param {object[]} rows
 * @param {object}  [opts]
 * @param {string}  [opts.idKey='vaAdId']  where the listing id lives on a row
 * @param {string}  [opts.key='va']        where to put the identity
 * @param {string}  [opts.nameKey='vaName'] fallback name for rows whose listing
 *        is gone — the row still gets a `va` with a name and no logo, so the
 *        UI has one shape to render rather than two.
 * @returns {Promise<object[]>} the same array, mutated
 */
async function attachVaIdentity(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return list;
    const idKey = opts.idKey || 'vaAdId';
    const key = opts.key || 'va';
    const nameKey = opts.nameKey === undefined ? 'vaName' : opts.nameKey;

    const map = await identityMap(list.map(r => r && r[idKey]));
    for (const row of list) {
        if (!row) continue;
        const found = row[idKey] ? map.get(String(row[idKey])) : null;
        if (found) { row[key] = found; continue; }
        // Unmatched, or matched to a listing that no longer exists. Keep the
        // name the feed recorded so the row still says which airline it meant.
        const fallbackName = nameKey ? (row[nameKey] || '') : '';
        row[key] = fallbackName ? { id: '', name: fallbackName, code: '', slug: '', logoUrl: '' } : null;
    }
    return list;
}

module.exports = { IDENTITY_SELECT, vaIdentity, identityMap, attachVaIdentity, forgetVaIdentity };

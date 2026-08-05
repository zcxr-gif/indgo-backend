'use strict';

/*
 * routeMapCache.js — the memo in front of the public route-map renderer.
 *
 * GET /api/route-map is unauthenticated and is fetched by link-preview
 * crawlers, which means the traffic shape is "twenty requests for the identical
 * image within two seconds of a link being posted, then nothing for an hour".
 * Rendering each of those separately would be pure waste, and worse than waste:
 * route-map renders share a process-wide single-slot queue with Discord webhook
 * card delivery (see queueRender in vaEventCardImage.js), so a miss storm sits
 * in front of real flight events.
 *
 * Three behaviours, in the order they matter:
 *
 *   1. LRU with a TTL — the same URL renders once and is served from memory
 *      until it expires. Callers pick the TTL, because a map with a live
 *      aircraft dot on it goes stale in minutes while bare route geometry does
 *      not change at all.
 *   2. In-flight de-duplication — concurrent misses on the SAME key await one
 *      render rather than queueing one each. This is the property that actually
 *      protects the render queue, since a crawler burst is by definition
 *      simultaneous and would all miss the cache together.
 *   3. Load shedding — past a ceiling of distinct in-flight renders, `run`
 *      reports that the caller should shed rather than adding to the queue.
 *
 * Deliberately in-memory and per-process: it is a cache, an empty one is only
 * slower, and a restart losing it costs one render per hot key.
 */

class RouteMapCache {
    /**
     * @param {object} [o]
     * @param {number} [o.max]         entries retained before the coldest is dropped
     * @param {number} [o.maxInflight] distinct renders allowed to be running at once
     */
    constructor({ max = 300, maxInflight = 4 } = {}) {
        this.max = max;
        this.maxInflight = maxInflight;
        this._entries = new Map();  // key -> { value, expires }
        this._inflight = new Map(); // key -> Promise
    }

    get size() { return this._entries.size; }
    get inflight() { return this._inflight.size; }

    /**
     * A live entry, or null when absent or expired.
     * A hit is re-inserted so insertion order stays recency order — that is what
     * makes the eviction below drop the coldest key rather than the oldest one.
     */
    get(key, now = Date.now()) {
        const hit = this._entries.get(key);
        if (!hit) return null;
        if (hit.expires <= now) { this._entries.delete(key); return null; }
        this._entries.delete(key);
        this._entries.set(key, hit);
        return hit.value;
    }

    set(key, value, ttlMs, now = Date.now()) {
        // Re-set has to delete first, or the existing key keeps its original
        // position and a hot entry could be evicted while cold ones survive.
        this._entries.delete(key);
        this._entries.set(key, { value, expires: now + ttlMs });
        while (this._entries.size > this.max) {
            const coldest = this._entries.keys().next().value;
            if (coldest === undefined) break;
            this._entries.delete(coldest);
        }
        return value;
    }

    /**
     * Resolve `key`, rendering through `produce` only when there is no live
     * entry and no identical render already running.
     *
     * `ttlFor(value)` picks the lifetime from the produced value so a caller can
     * cache a hit and, say, decline to cache a miss.
     *
     * @returns {Promise<{value: *, status: 'hit'|'miss'|'joined'|'shed'}>}
     *   `shed` means the ceiling was reached and nothing was rendered; `joined`
     *   means this call awaited a render someone else had already started.
     */
    async run(key, produce, ttlFor) {
        const cached = this.get(key);
        if (cached !== null) return { value: cached, status: 'hit' };

        const running = this._inflight.get(key);
        if (running) return { value: await running, status: 'joined' };

        if (this._inflight.size >= this.maxInflight) {
            return { value: null, status: 'shed' };
        }

        // The stored promise must never reject: every waiter awaits this exact
        // promise, and one rejection would surface as an unhandled rejection in
        // whichever waiter happened not to be inside a try.
        const pending = Promise.resolve()
            .then(produce)
            .catch(() => null)
            .finally(() => this._inflight.delete(key));
        this._inflight.set(key, pending);

        const value = await pending;
        const ttl = ttlFor ? ttlFor(value) : 0;
        if (value !== null && value !== undefined && ttl > 0) this.set(key, value, ttl);
        return { value, status: 'miss' };
    }

    clear() {
        this._entries.clear();
        this._inflight.clear();
    }
}

module.exports = { RouteMapCache };

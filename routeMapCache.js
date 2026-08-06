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
 *
 * WHY IT IS BOUNDED IN BYTES AS WELL AS IN ENTRIES
 * -----------------------------------------------
 * What this holds is PNG Buffers, and they are not all the same size. A route
 * map is mostly flat colour and lines; an IFC profile card carrying a
 * photograph of an aircraft is a lossless encoding of a photograph, which is
 * three orders of magnitude bigger — measured, 6 KB against 1.1 MB.
 *
 * An `max`-entries-only bound therefore does not bound memory at all. 200 cards
 * is either 1 MB or 200 MB depending on which pilots were viewed, and the
 * difference is invisible from here. Worse, Buffers live in Node's EXTERNAL
 * memory, outside the V8 heap: `--max-old-space-size` does not cap them,
 * `--expose-gc` cannot reclaim them while they are referenced, and the process
 * is killed by the container's memory limit rather than by a heap error, so
 * there is no stack to find afterwards. The failure looks like "it ran fine for
 * hours and then died", because it fills as distinct keys are viewed.
 *
 * So a caller may set `maxBytes` and the coldest entries are dropped until the
 * total fits. Entry count stays as a second, independent ceiling — it is the
 * cheaper guard and it still protects against a flood of tiny values.
 *
 * WHY EXPIRED ENTRIES ARE SWEPT
 * -----------------------------
 * `get` drops an entry it finds expired, which is enough for correctness — a
 * stale value is never served. It is not enough for MEMORY: an entry nobody
 * asks for again is never looked at again, so its bytes were held until the
 * entry count happened to overflow. A cache with a ten-minute TTL was keeping
 * its full complement of buffers resident hours after the traffic stopped.
 * `set` now sweeps, which costs one bounded pass on the only path that grows
 * the cache.
 */

/**
 * How many bytes a cached value occupies.
 *
 * Buffers and TypedArrays report their real length; anything else reports 0,
 * which makes the byte budget inert for a caller that stores something else and
 * keeps this class general. A caller with objects worth weighing passes its own.
 */
const defaultSizeOf = (v) => {
    if (v == null) return 0;
    if (Buffer.isBuffer(v)) return v.length;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (v instanceof ArrayBuffer) return v.byteLength;
    return 0;
};

class RouteMapCache {
    /**
     * @param {object} [o]
     * @param {number} [o.max]         entries retained before the coldest is dropped
     * @param {number} [o.maxInflight] distinct renders allowed to be running at once
     * @param {number} [o.maxBytes]    total bytes retained before the coldest is
     *                                 dropped. 0 disables the byte bound, which is
     *                                 the old behaviour.
     * @param {function} [o.sizeOf]    how to weigh a value; defaults to Buffer length
     */
    constructor({ max = 300, maxInflight = 4, maxBytes = 0, sizeOf = defaultSizeOf } = {}) {
        this.max = max;
        this.maxInflight = maxInflight;
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        this.sizeOf = typeof sizeOf === 'function' ? sizeOf : defaultSizeOf;
        this._entries = new Map();  // key -> { value, expires, bytes }
        this._inflight = new Map(); // key -> Promise
        this._bytes = 0;
        // Counters, so a container that is still dying has something to look at.
        this._evicted = 0;
        this._swept = 0;
    }

    get size() { return this._entries.size; }
    get inflight() { return this._inflight.size; }
    get bytes() { return this._bytes; }

    /** What this cache is holding. For a health endpoint or a log line. */
    stats() {
        return {
            entries: this._entries.size,
            bytes: this._bytes,
            max: this.max,
            maxBytes: this.maxBytes,
            inflight: this._inflight.size,
            evicted: this._evicted,
            swept: this._swept,
        };
    }

    /** Forget one key, keeping the byte total honest. */
    _drop(key) {
        const hit = this._entries.get(key);
        if (!hit) return false;
        this._bytes -= hit.bytes;
        this._entries.delete(key);
        // Floated back to zero rather than allowed to drift negative if a caller's
        // sizeOf is not stable across calls.
        if (this._bytes < 0) this._bytes = 0;
        return true;
    }

    /** Drop everything already past its TTL. One bounded pass; see the header. */
    _sweep(now = Date.now()) {
        for (const [key, hit] of this._entries) {
            if (hit.expires <= now) { this._drop(key); this._swept += 1; }
        }
    }

    /**
     * A live entry, or null when absent or expired.
     * A hit is re-inserted so insertion order stays recency order — that is what
     * makes the eviction below drop the coldest key rather than the oldest one.
     */
    get(key, now = Date.now()) {
        const hit = this._entries.get(key);
        if (!hit) return null;
        if (hit.expires <= now) { this._drop(key); return null; }
        this._entries.delete(key);
        this._entries.set(key, hit);
        return hit.value;
    }

    set(key, value, ttlMs, now = Date.now()) {
        // Re-set has to delete first, or the existing key keeps its original
        // position and a hot entry could be evicted while cold ones survive.
        // Through _drop, so the outgoing value's bytes come off the total.
        this._drop(key);

        // Before measuring the newcomer against the budget, let go of anything
        // already dead. Otherwise a cache full of expired-but-unread entries
        // evicts LIVE ones to make room, which is the wrong thing to throw away.
        this._sweep(now);

        const bytes = Math.max(0, Number(this.sizeOf(value)) || 0);
        this._entries.set(key, { value, expires: now + ttlMs, bytes });
        this._bytes += bytes;

        // Both ceilings, coldest-first. `size > 1` guards the case of a single
        // value larger than the whole budget: it is kept, because evicting the
        // thing just rendered would mean never caching it and re-rendering it on
        // every request — the opposite of what a cache is for. The budget is a
        // target for the steady state, not a hard cap on one entry.
        while (this._entries.size > this.max
               || (this.maxBytes > 0 && this._bytes > this.maxBytes && this._entries.size > 1)) {
            const coldest = this._entries.keys().next().value;
            if (coldest === undefined) break;
            this._drop(coldest);
            this._evicted += 1;
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
        this._bytes = 0;
    }
}

module.exports = { RouteMapCache, defaultSizeOf };

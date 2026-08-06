'use strict';
// test-route-map.js
//
// The public route-map image: the renderer changes that let it serve a link
// preview, and the cache that stops it from starving webhook delivery.
//
// Two things here are easy to get wrong and impossible to see by looking:
//
//   * The route map is also the image posted under every Discord card. Adding
//     an output size and caller-supplied endpoints must leave that path byte-
//     for-byte alone, so the default render is asserted at its original 1200x420.
//   * Route-map renders share a process-wide single-slot queue with webhook
//     card delivery. If the cache ever fails to de-duplicate a burst, a flight
//     event queues behind a pile of crawler requests. That property is asserted
//     directly rather than assumed.
//
// No DB and no network. Needs `sharp` (already a dependency) to read back the
// dimensions of what was rendered.
//
// Run:  node scratchpad/test-route-map.js
const path = require('path');
const sharp = require('sharp');
const { normalizeCardOptions } = require(path.join('..', 'vaEventCard.js'));
const { renderVaRouteMapImage } = require(path.join('..', 'vaEventCardImage.js'));
const { RouteMapCache } = require(path.join('..', 'routeMapCache.js'));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { console.log(`  ✓ ${name}`); pass++; }
    else { console.log(`  ✗ ${name}${extra ? `  (${extra})` : ''}`); fail++; }
};
const head = (s) => console.log(`\n${s}`);

const EGLL = [51.4775, -0.4614];
const KJFK = [40.6413, -73.7781];
const size = async (buf) => { const m = await sharp(buf).metadata(); return `${m.width}x${m.height}`; };

(async () => {
    // ------------------------------------------------------------------
    head('Option validation');
    ok('mapSize defaults to the Discord banner', normalizeCardOptions({}).mapSize === 'banner');
    ok('og is accepted', normalizeCardOptions({ mapSize: 'og' }).mapSize === 'og');
    ok('an unknown size falls back rather than throwing',
        normalizeCardOptions({ mapSize: 'billboard' }).mapSize === 'banner');
    ok('map styles still validate', normalizeCardOptions({ mapStyle: 'midnight' }).mapStyle === 'midnight');
    ok('an unknown style falls back to dark',
        normalizeCardOptions({ mapStyle: 'neon' }).mapStyle === 'dark');

    // ------------------------------------------------------------------
    head('Rendering');
    const ev = { departureIcao: 'EGLL', arrivalIcao: 'KJFK', position: { lat: 53, lon: -30 } };

    const banner = await renderVaRouteMapImage(ev, {});
    ok('the default render is unchanged at 1200x420', await size(banner) === '1200x420', await size(banner));

    const og = await renderVaRouteMapImage(ev, { mapSize: 'og' });
    ok('the og render is 1200x630', await size(og) === '1200x630', await size(og));

    const styled = await renderVaRouteMapImage(ev, { mapSize: 'og', mapStyle: 'light' });
    ok('a different palette produces a different image', !styled.equals(og));
    ok('every palette renders',
        (await Promise.all(['dark', 'midnight', 'light', 'mono'].map(
            s => renderVaRouteMapImage(ev, { mapStyle: s })))).every(b => b && b.length > 0));

    // ------------------------------------------------------------------
    head('Caller-supplied endpoints');
    // data/airport-coords.json holds ~5,900 fields. The tracker knows every ICAO
    // in airports.json, so it can map routes this module would have to refuse.
    const unknown = { departureIcao: 'ZZZZ', arrivalIcao: 'YYYY' };
    ok('an unknown pair is unmappable on its own', (await renderVaRouteMapImage(unknown, {})) === null);
    ok('the same pair maps when the caller supplies coordinates',
        !!(await renderVaRouteMapImage({ ...unknown, depCoords: EGLL, arrCoords: KJFK }, {})));

    // The corner chip reads the distance off whatever coordinates are drawn, so
    // an overridden pair must not silently lose it.
    const overridden = await renderVaRouteMapImage({ ...unknown, depCoords: EGLL, arrCoords: KJFK }, {});
    const named = await renderVaRouteMapImage({ departureIcao: 'EGLL', arrivalIcao: 'KJFK' }, {});
    ok('an overridden route still renders a distance chip',
        overridden.length > 0 && Math.abs(overridden.length - named.length) / named.length < 0.35,
        `${overridden.length} vs ${named.length}`);

    head('Rejecting bad coordinates');
    for (const [label, dep, arr] of [
        ['out-of-range latitude', [999, 0], KJFK],
        ['out-of-range longitude', EGLL, [0, 999]],
        ['a single number', 51.4, KJFK],
        ['a short array', [51.4], KJFK],
        ['strings', ['51.4', '-0.46'], KJFK],
        ['null', null, KJFK],
    ]) {
        // Bad overrides fall back to the index, which does not know ZZZZ/YYYY,
        // so the render must come back null rather than drawing a bogus point.
        const out = await renderVaRouteMapImage({ ...unknown, depCoords: dep, arrCoords: arr }, {});
        ok(`${label} is refused`, out === null, out ? `${out.length} bytes` : '');
    }

    // ------------------------------------------------------------------
    head('Cache: hits and expiry');
    {
        const c = new RouteMapCache({ max: 3 });
        let renders = 0;
        const produce = async () => { renders++; return Buffer.from('x'); };

        const a = await c.run('k1', produce, () => 1000);
        ok('a cold key renders', a.status === 'miss' && renders === 1);
        const b = await c.run('k1', produce, () => 1000);
        ok('a warm key does not', b.status === 'hit' && renders === 1);

        c.set('k2', Buffer.from('y'), -1);
        ok('an expired entry is a miss, not a stale hit', c.get('k2') === null);
    }

    head('Cache: eviction');
    {
        const c = new RouteMapCache({ max: 3 });
        for (const k of ['a', 'b', 'c']) c.set(k, Buffer.from(k), 10_000);
        c.get('a');                                   // 'a' is now the most recent
        c.set('d', Buffer.from('d'), 10_000);         // pushes past max
        ok('the cache holds its ceiling', c.size === 3, String(c.size));
        ok('the coldest entry is evicted', c.get('b') === null);
        ok('a recently read entry survives', c.get('a') !== null);
        ok('the newest entry is kept', c.get('d') !== null);

        c.set('a', Buffer.from('a2'), 10_000);
        c.set('e', Buffer.from('e'), 10_000);
        ok('re-setting a key refreshes its recency', c.get('a') !== null);
    }

    head('Cache: the byte budget');
    {
        // What this cache actually holds is PNG Buffers, and they are nowhere near
        // uniform: a route map is flat colour and lines, an IFC card carrying a
        // photograph is a lossless encoding of a photograph. Measured, 6 KB
        // against 1.1 MB. So an entry-count ceiling does not bound MEMORY at all,
        // and these buffers live in Node's external memory where the heap limit
        // cannot reach them and the container's limit kills the process instead.
        const KB = (n) => Buffer.alloc(n * 1024);
        const c = new RouteMapCache({ max: 100, maxBytes: 100 * 1024 });

        c.set('a', KB(40), 10_000);
        c.set('b', KB(40), 10_000);
        ok('bytes are counted as entries land', c.bytes === 80 * 1024, String(c.bytes));

        c.set('c', KB(40), 10_000);
        ok('the byte budget evicts, though the entry count is nowhere near max',
            c.bytes <= 100 * 1024, String(c.bytes));
        ok('…coldest first', c.get('a') === null);
        ok('…and the newest survives', c.get('c') !== null);
        ok('the entry count reflects the eviction', c.size === 2, String(c.size));

        // The case that would make the cache useless: one value bigger than the
        // whole budget. Evicting it would mean never caching it, and re-rendering
        // it on every single request — the opposite of the point.
        const big = new RouteMapCache({ max: 10, maxBytes: 10 * 1024 });
        big.set('huge', KB(500), 10_000);
        ok('a single value over the whole budget is still kept',
            big.get('huge') !== null, String(big.bytes));
        big.set('small', KB(1), 10_000);
        ok('…and is the first thing dropped when anything else arrives',
            big.get('huge') === null && big.get('small') !== null);

        // Re-setting a key must not double-count, or the total drifts up until the
        // cache evicts everything and the budget silently becomes zero.
        const re = new RouteMapCache({ max: 10, maxBytes: 1024 * 1024 });
        re.set('k', KB(10), 10_000);
        re.set('k', KB(10), 10_000);
        re.set('k', KB(10), 10_000);
        ok('re-setting a key does not double-count its bytes',
            re.bytes === 10 * 1024, String(re.bytes));

        const off = new RouteMapCache({ max: 2 });
        off.set('a', KB(500), 10_000);
        off.set('b', KB(500), 10_000);
        ok('with no maxBytes the byte bound is inert (old behaviour)',
            off.size === 2 && off.bytes === 1000 * 1024);

        const strings = new RouteMapCache({ max: 10, maxBytes: 1024 });
        strings.set('s', 'not a buffer', 10_000);
        ok('a non-Buffer value weighs nothing rather than throwing',
            strings.get('s') === 'not a buffer' && strings.bytes === 0);
    }

    head('Cache: sweeping what has expired');
    {
        // `get` drops an expired entry it happens to look at, which is enough for
        // correctness — a stale value is never served. It is not enough for
        // MEMORY: an entry nobody asks for again was never looked at again, so a
        // cache with a ten-minute TTL kept its full complement of buffers
        // resident hours after the traffic stopped.
        const KB = (n) => Buffer.alloc(n * 1024);
        const c = new RouteMapCache({ max: 100, maxBytes: 10 * 1024 * 1024 });
        // 20 entries written, every one already past its TTL. Because the sweep
        // runs on the write path, they cannot pile up in the first place: each
        // `set` clears the corpses left by the ones before it, so the cache never
        // holds more than the one just added.
        for (let i = 0; i < 20; i++) c.set(`dead${i}`, KB(50), -1);
        ok('dead entries never accumulate — 20 expired writes leave 1 behind',
            c.size === 1, String(c.size));
        ok('…so their bytes are not held either', c.bytes === 50 * 1024, String(c.bytes));

        c.set('live', KB(1), 10_000);
        ok('the last dead entry goes on the next write', c.size === 1, String(c.size));
        ok('…and its bytes are returned', c.bytes === 1024, String(c.bytes));
        ok('…leaving the live one alone', c.get('live') !== null);

        // The ordering that matters: dead entries must go BEFORE the budget starts
        // evicting, or a cache full of expired values throws away the live ones to
        // make room for the newcomer.
        const d = new RouteMapCache({ max: 100, maxBytes: 100 * 1024 });
        d.set('hot', KB(40), 10_000);
        for (let i = 0; i < 5; i++) d.set(`cold${i}`, KB(40), -1);
        d.set('new', KB(40), 10_000);
        ok('the live entry survives a cache full of expired ones',
            d.get('hot') !== null && d.get('new') !== null, JSON.stringify(d.stats()));

        ok('stats report what is held', (() => {
            const st = d.stats();
            return typeof st.entries === 'number' && typeof st.bytes === 'number'
                && st.maxBytes === 100 * 1024 && st.swept >= 5;
        })(), JSON.stringify(d.stats()));

        const cl = new RouteMapCache({ max: 10, maxBytes: 1024 * 1024 });
        cl.set('x', KB(10), 10_000);
        cl.clear();
        ok('clear() resets the byte total too', cl.size === 0 && cl.bytes === 0);
    }

    head('Cache: de-duplicating a crawler burst');
    {
        const c = new RouteMapCache({ max: 10, maxInflight: 4 });
        let renders = 0;
        let release;
        const gate = new Promise((r) => { release = r; });
        const slow = async () => { renders++; await gate; return Buffer.from('img'); };

        // Twenty simultaneous requests for one link, which is what actually
        // happens the moment a flight is pasted into a chat.
        const burst = Array.from({ length: 20 }, () => c.run('hot', slow, () => 1000));
        await new Promise((r) => setImmediate(r));
        ok('a burst on one key starts exactly one render', renders === 1, String(renders));
        ok('only one render is counted as in flight', c.inflight === 1, String(c.inflight));

        release();
        const results = await Promise.all(burst);
        ok('every caller in the burst is served', results.every(r => r.value && r.value.toString() === 'img'));
        ok('the burst still only rendered once', renders === 1, String(renders));
        ok('the waiters report that they joined',
            results.filter(r => r.status === 'joined').length === 19,
            String(results.filter(r => r.status === 'joined').length));
        ok('the in-flight set drains', c.inflight === 0, String(c.inflight));
    }

    head('Cache: shedding past the ceiling');
    {
        const c = new RouteMapCache({ max: 10, maxInflight: 2 });
        let release;
        const gate = new Promise((r) => { release = r; });
        const slow = async () => { await gate; return Buffer.from('img'); };

        const p1 = c.run('a', slow, () => 1000);
        const p2 = c.run('b', slow, () => 1000);
        await new Promise((r) => setImmediate(r));
        const shed = await c.run('c', slow, () => 1000);
        ok('a third distinct key is shed, not queued', shed.status === 'shed' && shed.value === null);

        release();
        await Promise.all([p1, p2]);
        ok('shedding is temporary — the key works once there is room',
            (await c.run('c', async () => Buffer.from('img'), () => 1000)).status === 'miss');
    }

    head('Cache: a failing render never poisons its waiters');
    {
        const c = new RouteMapCache({ max: 10 });
        const boom = async () => { throw new Error('render exploded'); };
        const results = await Promise.all([c.run('bad', boom, () => 1000), c.run('bad', boom, () => 1000)]);
        ok('a throwing render resolves to null instead of rejecting',
            results.every(r => r.value === null));
        ok('a failed render is not cached', c.get('bad') === null);
        ok('the in-flight set drains after a failure', c.inflight === 0);
    }

    head('Cache: misses are not cached');
    {
        const c = new RouteMapCache({ max: 10 });
        let renders = 0;
        // ttlFor returns 0 for a null value, exactly as the endpoint does.
        const produce = async () => { renders++; return null; };
        await c.run('m', produce, (v) => (v ? 1000 : 0));
        await c.run('m', produce, (v) => (v ? 1000 : 0));
        ok('an unmappable route is re-attempted rather than cached as a 404', renders === 2, String(renders));
    }

    // ------------------------------------------------------------------
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

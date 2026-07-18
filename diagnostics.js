// ===========================================================================
// diagnostics.js — live backend introspection for the "why did it crash / what
// is eating memory & CPU / what has an irregular rhythm" terminal.
//
// Design constraints (a diagnostics tool must not become the load it measures):
//   • One unref'd sampler interval; fixed-size ring buffers (no unbounded growth).
//   • Event-loop delay is read from perf_hooks' native histogram — the kernel/V8
//     does the accounting, we just read percentiles. This is the single most
//     honest signal for "irregular rhythm": a healthy loop sits near 0ms; GC
//     pauses, sync file reads, big JSON.parse, or CPU starvation show up as p99
//     and max spikes.
//   • Route timing is O(1) per request (a finish listener + counters).
//   • Everything is best-effort and guarded — diagnostics must never throw into
//     a request or take the process down.
// ===========================================================================

const { monitorEventLoopDelay, PerformanceObserver, constants } = require('perf_hooks');

const HISTORY = 120;          // samples kept per series (@5s = last 10 min)
const SAMPLE_MS = 5000;       // memory / cpu / handle sampling cadence
const RECENT_DURATIONS = 50;  // per-route rolling window for p95

const state = {
    startedAt: Date.now(),
    pid: process.pid,
    node: process.version,
    memoryLimitMb: 0,
    // ring buffers of { t, ... }
    mem: [],
    cpu: [],
    loop: [],
    handles: [],
    // GC accounting (cumulative since boot)
    gc: { count: 0, totalPauseMs: 0, maxPauseMs: 0, byKind: {} },
    // per-route metrics keyed by "METHOD path"
    routes: new Map(),
    // rolling request counter for req/min
    reqWindow: [],
    lastCpu: process.cpuUsage(),
    lastCpuAt: Date.now(),
    peakRssMb: 0,
    sources: new Map(), // name -> () => object
    loopHist: null,
    sampler: null,
};

const nowMb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY) arr.shift(); };

// --- event-loop delay histogram (nanoseconds) ------------------------------
function startLoopMonitor() {
    try {
        state.loopHist = monitorEventLoopDelay({ resolution: 10 });
        state.loopHist.enable();
    } catch (_) { state.loopHist = null; }
}

// --- GC observer -----------------------------------------------------------
function startGcObserver() {
    try {
        const kindName = {
            [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
            [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
            [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
            [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
        };
        const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const kind = kindName[entry.detail && entry.detail.kind] || 'other';
                state.gc.count += 1;
                state.gc.totalPauseMs += entry.duration;
                if (entry.duration > state.gc.maxPauseMs) state.gc.maxPauseMs = entry.duration;
                const b = state.gc.byKind[kind] || { count: 0, ms: 0 };
                b.count += 1; b.ms += entry.duration;
                state.gc.byKind[kind] = b;
            }
        });
        obs.observe({ entryTypes: ['gc'], buffered: false });
    } catch (_) { /* GC entries unavailable — non-fatal */ }
}

// --- periodic sampler ------------------------------------------------------
function sample() {
    const t = Date.now();
    const m = process.memoryUsage();
    const rssMb = nowMb(m.rss);
    if (rssMb > state.peakRssMb) state.peakRssMb = rssMb;
    push(state.mem, {
        t,
        rss: rssMb,
        heapUsed: nowMb(m.heapUsed),
        heapTotal: nowMb(m.heapTotal),
        external: nowMb(m.external),
        arrayBuffers: nowMb(m.arrayBuffers || 0),
    });

    // CPU: microseconds of user+system since last sample, as % of one core.
    const cu = process.cpuUsage(state.lastCpu);
    const wall = (t - state.lastCpuAt) || 1;
    const cpuPct = Math.round(((cu.user + cu.system) / 1000 / wall) * 100);
    state.lastCpu = process.cpuUsage();
    state.lastCpuAt = t;
    push(state.cpu, { t, pct: cpuPct });

    // Event-loop delay percentiles (ns -> ms).
    if (state.loopHist) {
        const ns2ms = (ns) => Math.round((ns / 1e6) * 100) / 100;
        push(state.loop, {
            t,
            mean: ns2ms(state.loopHist.mean),
            p50: ns2ms(state.loopHist.percentile(50)),
            p99: ns2ms(state.loopHist.percentile(99)),
            max: ns2ms(state.loopHist.max),
        });
        state.loopHist.reset();
    }

    // Active handles/requests — the classic leak tell. A steadily climbing
    // handle count (sockets, timers, streams never closed) precedes many OOMs.
    let handles = 0, requests = 0;
    try { handles = process._getActiveHandles().length; } catch (_) {}
    try { requests = process._getActiveRequests().length; } catch (_) {}
    push(state.handles, { t, handles, requests });
}

// --- express middleware: per-route timing ----------------------------------
function middleware() {
    return function diagnosticsMiddleware(req, res, next) {
        const start = process.hrtime.bigint();
        state.reqWindow.push(Date.now());
        res.on('finish', () => {
            try {
                const durMs = Number(process.hrtime.bigint() - start) / 1e6;
                // req.route is populated by the time 'finish' fires. The pattern
                // (e.g. /api/aircraft/:id) keeps cardinality bounded; params don't.
                const routePath = (req.route && req.route.path) || '(unmatched)';
                const key = `${req.method} ${req.baseUrl || ''}${routePath}`;
                let r = state.routes.get(key);
                if (!r) {
                    r = { key, count: 0, errors: 0, totalMs: 0, maxMs: 0, recent: [], lastAt: 0 };
                    state.routes.set(key, r);
                }
                r.count += 1;
                r.totalMs += durMs;
                if (durMs > r.maxMs) r.maxMs = durMs;
                if (res.statusCode >= 500) r.errors += 1;
                r.lastAt = Date.now();
                r.recent.push(durMs);
                if (r.recent.length > RECENT_DURATIONS) r.recent.shift();
            } catch (_) { /* never break the response */ }
        });
        next();
    };
}

const percentile = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
    return Math.round(s[idx] * 100) / 100;
};

// --- external sources (Discord client, Mongo, …) ---------------------------
function registerSource(name, fn) { state.sources.set(name, fn); }

function readSources() {
    const out = {};
    for (const [name, fn] of state.sources) {
        try { out[name] = fn(); } catch (e) { out[name] = { error: String(e && e.message || e) }; }
    }
    return out;
}

// --- anomaly detection: the "why could it crash / what's irregular" view ----
function detectAnomalies(snap) {
    const a = [];
    const cap = state.memoryLimitMb;
    const lastMem = snap.memory.current;
    const lastLoop = state.loop[state.loop.length - 1];
    const lastHandles = state.handles[state.handles.length - 1];

    if (cap && lastMem && lastMem.rss >= cap * 0.85) {
        a.push({ level: 'critical', signal: 'memory',
            msg: `RSS ${lastMem.rss}MB is ${Math.round((lastMem.rss / cap) * 100)}% of the ${cap}MB cap — OOM-kill risk.` });
    }
    // Heap-vs-RSS gap => native memory (libvips/sharp, Buffers) dominates; GC won't help.
    if (lastMem && (lastMem.rss - lastMem.heapTotal) > 250) {
        a.push({ level: 'warn', signal: 'native-memory',
            msg: `${Math.round(lastMem.rss - lastMem.heapTotal)}MB lives outside the V8 heap (native/Buffers) — likely image processing or arrayBuffers; --max-old-space-size won't bound this.` });
    }
    if (lastLoop && lastLoop.p99 >= 100) {
        a.push({ level: 'warn', signal: 'event-loop',
            msg: `Event-loop p99 delay ${lastLoop.p99}ms (max ${lastLoop.max}ms) — something is blocking the loop (sync I/O, big JSON.parse, or GC). This is the "irregular rhythm".` });
    }
    if (lastHandles && lastHandles.handles >= 200) {
        a.push({ level: 'warn', signal: 'handles',
            msg: `${lastHandles.handles} active handles — possible socket/timer/stream leak. Watch the trend, not the value.` });
    }
    // Handle growth trend across the window.
    if (state.handles.length >= 10) {
        const first = state.handles[0].handles;
        const last = state.handles[state.handles.length - 1].handles;
        if (last - first >= 50) {
            a.push({ level: 'warn', signal: 'handles-trend',
                msg: `Active handles grew ${first} → ${last} over the sampled window — a real leak keeps climbing and never settles.` });
        }
    }
    // Slow / error-prone routes.
    for (const r of snap.routes) {
        if (r.count >= 5 && r.p95 >= 1000) {
            a.push({ level: 'warn', signal: 'slow-route',
                msg: `${r.key}: p95 ${r.p95}ms over ${r.count} calls — a slow path that ties up the loop and memory under concurrency.` });
        }
        if (r.errors >= 3 && r.errors / r.count >= 0.2) {
            a.push({ level: 'warn', signal: 'route-errors',
                msg: `${r.key}: ${r.errors}/${r.count} responses were 5xx.` });
        }
    }
    // GC churn.
    const upMin = (Date.now() - state.startedAt) / 60000;
    if (upMin > 1 && state.gc.count / upMin > 60) {
        a.push({ level: 'info', signal: 'gc-churn',
            msg: `~${Math.round(state.gc.count / upMin)} GC/min — high allocation churn burns CPU; look at the busiest routes above.` });
    }
    if (!global.gc) {
        a.push({ level: 'info', signal: 'gc-exposed',
            msg: `global.gc is not exposed — launch with "node --expose-gc" so the memory janitor can release freed native memory.` });
    }
    if (!cap) {
        a.push({ level: 'info', signal: 'no-cap',
            msg: `MEMORY_LIMIT_MB is unset — cannot judge OOM proximity. Set it (and NODE_OPTIONS=--max-old-space-size) to ~the container cap.` });
    }
    return a;
}

// --- the snapshot the terminal renders -------------------------------------
function getSnapshot() {
    const routes = [...state.routes.values()].map(r => ({
        key: r.key,
        count: r.count,
        errors: r.errors,
        avgMs: r.count ? Math.round((r.totalMs / r.count) * 100) / 100 : 0,
        p95: percentile(r.recent, 95),
        maxMs: Math.round(r.maxMs * 100) / 100,
        lastAt: r.lastAt,
    })).sort((a, b) => (b.count * b.avgMs) - (a.count * a.avgMs)); // rank by total time cost

    const cutoff = Date.now() - 60000;
    while (state.reqWindow.length && state.reqWindow[0] < cutoff) state.reqWindow.shift();

    const current = state.mem[state.mem.length - 1] || null;
    const snap = {
        now: Date.now(),
        process: {
            pid: state.pid,
            node: state.node,
            uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
            memoryLimitMb: state.memoryLimitMb || null,
            gcExposed: !!global.gc,
            peakRssMb: state.peakRssMb,
            reqLastMin: state.reqWindow.length,
        },
        memory: { current, history: state.mem },
        cpu: { current: state.cpu[state.cpu.length - 1] || null, history: state.cpu },
        eventLoop: { current: state.loop[state.loop.length - 1] || null, history: state.loop },
        handles: { current: state.handles[state.handles.length - 1] || null, history: state.handles },
        gc: state.gc,
        routes,
        sources: readSources(),
    };
    snap.anomalies = detectAnomalies(snap);
    return snap;
}

function start({ memoryLimitMb = 0 } = {}) {
    if (state.sampler) return; // idempotent
    state.memoryLimitMb = memoryLimitMb || 0;
    startLoopMonitor();
    startGcObserver();
    sample(); // seed one immediately
    state.sampler = setInterval(sample, SAMPLE_MS);
    if (state.sampler.unref) state.sampler.unref(); // never keep the process alive
}

module.exports = { start, middleware, registerSource, getSnapshot };

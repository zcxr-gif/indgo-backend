// Peak RSS: streaming a big collection vs buffering it into one response.
// RSS is sampled on a timer, not per chunk (per-chunk sampling dominates).
//   node scratchpad/test-stream-memory.js streamed|buffered [N]
const http = require('http');

const STREAM_CHUNK_CHARS = 64 * 1024;
const streamJsonArray = async (res, query, { prefix = '', suffix = '' } = {}) => {
    const cursor = query.cursor();
    let started = false;
    // Documents are accumulated and written in ~64KB chunks rather than one
    // write per document. Writing each document separately is correct but
    // wasteful: every write is its own chunked-transfer framing and its own
    // trip through the socket, so a 60,000-document response became 60,000 of
    // them. Batching cuts that by two or three orders of magnitude while
    // keeping memory bounded — this buffer holds one chunk, not one response,
    // which is the entire distinction being drawn here.
    let buf = '';
    const flush = async (force) => {
        if (!buf || (!force && buf.length < STREAM_CHUNK_CHARS)) return;
        const chunk = buf;
        buf = '';
        if (!res.write(chunk)) {
            // The socket is full. Wait for it to drain before reading more
            // documents, so the cursor advances no faster than the client
            // consumes and memory stays flat on a slow connection.
            await new Promise((resolve) => res.once('drain', resolve));
        }
    };
    try {
        for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
            if (!started) {
                res.set('Content-Type', 'application/json; charset=utf-8');
                buf += `${prefix}[`;
                started = true;
            } else {
                buf += ',';
            }
            buf += JSON.stringify(doc);
            await flush(false);
        }
        if (!started) {
            res.set('Content-Type', 'application/json; charset=utf-8');
            buf += `${prefix}[`;
        }
        res.end(`${buf}]${suffix}`);
    } catch (err) {
        if (!started && !res.headersSent) throw err;
        console.error('Stream Error (response already started):', err?.message || err);
        res.destroy(err);
    } finally {
        try { await cursor.close(); } catch { /* already closed, or the socket went first */ }
    }
};

const mode = process.argv[2];
const N = Number(process.argv[3] || 80000);
const mb = (b) => Math.round(b / 1048576);

const mkDoc = (i) => ({
    _id: '65a1b2c3d4e5f60718293a' + String(i % 100).padStart(2, '0'),
    aircraftType: 'Boeing 737-800', liveryName: 'Some Airline Livery ' + i, tailNumber: 'G-ABC' + i,
    imageUrl: 'https://bucket.s3.eu-west-2.amazonaws.com/community-aircraft/tail-' + i + '.webp',
    imageUrls: ['https://bucket.s3.eu-west-2.amazonaws.com/community-aircraft/tail-' + i + '.webp'],
    imageContributors: [{ name: 'Contributor Name', id: null }], contributorName: 'Contributor Name',
    needsUpdate: false, uploadedAt: new Date('2026-03-04T05:06:07.008Z'),
});

// A generating cursor: never materialises the collection, so what is measured
// is the response path rather than the fixture.
const genQuery = () => ({
    cursor() { let i = 0; return { next: async () => (i < N ? mkDoc(i++) : null), close: async () => {} }; },
});

let writes = 0;
const srv = http.createServer(async (req, res) => {
    // Bare http responses have setHeader, not express's set(); and count the
    // actual socket writes so the batching claim is measured, not asserted.
    res.set = (k, v) => res.setHeader(k, v);
    const realWrite = res.write.bind(res);
    res.write = (c) => { writes++; return realWrite(c); };
    if (mode === 'streamed') { await streamJsonArray(res, genQuery()); return; }
    const all = [];
    for (let i = 0; i < N; i++) all.push(mkDoc(i));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(all));
});

srv.listen(0, () => {
    const base = process.memoryUsage().rss;
    let peak = base;
    const sampler = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 20);
    const t0 = Date.now();
    // `slow` throttles the reader once per received chunk — the shape of a
    // client on a bad connection, and the case where per-document writes turned
    // chunk COUNT into wall-clock time.
    const slow = process.argv[4] === 'slow';
    http.get({ port: srv.address().port, path: '/' }, (r) => {
        let bytes = 0;
        r.on('data', (c) => {
            bytes += c.length;
            if (slow) { r.pause(); setTimeout(() => r.resume(), 1); }
        });
        r.on('end', () => {
            clearInterval(sampler);
            console.log(`${mode.padEnd(9)} N=${N} body=${mb(bytes)}MB  RSS base=${mb(base)}MB peak=${mb(peak)}MB  growth=+${mb(peak - base)}MB  ${Date.now() - t0}ms  socketWrites=${writes}`);
            srv.close();
            process.exit(0);
        });
    });
});

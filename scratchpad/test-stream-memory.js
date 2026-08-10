// Peak RSS: streaming a big collection vs buffering it into one response.
// RSS is sampled on a timer, not per chunk (per-chunk sampling dominates).
//   node scratchpad/test-stream-memory.js streamed|buffered [N]
const http = require('http');

const streamJsonArray = async (res, query, { prefix = '', suffix = '' } = {}) => {
    const cursor = query.cursor();
    let started = false;
    try {
        for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
            if (!started) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.write(`${prefix}[`); started = true; }
            else res.write(',');
            if (!res.write(JSON.stringify(doc))) await new Promise((r) => res.once('drain', r));
        }
        if (!started) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.write(`${prefix}[`); }
        res.end(`]${suffix}`);
    } catch (err) { if (!started) throw err; res.destroy(err); }
    finally { try { await cursor.close(); } catch { /* noop */ } }
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

const srv = http.createServer(async (req, res) => {
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
    http.get({ port: srv.address().port, path: '/' }, (r) => {
        let bytes = 0;
        r.on('data', (c) => { bytes += c.length; });
        r.on('end', () => {
            clearInterval(sampler);
            console.log(`${mode.padEnd(9)} N=${N} body=${mb(bytes)}MB  RSS base=${mb(base)}MB peak=${mb(peak)}MB  growth=+${mb(peak - base)}MB  ${Date.now() - t0}ms`);
            srv.close();
            process.exit(0);
        });
    });
});

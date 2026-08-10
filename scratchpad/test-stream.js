// Verifies streamJsonArray is byte-identical to res.json(array), including the
// awkward cases: empty collections, unicode, Dates, ObjectIds, and a wrapper.
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');

// Same implementation as server.js (kept in sync by hand for this test).
const streamJsonArray = async (res, query, { prefix = '', suffix = '' } = {}) => {
    const cursor = query.cursor();
    let started = false;
    try {
        for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
            if (!started) { res.set('Content-Type', 'application/json; charset=utf-8'); res.write(`${prefix}[`); started = true; }
            else res.write(',');
            if (!res.write(JSON.stringify(doc))) await new Promise((r) => res.once('drain', r));
        }
        if (!started) { res.set('Content-Type', 'application/json; charset=utf-8'); res.write(`${prefix}[`); }
        res.end(`]${suffix}`);
    } catch (err) {
        if (!started && !res.headersSent) throw err;
        res.destroy(err);
    } finally { try { await cursor.close(); } catch {} }
};

// A fake Query/cursor over plain docs — exercises the same code path.
const fakeQuery = (docs) => ({
    cursor() { let i = 0; return { next: async () => (i < docs.length ? docs[i++] : null), close: async () => {} }; },
});

const get = (port, path) => new Promise((resolve) => {
    http.get({ port, path }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ body: b, type: r.headers['content-type'] })); });
});

(async () => {
    const docs = [
        { _id: new mongoose.Types.ObjectId(), name: 'Boeing 737', when: new Date('2026-01-02T03:04:05.678Z'), n: 1 },
        { _id: new mongoose.Types.ObjectId(), name: 'Airbus A350 — “é” \\ / <tag>', tags: ['a', 'b'], nested: { x: null, y: false } },
        { _id: new mongoose.Types.ObjectId(), name: 'Empty arrays', imageUrls: [], imageContributors: [] },
    ];

    const app = express();
    app.get('/buffered', (req, res) => res.json(docs));
    app.get('/streamed', async (req, res) => { await streamJsonArray(res, fakeQuery(docs)); });
    app.get('/buffered-empty', (req, res) => res.json([]));
    app.get('/streamed-empty', async (req, res) => { await streamJsonArray(res, fakeQuery([])); });
    app.get('/buffered-wrap', (req, res) => res.json({ data: docs }));
    app.get('/streamed-wrap', async (req, res) => { await streamJsonArray(res, fakeQuery(docs), { prefix: '{"data":', suffix: '}' }); });

    const srv = app.listen(0);
    const port = srv.address().port;
    let ok = true;
    for (const [a, b, label] of [['/buffered', '/streamed', 'populated'], ['/buffered-empty', '/streamed-empty', 'empty'], ['/buffered-wrap', '/streamed-wrap', 'wrapped']]) {
        const A = await get(port, a), B = await get(port, b);
        const same = A.body === B.body;
        if (!same) ok = false;
        console.log(`${label.padEnd(10)} identical: ${same}  (${A.body.length} bytes)`);
        if (!same) { console.log('  buffered:', A.body.slice(0, 200)); console.log('  streamed:', B.body.slice(0, 200)); }
        console.log(`${''.padEnd(10)} JSON.parse round-trips: ${JSON.stringify(JSON.parse(B.body)) === JSON.stringify(JSON.parse(A.body))}`);
    }
    srv.close();
    console.log(ok ? '\nALL IDENTICAL' : '\nMISMATCH');
    process.exit(ok ? 0 : 1);
})();

// Verifies streamJsonArray is byte-identical to res.json(array), including the
// awkward cases: empty collections, unicode, Dates, ObjectIds, and a wrapper.
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');

// Same implementation as server.js (kept in sync by hand for this test).
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
            //
            // 'close' is raced against 'drain' because a client that hangs up
            // while the socket is full never drains — and waiting on 'drain'
            // alone would then suspend this function forever, so the `finally`
            // below never runs and the cursor is never released. An abandoned
            // download is not exotic on these endpoints (closing the tab on a
            // large response does it), so that would leak a cursor per abort
            // and quietly become the very thing this helper exists to prevent.
            // Both listeners are removed on whichever fires, so a long response
            // cannot accumulate them either.
            await new Promise((resolve) => {
                const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                res.once('drain', done);
                res.once('close', done);
            });
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
            // Nobody is listening any more. Stop pulling documents for a socket
            // that is gone rather than reading the collection to its end.
            if (res.destroyed) return;
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

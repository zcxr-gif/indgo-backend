// What happens to a streamed response when the client hangs up mid-flight?
//
// The helper awaits 'drain' when the socket is full. If the client disconnects
// while we are waiting, 'drain' never fires — so the await never settles, the
// `finally` never runs, and the cursor is never closed. Every abandoned
// download would then leak a cursor and its closure for the life of the
// process. This test forces that exact interleaving.
//
//   node scratchpad/test-stream-abort.js current   # helper as written in server.js
//   node scratchpad/test-stream-abort.js fixed     # with the disconnect race
const http = require('http');

const variant = process.argv[2] || 'current';
const STREAM_CHUNK_CHARS = 64 * 1024;

// Waits for the socket to drain. `current` waits only for 'drain'; `fixed`
// also settles when the response closes.
const waitDrain = (res) => new Promise((resolve) => {
    if (variant === 'fixed') {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
    } else {
        res.once('drain', resolve);
    }
});

let cursorsOpened = 0;
let cursorsClosed = 0;

const streamJsonArray = async (res, query, { prefix = '', suffix = '' } = {}) => {
    const cursor = query.cursor();
    let started = false;
    let buf = '';
    const flush = async (force) => {
        if (!buf || (!force && buf.length < STREAM_CHUNK_CHARS)) return;
        const chunk = buf;
        buf = '';
        if (!res.write(chunk)) await waitDrain(res);
    };
    try {
        for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
            if (!started) { res.setHeader('Content-Type', 'application/json'); buf += `${prefix}[`; started = true; }
            else buf += ',';
            buf += JSON.stringify(doc);
            await flush(false);
            if (variant === 'fixed' && res.destroyed) break;
        }
        if (!started) { res.setHeader('Content-Type', 'application/json'); buf += `${prefix}[`; }
        res.end(`${buf}]${suffix}`);
    } catch (err) {
        if (!started) throw err;
        res.destroy(err);
    } finally {
        await cursor.close();
    }
};

const N = 400000; // big enough that the socket fills long before it ends
const mkDoc = (i) => ({ _id: 'abc' + i, name: 'padding padding padding padding ' + i, at: new Date() });
const genQuery = () => ({
    cursor() {
        cursorsOpened++;
        let i = 0;
        return { next: async () => (i < N ? mkDoc(i++) : null), close: async () => { cursorsClosed++; } };
    },
});

const srv = http.createServer(async (req, res) => {
    try { await streamJsonArray(res, genQuery()); } catch { /* reported via counters */ }
});

srv.listen(0, () => {
    const port = srv.address().port;
    const req = http.get({ port, path: '/' }, (r) => {
        let got = 0;
        r.on('data', (c) => {
            got += c.length;
            // Read a little, then hang up hard while the server is still writing.
            if (got > 200000) { req.destroy(); }
        });
        r.on('error', () => {});
    });
    req.on('error', () => {});

    setTimeout(() => {
        console.log(`variant=${variant}  cursors opened=${cursorsOpened} closed=${cursorsClosed}`);
        if (cursorsClosed === cursorsOpened) console.log('  OK — cursor released after client disconnect');
        else console.log('  LEAK — cursor still open; the await never settled, finally never ran');
        srv.close();
        process.exit(cursorsClosed === cursorsOpened ? 0 : 1);
    }, 2500);
});

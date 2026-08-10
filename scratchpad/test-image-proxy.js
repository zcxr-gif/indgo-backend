// The image proxy's failure modes: does an aborted download tear the upstream
// connection down, and is a hanging origin bounded by a timeout?
//
// Before the fix, pipe() left the upstream request running when the client went
// away, so every abandoned <img> leaked a socket until the origin finished.
const http = require('http');
const axios = require('axios');

let upstreamOpen = 0;
let upstreamClosed = 0;

// An origin that sends a trickle and never finishes — the shape that makes a
// leak visible, because it cannot end on its own.
const origin = http.createServer((req, res) => {
    upstreamOpen++;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 10);
    res.on('close', () => { clearInterval(timer); upstreamClosed++; });
});

// The proxy handler, matching server.js.
const makeProxy = (fixed) => http.createServer(async (req, res) => {
    const target = new URL(req.url.slice(req.url.indexOf('?url=') + 5));
    let upstream = null;
    try {
        const response = await axios({
            method: 'get', url: target.href, responseType: 'stream',
            timeout: 15000, maxRedirects: 3,
            maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024,
        });
        upstream = response.data;
        if (fixed) {
            res.once('close', () => { if (!upstream.destroyed) upstream.destroy(); });
            upstream.once('error', () => { if (!res.headersSent) res.status = 502; else res.destroy(); });
        }
        upstream.pipe(res);
    } catch (e) {
        if (upstream && !upstream.destroyed) upstream.destroy();
        if (!res.headersSent) { res.writeHead(502); res.end('fail'); }
    }
});

const run = (fixed) => new Promise((resolve) => {
    upstreamOpen = 0; upstreamClosed = 0;
    const proxy = makeProxy(fixed);
    proxy.listen(0, () => {
        const url = `http://127.0.0.1:${origin.address().port}/img.png`;
        const req = http.get({ port: proxy.address().port, path: `/api/image-proxy?url=${url}` }, (r) => {
            let got = 0;
            r.on('data', (c) => { got += c.length; if (got > 64 * 1024) req.destroy(); }); // client hangs up
            r.on('error', () => {});
        });
        req.on('error', () => {});
        setTimeout(() => {
            console.log(`${fixed ? 'fixed  ' : 'current'}  upstream opened=${upstreamOpen} closed=${upstreamClosed}`
                + `  -> ${upstreamClosed === upstreamOpen ? 'OK, upstream torn down' : 'LEAK, upstream still streaming'}`);
            proxy.close();
            resolve(upstreamClosed === upstreamOpen);
        }, 1500);
    });
});

origin.listen(0, async () => {
    const before = await run(false);
    const after = await run(true);
    origin.close();
    console.log(`\nleak reproduced before fix: ${!before}\nfixed after: ${after}`);
    process.exit(after ? 0 : 1);
});

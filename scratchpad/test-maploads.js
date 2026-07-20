const express = require('express');
const app = express();
app.use(require('../routes/mapLoads'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const hit = async (q) => (await (await fetch(`${base}/api/maploads/hit?${q}`, { method: 'POST' })).json());
  const status = async () => (await (await fetch(`${base}/api/maploads/status`)).json());
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('PASS:', m); };

  // limit=3, non-pro: 3 billed loads, 4th drops to free
  let r1 = await hit('limit=3&pro=0'); assert(r1.useFreeMap===false && r1.count===1, `1st non-pro count=${r1.count} free=${r1.useFreeMap}`);
  let r2 = await hit('limit=3&pro=0'); assert(r2.useFreeMap===false && r2.count===2, `2nd non-pro count=${r2.count}`);
  let r3 = await hit('limit=3&pro=0'); assert(r3.useFreeMap===false && r3.count===3, `3rd non-pro count=${r3.count}`);
  let r4 = await hit('limit=3&pro=0'); assert(r4.useFreeMap===true && r4.count===3, `4th non-pro drops to free, count stays 3 (count=${r4.count} free=${r4.useFreeMap})`);

  // Pro over ceiling: still Mapbox, and counted
  let rp = await hit('limit=3&pro=1'); assert(rp.useFreeMap===false && rp.count===4 && rp.pro===true, `pro over ceiling stays Mapbox & counts (count=${rp.count} free=${rp.useFreeMap})`);

  // GET also works
  let rg = await (await fetch(`${base}/api/maploads/hit?limit=3&pro=1`)).json(); assert(rg.useFreeMap===false, 'GET accepted');

  // status is read-only (no increment)
  let s1 = await status(); let s2 = await status(); assert(s1.count===s2.count, `status does not increment (${s1.count}==${s2.count})`);
  assert(s1.useFreeMap===true, `status reflects non-pro over-ceiling free=${s1.useFreeMap}`);

  // CORS + no-store headers
  let raw = await fetch(`${base}/api/maploads/hit?limit=3&pro=0`, { method: 'POST' });
  assert(raw.headers.get('access-control-allow-origin')==='*', 'CORS header set');
  assert((raw.headers.get('cache-control')||'').includes('no-store'), 'Cache-Control no-store set');

  // HARD_CAP clamps limit above 50000
  let rc = await hit('limit=999999&pro=0'); assert(rc.limit===50000, `limit clamped to HARD_CAP (${rc.limit})`);

  server.close();
});

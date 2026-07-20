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
  // status doesn't see the client's ?limit= — with no admin override it reports
  // against the default (40k), so 5 loads is comfortably under the ceiling.
  assert(s1.useFreeMap===false && s1.limit===40000, `status uses default limit when no override (limit=${s1.limit} free=${s1.useFreeMap})`);

  // CORS + no-store headers
  let raw = await fetch(`${base}/api/maploads/hit?limit=3&pro=0`, { method: 'POST' });
  assert(raw.headers.get('access-control-allow-origin')==='*', 'CORS header set');
  assert((raw.headers.get('cache-control')||'').includes('no-store'), 'Cache-Control no-store set');

  // HARD_CAP clamps limit above 50000
  let rc = await hit('limit=999999&pro=0'); assert(rc.limit===50000, `limit clamped to HARD_CAP (${rc.limit})`);

  // ---- Admin switches (Staff Hub /map-usage → /api/admin/maploads) ----
  const { admin } = require('../routes/mapLoads');

  // Pin the limit: overrides whatever the client asks for, and status sees it.
  let a1 = admin.update({ limit: 3 });
  assert(a1.limit===3 && a1.limitOverride===3, `admin pins limit (limit=${a1.limit})`);
  let rh = await hit('limit=999999&pro=0'); assert(rh.limit===3 && rh.useFreeMap===true, `pinned limit beats client query (limit=${rh.limit} free=${rh.useFreeMap})`);
  let s3 = await status(); assert(s3.limit===3 && s3.useFreeMap===true, `status reflects pinned limit (limit=${s3.limit} free=${s3.useFreeMap})`);

  // Force free map: stops everyone, Pro included, without counting.
  admin.update({ forceFreeMap: true });
  const before = admin.state().count;
  let rf = await hit('pro=1'); assert(rf.forced===true && rf.useFreeMap===true, `forced free map stops Pro (forced=${rf.forced})`);
  assert(admin.state().count===before, `forced load not counted (${admin.state().count}==${before})`);

  // Clear the override: back to the env var (unset here → off).
  admin.update({ forceFreeMap: null });
  let rf2 = await hit('pro=1'); assert(rf2.forced===false && rf2.useFreeMap===false, `override cleared, env applies (forced=${rf2.forced})`);

  // Validation: can't push the limit past the free-tier hard cap.
  let threw = false; try { admin.update({ limit: 60000 }); } catch { threw = true; }
  assert(threw, 'over-cap admin limit rejected');

  // Clear the limit override: back to the client/default behaviour.
  let a2 = admin.update({ limit: null });
  assert(a2.limitOverride===null && a2.limit===40000, `limit override cleared (limit=${a2.limit})`);

  // Reset the month counter.
  let a3 = admin.resetMonth();
  assert(a3.count===0, `month counter reset (count=${a3.count})`);

  server.close();
});

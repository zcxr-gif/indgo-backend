'use strict';
// A VA's Supabase project on an older schema than the code — the "502 when I
// add a route" case.
//
// v5 added crew_routes.kind / partner_name / partner_logo / min_rank. A project
// provisioned before that has none of them, and PostgREST fails the WHOLE write
// with PGRST204 rather than ignoring the column. This drove a bare 502 out of
// the API for something that is neither our outage nor unfixable.
//
// What is asserted here is the deal we now make: the row still lands, without
// the columns the project has not got; the store says which ones those were, so
// the handler can tell the VA; and nothing else in the error space gets swept
// into that treatment — a wrong column name and a constraint violation both
// still fail loudly.

const http = require('http');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'mongoose') return { Schema: function () { this.index = () => {}; }, models: {}, model: () => ({}) };
    return origLoad.call(this, req, ...rest);
};

const crewStore = require(path.join('..', 'crewStore.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n     want:', JSON.stringify(expected));
};
const OK = (label, cond, note) => {
    if (cond) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, note ? `\n      ${note}` : '');
};

// ---------------------------------------------------------------------------
// A project stuck on v4: crew_routes exists, but only with the v1 columns.
// ---------------------------------------------------------------------------
const V4_ROUTE_COLUMNS = new Set([
    'id', 'va_slug', 'flight_number', 'origin', 'destination',
    'aircraft', 'distance_nm', 'notes', 'active', 'created_at', 'updated_at',
]);

const tables = { crew_routes: [], crew_members: [], crew_schema_info: [{ version: 4, installed_at: '2026-01-01T00:00:00Z' }] };
let seq = 0;
const writes = [];   // every body we were asked to write, so a test can count round trips

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname.replace('/rest/v1/', '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const send = (code, payload) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        const data = body ? JSON.parse(body) : null;
        const table = tables[name];
        if (!table) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}'` });

        if (req.method === 'GET') return send(200, table);

        const rows = Array.isArray(data) ? data : [data];
        if (req.method === 'POST' || req.method === 'PATCH') {
            writes.push(rows[0]);
            if (name === 'crew_routes') {
                // PostgREST's own wording, which is what the parser has to read.
                for (const col of Object.keys(rows[0] || {})) {
                    if (!V4_ROUTE_COLUMNS.has(col)) {
                        return send(400, {
                            code: 'PGRST204',
                            message: `Could not find the '${col}' column of 'crew_routes' in the schema cache`,
                        });
                    }
                }
                // A real constraint failure, so the tests can prove it is not
                // mistaken for a version problem.
                if (rows[0].origin === '') {
                    return send(400, { code: '23502', message: 'null value in column "origin" of relation "crew_routes" violates not-null constraint' });
                }
            }
            const out = rows.map((r) => ({ id: `id-${++seq}`, ...r }));
            if (req.method === 'POST') table.push(...out);
            return send(req.method === 'POST' ? 201 : 200, out);
        }
        send(405, { message: 'nope' });
    });
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const va = { slug: 'aeromexico-virtual', supabaseUrl: url, supabaseServiceKey: 'service-key' };

    console.log('crew schema drift\n');
    console.log(' adding a route to a v4 project');
    const store = new crewStore.SupabaseStore(va);
    const route = await store.createRoute({
        flightNumber: 'AMX10', origin: 'MMMX', destination: 'KLAX', aircraft: 'Boeing 787-9',
        distanceNm: 1300, notes: '', active: true,
        kind: 'codeshare', partnerName: 'Delta', partnerLogo: 'https://x.test/d.png', minRank: 'First Officer',
    });
    OK('the route is written rather than 502ing', !!route && route.origin === 'MMMX');
    T('  …with the columns the project does have', [route.flightNumber, route.destination, route.distanceNm], ['AMX10', 'KLAX', 1300]);
    T('  …and the ones it has not are reported, in words', store.drift(),
        ['codeshare routes', 'codeshare partner names', 'codeshare partner logos', 'rank-gated routes']);
    OK('nothing unknown reached the table', Object.keys(tables.crew_routes[0]).every((c) => V4_ROUTE_COLUMNS.has(c)),
        `stored: ${Object.keys(tables.crew_routes[0]).join(', ')}`);

    console.log('\n the second write does not re-learn it');
    const before = writes.length;
    const store2 = new crewStore.SupabaseStore(va);
    await store2.createRoute({ flightNumber: 'AMX11', origin: 'MMMX', destination: 'KJFK', kind: 'codeshare', minRank: 'Captain' });
    T('one round trip, not five', writes.length - before, 1);
    T('  …and it still says what it left out', store2.drift(), ['codeshare routes', 'rank-gated routes']);

    console.log('\n what is NOT treated as an old schema');
    let caught = null;
    try {
        await store2.db.insert('crew_routes', { va_slug: 'x', nonsense_column: 1 });
    } catch (err) { caught = err; }
    T('a column that is in no schema at all still fails', [caught && caught.code, caught && caught.status], ['store_schema_outdated', 409]);
    OK('  …and is not silently dropped', caught instanceof crewStore.CrewStoreError);

    caught = null;
    try { await store2.db.insert('crew_routes', { va_slug: 'x', origin: '' }); }
    catch (err) { caught = err; }
    T('a not-null violation is a store error, not a version problem', caught && caught.code, 'store_error');

    console.log('\n after the VA updates their database');
    V4_ROUTE_COLUMNS.add('kind'); V4_ROUTE_COLUMNS.add('partner_name');
    V4_ROUTE_COLUMNS.add('partner_logo'); V4_ROUTE_COLUMNS.add('min_rank');
    crewStore.forgetSchemaDrift(url);
    const store3 = new crewStore.SupabaseStore(va);
    const full = await store3.createRoute({
        flightNumber: 'AMX12', origin: 'MMMX', destination: 'KSFO',
        kind: 'codeshare', partnerName: 'Delta', minRank: 'Captain',
    });
    T('the whole row goes in again', [full.kind, full.partnerName, full.minRank], ['codeshare', 'Delta', 'Captain']);
    T('  …and there is nothing left to warn about', store3.drift(), []);

    server.close();
    console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

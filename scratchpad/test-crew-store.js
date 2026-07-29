'use strict';
// Conformance test for crewStore's Supabase adapter — the layer that keeps a
// VA's crew data in the VA's OWN Postgres instead of ours.
//
// It stands up a tiny in-process PostgREST impersonator (enough of the surface
// that crewStore actually uses: GET with eq./in. filters + order/limit, POST
// insert, PATCH, DELETE, and POST /rpc/crew_stats) and drives the real store
// against it. That exercises the parts most likely to break silently in
// production: the snake_case <-> camelCase mapping, slug scoping, the flight-id
// dedupe filter, and the hours credit/reverse round trip.
//
// No mongoose, no network beyond loopback.

const http = require('http');
const path = require('path');
const Module = require('module');

// crewStore itself never imports mongoose, but requiring it from the repo root
// is enough — keep the stub in case that changes.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'mongoose') return { Schema: function () { this.index = () => {}; }, models: {}, model: () => ({}) };
    return origLoad.call(this, req, ...rest);
};

const crewStore = require(path.join('..', 'crewStore.js'));
// The events decisions live next door; the store only keeps their rows. Pulled
// in here so the gate-board checks can assert on both halves at once.
const crewEvents = require(path.join('..', 'crewEvents.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ❌', label, '\n     got', JSON.stringify(got), '\n     exp', JSON.stringify(expected));
};
const OK = (label, cond, note) => {
    if (cond) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ❌', label, note ? `\n     ${note}` : '');
};

// ---------------------------------------------------------------------------
// The fake project: four tables of plain rows, filtered the way PostgREST does.
// ---------------------------------------------------------------------------
const tables = { crew_members: [], crew_routes: [], crew_pireps: [], crew_applications: [], crew_events: [], crew_event_signups: [], crew_schema_info: [{ version: 1, installed_at: '2026-01-01T00:00:00Z' }] };

// The unique indexes the schema relies on, reproduced here because they are not
// decoration: crew_event_signups_gate_idx is the whole mechanism that makes a
// gate belong to one pilot, and a test suite that lets two inserts both succeed
// would be testing a database we do not ship. Returns the violated constraint's
// name, or '' when the row is fine.
function uniqueViolation(name, row) {
    if (name !== 'crew_event_signups') return '';
    const live = tables.crew_event_signups;
    const gate = String(row.gate || '').toUpperCase();
    if (gate && live.some((r) => r.event_id === row.event_id && String(r.gate || '').toUpperCase() === gate)) {
        return 'crew_event_signups_gate_idx';
    }
    if (row.account_id && live.some((r) => r.event_id === row.event_id && r.account_id === row.account_id)) {
        return 'crew_event_signups_account_idx';
    }
    if (row.member_id && live.some((r) => r.event_id === row.event_id && r.member_id === row.member_id)) {
        return 'crew_event_signups_member_idx';
    }
    return '';
}
let seq = 0;
const uuid = () => `id-${++seq}`;
const requests = [];   // every path+query we were asked for, so tests can assert on scoping

// PostgREST filter grammar, the subset crewStore emits.
function matches(row, params) {
    for (const [col, raw] of Object.entries(params)) {
        if (['select', 'order', 'limit', 'offset'].includes(col)) continue;
        const v = String(raw);
        if (v.startsWith('eq.')) { if (String(row[col] ?? '') !== v.slice(3)) return false; continue; }
        if (v.startsWith('neq.')) { if (String(row[col] ?? '') === v.slice(4)) return false; continue; }
        if (v === 'is.true') { if (row[col] !== true) return false; continue; }
        if (v.startsWith('in.(')) {
            const list = v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
            if (!list.includes(String(row[col] ?? ''))) return false;
            continue;
        }
        // Timestamp window on the events list ("starting later than 12h ago").
        if (v.startsWith('gte.')) { if (!(String(row[col] ?? '') >= v.slice(4))) return false; continue; }
        throw new Error(`fake postgrest: unsupported filter ${col}=${v}`);
    }
    return true;
}

function applyOrder(rows, order) {
    if (!order) return rows;
    const keys = order.split(',').map((k) => {
        const [col, dir] = k.split('.');
        return { col, desc: dir === 'desc' };
    });
    return rows.slice().sort((a, b) => {
        for (const { col, desc } of keys) {
            const x = a[col], y = b[col];
            if (x === y) continue;
            const cmp = (x == null) ? -1 : (y == null) ? 1 : (x > y ? 1 : -1);
            return desc ? -cmp : cmp;
        }
        return 0;
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const params = Object.fromEntries(url.searchParams.entries());
    const name = url.pathname.replace('/rest/v1/', '');
    requests.push({ method: req.method, path: name, params });

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const send = (code, payload) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        const data = body ? JSON.parse(body) : null;

        if (name === 'rpc/crew_stats') {
            const slug = data.p_va_slug;
            const members = tables.crew_members.filter((m) => m.va_slug === slug);
            const pireps = tables.crew_pireps.filter((p) => p.va_slug === slug && p.status === 'approved');
            return send(200, {
                pilots: members.length,
                hours: members.reduce((s, m) => s + Number(m.hours || 0), 0),
                pireps: tables.crew_pireps.filter((p) => p.va_slug === slug).length,
                flightHours: pireps.reduce((s, p) => s + p.duration_min, 0) / 60,
            });
        }

        const table = tables[name];
        if (!table) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}'` });

        if (req.method === 'GET') {
            let rows = table.filter((r) => matches(r, params));
            rows = applyOrder(rows, params.order);
            if (params.limit) rows = rows.slice(0, Number(params.limit));
            return send(200, rows);
        }
        if (req.method === 'POST') {
            const rows = (Array.isArray(data) ? data : [data]).map((r) => ({
                id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r,
            }));
            for (const row of rows) {
                const hit = uniqueViolation(name, row);
                if (hit) {
                    return send(409, {
                        code: '23505',
                        message: `duplicate key value violates unique constraint "${hit}"`,
                    });
                }
            }
            table.push(...rows);
            return send(201, rows);
        }
        if (req.method === 'PATCH') {
            const hit = table.filter((r) => matches(r, params));
            hit.forEach((r) => Object.assign(r, data, { updated_at: new Date().toISOString() }));
            return send(200, hit);
        }
        if (req.method === 'DELETE') {
            const keep = table.filter((r) => !matches(r, params));
            const removed = table.length - keep.length;
            tables[name] = keep;
            return send(200, { removed });
        }
        send(405, { message: 'nope' });
    });
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const store = new crewStore.SupabaseStore({ slug: 'aeromexico-virtual', supabaseUrl: url, supabaseServiceKey: 'service-key' });
    // A second VA sharing the same project — the multi-brand case the schema's
    // va_slug column exists for.
    const other = new crewStore.SupabaseStore({ slug: 'connect-regional', supabaseUrl: url, supabaseServiceKey: 'service-key' });

    console.log('• health');
    const health = await store.health();
    T('provisioned project reports its version', [health.ok, health.provisioned, health.version], [true, true, 1]);

    console.log('• roster round trip');
    const pilot = await store.createMember({ name: 'Antony', callsign: 'AMX101', hours: 12.5, ifUserId: 'if-1', aircraft: ['B738'] });
    T('create maps camelCase in and out', [pilot.name, pilot.callsign, pilot.hours, pilot.ifUserId], ['Antony', 'AMX101', 12.5, 'if-1']);
    OK('stored row is snake_case', tables.crew_members[0].if_user_id === 'if-1' && tables.crew_members[0].ifUserId === undefined);
    OK('row is stamped with the VA slug', tables.crew_members[0].va_slug === 'aeromexico-virtual');

    await other.createMember({ name: 'Someone Else', callsign: 'XXX1', hours: 999 });
    T('a sibling VA in the same project is invisible', (await store.listMembers()).map((m) => m.name), ['Antony']);
    T('…and sees only its own', (await other.listMembers()).map((m) => m.name), ['Someone Else']);

    const edited = await store.updateMember(pilot._id, { role: 'Captain' });
    T('patch touches only what was sent', [edited.role, edited.name, edited.hours], ['Captain', 'Antony', 12.5]);

    console.log('• hours credit / reverse');
    await store.addMemberHours(pilot._id, 2.5);
    T('credit adds', (await store.getMember(pilot._id)).hours, 15);
    await store.addMemberHours(pilot._id, -5);
    T('debit subtracts', (await store.getMember(pilot._id)).hours, 10);
    await store.addMemberHours(pilot._id, -999);
    T('debit clamps at zero, never negative', (await store.getMember(pilot._id)).hours, 0);

    console.log('• routes');
    const route = await store.createRoute({ flightNumber: 'AM404', origin: 'mmmx', destination: 'kjfk', distanceNm: 2085, active: true });
    T('origin/destination are normalised to ICAO', [route.origin, route.destination], ['MMMX', 'KJFK']);
    await store.createRoute({ flightNumber: 'AM999', origin: 'MMMX', destination: 'MMUN', active: false });
    T('activeOnly filters drafts out', (await store.listRoutes({ activeOnly: true })).map((r) => r.flightNumber), ['AM404']);
    T('unfiltered sees both', (await store.listRoutes()).length, 2);

    console.log('• flight reports');
    const pirep = await store.createPirep({
        memberId: pilot._id, routeId: route._id, flightId: 'flt-abc',
        origin: 'MMMX', destination: 'KJFK', durationMin: 295, landings: 1, status: 'pending',
        flownAt: new Date('2026-07-01T12:00:00Z'),
    });
    T('numbers and links survive the round trip', [pirep.durationMin, pirep.landings, pirep.memberId], [295, 1, pilot._id]);
    OK('flownAt is a Date on the way out', pirep.flownAt instanceof Date);
    OK('flownAt is an ISO string in the row', typeof tables.crew_pireps[0].flown_at === 'string');

    const seen = await store.seenFlightIds(['flt-abc', 'flt-new', 'flt-other']);
    T('dedupe reports only the captured flight', [...seen], ['flt-abc']);
    T('empty id list short-circuits', [...(await store.seenFlightIds([]))], []);

    await store.updatePirep(pirep._id, { status: 'approved' });
    T('status filter works', (await store.listPireps({ status: 'approved' })).length, 1);
    T('…and excludes other states', (await store.listPireps({ status: 'pending' })).length, 0);

    console.log('• applications stay scoped and token-addressable');
    const app1 = await store.createApplication({ ifcName: 'NewPilot', email: 'A@Example.COM', statusToken: 'tok-1', answers: [{ q: 'Why?', a: 'Eagles.' }] });
    T('email is lowercased', app1.email, 'a@example.com');
    T('answers survive as jsonb', app1.answers, [{ q: 'Why?', a: 'Eagles.' }]);
    T('token lookup finds it', (await store.getApplicationByToken('tok-1')).ifcName, 'NewPilot');
    T('a sibling VA cannot read that token', await other.getApplicationByToken('tok-1'), null);

    console.log('• events');
    const ev = await store.createEvent({
        title: 'Águila Transatlántica', origin: 'mmmx', destination: 'lemd',
        startsAt: new Date('2026-08-15T19:00:00Z'), slots: 40, status: 'published',
    });
    T('ICAOs normalise, status survives', [ev.origin, ev.destination, ev.status], ['MMMX', 'LEMD', 'published']);
    T('gates are open unless a VA turns them off', [ev.gatesOpen, ev.gatesLocked], [true, false]);
    T('the board falls back to the origin', crewEvents.gateAirport(ev), 'MMMX');
    T('…and to what the VA set, when they set one',
        crewEvents.gateAirport({ ...ev, gateIcao: 'LEMD' }), 'LEMD');

    const draft = await store.createEvent({ title: 'Not ready yet' });
    T('an event starts as a draft', draft.status, 'draft');
    T('status filter separates the two', (await store.listEvents({ status: 'published' })).map((e) => e.title), ['Águila Transatlántica']);
    await other.createEvent({ title: 'Someone else’s fly-in', status: 'published' });
    T('a sibling VA’s calendar is invisible', (await store.listEvents()).length, 2);

    console.log('• the gate board is claimed in the database');
    const mine = await store.createSignup({
        eventId: ev._id, memberId: pilot._id, accountId: 'acct-1',
        pilotName: 'Antony', callsign: 'AMX101', gate: 'b24', gateLat: 19.43, gateLon: -99.07, gateKind: 'gate',
    });
    T('the stand is stored upper-cased, the way the index reads it', mine.gate, 'B24');
    T('its position rides along so the board draws without OSM', [mine.gateLat, mine.gateLon], [19.43, -99.07]);

    try {
        await store.createSignup({ eventId: ev._id, accountId: 'acct-2', pilotName: 'Someone', gate: 'B24' });
        failures++; console.log('  ❌ a taken gate should have been refused');
    } catch (err) {
        OK('a second pilot cannot take a claimed stand', err.code === 'store_conflict', `got ${err.code}`);
        T('…and the handler is told which rule bit', err.constraint, 'crew_event_signups_gate_idx');
    }
    try {
        await store.createSignup({ eventId: ev._id, accountId: 'acct-2', pilotName: 'Someone', gate: 'b24' });
        failures++; console.log('  ❌ lower case should not dodge the gate index');
    } catch (err) {
        T('case is not a way around it', err.constraint, 'crew_event_signups_gate_idx');
    }
    try {
        await store.createSignup({ eventId: ev._id, accountId: 'acct-1', pilotName: 'Antony', gate: 'C7' });
        failures++; console.log('  ❌ signing up twice should have been refused');
    } catch (err) {
        T('one signup per pilot per event', err.constraint, 'crew_event_signups_account_idx');
    }

    T('the board finds a pilot’s own row', (await store.getSignupFor(ev._id, { accountId: 'acct-1' }))._id, mine._id);
    T('…and has nothing to find for a pilot who has not signed up',
        await store.getSignupFor(ev._id, { accountId: 'acct-nobody' }), null);
    await store.updateSignup(mine._id, { gate: 'c7', aircraft: 'B789' });
    T('changing stands keeps the upper-casing', (await store.getSignup(mine._id)).gate, 'C7');
    await store.deleteSignup(mine._id);
    T('withdrawing removes the row, freeing the stand', (await store.listSignups(ev._id)).length, 0);

    console.log('• stats');
    const stats = await store.stats();
    T('served by the project’s own function', stats.source, 'supabase');
    T('counts this VA only', [stats.pilots, stats.pireps], [1, 1]);

    console.log('• failure modes surface as actionable errors');
    const missing = new crewStore.SupabaseStore({ slug: 'x', supabaseUrl: url, supabaseServiceKey: 'k' });
    missing.db.base = `${url}/rest/v1`;
    try {
        await missing.db.select('crew_nonexistent', {});
        failures++; console.log('  ❌ missing table should have thrown');
    } catch (err) {
        T('missing tables say "run the schema"', err.code, 'store_schema_missing');
    }
    const dead = new crewStore.SupabaseStore({ slug: 'x', supabaseUrl: 'http://127.0.0.1:1', supabaseServiceKey: 'k' });
    try {
        await dead.listMembers();
        failures++; console.log('  ❌ unreachable project should have thrown');
    } catch (err) {
        OK('an unreachable project is a 502, not a 500', err.status === 502 && err.code === 'store_unreachable', `got ${err.status}/${err.code}`);
    }

    console.log('• computeStats (legacy + older-schema fallback) agrees in shape');
    const js = crewStore.computeStats({
        members: [{ name: 'A', callsign: 'A1', hours: 10, status: 'active', ifUserId: 'x', createdAt: new Date() },
                  { name: 'B', callsign: 'B1', hours: 0, status: 'loa', ifUserId: '', createdAt: new Date() }],
        pireps: [{ status: 'approved', durationMin: 120, landings: 2, distanceNm: 500, flownAt: new Date() },
                 { status: 'pending', durationMin: 60, landings: 1, distanceNm: 100, flownAt: new Date() }],
        routes: [{ active: true, destination: 'KJFK' }, { active: true, destination: 'KJFK' }, { active: false, destination: 'EGLL' }],
        applications: [{ status: 'pending', createdAt: new Date() }],
    });
    T('pilots / active / linked', [js.pilots, js.pilotsActive, js.pilotsLinked], [2, 1, 1]);
    T('roster hours vs flown hours are separate figures', [js.hours, js.flightHours], [10, 2]);
    T('only approved reports count toward flown', js.pirepsApproved, 1);
    T('destinations are distinct and active-only', js.destinations, 1);
    T('leaderboard skips zero-hour pilots', js.topPilots, [{ name: 'A', callsign: 'A1', hours: 10 }]);

    server.close();
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll crew store checks passed ✅');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

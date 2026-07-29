'use strict';
// Conformance test for crewAccounts — the module that keeps a VA's pilots'
// LOGINS in the VA's own Postgres rather than in ours.
//
// Same approach as test-crew-store.js: a tiny in-process PostgREST impersonator
// standing in for the VA's project, with the real crewStore + crewAccounts
// driven against it. What it is actually checking is the set of things that
// would be quiet, expensive bugs in production:
//
//   * a password is verifiable after a round trip through the store, and the
//     PLAINTEXT never lands in a row
//   * provisioning twice returns one account, not two logins for one pilot
//   * usernames are unique within a crew center and only within it — two VAs
//     may each have a `j.smith`
//   * wrong password / unknown user / disabled account are indistinguishable
//   * a password change requires the current password and clears the
//     must-change flag; a reset mints a new one and sets it again
//   * every row written carries the va_slug, so one project can back several
//     crew centers without their people mixing
//   * a project on the older schema fails with something the VA can act on
//
// No mongoose, no network beyond loopback.

const http = require('http');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'mongoose') return { Schema: function () { this.index = () => {}; }, models: {}, model: () => ({}) };
    return origLoad.call(this, req, ...rest);
};

const crewStore = require(path.join('..', 'crewStore.js'));
const crewAccounts = require(path.join('..', 'crewAccounts.js'));

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
// The fake project.
//
// `hasAccounts` flips the crew_accounts table out of existence so the pre-v3
// path can be exercised — that is the state every VA connected before this
// change is in until they re-run the SQL.
// ---------------------------------------------------------------------------
let hasAccounts = true;
const tables = {
    crew_members: [],
    crew_accounts: [],
    crew_schema_info: [{ version: 5, installed_at: '2026-01-01T00:00:00Z' }],
};
let seq = 0;
const uuid = () => `id-${++seq}`;

function matches(row, params) {
    for (const [col, raw] of Object.entries(params)) {
        if (['select', 'order', 'limit', 'offset'].includes(col)) continue;
        const v = String(raw);
        if (v.startsWith('eq.')) { if (String(row[col] ?? '') !== v.slice(3)) return false; continue; }
        if (v.startsWith('neq.')) { if (String(row[col] ?? '') === v.slice(4)) return false; continue; }
        throw new Error(`fake postgrest: unsupported filter ${col}=${v}`);
    }
    return true;
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const params = Object.fromEntries(url.searchParams.entries());
    const name = url.pathname.replace('/rest/v1/', '');

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const send = (code, payload) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        const data = body ? JSON.parse(body) : null;

        if (name === 'crew_accounts' && !hasAccounts) {
            return send(404, { code: 'PGRST205', message: "Could not find the table 'public.crew_accounts'" });
        }
        const table = tables[name];
        if (!table) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}'` });

        if (req.method === 'GET') {
            let rows = table.filter((r) => matches(r, params));
            if (params.limit) rows = rows.slice(0, Number(params.limit));
            return send(200, rows);
        }
        if (req.method === 'POST') {
            const rows = (Array.isArray(data) ? data : [data]).map((r) => ({
                id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r,
            }));
            // The schema's unique index, enforced here so the test can prove the
            // module never relies on the database to save it from a collision.
            for (const r of rows) {
                if (name === 'crew_accounts'
                    && table.some((x) => x.va_slug === r.va_slug && x.username === r.username)) {
                    return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
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
            tables[name] = table.filter((r) => !matches(r, params));
            return send(200, {});
        }
        send(405, { message: 'nope' });
    });
});

(async function run() {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const store = new crewStore.SupabaseStore({ slug: 'skyward', supabaseUrl: url, supabaseServiceKey: 'service-key' });
    const other = new crewStore.SupabaseStore({ slug: 'northwind', supabaseUrl: url, supabaseServiceKey: 'service-key' });

    console.log('\ncrewAccounts — pilot logins in the VA’s own project\n');

    // --- Provisioning ---
    console.log('provisioning');
    const first = await crewAccounts.provisionPilotAccount(store, {
        displayName: 'J. Smith', memberId: 'member-1', email: 'J.Smith@Example.com', createdByName: 'Ops',
    });
    T('username derived from the pilot’s name', first.username, 'j.smith');
    OK('a password comes back on creation', typeof first.password === 'string' && first.password.length >= 12);
    T('created', first.created, true);
    T('flagged must-change', first.account.mustChangePassword, true);
    T('linked to the roster row', first.account.memberId, 'member-1');
    T('email lower-cased', first.account.email, 'j.smith@example.com');

    const row = tables.crew_accounts.find((r) => r.username === 'j.smith');
    OK('the row is scoped to the crew center', row.va_slug === 'skyward');
    OK('the plaintext password is NOWHERE in the row',
        !JSON.stringify(row).includes(first.password),
        `row still contains the password: ${JSON.stringify(row)}`);
    OK('what IS stored is a bcrypt hash', /^\$2[aby]\$/.test(row.password_hash), row.password_hash);

    // --- Idempotency ---
    console.log('\nprovisioning the same pilot again');
    const again = await crewAccounts.provisionPilotAccount(store, { displayName: 'J. Smith', memberId: 'member-1' });
    T('does not create a second login', again.created, false);
    T('and hands back no password', again.password, null);
    T('one row, not two', tables.crew_accounts.filter((r) => r.va_slug === 'skyward').length, 1);
    const byName = await crewAccounts.provisionPilotAccount(store, { displayName: 'j. smith' });
    T('matched case-insensitively by name when there is no member id', byName.created, false);

    // --- Username collisions ---
    console.log('\nusername collisions');
    const twin = await crewAccounts.provisionPilotAccount(store, { displayName: 'J Smith', memberId: 'member-2' });
    T('a different pilot with the same derived name gets a suffix', twin.username, 'j.smith2');
    const elsewhere = await crewAccounts.provisionPilotAccount(other, { displayName: 'J. Smith', memberId: 'member-9' });
    T('another crew center may reuse the username outright', elsewhere.username, 'j.smith');
    T('…because uniqueness is per crew center', tables.crew_accounts.filter((r) => r.username === 'j.smith').length, 2);

    // --- Authentication ---
    console.log('\nsigning in');
    const good = await crewAccounts.authenticate(store, 'j.smith', first.password);
    OK('the issued password works', !!good && good._id === first.account._id);
    T('mixed-case username still resolves', !!await crewAccounts.authenticate(store, 'J.Smith', first.password), true);
    T('wrong password is refused', await crewAccounts.authenticate(store, 'j.smith', 'not-it'), null);
    T('unknown user is refused the same way', await crewAccounts.authenticate(store, 'nobody', first.password), null);
    T('the other crew center’s j.smith is a different person',
        await crewAccounts.authenticate(other, 'j.smith', first.password), null);

    await store.updateAccount(first.account._id, { active: false });
    T('a disabled account cannot sign in', await crewAccounts.authenticate(store, 'j.smith', first.password), null);
    await store.updateAccount(first.account._id, { active: true });

    // --- Changing the password ---
    console.log('\nchanging the password');
    const wrongCurrent = await crewAccounts.changePassword(store, first.account._id, 'wrong', 'a-much-better-one');
    T('the current password is required', wrongCurrent.status, 401);
    const tooShort = await crewAccounts.changePassword(store, first.account._id, first.password, 'short');
    T('a short new password is refused', tooShort.status, 400);
    const reuse = await crewAccounts.changePassword(store, first.account._id, first.password, first.password);
    T('reusing the same password is refused', reuse.status, 400);

    const changed = await crewAccounts.changePassword(store, first.account._id, first.password, 'a-much-better-one');
    T('a valid change succeeds', changed, { ok: true });
    T('the old password stops working', await crewAccounts.authenticate(store, 'j.smith', first.password), null);
    OK('the new one works', !!await crewAccounts.authenticate(store, 'j.smith', 'a-much-better-one'));
    T('and the must-change prompt is cleared',
        (await store.getAccount(first.account._id)).mustChangePassword, false);

    // --- Staff reset ---
    console.log('\nstaff resetting a lost password');
    const reset = await crewAccounts.resetPassword(store, first.account._id);
    T('reset reports the username', reset.username, 'j.smith');
    OK('the new password signs in', !!await crewAccounts.authenticate(store, 'j.smith', reset.password));
    T('the previous one does not', await crewAccounts.authenticate(store, 'j.smith', 'a-much-better-one'), null);
    T('and they must change it again',
        (await store.getAccount(first.account._id)).mustChangePassword, true);
    T('a reset for a login that isn’t there', await crewAccounts.resetPassword(store, 'id-nope'), null);

    // --- What staff are shown ---
    console.log('\nwhat leaves the server');
    const pub = crewAccounts.publicAccount(await store.getAccount(first.account._id));
    T('publicAccount never carries a hash', Object.keys(pub).includes('passwordHash'), false);
    T('nor a password', Object.keys(pub).includes('password'), false);
    T('it does carry the prompt flag', pub.mustChangePassword, true);

    // --- An older project ---
    console.log('\na project still on the pre-v3 schema');
    hasAccounts = false;
    let err = null;
    try { await store.getAccountByUsername('j.smith'); } catch (e) { err = e; }
    T('the error names the actual problem', err && err.code, 'store_accounts_missing');
    T('and is a 409, not a 502 — it is fixable by the VA', err && err.status, 409);
    OK('the message says how to fix it', /setup SQL/i.test(err.message), err && err.message);
    T('sign-in treats it as “not this identity”, not a crash',
        await crewAccounts.authenticate(store, 'j.smith', reset.password).catch(() => 'threw'), 'threw');

    tables.crew_schema_info[0].version = 2;
    const health = await store.health();
    T('health reports the project cannot hold logins', health.accounts, false);
    T('and flags it as outdated', health.outdated, true);
    hasAccounts = true;
    tables.crew_schema_info[0].version = 5;
    T('a current project reports it can', (await store.health()).accounts, true);

    server.close();
    console.log(failures ? `\n${failures} failing check(s)\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

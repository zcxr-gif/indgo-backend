'use strict';
// Conformance test for the KEPT Supabase access token — the thing that turns
// "your database is behind, go and mint a token" into a button, or into nothing
// at all.
//
// Two modules meet here and the properties worth defending belong to the seam
// between them:
//
//   crewSecrets — a token we keep is never at rest in the clear. With no key
//     configured, seal() must return NOTHING rather than falling back to
//     plaintext, because the failure mode of a silent fallback is an
//     account-wide credential sitting in a database dump. A blob that has been
//     edited, or opened with a different key, must come back empty rather than
//     as some other string.
//
//   crewSetup.updateSchema — the one path both the button and the automatic
//     updater take. It must run OUR file (not anything a caller supplied)
//     against the project it was told about and no other; refuse a project that
//     is paused rather than half-updating it; and tell a revoked token apart
//     from a token belonging to somebody else's account, because those are
//     different mistakes with different fixes and the dashboard says so.
//
// No network beyond loopback; SUPABASE_API_URL points the client at the fake.

const http = require('http');
const path = require('path');
const fs = require('fs');

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
// crewSecrets, with no key at all
//
// Done FIRST and in a child process: the module resolves its key once and
// caches it, exactly as it does in a running server, so "what happens with no
// key" cannot be asked after something has set one.
// ---------------------------------------------------------------------------
function withoutKey() {
    const { execFileSync } = require('child_process');
    const script = `
        const s = require(${JSON.stringify(path.join(__dirname, '..', 'crewSecrets.js'))});
        process.stdout.write(JSON.stringify({
            available: s.available(),
            sealed: s.seal('sbp_secret_token_value'),
            reason: s.unavailableReason(),
        }));`;
    const env = { ...process.env };
    delete env.CREW_SECRET_KEY;
    delete env.JWT_SECRET;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { env }).toString());
}

(async function run() {
    console.log('\nthe kept access token\n');

    console.log('sealing, with no key configured');
    const bare = withoutKey();
    T('it says so rather than pretending', bare.available, false);
    // The property, not the implementation: whatever comes back must not be the
    // secret. A future refactor that returns some other placeholder still
    // passes; one that quietly hands back the token does not.
    OK('and seals NOTHING — never the token in the clear',
        bare.sealed === '' || !bare.sealed.includes('sbp_secret_token_value'), `got ${JSON.stringify(bare.sealed)}`);
    OK('with a reason a deployer can act on', /CREW_SECRET_KEY/.test(bare.reason), bare.reason);

    console.log('\nsealing, with a key');
    process.env.CREW_SECRET_KEY = require('crypto').randomBytes(32).toString('hex');
    const secrets = require(path.join('..', 'crewSecrets.js'));
    const TOKEN = 'sbp_abcdefghijklmnopqrstuvwxyz012345';
    const sealed = secrets.seal(TOKEN);
    T('it is available now', secrets.available(), true);
    OK('the token is not in the blob', !sealed.includes(TOKEN), sealed);
    OK('the blob announces its format', secrets.isSealed(sealed) && sealed.startsWith('v1.'), sealed);
    T('and opens back to the token', secrets.open(sealed), TOKEN);
    OK('two seals of the same token differ (fresh IV each time)', secrets.seal(TOKEN) !== sealed);

    // GCM's authentication tag is the point of choosing it: a blob somebody has
    // edited must fail closed, not decrypt to something else.
    const parts = sealed.split('.');
    const flipped = [parts[0], parts[1], parts[2], parts[3].slice(0, -4) + 'AAAA'].join('.');
    T('an edited blob opens to nothing', secrets.open(flipped), '');
    T('so does a truncated one', secrets.open(parts.slice(0, 3).join('.')), '');
    T('so does something that was never sealed', secrets.open('sbp_plain_token'), '');

    // Key rotation is meant to be survivable: the convenience lapses, nothing
    // throws, and the VA is asked for a token again.
    const other = require('crypto').scryptSync('a different key entirely', 'x', 32);
    const wrongKey = (() => {
        const crypto = require('crypto');
        const iv = Buffer.from(parts[1], 'base64url');
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', other, iv);
            d.setAuthTag(Buffer.from(parts[2], 'base64url'));
            Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]);
            return 'decrypted';
        } catch { return 'refused'; }
    })();
    T('a different key cannot open it', wrongKey, 'refused');

    console.log('\nthe hint shown to staff');
    const hint = secrets.hint(TOKEN);
    T('keeps the prefix and the last four', hint, 'sbp_…012345'.replace('012345', TOKEN.slice(-4)));
    OK('and drops the middle entirely — not a mask over it', !hint.includes(TOKEN.slice(4, -4)), hint);

    // -----------------------------------------------------------------------
    // updateSchema against an impersonated Management API
    // -----------------------------------------------------------------------
    const GOOD_TOKEN = 'sbp_kept_token';
    const OTHER_ACCOUNT_TOKEN = 'sbp_someone_elses';
    const projects = {
        [GOOD_TOKEN]: [
            { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'crew-center', region: 'us-east-1', status: 'ACTIVE_HEALTHY' },
            { id: 'cccccccccccccccccccc', name: 'paused-one', region: 'us-east-1', status: 'INACTIVE' },
        ],
        [OTHER_ACCOUNT_TOKEN]: [
            { id: 'dddddddddddddddddddd', name: 'not-ours', region: 'us-east-1', status: 'ACTIVE_HEALTHY' },
        ],
    };
    const ranSql = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (code, payload) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
            const mine = projects[token];
            if (!mine) return send(401, { message: 'Unauthorized' });
            const m = url.pathname.match(/^\/v1\/projects\/([^/]+)(\/.*)?$/);
            if (!m) return send(404, { message: 'no such endpoint' });
            const project = mine.find((x) => x.id === m[1]);
            if (!project) return send(404, { message: 'Project not found' });
            if (!m[2]) return send(200, project);
            if (m[2] === '/database/query') {
                ranSql.push({ ref: project.id, query: JSON.parse(body || '{}').query, token });
                return send(201, []);
            }
            send(404, { message: 'no such endpoint' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.SUPABASE_API_URL = `http://127.0.0.1:${server.address().port}`;
    const crewSetup = require(path.join('..', 'crewSetup.js'));
    const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'crew-center-schema.sql'), 'utf8');

    console.log('\nupdating a connected project with the kept token');
    const out = await crewSetup.updateSchema({ accessToken: GOOD_TOKEN, ref: 'aaaaaaaaaaaaaaaaaaaa', sql: SQL });
    T('it reports the project it updated', out.project.ref, 'aaaaaaaaaaaaaaaaaaaa');
    T('exactly one script ran', ranSql.length, 1);
    T('against that project and no other', ranSql[0].ref, 'aaaaaaaaaaaaaaaaaaaa');
    OK('and what ran is OUR file, verbatim', ranSql[0].query === SQL);
    OK('which carries the storage report the usage screen needs',
        /create or replace function crew_storage_usage/i.test(ranSql[0].query));

    console.log('\nwhen the kept token has stopped working');
    const grab = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

    const revoked = await grab(() => crewSetup.updateSchema({ accessToken: 'sbp_revoked', ref: 'aaaaaaaaaaaaaaaaaaaa', sql: SQL }));
    T('a revoked token is bad_token', revoked && revoked.code, 'bad_token');
    OK('…and points at where to make a new one', /account\/tokens/.test(revoked.message), revoked.message);

    // The other way a kept token dies: still valid, but the VA made it on a
    // different Supabase account. Same symptom to a user, different fix, so the
    // codes must not be the same.
    const elsewhere = await grab(() => crewSetup.updateSchema({ accessToken: OTHER_ACCOUNT_TOKEN, ref: 'aaaaaaaaaaaaaaaaaaaa', sql: SQL }));
    T('a token from another account is project_not_found', elsewhere && elsewhere.code, 'project_not_found');
    OK('the two failures are told apart', revoked.code !== elsewhere.code);

    const paused = await grab(() => crewSetup.updateSchema({ accessToken: GOOD_TOKEN, ref: 'cccccccccccccccccccc', sql: SQL }));
    T('a paused project is refused, not half-updated', paused && paused.code, 'project_not_ready');
    T('and nothing was run against it', ranSql.filter((r) => r.ref === 'cccccccccccccccccccc').length, 0);

    const notOurs = await grab(() => crewSetup.updateSchema({
        accessToken: GOOD_TOKEN, ref: 'aaaaaaaaaaaaaaaaaaaa', sql: 'drop table crew_members;' }));
    T('a script that is not ours never reaches the project', notOurs && notOurs.code, 'schema_unavailable');
    T('and the run count is unchanged', ranSql.length, 1);

    console.log('\nchecking a token before we agree to keep it');
    const checked = await crewSetup.checkAccess(GOOD_TOKEN, 'aaaaaaaaaaaaaaaaaaaa');
    T('a live token on a healthy project is ready', checked.ready, true);
    const checkPaused = await crewSetup.checkAccess(GOOD_TOKEN, 'cccccccccccccccccccc');
    T('a paused project is reachable but not ready', { found: !!checkPaused.project, ready: checkPaused.ready }, { found: true, ready: false });
    T('and nothing was run by merely checking', ranSql.length, 1);

    server.close();
    console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

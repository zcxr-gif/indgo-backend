/*
 * scripts/test-session-cookies.js — part of `npm run test:sites`
 *
 * The platform's session cookies, in both environments.
 *
 * These names matter more than they used to. Virtual airline websites are
 * served from `<their slug>.<our domain>`, so a VA's own JavaScript runs on a
 * subdomain of ours and could otherwise write a cookie at the parent domain
 * that shadows one of these. The `__Host-` prefix is what stops it, in the
 * browser, and this file is what stops the prefix quietly going away.
 *
 * The functions are lifted out of the modules and run against a fake req/res
 * rather than booting them: vaPortal.js and staffAuth.js each want Mongo, and
 * this question has nothing to do with a database.
 *
 * Run with no argument to check both environments.
 */

// No argument: run both environments in their own processes, because the names
// are decided once, when the module is first loaded.
if (!process.argv[2]) {
    const { execFileSync } = require('child_process');
    let bad = 0;
    for (const mode of ['production', 'development']) {
        try { execFileSync(process.execPath, [__filename, mode], { stdio: 'inherit' }); }
        catch { bad++; }
    }
    process.exit(bad ? 1 : 0);
}

const path = require('path');
const mode = process.argv[2];
process.env.NODE_ENV = mode;
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.MONGODB_URI = 'mongodb://127.0.0.1/none';

const files = { vaPortal: 'va_portal_token', staffAuth: 'staff_token' };
let bad = 0;
for (const [file, base] of Object.entries(files)) {
    const src = require('fs').readFileSync(path.join(__dirname, '..', file + '.js'), 'utf8');
    // Pull the three functions out and run them against a fake req/res. Cheaper
    // and more honest than booting a module that wants Mongo and Discord.
    const grab = (re) => { const m = src.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
    const body = [
        grab(/const SECURE_COOKIES = [^\n]*\nconst LEGACY_COOKIE_NAME = [^\n]*\nconst COOKIE_NAME = [^\n]*/),
        grab(/const COOKIE_MAX_AGE = [^\n]*/),
        grab(/function getToken\(req\) \{[\s\S]*?\n\}/),
        grab(/function setAuthCookie\(res, token\) \{[\s\S]*?\n\}/),
        grab(/function clearAuthCookie\(res\) \{[\s\S]*?\n\}/),
    ].join('\n');
    const parse = grab(/function parseCookies\(req\)[\s\S]*?\n\}/);
    const run = new Function('return (function(){' + body + '\n' + parse + '\nreturn {getToken,setAuthCookie,clearAuthCookie,COOKIE_NAME,LEGACY_COOKIE_NAME};})()')();

    const expected = mode === 'production' ? '__Host-' + base : base;
    const ok = (name, cond, got) => { if (cond) console.log(`  ok   ${file}: ${name}`); else { bad++; console.log(`  FAIL ${file}: ${name} — ${got}`); } };

    ok('cookie name', run.COOKIE_NAME === expected, run.COOKIE_NAME);

    const set = [];
    const res = { cookie: (n, v, o) => set.push({ n, v, o }), clearCookie: (n, o) => set.push({ clear: n }) };
    run.setAuthCookie(res, 'tok');
    ok('written under that name', set[0].n === expected);
    ok('secure in production only', set[0].o.secure === (mode === 'production'));
    ok('path is /', set[0].o.path === '/');
    ok('no Domain attribute', set[0].o.domain === undefined);

    ok('reads the current name',
        run.getToken({ headers: { cookie: `${expected}=new` } }) === 'new');
    ok('still reads a session issued before the rename',
        run.getToken({ headers: { cookie: `${base}=old` } }) === 'old');
    ok('prefers the prefixed one when both are sent',
        run.getToken({ headers: { cookie: `${base}=old; __Host-${base}=new` } }) === (mode === 'production' ? 'new' : 'old'));
    ok('a bearer header still wins',
        run.getToken({ headers: { authorization: 'Bearer b', cookie: `${expected}=c` } }) === 'b');

    set.length = 0;
    run.clearAuthCookie(res);
    const cleared = set.filter(x => x.clear).map(x => x.clear);
    ok('sign-out clears both names', mode === 'production'
        ? (cleared.includes('__Host-' + base) && cleared.includes(base))
        : cleared.includes(base));
}
console.log(bad ? `\n${bad} FAILED (${mode})` : `\nall passed (${mode})`);
process.exit(bad ? 1 : 0);

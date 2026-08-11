#!/usr/bin/env node
'use strict';
/*
 * if-oauth-doctor.js — why does Infinite Flight say our client_id is invalid?
 *
 * Run it ON THE SERVER, where the environment and the network both are:
 *
 *     node scratchpad/if-oauth-doctor.js
 *
 * It changes nothing. It reads the configuration, shows exactly what we would
 * send, asks Infinite Flight where its OAuth endpoints actually are, and then
 * makes the real authorize request so the failure can be read in full.
 *
 * It exists because "the client id is correct" and "the client id works" are
 * different claims, and the three things that can separate them are all
 * invisible on screen:
 *
 *   1. CHARACTERS THAT DO NOT SHOW. A value pasted out of a web dashboard can
 *      carry a zero-width space (U+200B), a non-breaking space (U+00A0) or a
 *      smart quote. It looks identical in every editor and is a different
 *      string to a server. .trim() does not remove U+200B, and JavaScript's \s
 *      does not match it either, so nothing upstream catches it. Every byte is
 *      printed below.
 *
 *   2. THE WRONG AUTHORIZATION SERVER. A client registered on one host is
 *      unknown on another, and "unknown" is reported as "invalid". We default
 *      to api.infiniteflight.com/auth/v2 with auth.infiniteflight.com recorded
 *      as the issuer; if the real authorization endpoint is elsewhere, the id
 *      is fine and the address is not. Both are asked for their discovery
 *      document, and what they answer is compared with what we use.
 *
 *   3. A CLIENT THAT IS NOT USABLE YET. Infinite Flight limits a new client to
 *      "the owner and invited test users until the app is reviewed and
 *      approved". That refusal can arrive worded as a client problem while the
 *      id is perfectly real.
 *
 * Nothing secret is printed. The client id is public — it travels in the
 * authorization URL the browser follows — and the secret is reported only as
 * present or absent, never shown.
 */

const path = require('path');
const crypto = require('crypto');

// Load the environment the same way the server does, from the repo root.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* fine */ }

const ifOAuth = require(path.join(__dirname, '..', 'ifOAuth.js'));

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(`\x1b[1m${s}\x1b[0m`); line('─'.repeat(s.length)); };
const ok = (s) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => line(`  \x1b[31m✗\x1b[0m ${s}`);
const warn = (s) => line(`  \x1b[33m!\x1b[0m ${s}`);
const info = (s) => line(`    ${s}`);

/* ── 1. What is configured ─────────────────────────────────────────────── */

head('1. Configuration');

const raw = process.env.IF_OAUTH_CLIENT_ID;
const clientId = ifOAuth.PLATFORM_CLIENT.id;
const secret = ifOAuth.PLATFORM_CLIENT.secret;

if (raw === undefined) bad('IF_OAUTH_CLIENT_ID is not set at all.');
else if (!clientId) bad('IF_OAUTH_CLIENT_ID is set but empty once trimmed.');
else ok(`IF_OAUTH_CLIENT_ID is set (${clientId.length} characters after trimming)`);

info(`client secret:  ${secret ? `present (${secret.length} chars) → confidential client` : 'absent → public client, PKCE only'}`);
info(`authorization:  ${ifOAuth.AUTH_BASE}`);
info(`issuer (docs):  ${ifOAuth.ISSUER}`);
info(`redirect URI:   ${ifOAuth.REDIRECT_URI || '(not set — derived per request)'}`);

/* ── 2. Every byte of the client id ────────────────────────────────────── */

head('2. The client id, character by character');

if (!clientId) {
    bad('Nothing to inspect.');
} else {
    // Anything outside printable ASCII is suspicious in an OAuth client id.
    const suspects = [];
    const chars = [...clientId];
    chars.forEach((ch, i) => {
        const cp = ch.codePointAt(0);
        if (cp < 0x20 || cp > 0x7e) suspects.push({ i, ch, cp });
    });

    if (suspects.length === 0) {
        ok('All printable ASCII — no hidden characters.');
    } else {
        bad(`${suspects.length} character(s) outside printable ASCII. This is almost certainly the problem.`);
        for (const s of suspects) {
            const name = ({
                0x00a0: 'NO-BREAK SPACE',
                0x200b: 'ZERO WIDTH SPACE',
                0x200c: 'ZERO WIDTH NON-JOINER',
                0x200d: 'ZERO WIDTH JOINER',
                0xfeff: 'ZERO WIDTH NO-BREAK SPACE / BOM',
                0x2018: 'LEFT SINGLE QUOTE', 0x2019: 'RIGHT SINGLE QUOTE',
                0x201c: 'LEFT DOUBLE QUOTE', 0x201d: 'RIGHT DOUBLE QUOTE',
                0x2013: 'EN DASH', 0x2014: 'EM DASH',
            })[s.cp] || 'non-ASCII';
            info(`position ${s.i}: U+${s.cp.toString(16).toUpperCase().padStart(4, '0')} ${name}`);
        }
        info('Retype the id by hand rather than pasting it, or paste it through a plain-text editor first.');
    }

    // The raw value before trimming, so surrounding whitespace shows up too.
    if (raw !== clientId) {
        warn(`The variable has surrounding whitespace (${JSON.stringify(raw)}). We trim it, so this alone is harmless.`);
    }
    info(`hex: ${Buffer.from(clientId, 'utf8').toString('hex')}`);

    const problem = ifOAuth.clientIdProblem(clientId);
    if (problem) bad(problem); else ok('Passes our own sanity check.');
}

/* ── 3. The exact request we would make ────────────────────────────────── */

head('3. The authorize URL we would send');

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const redirectUri = ifOAuth.REDIRECT_URI || 'https://example.invalid/api/crew/if/callback';
const authorizeUrl = ifOAuth.authorizeUrl({
    clientId,
    redirectUri,
    scopes: ['live:aircraft.read'],
    state: 'doctor-' + crypto.randomBytes(6).toString('hex'),
    challenge,
});
line(authorizeUrl);
if (!ifOAuth.REDIRECT_URI) warn('IF_OAUTH_REDIRECT_URI is not set, so a placeholder redirect is shown above.');

/* ── 4. Where Infinite Flight says its endpoints are ───────────────────── */

const fetchText = async (url) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    try {
        const r = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: c.signal });
        return { status: r.status, body: await r.text().catch(() => ''), location: r.headers.get('location') || '' };
    } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
    } finally { clearTimeout(t); }
};

(async () => {
    head('4. Discovery — where the OAuth endpoints really are');

    const candidates = [
        ifOAuth.AUTH_BASE,
        String(ifOAuth.ISSUER || '').replace(/\/+$/, ''),
        'https://api.infiniteflight.com/auth/v2',
        'https://auth.infiniteflight.com',
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let discovered = null;
    for (const base of candidates) {
        const url = `${base}/.well-known/openid-configuration`;
        const res = await fetchText(url);
        if (res.error) { warn(`${url} — ${res.error}`); continue; }
        let doc = null;
        try { doc = JSON.parse(res.body); } catch { /* not JSON */ }
        if (res.status === 200 && doc && doc.authorization_endpoint) {
            ok(`${url} → 200`);
            info(`authorization_endpoint: ${doc.authorization_endpoint}`);
            info(`token_endpoint:         ${doc.token_endpoint || '(none)'}`);
            if (!discovered) discovered = doc;
        } else {
            warn(`${url} → ${res.status}${res.body ? ' ' + res.body.slice(0, 120).replace(/\s+/g, ' ') : ''}`);
        }
    }

    if (discovered) {
        const ours = `${ifOAuth.AUTH_BASE}/connect/authorize`;
        if (discovered.authorization_endpoint !== ours) {
            bad('We are NOT posting to the advertised authorization endpoint.');
            info(`we use:    ${ours}`);
            info(`they say:  ${discovered.authorization_endpoint}`);
            const base = String(discovered.authorization_endpoint).replace(/\/connect\/authorize$/, '');
            info(`Fix: set IF_OAUTH_BASE_URL=${base}`);
        } else {
            ok('Our authorization endpoint matches the advertised one.');
        }
    } else {
        warn('No discovery document answered. That is not conclusive — not every server publishes one.');
    }

    /* ── 5. Reproduce the failure ──────────────────────────────────────── */

    head('5. The real request, and what comes back');

    const res = await fetchText(authorizeUrl);
    if (res.error) {
        bad(`Could not reach it — ${res.error}`);
    } else {
        line(`  HTTP ${res.status}${res.location ? `  → ${res.location}` : ''}`);
        if (res.body) {
            const body = res.body.slice(0, 700);
            line();
            line(body.split('\n').map((l) => '    ' + l).join('\n'));
        }
        line();
        if (res.status >= 300 && res.status < 400) {
            ok('A redirect is what success looks like here — the browser would follow it to the sign-in page.');
        } else if (/client_id/i.test(res.body)) {
            bad('Infinite Flight does not know this client id.');
            info('Given section 2 found no hidden characters and section 4 matched, the remaining causes are:');
            info('  • the client was created on a different Infinite Flight account');
            info('  • the value is the application NAME or an internal id, not the client_id');
            info('  • the client exists but is not approved for general use yet — Infinite Flight');
            info('    limits a new one to "the owner and invited test users until the app is');
            info('    reviewed and approved", and that can surface worded as a client problem');
            info('Ask Infinite Flight to confirm the client_id string and its approval state.');
        }
    }

    line();
})();

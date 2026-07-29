'use strict';

/*
 * crewSecrets.js
 * Encryption at rest for the handful of VA secrets we hold on a VA's behalf.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Supabase personal access token is the credential that makes a schema update
 * a button rather than a chore (see crewSetup.js). Keeping one, though, changes
 * what a copy of our database is worth: a service_role key opens one project,
 * but a PAT opens the whole Supabase account that issued it. So a stored PAT
 * does not sit in Mongo as text. It is sealed here first, with a key that lives
 * in the environment and not in the database, so a dump of the collection is a
 * pile of ciphertext rather than a pile of account credentials.
 *
 * AES-256-GCM: authenticated, so a blob that has been edited fails to open
 * instead of decrypting to something else. Every seal gets a fresh 12-byte IV.
 *
 * THE KEY
 * -------
 *   CREW_SECRET_KEY   preferred. 32 raw bytes as hex or base64, or any
 *                     passphrase of 16+ characters (scrypt-stretched).
 *   JWT_SECRET        fallback, so an existing deployment gets sealing without
 *                     new configuration. Derived through scrypt with a label of
 *                     its own, so this key and the one that signs sessions are
 *                     unrelated even though they come from the same secret.
 *
 * With neither set, available() is false and nothing is stored: callers fall
 * back to asking the VA for the token each time, which is exactly where they
 * were before. We would rather lose the convenience than hold an account-wide
 * credential in the clear.
 *
 * ROTATION IS SAFE, IF LOSSY. Change the key and every sealed value stops
 * opening — open() returns '' rather than throwing, callers treat that as "we
 * haven't got it" and ask the VA to paste theirs again. Nothing breaks; a
 * convenience lapses.
 */

const crypto = require('crypto');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Distinct per purpose: two secrets derived from the same passphrase must not
// come out equal, or a key used for one thing quietly becomes a key for another.
const KDF_SALT = 'inflight:crew-secrets:v1';

let _key = null;          // resolved lazily, then cached
let _resolved = false;
let _warned = false;

// 32 raw bytes if the string IS a key; null if it is a passphrase to stretch.
function rawKey(value) {
    if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
    if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(value)) {
        try {
            const buf = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            if (buf.length === 32) return buf;
        } catch { /* not base64 after all — stretch it instead */ }
    }
    return null;
}

function resolveKey() {
    if (_resolved) return _key;
    _resolved = true;
    const configured = String(process.env.CREW_SECRET_KEY || '').trim();
    const fallback = String(process.env.JWT_SECRET || '').trim();
    const source = configured || fallback;
    if (!source || source.length < 16) {
        _key = null;
        return _key;
    }
    _key = rawKey(source) || crypto.scryptSync(source, KDF_SALT, 32);
    return _key;
}

/** Can we seal anything at all? False means: do not store secrets. */
function available() {
    return !!resolveKey();
}

/**
 * Why sealing is unavailable, in words a deployer can act on. Empty when it is
 * available — callers put this in the API response so the reason surfaces in
 * the dashboard rather than only in a log nobody reads.
 */
function unavailableReason() {
    if (available()) return '';
    return 'Set CREW_SECRET_KEY (or JWT_SECRET) on the backend to store Supabase access tokens.';
}

/**
 * Seal a secret. Returns 'v1.<iv>.<tag>.<ciphertext>', all base64url.
 * Returns '' when there is no key or nothing to seal — never plaintext, so a
 * caller that forgets to check available() stores nothing rather than storing
 * the secret unprotected.
 */
function seal(plaintext) {
    const text = String(plaintext || '');
    const key = resolveKey();
    if (!text) return '';
    if (!key) {
        if (!_warned) {
            _warned = true;
            console.warn('crewSecrets: no CREW_SECRET_KEY or JWT_SECRET — refusing to store secrets at rest.');
        }
        return '';
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * Open a sealed value. Returns '' for anything that does not open — a wrong
 * key, a truncated blob, a tampered one, or a field that was never sealed.
 *
 * Deliberately not an exception: every caller's answer to "this did not open"
 * is the same as its answer to "there was nothing stored" — ask the VA again —
 * and a throw here would turn a lapsed convenience into a 500.
 */
function open(blob) {
    const value = String(blob || '');
    const key = resolveKey();
    if (!value || !key) return '';
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) return '';
    try {
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ct = Buffer.from(parts[3], 'base64url');
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return '';
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
        return '';                    // wrong key, or somebody changed the bytes
    }
}

/** Does this look like something seal() produced? */
function isSealed(value) {
    const parts = String(value || '').split('.');
    return parts.length === 4 && parts[0] === VERSION;
}

/**
 * A non-secret label for a stored credential: enough for a VA to recognise
 * which token they saved ("that's the one I made in March"), not enough to be
 * worth anything. Keeps the prefix Supabase gives its tokens and the last four
 * characters; everything in between is dropped, never merely masked.
 */
function hint(secret) {
    const s = String(secret || '').trim();
    if (!s) return '';
    const prefix = /^sbp_/.test(s) ? 'sbp_' : '';
    const tail = s.slice(-4);
    return s.length <= 8 ? '••••' : `${prefix}…${tail}`;
}

module.exports = { available, unavailableReason, seal, open, isSealed, hint };

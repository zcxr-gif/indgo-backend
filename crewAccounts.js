'use strict';

/*
 * crewAccounts.js
 * A VA's pilots' crew center logins — created in, read from and changed in the
 * VA's OWN data store.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Pilot accounts used to be rows in our central VaPortalAccount collection,
 * alongside the VA's owner and staff logins. That made Inflight the custodian
 * of every pilot's credentials for every VA on the platform, which contradicts
 * the rule the rest of the crew center is built on: a VA's people are the VA's
 * data. So a pilot account is now a `crew_accounts` row inside the VA's own
 * Supabase project (see supabase/crew-center-schema.sql), reached through the
 * same crewStore interface as their roster and flight reports.
 *
 * What Inflight still holds centrally is the VA's *staff* logins — owner and
 * team accounts, which are how a VA administers its listing with us and are not
 * the VA's operational data. Pilots are.
 *
 * PASSWORDS
 * ---------
 * Nothing in THIS module stores a password. provisionPilotAccount and
 * resetPassword each generate one, return it once, and write only its bcrypt
 * hash to the VA's project. That remains true and is the property to protect
 * when changing anything here: the account's credential is the hash, and the
 * hash is all that lives on crew_accounts.
 *
 * What did change: the caller may now keep the returned password for a while.
 * An acceptance records it on the application row as an INVITATION, so a staff
 * member can still hand it over an hour later on the IFC and the applicant can
 * read it off their own status link. That copy is deliberately short-lived and
 * self-deleting — it is cleared the moment the pilot signs in, when staff
 * discard it, or when it ages out. crewInvite.js owns that lifecycle and
 * explains the trade; the schema file explains why it is not encrypted.
 *
 * So "there is no resend my password" is no longer quite the rule. There is a
 * window in which the invitation can be re-read, and after it closes the only
 * route back in is still a reset that mints a new one.
 *
 * The bcrypt cost (12) matches vaPortal/staffAuth, so a login costs the same
 * wherever the account lives.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

// Ambiguous glyphs (0/O, 1/l/I) are left out: these get read off a screen or
// out of an email and typed by hand, and a password that cannot be transcribed
// is a support ticket.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 14) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    return out;
}

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// A username derived from the pilot's name: lower-case, letters/digits/dots
// only. `usernameFor` then makes it unique within THIS crew center — uniqueness
// is per-VA now, not global, because the row lives in the VA's own project.
// Two VAs can each have a `jsmith`, and neither has to know about the other.
function baseUsername(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 24);
    return slug || 'pilot';
}

async function usernameFor(store, name) {
    const base = baseUsername(name);
    if (!await store.getAccountByUsername(base)) return base;
    // Numbered suffixes first (jsmith2, jsmith3 — the readable outcome), then a
    // random tail if this VA really does have a crowd of same-named pilots.
    for (let n = 2; n <= 9; n++) {
        const candidate = `${base}${n}`;
        if (!await store.getAccountByUsername(candidate)) return candidate;
    }
    for (let i = 0; i < 5; i++) {
        const candidate = `${base}.${crypto.randomBytes(2).toString('hex')}`;
        if (!await store.getAccountByUsername(candidate)) return candidate;
    }
    throw new Error('Could not find a free username for this pilot.');
}

/**
 * Provision a crew center login for a pilot, in the VA's own data store.
 *
 * Idempotent per pilot: called again for someone who already has an account it
 * returns theirs with `created: false` and no password, rather than minting a
 * second login or silently resetting the one they are already using. Identity
 * is the roster row when we have one (`memberId`) and the display name
 * otherwise — the join flow runs on the applicant's IFC name, so that is the
 * only handle a pilot accepted without a roster link has.
 *
 * @param {Object} store            a crewStore adapter (SupabaseStore | LegacyStore)
 * @param {Object} opts
 * @param {string} opts.displayName the pilot's name (their IFC name)
 * @param {string} [opts.memberId]  the roster row this login belongs to
 * @param {string} [opts.email]     so the VA can tell two same-named pilots apart
 * @param {string} [opts.createdByName]  which staff member accepted them
 * @param {string} [opts.vaName]    only used by the legacy adapter's denormalised copy
 * @returns {{account: Object, created: boolean, username: string, password: string|null}}
 */
async function provisionPilotAccount(store, opts = {}) {
    if (!store) throw new Error('provisionPilotAccount requires a crew store.');
    const displayName = clean(opts.displayName, 80);
    if (!displayName) throw new Error('provisionPilotAccount requires the pilot\'s name.');

    const existing = (opts.memberId && await store.getAccountByMember(opts.memberId))
        || await findByDisplayName(store, displayName);
    if (existing) {
        // Re-link a name-matched account to the roster row we now know about,
        // so the next lookup is by id rather than by a name someone may rename.
        if (opts.memberId && !existing.memberId) {
            await store.updateAccount(existing._id, { memberId: opts.memberId }).catch(() => {});
        }
        return { account: existing, created: false, username: existing.username, password: null };
    }

    const username = await usernameFor(store, displayName);
    const password = generatePassword();
    const account = await store.createAccount({
        username,
        displayName,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: 'pilot',
        memberId: opts.memberId || null,
        email: clean(opts.email, 120).toLowerCase(),
        active: true,
        mustChangePassword: true,
        createdVia: 'crew-center',
        createdByName: clean(opts.createdByName, 80),
        vaName: opts.vaName || '',
    });
    return { account, created: true, username, password };
}

// The name match is done in JS over the account list rather than as a query:
// the store interface has no case-insensitive name filter, rosters are small
// (hundreds, not millions), and this runs once per acceptance.
async function findByDisplayName(store, displayName) {
    const wanted = displayName.toLowerCase();
    const all = await store.listAccounts({ limit: 5000 });
    return all.find((a) => String(a.displayName || '').toLowerCase() === wanted) || null;
}

/**
 * Check a username/password against the VA's own store.
 *
 * Returns null for "no such account", "wrong password" and "account disabled"
 * alike — the caller must not be able to tell which, and neither must the
 * person at the keyboard.
 *
 * A store that cannot answer (unreachable project, or one still on a schema
 * without crew_accounts) throws; the login route treats that as "not this
 * identity" and carries on down its cascade, so a VA mid-setup does not lock
 * its own staff out of the dashboard.
 */
async function authenticate(store, username, password) {
    const u = clean(username, 60).toLowerCase();
    const p = String(password || '');
    if (!u || !p) return null;
    const account = await store.getAccountByUsername(u);
    if (!account || !account.active || !account.passwordHash) return null;
    if (!await bcrypt.compare(p, account.passwordHash)) return null;
    // Best-effort: a failure to record the timestamp must not fail the login.
    store.updateAccount(account._id, { lastLoginAt: new Date() }).catch(() => {});
    return account;
}

/**
 * Change a pilot's own password. Requires the current one — a valid session is
 * not enough, because the session may be sitting on an unattended screen and
 * the password is the thing that gets it back.
 *
 * @returns {{ok: true} | {error: string, status: number}}
 */
async function changePassword(store, accountId, currentPassword, newPassword) {
    const account = await store.getAccount(accountId);
    if (!account) return { error: 'Account not found.', status: 404 };
    const next = String(newPassword || '');
    if (next.length < MIN_PASSWORD_LENGTH) {
        return { error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`, status: 400 };
    }
    if (!account.passwordHash || !await bcrypt.compare(String(currentPassword || ''), account.passwordHash)) {
        return { error: 'Your current password is incorrect.', status: 401 };
    }
    if (await bcrypt.compare(next, account.passwordHash)) {
        return { error: 'Choose a password you are not already using.', status: 400 };
    }
    await store.updateAccount(account._id, {
        passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS),
        mustChangePassword: false,
    });
    return { ok: true };
}

/**
 * Staff resetting a pilot's password for them. Returns the new password once,
 * on the same terms as provisioning: it is shown and then gone.
 */
async function resetPassword(store, accountId) {
    const account = await store.getAccount(accountId);
    if (!account) return null;
    const password = generatePassword();
    await store.updateAccount(account._id, {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        mustChangePassword: true,
    });
    return { username: account.username, password };
}

// What staff are allowed to see about a pilot's login. Never the hash — this is
// the only shape any handler returns, so there is one place to get it wrong.
const publicAccount = (a) => a && {
    id: a._id,
    username: a.username,
    displayName: a.displayName || '',
    memberId: a.memberId || null,
    active: a.active !== false,
    mustChangePassword: !!a.mustChangePassword,
    lastLoginAt: a.lastLoginAt || null,
    createdAt: a.createdAt || null,
};

module.exports = {
    provisionPilotAccount,
    authenticate,
    changePassword,
    resetPassword,
    publicAccount,
    generatePassword,
    baseUsername,
    usernameFor,
    MIN_PASSWORD_LENGTH,
};

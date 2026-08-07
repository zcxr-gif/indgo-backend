'use strict';

/*
 * ifOauth.js
 * OAuth2 client for Infinite Flight PublicApi v3.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The v2 API we already use is a single server-side API key: one credential,
 * ours, that reads public Live data for everybody. v3 is different in kind. It
 * reads data that belongs to a *person* — the Live organizations they are a
 * member of, the aircraft in those organizations, the schedules on them — and
 * so it is authorized per user, by that user, through OAuth2.
 *
 * Concretely, for a VA connecting their Live organization:
 *
 *   1. A staff member clicks "Connect". We send them to Infinite Flight with a
 *      list of scopes we want and a one-time `state` we remember.
 *   2. They sign in at auth.infiniteflight.com and approve. IF redirects them
 *      back to us with a short-lived `code`.
 *   3. We swap that code for an access token (30 min) and a refresh token, from
 *      this server, and never in the browser.
 *   4. We call the API with the access token. When it expires we spend the
 *      refresh token for a new pair.
 *
 * WHY PKCE, GIVEN WE ARE CONFIDENTIAL
 * -----------------------------------
 * PKCE stops an intercepted authorization code being redeemed by whoever
 * intercepted it. We invent a random `code_verifier`, send only its SHA-256
 * hash up front, and reveal the verifier at token exchange — so a stolen code
 * is worthless without the verifier, which never left this server. IF requires
 * it of both client types, and it costs us nothing.
 *
 * WHY THE TOKENS ARE SEALED
 * -------------------------
 * A refresh token here is standing permission to read a VA's organization for
 * as long as they leave us connected. It is sealed with crewSecrets (AES-256-GCM
 * under a key that lives in the environment, not in Mongo) for the same reason
 * the Supabase PAT is: a dump of the collection should be ciphertext, not a set
 * of live credentials. With no key configured, available() is false and we
 * refuse to connect at all rather than write bearer tokens in the clear.
 *
 * REFRESH TOKENS ROTATE. Every refresh returns a new one and invalidates the
 * old. Store what comes back or the connection dies at the following refresh.
 *
 * THIS API IS A PREVIEW. Infinite Flight say plainly that v3 paths, scopes,
 * response fields, enum values and rate limits may change before general
 * availability, and not to build a production dependency on it. So nothing here
 * is load-bearing: a VA's hand-built fleet stays exactly where it was, this only
 * adds a synced mirror alongside it, and every failure path degrades to "not
 * connected" rather than breaking the crew center.
 *
 * CONFIGURATION
 *   IF_OAUTH_CLIENT_ID       required. From infiniteflight.com/account/api-keys.
 *   IF_OAUTH_CLIENT_SECRET   required for a confidential client (this one).
 *   PUBLIC_BASE_URL          required. The redirect URI is derived from it and
 *                            must match what is registered with IF exactly.
 * With any of those missing, configured() is false and the feature stays dark.
 */

const crypto = require('crypto');

// ── Endpoints ─────────────────────────────────────────────────────────────
const AUTH_BASE = process.env.IF_OAUTH_AUTH_BASE || 'https://api.infiniteflight.com/auth/v2';
const API_BASE  = process.env.IF_OAUTH_API_BASE  || 'https://api.infiniteflight.com/public/v3';

const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;
const TOKEN_URL     = `${AUTH_BASE}/connect/token`;

// The callback path. Registered with IF as PUBLIC_BASE_URL + this, exactly.
const CALLBACK_PATH = '/api/crew/if-org/callback';

// Only what the fleet feature needs. `offline_access` is what earns a refresh
// token — without it the connection would die thirty minutes after it is made
// and a VA would have to re-authorize to sync. We do not ask for
// live:schedules.write: nothing here writes to a VA's real Live schedules, and
// a scope we cannot use is a permission we should not hold.
const SCOPES = [
    'openid',
    'profile',
    'offline_access',
    'live:organizations.read',
    'live:aircraft.read',
    'live:schedules.read',
];

// Access tokens last ~30 min. Refresh a little early so a call that starts just
// before the boundary doesn't land just after it.
const EXPIRY_SKEW_MS = 60 * 1000;

const HTTP_TIMEOUT_MS = 12000;

// ── Configuration ─────────────────────────────────────────────────────────

function clientId()     { return String(process.env.IF_OAUTH_CLIENT_ID || '').trim(); }
function clientSecret() { return String(process.env.IF_OAUTH_CLIENT_SECRET || '').trim(); }
function publicBase()   { return String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''); }

/** The redirect URI. Must byte-match the one registered with Infinite Flight. */
function redirectUri() {
    const base = publicBase();
    return base ? base + CALLBACK_PATH : '';
}

/** True when this deployment can actually run the flow. */
function configured() {
    return !!(clientId() && clientSecret() && publicBase());
}

/** Why not, in words a VA-facing settings page can print. */
function unavailableReason() {
    if (!clientId())     return 'IF_OAUTH_CLIENT_ID is not set on the server.';
    if (!clientSecret()) return 'IF_OAUTH_CLIENT_SECRET is not set on the server.';
    if (!publicBase())   return 'PUBLIC_BASE_URL is not set, so the OAuth redirect URI cannot be built.';
    return '';
}

// ── PKCE ──────────────────────────────────────────────────────────────────

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh PKCE pair plus the one-time `state` that ties a callback back to the
 * request that started it. The verifier is 43 characters of base64url (32 bytes
 * of entropy), inside the spec's 43-128 range.
 */
function createPkce() {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge, state: b64url(crypto.randomBytes(24)) };
}

/**
 * The URL to send the staff member to.
 *
 * `prompt=consent` is offered because IF may skip the consent screen for a user
 * who already approved these scopes and redirect straight back. That is normal
 * and good for returning users, so it is off by default; pass it only where a
 * redirect has to follow a user gesture.
 */
function authorizeUrl({ challenge, state, prompt }) {
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId(),
        redirect_uri: redirectUri(),
        scope: SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    if (prompt) q.set('prompt', String(prompt));
    return `${AUTHORIZE_URL}?${q.toString()}`;
}

// ── Token endpoint ────────────────────────────────────────────────────────

// The OAuth2 token endpoint takes form encoding, not JSON. Getting this wrong
// produces a confusing 400 that looks like bad credentials.
async function postForm(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(body).toString(),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    let json = null;
    try { json = await res.json(); } catch (_) { /* handled below */ }

    if (!res.ok || !json || !json.access_token) {
        // OAuth errors come back as { error, error_description }. Surface the
        // description — "invalid_grant" alone tells a VA nothing.
        const detail = (json && (json.error_description || json.error)) || `HTTP ${res.status}`;
        const err = new Error(`Infinite Flight rejected the token request: ${detail}`);
        err.status = res.status;
        err.oauthError = json && json.error;
        throw err;
    }
    return normalizeTokens(json);
}

/**
 * Turn a token response into what we persist. `expiresAt` is absolute so a
 * stored connection can be judged stale without knowing when it was written.
 */
function normalizeTokens(json) {
    const ttlSec = Number(json.expires_in) || 1800;
    return {
        accessToken: String(json.access_token),
        refreshToken: json.refresh_token ? String(json.refresh_token) : '',
        expiresAt: Date.now() + ttlSec * 1000,
        scopes: String(json.scope || SCOPES.join(' ')).split(/\s+/).filter(Boolean),
    };
}

/** Swap the authorization code from the callback for tokens. */
async function exchangeCode({ code, verifier }) {
    return postForm({
        grant_type: 'authorization_code',
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
    });
}

/**
 * Spend a refresh token for a new pair.
 *
 * The result always carries a refreshToken: IF rotates them, but if a response
 * ever omits one, falling back to the token we just spent is safer than
 * returning empty and silently dropping the connection.
 */
async function refreshTokens(refreshToken) {
    const next = await postForm({
        grant_type: 'refresh_token',
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: refreshToken,
    });
    if (!next.refreshToken) next.refreshToken = refreshToken;
    return next;
}

// ── Calling the API ───────────────────────────────────────────────────────

/**
 * v3 wraps every response in { errorCode, result }. errorCode 0 is success;
 * anything else is a failure that may still arrive with HTTP 200, so the
 * envelope has to be checked rather than the status alone.
 */
function unwrap(json) {
    if (!json || typeof json !== 'object') throw new Error('Infinite Flight returned an empty response.');
    if (typeof json.errorCode === 'number' && json.errorCode !== 0) {
        const err = new Error(`Infinite Flight returned errorCode ${json.errorCode}.`);
        err.ifErrorCode = json.errorCode;
        throw err;
    }
    return json.result;
}

// What each HTTP status means here, phrased for the person who has to fix it.
function describeStatus(status) {
    switch (status) {
        case 400: return 'Infinite Flight rejected the request as invalid.';
        case 401: return 'The Infinite Flight connection has expired. Reconnect the organization.';
        case 403: return 'Infinite Flight refused this request — the app may still be in testing, '
                       + 'the scope may be missing, or this account may not have access to that organization.';
        case 404: return 'Infinite Flight has no such organization, aircraft or schedule for this account.';
        case 429: return 'Infinite Flight is rate limiting us. Try again shortly.';
        default:  return `Infinite Flight returned HTTP ${status}.`;
    }
}

/**
 * A GET against PublicApi v3 with a bearer token.
 *
 * Treats the access token as opaque — we never read its claims to decide
 * anything, per IF's guidance; if we want to know something, we ask the API.
 */
async function apiGet(path, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(API_BASE + path, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const err = new Error(describeStatus(res.status));
        err.status = res.status;
        throw err;
    }
    return unwrap(await res.json());
}

/**
 * Calls the API on behalf of a stored connection, refreshing first when the
 * access token is at or near expiry.
 *
 * `onTokens` is invoked with the new token set whenever a refresh happens, so
 * the caller can persist the rotated refresh token. Skipping that persistence
 * breaks the connection one refresh later, when the rotated-away token is
 * rejected — which is why this is a required argument rather than optional.
 *
 * @param {Object}   conn      { accessToken, refreshToken, expiresAt }
 * @param {string}   path      path under /public/v3, e.g. '/live/organizations'
 * @param {Function} onTokens  async (tokens) => void — persist them
 */
async function callWithConnection(conn, path, onTokens) {
    if (!conn || !conn.accessToken) throw new Error('This organization is not connected to Infinite Flight.');
    if (typeof onTokens !== 'function') throw new Error('callWithConnection requires an onTokens persister.');

    let tokens = conn;

    const stale = !conn.expiresAt || Date.now() >= (Number(conn.expiresAt) - EXPIRY_SKEW_MS);
    if (stale) {
        if (!conn.refreshToken) throw new Error('The Infinite Flight connection has expired. Reconnect the organization.');
        tokens = await refreshTokens(conn.refreshToken);
        await onTokens(tokens);
    }

    try {
        return await apiGet(path, tokens.accessToken);
    } catch (e) {
        // A 401 on a token we believed was live means it was revoked or cut
        // short. One refresh-and-retry, then give up — retrying a second time
        // would just spend the rotated token against the same rejection.
        if (e && e.status === 401 && !stale && tokens.refreshToken) {
            const next = await refreshTokens(tokens.refreshToken);
            await onTokens(next);
            return apiGet(path, next.accessToken);
        }
        throw e;
    }
}

// ── Enums ─────────────────────────────────────────────────────────────────
// v3 sends enums as bare numbers. These give them names for display. IF warn
// that values may be adjusted during the preview, so every lookup falls back to
// something printable rather than showing a naked integer or crashing.

const ORGANIZATION_TYPE = {
    0: 'Auto join', 1: 'Manual join', 2: 'Apply to join', 3: 'Invite only', 4: 'Single member',
};
const OPERATION_TYPE = {
    0: 'Undefined', 1: 'Airline', 2: 'Charter', 3: 'Freight',
    4: 'Military', 5: 'Flight school', 6: 'Private',
};
const WORLD_TYPE = { 0: 'Solo', 1: 'Casual', 2: 'Training', 3: 'Expert', 4: 'Private' };
const ORGANIZATION_STATUS = { 0: 'Active', 1: 'Suspended', 2: 'Deleted' };
const AIRCRAFT_STATUS = { 0: 'Active', 1: 'Deleted' };
const AIRCRAFT_VISIBILITY = { 0: 'Unknown', 1: 'Visible', 2: 'Hangared' };
const PERSISTENCE_STATE = {
    0: 'Unknown', 1: 'On ground', 2: 'In flight', 3: 'Cancelled', 4: 'Stopped', 5: 'Maintenance',
};
const SCHEDULE_STATUS = {
    0: 'Unknown', 1: 'Scheduled', 2: 'Boarding', 3: 'Boarded', 4: 'Taxiing to runway',
    6: 'In flight', 7: 'Diverted', 8: 'Delayed', 9: 'Cancelled',
    10: 'Taxiing to parking', 11: 'Arrived',
};
const FLIGHT_TYPE = {
    0: 'None', 1: 'Commercial', 2: 'Charter', 3: 'Cargo', 4: 'Training', 5: 'Test flight',
    6: 'Medical emergency', 7: 'Military', 8: 'VIP / executive', 9: 'Humanitarian relief',
    10: 'General aviation', 11: 'Airshow', 12: 'Other',
};

/** Name for an enum value, or a readable placeholder for one we don't know. */
function enumName(map, value) {
    if (value == null) return '';
    const hit = map[value];
    return hit != null ? hit : `Unknown (${value})`;
}

module.exports = {
    configured, unavailableReason, redirectUri, CALLBACK_PATH, SCOPES,
    createPkce, authorizeUrl,
    exchangeCode, refreshTokens, callWithConnection,
    apiGet, unwrap, normalizeTokens, describeStatus,
    enumName,
    ORGANIZATION_TYPE, OPERATION_TYPE, WORLD_TYPE, ORGANIZATION_STATUS,
    AIRCRAFT_STATUS, AIRCRAFT_VISIBILITY, PERSISTENCE_STATE, SCHEDULE_STATUS, FLIGHT_TYPE,
    _internals: { EXPIRY_SKEW_MS, AUTHORIZE_URL, TOKEN_URL, API_BASE },
};

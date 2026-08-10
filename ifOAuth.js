'use strict';

/*
 * ifOAuth.js
 * Talking to Infinite Flight PublicApi v3: the OAuth2 handshake, and the
 * transport underneath every Live call.
 *
 * WHAT LIVES HERE
 * ---------------
 * The half of the integration that touches the network. PKCE generation, the
 * authorization URL, the code exchange, the refresh (with its rotation), and a
 * `call()` that turns "GET /live/organizations" into either a result or an
 * IfApiError worth showing somebody. On top of that sits one thin function per
 * documented endpoint, so a route in server.js reads as
 * `ifOAuth.listAircraft(token, orgId)` and not as a URL.
 *
 * The decisions — what a schedule is allowed to say, what enum 6 means, what to
 * do about a field we have never seen — are in ifLive.js. This file does no
 * validation of its own beyond what it needs to build a request.
 *
 * THE THREE BASE URLS, AND WHY THEY ARE SEPARATE
 * ---------------------------------------------
 * The preview publishes three, and they genuinely differ:
 *
 *   authorization server   https://api.infiniteflight.com/auth/v2
 *   PublicApi v3           https://api.infiniteflight.com/public/v3
 *   OAuth2 issuer          https://auth.infiniteflight.com/
 *
 * We talk to the first two. The third is where the USER goes to sign in — the
 * authorize endpoint on api.infiniteflight.com redirects them there — so it
 * appears in no request we make, and is recorded here only so the next person
 * reading the docs does not wire it in by mistake.
 *
 * Both are overridable from the environment. Not for the sake of it: this is an
 * API whose own documentation says its paths may move before general
 * availability, and an env var is the difference between "change one value in
 * the dashboard" and "wait for a deploy" on the day it does.
 *
 * PKCE IS NOT OPTIONAL HERE
 * ------------------------
 * "Both client types must use PKCE." So there is no code path in this file that
 * builds an authorization request without a challenge, and no exchange that
 * omits the verifier — including for a confidential client that also holds a
 * secret. A confidential client sends both.
 *
 * WHAT THIS FILE WILL NOT DO
 * --------------------------
 * Read the access token. "Do not rely on JWT claim contents for product
 * behavior. Treat the access token as an opaque credential and call APIs to
 * retrieve data." Nothing here parses one, and nothing should: the tokens are
 * strings to be carried, and every fact about the user comes from an endpoint.
 */

const crypto = require('crypto');
const ifLive = require('./ifLive');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AUTH_BASE = (process.env.IF_OAUTH_BASE_URL || 'https://api.infiniteflight.com/auth/v2')
    .trim().replace(/\/+$/, '');
const API_BASE = (process.env.IF_V3_BASE_URL || 'https://api.infiniteflight.com/public/v3')
    .trim().replace(/\/+$/, '');

// The user-facing sign-in host. Never called from here — see the header — but
// exported so the connect screen can say where the VA is about to be sent.
const ISSUER = (process.env.IF_OAUTH_ISSUER || 'https://auth.infiniteflight.com/').trim();

// Where Infinite Flight sends the browser back to. One URI for the whole
// platform rather than one per VA: it has to be registered on the OAuth client
// exactly, and a per-VA URI would mean every VA editing their client every time
// they added a crew center. The VA is carried in the `state` instead, which is
// what state is for.
const REDIRECT_URI = (
    process.env.IF_OAUTH_REDIRECT_URI
    || (process.env.PUBLIC_BASE_URL ? `${String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '')}/api/crew/if/callback` : '')
).trim();

// The platform's own OAuth client, when there is one. A VA may bring their own
// instead (see clientFor in server.js) — which is the path that works today,
// because "testing clients are limited to the owner and invited test users
// until the app is reviewed and approved by Infinite Flight", and a VA's own
// client has the VA as its owner.
const PLATFORM_CLIENT = {
    id: (process.env.IF_OAUTH_CLIENT_ID || '').trim(),
    secret: (process.env.IF_OAUTH_CLIENT_SECRET || '').trim(),
    // A client with a secret is confidential; without one it is public and
    // leans on PKCE alone. Inferred rather than configured separately so the
    // two cannot contradict each other.
    get type() { return this.secret ? 'confidential' : 'public'; },
};

const TIMEOUT_MS = Math.max(3000, Number(process.env.IF_API_TIMEOUT_MS || 15000));

// An access token lasts 1800s. Refresh this far ahead of the stated expiry so a
// request never leaves with a token that dies in flight — 1800 is the documented
// figure today and the margin is deliberately generous relative to it.
const REFRESH_MARGIN_MS = 120 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Anything Infinite Flight refused, or anything that stopped us asking.
 *
 * Carries the HTTP status, the envelope's errorCode when there was one, and a
 * message already phrased for a person (ifLive.statusMessage). `retryable`
 * separates a queue from an answer so the sync can back off on one and stop on
 * the other.
 */
class IfApiError extends Error {
    constructor(message, { status = 0, errorCode = null, detail = '', retryable = false } = {}) {
        super(message);
        this.name = 'IfApiError';
        this.status = status;
        this.errorCode = errorCode;
        this.detail = detail;
        this.retryable = retryable;
    }
}

/**
 * An OAuth2 protocol failure — a refused exchange, a dead refresh token.
 *
 * Separate from IfApiError because the remedy is different and only one of them
 * is worth surfacing as "reconnect your account": a 403 from /live/aircraft is
 * about permissions, an invalid_grant from /connect/token is about the
 * connection itself.
 */
class IfAuthError extends Error {
    constructor(message, { status = 0, code = '', detail = '', reconnect = false } = {}) {
        super(message);
        this.name = 'IfAuthError';
        this.status = status;
        this.code = code;
        this.detail = detail;
        // True when the stored grant is gone for good and the VA has to go
        // through consent again. False for "the network was down".
        this.reconnect = reconnect;
    }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/**
 * A verifier and its S256 challenge.
 *
 * 32 random bytes base64url-encoded gives a 43-character verifier — the shortest
 * length RFC 7636 permits, and comfortably inside the 43..128 range. The
 * verifier is the secret half and never leaves our server until the exchange;
 * the challenge is the half that travels in the URL.
 */
function pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge, method: 'S256' };
}

/** Opaque anti-forgery value for the round trip. */
const randomState = () => crypto.randomBytes(24).toString('base64url');

/**
 * Compare two states without leaking where they diverged.
 *
 * A plain === on a secret compared byte by byte is a timing oracle. It is a
 * small one here — an attacker would need to steer a victim's callback and
 * measure our response — but constant-time comparison costs one function and
 * removes the question.
 */
function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    if (x.length !== y.length || !x.length) return false;
    return crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

/**
 * Where to send the VA's browser.
 *
 * `prompt=consent` is offered but off by default, exactly as the preview
 * advises: leaving it off lets a returning VA skip a repeat consent screen, and
 * turning it on is for the case where the final redirect has to follow a user
 * gesture (iOS Universal Links and friends). A crew center reconnecting in a
 * desktop browser wants it off; the setting exists because we cannot know that
 * for certain about every VA.
 */
function authorizeUrl({ clientId, redirectUri, scopes, state, challenge, prompt = '' }) {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: String(clientId || ''),
        redirect_uri: String(redirectUri || ''),
        scope: ifLive.scopeString(scopes),
        state: String(state || ''),
        code_challenge: String(challenge || ''),
        code_challenge_method: 'S256',
    });
    if (prompt) params.set('prompt', String(prompt));
    // URLSearchParams encodes a space as '+', which is legal in a query string
    // and which the preview's own examples do not use — they percent-encode the
    // scope separator. Space-delimited scopes are the one field here where the
    // difference could plausibly matter to a strict parser, and matching the
    // published example costs one replace. Nothing else in these parameters is
    // ever a literal space (base64url, an opaque client id, an encoded URI), so
    // this cannot corrupt another value.
    return `${AUTH_BASE}/connect/authorize?${params.toString().replace(/\+/g, '%20')}`;
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

/**
 * POST to /connect/token.
 *
 * Form-encoded, because that is the OAuth2 token endpoint standard and the
 * preview says so twice. The client secret is included only when there is one:
 * "Public clients do not receive a secret and rely on PKCE instead", and a
 * public client that sent an empty client_secret would be making a
 * confidential-client request with no credential — which servers reject, and
 * rightly.
 */
async function tokenRequest(form) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
        if (v === undefined || v === null || v === '') continue;
        body.set(k, String(v));
    }

    let resp;
    try {
        resp = await withTimeout((signal) => fetch(`${AUTH_BASE}/connect/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: body.toString(),
            signal,
        }));
    } catch (err) {
        // A network fault, not a refusal. Deliberately NOT reconnect:true — the
        // grant may be perfectly good and telling a VA to reconnect because our
        // DNS blipped would have them re-consenting for nothing.
        throw new IfAuthError('Could not reach Infinite Flight to sign in.', {
            detail: err && err.message ? err.message : String(err),
        });
    }

    let json = null;
    const raw = await resp.text().catch(() => '');
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }

    if (!resp.ok) {
        const code = String((json && (json.error || json.errorCode)) || '');
        const description = String((json && (json.error_description || json.errorDescription)) || '');
        // invalid_grant is the one that means the stored credential is finished:
        // the code was used already, or the refresh token has been revoked or
        // rotated past. Everything else may be transient or our own mistake.
        const reconnect = code === 'invalid_grant' || resp.status === 400 || resp.status === 401;
        throw new IfAuthError(
            reconnect
                ? 'Infinite Flight would not renew this connection. Connect the account again.'
                : 'Infinite Flight refused the sign-in.',
            { status: resp.status, code, detail: description || raw.slice(0, 300), reconnect }
        );
    }

    if (!json || !json.access_token) {
        throw new IfAuthError('Infinite Flight returned a sign-in without a token.', {
            status: resp.status, detail: raw.slice(0, 300),
        });
    }

    const expiresIn = Number(json.expires_in);
    return {
        accessToken: String(json.access_token),
        // Absent on a refresh when the server chooses not to rotate. The caller
        // keeps the one it has in that case — see the note in refresh().
        refreshToken: json.refresh_token ? String(json.refresh_token) : '',
        tokenType: String(json.token_type || 'Bearer'),
        expiresIn: Number.isFinite(expiresIn) ? expiresIn : 1800,
        expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000),
        // What was actually granted, which can be less than what was asked for.
        // Believed over our request everywhere downstream: a panel that offers
        // schedule editing because we ASKED for the write scope, on a grant that
        // did not include it, produces a 403 on the first save.
        scopes: json.scope ? ifLive.normalizeScopes(json.scope) : null,
    };
}

/** Authorization code → tokens. */
function exchangeCode({ clientId, clientSecret, code, redirectUri, verifier }) {
    return tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,     // dropped when empty — see tokenRequest
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
    });
}

/**
 * Refresh token → tokens.
 *
 * "Refresh tokens rotate. When you use a refresh token, store the newest
 * refresh token returned by the token endpoint and discard the old one." The
 * caller must persist what comes back BEFORE using the access token for
 * anything, because the token it sent is now spent: a crash between the two
 * loses the connection and the VA has to reconnect. server.js writes first.
 *
 * When the response carries no refresh_token the old one is still current and
 * the caller keeps it — returning '' here and having the caller blank the field
 * would throw away a working credential.
 */
function refresh({ clientId, clientSecret, refreshToken }) {
    return tokenRequest({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
    });
}

// ---------------------------------------------------------------------------
// The v3 transport
// ---------------------------------------------------------------------------

function withTimeout(run) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    return Promise.resolve(run(controller.signal)).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before a retry.
 *
 * Retry-After is honoured when Infinite Flight sends one, because a rate limiter
 * that has told us when to come back and is ignored is a rate limiter that will
 * start refusing for longer. Capped so a header of 3600 does not park a request
 * for an hour — past the cap we give up and let the caller decide.
 */
function retryDelay(resp, attempt) {
    const header = resp && resp.headers && resp.headers.get('retry-after');
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10000);
    return Math.min(500 * 2 ** attempt, 4000);
}

/**
 * One call to PublicApi v3, unwrapped.
 *
 * Returns the envelope's `result`. Throws IfApiError for everything else —
 * including a 200 whose errorCode is non-zero, which the envelope explicitly
 * allows ("errorCode: 0 means success. Non-zero error codes indicate a
 * validation, authorization, or lookup failure") and which a naive client would
 * read straight past.
 *
 * Retries only what is worth retrying: 429 and 5xx, twice, with the server's
 * own Retry-After where it gave one. A 403 is an answer and is never retried.
 *
 * `write` only changes the wording of a 403, which is the one status whose
 * cause differs between reading and writing — "you are not a member" against
 * "you are not an owner or admin".
 */
async function call(accessToken, method, path, { body, write = false, retries = 2 } = {}) {
    if (!accessToken) {
        throw new IfApiError('Not connected to Infinite Flight.', { status: 401 });
    }
    const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;

    for (let attempt = 0; ; attempt++) {
        let resp;
        try {
            resp = await withTimeout((signal) => fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal,
            }));
        } catch (err) {
            const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
            if (attempt < retries) { await sleep(retryDelay(null, attempt)); continue; }
            throw new IfApiError(
                aborted ? 'Infinite Flight did not answer in time.' : 'Could not reach Infinite Flight.',
                { status: 0, retryable: true, detail: err && err.message ? err.message : String(err) }
            );
        }

        if (!resp.ok) {
            if (ifLive.isRetryable(resp.status) && attempt < retries) {
                await sleep(retryDelay(resp, attempt));
                continue;
            }
            const raw = await resp.text().catch(() => '');
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON — keep the text */ }
            throw new IfApiError(ifLive.statusMessage(resp.status, { write }), {
                status: resp.status,
                errorCode: parsed && parsed.errorCode !== undefined ? parsed.errorCode : null,
                retryable: ifLive.isRetryable(resp.status),
                detail: raw.slice(0, 500),
            });
        }

        const raw = await resp.text().catch(() => '');
        // A 204, or an endpoint that answers with nothing. The documented
        // booleans (reorder, delete) come back inside the envelope, so an empty
        // body here means "it worked and said nothing" rather than "false".
        if (!raw.trim()) return true;

        let envelope;
        try { envelope = JSON.parse(raw); } catch {
            throw new IfApiError('Infinite Flight sent something we could not read.', {
                status: resp.status, detail: raw.slice(0, 300),
            });
        }

        const errorCode = envelope && envelope.errorCode;
        if (errorCode !== undefined && errorCode !== null && Number(errorCode) !== 0) {
            throw new IfApiError(`Infinite Flight refused that (error ${errorCode}).`, {
                status: resp.status, errorCode: Number(errorCode), detail: raw.slice(0, 300),
            });
        }
        // `result` is the envelope's payload; an endpoint returning a bare
        // boolean still wraps it, so `=== undefined` and not `|| null`.
        return envelope && Object.prototype.hasOwnProperty.call(envelope, 'result')
            ? envelope.result
            : envelope;
    }
}

// ---------------------------------------------------------------------------
// The Live endpoints
//
// One function each, in the order the preview lists them. They exist so that no
// route in server.js contains a v3 URL — when a path moves, it moves here.
// Each returns already-shaped objects (ifLive.public*), because every caller
// wants that and the raw envelope is of interest to nobody above this line.
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;
const asArray = (v) => (Array.isArray(v) ? v : []);

/** GET /live/organizations — the organizations this account belongs to. */
async function listOrganizations(token) {
    const result = await call(token, 'GET', '/live/organizations');
    return asArray(result).map(ifLive.publicOrganization).filter(Boolean);
}

/** GET /live/organizations/{organizationId} */
async function getOrganization(token, organizationId) {
    return ifLive.publicOrganization(await call(token, 'GET', `/live/organizations/${enc(organizationId)}`));
}

/**
 * GET /live/organizations/{organizationId}/aircraft
 *
 * Sorted by fleet rank on the way out. The API documents fleetRank as the
 * one-based position in the organization's fleet order, and a fleet board that
 * shows aircraft in whatever order they arrived is a board a VA has to re-sort
 * in their head every time they open it.
 */
async function listAircraft(token, organizationId) {
    const result = await call(token, 'GET', `/live/organizations/${enc(organizationId)}/aircraft`);
    return asArray(result)
        .map(ifLive.publicAircraft)
        .filter(Boolean)
        .sort((a, b) => (a.fleetRank ?? 1e9) - (b.fleetRank ?? 1e9)
            || String(a.registration).localeCompare(String(b.registration)));
}

/** GET /live/aircraft/{aircraftId} — the PERSISTENT id, not the content id. */
async function getAircraft(token, aircraftId) {
    return ifLive.publicAircraft(await call(token, 'GET', `/live/aircraft/${enc(aircraftId)}`));
}

/** GET /live/aircraft/{aircraftId}/position — last persisted state, possibly stale. */
async function getPosition(token, aircraftId) {
    return ifLive.publicPosition(await call(token, 'GET', `/live/aircraft/${enc(aircraftId)}/position`));
}

/**
 * GET /live/aircraft/{aircraftId}/schedules — "ordered by sequence".
 *
 * Re-sorted here anyway. The list is the aircraft's running order and the whole
 * reorder feature depends on it being right; trusting the wire order and being
 * wrong once would show a VA a rota that does not match what their aircraft
 * will actually fly.
 */
async function listSchedules(token, aircraftId) {
    const result = await call(token, 'GET', `/live/aircraft/${enc(aircraftId)}/schedules`);
    return asArray(result)
        .map(ifLive.publicSchedule)
        .filter(Boolean)
        .sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9));
}

/** POST /live/aircraft/{aircraftId}/schedules — appended to the end of the list. */
async function createSchedule(token, aircraftId, request) {
    const result = await call(token, 'POST', `/live/aircraft/${enc(aircraftId)}/schedules`, {
        body: request, write: true,
        // Never retried. A create is the one call where a retry after an
        // ambiguous failure can leave the aircraft with the same leg twice.
        retries: 0,
    });
    return ifLive.publicSchedule(result);
}

/** PUT /live/schedules/{scheduleId} — same body as create. */
async function updateSchedule(token, scheduleId, request) {
    const result = await call(token, 'PUT', `/live/schedules/${enc(scheduleId)}`, { body: request, write: true });
    return ifLive.publicSchedule(result);
}

/** PUT /live/schedules/{scheduleId}/flightplan — null or '' clears it. */
async function updateFlightPlan(token, scheduleId, flightPlan) {
    const result = await call(token, 'PUT', `/live/schedules/${enc(scheduleId)}/flightplan`, {
        body: { flightPlan: flightPlan === '' ? null : flightPlan }, write: true,
    });
    return ifLive.publicSchedule(result);
}

/** PUT /live/aircraft/{aircraftId}/schedules/reorder — afterId null moves to the top. */
async function reorderSchedule(token, aircraftId, { scheduleId, afterId }) {
    const result = await call(token, 'PUT', `/live/aircraft/${enc(aircraftId)}/schedules/reorder`, {
        body: { scheduleId, afterId: afterId || null }, write: true,
    });
    return result !== false;
}

/** DELETE /live/schedules/{scheduleId} */
async function deleteSchedule(token, scheduleId) {
    const result = await call(token, 'DELETE', `/live/schedules/${enc(scheduleId)}`, { write: true, retries: 0 });
    return result !== false;
}

/**
 * Apply a whole arrangement, one move at a time.
 *
 * ifLive.reorderPlan turns the order a person dragged into the sequence of
 * moves the API takes; this walks it. Serially and in order, because each move
 * is stated relative to the one before it and issuing them together would race.
 *
 * Best-effort per move, like the quick-links reorder: a schedule somebody else
 * deleted while the drag was happening must not abandon the rest of the
 * arrangement half-applied. What comes back says how far it got.
 */
async function applyOrder(token, aircraftId, ids, schedules) {
    const plan = ifLive.reorderPlan(ids, schedules);
    let moved = 0;
    const failures = [];
    for (const move of plan) {
        try {
            if (await reorderSchedule(token, aircraftId, move)) moved += 1;
        } catch (err) {
            failures.push({ scheduleId: move.scheduleId, error: err.message });
            // A rate limit will hit every remaining move too, so stop rather
            // than spending the rest of the budget being refused.
            if (err instanceof IfApiError && err.status === 429) break;
        }
    }
    return { planned: plan.length, moved, failures };
}

/**
 * Everything about one aircraft in a single answer: the aircraft, where it last
 * was, and what it is due to fly.
 *
 * In parallel and independently failing. A VA whose grant covers aircraft but
 * not schedules should still see the aeroplane rather than an error, and a
 * position endpoint having a bad minute should not blank the rota — so each
 * part carries its own error instead of the whole call having one.
 */
async function aircraftDetail(token, aircraftId, { position = true, schedules = true } = {}) {
    const [ac, pos, sched] = await Promise.all([
        getAircraft(token, aircraftId).then((v) => ({ v }), (e) => ({ e })),
        position ? getPosition(token, aircraftId).then((v) => ({ v }), (e) => ({ e })) : Promise.resolve({ v: null }),
        schedules ? listSchedules(token, aircraftId).then((v) => ({ v }), (e) => ({ e })) : Promise.resolve({ v: [] }),
    ]);
    // The aircraft itself is the one part worth failing over: without it there
    // is nothing to show a position or a rota against.
    if (ac.e) throw ac.e;
    return {
        aircraft: ac.v,
        position: pos.v || null,
        positionError: pos.e ? pos.e.message : '',
        schedules: sched.v || [],
        schedulesError: sched.e ? sched.e.message : '',
    };
}

module.exports = {
    // configuration, read by server.js so there is one source for each value
    AUTH_BASE, API_BASE, ISSUER, REDIRECT_URI, PLATFORM_CLIENT, REFRESH_MARGIN_MS,
    // errors
    IfApiError, IfAuthError,
    // the handshake
    pkce, randomState, safeEqual, authorizeUrl, exchangeCode, refresh,
    // transport
    call,
    // endpoints
    listOrganizations, getOrganization,
    listAircraft, getAircraft, getPosition, aircraftDetail,
    listSchedules, createSchedule, updateSchedule, updateFlightPlan,
    reorderSchedule, applyOrder, deleteSchedule,
};

'use strict';

/*
 * ifLive.js
 * Infinite Flight PublicApi v3 — the OAuth2 handshake, and the Live organization
 * endpoints behind it.
 *
 * WHAT THIS IS
 * ------------
 * Everything the crew center's Live Ops board needs to talk to Infinite Flight
 * *as a signed-in Infinite Flight user*, rather than as our platform API key.
 * The v2 API key we already hold (see ACARS_BACKEND_URL in server.js) answers
 * public questions — who is flying, what did this pilot log. It cannot answer
 * "what aircraft does this VA own" or "put this leg on that airframe", because
 * those are somebody's organization and the API will only discuss them with a
 * member of it. That is what v3 OAuth is for, and it is the whole reason this
 * module exists alongside the v2 path rather than replacing it.
 *
 *   THE PREVIEW WARNING IS REAL. Infinite Flight ships this as "under
 *   development": paths, scopes, response fields, enum values, validation rules
 *   and rate limits may all change before it is generally available. Two
 *   consequences are designed in here rather than left to be discovered:
 *
 *     1. Every enum is decoded through a TABLE (below) that maps the numeric
 *        wire value to a name and a human label, and an unrecognised number
 *        decodes to `{ value: n, name: '', label: 'Unknown (n)' }` instead of
 *        throwing or rendering blank. A new ScheduledFlightStatus added upstream
 *        shows up as an honest "Unknown (12)" on the board rather than breaking
 *        the page or, worse, silently reading as status 0.
 *     2. Unknown response fields are PASSED THROUGH on the raw side of the
 *        serialisers. We name what we understand and keep what we don't, so a
 *        renamed field is a display gap and not a data loss.
 *
 * WHAT IS *NOT* HERE
 * ------------------
 * Storage. Which VA is connected, whose tokens they are and when they expire is
 * server.js's business, because that is where the VA document lives and where
 * crewSecrets can seal a refresh token. This module is handed credentials and
 * hands back data; it never reads or writes a database.
 *
 * CLIENT TYPE
 * -----------
 * We are a CONFIDENTIAL client. The exchange happens on this server, the secret
 * never leaves it, and no browser ever sees a token — the crew center calls our
 * /api/crew/:slug/if/* routes and we call Infinite Flight. PKCE is used anyway,
 * because Infinite Flight requires it of both client types and because it costs
 * one hash to close the code-interception hole regardless of who holds a secret.
 *
 * If IF_OAUTH_CLIENT_SECRET is left unset the module runs as a PUBLIC client
 * (PKCE only, no secret on the token request). That is supported because the
 * API supports it, not because it is a good idea here: a server that can keep a
 * secret should.
 *
 * ENV
 * ---
 *   IF_OAUTH_CLIENT_ID       required. The `ifc_…` client id from
 *                            https://infiniteflight.com/account/api-keys
 *   IF_OAUTH_CLIENT_SECRET   confidential clients only. Shown once at creation.
 *   IF_OAUTH_REDIRECT_URI    required, and must match the client's registered
 *                            redirect exactly — Infinite Flight compares the
 *                            string, not the route. Points at this backend's
 *                            /api/crew/if/callback.
 *   IF_OAUTH_AUTH_BASE       default https://api.infiniteflight.com/auth/v2
 *   IF_PUBLIC_V3_BASE        default https://api.infiniteflight.com/public/v3
 *   IF_OAUTH_TIMEOUT_MS      default 10000
 */

const crypto = require('crypto');
const axios = require('axios');

const AUTH_BASE = (process.env.IF_OAUTH_AUTH_BASE || 'https://api.infiniteflight.com/auth/v2').replace(/\/+$/, '');
const V3_BASE = (process.env.IF_PUBLIC_V3_BASE || 'https://api.infiniteflight.com/public/v3').replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.IF_OAUTH_TIMEOUT_MS, 10) || 10000;

const CLIENT_ID = String(process.env.IF_OAUTH_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.IF_OAUTH_CLIENT_SECRET || '').trim();
const REDIRECT_URI = String(process.env.IF_OAUTH_REDIRECT_URI || '').trim();

/* ---------------------------------------------------------------------------
 * SCOPES
 *
 * Requested as a set, not one at a time: Infinite Flight shows the user a single
 * consent screen listing what we asked for, and a VA that connects once and then
 * discovers the schedule board is read-only has had a worse experience than one
 * that saw "manage schedules" on the consent screen and agreed to it.
 *
 * `offline_access` is the load-bearing one. Access tokens last thirty minutes.
 * Without a refresh token a VA would reconnect their Infinite Flight account
 * twice an hour, which is not a feature anybody would use.
 * ------------------------------------------------------------------------- */
const SCOPES = [
    { id: 'openid', label: 'Sign in with Infinite Flight', required: true },
    { id: 'profile', label: 'Read your basic Infinite Flight profile', required: true },
    { id: 'offline_access', label: 'Stay connected without signing in again', required: true },
    { id: 'live:organizations.read', label: 'Read the Live organizations you belong to', required: true },
    { id: 'live:aircraft.read', label: 'Read the aircraft in those organizations', required: true },
    { id: 'live:schedules.read', label: 'Read the schedules on those aircraft', required: true },
    { id: 'live:schedules.write', label: 'Create, edit, reorder and delete schedules', required: false },
];
const SCOPE_IDS = SCOPES.map((s) => s.id);
const READ_SCOPES = SCOPE_IDS.filter((id) => id !== 'live:schedules.write');

/* ---------------------------------------------------------------------------
 * ENUMS
 *
 * Straight from the v3 preview documentation. Every one of these arrives on the
 * wire as a bare integer, which is unreadable in a UI and dangerous in a
 * comparison — `status === 1` means "Suspended" on an organization and "Deleted"
 * on an aircraft. Decoding them here, once, is what stops that confusion
 * spreading into the routes and then into the browser.
 *
 * Note the hole at 5 in ScheduledFlightStatus. It is not a transcription slip —
 * the published table skips it, and leaving the gap rather than renumbering
 * means a 5 that turns up later decodes as "Unknown (5)" instead of quietly
 * borrowing the meaning of another state.
 * ------------------------------------------------------------------------- */
const ORGANIZATION_TYPE = {
    0: ['AutoJoin', 'Anyone can join'],
    1: ['ManualJoin', 'Join by request'],
    2: ['ApplyToJoin', 'Apply to join'],
    3: ['InviteOnly', 'Invite only'],
    4: ['SingleMember', 'Single member'],
};
const OPERATION_TYPE = {
    0: ['Undefined', 'Unspecified'],
    1: ['Airline', 'Airline'],
    2: ['Charter', 'Charter'],
    3: ['Freight', 'Freight'],
    4: ['Military', 'Military'],
    5: ['FlightSchool', 'Flight school'],
    6: ['Private', 'Private'],
};
const WORLD_TYPE = {
    0: ['Solo', 'Solo'],
    1: ['Casual', 'Casual'],
    2: ['Training', 'Training'],
    3: ['Expert', 'Expert'],
    4: ['Private', 'Private'],
};
const ORGANIZATION_STATUS = {
    0: ['Active', 'Active'],
    1: ['Suspended', 'Suspended'],
    2: ['Deleted', 'Deleted'],
};
const AIRCRAFT_STATUS = {
    0: ['Active', 'Active'],
    1: ['Deleted', 'Deleted'],
};
const AIRCRAFT_VISIBILITY = {
    0: ['Unknown', 'Unknown'],
    1: ['Visible', 'Visible'],
    2: ['Hangared', 'Hangared'],
};
const PERSISTENCE_STATE = {
    0: ['Unknown', 'Unknown'],
    1: ['OnGround', 'On the ground'],
    2: ['InFlight', 'In flight'],
    3: ['Cancelled', 'Cancelled'],
    4: ['Stopped', 'Stopped'],
    5: ['Maintenance', 'Maintenance'],
};
const SCHEDULE_STATUS = {
    0: ['Unknown', 'Unknown'],
    1: ['Scheduled', 'Scheduled'],
    2: ['Boarding', 'Boarding'],
    3: ['Boarded', 'Boarded'],
    4: ['TaxiingToRunway', 'Taxiing to runway'],
    6: ['InFlight', 'In flight'],
    7: ['Diverted', 'Diverted'],
    8: ['Delayed', 'Delayed'],
    9: ['Cancelled', 'Cancelled'],
    10: ['TaxiingToParking', 'Taxiing to parking'],
    11: ['Arrived', 'Arrived'],
};
const FLIGHT_TYPE = {
    0: ['None', 'Unspecified'],
    1: ['Commercial', 'Commercial'],
    2: ['Charter', 'Charter'],
    3: ['Cargo', 'Cargo'],
    4: ['Training', 'Training'],
    5: ['TestFlight', 'Test flight'],
    6: ['MedicalEmergency', 'Medical emergency'],
    7: ['Military', 'Military'],
    8: ['VIPExecutive', 'VIP / executive'],
    9: ['HumanitarianRelief', 'Humanitarian relief'],
    10: ['GeneralAviation', 'General aviation'],
    11: ['Airshow', 'Airshow'],
    12: ['Other', 'Other'],
};

/**
 * One numeric enum, decoded.
 *
 * Always returns an object, never null: a value the table does not know is a
 * preview API adding a state, and the board says "Unknown (13)" rather than
 * rendering an empty cell that reads as "no status".
 */
function decodeEnum(table, value) {
    if (value == null || value === '') return { value: null, name: '', label: '' };
    const n = Number(value);
    if (!Number.isFinite(n)) return { value: null, name: '', label: '' };
    const row = table[n];
    return row
        ? { value: n, name: row[0], label: row[1] }
        : { value: n, name: '', label: `Unknown (${n})` };
}

/** The catalogue a picker is built from — [{ value, name, label }, …]. */
const enumOptions = (table) => Object.keys(table)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((v) => ({ value: v, name: table[v][0], label: table[v][1] }));

/* ---------------------------------------------------------------------------
 * ERRORS
 *
 * One error type for everything upstream, carrying the status we should reply
 * with and a sentence a VA manager can act on. The status table is the one
 * published with the preview; the messages are ours, because "403" on its own
 * has four different causes here and only one of them is the VA's to fix.
 * ------------------------------------------------------------------------- */
class IfLiveError extends Error {
    constructor(message, { status = 502, code = 'if_live_error', detail = '', retryAfter = 0 } = {}) {
        super(message);
        this.name = 'IfLiveError';
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.retryAfter = retryAfter;
    }
}

/**
 * What an upstream HTTP status means to the person looking at the board.
 *
 * 403 is the interesting one and is deliberately not flattened to "not allowed":
 * the four causes the documentation lists (missing scope, disabled client, app
 * still in testing, user has no access) land on the same code, and a VA whose
 * owner has not been invited as a test user needs to be told *that* rather than
 * left to wonder whether they mistyped a slug.
 */
function upstreamMessage(status, body) {
    const upstream = String((body && (body.error_description || body.error || body.message)) || '').slice(0, 300);
    switch (status) {
        case 400:
            return { code: 'if_bad_request', status: 400, message: upstream || 'Infinite Flight rejected that request.' };
        case 401:
            return {
                code: 'if_unauthorized', status: 401,
                message: 'Infinite Flight no longer accepts this connection. Reconnect the account in Settings → Live ops.',
            };
        case 403:
            return {
                code: 'if_forbidden', status: 403,
                message: 'Infinite Flight refused this. The connected account may not have the right role in that organization, '
                    + 'the app may still be limited to invited testers, or the connection may be missing a permission — '
                    + 'reconnecting re-asks for all of them.',
            };
        case 404:
            return { code: 'if_not_found', status: 404, message: 'Infinite Flight has no such organization, aircraft or schedule for this account.' };
        case 429:
            return { code: 'if_rate_limited', status: 429, message: 'Infinite Flight is rate-limiting us. Try again shortly.' };
        default:
            if (status >= 500) return { code: 'if_upstream', status: 502, message: 'Infinite Flight didn’t answer. Try again in a moment.' };
            return { code: 'if_live_error', status: 502, message: upstream || 'Infinite Flight returned something unexpected.' };
    }
}

/* ---------------------------------------------------------------------------
 * CONFIGURATION
 * ------------------------------------------------------------------------- */

/** Has this deployment been given an OAuth client at all? */
const configured = () => !!(CLIENT_ID && REDIRECT_URI);

/**
 * Why not, in words the person reading a settings screen can act on. Empty when
 * everything needed is present.
 */
function unavailableReason() {
    if (!CLIENT_ID) return 'This deployment has no Infinite Flight OAuth client. Set IF_OAUTH_CLIENT_ID.';
    if (!REDIRECT_URI) return 'This deployment has no Infinite Flight redirect URI. Set IF_OAUTH_REDIRECT_URI to this backend’s /api/crew/if/callback.';
    return '';
}

/** 'confidential' when we hold a secret, 'public' when we are PKCE-only. */
const clientType = () => (CLIENT_SECRET ? 'confidential' : 'public');

const config = () => ({
    configured: configured(),
    unavailableReason: unavailableReason(),
    clientType: clientType(),
    redirectUri: REDIRECT_URI,
    authBase: AUTH_BASE,
    apiBase: V3_BASE,
    scopes: SCOPES,
});

/* ---------------------------------------------------------------------------
 * PKCE + THE AUTHORIZATION REQUEST
 * ------------------------------------------------------------------------- */

/** base64url with no padding — what RFC 7636 wants and what the server checks. */
const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh code verifier. 32 random bytes → 43 characters, inside the 43–128 range. */
const createVerifier = () => b64url(crypto.randomBytes(32));

/** The S256 challenge for a verifier. */
const challengeFor = (verifier) => b64url(crypto.createHash('sha256').update(String(verifier), 'ascii').digest());

/** An unguessable value for the `state` nonce. */
const createNonce = () => b64url(crypto.randomBytes(24));

/**
 * Where to send the user to approve the connection.
 *
 * `prompt` is passed through rather than hardcoded. The documentation's advice
 * is to leave it off so a returning user skips a repeat consent screen; we take
 * that advice by default and expose the override because reconnecting after a
 * scope change is exactly the case where forcing the screen is right — the user
 * needs to SEE that schedule-writing is now being asked for.
 */
function authorizeUrl({ state, codeChallenge, scopes, prompt = '' } = {}) {
    if (!configured()) throw new IfLiveError(unavailableReason(), { status: 503, code: 'if_not_configured' });
    if (!state) throw new IfLiveError('Missing state.', { status: 500, code: 'if_bad_state' });
    if (!codeChallenge) throw new IfLiveError('Missing PKCE challenge.', { status: 500, code: 'if_bad_pkce' });

    const wanted = Array.isArray(scopes) && scopes.length
        ? scopes.filter((s) => SCOPE_IDS.includes(s))
        : SCOPE_IDS;

    const qs = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: wanted.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });
    if (prompt) qs.set('prompt', String(prompt));
    return `${AUTH_BASE}/connect/authorize?${qs.toString()}`;
}

/* ---------------------------------------------------------------------------
 * THE TOKEN ENDPOINT
 * ------------------------------------------------------------------------- */

/**
 * A token response, normalised.
 *
 * `expiresAt` rather than `expiresIn`: a duration is only meaningful next to the
 * instant it was measured from, and storing the duration means every later
 * reader has to remember to also store — and trust — a timestamp beside it. The
 * sixty-second haircut is deliberate slack for the round trip and for clock
 * drift between us and the authorization server.
 *
 * The refresh token is returned as `refreshToken: ''` when the response carried
 * none. Callers must treat that as "keep the one you had", NOT as "we were given
 * nothing" — a refresh response that rotates only the access token is legal, and
 * discarding the stored refresh token on one would disconnect the VA.
 */
// What to assume when the token response carries no expires_in. Short, because
// the cost of assuming too long is a call that 401s in front of a user, while
// the cost of assuming too short is one extra refresh — but not so short that a
// server which simply omits the field turns every request into a refresh and
// rotates the VA's refresh token dozens of times a minute.
const ASSUMED_TTL_SECONDS = 300;

function normalizeTokens(data) {
    const d = data || {};
    const declared = Math.max(0, Math.round(Number(d.expires_in) || 0));
    const seconds = declared || ASSUMED_TTL_SECONDS;
    return {
        accessToken: String(d.access_token || ''),
        refreshToken: String(d.refresh_token || ''),
        tokenType: String(d.token_type || 'Bearer'),
        scope: String(d.scope || ''),
        expiresIn: declared,
        expiresAt: new Date(Date.now() + Math.max(30, seconds - 60) * 1000),
    };
}

/** POST to /connect/token with the client credentials this client type uses. */
async function tokenRequest(params) {
    if (!configured()) throw new IfLiveError(unavailableReason(), { status: 503, code: 'if_not_configured' });

    const body = new URLSearchParams({ client_id: CLIENT_ID, ...params });
    // A public client must not send a secret and the server rejects one that
    // does; a confidential client must. clientType() is the single switch.
    if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);

    let resp;
    try {
        resp = await axios.post(`${AUTH_BASE}/connect/token`, body.toString(), {
            timeout: TIMEOUT_MS,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            validateStatus: () => true,
        });
    } catch (err) {
        throw new IfLiveError('Could not reach Infinite Flight to complete the connection.', {
            status: 502, code: 'if_unreachable', detail: err?.message || String(err),
        });
    }

    if (resp.status >= 400) {
        const d = resp.data || {};
        const oauthError = String(d.error || '');
        // invalid_grant is the one worth naming: it is what an expired code, a
        // reused code and a revoked refresh token all come back as, and the fix
        // for every one of them is the same — connect again.
        const message = oauthError === 'invalid_grant'
            ? 'That Infinite Flight authorization has expired or already been used. Start the connection again.'
            : (String(d.error_description || '').slice(0, 300) || upstreamMessage(resp.status, d).message);
        throw new IfLiveError(message, {
            status: resp.status === 429 ? 429 : 400,
            code: oauthError ? `if_oauth_${oauthError}`.slice(0, 60) : 'if_oauth_error',
            detail: `${resp.status} ${JSON.stringify(d).slice(0, 300)}`,
        });
    }

    const tokens = normalizeTokens(resp.data);
    if (!tokens.accessToken) {
        throw new IfLiveError('Infinite Flight returned no access token.', { status: 502, code: 'if_no_token' });
    }
    return tokens;
}

/** Authorization code → tokens. `codeVerifier` is the PKCE half we kept. */
const exchangeCode = ({ code, codeVerifier }) => tokenRequest({
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: REDIRECT_URI,
    code_verifier: String(codeVerifier || ''),
});

/**
 * Refresh token → tokens.
 *
 * REFRESH TOKENS ROTATE. Whatever comes back must replace what was stored, and
 * the old one must be thrown away — see normalizeTokens on the one case where
 * "came back empty" means "keep yours".
 */
const refreshTokens = ({ refreshToken }) => tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken || ''),
});

/**
 * Who connected, in a word.
 *
 * BEST EFFORT, AND DELIBERATELY SO. The preview documents `openid` and `profile`
 * as scopes and names an OpenID issuer, which implies the standard userinfo
 * endpoint under the same /connect/* prefix the token endpoint uses — but it
 * does not document one, and it warns that access tokens are issued for the
 * `public-api-v3` audience, which a userinfo endpoint may well decline.
 *
 * So this asks, and shrugs. It returns '' for every failure and NEVER throws,
 * because the only thing hanging on it is a line of text on a settings screen:
 * "connected as <name>" is nicer than "connected", and not nice enough to risk
 * failing a connection that otherwise worked. If Infinite Flight later
 * documents something better, this is the one function to change.
 */
async function fetchUsername(accessToken) {
    if (!accessToken) return '';
    try {
        const resp = await axios.get(`${AUTH_BASE}/connect/userinfo`, {
            timeout: TIMEOUT_MS,
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            validateStatus: () => true,
        });
        if (resp.status >= 400) return '';
        const d = resp.data || {};
        return String(d.preferred_username || d.name || d.nickname || d.sub || '').slice(0, 60);
    } catch { return ''; }
}

/* ---------------------------------------------------------------------------
 * THE API CLIENT
 * ------------------------------------------------------------------------- */

/**
 * One call to PublicApi v3, envelope unwrapped.
 *
 * The envelope is `{ errorCode, result }`, and errorCode is checked as well as
 * the HTTP status: the preview can answer 200 with a non-zero errorCode, and a
 * caller that only looked at the status would render `undefined` as data.
 */
async function call(accessToken, method, path, body) {
    if (!accessToken) throw new IfLiveError('Not connected to Infinite Flight.', { status: 409, code: 'if_not_connected' });

    let resp;
    try {
        resp = await axios({
            method,
            url: `${V3_BASE}${path}`,
            data: body === undefined ? undefined : body,
            timeout: TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            validateStatus: () => true,
        });
    } catch (err) {
        throw new IfLiveError('Infinite Flight didn’t answer. Try again in a moment.', {
            status: 502, code: 'if_unreachable', detail: `${method} ${path}: ${err?.message || err}`,
        });
    }

    if (resp.status >= 400) {
        const mapped = upstreamMessage(resp.status, resp.data);
        const retryAfter = Math.max(0, Math.round(Number(resp.headers && resp.headers['retry-after']) || 0));
        throw new IfLiveError(mapped.message, {
            status: mapped.status, code: mapped.code, retryAfter,
            detail: `${method} ${path} → ${resp.status} ${JSON.stringify(resp.data || '').slice(0, 300)}`,
        });
    }

    const env = resp.data || {};
    const errorCode = Number(env.errorCode || 0);
    if (errorCode !== 0) {
        throw new IfLiveError('Infinite Flight refused that request.', {
            status: 400, code: `if_envelope_${errorCode}`,
            detail: `${method} ${path} → errorCode ${errorCode}`,
        });
    }
    // `result` is absent on some write endpoints that answer with a bare true;
    // returning the envelope's own body in that case keeps the caller honest
    // about what actually came back.
    return Object.prototype.hasOwnProperty.call(env, 'result') ? env.result : env;
}

/* ---------------------------------------------------------------------------
 * SERIALISERS
 *
 * Each of these names the fields the preview documents, decodes the enums, and
 * keeps everything else under `extra`. That last part is the preview clause: a
 * field renamed upstream stops appearing under its old name and starts appearing
 * in `extra`, which is a thing a developer can see in a response rather than a
 * thing that vanishes.
 * ------------------------------------------------------------------------- */

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Everything on `raw` that `known` did not claim. */
function extraFields(raw, known) {
    const out = {};
    for (const k of Object.keys(raw || {})) {
        if (!known.includes(k)) out[k] = raw[k];
    }
    return Object.keys(out).length ? out : undefined;
}

const ORG_KNOWN = ['id', 'name', 'type', 'operationType', 'worldType', 'status', 'description'];
function publicOrganization(o) {
    if (!o) return null;
    return {
        id: str(o.id, 64),
        name: str(o.name, 200),
        description: str(o.description, 4000),
        type: decodeEnum(ORGANIZATION_TYPE, o.type),
        operationType: decodeEnum(OPERATION_TYPE, o.operationType),
        worldType: decodeEnum(WORLD_TYPE, o.worldType),
        status: decodeEnum(ORGANIZATION_STATUS, o.status),
        extra: extraFields(o, ORG_KNOWN),
    };
}

const AIRCRAFT_KNOWN = ['id', 'aircraftId', 'organizationId', 'registration', 'status',
    'visibility', 'fleetPriority', 'fleetRank', 'isFleetActiveSlot', 'createdAt'];
/**
 * One aircraft.
 *
 * `id` and `aircraftId` are BOTH kept and are deliberately not merged, because
 * they are different things that the API names confusingly: `id` is the
 * organization's airframe — the value every other endpoint here calls
 * `{aircraftId}` — while `aircraftId` is Infinite Flight's aircraft/livery
 * content identifier, the same kind of value our v2 metadata lookup resolves to
 * a model name. Sending the wrong one at a schedule endpoint gets a 404 that
 * reads as "you don't own this aeroplane", so the field that endpoints take is
 * additionally surfaced as `airframeId`.
 */
function publicAircraft(a) {
    if (!a) return null;
    return {
        id: str(a.id, 64),
        airframeId: str(a.id, 64),
        contentAircraftId: str(a.aircraftId, 64),
        organizationId: str(a.organizationId, 64),
        registration: str(a.registration, 32),
        status: decodeEnum(AIRCRAFT_STATUS, a.status),
        visibility: decodeEnum(AIRCRAFT_VISIBILITY, a.visibility),
        fleetPriority: num(a.fleetPriority),
        fleetRank: num(a.fleetRank),
        // Visibility and storage are separate states upstream and are kept
        // separate here: an aircraft can be Visible and still sit outside the
        // organization's active fleet slots, which is what the Live portal draws
        // as storage. Collapsing the two would mislabel exactly those airframes.
        isFleetActiveSlot: a.isFleetActiveSlot === true,
        inStorage: a.isFleetActiveSlot === false,
        createdAt: iso(a.createdAt),
        extra: extraFields(a, AIRCRAFT_KNOWN),
    };
}

const POSITION_KNOWN = ['id', 'state', 'isOnGround', 'latitude', 'longitude', 'altitude',
    'heading', 'speed', 'verticalSpeed', 'lastPilotId', 'lastPilotUsername', 'updatedAt'];
/**
 * The last position Infinite Flight persisted for an airframe.
 *
 * `stale` is computed rather than reported, because the documentation is explicit
 * that this is a STORED state and can be old when the aircraft is not reporting.
 * A board that draws a three-day-old position as "in flight" is worse than one
 * that draws nothing, so the age is published alongside the coordinates and the
 * panel greys the row out past the threshold.
 */
const POSITION_STALE_MS = 15 * 60 * 1000;
function publicPosition(p) {
    if (!p) return null;
    const updatedAt = iso(p.updatedAt);
    const ageMs = updatedAt ? Math.max(0, Date.now() - new Date(updatedAt).getTime()) : null;
    return {
        id: str(p.id, 64),
        state: decodeEnum(PERSISTENCE_STATE, p.state),
        isOnGround: p.isOnGround === true,
        latitude: num(p.latitude),
        longitude: num(p.longitude),
        altitude: num(p.altitude),
        heading: num(p.heading),
        speed: num(p.speed),
        verticalSpeed: num(p.verticalSpeed),
        lastPilotId: str(p.lastPilotId, 64),
        lastPilotUsername: str(p.lastPilotUsername, 60),
        updatedAt,
        ageMs,
        stale: ageMs == null ? true : ageMs > POSITION_STALE_MS,
        extra: extraFields(p, POSITION_KNOWN),
    };
}

const SCHEDULE_KNOWN = ['id', 'status', 'callsign', 'organizationId', 'aircraftId', 'flightType',
    'originIcao', 'destinationIcao', 'scheduledDepartureUtc', 'scheduledArrivalUtc',
    'actualDepartureUtc', 'actualArrivalUtc', 'briefing', 'debriefing', 'flightPlan',
    'sequence', 'createdAt', 'updatedAt'];
function publicSchedule(s) {
    if (!s) return null;
    const dep = iso(s.scheduledDepartureUtc);
    const arr = iso(s.scheduledArrivalUtc);
    return {
        id: str(s.id, 64),
        status: decodeEnum(SCHEDULE_STATUS, s.status),
        callsign: str(s.callsign, 32),
        organizationId: str(s.organizationId, 64),
        aircraftId: str(s.aircraftId, 64),
        flightType: decodeEnum(FLIGHT_TYPE, s.flightType),
        originIcao: str(s.originIcao, 8).toUpperCase(),
        destinationIcao: str(s.destinationIcao, 8).toUpperCase(),
        scheduledDepartureUtc: dep,
        scheduledArrivalUtc: arr,
        actualDepartureUtc: iso(s.actualDepartureUtc),
        actualArrivalUtc: iso(s.actualArrivalUtc),
        // Block time, worked out once here so the three places that draw a
        // schedule row do not each do the arithmetic — and so a row whose times
        // are missing shows nothing rather than "0h 00".
        blockMinutes: (dep && arr) ? Math.max(0, Math.round((new Date(arr) - new Date(dep)) / 60000)) : null,
        briefing: str(s.briefing, 4000),
        debriefing: str(s.debriefing, 4000),
        flightPlan: str(s.flightPlan, 16000),
        sequence: num(s.sequence),
        createdAt: iso(s.createdAt),
        updatedAt: iso(s.updatedAt),
        extra: extraFields(s, SCHEDULE_KNOWN),
    };
}

/* ---------------------------------------------------------------------------
 * WRITE VALIDATION
 *
 * The published rules, applied BEFORE the request leaves us.
 *
 * Not because we distrust Infinite Flight's own validation — it is authoritative
 * and runs regardless — but because a 400 from an upstream preview API arrives
 * as a code, and a VA manager who typed a two-character callsign deserves the
 * sentence "a callsign is 1 to 32 characters" rather than "Request validation
 * failed". Every refusal here names the field and the rule.
 * ------------------------------------------------------------------------- */

// The documented callsign rule is "no control characters". Written as explicit
// ranges rather than \p{C} so it matches the C0/C1 sets the API means and
// nothing else — \p{C} also catches unassigned code points, which would refuse a
// callsign the API would have accepted.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const bad = (reason, field) => ({ ok: false, reason, field });

/**
 * A create/update schedule body.
 *
 * Returns `{ ok: true, value }` with exactly the fields ScheduleRequest defines,
 * or `{ ok: false, reason, field }`. Nothing else is forwarded: an unexpected
 * key in a request body is either a typo or an attempt, and either way the
 * documented contract is the whole of what we send.
 */
function normalizeScheduleRequest(b) {
    b = b || {};

    const callsign = String(b.callsign == null ? '' : b.callsign).trim();
    if (!callsign) return bad('A callsign is required.', 'callsign');
    if (callsign.length > 32) return bad('A callsign can be at most 32 characters.', 'callsign');
    if (CONTROL_CHARS.test(callsign)) return bad('A callsign cannot contain control characters.', 'callsign');

    const flightTypeRaw = b.flightType;
    const flightType = Number(flightTypeRaw);
    if (flightTypeRaw == null || flightTypeRaw === '' || !Number.isInteger(flightType) || !FLIGHT_TYPE[flightType]) {
        return bad('Pick a flight type.', 'flightType');
    }

    // Uppercased and stripped to alphanumerics, matching the documented storage
    // rule, so "kl ax" and "KLAX" reach the API as the same airport instead of
    // one of them being refused.
    const airport = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const originIcao = airport(b.originIcao);
    if (!originIcao) return bad('An origin airport is required.', 'originIcao');
    const destinationIcao = airport(b.destinationIcao);
    if (!destinationIcao) return bad('A destination airport is required.', 'destinationIcao');

    const dep = b.scheduledDepartureUtc ? new Date(b.scheduledDepartureUtc) : null;
    if (!dep || Number.isNaN(dep.getTime())) return bad('A departure time is required.', 'scheduledDepartureUtc');
    const arr = b.scheduledArrivalUtc ? new Date(b.scheduledArrivalUtc) : null;
    if (!arr || Number.isNaN(arr.getTime())) return bad('An arrival time is required.', 'scheduledArrivalUtc');
    if (arr.getTime() <= dep.getTime()) return bad('The arrival has to be after the departure.', 'scheduledArrivalUtc');

    const briefing = b.briefing == null ? '' : String(b.briefing);
    if (briefing.length > 4000) return bad('A briefing can be at most 4000 characters.', 'briefing');
    const flightPlan = b.flightPlan == null ? '' : String(b.flightPlan);
    if (flightPlan.length > 16000) return bad('A flight plan can be at most 16000 characters.', 'flightPlan');

    return {
        ok: true,
        value: {
            callsign,
            flightType,
            originIcao,
            destinationIcao,
            scheduledDepartureUtc: dep.toISOString(),
            scheduledArrivalUtc: arr.toISOString(),
            // null rather than '' for the optional pair: the documented way to
            // clear a stored value, and an empty string is not obviously the
            // same thing to a preview API.
            briefing: briefing || null,
            flightPlan: flightPlan || null,
        },
    };
}

/** A ScheduleFlightPlanRequest. Null or empty is legal and means "clear it". */
function normalizeFlightPlanRequest(b) {
    b = b || {};
    if (b.flightPlan == null) return { ok: true, value: { flightPlan: null } };
    const flightPlan = String(b.flightPlan);
    if (flightPlan.length > 16000) return bad('A flight plan can be at most 16000 characters.', 'flightPlan');
    return { ok: true, value: { flightPlan: flightPlan || null } };
}

/**
 * A ScheduleReorderRequest.
 *
 * `afterId` absent and `afterId: null` are the SAME instruction — move it to the
 * top — and both are normalised to an explicit null so the request body always
 * says which of the two positions was meant.
 */
function normalizeReorderRequest(b) {
    b = b || {};
    const scheduleId = String(b.scheduleId == null ? '' : b.scheduleId).trim();
    if (!scheduleId) return bad('Say which schedule to move.', 'scheduleId');
    const afterRaw = b.afterId == null ? '' : String(b.afterId).trim();
    if (afterRaw && afterRaw === scheduleId) return bad('A schedule cannot be placed after itself.', 'afterId');
    return { ok: true, value: { scheduleId, afterId: afterRaw || null } };
}

/* ---------------------------------------------------------------------------
 * THE LIVE ENDPOINTS
 *
 * A thin, complete method per documented path. Thin because the value of this
 * layer is the serialising and the error mapping, not cleverness; complete
 * because a half-wired integration is the kind that gets a feature request
 * rather than a bug report.
 * ------------------------------------------------------------------------- */

const enc = encodeURIComponent;

const listOrganizations = async (token) =>
    (await call(token, 'get', '/live/organizations') || []).map(publicOrganization).filter(Boolean);

const getOrganization = async (token, orgId) =>
    publicOrganization(await call(token, 'get', `/live/organizations/${enc(orgId)}`));

const listOrganizationAircraft = async (token, orgId) =>
    (await call(token, 'get', `/live/organizations/${enc(orgId)}/aircraft`) || []).map(publicAircraft).filter(Boolean);

const getAircraft = async (token, aircraftId) =>
    publicAircraft(await call(token, 'get', `/live/aircraft/${enc(aircraftId)}`));

const getAircraftPosition = async (token, aircraftId) =>
    publicPosition(await call(token, 'get', `/live/aircraft/${enc(aircraftId)}/position`));

const listSchedules = async (token, aircraftId) =>
    (await call(token, 'get', `/live/aircraft/${enc(aircraftId)}/schedules`) || []).map(publicSchedule).filter(Boolean);

const createSchedule = async (token, aircraftId, value) =>
    publicSchedule(await call(token, 'post', `/live/aircraft/${enc(aircraftId)}/schedules`, value));

const updateSchedule = async (token, scheduleId, value) =>
    publicSchedule(await call(token, 'put', `/live/schedules/${enc(scheduleId)}`, value));

const updateScheduleFlightPlan = async (token, scheduleId, value) =>
    publicSchedule(await call(token, 'put', `/live/schedules/${enc(scheduleId)}/flightplan`, value));

const reorderSchedules = async (token, aircraftId, value) =>
    !!(await call(token, 'put', `/live/aircraft/${enc(aircraftId)}/schedules/reorder`, value));

const deleteSchedule = async (token, scheduleId) =>
    !!(await call(token, 'delete', `/live/schedules/${enc(scheduleId)}`));

module.exports = {
    // configuration
    configured, unavailableReason, clientType, config,
    SCOPES, SCOPE_IDS, READ_SCOPES,

    // oauth
    createVerifier, challengeFor, createNonce, authorizeUrl,
    exchangeCode, refreshTokens, normalizeTokens, fetchUsername,

    // api
    call,
    listOrganizations, getOrganization, listOrganizationAircraft,
    getAircraft, getAircraftPosition,
    listSchedules, createSchedule, updateSchedule, updateScheduleFlightPlan,
    reorderSchedules, deleteSchedule,

    // shaping
    publicOrganization, publicAircraft, publicPosition, publicSchedule,
    normalizeScheduleRequest, normalizeFlightPlanRequest, normalizeReorderRequest,

    // vocabularies
    decodeEnum, enumOptions,
    ORGANIZATION_TYPE, OPERATION_TYPE, WORLD_TYPE, ORGANIZATION_STATUS,
    AIRCRAFT_STATUS, AIRCRAFT_VISIBILITY, PERSISTENCE_STATE, SCHEDULE_STATUS, FLIGHT_TYPE,

    IfLiveError,
};

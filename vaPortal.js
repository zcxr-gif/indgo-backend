// vaPortal.js
// VA Partnership Portal — a self-service portal for partnered Virtual Airlines.
//
// Where staffAuth.js gates the internal Inflight staff hub, this module powers a
// *separate* login surface for our partner VAs. When a VA is approved by the bot
// (or created manually by staff), an owner portal account is provisioned for it.
// From the portal a VA can:
//   - submit "everything and anything" to us (documents, requests, reports,
//     feedback, files) via the VaSubmission inbox, and
//   - hand out access to their own staff (owner-created sub-accounts scoped to
//     the same VA).
// Meanwhile our side (admin / staff / Inflight VA Rep) gets full oversight: we
// can read every submission, watch a portal activity feed ("see whatever they
// do"), and create / disable portal accounts manually.
//
// Auth model: per-account bcrypt passwords, a JWT in an httpOnly cookie
// (separate cookie + token type from the staff portal so the two never mix).
// Staff-oversight routes piggyback on staffAuth's staff session instead.
//
// Required env:
//   JWT_SECRET   - shared signing secret (same one staffAuth uses; tokens are
//                  namespaced by a `typ` claim so they are not interchangeable)

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

// Reuse the staff portal's auth so our oversight routes accept a staff session.
const { requireAuth: requireStaffSession } = require('./staffAuth');
const { normalizeCardOptions } = require('./vaEventCard');
// Shared roster helpers — same module the staff API uses, so a VA managing its
// own roster and staff managing it see identical parsing/de-dupe/limits.
const vaPilots = require('./vaPilots');
// Single source of truth for the Terms version + the enforcement ladder, shared
// with the Discord bot and the public Terms page so nothing drifts.
const {
    TOS_VERSION, TOS_EFFECTIVE_DATE, TOS_PDF_PATH, TOS_PAGE_PATH,
    TOS_SUMMARY, TOS_CHANGELOG, WARNING_LEVELS, WARNING_LEVEL_KEYS, getWarningLevel,
} = require('./vaTos');

// Where the embed widget is hosted. The portal surfaces a VA's embed link as a
// read-only, copyable URL; it never lets the VA change the underlying config.
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || 'https://inflight.info/embed.html';
// The Events + Calendar companion widget is served directly by THIS backend
// (unlike the map embed, which is fronted by the Netlify site at inflight.info).
// Point it at the backend's own public origin so its relative /api and /assets
// calls resolve straight to the backend. Override with EMBED_EVENTS_BASE_URL if
// the backend host ever changes.
const EMBED_EVENTS_BASE_URL = process.env.EMBED_EVENTS_BASE_URL
    || 'https://site--indgo-backend--6dmjph8ltlhv.code.run/embed-events.html';

const COOKIE_NAME = 'va_portal_token';
const TOKEN_TYPE = 'va_portal';            // distinguishes these tokens from staff tokens
const TOKEN_TTL = '30d';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Portal account roles (scoped to a single VA — NOT the staff roles).
//   owner - the VA partner who owns the listing. Can submit, and can create /
//           manage their own staff sub-accounts.
//   staff - a member of the VA's team. Can submit and view their VA's inbox, but
//           cannot manage accounts.
//   pilot - a crew member. Signs in ONLY at the VA's Crew Center (never this
//           partnership portal) and lands on the pilot home. Kept in the same
//           account table so a VA has one set of people.
const PORTAL_ROLES = ['owner', 'staff', 'pilot'];

// Inflight-side roles allowed to oversee the portal (read everything, manage
// accounts, triage submissions). Mirrors who can already touch VA tools.
const OVERSIGHT_ROLES = new Set(['admin', 'staff', 'va_rep']);

// Submission categories — deliberately broad ("everything and anything").
const SUBMISSION_CATEGORIES = ['document', 'request', 'report', 'event', 'feedback', 'other'];
const SUBMISSION_STATUSES = ['open', 'in_review', 'resolved', 'archived'];

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const VaPortalAccountSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: PORTAL_ROLES, default: 'owner' },

    // Which partner VA this account belongs to. vaAdId links to the
    // VirtualAirlineAd; vaName is denormalized so the portal still renders if the
    // ad is later renamed or removed.
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', default: null, index: true },
    vaName: { type: String, default: '' },

    // Discord user this account was provisioned for (when the bot created it).
    // Lets /va_addrep stay idempotent per person and /va_removerep find the
    // matching account to pause. Null for accounts created by hand.
    discordUserId: { type: String, default: null, index: true },

    active: { type: Boolean, default: true },
    // How the account came to exist, for the oversight UI: 'bot' (auto on
    // approval), 'staff' (created manually), or 'owner' (a VA invited a teammate).
    createdVia: { type: String, enum: ['bot', 'staff', 'owner'], default: 'staff' },
    createdByName: { type: String, default: '' },
    // Set when we generate a password for the account holder; the portal nudges
    // them to set their own on first login.
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },

    // Which Terms version this account holder has acknowledged in the portal.
    // The portal compares this to the current TOS_VERSION (vaTos.js) and shows a
    // "Terms updated — please review" banner whenever it lags behind, satisfying
    // "whenever we update the ToS, partners are updated on it in their portal".
    tosAckVersion: { type: String, default: '' },
    tosAckAt: { type: Date, default: null },

    // --- Which pilot this person is, on their own roster ---
    //
    // A VA's staff fly. That sounds obvious and the crew center did not allow
    // for it: a portal account could publish a schedule and could not book a
    // leg off it, could open the events panel and could not sign up, because
    // every pilot-side endpoint resolves the caller through the VA's OWN store
    // (crew_accounts.member_id) and a portal account has no row there.
    //
    // So this is the same link, from the other side: the id of the row in the
    // VA's crew_members table that IS this person. Set by the account holder
    // themselves from the crew center — nobody else's identity is theirs to
    // claim — and used only to answer "who is asking?" on the pilot endpoints.
    //
    // A bare string, not an ObjectId: it is a uuid in somebody else's Postgres,
    // and casting it here would be asserting a relationship this database
    // cannot enforce. Null means "this person does not fly", which is a normal
    // thing for a staff account to be.
    crewMemberId: { type: String, default: null, trim: true },
}, { timestamps: true });

const VaPortalAccount = mongoose.models.VaPortalAccount
    || mongoose.model('VaPortalAccount', VaPortalAccountSchema);

const VaSubmissionSchema = new mongoose.Schema({
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', default: null, index: true },
    vaName: { type: String, default: '' },

    // Who filed it (a portal account) — or, when staff log something on a VA's
    // behalf, the staff member.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'VaPortalAccount', default: null },
    submittedByName: { type: String, default: '' },
    submittedByRole: { type: String, default: '' }, // 'owner' | 'staff' | 'inflight-staff'

    category: { type: String, enum: SUBMISSION_CATEGORIES, default: 'other' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, default: '', maxlength: 8000 },
    links: { type: [String], default: [] },
    attachments: {
        type: [{
            url: String,
            name: String,
            size: Number,
            contentType: String,
        }],
        default: [],
    },

    // Triage on our side.
    status: { type: String, enum: SUBMISSION_STATUSES, default: 'open', index: true },
    staffNotes: { type: String, default: '' }, // internal, never shown to the VA
}, { timestamps: true });

VaSubmissionSchema.index({ vaAdId: 1, createdAt: -1 });
VaSubmissionSchema.index({ status: 1, createdAt: -1 });

const VaSubmission = mongoose.models.VaSubmission
    || mongoose.model('VaSubmission', VaSubmissionSchema);

/* =========================
 * VA PORTAL EVENTS
 *
 * Events a partner VA schedules through the portal (group flights, fly-ins,
 * etc.). Kept DELIBERATELY tiny on storage: a handful of short fields, no
 * attachments, and a TTL index that auto-deletes each event 14 days after it
 * starts, so past events never accumulate and the collection stays bounded.
 * (minimize:true also drops any empty objects.)
 * ========================= */
const MAX_EVENTS_PER_VA = 50;       // soft cap on a VA's upcoming events
const EVENT_RETAIN_MS = 14 * 24 * 60 * 60 * 1000; // prune 14d after start

const VaEventSchema = new mongoose.Schema({
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', default: null, index: true },
    vaName: { type: String, default: '' },
    createdByName: { type: String, default: '' },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 1000 },
    link: { type: String, default: '', maxlength: 300 },
    // Where the flight departs from, so pilots know where to spawn. Stored
    // uppercase; validated as a 3–4 letter/number ICAO before it's saved.
    departureIcao: { type: String, default: '', uppercase: true, trim: true, maxlength: 4 },
    // Optional hero banner (S3 URL) shown large on the event card.
    bannerUrl: { type: String, default: '' },
    // Optional group-flight code (see vaGroupFlights.js). Set once the event's
    // formation is airborne and the owner has minted a link — the tracker's
    // event list then offers "watch live" on the card instead of just a date.
    groupCode: { type: String, default: '', trim: true, maxlength: 16 },
    startsAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
}, { minimize: true });

// TTL prune: Mongo deletes the doc once startsAt + EVENT_RETAIN_MS is in the past.
VaEventSchema.index({ startsAt: 1 }, { expireAfterSeconds: EVENT_RETAIN_MS / 1000 });
VaEventSchema.index({ vaAdId: 1, startsAt: 1 });

const VaEvent = mongoose.models.VaEvent || mongoose.model('VaEvent', VaEventSchema);

function publicEvent(e) {
    if (!e) return null;
    return {
        id: e._id, vaAdId: e.vaAdId, vaName: e.vaName,
        title: e.title, description: e.description || '', link: e.link || '',
        departureIcao: e.departureIcao || '', bannerUrl: e.bannerUrl || '',
        groupCode: e.groupCode || '',
        startsAt: e.startsAt, createdByName: e.createdByName, createdAt: e.createdAt,
    };
}

/* =========================
 * VA WARNINGS  (Terms enforcement ladder)
 *
 * A durable record of every warning Inflight issues to a VA for not following
 * the Terms. The escalation levels (verbal → first → second → final →
 * termination) live in vaTos.js so the portal, the Discord embed and the PDF
 * all agree. Each warning is delivered to the VA's Discord channel AND shown in
 * their portal, where any account on the VA can acknowledge receipt.
 * ========================= */
const VaWarningSchema = new mongoose.Schema({
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    vaName: { type: String, default: '' },
    // One of vaTos WARNING_LEVEL_KEYS.
    level: { type: String, enum: WARNING_LEVEL_KEYS, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 4000 },
    // Which Terms version was in force when this was issued (for context).
    termsVersion: { type: String, default: TOS_VERSION },

    // Who issued it (an Inflight staff member).
    issuedByName: { type: String, default: '' },
    issuedByRole: { type: String, default: '' },

    // active until an admin rescinds it (e.g. issued in error / resolved).
    status: { type: String, enum: ['active', 'rescinded'], default: 'active', index: true },
    rescindedByName: { type: String, default: '' },
    rescindedAt: { type: Date, default: null },
    rescindReason: { type: String, default: '' },

    // The VA's acknowledgement of receipt (not agreement).
    acknowledgedAt: { type: Date, default: null },
    acknowledgedByName: { type: String, default: '' },

    // Delivery bookkeeping so staff can see it reached Discord.
    discordDelivered: { type: Boolean, default: false },
    discordChannelId: { type: String, default: null },
}, { timestamps: true });

VaWarningSchema.index({ vaAdId: 1, createdAt: -1 });
VaWarningSchema.index({ status: 1, createdAt: -1 });

const VaWarning = mongoose.models.VaWarning || mongoose.model('VaWarning', VaWarningSchema);

function publicWarning(w) {
    if (!w) return null;
    const lvl = getWarningLevel(w.level) || {};
    return {
        id: w._id,
        vaAdId: w.vaAdId,
        vaName: w.vaName,
        level: w.level,
        levelLabel: lvl.label || w.level,
        levelShort: lvl.short || w.level,
        palette: lvl.palette || 'red',
        order: (typeof lvl.order === 'number') ? lvl.order : 0,
        reason: w.reason,
        termsVersion: w.termsVersion || '',
        issuedByName: w.issuedByName || 'Inflight',
        status: w.status,
        rescindedByName: w.rescindedByName || '',
        rescindedAt: w.rescindedAt || null,
        acknowledgedAt: w.acknowledgedAt || null,
        acknowledgedByName: w.acknowledgedByName || '',
        discordDelivered: !!w.discordDelivered,
        createdAt: w.createdAt,
    };
}

// Lightweight audit trail so the Inflight side can "see whatever they do".
const VaPortalActivitySchema = new mongoose.Schema({
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', default: null, index: true },
    vaName: { type: String, default: '' },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    action: { type: String, default: '' },  // e.g. 'login', 'submission.create', 'team.create'
    detail: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
}, { timestamps: false });

VaPortalActivitySchema.index({ createdAt: -1 });
// Self-prune after 180 days so the log never grows unbounded.
VaPortalActivitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const VaPortalActivity = mongoose.models.VaPortalActivity
    || mongoose.model('VaPortalActivity', VaPortalActivitySchema);

// Fire-and-forget activity logging (never block a request on the audit write).
// Portal activity is no longer persisted to the database — every event is
// streamed to a Discord log channel instead (VA_PORTAL_LOG_CHANNEL_ID, default
// the dedicated VA logs channel). Fire-and-forget so logging never blocks or
// fails a request. bot.js is required lazily to dodge load-order coupling.
const VA_PORTAL_LOG_CHANNEL_ID = process.env.VA_PORTAL_LOG_CHANNEL_ID || '1521208457812774942';
function logActivity({ vaAdId, vaName, actorName, actorRole, action, detail }) {
    try {
        const { postToChannel } = require('./bot');
        const fields = [];
        if (vaName) fields.push({ name: 'VA', value: String(vaName).slice(0, 256), inline: true });
        if (actorName) fields.push({ name: 'By', value: `${actorName}${actorRole ? ` (${actorRole})` : ''}`.slice(0, 256), inline: true });
        if (action) fields.push({ name: 'Action', value: String(action).slice(0, 256), inline: true });
        postToChannel(VA_PORTAL_LOG_CHANNEL_ID, {
            embeds: [{
                title: '📋 VA Portal activity',
                description: detail ? String(detail).slice(0, 2000) : undefined,
                color: 0x6366f1,
                fields,
                timestamp: new Date().toISOString(),
            }],
        });
    } catch (err) {
        console.error('VA portal activity log error:', err.message);
    }
}

// Deliver a warning to the VA's own Discord channel (their "thread"), so the
// notice reaches the partner where they operate — not just in the portal.
// Best-effort and fire-and-forget: returns the channel id we posted to, or null
// if the VA has no Discord channel wired up. bot.js is required lazily.
function deliverWarningToDiscord(ad, warning) {
    try {
        const channelId = ad && ad.discordChannelId;
        if (!channelId) return null;
        const { postToChannel } = require('./bot');
        const lvl = getWarningLevel(warning.level) || {};
        const isTermination = warning.level === 'termination';
        const title = isTermination
            ? `⛔ ${lvl.label || 'Contract Termination'}`
            : `⚠️ ${lvl.label || 'Warning'}`;
        const ladder = WARNING_LEVELS.map((l) =>
            (l.key === warning.level ? `**➤ ${l.label}**` : l.label)).join('  →  ');
        postToChannel(channelId, {
            content: isTermination ? undefined : '@here',
            embeds: [{
                title,
                description:
                    `This is an official **${lvl.label || 'notice'}** issued to **${warning.vaName || ad.name}** ` +
                    `regarding compliance with the Inflight VA Advertisement Program Terms.\n\n` +
                    `**Reason**\n${String(warning.reason || '').slice(0, 1500)}\n\n` +
                    (lvl.meaning ? `**What this means**\n${lvl.meaning}\n\n` : '') +
                    `Please review and acknowledge this in your **VA Portal** › Compliance. ` +
                    `Questions can be raised with our VA Rep.`,
                color: (typeof lvl.color === 'number') ? lvl.color : 0xDC2626,
                fields: [
                    { name: 'Escalation stage', value: ladder, inline: false },
                    { name: 'Issued by', value: String(warning.issuedByName || 'Inflight').slice(0, 256), inline: true },
                    { name: 'Terms version', value: String(warning.termsVersion || TOS_VERSION), inline: true },
                ],
                footer: { text: 'Inflight VA Advertisement Program • Terms enforcement' },
                timestamp: new Date().toISOString(),
            }],
        });
        return channelId;
    } catch (err) {
        console.error('VA warning Discord delivery error:', err.message);
        return null;
    }
}

// Announce a Terms update to every VA that has a Discord channel, so partners
// are prompted (in Discord + their portal) to review the new version. Returns
// a { attempted } count. Best-effort per channel.
async function announceTosUpdateToDiscord(VirtualAirlineAd) {
    let attempted = 0;
    try {
        const { postToChannel } = require('./bot');
        const ads = await VirtualAirlineAd
            .find({ discordChannelId: { $ne: null }, status: { $ne: 'removed' } }, 'name discordChannelId')
            .limit(2000);
        // Surface the current version's changelog in the notice so partners see
        // what actually changed without having to open the Terms page first.
        const current = TOS_CHANGELOG.find((c) => c.version === TOS_VERSION);
        const changed = current && current.notes && current.notes.length
            ? current.notes.map((n) => `• ${n}`).join('\n').slice(0, 1024)
            : '';
        for (const ad of ads) {
            if (!ad.discordChannelId) continue;
            attempted += 1;
            postToChannel(ad.discordChannelId, {
                embeds: [{
                    title: '📄 Our Terms & Conditions have been updated',
                    description:
                        `The Inflight VA Advertisement Program **Terms & Conditions** have been updated to ` +
                        `**${TOS_VERSION}** (effective ${TOS_EFFECTIVE_DATE}).\n\n` +
                        `Please review them and acknowledge the new version in your **VA Portal** › Compliance. ` +
                        `Continued participation constitutes acceptance of the revised Terms.`,
                    color: 0x2563EB,
                    fields: changed ? [{ name: 'What changed', value: changed, inline: false }] : [],
                    footer: { text: 'Inflight VA Advertisement Program' },
                    timestamp: new Date().toISOString(),
                }],
            });
        }
    } catch (err) {
        console.error('VA ToS announce error:', err.message);
    }
    return { attempted };
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------
function publicAccount(a) {
    if (!a) return null;
    return {
        id: a._id,
        username: a.username,
        displayName: a.displayName || a.username,
        role: a.role,
        vaAdId: a.vaAdId,
        vaName: a.vaName,
        active: a.active,
        createdVia: a.createdVia,
        createdByName: a.createdByName,
        mustChangePassword: a.mustChangePassword,
        lastLoginAt: a.lastLoginAt,
        createdAt: a.createdAt,
        tosAckVersion: a.tosAckVersion || '',
        tosAckAt: a.tosAckAt || null,
    };
}

// The current Terms state, plus whether a given portal account has acknowledged
// the live version. Shared by /auth/me and the dedicated /tos route so the
// portal can render its "Terms updated" banner from either.
function tosState(account) {
    const acked = !!account && account.tosAckVersion === TOS_VERSION;
    return {
        version: TOS_VERSION,
        effectiveDate: TOS_EFFECTIVE_DATE,
        pdfUrl: TOS_PDF_PATH,
        pageUrl: TOS_PAGE_PATH,
        summary: TOS_SUMMARY,
        changelog: TOS_CHANGELOG,
        acknowledged: acked,
        acknowledgedVersion: (account && account.tosAckVersion) || '',
        acknowledgedAt: (account && account.tosAckAt) || null,
    };
}

// The enforcement ladder shape the portal + staff UI render (no server-only bits).
const warningLevelsPublic = () => WARNING_LEVELS.map((l) => ({
    key: l.key, order: l.order, label: l.label, short: l.short, palette: l.palette, meaning: l.meaning,
}));

// Shape a submission for the VA-facing portal (hides internal staff notes).
function publicSubmission(s) {
    if (!s) return null;
    return {
        id: s._id,
        vaAdId: s.vaAdId,
        vaName: s.vaName,
        submittedByName: s.submittedByName,
        submittedByRole: s.submittedByRole,
        category: s.category,
        title: s.title,
        body: s.body,
        links: s.links || [],
        attachments: s.attachments || [],
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
}

// Staff oversight gets everything, including internal notes.
function adminSubmission(s) {
    return { ...publicSubmission(s), staffNotes: s.staffNotes || '' };
}

// ---------------------------------------------------------------------------
// Token + cookie helpers
// ---------------------------------------------------------------------------
function signToken(account) {
    return jwt.sign(
        { sub: String(account._id), typ: TOKEN_TYPE, role: account.role, va: String(account.vaAdId || '') },
        JWT_SECRET,
        { expiresIn: TOKEN_TTL }
    );
}

function parseCookies(req) {
    const header = req.headers && req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

function getToken(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return parseCookies(req)[COOKIE_NAME] || null;
}

function setAuthCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: COOKIE_MAX_AGE,
        path: '/',
    });
}

function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Verify the request's portal token and load the active account.
async function resolveAccount(req) {
    const token = getToken(req);
    if (!token) return null;
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
    if (payload.typ !== TOKEN_TYPE) return null; // reject staff tokens etc.
    const account = await VaPortalAccount.findById(payload.sub);
    if (!account || !account.active) return null;
    return account;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// VA portal API guard.
async function requirePortal(req, res, next) {
    const account = await resolveAccount(req);
    if (!account) return res.status(401).json({ error: 'Authentication required.' });
    req.portal = account;
    next();
}

// VA portal API guard — owner only (account management).
async function requirePortalOwner(req, res, next) {
    const account = await resolveAccount(req);
    if (!account) return res.status(401).json({ error: 'Authentication required.' });
    if (account.role !== 'owner') return res.status(403).json({ error: 'Only the VA owner can do that.' });
    req.portal = account;
    next();
}

// VA portal page guard — redirect to the portal login if not signed in.
async function requirePortalPage(req, res, next) {
    const account = await resolveAccount(req);
    if (!account) {
        const next_ = encodeURIComponent(req.originalUrl || '/va-portal');
        return res.redirect(`/va-portal?next=${next_}`);
    }
    req.portal = account;
    next();
}

// Inflight-side oversight guard: requires a staff session in an oversight role.
// Reuses staffAuth.requireAuth, then checks the role.
function requireOversight(req, res, next) {
    requireStaffSession(req, res, () => {
        if (!req.staff || !OVERSIGHT_ROLES.has(req.staff.role)) {
            return res.status(403).json({ error: 'Inflight staff access required.' });
        }
        next();
    });
}

// ---------------------------------------------------------------------------
// Password helpers + provisioning
// ---------------------------------------------------------------------------
// Generate a readable random password for an auto-provisioned account.
function generatePassword() {
    // 12 url-safe chars, avoids ambiguous lookalikes well enough for a one-time
    // credential the user is asked to change.
    return crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '7a';
}

// Build a unique, sensible username from a VA name (e.g. "Oceanic VA" -> "oceanic-va").
async function uniqueUsernameFrom(base) {
    let root = String(base || 'va').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'va';
    let candidate = root;
    let n = 1;
    // Loop until we find a free username.
    while (await VaPortalAccount.exists({ username: candidate })) {
        n += 1;
        candidate = `${root}-${n}`;
    }
    return candidate;
}

/**
 * Provision (or fetch) the owner portal account for a VA ad. Idempotent: if the
 * VA already has an owner account it is returned with `created: false` and no
 * new password. On first creation it returns the plaintext password ONCE so the
 * caller (the bot) can DM it to the VA owner.
 *
 * @param {Object} ad         a VirtualAirlineAd document (needs _id and name)
 * @param {Object} [opts]
 * @param {string} [opts.createdVia='bot']
 * @param {string} [opts.createdByName='Inflight Bot']
 * @returns {{account: Object, created: boolean, username: string, password: string|null}}
 */
async function provisionOwnerAccount(ad, opts = {}) {
    if (!ad || !ad._id) throw new Error('provisionOwnerAccount requires a VA ad with an _id.');
    const { createdVia = 'bot', createdByName = 'Inflight Bot' } = opts;

    const existing = await VaPortalAccount.findOne({ vaAdId: ad._id, role: 'owner' });
    if (existing) {
        // Keep the denormalized name fresh.
        if (ad.name && existing.vaName !== ad.name) {
            existing.vaName = ad.name;
            await existing.save().catch(() => {});
        }
        return { account: existing, created: false, username: existing.username, password: null };
    }

    const username = await uniqueUsernameFrom(ad.name);
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const account = await VaPortalAccount.create({
        username,
        displayName: ad.ownerName || ad.name || username,
        passwordHash,
        role: 'owner',
        vaAdId: ad._id,
        vaName: ad.name || '',
        discordUserId: ad.ownerId || null,
        createdVia,
        createdByName,
        mustChangePassword: true,
        active: true,
    });
    logActivity({
        vaAdId: ad._id, vaName: ad.name, actorName: createdByName, actorRole: createdVia,
        action: 'account.provision', detail: `Owner account @${username} created`,
    });
    return { account, created: true, username, password };
}

/**
 * Provision (or revive) a portal *staff* account for one of a VA's Discord
 * representatives — the companion to the bot's /va_addrep. Keyed on the rep's
 * Discord user id so re-adding the same person never mints a duplicate:
 *   - no account yet            → create one, return the plaintext password once
 *   - account exists, disabled  → reactivate it with a fresh temporary password
 *   - account exists, active    → return it untouched (password: null)
 *
 * If the rep already holds the VA's OWNER account, that account is returned
 * as-is (role untouched) — the owner doesn't need a second login.
 *
 * @param {Object} ad    a VirtualAirlineAd document (needs _id and name)
 * @param {Object} opts
 * @param {string} opts.discordUserId    the rep's Discord user id (required)
 * @param {string} [opts.discordUsername] used to build a readable username
 * @param {string} [opts.displayName]
 * @param {string} [opts.createdByName='Inflight Bot']
 * @returns {{account: Object, created: boolean, reactivated: boolean, username: string, password: string|null}}
 */
async function provisionRepAccount(ad, opts = {}) {
    if (!ad || !ad._id) throw new Error('provisionRepAccount requires a VA ad with an _id.');
    const { discordUserId, discordUsername = '', displayName = '', createdByName = 'Inflight Bot' } = opts;
    if (!discordUserId) throw new Error('provisionRepAccount requires the rep\'s Discord user id.');

    const existing = await VaPortalAccount.findOne({ vaAdId: ad._id, discordUserId: String(discordUserId) });
    if (existing) {
        if (existing.active) {
            return { account: existing, created: false, reactivated: false, username: existing.username, password: null };
        }
        // Paused (e.g. after /va_removerep) — revive it with a fresh temp password.
        const password = generatePassword();
        existing.passwordHash = await bcrypt.hash(password, 12);
        existing.mustChangePassword = true;
        existing.active = true;
        if (ad.name) existing.vaName = ad.name;
        await existing.save();
        logActivity({
            vaAdId: ad._id, vaName: ad.name, actorName: createdByName, actorRole: 'bot',
            action: 'account.reactivate', detail: `Rep account @${existing.username} reactivated`,
        });
        return { account: existing, created: false, reactivated: true, username: existing.username, password };
    }

    const base = discordUsername || displayName || `${ad.name || 'va'}-rep`;
    const username = await uniqueUsernameFrom(base);
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const account = await VaPortalAccount.create({
        username,
        displayName: displayName || discordUsername || username,
        passwordHash,
        role: 'staff',
        vaAdId: ad._id,
        vaName: ad.name || '',
        discordUserId: String(discordUserId),
        createdVia: 'bot',
        createdByName,
        mustChangePassword: true,
        active: true,
    });
    logActivity({
        vaAdId: ad._id, vaName: ad.name, actorName: createdByName, actorRole: 'bot',
        action: 'account.provision', detail: `Rep account @${username} created`,
    });
    return { account, created: true, reactivated: false, username, password };
}

/*
 * PILOT ACCOUNTS ARE NOT PROVISIONED HERE ANY MORE.
 *
 * They used to be: a 'pilot' row in the table above, created when a VA accepted
 * an application. That made Inflight the custodian of every pilot's credentials
 * for every VA on the platform, which is precisely what the crew center's
 * bring-your-own-database model exists to avoid — a pilot's account is the VA's
 * data in the same way their hours are.
 *
 * A pilot login is now a row in the VA's OWN Supabase project. See
 * crewAccounts.js for provisioning, authentication and password changes, and
 * supabase/crew-center-schema.sql for the table.
 *
 * 'pilot' stays in PORTAL_ROLES and pilot rows stay readable here because VAs
 * that have not run the migration yet still have theirs in this collection;
 * crewStore's legacy adapter serves those through the same interface until
 * POST /api/crew/:slug/store/migrate moves them across.
 */

/**
 * Pause the portal account(s) the bot provisioned for a Discord rep of a VA —
 * the companion to /va_removerep. Deactivates rather than deletes (the account
 * and its history survive, and /va_addrep revives it). Owner accounts are left
 * alone: removing someone as a rep must never lock the VA owner out.
 *
 * @returns {Promise<number>} how many accounts were paused
 */
async function deactivateRepAccount(ad, discordUserId, { actorName = 'Inflight Bot' } = {}) {
    if (!ad || !ad._id || !discordUserId) return 0;
    const res = await VaPortalAccount.updateMany(
        { vaAdId: ad._id, discordUserId: String(discordUserId), role: { $ne: 'owner' }, active: true },
        { $set: { active: false } }
    );
    const n = res.modifiedCount || 0;
    if (n) {
        logActivity({
            vaAdId: ad._id, vaName: ad.name, actorName, actorRole: 'bot',
            action: 'account.deactivate', detail: `Rep portal access paused (${n} account${n === 1 ? '' : 's'})`,
        });
    }
    return n;
}

/**
 * Completely erase a VA's portal-side footprint: every portal account (owner +
 * staff), submission (and its S3 attachments), scheduled event, activity-log row
 * and live-map embed, the VA's own logo/banner images in S3, and its flight-events
 * Discord webhook (deleted at Discord, not just dropped from our database).
 *
 * It deliberately does NOT touch the Discord channel/role or delete the
 * VirtualAirlineAd document itself — the caller owns those (the bot deletes the
 * Discord space and the ad doc). Every delete is best-effort so one failure never
 * blocks the rest. Returns counts so the caller can report what was cleared.
 *
 * NOTE: the webhook URL is stored select:false, so for the webhook delete to fire
 * the caller must load `ad` with `.select('+flightEventsWebhookUrl')`.
 *
 * @param {Object} ad  the VirtualAirlineAd document being removed
 * @param {Object} [deps]
 * @param {Object} [deps.EmbedConfig]         embed-config model (embeds are matched by callsign)
 * @param {Function} [deps.deleteVaImage]     (s3Client, url) => Promise — deletes one S3 object
 * @param {Object} [deps.s3Client]            S3 client for image/attachment deletes
 * @param {Function} [deps.isDiscordWebhookUrl] (url) => boolean — validates before we DELETE it
 * @returns {Promise<{accounts:number, submissions:number, events:number, activity:number, embeds:number, images:number, webhook:boolean}>}
 */
async function purgeVaData(ad, { EmbedConfig, deleteVaImage, s3Client, isDiscordWebhookUrl } = {}) {
    const counts = { accounts: 0, submissions: 0, events: 0, activity: 0, embeds: 0, images: 0, webhook: false };
    if (!ad || !ad._id) return counts;
    const vaAdId = ad._id;

    // Delete any S3 attachments carried by this VA's submissions before we drop
    // the rows that point at them (otherwise the objects would be orphaned).
    if (deleteVaImage && s3Client) {
        try {
            const subs = await VaSubmission.find({ vaAdId }, 'attachments');
            for (const s of subs) {
                for (const att of (s.attachments || [])) {
                    if (att && att.url) { await deleteVaImage(s3Client, att.url); counts.images += 1; }
                }
            }
        } catch (e) { console.error('purgeVaData submission attachments:', e.message); }
    }

    // Drop every portal-side collection keyed to this VA.
    try { counts.accounts    = (await VaPortalAccount.deleteMany({ vaAdId })).deletedCount || 0; } catch (e) { console.error('purgeVaData accounts:', e.message); }
    try { counts.submissions = (await VaSubmission.deleteMany({ vaAdId })).deletedCount || 0; } catch (e) { console.error('purgeVaData submissions:', e.message); }
    try { counts.events      = (await VaEvent.deleteMany({ vaAdId })).deletedCount || 0; } catch (e) { console.error('purgeVaData events:', e.message); }
    try { counts.activity    = (await VaPortalActivity.deleteMany({ vaAdId })).deletedCount || 0; } catch (e) { console.error('purgeVaData activity:', e.message); }

    // Embeds are linked to a VA by the hard vaAdId reference (the "head"), with a
    // legacy callsign match as a fallback — the same pair the portal lists on.
    if (EmbedConfig) {
        try {
            const codes = ((Array.isArray(ad.callsigns) && ad.callsigns.length ? ad.callsigns : [ad.callsign])
                .filter(Boolean)).map(c => String(c).toUpperCase());
            const or = [{ vaAdId }];
            if (codes.length) or.push({ 'va.code': { $in: codes } });
            counts.embeds = (await EmbedConfig.deleteMany({ $or: or })).deletedCount || 0;
        } catch (e) { console.error('purgeVaData embeds:', e.message); }
    }

    // The VA's own banner/logo images.
    if (deleteVaImage && s3Client) {
        try {
            if (ad.logoUrl)   { await deleteVaImage(s3Client, ad.logoUrl);   counts.images += 1; }
            if (ad.bannerUrl) { await deleteVaImage(s3Client, ad.bannerUrl); counts.images += 1; }
        } catch (e) { console.error('purgeVaData images:', e.message); }
    }

    // Finally the flight-events webhook — deleted at Discord, so the VA's own
    // channel stops receiving posts and the webhook itself is gone (not just our
    // stored copy). Only fires if the caller loaded the select:false URL. Validate
    // the host first so this can never be turned into an arbitrary-URL DELETE.
    const hookUrl = ad.flightEventsWebhookUrl;
    if (hookUrl && (typeof isDiscordWebhookUrl !== 'function' || isDiscordWebhookUrl(hookUrl))) {
        try {
            const resp = await fetch(hookUrl.trim(), { method: 'DELETE' });
            // 204 = deleted; 404 = already gone. Either way it is no longer live.
            if (resp.ok || resp.status === 404) counts.webhook = true;
            else console.error('purgeVaData webhook delete: unexpected status', resp.status);
        } catch (e) { console.error('purgeVaData webhook delete:', e.message); }
    }

    return counts;
}

// Upload an arbitrary submission attachment to S3 and return its descriptor.
async function uploadSubmissionFile(s3Client, file) {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const fs = require('fs');
    const body = file.path ? fs.createReadStream(file.path) : file.buffer;
    const safeName = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
    const key = `va-portal/submissions/${Date.now()}-${Math.round(Math.random() * 1e6)}-${safeName}`;
    await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: file.mimetype || 'application/octet-stream',
    }));
    if (file.path) fs.unlink(file.path, () => {});
    return {
        url: `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
        name: file.originalname || safeName,
        size: file.size || 0,
        contentType: file.mimetype || 'application/octet-stream',
    };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * @param {Express} app
 * @param {Object} deps
 * @param {Object} deps.VirtualAirlineAd  the VA ad mongoose model
 * @param {Object} [deps.EmbedConfig]     the embed-config model (for embed links)
 * @param {Object} deps.s3Client          AWS S3 client (for attachments)
 * @param {Object} deps.upload            configured multer instance
 * @param {Function} [deps.uploadVaImage] (s3Client, file, ref, kind) => url
 * @param {Function} [deps.deleteVaImage] (s3Client, url) => Promise
 */
function registerVaPortalRoutes(app, { VirtualAirlineAd, EmbedConfig, VaPilot, s3Client, upload, uploadVaImage, deleteVaImage, isDiscordWebhookUrl, sendVaTestEvent, renderCardPreview, applyEmbedAppearance }) {
    // Webhook URLs are secrets, so the profile API never echoes one back in full.
    // Surface just enough for the owner to recognise what's saved: the trailing
    // chars of the webhook id. Defensive against malformed stored values.
    const maskWebhookUrl = (url) => {
        if (!url) return '';
        const m = String(url).match(/webhooks\/(\d+)/);
        const id = m && m[1];
        return id ? `…/webhooks/${id.slice(-4).padStart(id.length > 4 ? 8 : id.length, '•')}/…` : '…';
    };
    // multipart parser for the VA-profile editor (optional new logo + banner).
    const uploadVaProfileImages = upload.fields([
        { name: 'logo', maxCount: 1 },
        { name: 'banner', maxCount: 1 },
    ]);
    // multipart parser for the event editor (optional hero banner).
    const uploadEventBanner = upload.single('banner');

    // Validate + normalise a departure airport ICAO. ICAO codes are 4 chars
    // (occasionally 3 for some codes we still accept), letters/digits only.
    // Returns the uppercased code, or '' when blank; throws on a bad value so
    // the route can bounce it with a clear message.
    const normalizeIcao = (raw) => {
        const s = String(raw == null ? '' : raw).trim().toUpperCase();
        if (!s) return '';
        if (!/^[A-Z0-9]{3,4}$/.test(s)) {
            const err = new Error('Departure ICAO must be a 3–4 character airport code (e.g. KLAX).');
            err.status = 400;
            throw err;
        }
        return s;
    };

    // Parse a field that may arrive as a JSON array, a CSV string, or an array.
    const parseList = (value) => {
        if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
        if (typeof value !== 'string' || !value.trim()) return [];
        const raw = value.trim();
        if (raw.startsWith('[')) {
            try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr.map(v => String(v).trim()).filter(Boolean); }
            catch { /* fall through */ }
        }
        return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    };

    // Shape a VA ad for the portal's "profile" view — everything a partner may
    // see/edit about themselves, plus the read-only media URLs.
    const portalVa = (ad) => {
        if (!ad) return null;
        const callsigns = (Array.isArray(ad.callsigns) && ad.callsigns.length)
            ? ad.callsigns : (ad.callsign ? [ad.callsign] : []);
        return {
            id: ad._id,
            name: ad.name,
            type: ad.type,
            callsign: ad.callsign || (callsigns[0] || ''),
            callsigns,
            tagline: ad.tagline || '',
            description: ad.description || '',
            logoUrl: ad.logoUrl || null,
            bannerUrl: ad.bannerUrl || null,
            websiteUrl: ad.websiteUrl || '',
            discordUrl: ad.discordUrl || '',
            ifcThreadUrl: ad.ifcThreadUrl || '',
            applicationUrl: ad.applicationUrl || '',
            region: ad.region || 'Global',
            hubs: ad.hubs || [],
            fleet: ad.fleet || [],
            tags: ad.tags || [],
            pilotCount: ad.pilotCount || 0,
            recruiting: !!ad.recruiting,
            minGrade: ad.minGrade || null,
            requirements: ad.requirements || '',
            status: ad.status,
            // Flight-event delivery (request → staff approval). Never return the
            // raw webhook — only whether one is set, a masked hint, the on/off
            // toggle, and the request/approval state that drives the portal card.
            flightEventsConfigured: !!ad.flightEventsWebhookUrl,
            flightEventsEnabled: !!ad.flightEventsEnabled,
            flightEventsApproved: !!ad.flightEventsApproved,
            flightEventsRequested: !!ad.flightEventsRequestedAt,
            flightEventsWebhookHint: ad.flightEventsWebhookUrl ? maskWebhookUrl(ad.flightEventsWebhookUrl) : '',
            // The (normalized) card customization — colours/layout/fields — so the
            // portal can render the current selection. Always a full, valid object.
            flightEventsCard: normalizeCardOptions(ad.flightEventsCard || {}),
        };
    };

    // The VA's callsign code(s), uppercased — the key an embed is matched on.
    // An embed "belongs to" this VA when its va.code is one of these, which is
    // also the ownership check for editing (a VA can only restyle its own embeds).
    const vaCallsignCodes = (ad) =>
        ((Array.isArray(ad.callsigns) && ad.callsigns.length ? ad.callsigns : [ad && ad.callsign])
            .filter(Boolean)).map((c) => String(c).toUpperCase());

    // Shape one embed config for the portal: the copyable link/iframe plus the
    // editable appearance (mirrors the cosmetic fields applyEmbedAppearance
    // accepts). Identity, matching and access-control fields are never exposed.
    const serializeEmbed = (c, ad) => {
        const url = `${EMBED_BASE_URL}?token=${encodeURIComponent(c.token)}`;
        const title = (c.va && c.va.name) || (ad && ad.name) || 'VA';
        // The Events + Calendar companion embed shares the same token (the widget
        // resolves it for appearance, the VA link and the chosen template).
        const eventsUrl = `${EMBED_EVENTS_BASE_URL}?token=${encodeURIComponent(c.token)}`;
        const eventsEnabled = c.events === 'on';
        return {
            id: String(c._id),
            label: c.label || (c.va && c.va.name) || (ad && ad.name) || 'Embed',
            mode: c.mode,
            revoked: !!c.revoked,
            url,
            iframe: `<iframe src="${url}" style="width:100%;height:560px;border:0;border-radius:16px;overflow:hidden" loading="lazy" title="${title} live map"></iframe>`,
            // Events + calendar companion widget (only meaningful when enabled).
            eventsEnabled,
            eventsUrl,
            eventsIframe: `<iframe src="${eventsUrl}" style="width:100%;height:720px;border:0;border-radius:16px;overflow:hidden" loading="lazy" title="${title} events & calendar"></iframe>`,
            appearance: {
                mode: c.mode || 'roster',
                theme: c.theme || 'dark',
                header: c.header || 'on',
                headerPos: c.headerPos || 'top',
                accent: Array.isArray(c.accent) ? c.accent : [],
                gradient: c.gradient || 'auto',
                gradientAngle: (c.gradientAngle == null ? 120 : c.gradientAngle),
                compact: !!c.compact,
                radius: (c.radius == null ? null : c.radius),
                freeStyle: c.freeStyle || 'dark',
                events: eventsEnabled ? 'on' : 'off',
                eventsTemplate: (c.eventsTemplate == null ? 1 : c.eventsTemplate),
                card: {
                    color: (c.card && c.card.color) || '',
                    text: (c.card && c.card.text) || '',
                    opacity: (c.card && c.card.opacity != null) ? c.card.opacity : null,
                    blur: (c.card && c.card.blur != null) ? c.card.blur : null,
                },
            },
        };
    };

    // Find this VA's embeds. Matched on the embed config's va.code against any of
    // the VA's callsigns. Read for everyone on the VA; editing is owner-gated at
    // the route + re-checked against these codes before any write.
    async function embedLinksForVa(ad) {
        if (!EmbedConfig || !ad) return [];
        const codes = vaCallsignCodes(ad);
        // Prefer the hard vaAdId link (the "trail to the head"); fall back to the
        // legacy callsign match so embeds created before the link still show.
        const or = [{ vaAdId: ad._id }];
        if (codes.length) or.push({ 'va.code': { $in: codes } });
        try {
            const configs = await EmbedConfig.find({ $or: or }).sort({ createdAt: -1 }).limit(20);
            return configs.map((c) => serializeEmbed(c, ad));
        } catch (err) {
            console.error('VA portal embed lookup error:', err.message);
            return [];
        }
    }

    // =====================================================================
    // VA-FACING AUTH
    // =====================================================================
    app.post('/api/va-portal/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required.' });
            }
            const account = await VaPortalAccount.findOne({ username: String(username).toLowerCase().trim() });
            const ok = account && account.active && await bcrypt.compare(password, account.passwordHash);
            if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
            // Pilots don't belong in the partnership portal — they sign in at the
            // Crew Center. Blocking them here keeps portal data owner/staff-only.
            if (account.role === 'pilot') {
                return res.status(403).json({ error: 'Pilots sign in through your VA’s crew center.' });
            }

            account.lastLoginAt = new Date();
            await account.save();
            setAuthCookie(res, signToken(account));
            logActivity({
                vaAdId: account.vaAdId, vaName: account.vaName,
                actorName: account.displayName || account.username, actorRole: account.role,
                action: 'login', detail: '',
            });
            res.json({ account: publicAccount(account) });
        } catch (err) {
            console.error('VA portal login error:', err);
            res.status(500).json({ error: 'Login failed.' });
        }
    });

    app.post('/api/va-portal/auth/logout', (req, res) => {
        clearAuthCookie(res);
        res.json({ ok: true });
    });

    app.get('/api/va-portal/auth/me', async (req, res) => {
        const account = await resolveAccount(req);
        if (!account) return res.status(401).json({ error: 'Not authenticated.' });
        res.json({ account: publicAccount(account), tos: tosState(account) });
    });

    app.post('/api/va-portal/auth/change-password', requirePortal, async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body || {};
            if (!currentPassword || !newPassword) {
                return res.status(400).json({ error: 'Current and new password are required.' });
            }
            if (String(newPassword).length < 8) {
                return res.status(400).json({ error: 'New password must be at least 8 characters.' });
            }
            const ok = await bcrypt.compare(currentPassword, req.portal.passwordHash);
            if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
            req.portal.passwordHash = await bcrypt.hash(newPassword, 12);
            req.portal.mustChangePassword = false;
            await req.portal.save();
            res.json({ ok: true });
        } catch (err) {
            console.error('VA portal change-password error:', err);
            res.status(500).json({ error: 'Could not change password.' });
        }
    });

    // =====================================================================
    // VA-FACING PROFILE  (the partner's own VA listing)
    // =====================================================================
    // The VA's profile (logo, banner, callsigns, copy, links) plus its
    // read-only embed link(s). Any signed-in account on the VA may view it.
    app.get('/api/va-portal/va', requirePortal, async (req, res) => {
        try {
            if (!req.portal.vaAdId) {
                return res.json({ va: null, embeds: [], editable: false });
            }
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('+flightEventsWebhookUrl');
            if (!ad) return res.json({ va: null, embeds: [], editable: false });
            const embeds = await embedLinksForVa(ad);
            res.json({ va: portalVa(ad), embeds, editable: req.portal.role === 'owner' });
        } catch (err) {
            console.error('VA portal get profile error:', err);
            res.status(500).json({ error: 'Could not load your VA profile.' });
        }
    });

    // Update the VA's own listing. Owner only. Accepts JSON or multipart (so a
    // fresh logo/banner can ride along). Moderation fields (status, featured),
    // the unique name, and ownership are intentionally NOT editable here.
    app.patch('/api/va-portal/va', requirePortalOwner, uploadVaProfileImages, async (req, res) => {
        const logoFile = req.files && req.files.logo && req.files.logo[0];
        const bannerFile = req.files && req.files.banner && req.files.banner[0];
        const fs = require('fs');
        const cleanup = () => [logoFile, bannerFile].forEach(f => { if (f && f.path) fs.unlink(f.path, () => {}); });
        try {
            if (!req.portal.vaAdId) { cleanup(); return res.status(404).json({ error: 'No VA is linked to this account.' }); }
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('+flightEventsWebhookUrl');
            if (!ad) { cleanup(); return res.status(404).json({ error: 'Your VA listing could not be found.' }); }

            const b = req.body || {};
            // Free-text + link fields.
            if (b.tagline !== undefined) ad.tagline = String(b.tagline).slice(0, 140);
            if (b.description !== undefined) ad.description = String(b.description).slice(0, 4000);
            if (b.region !== undefined) ad.region = String(b.region).trim() || 'Global';
            if (b.requirements !== undefined) ad.requirements = String(b.requirements);
            if (b.websiteUrl !== undefined) ad.websiteUrl = String(b.websiteUrl).trim() || null;
            // Discord invite is optional, and a bare "discord.gg/…" is accepted —
            // we add the scheme rather than bounce the save on a missing https://.
            if (b.discordUrl !== undefined) {
                const raw = String(b.discordUrl).trim();
                ad.discordUrl = raw ? (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) : null;
            }
            if (b.ifcThreadUrl !== undefined) ad.ifcThreadUrl = String(b.ifcThreadUrl).trim() || null;
            if (b.applicationUrl !== undefined) ad.applicationUrl = String(b.applicationUrl).trim() || null;
            // NOTE: flight-event delivery is intentionally NOT editable here — it
            // goes through the request → staff-approval flow (see the
            // /flight-events/request and /flight-events/toggle routes below).
            // List fields.
            if (b.callsigns !== undefined) ad.callsigns = parseList(b.callsigns); // pre-save normalises + syncs callsign
            if (b.hubs !== undefined) ad.hubs = parseList(b.hubs).map(h => h.toUpperCase());
            if (b.fleet !== undefined) ad.fleet = parseList(b.fleet);
            if (b.tags !== undefined) ad.tags = parseList(b.tags);
            // Numbers / flags.
            if (b.pilotCount !== undefined) ad.pilotCount = Math.max(0, parseInt(b.pilotCount, 10) || 0);
            if (b.minGrade !== undefined) ad.minGrade = b.minGrade ? Math.min(5, Math.max(1, parseInt(b.minGrade, 10))) : null;
            if (b.recruiting !== undefined) ad.recruiting = b.recruiting !== 'false' && b.recruiting !== false;

            // Optional new images (only if the helper was wired in).
            const ref = ad.callsign || ad.name;
            if (logoFile && uploadVaImage) {
                const url = await uploadVaImage(s3Client, logoFile, ref, 'logo');
                if (ad.logoUrl && deleteVaImage) await deleteVaImage(s3Client, ad.logoUrl);
                ad.logoUrl = url;
            }
            if (bannerFile && uploadVaImage) {
                const url = await uploadVaImage(s3Client, bannerFile, ref, 'banner');
                if (ad.bannerUrl && deleteVaImage) await deleteVaImage(s3Client, ad.bannerUrl);
                ad.bannerUrl = url;
            }

            // Keep the portal account's denormalized VA name in step (name is
            // not editable here, but this is cheap insurance).
            await ad.save();
            // Keep this VA's embeds in step with the head (e.g. a new logo).
            if (EmbedConfig) {
                EmbedConfig.updateMany(
                    { vaAdId: ad._id },
                    { $set: { 'va.name': ad.name || '', 'va.logo': ad.logoUrl || '', updatedAt: new Date() } },
                ).catch((e) => console.error('VA portal embed sync error:', e.message));
            }
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'va.update', detail: 'Updated VA profile',
            });
            const embeds = await embedLinksForVa(ad);
            res.json({ va: portalVa(ad), embeds, editable: true });
        } catch (err) {
            cleanup();
            console.error('VA portal update profile error:', err);
            // Surface a tagged image error (e.g. an oversized animated banner)
            // with its own message; otherwise a generic failure.
            if (err && err.status) return res.status(err.status).json({ error: err.message });
            res.status(500).json({ error: 'Could not save your VA profile.' });
        }
    });

    // =====================================================================
    // VA-FACING FEATURE REQUESTS  (flight events + embed — granted by staff)
    // =====================================================================
    // Request takeoff/landing notifications to the VA's OWN Discord webhook.
    // This does NOT switch delivery on: a staff member must approve the VA
    // (flightEventsApproved, set from the VA editor) before anything is sent. We
    // store the webhook to use, stamp the request, file it in the submissions
    // queue, and log it to Discord so staff are notified.
    app.post('/api/va-portal/flight-events/request', requirePortalOwner, async (req, res) => {
        try {
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('+flightEventsWebhookUrl');
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });

            const raw = String((req.body && req.body.flightEventsWebhookUrl) || '').trim();
            if (!raw) return res.status(400).json({ error: 'Paste the Discord webhook URL you want your flights posted to.' });
            if (typeof isDiscordWebhookUrl === 'function' && !isDiscordWebhookUrl(raw)) {
                return res.status(400).json({ error: 'That doesn’t look like a Discord webhook URL. It should look like https://discord.com/api/webhooks/…' });
            }

            ad.flightEventsWebhookUrl = raw;
            ad.flightEventsEnabled = true;
            ad.flightEventsRequestedAt = new Date();
            // Approval is staff-only; re-requesting never self-approves.
            await ad.save();

            await VaSubmission.create({
                vaAdId: ad._id, vaName: ad.name, accountId: req.portal._id,
                submittedByName: req.portal.displayName || req.portal.username,
                submittedByRole: req.portal.role,
                category: 'request',
                title: 'Flight event notifications',
                body: 'Requesting takeoff/landing notifications to the VA’s own Discord webhook. Approve from the VA editor (Flight events approved).',
            });
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'flight-events.request',
                detail: ad.flightEventsApproved ? 'Updated flight-event webhook (already approved)' : 'Requested flight-event notifications',
            });
            res.json({ va: portalVa(ad) });
        } catch (err) {
            console.error('VA portal flight-events request error:', err);
            res.status(500).json({ error: 'Could not submit your request.' });
        }
    });

    // Owner toggles their (already-approved) flight-event delivery on/off without
    // losing the saved webhook. No-op effect until staff have approved the VA.
    app.post('/api/va-portal/flight-events/toggle', requirePortalOwner, async (req, res) => {
        try {
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('+flightEventsWebhookUrl');
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });
            const on = req.body && (req.body.enabled === true || req.body.enabled === 'true');
            ad.flightEventsEnabled = on;
            await ad.save();
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'flight-events.toggle', detail: on ? 'Resumed flight-event delivery' : 'Paused flight-event delivery',
            });
            res.json({ va: portalVa(ad) });
        } catch (err) {
            console.error('VA portal flight-events toggle error:', err);
            res.status(500).json({ error: 'Could not update delivery.' });
        }
    });

    // Owner customizes the look of their flight-event card — accent colour,
    // layout (full card vs. compact embed), which detail fields to show, and
    // whether to include the aircraft photo / route map. The payload is fully
    // normalized before storing, so a malformed body can never break the card.
    // The Inflight brand mark stays on every card regardless (not customizable).
    app.post('/api/va-portal/flight-events/customize', requirePortalOwner, async (req, res) => {
        try {
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('+flightEventsWebhookUrl');
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });

            ad.flightEventsCard = normalizeCardOptions((req.body && req.body.card) || req.body || {});
            await ad.save();
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'flight-events.customize', detail: 'Updated flight-event card appearance',
            });
            res.json({ va: portalVa(ad) });
        } catch (err) {
            console.error('VA portal flight-events customize error:', err);
            res.status(500).json({ error: 'Could not save your card customization.' });
        }
    });

    // Live preview of the card for arbitrary (unsaved) options — renders only,
    // posts nothing. Lets an owner see how their customization looks before they
    // save or send a Discord test.
    app.post('/api/va-portal/flight-events/preview', requirePortalOwner, async (req, res) => {
        try {
            if (typeof renderCardPreview !== 'function') {
                return res.status(500).json({ error: 'Preview is unavailable right now.' });
            }
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('name callsign callsigns logoUrl').lean();
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });
            const preview = await renderCardPreview(ad, (req.body && req.body.card) || req.body || {});
            res.json(preview);
        } catch (err) {
            console.error('VA portal flight-events preview error:', err);
            res.status(500).json({ error: 'Could not render a preview.' });
        }
    });

    // Owner sends a sample takeoff card to their own saved webhook, so they can
    // confirm delivery works (and see the card) without waiting for a real flight.
    // Posts via the same renderer/path as live events, so a failure here surfaces
    // the exact problem a real flight would hit.
    app.post('/api/va-portal/flight-events/test', requirePortalOwner, async (req, res) => {
        try {
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId)
                .select('+flightEventsWebhookUrl name callsign callsigns logoUrl flightEventsCard');
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });
            if (!ad.flightEventsWebhookUrl) return res.status(400).json({ error: 'Save a webhook first, then send a test.' });
            if (typeof isDiscordWebhookUrl === 'function' && !isDiscordWebhookUrl(ad.flightEventsWebhookUrl)) {
                return res.status(400).json({ error: 'The saved webhook is not a valid Discord webhook URL.' });
            }
            if (typeof sendVaTestEvent !== 'function') {
                return res.status(500).json({ error: 'Test delivery is unavailable right now.' });
            }
            await sendVaTestEvent(ad);
            res.json({ message: 'Test event sent — check your Discord channel.' });
        } catch (err) {
            const status = err.response && err.response.status;
            console.error('VA portal flight-events test error:', status || '', err.message);
            res.status(502).json({
                error: status
                    ? `Discord rejected the webhook (HTTP ${status}). The URL may be wrong, revoked or deleted.`
                    : 'Could not reach the webhook URL.',
            });
        }
    });

    // --- Pilot roster (owner self-service) ----------------------------------
    // A VA owner manages their own list of Infinite Flight usernames. Same shared
    // helpers + VaPilot collection the staff API uses, always scoped to THIS
    // account's VA so an owner can only ever touch their own roster. Guarded so a
    // clear "roster is unavailable" beats a crash if the model wasn't wired in.
    const rosterReady = (res) => {
        if (!VaPilot) { res.status(500).json({ error: 'The pilot roster is unavailable right now.' }); return false; }
        return true;
    };

    // GET: list the owner's roster (optional ?q= search + ?limit=/?skip= paging).
    app.get('/api/va-portal/pilots', requirePortal, async (req, res) => {
        try {
            if (!rosterReady(res)) return;
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const out = await vaPilots.listPilots(VaPilot, req.portal.vaAdId, {
                q: req.query.q, limit: req.query.limit, skip: req.query.skip,
            });
            res.json(out);
        } catch (err) {
            console.error('VA portal pilots list error:', err);
            res.status(500).json({ error: 'Could not load your pilot roster.' });
        }
    });

    // POST: add one or many usernames. Owner-only (managing the roster is an
    // ownership action, like editing the profile). Body: { usernames }.
    app.post('/api/va-portal/pilots', requirePortalOwner, async (req, res) => {
        try {
            if (!rosterReady(res)) return;
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('name').lean();
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });
            const input = (req.body && (req.body.usernames !== undefined ? req.body.usernames : req.body.username));
            const who = req.portal.displayName || req.portal.username;
            const out = await vaPilots.addPilots(VaPilot, req.portal.vaAdId, input, who);
            logActivity({
                vaAdId: ad._id, vaName: ad.name, actorName: who, actorRole: req.portal.role,
                action: 'pilots.add', detail: `Added ${out.added} pilot${out.added === 1 ? '' : 's'} (skipped ${out.skipped})`,
            });
            res.json({ message: `Added ${out.added}, skipped ${out.skipped} duplicate${out.skipped === 1 ? '' : 's'}.`, ...out });
        } catch (err) {
            console.error('VA portal pilots add error:', err);
            res.status(500).json({ error: 'Could not add pilots.' });
        }
    });

    // DELETE: remove one roster entry by id (owner-only).
    app.delete('/api/va-portal/pilots/:pilotId', requirePortalOwner, async (req, res) => {
        try {
            if (!rosterReady(res)) return;
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const out = await vaPilots.removePilot(VaPilot, req.portal.vaAdId, req.params.pilotId);
            res.json({ message: out.removed ? 'Pilot removed.' : 'Pilot not found.', ...out });
        } catch (err) {
            console.error('VA portal pilots remove error:', err);
            res.status(500).json({ error: 'Could not remove the pilot.' });
        }
    });

    // DELETE: clear the whole roster (owner-only).
    app.delete('/api/va-portal/pilots', requirePortalOwner, async (req, res) => {
        try {
            if (!rosterReady(res)) return;
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('name').lean();
            const out = await vaPilots.clearPilots(VaPilot, req.portal.vaAdId);
            if (ad) logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: req.portal.role,
                action: 'pilots.clear', detail: `Cleared ${out.removed} pilot${out.removed === 1 ? '' : 's'}`,
            });
            res.json({ message: `Cleared ${out.removed} pilot${out.removed === 1 ? '' : 's'}.`, ...out, total: 0 });
        } catch (err) {
            console.error('VA portal pilots clear error:', err);
            res.status(500).json({ error: 'Could not clear the roster.' });
        }
    });

    // Request a live-map embed. Embeds are provisioned by staff (copy-only on the
    // VA side), so this just files the request + logs it; no schema change.
    app.post('/api/va-portal/embed/request', requirePortalOwner, async (req, res) => {
        try {
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId).select('name');
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });
            const note = String((req.body && req.body.note) || '').slice(0, 2000);
            await VaSubmission.create({
                vaAdId: ad._id, vaName: ad.name, accountId: req.portal._id,
                submittedByName: req.portal.displayName || req.portal.username,
                submittedByRole: req.portal.role,
                category: 'request',
                title: 'Live map embed',
                body: note || 'Requesting a live-map embed for the VA.',
            });
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'embed.request', detail: 'Requested a live-map embed',
            });
            res.json({ ok: true });
        } catch (err) {
            console.error('VA portal embed request error:', err);
            res.status(500).json({ error: 'Could not submit your request.' });
        }
    });

    // PATCH an embed's appearance — owner only. The VA can restyle its widget on
    // demand (theme, header, accent/gradient, corner radius, map-card colours);
    // the change is written to the shared EmbedConfig, so every place the embed
    // is deployed (and this portal's preview) picks it up on next load. Scoped
    // hard: the target embed's va.code must be one of THIS VA's callsigns, so an
    // owner can never touch another VA's embed by guessing an id.
    app.patch('/api/va-portal/embeds/:id', requirePortalOwner, async (req, res) => {
        try {
            if (!EmbedConfig || typeof applyEmbedAppearance !== 'function') {
                return res.status(500).json({ error: 'Embed editing is unavailable right now.' });
            }
            if (!req.portal.vaAdId) return res.status(404).json({ error: 'No VA is linked to this account.' });
            const ad = await VirtualAirlineAd.findById(req.portal.vaAdId);
            if (!ad) return res.status(404).json({ error: 'Your VA listing could not be found.' });

            const codes = vaCallsignCodes(ad);
            let cfg = null;
            if (mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) {
                cfg = await EmbedConfig.findById(req.params.id);
            }
            if (!cfg || !codes.includes(String((cfg.va && cfg.va.code) || '').toUpperCase())) {
                return res.status(404).json({ error: 'That embed was not found for your VA.' });
            }

            applyEmbedAppearance(cfg, req.body || {});
            await cfg.save();
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.portal.displayName || req.portal.username, actorRole: req.portal.role,
                action: 'embed.style', detail: `Updated appearance of embed “${cfg.label || (cfg.va && cfg.va.name) || ad.name}”`,
            });
            res.json({ ok: true, embed: serializeEmbed(cfg, ad) });
        } catch (err) {
            console.error('VA portal embed update error:', err);
            res.status(500).json({ error: 'Could not update the embed.' });
        }
    });

    // =====================================================================
    // VA-FACING SUBMISSIONS
    // =====================================================================
    // List this VA's submissions (both owner and staff see the whole VA inbox).
    app.get('/api/va-portal/submissions', requirePortal, async (req, res) => {
        try {
            const subs = await VaSubmission.find({ vaAdId: req.portal.vaAdId })
                .sort({ createdAt: -1 }).limit(200);
            res.json({ submissions: subs.map(publicSubmission) });
        } catch (err) {
            console.error('VA portal list submissions error:', err);
            res.status(500).json({ error: 'Could not load submissions.' });
        }
    });

    app.get('/api/va-portal/submissions/:id', requirePortal, async (req, res) => {
        try {
            const sub = await VaSubmission.findById(req.params.id);
            if (!sub || String(sub.vaAdId) !== String(req.portal.vaAdId)) {
                return res.status(404).json({ error: 'Submission not found.' });
            }
            res.json({ submission: publicSubmission(sub) });
        } catch (err) {
            res.status(500).json({ error: 'Could not load submission.' });
        }
    });

    // Create a submission. multipart/form-data so files can ride along.
    app.post('/api/va-portal/submissions', requirePortal, upload.array('attachments', 8), async (req, res) => {
        try {
            const { title, body, category } = req.body || {};
            if (!title || !String(title).trim()) {
                return res.status(400).json({ error: 'A title is required.' });
            }
            // links may arrive as a JSON array, newline list, or repeated field.
            let links = [];
            const rawLinks = req.body.links;
            if (Array.isArray(rawLinks)) links = rawLinks;
            else if (typeof rawLinks === 'string' && rawLinks.trim()) {
                try { const parsed = JSON.parse(rawLinks); links = Array.isArray(parsed) ? parsed : [rawLinks]; }
                catch { links = rawLinks.split(/[\n,]+/); }
            }
            links = links.map(s => String(s).trim()).filter(Boolean).slice(0, 20);

            // Upload any attached files.
            let attachments = [];
            if (req.files && req.files.length) {
                attachments = await Promise.all(req.files.map(f => uploadSubmissionFile(s3Client, f)));
            }

            const cat = SUBMISSION_CATEGORIES.includes(category) ? category : 'other';
            const sub = await VaSubmission.create({
                vaAdId: req.portal.vaAdId,
                vaName: req.portal.vaName,
                accountId: req.portal._id,
                submittedByName: req.portal.displayName || req.portal.username,
                submittedByRole: req.portal.role,
                category: cat,
                title: String(title).trim().slice(0, 200),
                body: String(body || '').slice(0, 8000),
                links,
                attachments,
            });
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: req.portal.role,
                action: 'submission.create', detail: `${cat}: ${sub.title}`,
            });
            res.status(201).json({ submission: publicSubmission(sub) });
        } catch (err) {
            console.error('VA portal create submission error:', err);
            res.status(500).json({ error: 'Could not save your submission.' });
        }
    });

    // =====================================================================
    // VA-FACING EVENTS
    // =====================================================================
    // Upcoming events for this VA (anything not older than 12h ago).
    app.get('/api/va-portal/events', requirePortal, async (req, res) => {
        try {
            const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
            const events = await VaEvent.find({ vaAdId: req.portal.vaAdId, startsAt: { $gte: since } })
                .sort({ startsAt: 1 }).limit(MAX_EVENTS_PER_VA);
            res.json({ events: events.map(publicEvent) });
        } catch (err) {
            console.error('VA portal list events error:', err);
            res.status(500).json({ error: 'Could not load events.' });
        }
    });

    // Accepts JSON or multipart (so an optional banner image can ride along).
    app.post('/api/va-portal/events', requirePortal, uploadEventBanner, async (req, res) => {
        const fs = require('fs');
        const bannerFile = req.file;
        const cleanup = () => { if (bannerFile && bannerFile.path) fs.unlink(bannerFile.path, () => {}); };
        try {
            const { title, description, link, startsAt } = req.body || {};
            if (!title || !String(title).trim()) { cleanup(); return res.status(400).json({ error: 'A title is required.' }); }
            const when = new Date(startsAt);
            if (isNaN(when.getTime())) { cleanup(); return res.status(400).json({ error: 'A valid date & time is required.' }); }

            let departureIcao;
            try { departureIcao = normalizeIcao(req.body && req.body.departureIcao); }
            catch (e) { cleanup(); return res.status(e.status || 400).json({ error: e.message }); }

            // Soft cap so a VA can't balloon the (tiny) collection.
            const upcoming = await VaEvent.countDocuments({
                vaAdId: req.portal.vaAdId, startsAt: { $gte: new Date() },
            });
            if (upcoming >= MAX_EVENTS_PER_VA) {
                cleanup();
                return res.status(400).json({ error: `You can have at most ${MAX_EVENTS_PER_VA} upcoming events.` });
            }

            // Optional hero banner → S3 (only if the helper was wired in).
            let bannerUrl = '';
            if (bannerFile && uploadVaImage) {
                bannerUrl = await uploadVaImage(s3Client, bannerFile, req.portal.vaName || 'va', 'event');
            } else {
                cleanup();
            }

            const event = await VaEvent.create({
                vaAdId: req.portal.vaAdId,
                vaName: req.portal.vaName,
                createdByName: req.portal.displayName || req.portal.username,
                title: String(title).trim().slice(0, 120),
                description: String(description || '').slice(0, 1000),
                link: String(link || '').trim().slice(0, 300),
                departureIcao,
                bannerUrl,
                startsAt: when,
            });
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: req.portal.role,
                action: 'event.create', detail: `${event.title} @ ${when.toISOString()}`,
            });
            res.status(201).json({ event: publicEvent(event) });
        } catch (err) {
            cleanup();
            console.error('VA portal create event error:', err);
            // Surface a tagged image error (e.g. an oversized animated banner).
            if (err && err.status) return res.status(err.status).json({ error: err.message });
            res.status(500).json({ error: 'Could not save the event.' });
        }
    });

    app.delete('/api/va-portal/events/:id', requirePortal, async (req, res) => {
        try {
            const event = await VaEvent.findById(req.params.id);
            if (!event || String(event.vaAdId) !== String(req.portal.vaAdId)) {
                return res.status(404).json({ error: 'Event not found.' });
            }
            // Best-effort: drop the event's banner from S3 so images don't leak.
            if (event.bannerUrl && deleteVaImage) {
                await deleteVaImage(s3Client, event.bannerUrl).catch(() => {});
            }
            await event.deleteOne();
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: req.portal.role,
                action: 'event.delete', detail: event.title,
            });
            res.json({ ok: true });
        } catch (err) {
            console.error('VA portal delete event error:', err);
            res.status(500).json({ error: 'Could not delete the event.' });
        }
    });

    // =====================================================================
    // VA-FACING COMPLIANCE: TERMS + WARNINGS
    // =====================================================================
    // Current Terms state + this account's acknowledgement, plus the warning
    // ladder definition (so the portal can render level meanings).
    app.get('/api/va-portal/tos', requirePortal, async (req, res) => {
        res.json({ tos: tosState(req.portal), levels: warningLevelsPublic() });
    });

    // Acknowledge the current Terms version. Records it against the account so
    // the "Terms updated" banner clears. Any account on the VA may acknowledge.
    app.post('/api/va-portal/tos/acknowledge', requirePortal, async (req, res) => {
        try {
            req.portal.tosAckVersion = TOS_VERSION;
            req.portal.tosAckAt = new Date();
            await req.portal.save();
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: req.portal.role,
                action: 'tos.acknowledge', detail: `Acknowledged Terms ${TOS_VERSION}`,
            });
            res.json({ ok: true, tos: tosState(req.portal) });
        } catch (err) {
            console.error('VA portal tos ack error:', err);
            res.status(500).json({ error: 'Could not record your acknowledgement.' });
        }
    });

    // The VA's own warnings (active + history), newest first, plus a compact
    // "standing" summary the portal renders at a glance.
    app.get('/api/va-portal/warnings', requirePortal, async (req, res) => {
        try {
            if (!req.portal.vaAdId) return res.json({ warnings: [], standing: null, levels: warningLevelsPublic() });
            const warnings = await VaWarning.find({ vaAdId: req.portal.vaAdId }).sort({ createdAt: -1 }).limit(200);
            const active = warnings.filter(w => w.status === 'active');
            const terminated = active.some(w => w.level === 'termination');
            // Highest active escalation stage drives the standing badge.
            let peak = null;
            for (const w of active) {
                const lvl = getWarningLevel(w.level);
                if (lvl && (!peak || lvl.order > peak.order)) peak = lvl;
            }
            res.json({
                warnings: warnings.map(publicWarning),
                levels: warningLevelsPublic(),
                standing: {
                    activeCount: active.length,
                    unacknowledged: active.filter(w => !w.acknowledgedAt).length,
                    terminated,
                    peakLevel: peak ? peak.key : null,
                    peakLabel: peak ? peak.label : null,
                    peakPalette: peak ? peak.palette : null,
                },
            });
        } catch (err) {
            console.error('VA portal warnings error:', err);
            res.status(500).json({ error: 'Could not load your warnings.' });
        }
    });

    // Acknowledge receipt of a warning (not agreement). Any account on the VA.
    app.post('/api/va-portal/warnings/:id/acknowledge', requirePortal, async (req, res) => {
        try {
            const w = await VaWarning.findById(req.params.id);
            if (!w || String(w.vaAdId) !== String(req.portal.vaAdId)) {
                return res.status(404).json({ error: 'Warning not found.' });
            }
            if (!w.acknowledgedAt) {
                w.acknowledgedAt = new Date();
                w.acknowledgedByName = req.portal.displayName || req.portal.username;
                await w.save();
                logActivity({
                    vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                    actorName: w.acknowledgedByName, actorRole: req.portal.role,
                    action: 'warning.acknowledge', detail: `${(getWarningLevel(w.level) || {}).label || w.level} acknowledged`,
                });
            }
            res.json({ ok: true, warning: publicWarning(w) });
        } catch (err) {
            console.error('VA portal warning ack error:', err);
            res.status(500).json({ error: 'Could not acknowledge the warning.' });
        }
    });

    // =====================================================================
    // VA-FACING TEAM MANAGEMENT (owner only)
    // =====================================================================
    app.get('/api/va-portal/team', requirePortal, async (req, res) => {
        const team = await VaPortalAccount.find({ vaAdId: req.portal.vaAdId }).sort({ createdAt: 1 });
        res.json({ team: team.map(publicAccount) });
    });

    app.post('/api/va-portal/team', requirePortalOwner, async (req, res) => {
        try {
            const { username, password, displayName } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required.' });
            }
            if (String(password).length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            }
            // Owners can mint their own team: a fellow 'staff' admin or a 'pilot'
            // crew login. Never another owner.
            const role = ['staff', 'pilot'].includes(String(req.body.role || '').toLowerCase())
                ? String(req.body.role).toLowerCase()
                : 'staff';
            const uname = String(username).toLowerCase().trim();
            if (await VaPortalAccount.exists({ username: uname })) {
                return res.status(409).json({ error: 'That username is already taken.' });
            }
            const passwordHash = await bcrypt.hash(password, 12);
            const account = await VaPortalAccount.create({
                username: uname,
                displayName: displayName || username,
                passwordHash,
                role,
                vaAdId: req.portal.vaAdId,
                vaName: req.portal.vaName,
                createdVia: 'owner',
                createdByName: req.portal.displayName || req.portal.username,
                active: true,
            });
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'team.create', detail: `Added @${uname}`,
            });
            res.status(201).json({ account: publicAccount(account) });
        } catch (err) {
            console.error('VA portal team create error:', err);
            res.status(500).json({ error: 'Could not create the account.' });
        }
    });

    app.patch('/api/va-portal/team/:id', requirePortalOwner, async (req, res) => {
        try {
            const account = await VaPortalAccount.findById(req.params.id);
            if (!account || String(account.vaAdId) !== String(req.portal.vaAdId)) {
                return res.status(404).json({ error: 'Team member not found.' });
            }
            if (account.role === 'owner') {
                return res.status(400).json({ error: 'The owner account cannot be edited here.' });
            }
            const { active, displayName, password } = req.body || {};
            if (typeof active === 'boolean') account.active = active;
            if (typeof displayName === 'string') account.displayName = displayName;
            if (password) {
                if (String(password).length < 8) {
                    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
                }
                account.passwordHash = await bcrypt.hash(password, 12);
                account.mustChangePassword = false;
            }
            await account.save();
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'team.update', detail: `Updated @${account.username}`,
            });
            res.json({ account: publicAccount(account) });
        } catch (err) {
            console.error('VA portal team update error:', err);
            res.status(500).json({ error: 'Could not update the account.' });
        }
    });

    app.delete('/api/va-portal/team/:id', requirePortalOwner, async (req, res) => {
        try {
            const account = await VaPortalAccount.findById(req.params.id);
            if (!account || String(account.vaAdId) !== String(req.portal.vaAdId)) {
                return res.status(404).json({ error: 'Team member not found.' });
            }
            if (account.role === 'owner') {
                return res.status(400).json({ error: 'The owner account cannot be removed.' });
            }
            await account.deleteOne();
            logActivity({
                vaAdId: req.portal.vaAdId, vaName: req.portal.vaName,
                actorName: req.portal.displayName || req.portal.username, actorRole: 'owner',
                action: 'team.delete', detail: `Removed @${account.username}`,
            });
            res.json({ ok: true });
        } catch (err) {
            console.error('VA portal team delete error:', err);
            res.status(500).json({ error: 'Could not remove the account.' });
        }
    });

    // =====================================================================
    // INFLIGHT-SIDE OVERSIGHT (admin / staff / va_rep)
    // =====================================================================
    // VAs available to provision a portal account for, plus whether one exists.
    app.get('/api/va-portal/admin/vas', requireOversight, async (req, res) => {
        try {
            const ads = await VirtualAirlineAd.find({}, 'name callsign status logoUrl ownerName')
                .sort({ name: 1 }).limit(1000);
            const owned = await VaPortalAccount.find({ role: 'owner' }, 'vaAdId');
            const ownedSet = new Set(owned.map(o => String(o.vaAdId)));
            res.json({
                vas: ads.map(a => ({
                    id: a._id, name: a.name, callsign: a.callsign, status: a.status,
                    logoUrl: a.logoUrl, ownerName: a.ownerName,
                    hasPortal: ownedSet.has(String(a._id)),
                })),
            });
        } catch (err) {
            console.error('VA portal admin vas error:', err);
            res.status(500).json({ error: 'Could not load VAs.' });
        }
    });

    // All portal accounts (optionally filtered by VA).
    app.get('/api/va-portal/admin/accounts', requireOversight, async (req, res) => {
        const filter = {};
        if (req.query.vaAdId) filter.vaAdId = req.query.vaAdId;
        const accounts = await VaPortalAccount.find(filter).sort({ vaName: 1, role: 1, createdAt: 1 });
        res.json({ accounts: accounts.map(publicAccount) });
    });

    // Manually create a portal account for any VA. If no password is provided we
    // generate one and return it so staff can pass it on.
    app.post('/api/va-portal/admin/accounts', requireOversight, async (req, res) => {
        try {
            const { vaAdId, username, password, displayName, role } = req.body || {};
            if (!vaAdId) return res.status(400).json({ error: 'A VA must be selected.' });
            const ad = await VirtualAirlineAd.findById(vaAdId).catch(() => null);
            if (!ad) return res.status(404).json({ error: 'That VA does not exist.' });

            const wantRole = PORTAL_ROLES.includes(role) ? role : 'owner';
            if (wantRole === 'owner' && await VaPortalAccount.exists({ vaAdId: ad._id, role: 'owner' })) {
                return res.status(409).json({ error: 'This VA already has an owner account.' });
            }

            const uname = username
                ? String(username).toLowerCase().trim()
                : await uniqueUsernameFrom(ad.name);
            if (await VaPortalAccount.exists({ username: uname })) {
                return res.status(409).json({ error: 'That username is already taken.' });
            }

            let plainPassword = password;
            let generated = false;
            if (!plainPassword) { plainPassword = generatePassword(); generated = true; }
            else if (String(plainPassword).length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            }
            const passwordHash = await bcrypt.hash(plainPassword, 12);
            const account = await VaPortalAccount.create({
                username: uname,
                displayName: displayName || ad.ownerName || ad.name,
                passwordHash,
                role: wantRole,
                vaAdId: ad._id,
                vaName: ad.name,
                createdVia: 'staff',
                createdByName: req.staff.displayName || req.staff.username,
                mustChangePassword: generated,
                active: true,
            });
            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: req.staff.displayName || req.staff.username, actorRole: 'inflight-staff',
                action: 'account.create', detail: `Created ${wantRole} @${uname}`,
            });
            // Return the plaintext password ONLY when we generated it.
            res.status(201).json({ account: publicAccount(account), password: generated ? plainPassword : null });
        } catch (err) {
            console.error('VA portal admin create account error:', err);
            res.status(500).json({ error: 'Could not create the account.' });
        }
    });

    app.patch('/api/va-portal/admin/accounts/:id', requireOversight, async (req, res) => {
        try {
            const account = await VaPortalAccount.findById(req.params.id);
            if (!account) return res.status(404).json({ error: 'Account not found.' });
            const { active, displayName, password, role } = req.body || {};
            if (typeof active === 'boolean') account.active = active;
            if (typeof displayName === 'string') account.displayName = displayName;
            if (PORTAL_ROLES.includes(role)) account.role = role;
            if (password) {
                if (String(password).length < 8) {
                    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
                }
                account.passwordHash = await bcrypt.hash(password, 12);
                account.mustChangePassword = false;
            }
            await account.save();
            logActivity({
                vaAdId: account.vaAdId, vaName: account.vaName,
                actorName: req.staff.displayName || req.staff.username, actorRole: 'inflight-staff',
                action: 'account.update', detail: `Updated @${account.username}`,
            });
            res.json({ account: publicAccount(account) });
        } catch (err) {
            console.error('VA portal admin update account error:', err);
            res.status(500).json({ error: 'Could not update the account.' });
        }
    });

    app.delete('/api/va-portal/admin/accounts/:id', requireOversight, async (req, res) => {
        try {
            const account = await VaPortalAccount.findById(req.params.id);
            if (!account) return res.status(404).json({ error: 'Account not found.' });
            await account.deleteOne();
            logActivity({
                vaAdId: account.vaAdId, vaName: account.vaName,
                actorName: req.staff.displayName || req.staff.username, actorRole: 'inflight-staff',
                action: 'account.delete', detail: `Deleted @${account.username}`,
            });
            res.json({ ok: true });
        } catch (err) {
            console.error('VA portal admin delete account error:', err);
            res.status(500).json({ error: 'Could not delete the account.' });
        }
    });

    // All submissions across every VA (with optional filters).
    app.get('/api/va-portal/admin/submissions', requireOversight, async (req, res) => {
        try {
            const filter = {};
            if (req.query.vaAdId) filter.vaAdId = req.query.vaAdId;
            if (SUBMISSION_STATUSES.includes(req.query.status)) filter.status = req.query.status;
            if (SUBMISSION_CATEGORIES.includes(req.query.category)) filter.category = req.query.category;
            const subs = await VaSubmission.find(filter).sort({ createdAt: -1 }).limit(500);
            res.json({ submissions: subs.map(adminSubmission) });
        } catch (err) {
            console.error('VA portal admin list submissions error:', err);
            res.status(500).json({ error: 'Could not load submissions.' });
        }
    });

    app.get('/api/va-portal/admin/submissions/:id', requireOversight, async (req, res) => {
        const sub = await VaSubmission.findById(req.params.id).catch(() => null);
        if (!sub) return res.status(404).json({ error: 'Submission not found.' });
        res.json({ submission: adminSubmission(sub) });
    });

    // Triage a submission (status + internal notes).
    app.patch('/api/va-portal/admin/submissions/:id', requireOversight, async (req, res) => {
        try {
            const sub = await VaSubmission.findById(req.params.id);
            if (!sub) return res.status(404).json({ error: 'Submission not found.' });
            const { status, staffNotes } = req.body || {};
            if (SUBMISSION_STATUSES.includes(status)) sub.status = status;
            if (typeof staffNotes === 'string') sub.staffNotes = staffNotes.slice(0, 4000);
            await sub.save();
            res.json({ submission: adminSubmission(sub) });
        } catch (err) {
            console.error('VA portal admin update submission error:', err);
            res.status(500).json({ error: 'Could not update the submission.' });
        }
    });

    // Upcoming events across every VA (optionally filtered by VA).
    app.get('/api/va-portal/admin/events', requireOversight, async (req, res) => {
        try {
            const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
            const filter = { startsAt: { $gte: since } };
            if (req.query.vaAdId) filter.vaAdId = req.query.vaAdId;
            const events = await VaEvent.find(filter).sort({ startsAt: 1 }).limit(500);
            res.json({ events: events.map(publicEvent) });
        } catch (err) {
            console.error('VA portal admin events error:', err);
            res.status(500).json({ error: 'Could not load events.' });
        }
    });

    // Recent portal activity feed ("see whatever they do").
    app.get('/api/va-portal/admin/activity', requireOversight, async (req, res) => {
        const filter = {};
        if (req.query.vaAdId) filter.vaAdId = req.query.vaAdId;
        const items = await VaPortalActivity.find(filter).sort({ createdAt: -1 }).limit(200);
        res.json({
            activity: items.map(a => ({
                id: a._id, vaName: a.vaName, actorName: a.actorName, actorRole: a.actorRole,
                action: a.action, detail: a.detail, createdAt: a.createdAt,
            })),
        });
    });

    // =====================================================================
    // STAFF OVERSIGHT: TERMS ENFORCEMENT (WARNINGS) + TERMS ANNOUNCE
    // =====================================================================
    // Warnings across all VAs, or filtered to one. Newest first.
    app.get('/api/va-portal/admin/warnings', requireOversight, async (req, res) => {
        try {
            const filter = {};
            if (req.query.vaAdId) filter.vaAdId = req.query.vaAdId;
            if (req.query.status && ['active', 'rescinded'].includes(req.query.status)) filter.status = req.query.status;
            const warnings = await VaWarning.find(filter).sort({ createdAt: -1 }).limit(500);
            res.json({ warnings: warnings.map(publicWarning), levels: warningLevelsPublic() });
        } catch (err) {
            console.error('VA portal admin warnings error:', err);
            res.status(500).json({ error: 'Could not load warnings.' });
        }
    });

    // Issue a warning to a VA. Records it, delivers it to the VA's Discord
    // channel, and logs it. `level` must be one of the enforcement-ladder keys.
    app.post('/api/va-portal/admin/warnings', requireOversight, async (req, res) => {
        try {
            const { vaAdId, level, reason } = req.body || {};
            if (!vaAdId || !level || !String(reason || '').trim()) {
                return res.status(400).json({ error: 'A VA, a level, and a reason are all required.' });
            }
            if (!WARNING_LEVEL_KEYS.includes(level)) {
                return res.status(400).json({ error: 'Unknown warning level.' });
            }
            const ad = await VirtualAirlineAd.findById(vaAdId);
            if (!ad) return res.status(404).json({ error: 'VA not found.' });

            const issuedByName = (req.staff && (req.staff.displayName || req.staff.username || req.staff.name)) || 'Inflight staff';
            const warning = await VaWarning.create({
                vaAdId: ad._id,
                vaName: ad.name,
                level,
                reason: String(reason).trim().slice(0, 4000),
                termsVersion: TOS_VERSION,
                issuedByName,
                issuedByRole: (req.staff && req.staff.role) || 'staff',
            });

            // Deliver to the VA's Discord channel (their thread) — best-effort.
            const channelId = deliverWarningToDiscord(ad, warning);
            if (channelId) {
                warning.discordDelivered = true;
                warning.discordChannelId = channelId;
                await warning.save();
            }

            logActivity({
                vaAdId: ad._id, vaName: ad.name,
                actorName: issuedByName, actorRole: 'inflight-staff',
                action: 'warning.issue',
                detail: `${(getWarningLevel(level) || {}).label || level} issued${channelId ? ' (delivered to Discord)' : ''}: ${String(reason).slice(0, 200)}`,
            });

            res.status(201).json({ warning: publicWarning(warning), deliveredToDiscord: !!channelId });
        } catch (err) {
            console.error('VA portal issue warning error:', err);
            res.status(500).json({ error: 'Could not issue the warning.' });
        }
    });

    // Rescind a warning (issued in error / resolved). Kept for the audit trail.
    app.patch('/api/va-portal/admin/warnings/:id', requireOversight, async (req, res) => {
        try {
            const w = await VaWarning.findById(req.params.id);
            if (!w) return res.status(404).json({ error: 'Warning not found.' });
            const { status, rescindReason } = req.body || {};
            if (status && !['active', 'rescinded'].includes(status)) {
                return res.status(400).json({ error: 'Invalid status.' });
            }
            const staffName = (req.staff && (req.staff.displayName || req.staff.username || req.staff.name)) || 'Inflight staff';
            if (status === 'rescinded' && w.status !== 'rescinded') {
                w.status = 'rescinded';
                w.rescindedByName = staffName;
                w.rescindedAt = new Date();
                w.rescindReason = String(rescindReason || '').slice(0, 1000);
            } else if (status === 'active' && w.status !== 'active') {
                w.status = 'active';
                w.rescindedByName = '';
                w.rescindedAt = null;
                w.rescindReason = '';
            }
            await w.save();
            logActivity({
                vaAdId: w.vaAdId, vaName: w.vaName,
                actorName: staffName, actorRole: 'inflight-staff',
                action: 'warning.update', detail: `${(getWarningLevel(w.level) || {}).label || w.level} → ${w.status}`,
            });
            res.json({ warning: publicWarning(w) });
        } catch (err) {
            console.error('VA portal update warning error:', err);
            res.status(500).json({ error: 'Could not update the warning.' });
        }
    });

    // Current Terms metadata for the staff console (version, date, level defs).
    app.get('/api/va-portal/admin/tos', requireOversight, async (req, res) => {
        res.json({ tos: tosState(null), levels: warningLevelsPublic() });
    });

    // Broadcast a "Terms updated" notice to every VA's Discord channel. The
    // portal banner already nudges partners; this reaches them in Discord too.
    app.post('/api/va-portal/admin/tos/announce', requireOversight, async (req, res) => {
        try {
            const result = await announceTosUpdateToDiscord(VirtualAirlineAd);
            const staffName = (req.staff && (req.staff.displayName || req.staff.username || req.staff.name)) || 'Inflight staff';
            logActivity({
                actorName: staffName, actorRole: 'inflight-staff',
                action: 'tos.announce', detail: `Announced Terms ${TOS_VERSION} to ${result.attempted} VA channel(s)`,
            });
            res.json({ ok: true, ...result, version: TOS_VERSION });
        } catch (err) {
            console.error('VA portal tos announce error:', err);
            res.status(500).json({ error: 'Could not announce the Terms update.' });
        }
    });
}

module.exports = {
    VaPortalAccount,
    VaSubmission,
    VaEvent,
    VaPortalActivity,
    VaWarning,
    registerVaPortalRoutes,
    provisionOwnerAccount,
    provisionRepAccount,
    deactivateRepAccount,
    purgeVaData,
    requirePortalPage,
    // The portal API guard, exported so modules registering their own
    // partner-facing routes (e.g. vaStats) gate them on the same session
    // instead of re-implementing the cookie/JWT check.
    requirePortal,
    SUBMISSION_CATEGORIES,
    SUBMISSION_STATUSES,
};

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

const COOKIE_NAME = 'va_portal_token';
const TOKEN_TYPE = 'va_portal';            // distinguishes these tokens from staff tokens
const TOKEN_TTL = '30d';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Portal account roles (scoped to a single VA — NOT the staff roles).
//   owner - the VA partner who owns the listing. Can submit, and can create /
//           manage their own staff sub-accounts.
//   staff - a member of the VA's team. Can submit and view their VA's inbox, but
//           cannot manage accounts.
const PORTAL_ROLES = ['owner', 'staff'];

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

    active: { type: Boolean, default: true },
    // How the account came to exist, for the oversight UI: 'bot' (auto on
    // approval), 'staff' (created manually), or 'owner' (a VA invited a teammate).
    createdVia: { type: String, enum: ['bot', 'staff', 'owner'], default: 'staff' },
    createdByName: { type: String, default: '' },
    // Set when we generate a password for the account holder; the portal nudges
    // them to set their own on first login.
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
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
function logActivity({ vaAdId, vaName, actorName, actorRole, action, detail }) {
    VaPortalActivity.create({
        vaAdId: vaAdId || null,
        vaName: vaName || '',
        actorName: actorName || '',
        actorRole: actorRole || '',
        action: action || '',
        detail: detail || '',
    }).catch(err => console.error('VA portal activity log error:', err.message));
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
    };
}

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
 * @param {Object} deps.s3Client          AWS S3 client (for attachments)
 * @param {Object} deps.upload            configured multer instance
 */
function registerVaPortalRoutes(app, { VirtualAirlineAd, s3Client, upload }) {
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
        res.json({ account: publicAccount(account) });
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
            const uname = String(username).toLowerCase().trim();
            if (await VaPortalAccount.exists({ username: uname })) {
                return res.status(409).json({ error: 'That username is already taken.' });
            }
            const passwordHash = await bcrypt.hash(password, 12);
            const account = await VaPortalAccount.create({
                username: uname,
                displayName: displayName || username,
                passwordHash,
                role: 'staff', // VAs can only mint staff, never another owner
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
}

module.exports = {
    VaPortalAccount,
    VaSubmission,
    VaPortalActivity,
    registerVaPortalRoutes,
    provisionOwnerAccount,
    requirePortalPage,
    SUBMISSION_CATEGORIES,
    SUBMISSION_STATUSES,
};

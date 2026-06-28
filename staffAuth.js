// staffAuth.js
// Per-user staff authentication for the admin portal.
//
// Provides a StaffUser model (bcrypt-hashed passwords), JWT issued into an
// httpOnly cookie, login/logout/me + admin user-management routes, and the
// middleware used by server.js to gate staff pages and write APIs.
//
// Required env:
//   JWT_SECRET                 - secret for signing session tokens
// Bootstrap (first admin, used only when no staff users exist yet):
//   STAFF_BOOTSTRAP_USERNAME
//   STAFF_BOOTSTRAP_PASSWORD
//   STAFF_BOOTSTRAP_NAME       - optional display name

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const COOKIE_NAME = 'staff_token';
const TOKEN_TTL = '7d';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Roles a staff account can hold.
//   admin            - full access + staff-account management
//   staff            - full tool access, no account management
//   va_rep           - "Inflight VA Rep": scoped access to the VA Ads Manager
//                      and the VA Admin Manual only. Everything else (Aircraft
//                      DB, Airports, Embeds, account admin) is hidden/blocked.
//   graphic_designer - "Graphic Designer": scoped access to the Graphic Designer
//                      workspace (brand assets, logo + banner specs/guidelines).
//                      Everything else is hidden and blocked.
const ROLES = ['admin', 'staff', 'va_rep', 'graphic_designer'];

// Pages an Inflight VA Rep is allowed to open. Any other staff page redirects
// them back to the hub. (Admin/staff bypass this — they see everything.)
const VA_REP_ALLOWED_PAGES = new Set([
    '/staff',
    '/va-ads', '/va-ads.html',
    '/va-admin-manual', '/va-admin-manual.html',
    '/VA-ADMIN-MANUAL.md',
]);

// Pages a Graphic Designer is allowed to open. Like the VA Rep, anything else
// bounces them back to the hub. The brand assets they need live under /assets,
// which is served publicly by express.static (logo branding is not sensitive),
// so it doesn't need to be listed here.
const GRAPHIC_DESIGNER_ALLOWED_PAGES = new Set([
    '/staff',
    '/graphic-designer', '/graphic-designer.html',
]);

// Decide whether a resolved user may open a given page path.
function canAccessPage(user, pathname) {
    if (!user) return false;
    if (user.role === 'va_rep') return VA_REP_ALLOWED_PAGES.has(pathname);
    if (user.role === 'graphic_designer') return GRAPHIC_DESIGNER_ALLOWED_PAGES.has(pathname);
    return true; // admin + staff: full access
}

// A stable secret is required so sessions survive restarts. Fall back to a
// random per-process secret (with a loud warning) so the app still boots.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET not set — using a random per-process secret. ' +
        'Staff sessions will be invalidated on every restart. Set JWT_SECRET in .env.');
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
const StaffUserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, default: 'staff' },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

const StaffUser = mongoose.models.StaffUser || mongoose.model('StaffUser', StaffUserSchema);

// Shape a user doc for client consumption (never leak the hash).
function publicUser(u) {
    if (!u) return null;
    return {
        id: u._id,
        username: u.username,
        displayName: u.displayName || u.username,
        role: u.role,
        active: u.active,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
    };
}

// ---------------------------------------------------------------------------
// Token + cookie helpers
// ---------------------------------------------------------------------------
function signToken(user) {
    return jwt.sign(
        { sub: String(user._id), username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: TOKEN_TTL }
    );
}

// Minimal cookie-header parser so we don't pull in cookie-parser.
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

// Verify the request's token and load the (active) user. Returns the user doc
// or null. Used by all the middleware below.
async function resolveUser(req) {
    const token = getToken(req);
    if (!token) return null;
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
    const user = await StaffUser.findById(payload.sub);
    if (!user || !user.active) return null;
    return user;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// API guard: 401 JSON if not authenticated.
async function requireAuth(req, res, next) {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    req.staff = user;
    next();
}

// API guard: 401/403 JSON unless an admin.
async function requireAdmin(req, res, next) {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    req.staff = user;
    next();
}

// Page guard: redirect to the portal login (preserving the destination) if the
// visitor isn't a signed-in staff member.
async function requireAuthPage(req, res, next) {
    const user = await resolveUser(req);
    if (!user) {
        const next_ = encodeURIComponent(req.originalUrl || '/');
        return res.redirect(`/staff?next=${next_}`);
    }
    // Role-scoped pages: an Inflight VA Rep hitting a page outside their lane
    // is bounced back to the hub rather than shown the tool.
    if (!canAccessPage(user, req.path)) {
        return res.redirect('/staff');
    }
    req.staff = user;
    next();
}

// ---------------------------------------------------------------------------
// Bootstrap the first admin from env when the collection is empty.
// ---------------------------------------------------------------------------
async function bootstrapAdmin() {
    try {
        const count = await StaffUser.countDocuments();
        if (count > 0) return;
        const username = process.env.STAFF_BOOTSTRAP_USERNAME;
        const password = process.env.STAFF_BOOTSTRAP_PASSWORD;
        if (!username || !password) {
            console.warn('⚠️  No staff users exist and STAFF_BOOTSTRAP_USERNAME / ' +
                'STAFF_BOOTSTRAP_PASSWORD are not set. The /staff portal has no accounts yet — ' +
                'set those env vars and restart to create the first admin.');
            return;
        }
        const passwordHash = await bcrypt.hash(password, 12);
        await StaffUser.create({
            username: username.toLowerCase().trim(),
            displayName: process.env.STAFF_BOOTSTRAP_NAME || username,
            passwordHash,
            role: 'admin',
            active: true,
        });
        console.log(`✅ Bootstrapped initial staff admin "${username}".`);
    } catch (err) {
        console.error('❌ Staff admin bootstrap failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function registerAuthRoutes(app) {
    // --- Login ---
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required.' });
            }
            const user = await StaffUser.findOne({ username: String(username).toLowerCase().trim() });
            // Constant-ish failure path: same response whether user missing or bad password.
            const ok = user && user.active && await bcrypt.compare(password, user.passwordHash);
            if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

            user.lastLoginAt = new Date();
            await user.save();

            const token = signToken(user);
            setAuthCookie(res, token);
            res.json({ user: publicUser(user) });
        } catch (err) {
            console.error('Login error:', err);
            res.status(500).json({ error: 'Login failed.' });
        }
    });

    // --- Logout ---
    app.post('/api/auth/logout', (req, res) => {
        clearAuthCookie(res);
        res.json({ ok: true });
    });

    // --- Current user ---
    app.get('/api/auth/me', async (req, res) => {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ error: 'Not authenticated.' });
        res.json({ user: publicUser(user) });
    });

    // --- Change own password ---
    app.post('/api/auth/change-password', requireAuth, async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body || {};
            if (!currentPassword || !newPassword) {
                return res.status(400).json({ error: 'Current and new password are required.' });
            }
            if (String(newPassword).length < 8) {
                return res.status(400).json({ error: 'New password must be at least 8 characters.' });
            }
            const ok = await bcrypt.compare(currentPassword, req.staff.passwordHash);
            if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
            req.staff.passwordHash = await bcrypt.hash(newPassword, 12);
            await req.staff.save();
            res.json({ ok: true });
        } catch (err) {
            console.error('Change password error:', err);
            res.status(500).json({ error: 'Could not change password.' });
        }
    });

    // --- Admin: list users ---
    app.get('/api/auth/users', requireAdmin, async (req, res) => {
        const users = await StaffUser.find().sort({ createdAt: 1 });
        res.json({ users: users.map(publicUser) });
    });

    // --- Admin: create user ---
    app.post('/api/auth/users', requireAdmin, async (req, res) => {
        try {
            const { username, password, displayName, role } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required.' });
            }
            if (String(password).length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            }
            const uname = String(username).toLowerCase().trim();
            const exists = await StaffUser.findOne({ username: uname });
            if (exists) return res.status(409).json({ error: 'That username already exists.' });

            const passwordHash = await bcrypt.hash(password, 12);
            const user = await StaffUser.create({
                username: uname,
                displayName: displayName || username,
                passwordHash,
                role: ROLES.includes(role) ? role : 'staff',
                active: true,
            });
            res.status(201).json({ user: publicUser(user) });
        } catch (err) {
            console.error('Create user error:', err);
            res.status(500).json({ error: 'Could not create user.' });
        }
    });

    // --- Admin: update user (role / active / displayName / password reset) ---
    app.patch('/api/auth/users/:id', requireAdmin, async (req, res) => {
        try {
            const user = await StaffUser.findById(req.params.id);
            if (!user) return res.status(404).json({ error: 'User not found.' });

            const { role, active, displayName, password } = req.body || {};
            const isSelf = String(user._id) === String(req.staff._id);

            // Guard: never let an admin lock themselves out or demote/disable the
            // last remaining active admin.
            if ((role && role !== 'admin') || active === false) {
                if (user.role === 'admin') {
                    const otherActiveAdmins = await StaffUser.countDocuments({
                        _id: { $ne: user._id }, role: 'admin', active: true,
                    });
                    if (otherActiveAdmins === 0) {
                        return res.status(400).json({ error: 'Cannot demote or disable the last active admin.' });
                    }
                }
            }

            if (ROLES.includes(role)) user.role = role;
            if (typeof active === 'boolean') user.active = active;
            if (typeof displayName === 'string') user.displayName = displayName;
            if (password) {
                if (String(password).length < 8) {
                    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
                }
                user.passwordHash = await bcrypt.hash(password, 12);
            }
            await user.save();
            res.json({ user: publicUser(user), self: isSelf });
        } catch (err) {
            console.error('Update user error:', err);
            res.status(500).json({ error: 'Could not update user.' });
        }
    });

    // --- Admin: delete user ---
    app.delete('/api/auth/users/:id', requireAdmin, async (req, res) => {
        try {
            const user = await StaffUser.findById(req.params.id);
            if (!user) return res.status(404).json({ error: 'User not found.' });
            if (String(user._id) === String(req.staff._id)) {
                return res.status(400).json({ error: 'You cannot delete your own account.' });
            }
            if (user.role === 'admin') {
                const otherActiveAdmins = await StaffUser.countDocuments({
                    _id: { $ne: user._id }, role: 'admin', active: true,
                });
                if (otherActiveAdmins === 0) {
                    return res.status(400).json({ error: 'Cannot delete the last active admin.' });
                }
            }
            await user.deleteOne();
            res.json({ ok: true });
        } catch (err) {
            console.error('Delete user error:', err);
            res.status(500).json({ error: 'Could not delete user.' });
        }
    });
}

module.exports = {
    StaffUser,
    registerAuthRoutes,
    bootstrapAdmin,
    requireAuth,
    requireAdmin,
    requireAuthPage,
};

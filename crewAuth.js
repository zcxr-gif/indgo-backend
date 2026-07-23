// crewAuth.js
// Sign-in for the Crew Center (inflight.info/crew/<slug>).
//
// One cascading login that authenticates against OUR existing accounts — never
// the VA's Supabase — so the whole VA team plus Inflight can get in:
//   1. VaPortalAccount scoped to THIS crew center's VA  (owner | staff | pilot)
//   2. StaffUser (Inflight staff)                       (oversight into any VA)
//
// Owner/staff/Inflight land on the management dashboard; pilots land on the pilot
// home. The static login page stores the returned Bearer token itself (no
// cross-site cookies), so CORS stays simple (no credentials).
//
// Required env: JWT_SECRET (the SAME secret staffAuth / vaPortal sign with).

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const TOKEN_TTL = '7d';

// Known layout presets + login looks (mirrors the crew center front-end).
const CREW_LAYOUTS = ['editorial', 'console', 'split', 'classic'];
const LOGIN_LOOKS = ['center', 'split'];

const isHexColor = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || '');
const clampStr = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cleanImageUrl = (u) => { const s = clampStr(u, 600); return /^https:\/\//i.test(s) ? s : ''; };

// Verify a crew Bearer token on a request (used by routes registered outside
// this module, e.g. the badge-image upload in server.js). Returns the crew
// payload or null.
function verifyCrewRequest(req) {
    const token = getBearer(req);
    if (!token) return null;
    try { const p = jwt.verify(token, JWT_SECRET); return p.typ === 'crew' ? p : null; }
    catch { return null; }
}

// Sanitize the VA-defined rank ladder / role list before saving.
function sanitizeRanks(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 40).map(r => ({
        name: clampStr(r && r.name, 40),
        minHours: Math.max(0, Math.min(100000, Number(r && r.minHours) || 0)),
        color: isHexColor(r && r.color) ? r.color : '',
        icon: clampStr(r && r.icon, 30),
        image: cleanImageUrl(r && r.image),
    })).filter(r => r.name).sort((a, b) => a.minHours - b.minHours);
}
function sanitizeRoles(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 40).map(r => ({
        name: clampStr(r && r.name, 40),
        color: isHexColor(r && r.color) ? r.color : '',
        icon: clampStr(r && r.icon, 30),
        image: cleanImageUrl(r && r.image),
        staff: !!(r && r.staff),
    })).filter(r => r.name);
}

// Which dashboard a role routes to.
function viewForRole(role) {
    return role === 'pilot' ? 'pilot' : 'owner';
}

function signCrewToken(payload) {
    // typ:'crew' namespaces these so they can't be swapped for a staff/portal cookie.
    return jwt.sign({ ...payload, typ: 'crew' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function getBearer(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return null;
}

// Resolve the VA for a crew slug (slug first, callsign fallback), approved only.
async function resolveVa(slug) {
    const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
    const raw = String(slug || '').trim().toLowerCase();
    if (!raw) return null;
    let va = await VirtualAirlineAd.findOne({ slug: raw, status: 'approved' })
        .select('_id name slug callsign').lean();
    if (!va) {
        va = await VirtualAirlineAd.findOne({ callsign: raw.toUpperCase(), status: 'approved' })
            .select('_id name slug callsign').lean();
    }
    return va;
}

function registerCrewAuthRoutes(app) {
    // --- Sign in ---
    app.post('/api/crew/:slug/login', async (req, res) => {
        try {
            const va = await resolveVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });

            const username = String((req.body && req.body.username) || '').toLowerCase().trim();
            const password = String((req.body && req.body.password) || '');
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required.' });
            }

            const VaPortalAccount = mongoose.model('VaPortalAccount');
            const StaffUser = mongoose.model('StaffUser');

            let identity = null;

            // 1) A VA account that belongs to THIS crew center's VA.
            const acct = await VaPortalAccount.findOne({ username });
            if (acct && acct.active && String(acct.vaAdId) === String(va._id)
                && await bcrypt.compare(password, acct.passwordHash)) {
                acct.lastLoginAt = new Date();
                await acct.save();
                identity = { sub: String(acct._id), kind: 'va', role: acct.role, name: acct.displayName || acct.username };
            }

            // 2) Otherwise an Inflight staff member (oversight into any crew center).
            if (!identity) {
                const staff = await StaffUser.findOne({ username });
                if (staff && staff.active && await bcrypt.compare(password, staff.passwordHash)) {
                    staff.lastLoginAt = new Date();
                    await staff.save();
                    identity = { sub: String(staff._id), kind: 'inflight', role: 'inflight', name: staff.displayName || staff.username };
                }
            }

            // Same response whether the user was missing or the password was wrong.
            if (!identity) return res.status(401).json({ error: 'Invalid username or password.' });

            const view = viewForRole(identity.role);
            const token = signCrewToken({
                sub: identity.sub, kind: identity.kind, role: identity.role, view,
                slug: va.slug || String(req.params.slug).toLowerCase(), vaId: String(va._id), name: identity.name,
            });

            res.set('Cache-Control', 'no-store');
            res.json({
                token, view, role: identity.role, oversight: identity.kind === 'inflight', name: identity.name,
                va: { name: va.name, slug: va.slug || null, code: va.callsign || null },
            });
        } catch (err) {
            console.error('Crew login error:', err);
            res.status(500).json({ error: 'Sign-in failed.' });
        }
    });

    // --- Crew settings (owner/staff or Inflight can change; e.g. the layout) ---
    app.post('/api/crew/:slug/settings', async (req, res) => {
        const token = getBearer(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated.' });
        let p;
        try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid session.' }); }
        if (p.typ !== 'crew') return res.status(401).json({ error: 'Invalid session.' });

        const slug = String(req.params.slug || '').toLowerCase();
        // Pilots can't change crew settings; a VA account is bound to its own crew.
        const isInflight = p.kind === 'inflight';
        if (!(isInflight || p.role === 'owner' || p.role === 'staff')) {
            return res.status(403).json({ error: 'Not allowed to change crew settings.' });
        }
        if (!isInflight && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }

        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
            const ad = await VirtualAirlineAd.findById(va._id);
            if (!ad) return res.status(404).json({ error: 'Crew center not found.' });

            if (typeof req.body?.layout === 'string') {
                const layout = req.body.layout.toLowerCase();
                const allowed = (Array.isArray(ad.allowedLayouts) && ad.allowedLayouts.length)
                    ? ad.allowedLayouts : CREW_LAYOUTS;
                if (!CREW_LAYOUTS.includes(layout) || !allowed.includes(layout)) {
                    return res.status(400).json({ error: 'That layout isn’t available for this crew center.' });
                }
                ad.layout = layout;
            }
            if (typeof req.body?.accent === 'string') {
                const a = req.body.accent.trim();
                if (a && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(a)) {
                    return res.status(400).json({ error: 'Enter a valid hex colour like #1c1a16.' });
                }
                ad.crewAccent = a; // '' clears it (falls back to the derived accent)
            }
            if (typeof req.body?.loginLook === 'string') {
                const look = req.body.loginLook.toLowerCase();
                if (!LOGIN_LOOKS.includes(look)) {
                    return res.status(400).json({ error: 'Unknown login look.' });
                }
                ad.loginLook = look;
            }
            if (req.body?.ranks !== undefined) {
                const r = sanitizeRanks(req.body.ranks);
                if (r) ad.ranks = r;
            }
            if (req.body?.roles !== undefined) {
                const r = sanitizeRoles(req.body.roles);
                if (r) ad.roles = r;
            }
            await ad.save();
            res.set('Cache-Control', 'no-store');
            res.json({
                layout: ad.layout, allowedLayouts: ad.allowedLayouts, accent: ad.crewAccent || '',
                loginLook: ad.loginLook || 'center', ranks: ad.ranks || [], roles: ad.roles || [],
            });
        } catch (err) {
            console.error('Crew settings error:', err);
            res.status(500).json({ error: 'Could not save settings.' });
        }
    });

    // --- Connect the VA's Supabase project (owner or Inflight only) ---
    // Stores the project URL + public anon key (browser-safe) and, optionally,
    // the secret service-role key (never returned). Staff/pilots cannot touch it.
    app.post('/api/crew/:slug/supabase', async (req, res) => {
        const token = getBearer(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated.' });
        let p;
        try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid session.' }); }
        if (p.typ !== 'crew') return res.status(401).json({ error: 'Invalid session.' });

        const slug = String(req.params.slug || '').toLowerCase();
        const isInflight = p.kind === 'inflight';
        if (!(isInflight || p.role === 'owner')) {
            return res.status(403).json({ error: 'Only the VA owner can connect Supabase.' });
        }
        if (!isInflight && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }

        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
            const ad = await VirtualAirlineAd.findById(va._id).select('+supabaseServiceKey');
            if (!ad) return res.status(404).json({ error: 'Crew center not found.' });

            const body = req.body || {};
            if (body.url !== undefined) {
                const u = String(body.url || '').trim().replace(/\/+$/, '');
                if (u && !/^https:\/\/[a-z0-9.-]+/i.test(u)) {
                    return res.status(400).json({ error: 'Enter a valid https Supabase project URL.' });
                }
                ad.supabaseUrl = u;
            }
            if (body.anonKey !== undefined) ad.supabaseAnonKey = String(body.anonKey || '').trim();
            // Only overwrite the secret when a new non-empty value is supplied, so
            // re-saving without re-typing it doesn't wipe it. '' with clear:true clears.
            if (typeof body.serviceKey === 'string' && body.serviceKey.trim()) {
                ad.supabaseServiceKey = body.serviceKey.trim();
            } else if (body.clearServiceKey === true) {
                ad.supabaseServiceKey = '';
            }
            await ad.save();
            res.set('Cache-Control', 'no-store');
            res.json({
                connected: !!(ad.supabaseUrl && ad.supabaseAnonKey),
                url: ad.supabaseUrl || '',
                anonKey: ad.supabaseAnonKey || '',
                hasServiceKey: !!ad.supabaseServiceKey,
            });
        } catch (err) {
            console.error('Crew supabase save error:', err);
            res.status(500).json({ error: 'Could not save the Supabase connection.' });
        }
    });

    // --- Who am I (verify a Bearer token for this crew center) ---
    app.get('/api/crew/:slug/me', async (req, res) => {
        const token = getBearer(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated.' });
        let p;
        try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid session.' }); }
        if (p.typ !== 'crew') return res.status(401).json({ error: 'Invalid session.' });
        const slug = String(req.params.slug || '').toLowerCase();
        if (p.slug && slug && p.slug !== slug) return res.status(403).json({ error: 'Wrong crew center.' });
        res.set('Cache-Control', 'no-store');
        res.json({ role: p.role, view: p.view, name: p.name, oversight: p.kind === 'inflight' });
    });
}

module.exports = { registerCrewAuthRoutes, viewForRole, verifyCrewRequest };

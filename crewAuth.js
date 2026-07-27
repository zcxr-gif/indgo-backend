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
function sanitizeFleet(arr) {
    if (!Array.isArray(arr)) return null;
    // `type` holds the aircraft name and `name` the livery — both are meant to be
    // the canonical Infinite Flight API strings (offered by the fleet editor) so
    // the tracker can match live flights to the fleet. Canonical aircraft names
    // ("Boeing 787-10 Dreamliner") run long, so type is clamped generously.
    return arr.slice(0, 100).map(a => ({
        type: clampStr(a && a.type, 60),
        name: clampStr(a && a.name, 80),
        image: cleanImageUrl(a && a.image),
    })).filter(a => a.type || a.name);
}
function sanitizeForm(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 30).map(q => ({
        label: clampStr(q && q.label, 120),
        type: ['text', 'textarea', 'select'].includes(q && q.type) ? q.type : 'text',
        options: Array.isArray(q && q.options) ? q.options.slice(0, 20).map(o => clampStr(o, 60)).filter(Boolean) : [],
        required: !!(q && q.required),
    })).filter(q => q.label);
}
// Extensible join requirements. Numeric-threshold types are auto-checked
// against real IF stats; 'agree' is a custom checkbox the applicant must tick.
const REQ_TYPES = ['grade', 'hours', 'landings', 'xp', 'flights', 'violations', 'agree'];
function sanitizeRequirements(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 20).map(r => {
        const type = REQ_TYPES.includes(r && r.type) ? r.type : 'agree';
        if (type === 'agree') {
            return { type, value: 0, label: clampStr(r && r.label, 200), required: r && r.required === false ? false : true };
        }
        // grade caps at 5; the rest are open-ended non-negative integers.
        const cap = type === 'grade' ? 5 : 10000000;
        return { type, value: Math.max(0, Math.min(cap, Math.round(Number(r && r.value) || 0))), label: clampStr(r && r.label, 200), required: true };
    }).filter(r => (r.type === 'agree' ? r.label : r.value > 0));
}

// ---- Staff permissions ----
// The catalog of things a staff member can be granted. This is the ONE place to
// extend the permission system — add a row here (and gate an endpoint on it) and
// it flows through to the owner's role builder automatically. Owner-only powers
// (connect Supabase, manage the team itself) are deliberately NOT here.
const CREW_CAPABILITIES = [
    { id: 'roster.manage',          group: 'Roster',        label: 'Add, edit & remove pilots' },
    { id: 'applications.review',    group: 'Recruitment',   label: 'Review applications — accept / decline' },
    { id: 'settings.recruitment',   group: 'Recruitment',   label: 'Edit join settings, questions & requirements' },
    { id: 'settings.branding',      group: 'Appearance',    label: 'Change appearance, ranks, roles & fleet' },
    { id: 'settings.notifications', group: 'Notifications',  label: 'Manage Discord & email notifications' },
    { id: 'routes.manage',          group: 'Operations',    label: 'Create & manage the route network' },
    { id: 'flights.review',         group: 'Operations',    label: 'Review flights (PIREPs) & auto-tracking' },
    // Room to grow, e.g.:
    // { id: 'events.manage',     group: 'Operations', label: 'Create & manage events' },
    // { id: 'schedules.manage',  group: 'Operations', label: 'Manage schedules & bookings' },
    // { id: 'members.message',   group: 'Roster',     label: 'Message crew members' },
];
const CREW_CAP_IDS = CREW_CAPABILITIES.map(c => c.id);

function slugifyRoleId(s) {
    const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || ('role-' + Math.random().toString(36).slice(2, 8));
}
// Owner-defined staff roles: a name + colour + a set of capability ids.
function sanitizeStaffRoles(arr) {
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    return arr.slice(0, 30).map(r => {
        let id = slugifyRoleId(clampStr(r && r.id, 40) || (r && r.name));
        while (seen.has(id)) id = id + '-' + Math.random().toString(36).slice(2, 4);
        seen.add(id);
        return {
            id, name: clampStr(r && r.name, 40),
            color: isHexColor(r && r.color) ? r.color : '',
            permissions: Array.isArray(r && r.permissions) ? r.permissions.filter(c => CREW_CAP_IDS.includes(c)) : [],
        };
    }).filter(r => r.name);
}
// Which staff account (by login username) maps to which staff role.
function sanitizeAssignments(arr) {
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    return arr.slice(0, 300).map(a => ({
        username: clampStr(a && a.username, 60).toLowerCase(),
        roleId: clampStr(a && a.roleId, 40),
    })).filter(a => { if (!a.username || !a.roleId || seen.has(a.username)) return false; seen.add(a.username); return true; });
}
// The capabilities a caller effectively has. Owner + Inflight get everything;
// pilots get nothing. A staff member gets their assigned role's permissions —
// but a staff member with NO assignment keeps full access, so turning on the
// system doesn't silently lock out a VA's existing team until they choose to.
function effectiveCaps(va, p) {
    if (!p) return [];
    if (p.kind === 'inflight' || p.role === 'owner') return CREW_CAP_IDS.slice();
    if (p.role !== 'staff') return [];
    const roles = Array.isArray(va && va.staffRoles) ? va.staffRoles : [];
    const asn = Array.isArray(va && va.staffAssignments) ? va.staffAssignments : [];
    const uname = String(p.uname || '').toLowerCase();
    const a = uname && asn.find(x => String(x.username || '').toLowerCase() === uname);
    if (a) {
        const role = roles.find(r => r.id === a.roleId);
        return role ? (role.permissions || []).filter(c => CREW_CAP_IDS.includes(c)) : [];
    }
    return CREW_CAP_IDS.slice(); // unassigned staff → full (non-breaking default)
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

// A crew center answers to its slug OR to any callsign its VA flies under (the
// directory lets a VA register several — `callsign` is only the primary). The
// old lookup checked the primary alone, so a link built from a sub-fleet
// callsign 404'd on a VA that was perfectly live.
function crewHandleQuery(handle) {
    const raw = String(handle || '').trim().toLowerCase();
    if (!raw) return null;
    const code = raw.toUpperCase();
    return { $or: [{ slug: raw }, { callsign: code }, { callsigns: code }] };
}

/**
 * Resolve a crew center handle to its VA.
 *
 * Queries WITHOUT the status filter and applies it here on purpose: a caller
 * that only gets `null` cannot tell "no VA answers to this address" from "the
 * VA exists but isn't approved yet", and the second is the case that leaves an
 * owner staring at a link that will never work. Only an approved VA is ever
 * returned — the reason is what changes.
 *
 * @param {string} handle  the slug (or callsign) from /crew/<handle>
 * @param {string} select  mongoose projection for the fields the caller needs
 * @returns {Promise<{va: object|null, reason: 'unknown'|'not-approved'|null, status?: string}>}
 */
async function lookupCrewVa(handle, select) {
    const query = crewHandleQuery(handle);
    if (!query) return { va: null, reason: 'unknown' };
    const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
    const raw = String(handle).trim().toLowerCase();
    const found = await VirtualAirlineAd.find(query)
        .select(`${select} status slug`).limit(10).lean();
    if (!found.length) return { va: null, reason: 'unknown' };
    // A slug is unique and exact; a callsign can be shared with a pending or
    // rejected duplicate of the same brand, so an exact slug match wins the tie.
    const exact = found.filter(v => v.slug === raw);
    const pool = exact.length ? exact : found;
    const va = pool.find(v => v.status === 'approved');
    if (!va) return { va: null, reason: 'not-approved', status: pool[0].status };
    return { va, reason: null };
}

// Resolve the VA for a crew slug, approved only.
async function resolveVa(slug) {
    const { va } = await lookupCrewVa(slug, '_id name slug callsign staffRoles staffAssignments');
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
                slug: va.slug || String(req.params.slug).toLowerCase(), vaId: String(va._id),
                name: identity.name, uname: username,
            });
            const payload = { kind: identity.kind, role: identity.role, uname: username };
            const caps = effectiveCaps(va, payload);

            res.set('Cache-Control', 'no-store');
            res.json({
                token, view, role: identity.role, oversight: identity.kind === 'inflight', name: identity.name,
                caps, capabilities: CREW_CAPABILITIES,
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

            // Per-capability gate: staff can only change the areas their role allows.
            const caps = effectiveCaps(ad, p);
            const can = (c) => caps.includes(c);
            const body = req.body || {};
            const touchesBranding = ['layout', 'accent', 'loginLook', 'ranks', 'roles', 'fleet'].some(f => body[f] !== undefined);
            const touchesRecruit = ['joinMode', 'minGrade', 'callsignPrefix', 'applicationForm', 'joinRequirements'].some(f => body[f] !== undefined);
            const touchesTeam = body.staffRoles !== undefined || body.staffAssignments !== undefined;
            const touchesOps = body.pirepAutoApprove !== undefined;
            if (touchesBranding && !can('settings.branding')) return res.status(403).json({ error: 'You don’t have permission to change appearance.' });
            if (touchesRecruit && !can('settings.recruitment')) return res.status(403).json({ error: 'You don’t have permission to change recruitment settings.' });
            if (touchesTeam && !(isInflight || p.role === 'owner')) return res.status(403).json({ error: 'Only the owner can manage staff roles.' });
            if (touchesOps && !can('flights.review')) return res.status(403).json({ error: 'You don’t have permission to change flight tracking.' });

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
            if (req.body?.fleet !== undefined) {
                const f = sanitizeFleet(req.body.fleet);
                if (f) ad.crewFleet = f;
            }
            if (typeof req.body?.joinMode === 'string' && ['free', 'application'].includes(req.body.joinMode)) {
                ad.joinMode = req.body.joinMode;
            }
            if (req.body?.minGrade !== undefined) {
                ad.minGrade = Math.max(0, Math.min(5, Number(req.body.minGrade) || 0));
            }
            if (typeof req.body?.callsignPrefix === 'string') {
                ad.callsignPrefix = req.body.callsignPrefix.trim().slice(0, 10);
            }
            if (req.body?.applicationForm !== undefined) {
                const f = sanitizeForm(req.body.applicationForm);
                if (f) ad.applicationForm = f;
            }
            if (req.body?.joinRequirements !== undefined) {
                const r = sanitizeRequirements(req.body.joinRequirements);
                if (r) {
                    ad.joinRequirements = r;
                    // Keep minGrade mirrored from a grade requirement so the public
                    // directory + legacy gate stay in sync with the builder.
                    const g = r.find(x => x.type === 'grade');
                    if (g) ad.minGrade = Math.max(0, Math.min(5, g.value));
                }
            }
            if (touchesTeam) {
                if (req.body.staffRoles !== undefined) { const r = sanitizeStaffRoles(req.body.staffRoles); if (r) ad.staffRoles = r; }
                if (req.body.staffAssignments !== undefined) { const a = sanitizeAssignments(req.body.staffAssignments); if (a) ad.staffAssignments = a; }
            }
            if (touchesOps) ad.crewPirepAutoApprove = !!req.body.pirepAutoApprove;
            await ad.save();
            res.set('Cache-Control', 'no-store');
            res.json({
                layout: ad.layout, allowedLayouts: ad.allowedLayouts, accent: ad.crewAccent || '',
                loginLook: ad.loginLook || 'center', ranks: ad.ranks || [], roles: ad.roles || [], fleet: ad.crewFleet || [],
                joinMode: ad.joinMode, minGrade: ad.minGrade, callsignPrefix: ad.callsignPrefix || '',
                applicationForm: ad.applicationForm || [], joinRequirements: ad.joinRequirements || [],
                staffRoles: ad.staffRoles || [], staffAssignments: ad.staffAssignments || [],
                pirepAutoApprove: !!ad.crewPirepAutoApprove,
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
        // Resolve fresh caps from the VA (so an owner's change takes effect without
        // waiting for re-login). The owner also gets the role config to manage it.
        const va = await resolveVa(slug || p.slug);
        const caps = effectiveCaps(va, p);
        const isOwner = p.kind === 'inflight' || p.role === 'owner';
        res.set('Cache-Control', 'no-store');
        res.json({
            role: p.role, view: p.view, name: p.name, oversight: p.kind === 'inflight',
            caps, capabilities: CREW_CAPABILITIES,
            staffRoles: (isOwner && va && va.staffRoles) || [],
            staffAssignments: (isOwner && va && va.staffAssignments) || [],
        });
    });
}

module.exports = { registerCrewAuthRoutes, viewForRole, verifyCrewRequest, effectiveCaps, lookupCrewVa, CREW_CAPABILITIES, CREW_CAP_IDS };

// crewAuth.js
// Sign-in for the Crew Center (inflight.info/crew/<slug>).
//
// One cascading login, tried in this order:
//   1. a PILOT account in the VA's OWN data store   (crew_accounts, their project)
//   2. VaPortalAccount scoped to THIS crew center's VA  (owner | staff)
//   3. StaffUser (Inflight staff)                       (oversight into any VA)
//
// Step 1 is the one that moved. A pilot's account belongs to the VA in the same
// way their hours do, so it is stored in the VA's project and read back through
// crewStore — Inflight holds no pilot credentials for any VA. Steps 2 and 3 are
// our own accounts: the VA's staff administer their partnership with us, and
// Inflight staff have oversight, so those stay central.
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

const crewStore = require('./crewStore');
const crewAccounts = require('./crewAccounts');
const crewInvite = require('./crewInvite');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

/**
 * Retire the invitation that let a pilot in, the moment they use it.
 *
 * Deliberately returns nothing and swallows everything. This runs after a
 * password has already been checked and accepted, so there is no outcome here —
 * including "the store went away mid-login" — that should turn a successful
 * sign-in into a failure. The worst case is an invitation that stays readable
 * until it expires, which is what would have happened anyway.
 */
function claimInvitation(store, accountId) {
    if (!store || !accountId || typeof store.getApplicationByInviteAccount !== 'function') return;
    Promise.resolve()
        .then(async () => {
            const appDoc = await store.getApplicationByInviteAccount(String(accountId));
            // No invitation, or one that has already been spent. Either way
            // there is nothing left to clear, and re-stamping a claim date that
            // is already set would only move it.
            if (!appDoc || !appDoc.invitePassword) return;
            await store.updateApplication(appDoc._id, crewInvite.claimPatch());
        })
        .catch((err) => console.warn('crew login: could not clear invitation —', err?.message || err));
}
const TOKEN_TTL = '7d';

// Known layout presets + login looks (mirrors the crew center front-end).
const CREW_LAYOUTS = ['editorial', 'console', 'split', 'classic'];
const LOGIN_LOOKS = ['center', 'split'];

const isHexColor = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || '');
const clampStr = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cleanImageUrl = (u) => { const s = clampStr(u, 600); return /^https:\/\//i.test(s) ? s : ''; };

// A Discord INVITE link — discord.gg/abc123, or discord.com/invite/abc123.
// NOT the webhook URL the VA sets for notifications; that one is a secret and
// lives elsewhere. This one is public and is handed to accepted pilots.
//
// Validated strictly, and not as a formality: this string goes into an
// acceptance email that WE send, with our name on it. An unvalidated "invite"
// field is a phishing vector — a VA could point it anywhere and the message
// would still read as coming from Inflight. Anything that is not literally a
// Discord invite is rejected rather than sanitised into something plausible.
const isDiscordInviteUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    let u;
    try { u = new URL(url.trim()); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // Discord's own codes are alphanumeric; vanity URLs add hyphens. No slashes
    // in the pattern, so an extra path segment can't be smuggled through.
    const code = '[A-Za-z0-9-]{2,64}';
    const known = ['discord.gg', 'discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'];
    if (!known.includes(host)) return false;
    if (!new RegExp(`^/(invite/)?${code}/?$`).test(u.pathname)) return false;
    // Only discord.gg may use the bare /code form; on the full domains an
    // invite always lives under /invite/.
    return host === 'discord.gg' || u.pathname.startsWith('/invite/');
};

// '' when nothing was supplied (a meaningful value — it clears a stored
// invite), the CANONICAL url when it is a real invite, and null when the caller
// sent something that is not one, so a handler can tell "cleared" from
// "rejected".
//
// Canonical, not merely trimmed: the returned string is rebuilt from the parsed
// URL, so what we store and later show a pilot is always origin + clean path.
// The parser resolves "/abc/../../x" to "/x" before the host check, so such a
// URL is on discord.gg either way and is safe — but echoing the traversal back
// to a pilot as their invite link would look like an attack. Rebuilding drops
// it, along with any query string or fragment an invite has no use for.
const cleanDiscordInvite = (url) => {
    const s = String(url == null ? '' : url).trim();
    if (!s) return '';
    if (!isDiscordInviteUrl(s)) return null;
    const u = new URL(s);
    return (u.origin + u.pathname).replace(/\/+$/, '');
};

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
        // v7. A rung a pilot cannot reach on hours alone — staff sign them off.
        // A VA's choice, per rung: most gate none, or one (the step up to
        // Captain). See crewRanks for how it resolves.
        requiresCheck: !!(r && r.requiresCheck),
        // What the check-ride actually is, in the VA's words. Shown to the
        // pilot waiting on it, so "awaiting a check-ride" says what to do.
        checkNote: clampStr(r && r.checkNote, 300),
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
    { id: 'events.manage',          group: 'Operations',    label: 'Create & manage events and the gate board' },
    // Room to grow, e.g.:
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

// Resolve the VA for a crew slug (slug first, callsign fallback), approved only.
//
// The selection carries the VA's data-store connection (crewStore.SELECT pulls
// in the select:false service key) because the login below has to open the VA's
// project to check a pilot's password. Nothing in this module returns the `va`
// object itself — every response is assembled field by field — so the key does
// not escape by being along for the ride.
async function resolveVa(slug) {
    const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
    const raw = String(slug || '').trim().toLowerCase();
    if (!raw) return null;
    const sel = `${crewStore.SELECT} staffRoles staffAssignments`;
    let va = await VirtualAirlineAd.findOne({ slug: raw, status: 'approved' })
        .select(sel).lean();
    if (!va) {
        va = await VirtualAirlineAd.findOne({ callsign: raw.toUpperCase(), status: 'approved' })
            .select(sel).lean();
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

            // 1) A pilot account in the VA's OWN data store.
            //
            // Deliberately tolerant of a store that cannot answer: a VA
            // half-way through connecting a project, or one whose project is
            // briefly unreachable, must not lock its own staff out of the
            // dashboard they would use to fix it. A failure here means "not
            // this identity" and the cascade continues.
            try {
                const store = await crewStore.forVa(va);
                const pilot = await crewAccounts.authenticate(store, username, password);
                if (pilot) {
                    identity = {
                        sub: String(pilot._id), kind: 'crew', role: pilot.role || 'pilot',
                        name: pilot.displayName || pilot.username,
                        mustChangePassword: !!pilot.mustChangePassword,
                    };
                    // The invitation has done its job. Clearing it here rather
                    // than on the password change is on purpose: arriving is the
                    // proof it was delivered, and a pilot who signs in and then
                    // wanders off should not leave a live credential on a status
                    // page anyone they forwarded the link to can still read.
                    //
                    // Fire-and-forget, and it must stay that way — a store that
                    // cannot record this is not a reason to refuse a login whose
                    // password we have already verified.
                    claimInvitation(store, pilot._id);
                }
            } catch (err) {
                if (err && err.code !== 'store_not_connected') {
                    console.warn('crew login: pilot store lookup failed —', err.message || err);
                }
            }

            // 2) A VA staff account that belongs to THIS crew center's VA.
            if (!identity) {
                const acct = await VaPortalAccount.findOne({ username });
                if (acct && acct.active && String(acct.vaAdId) === String(va._id)
                    && await bcrypt.compare(password, acct.passwordHash)) {
                    acct.lastLoginAt = new Date();
                    await acct.save();
                    identity = {
                        sub: String(acct._id), kind: 'va', role: acct.role,
                        name: acct.displayName || acct.username,
                        mustChangePassword: !!acct.mustChangePassword,
                    };
                }
            }

            // 3) Otherwise an Inflight staff member (oversight into any crew center).
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
                username,
                // The password this account was issued was generated for them and
                // has been seen by whoever handed it over, so the crew center
                // asks for a new one before it lets them do anything else. Only
                // a store-backed account can change it here (see
                // POST /api/crew/:slug/account/password); central accounts are
                // told to use the portal.
                mustChangePassword: !!identity.mustChangePassword,
                canChangePassword: identity.kind === 'crew',
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
            const touchesRecruit = ['joinMode', 'minGrade', 'callsignPrefix', 'discordInvite', 'applicationForm', 'joinRequirements'].some(f => body[f] !== undefined);
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
            // The VA's Discord invite, offered to every pilot they accept. The
            // accept dialog pre-fills from this and can override it per pilot.
            if (req.body?.discordInvite !== undefined) {
                const inv = cleanDiscordInvite(req.body.discordInvite);
                if (inv === null) {
                    return res.status(400).json({ error: 'That is not a Discord invite link. Use a discord.gg or discord.com/invite address.' });
                }
                ad.crewDiscordInvite = inv;
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
                discordInvite: ad.crewDiscordInvite || '',
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
        // Re-read the "you still owe us a password change" flag from the store
        // rather than trusting the token: the flag clears mid-session, and a
        // stale claim in a 7-day token would either nag someone who has already
        // changed it or stop nagging someone who reloaded before doing so.
        let mustChangePassword = false;
        if (p.kind === 'crew' && va) {
            try {
                const account = await (await crewStore.forVa(va)).getAccount(p.sub);
                mustChangePassword = !!(account && account.mustChangePassword);
            } catch { /* unreachable store — don't block "who am I" on it */ }
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            role: p.role, view: p.view, name: p.name, oversight: p.kind === 'inflight',
            username: p.uname || '',
            mustChangePassword,
            canChangePassword: p.kind === 'crew',
            caps, capabilities: CREW_CAPABILITIES,
            staffRoles: (isOwner && va && va.staffRoles) || [],
            staffAssignments: (isOwner && va && va.staffAssignments) || [],
        });
    });
}

module.exports = {
    registerCrewAuthRoutes, viewForRole, verifyCrewRequest, effectiveCaps,
    isDiscordInviteUrl, cleanDiscordInvite,
    CREW_CAPABILITIES, CREW_CAP_IDS,
};

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

module.exports = { registerCrewAuthRoutes, viewForRole };

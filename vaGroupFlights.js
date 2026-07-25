// vaGroupFlights.js
// Group flights — "we all took off together, come watch us".
//
// A VA runs an event, a dozen aircraft depart, and the VA owner wants ONE link
// to post on the IFC so everyone can watch the whole formation instead of
// clicking twelve separate flights. That link is what this module mints.
//
// Two halves:
//
//  1. OWNERSHIP (who is allowed to publish for a VA)
//     Rather than invent another password, a VA claims its listing with the
//     contact email ALREADY on file for the partnership. Sign in to Inflight
//     with that same address and the account is bound to the VA. Exactly ONE
//     account can hold a VA — the first to claim it — so a shared inbox can't
//     turn into five people publishing under the same brand. Staff can release
//     the binding if the VA changes hands.
//
//     The email is never taken on trust from the browser. The tracker sends its
//     Supabase ACCESS TOKEN; we hand that to Supabase's own /auth/v1/user
//     endpoint and use the address it returns, which a page cannot forge. An
//     unverified (unconfirmed) address is refused.
//
//  2. THE LINK
//     A group is stored here under a short code and shared as
//     https://inflight.info/?g=<code> — a URL short enough to paste anywhere,
//     instead of the ~2 KB the fully self-contained encoding would need for a
//     dozen aircraft. /g/<code> on this backend serves the same group as a
//     preview page carrying Open Graph tags, so a paste on the IFC (or Discord)
//     unfurls with the title, the VA and the aircraft count before redirecting
//     a human on to the tracker. No Netlify function is involved in either path.
//
//     A group is a SNAPSHOT of who was airborne when it was created, plus the
//     flight ids. The tracker re-finds those flights live; the snapshot is only
//     the fallback that keeps a link meaningful after the flights have landed.
//     Groups self-delete after VA_GROUP_TTL_DAYS (default 30).
//
// Env:
//   INFLIGHT_SUPABASE_URL / INFLIGHT_SUPABASE_ANON_KEY  identity check target.
//                          Both default to the tracker's public project.
//   VA_GROUP_TTL_DAYS      how long a group link stays alive (default 30).
//   PUBLIC_BASE_URL        origin used to build the shareable link.

const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');

const SUPABASE_URL = (process.env.INFLIGHT_SUPABASE_URL
    || 'https://lcgaoiqwwpyqndaucyzu.supabase.co').replace(/\/+$/, '');
// The anon key is a PUBLIC key — it already ships inside the tracker bundle.
// It only identifies the project; the user's own access token is what actually
// authorises the lookup below.
const SUPABASE_ANON_KEY = process.env.INFLIGHT_SUPABASE_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjZ2FvaXF3d3B5cW5kYXVjeXp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNjkyOTksImV4cCI6MjA4NzY0NTI5OX0.9TO21knXR_P9E80pea7gUOu-gTjb17sCGk7BYgRRe3U';

const GROUP_TTL_DAYS = parseInt(process.env.VA_GROUP_TTL_DAYS, 10) || 30;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://inflight.info').replace(/\/+$/, '');

const MAX_AIRCRAFT = 24;      // a formation, not the whole server
const MAX_TITLE = 90;

/* ===========================================================================
 * Identity — verify a tracker sign-in without trusting the browser
 * =========================================================================== */

// Ask Supabase who this access token belongs to. Returns { id, email } for a
// signed-in, email-CONFIRMED account, or null for anything else. Short timeout:
// this sits in front of a user action, and a slow identity provider should
// surface as "try again", not a hung request.
async function resolveSupabaseUser(accessToken) {
    const token = String(accessToken || '').trim();
    // Cheap shape check first so obvious junk never becomes an outbound request.
    if (!token || token.length < 20 || token.length > 4000) return null;
    try {
        const res = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
            timeout: 8000,
            validateStatus: (s) => s === 200 || s === 401 || s === 403,
        });
        if (res.status !== 200 || !res.data) return null;
        const u = res.data;
        const email = String(u.email || '').trim().toLowerCase();
        if (!email) return null;
        // An address nobody has proved they can read is not an identity. Without
        // this, signing up as the VA's contact address would be enough to seize
        // the listing.
        if (!u.email_confirmed_at && !u.confirmed_at) return null;
        return { id: String(u.id || ''), email };
    } catch (err) {
        console.warn('[va-group] identity lookup failed:', err.message);
        return null;
    }
}

/* ===========================================================================
 * Model
 * =========================================================================== */

// Short, unambiguous share code. No vowels (can't spell anything), no 0/O/1/I/l
// (can't be mistyped off a screenshot). 7 chars from a 29-symbol alphabet is
// ~10^10 combinations — far beyond anything worth guessing at, and still short
// enough that the whole link fits in a forum signature.
const CODE_ALPHABET = '23456789bcdfghjkmnpqrstvwxyz';
function makeCode(len = 7) {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}

const GroupFlightSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true },
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    vaName: { type: String, default: '' },
    vaLogoUrl: { type: String, default: '' },
    title: { type: String, required: true, trim: true, maxlength: MAX_TITLE },
    // Which Infinite Flight server the formation is on, so an arriving viewer
    // can be switched to it before we go looking for the flights.
    server: { type: String, default: '' },
    // Supabase user id of the owner who published it — the audit trail for
    // "who put this out under our name".
    createdByUserId: { type: String, default: '' },
    createdByEmail: { type: String, default: '' },
    // The formation as it stood at publish time. flightId is what the tracker
    // re-finds live; the rest is the fallback that keeps the link readable once
    // the flights have ended.
    aircraft: {
        type: [{
            _id: false,
            flightId: String,
            callsign: String,
            username: String,
            aircraft: String,
            livery: String,
            dep: String,
            arr: String,
            lat: Number,
            lon: Number,
            altFt: Number,
            gsKt: Number,
            headingDeg: Number,
        }],
        default: [],
    },
    views: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
});
// Self-deleting: a group link is for an event happening now, not an archive.
GroupFlightSchema.index({ createdAt: 1 }, { expireAfterSeconds: GROUP_TTL_DAYS * 86400 });
GroupFlightSchema.index({ vaAdId: 1, createdAt: -1 });

const GroupFlight = mongoose.models.GroupFlight || mongoose.model('GroupFlight', GroupFlightSchema);

/* ===========================================================================
 * Helpers
 * =========================================================================== */

const dbUp = () => mongoose.connection.readyState === 1;
const shareUrlFor = (code) => `${PUBLIC_BASE_URL}/?g=${code}`;

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Normalise one aircraft the tracker offered us. Everything is length-bounded —
// this is client-supplied data that ends up rendered on a public page.
function cleanAircraft(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const flightId = String(raw.flightId || raw.id || '').trim().slice(0, 64);
    if (!flightId) return null;
    return {
        flightId,
        callsign: String(raw.callsign || '').trim().slice(0, 32),
        username: String(raw.username || '').trim().slice(0, 40),
        aircraft: String(raw.aircraft || '').trim().slice(0, 60),
        livery: String(raw.livery || '').trim().slice(0, 60),
        dep: String(raw.dep || '').trim().toUpperCase().slice(0, 4),
        arr: String(raw.arr || '').trim().toUpperCase().slice(0, 4),
        lat: num(raw.lat), lon: num(raw.lon),
        altFt: Math.round(num(raw.altFt) || 0),
        gsKt: Math.round(num(raw.gsKt) || 0),
        headingDeg: Math.round(num(raw.headingDeg) || 0),
    };
}

// Public shape of a group — what the watch view and the preview page both read.
function publicGroup(doc) {
    return {
        code: doc.code,
        title: doc.title,
        server: doc.server || '',
        va: {
            id: String(doc.vaAdId || ''),
            name: doc.vaName || '',
            logo: doc.vaLogoUrl || '',
        },
        aircraft: (doc.aircraft || []).map(a => ({
            flightId: a.flightId,
            callsign: a.callsign || '',
            username: a.username || '',
            aircraft: a.aircraft || '',
            livery: a.livery || '',
            dep: a.dep || '',
            arr: a.arr || '',
            position: (a.lat != null && a.lon != null)
                ? { lat: a.lat, lon: a.lon, alt_ft: a.altFt || 0, gs_kt: a.gsKt || 0, heading_deg: a.headingDeg || 0 }
                : null,
        })),
        count: (doc.aircraft || []).length,
        createdAt: doc.createdAt,
        shareUrl: shareUrlFor(doc.code),
    };
}

/* ===========================================================================
 * Routes
 * =========================================================================== */

/**
 * @param {object} app                express app
 * @param {object} deps
 *   VirtualAirlineAd  the listing model (ownership lives on it)
 *   VaEvent           optional; lets a publish attach its code to a scheduled event
 *   requireAuth       staff guard, for the staff-side release/list routes
 *   vaStats           optional; group publishes are counted for the daily report
 */
function registerGroupFlightRoutes(app, { VirtualAirlineAd, VaEvent, requireAuth, vaStats } = {}) {
    // Resolve the caller's identity, then the VA they own. Returns
    // { user, ad } or null. Used by every owner-gated route below.
    const resolveOwner = async (accessToken) => {
        const user = await resolveSupabaseUser(accessToken);
        if (!user || !dbUp()) return null;
        const ad = await VirtualAirlineAd.findOne({ groupOwnerUserId: user.id })
            .select('_id name logoUrl groupOwnerUserId groupOwnerEmail').lean();
        return ad ? { user, ad } : { user, ad: null };
    };

    // --- Claim: bind this signed-in account to the VA whose contact email it
    // matches. Idempotent for the holder; refused for anyone else.
    app.post('/api/va-link/claim', async (req, res) => {
        try {
            if (!dbUp()) return res.status(503).json({ ok: false, error: 'Service unavailable, try again shortly.' });
            const user = await resolveSupabaseUser((req.body || {}).accessToken);
            if (!user) {
                return res.status(401).json({ ok: false, error: 'Sign in to Inflight with a confirmed email address first.' });
            }

            // Already holds one? Hand it straight back — re-claiming from a new
            // device must not read as an error.
            const existing = await VirtualAirlineAd.findOne({ groupOwnerUserId: user.id })
                .select('_id name logoUrl').lean();
            if (existing) {
                return res.json({ ok: true, claimed: true, alreadyOwner: true, va: { id: String(existing._id), name: existing.name, logo: existing.logoUrl || '' } });
            }

            const ad = await VirtualAirlineAd.findOne({ contactEmail: user.email, status: 'approved' })
                .select('_id name logoUrl groupOwnerUserId groupOwnerEmail');
            if (!ad) {
                return res.status(404).json({
                    ok: false,
                    error: 'No partnered VA is registered to that email address. Use the address on file for your partnership, or ask us to update it.',
                });
            }
            // One account per VA. A second person on the same shared inbox gets a
            // clear "someone already holds this" rather than silently taking over.
            if (ad.groupOwnerUserId && ad.groupOwnerUserId !== user.id) {
                return res.status(409).json({
                    ok: false,
                    error: 'This VA is already linked to another Inflight account. Contact us if it needs to be moved.',
                });
            }

            ad.groupOwnerUserId = user.id;
            ad.groupOwnerEmail = user.email;
            ad.groupOwnerClaimedAt = new Date();
            await ad.save();
            console.log(`[va-group] "${ad.name}" claimed by ${user.email}`);
            res.json({ ok: true, claimed: true, va: { id: String(ad._id), name: ad.name, logo: ad.logoUrl || '' } });
        } catch (err) {
            console.error('[va-group] claim failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not link your account right now.' });
        }
    });

    // --- Who am I? The tracker calls this on sign-in to decide whether to show
    // the group-flight controls at all.
    app.post('/api/va-link/me', async (req, res) => {
        try {
            const out = await resolveOwner((req.body || {}).accessToken);
            if (!out) return res.json({ ok: true, signedIn: false, va: null });
            if (!out.ad) return res.json({ ok: true, signedIn: true, va: null, email: out.user.email });
            res.json({
                ok: true,
                signedIn: true,
                email: out.user.email,
                va: { id: String(out.ad._id), name: out.ad.name, logo: out.ad.logoUrl || '' },
            });
        } catch (err) {
            console.error('[va-group] me failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not check your account.' });
        }
    });

    // --- Publish a group flight.
    app.post('/api/group-flights', async (req, res) => {
        try {
            if (!dbUp()) return res.status(503).json({ ok: false, error: 'Service unavailable, try again shortly.' });
            const b = req.body || {};
            const out = await resolveOwner(b.accessToken);
            if (!out) return res.status(401).json({ ok: false, error: 'Sign in first.' });
            if (!out.ad) return res.status(403).json({ ok: false, error: 'Link your VA to this account before publishing a group flight.' });

            const title = String(b.title || '').trim().slice(0, MAX_TITLE);
            if (!title) return res.status(400).json({ ok: false, error: 'Give the group flight a title.' });

            const aircraft = (Array.isArray(b.aircraft) ? b.aircraft : [])
                .map(cleanAircraft).filter(Boolean).slice(0, MAX_AIRCRAFT);
            // De-dupe: the same flight selected twice would draw a zero-length
            // link between an aircraft and itself in the watch view.
            const seen = new Set();
            const unique = aircraft.filter(a => !seen.has(a.flightId) && seen.add(a.flightId));
            if (unique.length < 2) {
                return res.status(400).json({ ok: false, error: 'Pick at least two aircraft for a group flight.' });
            }

            // Retry on the (vanishingly unlikely) code collision rather than
            // handing the user an error for something we can just re-roll.
            let doc = null;
            for (let attempt = 0; attempt < 5 && !doc; attempt += 1) {
                try {
                    doc = await GroupFlight.create({
                        code: makeCode(),
                        vaAdId: out.ad._id,
                        vaName: out.ad.name,
                        vaLogoUrl: out.ad.logoUrl || '',
                        title,
                        server: String(b.server || '').trim().slice(0, 40),
                        createdByUserId: out.user.id,
                        createdByEmail: out.user.email,
                        aircraft: unique,
                    });
                } catch (err) {
                    if (!(err && err.code === 11000)) throw err;
                }
            }
            if (!doc) return res.status(500).json({ ok: false, error: 'Could not mint a link, please try again.' });

            // Optionally bind it to one of the VA's scheduled events, so the
            // event card on the tracker turns into "watch live" the moment the
            // formation departs. Scoped to the owner's own VA — an event id from
            // another VA is ignored rather than honoured.
            let linkedEventId = null;
            const eventId = String(b.eventId || '').trim();
            if (VaEvent && eventId && mongoose.Types.ObjectId.isValid(eventId)) {
                try {
                    const upd = await VaEvent.updateOne(
                        { _id: eventId, vaAdId: out.ad._id },
                        { $set: { groupCode: doc.code } },
                    );
                    if (upd.matchedCount) linkedEventId = eventId;
                } catch (err) { console.warn('[va-group] event link failed:', err.message); }
            }

            // Feed the daily report: the VA's own scorecard should say a group
            // flight went out and how big it was.
            if (vaStats) {
                try {
                    vaStats.recordEngagement(out.ad._id, 'groupFlight', 1, out.ad.name);
                    vaStats.recordGroupFlight(out.ad._id, out.ad.name, { title, size: unique.length, code: doc.code });
                } catch (err) { console.warn('[va-group] stats hook failed:', err.message); }
            }

            console.log(`[va-group] "${out.ad.name}" published "${title}" (${unique.length} aircraft) as ${doc.code}`);
            res.status(201).json({ ok: true, ...publicGroup(doc), linkedEventId });
        } catch (err) {
            console.error('[va-group] publish failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not publish the group flight.' });
        }
    });

    // --- Read a group. Public: this is what a share link resolves to.
    app.get('/api/group-flights/:code', async (req, res) => {
        try {
            if (!dbUp()) return res.status(503).json({ ok: false, error: 'unavailable' });
            const code = String(req.params.code || '').trim().toLowerCase().slice(0, 16);
            const doc = await GroupFlight.findOne({ code }).lean();
            if (!doc) return res.status(404).json({ ok: false, error: 'That group flight link has expired or never existed.' });
            GroupFlight.updateOne({ code }, { $inc: { views: 1 } }).catch(() => {});
            res.set('Cache-Control', 'no-store');
            res.json({ ok: true, ...publicGroup(doc) });
        } catch (err) {
            console.error('[va-group] read failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not load that group flight.' });
        }
    });

    // --- The owner's own recent groups, so they can re-copy a link.
    app.post('/api/group-flights/mine', async (req, res) => {
        try {
            const out = await resolveOwner((req.body || {}).accessToken);
            if (!out || !out.ad) return res.status(403).json({ ok: false, error: 'Not linked to a VA.' });
            const rows = await GroupFlight.find({ vaAdId: out.ad._id })
                .sort({ createdAt: -1 }).limit(20).lean();
            res.json({ ok: true, groups: rows.map(publicGroup) });
        } catch (err) {
            console.error('[va-group] mine failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not load your group flights.' });
        }
    });

    // --- Delete one (the owner pulled the wrong aircraft in, say).
    app.post('/api/group-flights/:code/delete', async (req, res) => {
        try {
            const out = await resolveOwner((req.body || {}).accessToken);
            if (!out || !out.ad) return res.status(403).json({ ok: false, error: 'Not linked to a VA.' });
            const code = String(req.params.code || '').trim().toLowerCase().slice(0, 16);
            const del = await GroupFlight.deleteOne({ code, vaAdId: out.ad._id });
            if (!del.deletedCount) return res.status(404).json({ ok: false, error: 'Not found.' });
            res.json({ ok: true });
        } catch (err) {
            console.error('[va-group] delete failed:', err.message);
            res.status(500).json({ ok: false, error: 'Could not delete that group flight.' });
        }
    });

    // --- /g/<code> — the link-preview page.
    //
    // Pasting on the IFC (or Discord, or anywhere that unfurls) should show the
    // event, not a bare URL. This serves Open Graph tags for the crawler and
    // bounces a human straight to the tracker. It lives on this backend because
    // the tracker's host serves a single-page app with no per-group tags of its
    // own — and this needs no serverless function to exist.
    app.get('/g/:code', async (req, res) => {
        const code = String(req.params.code || '').trim().toLowerCase().slice(0, 16);
        const target = shareUrlFor(code);
        let doc = null;
        try { if (dbUp()) doc = await GroupFlight.findOne({ code }).lean(); } catch { /* render the generic card */ }

        const title = doc ? `${doc.title} — ${doc.vaName || 'Group flight'}` : 'Group flight — Inflight';
        const count = doc ? (doc.aircraft || []).length : 0;
        const routes = doc
            ? [...new Set((doc.aircraft || []).map(a => `${a.dep || '????'}→${a.arr || '????'}`))].slice(0, 3).join(', ')
            : '';
        const desc = doc
            ? `${count} aircraft flying together${routes ? ` · ${routes}` : ''}. Watch them live on Inflight.`
            : 'This group flight link has expired.';
        const image = (doc && doc.vaLogoUrl) || `${PUBLIC_BASE_URL}/assets/brand/inflight-logo.png`;

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=120');
        res.send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Inflight">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(target)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="canonical" href="${esc(target)}">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6e9ef;
       font:500 15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:24px}
  a{color:#60a5fa}
  .t{font-size:1.25rem;font-weight:800;margin:0 0 6px}
  .s{opacity:.7;margin:0 0 18px}
</style>
</head><body>
<div>
  <p class="t">${esc(doc ? doc.title : 'Group flight')}</p>
  <p class="s">${esc(desc)}</p>
  <p><a href="${esc(target)}">Open it on Inflight →</a></p>
</div>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`);
    });

    // --- Staff: release a VA's binding so it can be claimed again (the VA
    // changed hands, or someone claimed it by mistake).
    if (requireAuth) {
        app.post('/api/admin/va-link/:id/release', requireAuth, async (req, res) => {
            try {
                const ad = await VirtualAirlineAd.findById(req.params.id).select('name groupOwnerUserId groupOwnerEmail');
                if (!ad) return res.status(404).json({ error: 'VA not found.' });
                const was = ad.groupOwnerEmail || '';
                ad.groupOwnerUserId = null;
                ad.groupOwnerEmail = null;
                ad.groupOwnerClaimedAt = null;
                await ad.save();
                console.log(`[va-group] "${ad.name}" ownership released (was ${was || 'unclaimed'})`);
                res.json({ ok: true, released: was });
            } catch (err) {
                console.error('[va-group] release failed:', err.message);
                res.status(500).json({ error: 'Could not release that link.' });
            }
        });

        // Staff view of every published group, newest first.
        app.get('/api/admin/group-flights', requireAuth, async (req, res) => {
            try {
                // Without this the query sits in Mongoose's buffer for 10s
                // before failing, so a staff page hangs instead of saying so.
                if (!dbUp()) return res.status(503).json({ error: 'Database unavailable.' });
                const rows = await GroupFlight.find({})
                    .sort({ createdAt: -1 })
                    .limit(Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 40)))
                    .lean();
                res.json({ ok: true, groups: rows.map(d => ({ ...publicGroup(d), views: d.views || 0, createdByEmail: d.createdByEmail || '' })) });
            } catch (err) {
                console.error('[va-group] admin list failed:', err.message);
                res.status(500).json({ error: 'Could not load group flights.' });
            }
        });
    }
}

module.exports = {
    GroupFlight,
    registerGroupFlightRoutes,
    resolveSupabaseUser,
    shareUrlFor,
    MAX_AIRCRAFT,
};

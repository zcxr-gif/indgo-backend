// server.js
// A lightweight backend for Community Aircraft Contributions and Flight Trail Storage.

const {
    uploadAirportImage,
    getAirportInfo,
    deleteAirportImages,
    updateAirportMetadata
} = require('./airports');

// VA Advertisement image helpers (banner + logo -> S3 as WebP)
const { uploadVaImage, deleteVaImage } = require('./vaAds');

// Staff portal authentication (per-user accounts, JWT cookie).
const {
    registerAuthRoutes,
    bootstrapAdmin,
    requireAuth,
    requireAdmin,
    requireAuthPage,
} = require('./staffAuth');

// VA Partnership Portal (partner-facing logins, submissions, oversight).
const {
    registerVaPortalRoutes,
    provisionOwnerAccount,
    provisionRepAccount,
    deactivateRepAccount,
    purgeVaData,
    VaPortalAccount,
    VaSubmission,
    VaEvent,
    VaWarning,
    requirePortal: requireVaPortalSession,
} = require('./vaPortal');

// Crew Center sign-in (inflight.info/crew/<slug>) — cascades our existing
// accounts (VA portal accounts + Inflight staff) and routes to the right view.
const { registerCrewAuthRoutes, verifyCrewRequest, effectiveCaps, cleanDiscordInvite } = require('./crewAuth');

// VA statistics engine — reach/engagement counters from the tracker plus flight
// operations derived from the ACARS takeoff/landing feed, summarised per day,
// reported to each VA's webhook at end of day and then erased. See vaStats.js.
const vaStats = require('./vaStats');

// Where a VA's crew data lives. Rosters, flight reports and applications belong
// to the VA and are stored in the VA's OWN Supabase project; we keep only their
// staff logins and their directory/branding metadata. crewStore hides which of
// the two backends (their Postgres, or our legacy managed collections for VAs
// that have not migrated yet) is answering. See crewStore.js.
const crewStore = require('./crewStore');
const { resolveGrade } = require('./ifGrade');

// Pilot logins. A pilot's account is the VA's data like their hours are, so it
// is created in and read from the VA's own project through crewStore — Inflight
// keeps only the VA's staff logins. See crewAccounts.js.
const crewAccounts = require('./crewAccounts');

// The invitation an accepted applicant is handed — the temporary password, the
// message staff paste to them on the IFC, and the lifecycle that clears the
// credential once it has been used, thrown away or left to age out. Nothing
// outside this module may read the stored password directly. See crewInvite.js.
const crewInvite = require('./crewInvite');

// Roster and route network in and out as CSV — the same columns both ways, so a
// VA can take their data to a spreadsheet and bring it back. See crewCsv.js.
const crewCsv = require('./crewCsv');

// The VA's rank ladder. Rank is DERIVED from hours rather than stored, and it
// is derived here so the server, the dashboard and the pilot view cannot
// disagree — and so a rank can gate something. See crewRanks.js.
const crewRanks = require('./crewRanks');

// Events, and the gate board that stops a dozen aircraft spawning on the same
// stand. Everything that is a decision rather than a database write lives
// there — including where the stands themselves come from. See crewEvents.js.
const crewEvents = require('./crewEvents');
const crewInsights = require('./crewInsights');

// The airline's ordinary week: which legs are flown when, and who has taken
// them. Events gather everyone at one departure; a schedule is many departures
// each flown by one pilot. Seat allocation, repetition and what a departure is
// allowed to say live there. See crewSchedules.js.
const crewSchedules = require('./crewSchedules');
const crewRetention = require('./crewRetention');

// One-paste setup for a VA's Supabase project: given a Supabase access token we
// install the schema, read the project's keys back and store the connection
// ourselves, so nobody has to hand-copy three values between two dashboards.
// The token is used for the request, and kept afterwards only if the VA asks us
// to — sealed, and only so later schema updates need no second visit to
// supabase.com. See crewSetup.js.
const crewSetup = require('./crewSetup');

// AES-256-GCM at rest for the VA secrets we do keep — today, the Supabase
// access token above. The key lives in the environment, not the database. See
// crewSecrets.js.
const crewSecrets = require('./crewSecrets');

// Group flights — a VA owner selects the aircraft flying their event and mints
// one short link to share. Ownership is claimed with the contact email already
// on file for the partnership. See vaGroupFlights.js.
const vaGroupFlights = require('./vaGroupFlights');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const axios = require('axios'); // Added for Webhook
const crypto = require('crypto'); // <--- ADDED for IP Hashing
const { 
    S3Client, 
    PutObjectCommand, 
    DeleteObjectCommand, 
    ListObjectsV2Command,
    GetObjectCommand
} = require('@aws-sdk/client-s3');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const sharp = require('sharp'); // Image processing library
require('dotenv').config();
const fs = require('fs');
const os = require('os');

// MEMORY FIX: Disable Sharp's internal cache to prevent RAM balloons
sharp.cache(false);
sharp.concurrency(1);

// STABILITY: Keep the backend alive when the bot (or anything else) misbehaves.
// Without these, a single rejected promise inside discord.js takes down the API.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️  Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️  Uncaught Exception:', err && err.stack ? err.stack : err);
});

// IMPORT THE BOT
const { startDiscordBot, submitWebAircraftReview, resolveAircraftMatch, getBotStats } = require('./bot');

// Live backend diagnostics (memory / CPU / event-loop / per-route timing).
// Powers the /diagnostics terminal. Kept intentionally low-overhead.
const diagnostics = require('./diagnostics');

// 1. INITIALIZE APP
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Allow all origins
// Increase limit for JSON body (trails can be large)
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Trust Proxy (Required if behind Nginx/Heroku/Cloudflare to get real IPs)
app.set('trust proxy', 1);

// Per-request timing for the diagnostics terminal. Mounted before the routes so
// it observes the full handling time; it only attaches a res 'finish' listener.
app.use(diagnostics.middleware());

// 2. CONNECT TO MONGODB
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB Connected');
        // Create the first staff admin from env vars if no accounts exist yet.
        bootstrapAdmin();
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const CommunityAircraftSchema = new mongoose.Schema({
    contributorName: { type: String, default: "System" }, // Default to system for pre-filled
    contributorId: { type: String, required: false },
    aircraftType: { type: String, required: true },
    liveryName: { type: String, required: true },
    tailNumber: { type: String, required: true, unique: true }, // Ensure no duplicates
    imageUrl: { type: String, required: false, default: null }, // Primary image (kept for backward compatibility)
    imageUrls: { type: [String], default: [] }, // NEW: Up to 3 images per aircraft (imageUrl mirrors imageUrls[0])
    // Per-image contributor info, aligned by index to imageUrls. Different images
    // on the same aircraft can be supplied by different people, so each slot tracks
    // its own contributor. The legacy top-level contributorName/Id mirror slot 0.
    imageContributors: {
        type: [{
            name: { type: String, default: "System" },
            id: { type: String, default: null }
        }],
        default: [],
        _id: false
    },
    needsUpdate: { type: Boolean, default: false }, // NEW: Flag for image updates
    uploadedAt: { type: Date, default: Date.now }
});

// Indexes: every hot query path now hits an index instead of scanning.
CommunityAircraftSchema.index({ contributorId: 1 });
CommunityAircraftSchema.index({ contributorName: 1 });
CommunityAircraftSchema.index({ aircraftType: 1, liveryName: 1 });
CommunityAircraftSchema.index({ needsUpdate: 1 });
CommunityAircraftSchema.index({ uploadedAt: -1 });

const CommunityAircraft = mongoose.model('CommunityAircraft', CommunityAircraftSchema);

/* =========================
 * NEW: GATES SCHEMA
 * ========================= */
const AirportGateSchema = new mongoose.Schema({
    airportCode: { type: String, required: true, unique: true, index: true }, // e.g., "KJFK"
    gates: { type: mongoose.Schema.Types.Mixed, required: true }, // Flexible to hold the specific gate array structure
    updatedAt: { type: Date, default: Date.now }
});

const AirportGate = mongoose.model('AirportGate', AirportGateSchema);

/* =========================
 * VIRTUAL AIRLINE ADVERTISEMENT SCHEMA
 *
 * Backs the VA advertising directory: Infinite Flight virtual airlines (VA)
 * and virtual organizations (VO) get a banner + info to recruit pilots.
 *
 * Entries are created by admins/staff only (no public submission form), so they
 * default to `status: "approved"` and go live immediately. The status field is
 * kept as a simple show/hide switch — set "pending" to stage a draft or
 * "rejected" to archive an ad without deleting it. Approved ads can be
 * `featured` to pin them to the top, and lightweight view/click counters let
 * each VA measure how its ad is performing without a separate analytics service.
 * ========================= */
const VA_AD_STATUSES = ['pending', 'approved', 'rejected'];
const VA_AD_TYPES = ['VA', 'VO']; // Virtual Airline vs Virtual Organization (IF terminology)

const VirtualAirlineAdSchema = new mongoose.Schema({
    // --- Identity ---
    name: { type: String, required: true, unique: true, trim: true },
    // Primary radio callsign base, kept for back-compat with everything that
    // reads a single callsign (bot matching, embeds, indexes). Always mirrors
    // callsigns[0] when any callsigns are set (see the pre-save hook below).
    callsign: { type: String, trim: true, uppercase: true, default: null }, // e.g. "IGO", "SPEEDBIRD"
    // A VA may fly under several callsigns (e.g. a parent brand + sub-fleets).
    // The first entry is treated as the primary and synced into `callsign`.
    callsigns: { type: [String], default: [] },
    type: { type: String, enum: VA_AD_TYPES, default: 'VA' },

    // URL handle for the VA's Crew Center — inflight.info/crew/<slug>. Unique
    // when set; auto-derived from `name` on save when left blank (see the slug
    // pre-save hook + slugifyVaName), and overridable by staff in the Crew
    // Centers manager. Stored lowercase; sparse-unique so legacy docs without a
    // slug don't collide on null.
    slug: { type: String, trim: true, lowercase: true, default: null },

    // Crew Center layout the VA lands on, and the presets staff permit them to
    // choose from. The VA picks from allowedLayouts in their crew center settings;
    // staff manage the allow-list in the Crew Centers tool.
    layout: { type: String, default: 'editorial' },
    allowedLayouts: { type: [String], default: ['editorial', 'console', 'split', 'classic'] },
    // Which login-page look the VA uses (owner-chosen). See the crew.html looks.
    loginLook: { type: String, default: 'center' },
    // How a crew center topic opens: 'sheet' (a slide-over on the dashboard) or
    // 'page' (the topic takes the window and gets its own link). Owner-chosen,
    // and only the crew's default — a device that has picked for itself keeps
    // its choice. See crewTopicWindows.js in the tracker.
    crewTopicMode: { type: String, default: 'sheet' },
    // Owner/staff-chosen accent for the crew center + login. Overrides the accent
    // otherwise derived from the VA's embed config. '' = fall back to that.
    crewAccent: { type: String, trim: true, default: '' },

    // Crew structure the VA defines (all optional): a rank ladder + roles, each
    // carrying a badge (colour + icon). These are the DEFINITIONS; per-pilot
    // assignments live in the VA's own Supabase.
    ranks: { type: [{ _id: false, name: String, minHours: Number, color: String, icon: String, image: String }], default: [] },
    roles: { type: [{ _id: false, name: String, color: String, icon: String, image: String, staff: Boolean }], default: [] },
    // Owner-defined STAFF roles (permissions) + which staff account (by login
    // username) holds each. Distinct from the display `roles` above: these gate
    // what a signed-in staff member can do. See crewAuth CREW_CAPABILITIES.
    staffRoles: { type: [{ _id: false, id: String, name: String, color: String, permissions: [String] }], default: [] },
    staffAssignments: { type: [{ _id: false, username: String, roleId: String }], default: [] },
    // The VA's fleet — aircraft they operate (name/type + optional livery image).
    // NOTE: named crewFleet (not fleet) to avoid colliding with the older
    // directory-level `fleet: [String]` field further down this schema.
    crewFleet: { type: [{ _id: false, type: String, name: String, image: String }], default: [] },
    // Auto-PIREP handling. false (default) = auto-captured flights land as pending
    // for staff review; true = a flight that matches the fleet is approved on
    // capture and its hours roll straight onto the roster.
    crewPirepAutoApprove: { type: Boolean, default: false },

    // --- The schedule, as the VA chooses to run it (v8) ---
    //
    // Airlines run bidding very differently and the crew center should not have
    // an opinion. Some publish a week and let anyone take anything; some assign
    // every leg by hand; some open the schedule to First Officers and up and
    // nobody else. All of that is this object, and every field of it is
    // enforced on the SERVER — the panel reads these to explain a refusal
    // before it happens, but it is not what makes the refusal.
    //
    // The rules live centrally, with the rank ladder and the fleet, rather than
    // in the VA's own Postgres: they are definitions of how the airline is run,
    // the same class of thing as `ranks`, and the crew center reads them before
    // it has a store connection to read anything else from.
    crewSchedule: {
        // The whole feature. Off hides the panel, the tile and the hero button
        // — a VA that assigns flying in Discord should not have a schedule tab
        // that is permanently empty. Existing VAs default ON: the feature is
        // new, nobody has opted into anything, and a crew center that quietly
        // hid a section they had not asked to hide would read as a bug.
        enabled: { type: Boolean, default: true },
        // 'pilots' — anyone who meets the rank takes what they want.
        // 'staff'  — staff assign every leg; pilots read the schedule and
        //            cannot book. Not the same as disabling the feature: the
        //            schedule is still published, it is just not self-service.
        booking: { type: String, enum: ['pilots', 'staff'], default: 'pilots' },
        // The rung the schedule OPENS at, airline-wide. Names a rank exactly as
        // crew_routes.min_rank and crew_events.min_rank do, and for the same
        // reason: what a rank is worth is decided in one place. A per-departure
        // min_rank still applies on top — it can raise the bar for one leg, and
        // deliberately cannot lower it below this.
        minRank: { type: String, trim: true, default: '' },
        // How many upcoming legs one pilot may be holding at once. 0 = as many
        // as they like. This is the rule that stops one keen pilot taking the
        // whole week ten minutes after it is published, which is the failure
        // every VA running a schedule eventually writes a Discord rule about.
        maxPerPilot: { type: Number, default: 0, min: 0, max: 50 },
        // Booking opens this many days before departure. 0 = as soon as it is
        // published. Non-zero is how a VA runs a fair weekly bid instead of a
        // race to whoever was online when staff pressed publish.
        openDaysAhead: { type: Number, default: 0, min: 0, max: 365 },
        // How close to departure a pilot may still hand a leg back. 0 = right
        // up to the moment. Non-zero gives staff time to find cover rather than
        // discovering an empty seat at pushback.
        cancelHoursBefore: { type: Number, default: 0, min: 0, max: 336 },
    },

    // How this VA keeps its roster honest — the probation window a new recruit
    // has to fly their first flight in, and the silence after which an
    // established pilot stops counting as active. Stored here beside the rank
    // ladder and the schedule rules because it is the same class of thing: a
    // definition of how the airline is run, not operational data.
    //
    // OFF unless a VA switches it on, and every sub-rule off inside that. This
    // is the one settings block in the product that DELETES PEOPLE, so it does
    // not get a helpful default. Bounds are enforced again in crewRetention's
    // normalizeRules — the module that also applies them — so a value saved
    // here cannot mean something different when it runs.
    crewRetention: {
        enabled: { type: Boolean, default: false },
        // Probation: fly and log one flight within firstFlightDays of joining.
        firstFlight: { type: Boolean, default: false },
        firstFlightDays: { type: Number, default: 7, min: 1, max: 90 },
        firstFlightAction: { type: String, enum: ['remove', 'inactive'], default: 'remove' },
        firstFlightWarnDays: { type: Number, default: 2, min: 0, max: 30 },
        // Inactivity: no validated flight in inactivityDays.
        inactivity: { type: Boolean, default: false },
        inactivityDays: { type: Number, default: 30, min: 7, max: 365 },
        inactivityAction: { type: String, enum: ['remove', 'inactive'], default: 'inactive' },
        inactivityWarnDays: { type: Number, default: 7, min: 0, max: 60 },
        // A VA's own staff are not swept by default; running the airline is not
        // the same as flying it.
        exemptStaff: { type: Boolean, default: true },
    },

    // --- Recruitment / join settings ---
    // joinMode: 'free' = instant account; 'application' = staff review.
    joinMode: { type: String, enum: ['free', 'application'], default: 'application' },
    callsignPrefix: { type: String, trim: true, default: '' }, // default prefix for pilot callsigns
    // A staff-built application form: ordered questions.
    applicationForm: { type: [{ _id: false, label: String, type: String, options: [String], required: Boolean }], default: [] },
    // Extensible join requirements. Auto types are checked against the
    // applicant's REAL Infinite Flight stats (verified through our tooling);
    // 'agree' is a custom checkbox the applicant must tick.
    //   type: 'grade'|'hours'|'landings'|'xp'|'flights'|'violations'|'agree'
    //   value: numeric threshold (min for most, MAX for 'violations')
    //   label: custom text (used by 'agree', optional note for others)
    //   required: for 'agree', whether ticking is mandatory
    joinRequirements: { type: [{ _id: false, type: String, value: Number, label: String, required: Boolean }], default: [] },
    // A Discord webhook the VA sets so recruitment activity (new applications,
    // accept / decline decisions + the staff's message) is posted to their
    // server. Secret (contains a token) → select:false, never echoed back.
    crewWebhookUrl: { type: String, trim: true, default: null, select: false },

    // Per-feed webhooks. Each is optional and each falls back to
    // crewWebhookUrl above, which means a VA that wants one Discord channel for
    // everything sets exactly one URL and is done — and a VA that wants
    // recruitment in #staff, flights in #pireps and network changes in
    // #ops-notices sets three. That fallback is why adding these breaks nothing
    // for the VAs already running on the single hook.
    //
    // Secret, like the one above: a Discord webhook URL contains its own token,
    // so it is select:false and is never echoed back to a browser (see
    // maskWebhookUrl).
    crewWebhooks: {
        type: new mongoose.Schema({
            // New applications, accept/decline decisions, and pilots joining.
            recruitment: { type: String, trim: true, default: '' },
            // Flight reports filed, approved and rejected — one feed, plus the
            // promotions those approvals cause.
            pireps:      { type: String, trim: true, default: '' },
            // Route network changes: added, edited, removed, imported.
            routes:      { type: String, trim: true, default: '' },
            // Events published, changed and cancelled. Deliberately not
            // signups: a popular event would fire forty embeds in an evening,
            // which is how a channel gets muted.
            events:      { type: String, trim: true, default: '' },
            // The roster sweep: first-flight warnings and deadlines, inactivity
            // warnings and deadlines. Its own feed rather than riding
            // recruitment, because the audience is different — recruitment is
            // "somebody wants in", this is "somebody is on their way out", and
            // a VA usually wants the second one where staff will actually see
            // it rather than in the channel that pings on every application.
            retention:   { type: String, trim: true, default: '' },
        }, { _id: false }),
        default: () => ({}),
        select: false,
    },

    // The VA's Discord INVITE (not the webhook above — this one is public and
    // shareable). Handed to a pilot when their application is accepted, so
    // "you're in" and "here's where the crew talks" arrive together. Set once
    // here; the accept dialog pre-fills from it and can override per pilot
    // (a one-time or role-specific invite). Validated as a real Discord invite
    // link — see isDiscordInviteUrl.
    crewDiscordInvite: { type: String, trim: true, default: '' },

    // --- Bring-your-own email provider (applicant notifications) ---
    // When set, applicant emails go through the VA's OWN provider/account so
    // mail comes from their domain and their quota. Falls back to the platform
    // key when left blank. crewEmailKey is a secret → select:false.
    crewEmailProvider: { type: String, enum: ['', 'resend', 'sendgrid', 'postmark', 'mailgun'], default: '' },
    crewEmailFrom: { type: String, trim: true, default: '' },       // "VA Name <crew@va.com>"
    crewEmailReplyTo: { type: String, trim: true, default: '' },    // optional Reply-To
    crewEmailDomain: { type: String, trim: true, default: '' },     // Mailgun sending domain
    crewEmailRegion: { type: String, enum: ['us', 'eu'], default: 'us' }, // Mailgun region
    crewEmailKey: { type: String, default: '', select: false },     // API key / server token (secret)
    crewEmailConfigured: { type: Boolean, default: false },          // non-secret mirror: is BYO email ready to send?

    // --- The VA's own Supabase project (bring-your-own data store) ---
    // The VA connects their Supabase in owner onboarding; their crew data lives
    // there and stays theirs. anonKey is the PUBLIC browser key (safe to expose
    // via by-slug so the crew center can talk to their project). serviceKey is a
    // SECRET with full access — select:false so it is NEVER returned to the
    // browser; kept only for Inflight's retained server-side access.
    supabaseUrl: { type: String, trim: true, default: '' },
    supabaseAnonKey: { type: String, trim: true, default: '' },
    supabaseServiceKey: { type: String, trim: true, default: '', select: false },

    // --- The kept access token (opt-in) ---
    // A Supabase personal access token, SEALED (crewSecrets — AES-256-GCM under
    // a key that lives in the environment, never in this document), stored only
    // when the VA ticks "remember this" and deletable by them at any time.
    //
    // WHY WE KEEP ONE AT ALL. The crew center's schema gains columns as the
    // product does, and a project set up last year has not got them. Without a
    // token that upgrade means the VA going back to supabase.com, minting a new
    // token and pasting it — months after they last thought about any of this —
    // so in practice it did not happen, and the first sign of the gap was a save
    // that quietly dropped a field. With one, the update is a button, or nothing
    // at all (see supabaseAutoUpdate).
    //
    // It is used for exactly one thing: running OUR schema file against the
    // project this VA is already connected to. Never echoed to a browser, never
    // logged, never used to reach any other project on the account.
    supabaseAccessToken: { type: String, default: '', select: false },
    // Non-secret companions, safe to show staff so they can tell which token
    // they saved and when — "sbp_…9f3a", not the token.
    supabaseTokenHint: { type: String, default: '' },
    supabaseTokenSavedAt: { type: Date, default: null },
    supabaseTokenUsedAt: { type: Date, default: null },
    // Set when Supabase last rejected the stored token (revoked, or belonging to
    // another account now). Keeps us from retrying a dead credential on every
    // health check, and gives the dashboard something honest to say.
    supabaseTokenFailedAt: { type: Date, default: null },
    supabaseTokenError: { type: String, default: '' },
    // May we run a schema update on the VA's behalf when we notice their project
    // is behind? On by default WHEN A TOKEN IS SAVED (saving one is the consent;
    // this switch is the VA's way to take it back without giving up one-click
    // updates). Irrelevant with no token — nothing can run.
    supabaseAutoUpdate: { type: Boolean, default: true },
    // Stamped by the automatic updater so the dashboard can show what it did,
    // and so a project that keeps failing is not retried in a loop.
    supabaseAutoUpdatedAt: { type: Date, default: null },
    supabaseAutoUpdatedTo: { type: Number, default: 0 },

    // --- Copy ---
    tagline: { type: String, trim: true, maxlength: 140, default: '' }, // short hook
    description: { type: String, trim: true, maxlength: 4000, default: '' },

    // --- Media (S3 WebP URLs) ---
    bannerUrl: { type: String, default: null },
    logoUrl: { type: String, default: null },

    // --- Links ---
    websiteUrl: { type: String, trim: true, default: null },
    discordUrl: { type: String, trim: true, default: null },        // Discord invite
    ifcThreadUrl: { type: String, trim: true, default: null },      // Infinite Flight Community forum thread
    applicationUrl: { type: String, trim: true, default: null },    // where pilots apply / join

    // --- VA details ---
    region: { type: String, trim: true, default: 'Global' },        // e.g. "Asia", "Europe", "Global"
    hubs: { type: [String], default: [] },                          // primary hub ICAOs, e.g. ["VABB", "VIDP"]
    fleet: { type: [String], default: [] },                         // aircraft types operated
    pilotCount: { type: Number, default: 0, min: 0 },
    recruiting: { type: Boolean, default: true },                   // currently accepting applications?
    minGrade: { type: Number, default: 0, min: 0, max: 5 },         // IF grade requirement; 0 = none (single source of truth)
    requirements: { type: String, trim: true, default: '' },        // free-text joining requirements (directory display)
    tags: { type: [String], default: [] },                          // searchable keywords

    // --- Ownership / contact (who submitted) ---
    ownerName: { type: String, trim: true, default: 'Unknown' },
    ownerId: { type: String, default: null },                       // Discord ID, if submitted via bot/auth
    contactEmail: { type: String, trim: true, lowercase: true, default: null },

    // --- Moderation & promotion ---
    status: { type: String, enum: VA_AD_STATUSES, default: 'approved', index: true },
    featured: { type: Boolean, default: false },

    // --- Discord provisioning (set by the bot when a VA is approved) ---
    discordRoleId: { type: String, default: null },     // VA-specific role
    discordChannelId: { type: String, default: null },  // VA's private channel
    // Timestamp of the one-time public partnership announcement. Stays null
    // until the bot posts it (VA approved + banner + logo all present), which
    // doubles as the guard that keeps the announcement from firing twice.
    partnershipAnnouncedAt: { type: Date, default: null },

    // --- VA-managed flight event delivery (self-serve in the VA portal) ---
    // When a webhook is set AND enabled, each takeoff/landing the ACARS sender
    // attributes to this VA is ALSO posted to this Discord webhook (their own
    // channel), in addition to the central VA-events feed. The URL is a secret (anyone holding
    // it can post to that channel), so the portal never echoes it back in full —
    // see portalVa()/the PATCH handler in vaPortal.js. Validated to a Discord
    // webhook host on write to keep this from becoming an open POST relay.
    // select:false so this secret is NEVER returned by default — notably the
    // PUBLIC GET /api/va-ads list returns full ad docs. Read paths that need the
    // actual URL must opt in with .select('+flightEventsWebhookUrl').
    flightEventsWebhookUrl: { type: String, trim: true, default: null, select: false },
    flightEventsEnabled: { type: Boolean, default: true },
    // Staff gate: the feature is REQUESTED by the VA, not auto-granted. Delivery
    // (resolveVaEventPartner) only fires once a staff member approves. The request
    // timestamp lets the portal show a "pending approval" state.
    flightEventsApproved: { type: Boolean, default: false },
    flightEventsRequestedAt: { type: Date, default: null },
    // Per-VA customization of the takeoff/landing card the VA receives (colours,
    // layout, which fields to show, whether to include the aircraft photo / route
    // map). Every field is optional and falls back to the default look; the
    // Inflight brand mark is deliberately NOT customizable (always drawn on the
    // card and always in the embed footer). Shape is validated on write via
    // normalizeCardOptions() from vaEventCard.js. Only ever applied to THIS VA's
    // own webhook — the central feed always uses the default card.
    flightEventsCard: {
        accent:     { type: String, trim: true, default: '' },      // '#rrggbb' or '' = event colour
        layout:     { type: String, enum: ['card', 'compact'], default: 'card' },
        imageStyle: { type: String, enum: ['embed', 'large'], default: 'embed' }, // card/map framed in the embed vs. posted as full-width standalone attachments
        showMap:    { type: Boolean, default: true },               // post the route-map image
        showPhoto:  { type: Boolean, default: true },               // aircraft photo on the card
        photoSide:  { type: String, enum: ['right', 'left'], default: 'right' },  // which side the aircraft photo sits on
        mapStyle:   { type: String, enum: ['dark', 'midnight', 'light', 'mono'], default: 'dark' }, // route-map basemap palette
        mapLine:    { type: String, trim: true, default: '' },      // route-line colour ('#rrggbb'/name) or '' = accent
        title:      { type: String, trim: true, default: '' },      // custom embed title; '' = default
        fields:     { type: [String], default: [] },                // ordered subset; [] = default set
    },

    // --- Group-flight ownership (see vaGroupFlights.js) ---
    // A VA claims its own listing by signing in to Inflight with the SAME email
    // we already hold in contactEmail above — no extra credential. The claim
    // binds the Supabase user id here, and exactly ONE account can hold a VA, so
    // a shared inbox can't become several people publishing under one brand.
    // Staff can clear these three to hand the VA to someone else.
    groupOwnerUserId: { type: String, default: null, index: true },
    groupOwnerEmail: { type: String, default: null },
    groupOwnerClaimedAt: { type: Date, default: null },

    // --- Analytics ---
    views: { type: Number, default: 0 },                            // detail-page impressions
    clicks: { type: Number, default: 0 },                           // click-throughs on join/apply link

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Index the hot query paths: public listing filters by status, then sorts by
// featured/newest; callsign and text search back the directory's search box.
VirtualAirlineAdSchema.index({ status: 1, featured: -1, createdAt: -1 });
VirtualAirlineAdSchema.index({ region: 1 });
VirtualAirlineAdSchema.index({ callsign: 1 });
// Crew Center slug lookup (inflight.info/crew/<slug>). Sparse so the many docs
// with a null slug don't collide; unique so a slug maps to exactly one VA.
VirtualAirlineAdSchema.index({ slug: 1 }, { unique: true, sparse: true });
// Back the "which VAs are based at this airport?" lookup (e.g. to render a VA's
// banner on an airport page). hubs holds the primary hub ICAOs for each VA.
VirtualAirlineAdSchema.index({ hubs: 1 });
VirtualAirlineAdSchema.index({ name: 'text', tagline: 'text', description: 'text', tags: 'text' });

// Keep updatedAt fresh, and keep the single `callsign` field and the
// `callsigns` list reconciled so older code (which reads `callsign`) and newer
// code (which reads the array) always agree. callsigns[0] is the primary.
VirtualAirlineAdSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    if (Array.isArray(this.callsigns) && this.callsigns.length) {
        // Normalise, de-dupe (case-insensitive), and drop blanks.
        const seen = new Set();
        const cleaned = [];
        for (const c of this.callsigns) {
            const norm = cleanCallsignInput(c);
            if (norm && !seen.has(norm)) { seen.add(norm); cleaned.push(norm); }
        }
        this.callsigns = cleaned;
        this.callsign = cleaned[0] || null;
    } else if (this.callsign) {
        // Back-fill the array from a legacy single callsign.
        this.callsigns = [this.callsign];
    } else {
        this.callsigns = [];
    }
    next();
});

// Turn a VA name (or a staff-typed handle) into a URL-safe Crew Center slug:
// lowercase, accents stripped, non-alphanumerics collapsed to single hyphens.
// "Air Canada Virtual" -> "air-canada-virtual".
function slugifyVaName(s) {
    return String(s || '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .toLowerCase()
        .replace(/[’'".]/g, '')        // drop apostrophes / quotes / dots outright
        .replace(/[^a-z0-9]+/g, '-')   // any other run of non-alnum -> one hyphen
        .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
        .slice(0, 40);
}

// Fill in / normalise the Crew Center slug before save. A staff-set slug is
// slugified as-is; otherwise it's derived from the VA name. Either way we ensure
// uniqueness by appending -2, -3, … on the rare collision, so a save never fails
// on the unique index. Kept separate from the callsign hook for readability.
VirtualAirlineAdSchema.pre('save', async function (next) {
    try {
        const Model = this.constructor;
        let slug = this.slug ? slugifyVaName(this.slug) : '';
        if (!slug && this.name) slug = slugifyVaName(this.name);
        if (slug) {
            let candidate = slug, n = 2;
            while (await Model.exists({ slug: candidate, _id: { $ne: this._id } })) {
                candidate = `${slug}-${n++}`;
            }
            this.slug = candidate;
        } else {
            this.slug = null; // nothing usable -> stay null (sparse index skips it)
        }
        next();
    } catch (err) { next(err); }
});

const VirtualAirlineAd = mongoose.model('VirtualAirlineAd', VirtualAirlineAdSchema);

// A crew roster member (rich profile). Rank is NOT stored — it's derived from
// `hours` against the VA's rank ladder. Managed storage so a roster works with
// zero VA setup; a VA can later mirror this into their own Supabase.
const CrewMemberSchema = new mongoose.Schema({
    vaAdId:   { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    name:     { type: String, trim: true, default: '' },
    callsign: { type: String, trim: true, default: '' },
    hours:    { type: Number, default: 0, min: 0 },
    role:     { type: String, trim: true, default: '' },
    aircraft: { type: [String], default: [] },
    status:   { type: String, enum: ['active', 'loa', 'inactive'], default: 'active' },
    // Infinite Flight identity — carried from the accepted application so auto
    // PIREPs can pull this pilot's real flights and attribute them here.
    ifUserId: { type: String, trim: true, default: '', index: true },
    ifcName:  { type: String, trim: true, default: '' },            // IF Community name (canonical)
}, { timestamps: true });
const CrewMember = mongoose.models.CrewMember || mongoose.model('CrewMember', CrewMemberSchema);

// A membership application submitted through the crew center's join form.
const CrewApplicationSchema = new mongoose.Schema({
    vaAdId:   { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    ifcName:  { type: String, trim: true, default: '' },       // Infinite Flight Community name
    email:    { type: String, trim: true, lowercase: true, default: '' }, // optional contact for decision emails
    callsignPrefix: { type: String, trim: true, default: '' },
    callsignNumber: { type: String, trim: true, default: '' },
    grade:    { type: Number, default: 0 },                    // IF grade (verified if ifVerified)
    ifVerified: { type: Boolean, default: false },             // did our IF lookup confirm this account?
    ifUserId: { type: String, trim: true, default: '' },       // resolved Infinite Flight user id
    answers:  { type: [{ _id: false, q: String, a: String }], default: [] },
    status:   { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    // A message the reviewing staff can leave for the applicant, shown on the
    // status page when they check back (accept or decline).
    staffMessage: { type: String, trim: true, default: '' },
    // Opaque token the applicant is handed so they can check their status
    // without an account or email. Indexed so lookups are cheap.
    statusToken: { type: String, trim: true, default: '', index: true },
    // The Discord invite sent on acceptance, so the status page can show it
    // again — an emailed invite is easy to lose, and an applicant who gave no
    // email has the status link as their only copy.
    discordInvite: { type: String, trim: true, default: '' },
    // The invitation handed to an accepted applicant — the legacy mirror of the
    // invite_* columns in supabase/crew-center-schema.sql. `invitePassword` holds
    // a live credential until the pilot signs in, staff throw it away, or it
    // ages out, at which point it is blanked. See crewInvite.js for the
    // lifecycle and the schema file for why it is kept in readable form.
    inviteUsername: { type: String, trim: true, default: '' },
    invitePassword: { type: String, trim: true, default: '' },
    inviteIssuedAt: { type: Date, default: null },
    inviteClaimedAt: { type: Date, default: null },
    inviteRevokedAt: { type: Date, default: null },
    inviteAccountId: { type: String, trim: true, default: '', index: true },
    reviewedAt: { type: Date, default: null },
}, { timestamps: true });
const CrewApplication = mongoose.models.CrewApplication || mongoose.model('CrewApplication', CrewApplicationSchema);

// A route in the VA's network — a flyable leg pilots can pick up.
const CrewRouteSchema = new mongoose.Schema({
    vaAdId:      { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    flightNumber:{ type: String, trim: true, default: '' },   // e.g. "ACA123"
    origin:      { type: String, trim: true, uppercase: true, default: '' },  // departure ICAO
    destination: { type: String, trim: true, uppercase: true, default: '' },  // arrival ICAO
    aircraft:    { type: String, trim: true, default: '' },   // aircraft type/name (often from the fleet)
    distanceNm:  { type: Number, default: 0, min: 0 },        // optional great-circle distance
    notes:       { type: String, trim: true, default: '' },
    active:      { type: Boolean, default: true },            // hidden from pilots when false
    // v5 — the legacy mirror of the codeshare/rank columns in
    // supabase/crew-center-schema.sql. `kind` splits the airline's own network
    // from legs it sells on a partner's metal; `minRank` names a rung on the
    // VA's ladder rather than an hours figure, so moving the threshold moves
    // every route gated on it.
    kind:        { type: String, enum: ['own', 'codeshare'], default: 'own' },
    partnerName: { type: String, trim: true, default: '' },
    partnerLogo: { type: String, trim: true, default: '' },
    minRank:     { type: String, trim: true, default: '' },
}, { timestamps: true });
const CrewRoute = mongoose.models.CrewRoute || mongoose.model('CrewRoute', CrewRouteSchema);

// A flight report (PIREP). Auto-captured from a pilot's real Infinite Flight
// history (source 'auto') or filed by hand (source 'manual'). The aircraft/
// livery are the canonical API names so a PIREP lines up with the fleet and,
// where it exists, a route in the network.
const CrewPirepSchema = new mongoose.Schema({
    vaAdId:      { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    memberId:    { type: mongoose.Schema.Types.ObjectId, ref: 'CrewMember', default: null, index: true },
    routeId:     { type: mongoose.Schema.Types.ObjectId, ref: 'CrewRoute', default: null },
    // Denormalised so a PIREP still reads correctly if the pilot/route is later removed.
    pilotName:   { type: String, trim: true, default: '' },
    callsign:    { type: String, trim: true, default: '' },
    flightNumber:{ type: String, trim: true, default: '' },
    ifUserId:    { type: String, trim: true, default: '' },
    // The Infinite Flight flight id — the dedupe key so a flight is captured once.
    flightId:    { type: String, trim: true, default: '', index: true },
    origin:      { type: String, trim: true, uppercase: true, default: '' },
    destination: { type: String, trim: true, uppercase: true, default: '' },
    aircraftName:{ type: String, trim: true, default: '' },   // canonical IF aircraft name
    liveryName:  { type: String, trim: true, default: '' },   // canonical IF livery name
    durationMin: { type: Number, default: 0, min: 0 },
    landings:    { type: Number, default: 0, min: 0 },
    xp:          { type: Number, default: 0 },
    violations:  { type: Number, default: 0, min: 0 },
    distanceNm:  { type: Number, default: 0, min: 0 },
    server:      { type: String, trim: true, default: '' },
    inFleet:     { type: Boolean, default: false },           // did the aircraft match the VA fleet?
    source:      { type: String, enum: ['auto', 'manual'], default: 'auto' },
    status:      { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    hoursApplied:{ type: Boolean, default: false },           // guard so approving twice can't double-credit
    flownAt:     { type: Date, default: null },
    reviewedAt:  { type: Date, default: null },
}, { timestamps: true });
// Fast "already captured?" checks and per-VA listings.
CrewPirepSchema.index({ vaAdId: 1, flightId: 1 });
CrewPirepSchema.index({ vaAdId: 1, status: 1, flownAt: -1 });
const CrewPirep = mongoose.models.CrewPirep || mongoose.model('CrewPirep', CrewPirepSchema);

// The four collections above are LEGACY. New crew data is written to the VA's
// own Supabase project; these remain only so VAs onboarded before that keep
// working until they run the migration (POST /api/crew/:slug/store/migrate).
// Handing them to crewStore keeps that fallback in one place instead of spread
// through the route handlers.
//
// VaPortalAccount is in the list for the same reason: a not-yet-migrated VA's
// pilot logins are still rows there, and the legacy adapter serves them through
// the same account interface the VA's own project answers.
crewStore.configure({ CrewMember, CrewApplication, CrewRoute, CrewPirep, VaPortalAccount });

// ---- Infinite Flight identity verification ----
// We already run an acars backend that proxies the official IF API. It resolves
// a community name to a userId (proof the account exists + the canonical
// spelling) and its stats carry the real grade. We reuse it here so a crew
// center never has to trust a self-reported grade. Best-effort: if the service
// is unreachable we return { ok:false } and callers fall back gracefully.
const ACARS_BACKEND_URL = (process.env.ACARS_BACKEND_URL || 'https://site--acars-backend--6dmjph8ltlhv.code.run').replace(/\/+$/, '');
async function verifyIfUser(name) {
    const q = String(name || '').trim();
    if (!q) return { ok: false, reason: 'empty' };
    try {
        // 1) Resolve the community name → userId + canonical spelling.
        const lookup = await axios.post(`${ACARS_BACKEND_URL}/users`,
            { discourseNames: [q], userHashes: [q] },
            { timeout: 8000, headers: { 'Content-Type': 'application/json' } });
        const u = lookup?.data?.users?.[0];
        if (!u || !u.userId) return { ok: true, found: false };
        const out = {
            ok: true, found: true,
            userId: String(u.userId),
            username: String(u.discourseUsername || q),
            grade: Number.isFinite(u.grade) ? Number(u.grade) : null,
            stats: null,
        };
        // 2) Pull the account's real stats (grade + hours/landings/xp/…) so we
        // can gate on them. Best-effort: existence is what matters most.
        try {
            const resp = await axios.get(`${ACARS_BACKEND_URL}/api/users/${encodeURIComponent(out.userId)}/stats`, { timeout: 8000 });
            const s = resp?.data?.stats || resp?.data?.gradeInfo || resp?.data || {};
            // gradeDetails.gradeIndex is an array index, not the grade —
            // resolveGrade maps it back to the 1-5 number the requirements
            // below are written against.
            if (out.grade == null) out.grade = resolveGrade(s);
            const viol = Number.isFinite(s?.violations) ? Number(s.violations)
                : ((s?.violationCountByLevel?.level1 || 0) + (s?.violationCountByLevel?.level2 || 0) + (s?.violationCountByLevel?.level3 || 0));
            out.stats = {
                grade: out.grade,
                hours: Math.floor((Number(s?.flightTime) || 0) / 60),   // flightTime is minutes
                landings: Number(s?.landingCount) || 0,
                xp: Number(s?.totalXP ?? s?.xp) || 0,
                flights: Number(s?.onlineFlights) || 0,
                violations: viol,
            };
        } catch (_) { /* stats unavailable; out.stats stays null */ }
        return out;
    } catch (err) {
        console.error('verifyIfUser error:', err?.message || err);
        return { ok: false, reason: 'unreachable' };
    }
}

// Evaluate a VA's join requirements against an applicant. `stats` is the real
// IF stat block from verifyIfUser (or null when unavailable); `agreed` is the
// set of agreement labels the applicant ticked. Returns { ok, autoChecked,
// failures:[{type,label,need,have,cmp}] }.
const REQ_META = {
    grade:      { label: 'Grade',        cmp: 'min', stat: 'grade' },
    hours:      { label: 'Flight hours', cmp: 'min', stat: 'hours' },
    landings:   { label: 'Landings',     cmp: 'min', stat: 'landings' },
    xp:         { label: 'XP',           cmp: 'min', stat: 'xp' },
    flights:    { label: 'Online flights', cmp: 'min', stat: 'flights' },
    violations: { label: 'Violations',   cmp: 'max', stat: 'violations' },
};
// ---- Crew Center Discord notifications ----
// Post a small embed to a VA's crew webhook. Fire-and-forget: never let a
// webhook hiccup fail the applicant's request.
const CREW_COLORS = { new: 0xF59E0B, accepted: 0x16A34A, declined: 0x6E685D };
async function postCrewNotice(url, { title, description, color, fields, image }) {
    if (!url || !isDiscordWebhookUrl(url)) return false;
    // A malformed image URL makes Discord reject the WHOLE post with a 400,
    // silently dropping the notice — so anything that is not plainly an https
    // URL is left off rather than sent and hoped for. Same rule vaEventCard.js
    // follows for every URL it puts in an embed.
    const art = /^https:\/\/\S+$/i.test(String(image || '')) ? String(image) : '';
    try {
        await axios.post(url, {
            embeds: [{
                title: String(title || '').slice(0, 256),
                description: description ? String(description).slice(0, 2000) : undefined,
                color: color != null ? color : 0x1C1A16,
                fields: Array.isArray(fields) ? fields.slice(0, 10) : [],
                image: art ? { url: art } : undefined,
                footer: { text: 'Inflight · Crew Center' },
                timestamp: new Date().toISOString(),
            }],
        }, { timeout: 8000, headers: { 'Content-Type': 'application/json' } });
        return true;
    } catch (err) { console.error('crew webhook post failed:', err?.message || err); return false; }
}
// ---- Crew Center applicant emails ----
// Email is strictly bring-your-own: there is NO platform sending account. A VA
// that wants applicant emails plugs in their own provider (below); otherwise no
// email is ever sent and applicants rely on the status page.
const SITE_ORIGIN = (process.env.CREW_SITE_ORIGIN || 'https://inflight.info').replace(/\/+$/, '');
const CREW_EMAIL_PROVIDERS = ['resend', 'sendgrid', 'postmark', 'mailgun'];
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const maskKey = (k) => k ? '••••••' + String(k).slice(-4) : '';
// Split "Name <email>" → { name, email }.
function parseAddress(s) {
    const m = String(s || '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
    return { name: '', email: String(s || '').trim() };
}
// Is an email-provider config complete enough to send with?
function emailCfgReady(cfg) {
    if (!cfg || !cfg.provider || !cfg.key || !cfg.from) return false;
    if (cfg.provider === 'mailgun' && !cfg.domain) return false;
    return true;
}

// One send, dispatched to whichever provider the config names. Every provider
// here is a pure HTTPS JSON/form API (no SMTP), so axios covers them all.
async function sendCrewEmail(cfg, { to, subject, html, replyTo }) {
    if (!emailCfgReady(cfg) || !isEmail(to)) return false;
    const rt = (replyTo && isEmail(replyTo)) ? replyTo : (isEmail(cfg.replyTo) ? cfg.replyTo : undefined);
    const subj = String(subject || '').slice(0, 200);
    try {
        if (cfg.provider === 'resend') {
            await axios.post('https://api.resend.com/emails',
                { from: cfg.from, to: [to], subject: subj, html, reply_to: rt },
                { timeout: 10000, headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' } });
        } else if (cfg.provider === 'sendgrid') {
            const f = parseAddress(cfg.from);
            const payload = {
                personalizations: [{ to: [{ email: to }] }],
                from: f.name ? { email: f.email, name: f.name } : { email: f.email },
                subject: subj, content: [{ type: 'text/html', value: html }],
            };
            if (rt) payload.reply_to = { email: rt };
            await axios.post('https://api.sendgrid.com/v3/mail/send', payload,
                { timeout: 10000, headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' } });
        } else if (cfg.provider === 'postmark') {
            await axios.post('https://api.postmarkapp.com/email',
                { From: cfg.from, To: to, Subject: subj, HtmlBody: html, ReplyTo: rt, MessageStream: 'outbound' },
                { timeout: 10000, headers: { 'X-Postmark-Server-Token': cfg.key, Accept: 'application/json', 'Content-Type': 'application/json' } });
        } else if (cfg.provider === 'mailgun') {
            const base = cfg.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
            const form = new URLSearchParams({ from: cfg.from, to, subject: subj, html });
            if (rt) form.append('h:Reply-To', rt);
            await axios.post(`${base}/v3/${encodeURIComponent(cfg.domain)}/messages`, form,
                { timeout: 10000, auth: { username: 'api', password: cfg.key }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        } else return false;
        return true;
    } catch (err) { console.error(`crew email failed (${cfg.provider}):`, err?.response?.data || err?.message || err); return false; }
}
// Resolve the email config for a VA: their OWN provider if configured, else null
// (email off — there is no platform fallback).
async function crewEmailConfigFor(vaId) {
    let doc = null;
    try { doc = await VirtualAirlineAd.findById(vaId).select('+crewEmailKey crewEmailProvider crewEmailFrom crewEmailReplyTo crewEmailDomain crewEmailRegion contactEmail').lean(); } catch { /* fall through */ }
    if (doc && doc.crewEmailProvider && doc.crewEmailKey && doc.crewEmailFrom) {
        return {
            provider: doc.crewEmailProvider, key: doc.crewEmailKey, from: doc.crewEmailFrom,
            replyTo: doc.crewEmailReplyTo || doc.contactEmail || '', domain: doc.crewEmailDomain || '', region: doc.crewEmailRegion || 'us',
        };
    }
    return null;
}
// Minimal, warm, inline-styled email shell (email clients ignore <style>/CSS).
function crewEmailHtml({ vaName, heading, accent, bodyHtml, button }) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const a = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent || '') ? accent : '#1C1A16';
    const btn = button ? `<tr><td style="padding-top:20px"><a href="${esc(button.url)}" style="display:inline-block;background:${a};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">${esc(button.label)}</a></td></tr>` : '';
    return `<!doctype html><html><body style="margin:0;background:#F6F3ED;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1C1A16">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F3ED;padding:28px 16px"><tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #E7E2D8;border-radius:16px;overflow:hidden">
          <tr><td style="height:4px;background:${a}"></td></tr>
          <tr><td style="padding:28px 28px 24px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#A8A296;padding-bottom:8px">${esc(vaName || 'Crew Center')}</td></tr>
              <tr><td style="font-size:20px;font-weight:700;padding-bottom:10px">${esc(heading)}</td></tr>
              <tr><td style="font-size:14px;line-height:1.6;color:#3a362f">${bodyHtml}</td></tr>
              ${btn}
            </table>
          </td></tr>
          <tr><td style="padding:14px 28px;border-top:1px solid #F0ECE4;font-size:11px;color:#A8A296">Sent by ${esc(vaName || 'this VA')} via Inflight · Crew Center</td></tr>
        </table>
      </td></tr></table></body></html>`;
}

// The "here is how you get in" block of a welcome email.
//
// This is the ONLY copy of the password that will ever exist: it was generated,
// hashed into the VA's project, and handed back to us once (see
// crewAccounts.provisionPilotAccount). So the email has to carry everything the
// pilot needs in one go — where to sign in, the username, the password, and the
// fact that they will be asked to replace it immediately — because there is no
// second email to fall back on and nothing to look it up from later.
//
// Shared by the free-join path and the accept-an-application path so a pilot
// gets the same instructions however they joined.
function crewCredentialsHtml({ username, password, signInUrl }) {
    if (!username || !password) return '';
    return `<br><br><b>Your crew center sign-in</b>`
        + `<br>Username: <b>${escHtml(username)}</b>`
        + `<br>One-time password: <b>${escHtml(password)}</b>`
        + `<br><span style="color:#6b7280">You’ll be asked to choose your own password the first time you sign in. `
        + `This one only works until you do, and it isn’t stored anywhere — keep this email until you’ve changed it.</span>`
        + (signInUrl ? `<br><br>Sign in: <a href="${escHtml(signInUrl)}">${escHtml(signInUrl)}</a>` : '');
}

// The feeds a VA can point at a Discord channel. Adding one here is most of the
// work of adding a new notification category.
const CREW_FEEDS = ['recruitment', 'pireps', 'routes', 'events', 'retention'];

/**
 * Load a VA's (secret) webhook URL for one feed.
 *
 * Falls back to the single crewWebhookUrl, which is the whole compatibility
 * story: every VA already configured keeps receiving everything on the hook
 * they set, and pointing a feed somewhere else is opt-in.
 *
 * Returns '' when unset or not a real Discord webhook.
 */
async function crewWebhookUrlFor(vaId, feed = 'recruitment') {
    try {
        const doc = await VirtualAirlineAd.findById(vaId).select('+crewWebhookUrl +crewWebhooks').lean();
        if (!doc) return '';
        const specific = CREW_FEEDS.includes(feed) ? (doc.crewWebhooks && doc.crewWebhooks[feed]) : '';
        const u = specific || doc.crewWebhookUrl;
        return u && isDiscordWebhookUrl(u) ? u : '';
    } catch { return ''; }
}

// ---- Flight report notices ----
//
// Filed, approved and rejected all go to ONE feed. They are three moments in
// the same conversation — a pilot files, staff decide — and splitting them
// across channels means nobody can follow a report from end to end. The colour
// and the verb carry the difference.
const PIREP_COLORS = { filed: 0x0EA5E9, approved: 0x16A34A, rejected: 0x6E685D, promoted: 0xD97706 };

function pirepFields(p) {
    const leg = [p.origin, p.destination].filter(Boolean).join(' → ');
    const hours = Math.round(((Number(p.durationMin) || 0) / 60) * 10) / 10;
    return [
        leg ? { name: 'Route', value: leg, inline: true } : null,
        p.flightNumber ? { name: 'Flight', value: String(p.flightNumber), inline: true } : null,
        p.aircraftName ? { name: 'Aircraft', value: String(p.aircraftName).slice(0, 60), inline: true } : null,
        hours ? { name: 'Hours', value: `${hours}`, inline: true } : null,
        Number(p.landings) ? { name: 'Landings', value: String(p.landings), inline: true } : null,
        Number(p.violations) ? { name: 'Violations', value: String(p.violations), inline: true } : null,
    ].filter(Boolean);
}

/**
 * Post a flight report event. Fire-and-forget, always: a webhook that is down,
 * rate-limited or misconfigured must never turn a pilot's filed report or a
 * reviewer's decision into an error.
 */
function postPirepNotice(va, event, pirep, actor) {
    if (!va || !pirep) return;
    const who = (actor && actor.name) || '';
    const title = {
        filed: `📋 Flight filed — ${pirep.pilotName || 'a pilot'}`,
        approved: `✅ Flight approved — ${pirep.pilotName || 'a pilot'}`,
        rejected: `🚫 Flight rejected — ${pirep.pilotName || 'a pilot'}`,
    }[event];
    if (!title) return;
    crewWebhookUrlFor(va._id, 'pireps')
        .then((hook) => hook && postCrewNotice(hook, {
            title,
            description: event === 'filed'
                ? (pirep.source === 'auto' ? 'Captured automatically from Infinite Flight.' : undefined)
                : (who ? `Reviewed by ${who}.` : undefined),
            color: PIREP_COLORS[event],
            fields: pirepFields(pirep),
        }))
        .catch(() => {});
}

/**
 * Announce a promotion. Rides the pireps feed because an approval is what
 * causes one, and a VA watching flights come in is the audience for it.
 *
 * Only ever called for a genuine climb — crewRanks.promotionFor returns nothing
 * for a rollback, so correcting a mistyped hours figure cannot publish "Jo has
 * been demoted" to a Discord channel.
 */
function postPromotionNotice(va, member, promotion, opts) {
    if (!va || !promotion || !promotion.to) return;
    const from = promotion.from ? promotion.from.name : null;
    const by = (opts && opts.by) || '';
    // A promotion that came from a check-ride says who signed it off. It is a
    // person's decision rather than an arithmetic threshold, and the crew
    // channel reads very differently when it names them.
    const how = (opts && opts.viaCheck)
        ? `Check-ride passed${by ? `, signed off by ${by}` : ''}.`
        : '';
    crewWebhookUrlFor(va._id, 'pireps')
        .then((hook) => hook && postCrewNotice(hook, {
            title: `🎖️ ${member.name || 'A pilot'} promoted to ${promotion.to.name}`,
            description: [
                from ? `Up from ${from}${promotion.skipped ? ` — skipping ${promotion.skipped} rank${promotion.skipped === 1 ? '' : 's'}` : ''}.` : '',
                how,
            ].filter(Boolean).join(' ') || undefined,
            color: PIREP_COLORS.promoted,
            fields: [
                member.callsign ? { name: 'Callsign', value: member.callsign, inline: true } : null,
                { name: 'Hours', value: String(Math.round((Number(member.hours) || 0) * 10) / 10), inline: true },
            ].filter(Boolean),
        }))
        .catch(() => {});
}

/**
 * A pilot has flown the hours for a rung that needs a person to sign it off.
 *
 * Fires once, at the moment they arrive — which is the only moment anybody
 * would otherwise find out, because the alternative is a pilot who quietly
 * stops being promoted and a staff member who never learns they are waiting.
 *
 * Rides the pireps feed because an approved flight is what causes it, and that
 * is the channel already being watched for exactly this kind of movement.
 */
function postCheckRideDueNotice(va, member, rung, actor) {
    if (!va || !member || !rung) return;
    crewWebhookUrlFor(va._id, 'pireps')
        .then((hook) => hook && postCrewNotice(hook, {
            title: `🧭 ${member.name || 'A pilot'} is ready for their ${rung.name} check-ride`,
            description: rung.checkNote
                ? String(rung.checkNote).slice(0, 600)
                : 'They have the hours — the rank is waiting on a sign-off.',
            color: 0x7C3AED,
            fields: [
                member.callsign ? { name: 'Callsign', value: member.callsign, inline: true } : null,
                { name: 'Hours', value: String(Math.round((Number(member.hours) || 0) * 10) / 10), inline: true },
                { name: 'Needs', value: `${rung.name} · ${rung.minHours}h`, inline: true },
            ].filter(Boolean),
        }))
        .catch(() => {});
    postAnnouncement(va, {
        kind: 'checkride',
        title: `${member.name || 'A pilot'} is ready for their ${rung.name} check-ride`,
        body: rung.checkNote || '',
        refId: member._id,
        authorName: (actor && actor.name) || '',
    });
}

/**
 * Write a row on the VA's noticeboard.
 *
 * Fire-and-forget, and deliberately silent on failure: a promotion that
 * happened must not be reported as a failure because the announcement about it
 * could not be written. A VA on an older schema has no crew_announcements table
 * at all, and that is a reason to skip the notice, never to fail the thing that
 * caused it.
 */
function postAnnouncement(va, { kind = 'notice', title, body = '', refId = null, authorName = '' }) {
    if (!va || !title) return;
    Promise.resolve()
        .then(async () => {
            const store = await crewStore.forVaOrNull(va);
            if (!store || typeof store.createAnnouncement !== 'function') return;
            await store.createAnnouncement({
                kind, title, body, refId, authorName, source: 'auto',
            });
        })
        .catch((err) => console.warn('announcement skipped —', err?.message || err));
}

// ---- Route network notices ----
const ROUTE_COLORS = { added: 0x16A34A, updated: 0x0EA5E9, removed: 0x6E685D, imported: 0x4F46E5 };

const routeLabel = (r) => {
    const leg = [r.origin, r.destination].filter(Boolean).join(' → ') || 'a route';
    return r.flightNumber ? `${r.flightNumber} · ${leg}` : leg;
};

/**
 * Post a route change. `before` lets an edit say what actually changed rather
 * than "someone touched this route", which is the difference between a feed
 * worth watching and one people mute.
 */
function postRouteNotice(va, event, route, actor, before) {
    if (!va || !route) return;
    const who = (actor && actor.name) || '';
    const changed = [];
    if (before && event === 'updated') {
        const watch = [
            ['origin', 'Origin'], ['destination', 'Destination'], ['aircraft', 'Aircraft'],
            ['flightNumber', 'Flight number'], ['kind', 'Type'], ['minRank', 'Rank required'],
            ['partnerName', 'Partner'], ['active', 'Published'],
        ];
        for (const [key, label] of watch) {
            if (String(before[key] ?? '') !== String(route[key] ?? '')) {
                changed.push(`${label}: ${before[key] || '—'} → ${route[key] || '—'}`);
            }
        }
        // Nothing a human would notice changed — a re-save of the same values.
        // Staying quiet is the right call; a feed that fires on no-ops is noise.
        if (!changed.length) return;
    }
    crewWebhookUrlFor(va._id, 'routes')
        .then((hook) => hook && postCrewNotice(hook, {
            title: `${event === 'added' ? '🛫 Route added' : event === 'removed' ? '🗑️ Route removed' : '✏️ Route updated'} — ${routeLabel(route)}`,
            description: [changed.join('\n'), who ? `By ${who}.` : ''].filter(Boolean).join('\n\n') || undefined,
            color: ROUTE_COLORS[event] || ROUTE_COLORS.updated,
            fields: [
                route.kind === 'codeshare'
                    ? { name: 'Type', value: `Codeshare${route.partnerName ? ` · ${route.partnerName}` : ''}`, inline: true }
                    : { name: 'Type', value: 'Own metal', inline: true },
                route.minRank ? { name: 'Opens at', value: String(route.minRank), inline: true } : null,
                route.distanceNm ? { name: 'Distance', value: `${Math.round(route.distanceNm)} nm`, inline: true } : null,
            ].filter(Boolean),
        }))
        .catch(() => {});
}

/**
 * One notice for a whole CSV import, rather than one per row.
 *
 * A VA pasting in a 200-route network would otherwise post 200 embeds and get
 * themselves rate-limited by Discord — and nobody wants to scroll past that to
 * find the one route somebody edited by hand.
 */
function postRouteImportNotice(va, summary, actor) {
    if (!va || !summary || (!summary.created && !summary.updated)) return;
    const who = (actor && actor.name) || '';
    crewWebhookUrlFor(va._id, 'routes')
        .then((hook) => hook && postCrewNotice(hook, {
            title: '📥 Route network imported',
            description: who ? `By ${who}.` : undefined,
            color: ROUTE_COLORS.imported,
            fields: [
                { name: 'Added', value: String(summary.created || 0), inline: true },
                { name: 'Updated', value: String(summary.updated || 0), inline: true },
                { name: 'Unchanged', value: String(summary.unchanged || 0), inline: true },
            ],
        }))
        .catch(() => {});
}

// ---- Event notices ----
//
// What this feed is for: an event only works if people know it is happening,
// and the channel a VA already watches is where they will see it. So the loud
// moments post — published, cancelled, starting — and the quiet ones do not.
//
// Signups deliberately do NOT post. A popular event would fire forty embeds in
// an evening, which is how a channel gets muted, and "who is coming" is a
// question the event's own attendee board answers better than a scroll-back.
const EVENT_COLORS = { published: 0x16A34A, updated: 0x0EA5E9, cancelled: 0xDC2626, removed: 0x6E685D };

const eventLabel = (e) => {
    const leg = [e.origin, e.destination].filter(Boolean).join(' → ');
    return e.title || leg || 'an event';
};

/**
 * Post an event change. Fire-and-forget like every other notice: a Discord
 * webhook that is down must never turn "publish this event" into an error the
 * VA sees.
 *
 * `when` is sent as a Discord timestamp (<t:epoch:F>) rather than a formatted
 * string, so every pilot reads the departure in their OWN timezone. An event
 * time is the single most misread thing a VA posts, and a Z-time in prose is
 * what makes it so.
 */
function postEventNotice(va, action, event, actor) {
    if (!va || !event) return;
    const who = (actor && actor.name) || '';
    const title = {
        published: `📣 Event published — ${eventLabel(event)}`,
        updated: `✏️ Event updated — ${eventLabel(event)}`,
        cancelled: `⚠️ Event cancelled — ${eventLabel(event)}`,
        removed: `🗑️ Event removed — ${eventLabel(event)}`,
    }[action];
    if (!title) return;
    const startsAt = event.startsAt ? new Date(event.startsAt) : null;
    const stamp = startsAt && !Number.isNaN(startsAt.getTime())
        ? `<t:${Math.floor(startsAt.getTime() / 1000)}:F>` : '';
    crewWebhookUrlFor(va._id, 'events')
        .then((hook) => hook && postCrewNotice(hook, {
            title,
            description: [event.description ? String(event.description).slice(0, 600) : '', who ? `By ${who}.` : '']
                .filter(Boolean).join('\n\n') || undefined,
            color: EVENT_COLORS[action],
            image: /^https:\/\//i.test(event.bannerUrl || '') ? event.bannerUrl : undefined,
            fields: [
                stamp ? { name: 'Departs', value: stamp, inline: false } : null,
                (event.origin || event.destination)
                    ? { name: 'Route', value: [event.origin, event.destination].filter(Boolean).join(' → '), inline: true } : null,
                event.aircraft ? { name: 'Aircraft', value: String(event.aircraft).slice(0, 60), inline: true } : null,
                event.server ? { name: 'Server', value: String(event.server).slice(0, 30), inline: true } : null,
                event.slots ? { name: 'Slots', value: String(event.slots), inline: true } : null,
                event.minRank ? { name: 'Opens at', value: String(event.minRank), inline: true } : null,
            ].filter(Boolean),
        }))
        .catch(() => {});
}

// ---- Schedule notices ----
const SCHEDULE_COLORS = { published: 0x16A34A, cancelled: 0xDC2626, removed: 0x6E685D };

/**
 * Post a schedule change to the VA's own Discord.
 *
 * Rides the events feed rather than asking VAs to configure a fourth webhook:
 * "here is something to fly" is the same channel and the same audience, and a
 * VA that has set up an events feed has already told us where that is.
 *
 * `count` is how many departures the batch created. It is the difference
 * between a useful notice and sixty useless ones — publishing a fortnight of
 * flying posts once, and says how much went up.
 *
 * Times go as Discord timestamps (<t:epoch:F>) for the reason event times do:
 * every pilot then reads the departure in their OWN timezone, and a Z-time in
 * prose is the single most misread thing a VA posts.
 */
function postScheduleNotice(va, action, schedule, actor, count = 1) {
    if (!va || !schedule) return;
    const who = (actor && actor.name) || '';
    const leg = crewSchedules.describeLeg(schedule) || 'a departure';
    const many = count > 1;
    const title = {
        published: many ? `🗓️ ${count} departures added to the schedule` : `🗓️ On the schedule — ${leg}`,
        cancelled: `⚠️ Departure cancelled — ${leg}`,
        removed: `🗑️ Departure removed — ${leg}`,
    }[action];
    if (!title) return;
    const departsAt = schedule.departsAt ? new Date(schedule.departsAt) : null;
    const stamp = departsAt && !Number.isNaN(departsAt.getTime())
        ? `<t:${Math.floor(departsAt.getTime() / 1000)}:F>` : '';
    crewWebhookUrlFor(va._id, 'events')
        .then((hook) => hook && postCrewNotice(hook, {
            title,
            description: [
                many ? `Starting with ${leg}.` : (schedule.notes ? String(schedule.notes).slice(0, 600) : ''),
                who ? `By ${who}.` : '',
            ].filter(Boolean).join('\n\n') || undefined,
            color: SCHEDULE_COLORS[action],
            fields: [
                stamp ? { name: many ? 'First departure' : 'Departs', value: stamp, inline: false } : null,
                schedule.aircraft ? { name: 'Aircraft', value: String(schedule.aircraft).slice(0, 60), inline: true } : null,
                schedule.seats > 1 ? { name: 'Seats', value: String(schedule.seats), inline: true } : null,
                schedule.minRank ? { name: 'Opens at', value: String(schedule.minRank), inline: true } : null,
            ].filter(Boolean),
        }))
        .catch(() => {});
}

// ---- The roster sweep ----
//
// crewRetention.js decides WHO is due; this applies it. Kept apart on purpose:
// the decisions are pure and tested against a table of fixtures, and everything
// with a side effect — a delete, a status change, a webhook — is here, where it
// can be read in one sitting.
//
// Every action posts to the VA's retention feed BEFORE it happens, and the post
// is not awaited: a Discord outage must not stop a sweep, and a sweep must not
// wait on Discord. What it must never do is act without saying so, which is why
// the notice is fired first.

const RETENTION_COLORS = { warn: 0xD97706, removed: 0xDC2626, inactive: 0x6E685D, summary: 0x1C1A16 };

function postRetentionNotice(va, kind, payload) {
    if (!va) return;
    crewWebhookUrlFor(va._id, 'retention')
        .then((hook) => hook && postCrewNotice(hook, { ...payload, color: RETENTION_COLORS[kind] }))
        .catch(() => {});
}

/** "Rae Okafor (TVA101)" — how a pilot is named in a notice. */
const pilotLabel = (m) => [m.name || 'A pilot', m.callsign ? `(${m.callsign})` : ''].filter(Boolean).join(' ');

/**
 * Run the sweep for one VA.
 *
 * `dryRun` does everything except write and post, and returns the same shape —
 * which is the whole point of it. This feature removes people, and an owner
 * about to switch it on should be able to see exactly who the first run would
 * take before it takes them.
 */
async function runRetentionSweep(va, { dryRun = false, now = Date.now() } = {}) {
    const rules = crewRetention.normalizeRules(va.crewRetention);
    const result = {
        slug: va.slug || String(va._id), rules, dryRun,
        warned: [], removed: [], deactivated: [], failed: [], checked: 0, skipped: '',
    };
    if (!rules.enabled || (!rules.firstFlight && !rules.inactivity)) {
        result.skipped = 'not enabled';
        return result;
    }

    let store;
    try { store = await crewStore.forVa(va); } catch (err) {
        result.skipped = `no store (${err && err.code ? err.code : 'error'})`;
        return result;
    }

    let members = [];
    let pireps = [];
    try {
        [members, pireps] = await Promise.all([
            store.listMembers({ limit: 5000 }),
            store.listPireps({ status: 'approved', limit: 20000 }),
        ]);
    } catch (err) {
        // A VA whose project is unreachable or on an older shape is skipped
        // whole. Sweeping a partial roster is how you delete the pilots whose
        // flights did not come back.
        result.skipped = `store read failed (${err && err.code ? err.code : err && err.message})`;
        return result;
    }

    const due = crewRetention.assess({ members, pireps, rules, now });
    result.checked = due.checked;

    // Warnings first, and only warnings. A pilot warned on this run has not
    // also run out of time on it — assess() puts them in one list or the other.
    for (const w of [...due.probationWarn, ...due.inactivityWarn]) {
        const m = w.member;
        const first = due.probationWarn.includes(w);
        result.warned.push({ id: m._id, name: m.name, callsign: m.callsign, rule: first ? 'first-flight' : 'inactivity', days: w.days });
        if (dryRun) continue;
        try {
            await store.updateMember(m._id, { retentionWarnedAt: new Date(now).toISOString() });
            postRetentionNotice(va, 'warn', {
                title: `⏳ ${pilotLabel(m)} — ${w.days} day${w.days === 1 ? '' : 's'} left`,
                description: first
                    ? `They joined ${rules.firstFlightDays} days ago and have not logged a flight yet. If none arrives by <t:${Math.floor(w.dueAt.getTime() / 1000)}:D> their account will be ${w.action === 'remove' ? 'removed' : 'marked inactive'}.`
                    : `No flight logged in ${rules.inactivityDays} days. If none arrives by <t:${Math.floor(w.dueAt.getTime() / 1000)}:D> they will be ${w.action === 'remove' ? 'removed' : 'marked inactive'}.`,
                fields: [{ name: 'Rule', value: first ? 'First flight' : 'Inactivity', inline: true }],
            });
        } catch (err) {
            result.failed.push({ id: m._id, name: m.name, stage: 'warn', error: err && err.message });
        }
    }

    // Then the deadlines.
    for (const d of [...due.probationDue, ...due.inactivityDue]) {
        const m = d.member;
        const first = due.probationDue.includes(d);
        const remove = d.action === 'remove';
        const row = { id: m._id, name: m.name, callsign: m.callsign, rule: first ? 'first-flight' : 'inactivity', hours: m.hours };
        (remove ? result.removed : result.deactivated).push(row);
        if (dryRun) continue;
        try {
            if (remove) {
                // The login goes with the pilot. Leaving an account behind
                // whose member row is gone is an account that can sign in to a
                // crew center it is no longer on.
                const acct = await store.getAccountByMember(m._id).catch(() => null);
                if (acct) await store.deleteAccount(acct._id).catch(() => {});
                await store.deleteMember(m._id);
            } else {
                await store.updateMember(m._id, { status: 'inactive' });
            }
            postRetentionNotice(va, remove ? 'removed' : 'inactive', {
                title: remove
                    ? `🗑️ ${pilotLabel(m)} removed from the roster`
                    : `💤 ${pilotLabel(m)} marked inactive`,
                description: first
                    ? `No first flight within ${rules.firstFlightDays} days of joining.`
                    : `No flight logged in ${rules.inactivityDays} days.`,
                fields: [
                    { name: 'Rule', value: first ? 'First flight' : 'Inactivity', inline: true },
                    Number(m.hours) ? { name: 'Hours', value: String(Math.round(Number(m.hours) * 10) / 10), inline: true } : null,
                ].filter(Boolean),
            });
        } catch (err) {
            result.failed.push({ id: m._id, name: m.name, stage: remove ? 'remove' : 'deactivate', error: err && err.message });
        }
    }

    // One summary when anything happened, so a VA reading only their Discord
    // still knows a sweep ran and what it did.
    if (!dryRun && (result.removed.length || result.deactivated.length)) {
        postRetentionNotice(va, 'summary', {
            title: '🧹 Roster sweep',
            description: crewRetention.summarize(due),
            fields: [
                result.removed.length ? { name: 'Removed', value: String(result.removed.length), inline: true } : null,
                result.deactivated.length ? { name: 'Marked inactive', value: String(result.deactivated.length), inline: true } : null,
                result.warned.length ? { name: 'Warned', value: String(result.warned.length), inline: true } : null,
            ].filter(Boolean),
        });
    }
    return result;
}

/**
 * Sweep every VA that has switched this on.
 *
 * Serial, not parallel: each VA is a separate Supabase project and a burst of
 * concurrent connections buys nothing here — this runs on a timer with no user
 * waiting on it, and being polite to a hundred small projects matters more than
 * finishing a minute sooner.
 */
async function runRetentionSweepAll({ now = Date.now() } = {}) {
    let vas = [];
    try {
        vas = await VirtualAirlineAd.find({
            status: 'approved',
            'crewRetention.enabled': true,
        }).select(crewStore.SELECT + ' crewRetention').lean();
    } catch (err) {
        console.error('[retention] could not list VAs:', err && err.message);
        return { vas: 0, removed: 0, deactivated: 0, warned: 0 };
    }
    const totals = { vas: 0, removed: 0, deactivated: 0, warned: 0 };
    for (const va of vas) {
        try {
            const r = await runRetentionSweep(va, { now });
            totals.vas += 1;
            totals.removed += r.removed.length;
            totals.deactivated += r.deactivated.length;
            totals.warned += r.warned.length;
            if (r.skipped) console.log(`[retention] ${r.slug}: skipped — ${r.skipped}`);
            else if (r.removed.length || r.deactivated.length || r.warned.length || r.failed.length) {
                console.log(`[retention] ${r.slug}: ${r.checked} checked, ${r.warned.length} warned, ${r.removed.length} removed, ${r.deactivated.length} inactive, ${r.failed.length} failed`);
            }
        } catch (err) {
            console.error(`[retention] ${va.slug || va._id} sweep failed:`, err && err.message);
        }
    }
    return totals;
}

function evaluateRequirements(reqs, stats, agreed) {
    const failures = [];
    let autoChecked = false;
    const agreedSet = new Set((agreed || []).map(x => String(x).trim().toLowerCase()));
    for (const r of (reqs || [])) {
        if (r.type === 'agree') {
            if (r.required && !agreedSet.has(String(r.label || '').trim().toLowerCase())) {
                failures.push({ type: 'agree', label: r.label || 'Agreement', need: 'accepted', have: 'not accepted', cmp: 'agree' });
            }
            continue;
        }
        const meta = REQ_META[r.type];
        if (!meta) continue;
        autoChecked = true;
        if (!stats) { // can't verify this numeric requirement right now
            failures.push({ type: r.type, label: meta.label, need: r.value, have: null, cmp: meta.cmp, unverified: true });
            continue;
        }
        const have = Number(stats[meta.stat]) || 0;
        const pass = meta.cmp === 'max' ? have <= r.value : have >= r.value;
        if (!pass) failures.push({ type: r.type, label: meta.label, need: r.value, have, cmp: meta.cmp });
    }
    return { ok: failures.length === 0, autoChecked, failures };
}

/* =========================
 * VA PILOT ROSTER
 *
 * The list of Infinite Flight usernames a VA gives us for their pilots. One row
 * per (VA, username). Deliberately its OWN collection rather than an array on
 * the VA listing: usernames are tiny text so this scales to thousands per VA
 * without bloating the VA document, and it leaves room to hang per-pilot data
 * off a row later (join date, stats link, verification). The username is stored
 * both as typed (for display) and lowercased (usernameLower) as the match/de-dupe
 * key, since IFC usernames are case-insensitive. Shared parse/normalize/DB
 * helpers live in vaPilots.js so the staff API and the VA portal behave alike.
 * ========================= */
const VaPilotSchema = new mongoose.Schema({
    vaAdId:        { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', required: true, index: true },
    username:      { type: String, required: true, trim: true }, // as typed (display)
    usernameLower: { type: String, required: true },             // lowercased match/de-dupe key
    addedBy:       { type: String, default: '' },                // staff/owner who added it (audit)
    addedAt:       { type: Date, default: Date.now },
});
// One username per VA (case-insensitive), and the fast "who's on this VA's
// roster" path.
VaPilotSchema.index({ vaAdId: 1, usernameLower: 1 }, { unique: true });
// Reverse lookup: "which VAs is this pilot on the roster of?" — backs
// roster-based flight-event attribution (resolveVaEventPartnerByRoster), which
// queries by usernameLower ALONE (not prefixed by vaAdId), so it needs its own
// index rather than riding the compound one above.
VaPilotSchema.index({ usernameLower: 1 });
const VaPilot = mongoose.models.VaPilot || mongoose.model('VaPilot', VaPilotSchema);

/* =========================
 * VA PARTNERSHIP TERMS ACCEPTANCE
 *
 * Written by the ticket bot when a user clicks "I accept" on the VA partnership
 * Terms of Service inside their partnership ticket. One row per Discord user
 * (the latest acceptance wins). Lets us prove a user agreed before they were
 * walked into the VA application, without re-prompting on every ticket.
 * ========================= */
const VaTermsAcceptanceSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true }, // Discord user ID
    username: { type: String, default: '' },                            // Discord username at accept time
    termsVersion: { type: String, default: 'v1' },                      // bump when the ToS text changes
    channelId: { type: String, default: null },                         // ticket thread it was accepted in
    acceptedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const VaTermsAcceptance = mongoose.models.VaTermsAcceptance
    || mongoose.model('VaTermsAcceptance', VaTermsAcceptanceSchema);

/* =========================
 * EMBED CONFIG SCHEMA
 *
 * Backs the Inflight embed widget (hosted at inflight.info/embed.html).
 * Each document is one distributable token-link config for a VA: the widget is
 * handed only an opaque ?token=… and calls GET /api/embed/resolve to fetch the
 * real settings. This keeps the VA's Mapbox token off the public URL, lets a
 * token be locked to specific sites, and lets staff revoke a VA instantly.
 *
 * See EMBEDBACKEND.md / the staff embed manager (/embeds) for the distribution
 * flow. The resolve response contract is mirrored field-for-field below.
 * ========================= */
const EMBED_MODES = ['roster', 'map'];
const EMBED_PROVIDERS = ['mapbox', 'free'];
const EMBED_THEMES = ['dark', 'light'];
const EMBED_HEADER_POSITIONS = ['top', 'bottom', 'left', 'right'];
// The Events + Calendar companion widget (embed-events.html) ships 10 layout
// presets; the VA picks one. Kept here so schema, resolve and validation agree.
const EMBED_EVENT_TEMPLATE_MAX = 10;
const normalizeEventsFlag = (v) =>
    (v === true || v === 1 || v === '1' || v === 'on' || v === 'true') ? 'on' : 'off';
const normalizeEventsTemplate = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(EMBED_EVENT_TEMPLATE_MAX, Math.max(1, Math.round(n))) : 1;
};

const EmbedConfigSchema = new mongoose.Schema({
    // Opaque token the VA embeds in their iframe URL. Generated on create.
    token: { type: String, required: true, unique: true, index: true },

    // Hard link to the VA advertisement this embed belongs to — the "head".
    // Embeds were historically matched to a VA only by va.code (callsign); this
    // reference makes the trail explicit, so a VA's ad, roster, webhook and
    // embed all point at one record. Backfilled from va.code for legacy embeds;
    // kept in step with the ad's name/logo whenever either side changes.
    vaAdId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', default: null, index: true },

    // Internal label so staff can tell entries apart in the manager (not exposed).
    label: { type: String, trim: true, default: '' },

    // --- VA identity (va.code is the only required field for resolution) ---
    va: {
        code: { type: String, required: true, trim: true, uppercase: true },
        name: { type: String, trim: true, default: '' },
        logo: { type: String, trim: true, default: '' },
    },

    // --- Callsign matching (see EMBEDBACKEND.md §2) ---
    // Prefixes are the FULL airline name flown (e.g. "Air Canada"), not a short
    // ICAO code. Case is preserved so it matches the in-game callsign exactly.
    callsignPrefixes: { type: [String], default: [] }, // empty => widget falls back to [va.code]
    callsignSuffixes: { type: [String], default: [] }, // tag(s) carried after the number, e.g. "VA"
    // Untagged callsigns matched by PREFIX ONLY and always included, even when
    // the prefixes above run in tag mode. Staff / charter / plain airline names
    // that fly alongside the tagged members. See EMBEDBACKEND.md §2c.
    regularCallsigns: { type: [String], default: [] },

    /* How hard the widget should work to find this VA's pilots.
     *
     * There is a real limit here and it cannot be engineered away: the only
     * thing a live flight gives us is the callsign the pilot typed. A member
     * flying a codeshare leg types the partner airline's callsign and no VA
     * tag at all, so nothing in it says which VA they belong to — and a
     * stranger flying some OTHER airline's VA, whose callsign also happens to
     * end in "VA", is indistinguishable from a member by pattern alone.
     *
     * A VA cannot have both, so it chooses which error it prefers:
     *
     *   'strict' — only callsigns that fit this VA's configured patterns. The
     *     map shows nobody who isn't yours. Members on codeshare callsigns, or
     *     any shape not registered here, will be missing.
     *   'broad'  — also accept the prefix without the VA's own tag, catching
     *     members whose callsign doesn't fit. The cost is that somebody flying
     *     for a different VA on a similar callsign can appear as one of yours.
     */
    callsignMatch: { type: String, enum: ['strict', 'broad'], default: 'strict' },

    // Hub ICAOs. Each becomes a map marker whose window lists the VA's inbound
    // pilots. Stored uppercase, e.g. ["CYYZ", "CYUL", "CYVR"].
    hubs: { type: [String], default: [] },

    // --- Widget appearance / data source ---
    mode: { type: String, enum: EMBED_MODES, default: 'roster' },
    provider: { type: String, enum: EMBED_PROVIDERS, default: null }, // null => auto from mapboxToken
    mapboxToken: { type: String, trim: true, default: '' },           // the VA's own Mapbox token
    mapStyle: { type: String, trim: true, default: '' },
    freeStyle: { type: String, trim: true, default: 'dark' },
    theme: { type: String, enum: EMBED_THEMES, default: 'dark' },
    // Header/accent colour, stored as a hex string like "#1d4ed8". Empty lets the
    // widget fall back to sampling the VA logo for its header colour.
    // LEGACY: superseded by `accent` below, but still served (mirroring accent's
    // first stop) so older cached widget builds keep their header colour.
    brandColor: { type: String, trim: true, default: '' },
    servers: { type: [String], default: [] },                         // IF session names to scan

    // --- Header & appearance customization (mirrors embed.html query params) ---
    header: { type: String, enum: ['on', 'off'], default: 'on' },     // 'off' hides the bar; Powered-by floats as a pill
    headerPos: { type: String, enum: EMBED_HEADER_POSITIONS, default: 'top' }, // left/right = vertical brand rail
    // Accent colour stops, up to 3 "#rrggbb" strings. One stop auto-expands into
    // a gradient with a derived companion shade; 2–3 stops = multi-stop gradient.
    // Empty => the widget samples the VA logo's most vivid colours.
    accent: { type: [String], default: [] },
    gradient: { type: String, enum: ['auto', 'off'], default: 'auto' }, // 'off' keeps a single colour flat
    gradientAngle: { type: Number, default: 120 },                    // degrees
    compact: { type: Boolean, default: false },                       // slimmer header
    radius: { type: Number, default: null },                          // widget corner radius px 0–32; null = widget default

    // --- Events + calendar companion widget (embed-events.html) ---
    // The VA's choice: 'on' surfaces an Events+Calendar embed that pulls this
    // VA's upcoming events and styles itself with the same accent/theme/radius
    // as the map embed. 'off' (default) means the VA hasn't opted in.
    events: { type: String, enum: ['on', 'off'], default: 'off' },
    // One of 10 layout presets (size / banners / logos / flags mix), 1-based.
    eventsTemplate: { type: Number, default: 1, min: 1, max: EMBED_EVENT_TEMPLATE_MAX },

    // --- Flight-card customization (map mode) — see EMBEDBACKEND.md §1 ---
    // Purely cosmetic; the widget turns these into CSS on the tap/detail card.
    // Colours may be hex, rgb()/rgba() or a named colour; empty = widget default.
    card: {
        color:   { type: String, trim: true, default: '' }, // card surface colour
        text:    { type: String, trim: true, default: '' }, // card text colour
        opacity: { type: Number, default: null },           // 0–1 OR 0–100; null = default
        blur:    { type: Number, default: null },           // backdrop blur px 0–40; null = auto
    },

    // --- Access control ---
    allowedOrigins: { type: [String], default: [] }, // empty => any site may embed
    revoked: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null },

    // --- Analytics ---
    resolveCount: { type: Number, default: 0 },
    lastResolvedAt: { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

EmbedConfigSchema.index({ 'va.code': 1 });
EmbedConfigSchema.index({ createdAt: -1 });

EmbedConfigSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

const EmbedConfig = mongoose.model('EmbedConfig', EmbedConfigSchema);

// --- GIVEAWAY ---
// Giveaways used to live only in the bot's memory, so any restart (deploy,
// crash, host cycling) wiped the entrants and the "end" timer — a multi-day
// giveaway would silently die and the Enter button would report "already
// ended". Persisting them lets the bot restore active giveaways on boot.
const GiveawaySchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true, index: true },
    channelId: { type: String, required: true },
    prize: { type: String, required: true },
    delivery: { type: String, default: 'mod_message' }, // 'mod_message' | 'ticket'
    hostId: { type: String, required: true },
    entrants: { type: [String], default: [] },          // Discord user IDs
    endsAt: { type: Date, required: true },
    ended: { type: Boolean, default: false }
});
// Restore on boot queries the still-running giveaways.
GiveawaySchema.index({ ended: 1 });

const Giveaway = mongoose.model('Giveaway', GiveawaySchema);

// Store only the base radio callsign (e.g. "OCEAN"); the Infinite Flight VA
// suffix "##VA" is appended at display time. Strip it here so a value entered as
// "Ocean ##VA" or "Ocean VA" is normalized back to "OCEAN".
const normalizeCallsignBase = (raw) => {
    if (!raw) return null;
    const clean = String(raw).trim().toUpperCase().replace(/\s*#+\s*VA$/i, '').replace(/\s+VA$/i, '').trim();
    return clean || null;
};

// Callsign as the operator typed it (trim + uppercase only — no suffix
// stripping). Used by the staff/portal SAVE paths so a value entered as
// "AIR CANADA ##VA" is stored verbatim and shown back unchanged when the editor
// is reopened. Display helpers collapse any "##VA" the stored value already
// carries (formatCallsignDisplay here; fmtCallsign / formatVaCallsign in the
// UIs) so the suffix is never doubled at render time.
const cleanCallsignInput = (raw) => {
    if (!raw) return null;
    const clean = String(raw).trim().toUpperCase();
    return clean || null;
};

// Render a stored callsign as "<BASE> ##VA" for read-only display, tolerating a
// stored value that already ends in the suffix so it isn't doubled.
const formatCallsignDisplay = (raw) => {
    if (!raw) return null;
    const base = String(raw).trim().toUpperCase()
        .replace(/\s*#+\s*VA$/i, '').replace(/\s+VA$/i, '').trim();
    return base ? `${base} ##VA` : null;
};

// Expand reduced callsign bases with their "##VA" / " VA" suffixed forms for the
// flight-event lookups. Stored callsigns are now kept verbatim (see
// cleanCallsignInput), so a VA that saved its callsign WITH the suffix (e.g.
// "AIR CANADA ##VA") must still match a live callsign we reduced to the bare base
// ("AIR CANADA"). Querying both forms keeps delivery working either way.
const callsignQueryVariants = (bases) => {
    const out = new Set();
    for (const b of bases) {
        if (!b) continue;
        out.add(b);
        out.add(`${b} ##VA`);
        out.add(`${b} VA`);
    }
    return [...out];
};

// --- Our own VA callsign filter ---------------------------------------------
// A pilot flying for a VA uses a callsign shaped "<BASE> <pilot#>VA": it must
// START with the VA's base radio callsign and END with "VA", with the pilot
// number in between — e.g. base "STARLUX" → "STARLUX 123VA" (the "###" in
// "Starlux ###VA" stands in for the number). This is the rule we apply to decide
// whether a live in-game callsign really belongs to one of the VA's stored
// callsigns. Tolerances: case-insensitive; a stored base that itself carries a
// "##VA"/" VA" suffix is reduced first; the number may use digits and/or "#"
// placeholders; the space before "VA" is optional.
const callsignMatchesVaBase = (callsign, base) => {
    const cs = String(callsign || '').trim().toUpperCase();
    const b = String(base || '').trim().toUpperCase()
        .replace(/\s*#+\s*VA$/i, '').replace(/\s+VA$/i, '').trim();
    if (!cs || !b) return false;
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // <base><space><pilot number (digits / # placeholders)><optional space>VA
    return new RegExp('^' + escaped + '\\s+[0-9#]+\\s*VA$').test(cs);
};

// List-aware form of callsignMatchesVaBase: returns the first stored base the
// live callsign fits (so it doubles as "which callsign matched"), or null.
const matchVaCallsign = (callsign, bases = []) => {
    for (const b of (Array.isArray(bases) ? bases : [bases])) {
        if (callsignMatchesVaBase(callsign, b)) return b;
    }
    return null;
};

// Reduce a LIVE in-game callsign to its airline-name base by dropping the trailing
// flight number + optional tag: "Air Canada 001VA" -> "AIR CANADA",
// "OCEAN 12VA" -> "OCEAN", "OCEAN 7" -> "OCEAN". A bare base ("OCEAN") is left as
// is. Complements normalizeCallsignBase (which only strips the "##VA" suffix form)
// so partner matching can line a real callsign up against a stored base callsign.
const callsignAirlineBase = (raw) => {
    if (!raw) return null;
    const clean = String(raw).trim().toUpperCase().replace(/\s+\d+\s*[A-Z]*$/, '').trim();
    return clean || null;
};

// True only for a well-formed Discord webhook URL. Partner VAs paste these into
// the portal themselves, so we gate both the write (vaPortal.js) and the post
// (VA flight events, below) on this — without it the per-VA delivery would be an
// open POST relay to any host the caller named (SSRF). Covers the main +
// canary/ptb subdomains and the optional /v<n>/ version segment Discord hands out.
// Defined here (above registerVaPortalRoutes) so it can be passed into the portal.
const isDiscordWebhookUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    let u;
    try { u = new URL(url.trim()); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const allowedHost = host === 'discord.com' || host === 'discordapp.com'
        || host === 'canary.discord.com' || host === 'ptb.discord.com';
    return allowedHost && /^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(u.pathname);
};


// A safe, non-secret hint for a stored Discord webhook — mirrors the masking in
// vaPortal.js so staff surfaces (inbox, embed manager) can show "a webhook is on
// file" without ever echoing the token back. Returns '' when nothing is set.
const maskWebhookUrl = (url) => {
    if (!url) return '';
    const m = String(url).match(/webhooks\/(\d+)/);
    const id = m && m[1];
    return id ? `…/webhooks/${id.slice(-4).padStart(id.length > 4 ? 8 : id.length, '•')}/…` : '…';
};

/* =========================
 * LEADERBOARD SCHEMAS
 *
 * Old design (replaced): single doc per pilot/day with a `uniqueViewers` array
 * of hashed IPs. Every track call did `array.includes()` then rewrote the whole
 * doc. Doc size + CPU grew linearly with traffic for popular pilots.
 *
 * Newer design: tally per (date, pilot, viewer). Worked, but a single pilot
 * can be flying multiple concurrent flights and we couldn't decompose the
 * count to know *which* flight was being watched.
 *
 * Current design: tally per (date, pilot, flight, viewer). `flightId`
 * carries the live-tracker's per-flight identifier, so the leaderboard can
 * surface the exact flight that's drawing eyes. Pre-flightId clients (no
 * `flightId` in the body) bucket into a sentinel value so their views still
 * count, just lumped together per pilot.
 *
 *  - DailyPilotView    : one tiny doc per (date, pilot, flight, viewer).
 *                        Compound unique index makes "has this viewer seen
 *                        this flight today?" an O(1) insert that either
 *                        succeeds or duplicate-keys. TTL auto-deletes after 24h.
 *  - DailyPilotStats   : one tiny doc per (date, pilot, flight) holding the
 *                        counter. `$inc` is atomic — no full-doc rewrites.
 *                        TTL keeps history for 7 days.
 * ========================= */
const VIEW_TTL_SECONDS = 60 * 60 * 24;            // 24h for individual view records
const STATS_TTL_SECONDS = 60 * 60 * 24 * 7;       // 7d of daily aggregates
const NO_FLIGHT = '__none__';                     // sentinel for pre-flightId clients

const DailyPilotViewSchema = new mongoose.Schema({
    date: { type: String, required: true },        // YYYY-MM-DD
    pilotUserId: { type: String, required: true },
    flightId: { type: String, required: true, default: NO_FLIGHT },
    viewerHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
DailyPilotViewSchema.index(
    { date: 1, pilotUserId: 1, flightId: 1, viewerHash: 1 },
    { unique: true }
);
DailyPilotViewSchema.index({ createdAt: 1 }, { expireAfterSeconds: VIEW_TTL_SECONDS });

const DailyPilotView = mongoose.model('DailyPilotView', DailyPilotViewSchema);

const DailyPilotStatsSchema = new mongoose.Schema({
    date: { type: String, required: true },
    pilotUserId: { type: String, required: true },
    pilotName: { type: String, required: true },
    flightId: { type: String, required: true, default: NO_FLIGHT },
    viewCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
DailyPilotStatsSchema.index(
    { date: 1, pilotUserId: 1, flightId: 1 },
    { unique: true }
);
DailyPilotStatsSchema.index({ date: 1, viewCount: -1 });
DailyPilotStatsSchema.index({ createdAt: 1 }, { expireAfterSeconds: STATS_TTL_SECONDS });

const DailyPilotStats = mongoose.model('DailyPilotStats', DailyPilotStatsSchema);

// One-time cleanup on process start. Two jobs:
//   1. Drop any legacy stats docs left over from the uniqueViewers-array era.
//   2. Drop the previous (date, pilot, viewer) and (date, pilot) unique
//      indexes — they conflict with the new flightId-aware ones. Mongoose
//      will (re)create the correct indexes when the models load.
mongoose.connection.once('open', async () => {
    try {
        const result = await DailyPilotStats.collection.deleteMany({
            $or: [{ uniqueViewers: { $exists: true } }, { createdAt: { $exists: false } }]
        });
        if (result.deletedCount > 0) {
            console.log(`🧹 Cleared ${result.deletedCount} legacy DailyPilotStats docs.`);
        }
    } catch (e) {
        console.error('Legacy stats cleanup failed (non-fatal):', e.message);
    }

    const dropLegacyIndex = async (model, indexName) => {
        try {
            await model.collection.dropIndex(indexName);
            console.log(`🧹 Dropped legacy index ${model.modelName}.${indexName}.`);
        } catch (e) {
            // 27 = IndexNotFound — expected on fresh deploys / re-runs.
            if (e && e.code !== 27 && !/index not found/i.test(e.message)) {
                console.error(`Index drop (${model.modelName}.${indexName}) failed:`, e.message);
            }
        }
    };
    await dropLegacyIndex(DailyPilotView,  'date_1_pilotUserId_1_viewerHash_1');
    await dropLegacyIndex(DailyPilotStats, 'date_1_pilotUserId_1');

    // Make sure every legacy embed is plugged into its VA (backfills vaAdId from
    // callsign for embeds created before the link existed). Idempotent.
    backfillEmbedVaLinks();
});

// 4. CONFIGURE AWS CLIENTS
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// CloudWatch Client (Monitoring/Stats)
const cloudWatchClient = new CloudWatchClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// Configure Multer to store file in MEMORY temporarily
const upload = multer({
    dest: os.tmpdir(),
    // 15MB is comfortably above any logo/banner/aircraft image or gate CSV we
    // accept, while cutting the old 100MB ceiling that let a single upload write
    // a huge temp file — on some container hosts os.tmpdir() is RAM-backed
    // (tmpfs), so an oversized upload could spike memory toward the cap.
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

// --- START THE BOT ---
// We pass the Model AND the S3 Client/Config to the bot
startDiscordBot(
    CommunityAircraft,
    s3Client,
    process.env.AWS_S3_BUCKET_NAME,
    process.env.AWS_REGION,
    { DailyPilotStats, DailyPilotView, VirtualAirlineAd, Giveaway, VaTermsAcceptance,
      provisionVaPortalAccount: provisionOwnerAccount,
      // Per-rep portal accounts, managed alongside /va_addrep and /va_removerep.
      provisionVaPortalRepAccount: provisionRepAccount,
      deactivateVaPortalRepAccount: deactivateRepAccount,
      // Full VA teardown: wipes portal accounts, submissions, events, embeds,
      // S3 images and the flight-events webhook for a VA. The bot handles the
      // Discord channel/role + the ad doc itself.
      purgeVaData: (ad) => purgeVaData(ad, { EmbedConfig, deleteVaImage, s3Client, isDiscordWebhookUrl }) }
);
// ---------------------

// Helper to delete image from S3
const deleteS3Object = async (imageUrl) => {
    if (!imageUrl) return;
    try {
        // Extract Key from URL
        const urlObj = new URL(imageUrl);
        const key = urlObj.pathname.substring(1); // Remove leading '/'

        const command = new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key,
        });
        await s3Client.send(command);
        console.log(`🗑️ Deleted old S3 Object: ${key}`);
    } catch (error) {
        console.error(`Error deleting S3 Object: ${imageUrl}`, error);
    }
};

// Maximum number of images allowed per aircraft
const MAX_AIRCRAFT_IMAGES = 3;

// Helper: Gather uploaded image files from a multipart request.
// Accepts both the new 'images' field (multiple) and the legacy 'image' field (single),
// then caps the total at MAX_AIRCRAFT_IMAGES.
const collectUploadedImages = (req) => {
    const files = [];
    if (req.files) {
        if (Array.isArray(req.files.images)) files.push(...req.files.images);
        if (Array.isArray(req.files.image)) files.push(...req.files.image);
    }
    // Fallback for upload.single() style requests
    if (req.file) files.push(req.file);
    return files.slice(0, MAX_AIRCRAFT_IMAGES);
};

// Serialize aircraft-image sharp pipelines. Each resize decodes a full-res image
// into a large native (libvips) buffer; a burst of uploads — now reachable from
// the public partner-submission endpoint, not just staff — could otherwise run
// several at once and spike RSS toward the container cap (and on glibc that freed
// native memory lingers in the allocator's arenas, the "RSS only drops on
// restart" effect). A single-slot queue keeps at most one pipeline's buffers
// alive at a time. This mirrors the render queue in vaEventCardImage.js. The cost
// is a few ms of ordering per image, invisible next to the S3 round-trip.
let aircraftImageTail = Promise.resolve();
const queueAircraftImage = (task) => {
    const result = aircraftImageTail.then(task);
    aircraftImageTail = result.then(() => {}, () => {});
    return result;
};

// Helper: Optimize a single image file and upload it to S3, returning the public URL.
const processAndUploadAircraftImage = (file, tailRef) => queueAircraftImage(async () => {
    const optimizedBuffer = await sharp(file.path)
        .resize({ width: 1920, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

    const cleanTailName = (tailRef || 'aircraft').replace(/[^a-zA-Z0-9]/g, '');
    // Random suffix avoids collisions when several images are uploaded in the same millisecond
    const fileName = `community-aircraft/${cleanTailName}-${Date.now()}-${Math.round(Math.random() * 1e6)}.webp`;

    await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: fileName,
        Body: optimizedBuffer,
        ContentType: 'image/webp',
    }));

    return `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
});

// Helper: Optimize a single image to a webp buffer (no upload). Used by the web
// submission endpoint, which hands the buffer to the bot to attach to the Discord
// review message — the image lives on Discord until a staff approval moves it to
// S3 (mirroring the DM flow). Runs through the same single-slot sharp queue so it
// can't stack native image buffers with other uploads.
const optimizeAircraftImageBuffer = (file) => queueAircraftImage(() =>
    sharp(file.path)
        .resize({ width: 1920, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
);

// Helper: Delete every image associated with an aircraft entry (primary + gallery).
const deleteAircraftImages = async (entry) => {
    if (!entry) return;
    const urls = new Set();
    if (entry.imageUrl) urls.add(entry.imageUrl);
    if (Array.isArray(entry.imageUrls)) entry.imageUrls.forEach(u => u && urls.add(u));
    await Promise.all([...urls].map(deleteS3Object));
};

// Helper: Remove temp files left on disk by multer after processing.
const cleanupTempFiles = (files) => {
    (files || []).forEach(f => {
        if (f && f.path) fs.unlink(f.path, () => {});
    });
};

// Helper: Keep the legacy `imageUrl` field pointed at the first gallery image.
const syncPrimaryImage = (entry) => {
    entry.imageUrl = (Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0)
        ? entry.imageUrls[0]
        : null;
};

// Helper: Normalize an entry's stored images into an array, falling back to the
// legacy single `imageUrl` for records created before multi-image support.
const getEntryImages = (entry) => {
    if (Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0) return [...entry.imageUrls];
    return entry.imageUrl ? [entry.imageUrl] : [];
};

// Helper: Normalize an entry's per-image contributors into an array aligned to
// its images. For records created before per-image attribution (or any slot that
// predates it), fall back to the legacy top-level contributor.
const getEntryContributors = (entry) => {
    const images = getEntryImages(entry);
    const stored = Array.isArray(entry.imageContributors) ? entry.imageContributors : [];
    return images.map((_, i) => {
        const c = stored[i];
        if (c && (c.name || c.id)) return { name: c.name || "System", id: c.id || null };
        return { name: entry.contributorName || "System", id: entry.contributorId || null };
    });
};

// Helper: Mirror the primary (slot 0) image's contributor onto the legacy
// top-level fields so existing queries/leaderboards keep working.
const syncPrimaryContributor = (entry) => {
    if (Array.isArray(entry.imageContributors) && entry.imageContributors.length > 0) {
        entry.contributorName = entry.imageContributors[0].name || "System";
        entry.contributorId = entry.imageContributors[0].id || null;
    }
};

// Multer config for the aircraft endpoints: accept up to MAX_AIRCRAFT_IMAGES under
// the new 'images' field plus one legacy 'image' field.
const uploadAircraftImages = upload.fields([
    { name: 'images', maxCount: MAX_AIRCRAFT_IMAGES },
    { name: 'image', maxCount: 1 }
]);

// Helper: Convert S3 Stream to String
const streamToString = (stream) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

// Helper: Send Discord Webhook Notification
const sendDiscordWebhook = async (entry) => {
    if (!process.env.DISCORD_WEBHOOK_URL) return;

    try {
        const payload = {
            embeds: [{
                title: "✈️ New Aircraft Contribution!",
                color: 5763719, // Greenish color
                fields: [
                    { name: "Aircraft Type", value: entry.aircraftType, inline: true },
                    { name: "Livery", value: entry.liveryName, inline: true },
                    { name: "Tail Number", value: entry.tailNumber, inline: true },
                    { name: "Contributor", value: entry.contributorName, inline: false }
                ],
                image: { url: entry.imageUrl },
                timestamp: new Date().toISOString(),
                footer: { text: "Community Tracker Bot" }
            }]
        };

        await axios.post(process.env.DISCORD_WEBHOOK_URL, payload);
        console.log(`🔔 Notification sent to Discord for ${entry.tailNumber}`);
    } catch (error) {
        console.error("❌ Failed to send Discord Webhook:", error.message);
    }
};

/* =========================
 * HELPER: DATE UTILS
 * ========================= */
const getTodayString = () => {
    return new Date().toISOString().split('T')[0]; // Returns "YYYY-MM-DD"
};

const hashIp = (ip) => {
    return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
};

// 5. API ROUTES

// Staff portal auth routes (login / logout / me / user management).
registerAuthRoutes(app);

// VA Partnership Portal routes (partner login/submissions/team + staff oversight).
// sendVaTestEvent is defined further down (with the card renderer); wrap it in a
// lambda so this call site doesn't touch it before it's initialised — the wrapper
// only resolves it at request time, when the "send test" button is clicked.
registerVaPortalRoutes(app, { VirtualAirlineAd, EmbedConfig, VaPilot, s3Client, upload, uploadVaImage, deleteVaImage, isDiscordWebhookUrl, sendVaTestEvent: (ad) => sendVaTestEvent(ad), renderCardPreview: (ad, opts) => renderCardPreview(ad, opts), applyEmbedAppearance: (cfg, body) => applyEmbedAppearance(cfg, body) });

// Crew Center sign-in routes (POST /api/crew/:slug/login, GET /api/crew/:slug/me).
registerCrewAuthRoutes(app);

// ---- Infinite Flight aircraft + livery reference ----
// The crew center fleet builder lets a VA declare which aircraft/liveries they
// operate. For the tracker to attribute live flights to that fleet, the names a
// VA types have to be the SAME canonical strings the live API reports. We proxy
// the ACARS backend's /api/metadata (the single source of truth for aircraft and
// livery names) and reshape it into { aircraft:[names], liveries:{ name:[…] } }
// so the fleet editor can offer exact matches instead of free text. Cached in
// memory because the catalogue changes only when IF ships an update.
let _acMetaCache = { at: 0, data: null };
const AC_META_TTL = 6 * 60 * 60 * 1000; // 6h
async function loadAircraftMetadata() {
    if (_acMetaCache.data && (Date.now() - _acMetaCache.at) < AC_META_TTL) return _acMetaCache.data;
    const resp = await axios.get(`${ACARS_BACKEND_URL}/api/metadata`, { timeout: 8000 });
    const j = resp?.data || {};
    if (!j.ok) throw new Error('metadata upstream not ok');
    // aircraft: canonical type names (sorted, de-duped) + an id→name map used to
    // resolve the UUIDs on a live flight back to a name.
    const acById = new Map();
    for (const a of (j.aircraft || [])) {
        const id = String(a && a.id || '').toLowerCase(); const name = String(a && a.name || '').trim();
        if (id && name) acById.set(id, name);
    }
    const aircraft = [...new Set([...acById.values()])].sort((a, b) => a.localeCompare(b));
    // liveries: keyed by their aircraft name so the editor can filter per type;
    // plus an id→{liveryName,aircraftName} map for flight resolution.
    const liveries = {};
    const livById = new Map();
    for (const l of (j.liveries || [])) {
        const ac = String(l && l.aircraftName || '').trim();
        const name = String(l && l.name || '').trim();
        const id = String(l && l.id || '').toLowerCase();
        if (id && name) livById.set(id, { liveryName: name, aircraftName: ac });
        if (!ac || !name) continue;
        (liveries[ac] = liveries[ac] || []).push(name);
    }
    for (const ac of Object.keys(liveries)) {
        liveries[ac] = [...new Set(liveries[ac])].sort((a, b) => a.localeCompare(b));
    }
    const data = { aircraft, liveries, acById, livById };
    _acMetaCache = { at: Date.now(), data };
    return data;
}
// Public reference — no auth. Reference data the fleet builder reads. Only the
// name lists are exposed (the id maps are for server-side flight resolution).
app.get('/api/crew/aircraft-metadata', async (req, res) => {
    try {
        const { aircraft, liveries } = await loadAircraftMetadata();
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ ok: true, aircraft, liveries });
    } catch (err) {
        console.error('aircraft-metadata error:', err?.message || err);
        // Serve a stale copy rather than nothing if we have one.
        if (_acMetaCache.data) {
            const { aircraft, liveries } = _acMetaCache.data;
            return res.json({ ok: true, stale: true, aircraft, liveries });
        }
        res.status(502).json({ ok: false, error: 'Aircraft metadata unavailable.', aircraft: [], liveries: {} });
    }
});

// ---- The crew center setup script ----
// The SQL a VA runs in their own Supabase project, served from the one copy in
// this repo. The crew dashboard's "Copy setup SQL" button fetches it rather
// than carrying its own inline duplicate — two copies of a schema in two repos
// drift, and the failure mode is a VA whose tables are subtly the wrong shape.
//
// Public: it is a schema, not a secret, and the VA is about to paste it into
// their own SQL editor.
//
// Read here rather than in each caller: the automatic setup path runs this very
// file against the VA's project (see /store/provision), so the script we hand
// out to copy and the script we execute are the same bytes by construction.
let _setupSqlCache = null;
function readSetupSql() {
    if (!_setupSqlCache) {
        _setupSqlCache = fs.readFileSync(path.join(__dirname, 'supabase', 'crew-center-schema.sql'), 'utf8');
    }
    return _setupSqlCache;
}
app.get('/api/crew/setup-sql', (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=600');
        res.type('text/plain; charset=utf-8').send(readSetupSql());
    } catch (err) {
        console.error('setup-sql read error:', err);
        res.status(500).type('text/plain').send('-- The setup script could not be read. Contact Inflight support.');
    }
});

// ---- Crew data ----
// Resolve the VA behind a crew-center slug. The selection includes the VA's
// data-store connection (crewStore.SELECT pulls in the secret service key) so
// the caller can immediately open a store against the VA's own project.
async function resolveCrewVa(slug) {
    const raw = String(slug || '').trim().toLowerCase();
    if (!raw) return null;
    const sel = crewStore.SELECT;
    let va = await VirtualAirlineAd.findOne({ slug: raw, status: 'approved' }).select(sel).lean();
    if (!va) va = await VirtualAirlineAd.findOne({ callsign: raw.toUpperCase(), status: 'approved' }).select(sel).lean();
    return va;
}

// Resolve the VA *and* open its store in one step. Throws a CrewStoreError
// (404 for an unknown slug, 409 when the VA has not connected a project) which
// crewFail below turns into the right reply.
async function resolveCrewStore(slug) {
    const va = await resolveCrewVa(slug);
    if (!va) throw new crewStore.CrewStoreError('Crew center not found.', { status: 404, code: 'va_not_found' });
    return { va, store: await crewStore.forVa(va) };
}

// One error shape for every crew handler. A fault inside the VA's own database
// is the VA's to fix, so its status and message are passed through verbatim
// (with the machine-readable code) instead of being flattened to "500 something
// went wrong" — which would read as our outage. Anything else is ours: log it
// and say so generically.
function crewFail(res, err, fallback) {
    if (err instanceof crewStore.CrewStoreError) {
        if (err.detail) console.warn(`crew store [${err.code}]:`, err.detail);
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(`${fallback.log}:`, err);
    return res.status(500).json({ error: fallback.message });
}

// A write that succeeded, but did less than it was asked to because the VA's
// project is on an older schema than this code (see LATE_COLUMNS in
// crewStore.js). Returned alongside the saved row rather than as an error: the
// route IS in the network, it just is not marked as a codeshare yet, and a VA
// who is told that will go and press the update button.
function driftWarning(store) {
    const lost = (store && typeof store.drift === 'function') ? store.drift() : [];
    if (!lost.length) return '';
    return `Saved — but your database is on an older version and doesn’t support ${lost.join(' or ')} yet. `
        + 'Update it in Settings → Data store to keep those.';
}
// Attach the warning only when there is one, so an up-to-date VA's responses
// are byte-for-byte what they were.
const withDrift = (store, payload) => {
    const warning = driftWarning(store);
    return warning ? { ...payload, warning, code: 'store_schema_outdated' } : payload;
};

function cleanMember(b) {
    b = b || {};
    return {
        name: String(b.name || '').trim().slice(0, 60),
        callsign: String(b.callsign || '').trim().slice(0, 20),
        hours: Math.max(0, Math.min(1e6, Number(b.hours) || 0)),
        role: String(b.role || '').trim().slice(0, 40),
        aircraft: Array.isArray(b.aircraft) ? b.aircraft.slice(0, 40).map(a => String(a).trim().slice(0, 40)).filter(Boolean) : [],
        status: ['active', 'loa', 'inactive'].includes(b.status) ? b.status : 'active',
        // Preserved through edits (PATCH merges the existing member through here);
        // staff may also set/clear the IF link by hand.
        ifUserId: String(b.ifUserId || '').trim().slice(0, 40),
        ifcName: String(b.ifcName || '').trim().slice(0, 60),
    };
}
// `ranks` is the VA's ladder. Passing it resolves the pilot's rank here rather
// than in each of the three front-ends that draw a badge — one arithmetic, one
// answer. A new pilot at zero hours lands on the entry rung rather than on
// nothing, which is the whole point of resolving it centrally.
const publicMember = (m, ranks) => ({
    id: m._id, name: m.name, callsign: m.callsign, hours: m.hours,
    role: m.role, aircraft: m.aircraft || [], status: m.status,
    linked: !!m.ifUserId,   // is this pilot linked to an IF account for auto-PIREPs?
    // The badge, plus `awaitingCheck` when hours have taken this pilot as far
    // as a rung a person has to sign off. The roster draws "ready for their
    // Captain check-ride" from it, which is the difference between a pilot who
    // has stopped being promoted and one who is waiting on staff.
    rank: crewRanks.memberRank(ranks, m.hours, m.checksPassed),
    checksPassed: Array.isArray(m.checksPassed) ? m.checksPassed : [],
});
// Owner/staff (or Inflight) gate for roster writes.
function crewCanManage(req, slug) {
    const p = verifyCrewRequest(req);
    if (!p) return { error: 401 };
    if (!(p.kind === 'inflight' || p.role === 'owner' || p.role === 'staff')) return { error: 403 };
    if (p.kind !== 'inflight' && p.slug && p.slug !== String(slug).toLowerCase()) return { error: 403 };
    return { p };
}
// Capability gate: like crewCanManage, but a staff member must additionally
// hold `capability`. Owner + Inflight always pass. Async because a staff
// member's permissions live on the VA (staffRoles/staffAssignments).
async function requireCap(req, slug, capability) {
    const base = crewCanManage(req, slug);
    if (base.error) return base;
    const p = base.p;
    if (p.kind === 'inflight' || p.role === 'owner') return { p };
    // staff: resolve their role's permissions from the VA.
    const va = await VirtualAirlineAd.findById(p.vaId).select('staffRoles staffAssignments').lean();
    if (effectiveCaps(va, p).includes(capability)) return { p };
    return { error: 403 };
}

// The pilot making this request, when it is a pilot — so a route can say
// whether their rank opens it.
//
// Returns null for staff, for Inflight oversight and for the public. None of
// them are flying these legs, and marking a route "locked" for a manager
// reviewing their own network would be nonsense.
async function crewViewer(req, store) {
    const p = verifyCrewRequest(req);
    if (!p || p.kind !== 'crew') return null;
    try {
        const account = await store.getAccount(p.sub);
        if (!account) return null;
        const member = account.memberId ? await store.getMember(account.memberId) : null;
        // A pilot with a login but no roster row yet is treated as zero hours —
        // the entry rank — rather than as nobody.
        return { hours: member ? Number(member.hours) || 0 : 0, memberId: member ? member._id : null };
    } catch { return null; }
}

// Public read — the roster is shown on the crew center.
app.get('/api/crew/:slug/roster', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const members = await store.listMembers();
        res.json({ roster: members.map((m) => publicMember(m, va.ranks)) });
    } catch (err) { crewFail(res, err, { log: 'roster list error', message: 'Could not load the roster.' }); }
});
// Add a member.
app.post('/api/crew/:slug/roster', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const m = await store.createMember(cleanMember(req.body));
        vaStats.recordEngagement(va._id, 'crewJoin', 1, va.name);
        res.status(201).json({ member: publicMember(m, va.ranks) });
    } catch (err) { crewFail(res, err, { log: 'roster add error', message: 'Could not add the pilot.' }); }
});
// Edit a member.
app.patch('/api/crew/:slug/roster/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getMember(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Pilot not found.' });
        // Merge over the current record before cleaning so a partial PATCH keeps
        // the fields it didn't mention (notably the IF link, which the roster
        // editor never sends back).
        const m = await store.updateMember(req.params.id, cleanMember({ ...existing, ...req.body }));
        // Staff editing hours by hand can promote someone too — that is a real
        // promotion and worth the same notice an approved flight would earn.
        const promotion = crewRanks.promotionFor(va.ranks, existing.hours, m.hours, m.checksPassed);
        if (promotion) postPromotionNotice(va, m, promotion);
        res.json({ member: publicMember(m, va.ranks) });
    } catch (err) { crewFail(res, err, { log: 'roster edit error', message: 'Could not update the pilot.' }); }
});
// Remove a member.
app.delete('/api/crew/:slug/roster/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        await store.deleteMember(req.params.id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'roster delete error', message: 'Could not remove the pilot.' }); }
});

/**
 * Sign a pilot off for a rung — or take the sign-off back.
 *
 * A VA can mark any rung of their ladder "requires a check-ride", and hours
 * then carry a pilot only as far as its door: they hold the rung below and the
 * roster shows them waiting. This is the door being opened.
 *
 * POST { rank: 'Captain' }              — passed, promote them
 * POST { rank: 'Captain', pass: false } — take it back
 *
 * The promotion this causes earns the SAME announcement an hours-driven one
 * does (crewRanks.promotionForCheck), because from the pilot's side they are
 * the same event: they are a Captain now. Revoking announces nothing, like
 * every other downward move in this codebase.
 */
app.post('/api/crew/:slug/roster/:id/checkride', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const member = await store.getMember(req.params.id);
        if (!member) return res.status(404).json({ error: 'Pilot not found.' });

        const wanted = String((req.body || {}).rank || '').trim().slice(0, 40);
        if (!wanted) return res.status(400).json({ error: 'Say which rank the check-ride was for.' });
        // The rung has to be one on the VA's current ladder. A sign-off for a
        // rank that does not exist would sit in the column forever, doing
        // nothing and confusing whoever reads it next.
        const ladder = crewRanks.normalizeLadder(va.ranks);
        const rung = ladder.find((r) => r.name.toLowerCase() === wanted.toLowerCase());
        if (!rung) return res.status(400).json({ error: `${wanted} isn’t a rank on your ladder.` });

        const pass = (req.body || {}).pass !== false;
        const before = Array.isArray(member.checksPassed) ? member.checksPassed : [];
        const after = pass
            ? [...new Set([...before, rung.name])]
            : before.filter((c) => String(c).toLowerCase() !== rung.name.toLowerCase());

        const saved = await store.updateMember(member._id, { checksPassed: after });
        const promotion = crewRanks.promotionForCheck(va.ranks, saved.hours, before, after);
        if (promotion) {
            postPromotionNotice(va, saved, promotion, { by: (gate.p && gate.p.name) || '', viaCheck: true });
            postAnnouncement(va, {
                kind: 'promotion',
                title: `${saved.name || 'A pilot'} is now ${promotion.to.name}`,
                body: `Signed off after their ${rung.name} check-ride.`,
                refId: saved._id,
            });
        }
        res.json(withDrift(store, { member: publicMember(saved, va.ranks), promoted: !!promotion }));
    } catch (err) { crewFail(res, err, { log: 'checkride error', message: 'Could not record the check-ride.' }); }
});

// ---- Route network ----
const cleanRoute = (b) => {
    b = b || {};
    const icao = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    // A partner logo is rendered in an <img> on a public crew center page, so
    // anything that is not plainly an https URL is dropped rather than passed
    // through — the same rule the branding fields already follow.
    const logo = String(b.partnerLogo || '').trim().slice(0, 600);
    const kind = b.kind === 'codeshare' ? 'codeshare' : 'own';
    return {
        flightNumber: String(b.flightNumber || '').trim().slice(0, 12),
        origin: icao(b.origin),
        destination: icao(b.destination),
        aircraft: String(b.aircraft || '').trim().slice(0, 60),
        distanceNm: Math.max(0, Math.min(20000, Math.round(Number(b.distanceNm) || 0))),
        notes: String(b.notes || '').trim().slice(0, 500),
        active: b.active === undefined ? true : !!b.active,
        kind,
        // Partner details only mean anything on a codeshare. Clearing them when
        // a route is flipped back to 'own' stops a stale partner logo appearing
        // beside a leg the airline now operates itself.
        partnerName: kind === 'codeshare' ? String(b.partnerName || '').trim().slice(0, 60) : '',
        partnerLogo: kind === 'codeshare' && /^https:\/\//i.test(logo) ? logo : '',
        minRank: String(b.minRank || '').trim().slice(0, 40),
    };
};
// `viewer` carries the hours of the pilot asking, when there is one, so a route
// can say whether it is open to them. Staff and the public get `locked: false`
// — the gate is about what a PILOT may fly, and hiding the shape of the network
// from everyone else would make a rank ladder impossible to plan around.
const publicRoute = (r, ranks, viewer) => {
    const gated = !!r.minRank;
    const locked = gated && !!viewer && !crewRanks.meetsRank(ranks, viewer.hours, r.minRank);
    return {
        id: r._id, flightNumber: r.flightNumber, origin: r.origin, destination: r.destination,
        aircraft: r.aircraft, distanceNm: r.distanceNm, notes: r.notes, active: r.active,
        kind: r.kind === 'codeshare' ? 'codeshare' : 'own',
        partnerName: r.partnerName || '', partnerLogo: r.partnerLogo || '',
        minRank: r.minRank || '',
        locked,
        // How much further this particular pilot has to fly. Shown rather than
        // hidden on purpose: "unlocks in 12h" is the thing that makes a rank
        // ladder worth climbing, where a route that simply is not there is
        // indistinguishable from a network that is smaller than advertised.
        hoursUntilUnlock: locked ? crewRanks.hoursUntilRank(ranks, viewer.hours, r.minRank) : 0,
    };
};
/**
 * The codeshare network, grouped by partner airline.
 *
 * One entry per partner, carrying enough to draw a clickable tile — the name,
 * a logo when the VA gave one, how many legs, where they go, and the lowest
 * rank that opens any of them.
 *
 * Grouped on a case-folded name because "Delta Virtual" and "delta virtual" are
 * one airline to everybody except a `groupBy`, and a VA typing the partner in
 * by hand on each route WILL produce both. The display name kept is the first
 * spelling seen, so the tile reads the way the VA writes it.
 *
 * `lockedRoutes` counts what is shut to the pilot ASKING, so a tile can say
 * "3 of 8 open at First Officer" rather than either hiding the partner or
 * pretending all of it is available. It is 0 for staff and the public, who are
 * never marked locked — the gate is about what a pilot may fly.
 */
function codesharePartners(routes) {
    const byName = new Map();
    for (const r of routes) {
        if (r.kind !== 'codeshare') continue;
        const name = String(r.partnerName || '').trim();
        const key = name.toLowerCase() || '(unnamed)';
        let p = byName.get(key);
        if (!p) {
            p = {
                name: name || 'Partner airline',
                logo: r.partnerLogo || '',
                routes: 0,
                destinations: new Set(),
                lockedRoutes: 0,
            };
            byName.set(key, p);
        }
        p.routes += 1;
        if (!p.logo && r.partnerLogo) p.logo = r.partnerLogo;
        if (r.destination) p.destinations.add(r.destination);
        if (r.locked) p.lockedRoutes += 1;
    }
    return [...byName.values()]
        .map((p) => ({
            name: p.name,
            logo: p.logo,
            routes: p.routes,
            destinations: p.destinations.size,
            // How much of this partner is shut to the pilot asking. Zero for
            // staff and the public, who are never marked locked.
            lockedRoutes: p.lockedRoutes,
        }))
        .sort((a, b) => b.routes - a.routes || a.name.localeCompare(b.name));
}

// Public: the VA's route network (active only for non-managers is handled client-side;
// here we return all so managers see drafts too — the list isn't sensitive).
//
// `counts` splits the network the way the map and the panel draw it. Sent from
// here rather than counted in the browser so the figure a VA quotes for "our
// network" is the same number everywhere, and so it is obvious at a glance how
// much of a network is the airline's own metal.
app.get('/api/crew/:slug/routes', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const routes = await store.listRoutes();
        const viewer = await crewViewer(req, store);
        const out = routes.map((r) => publicRoute(r, va.ranks, viewer));
        res.json({
            routes: out,
            counts: {
                own: out.filter((r) => r.kind === 'own').length,
                codeshare: out.filter((r) => r.kind === 'codeshare').length,
                locked: out.filter((r) => r.locked).length,
            },
            // The codeshare network, grouped by the airline whose metal it is.
            //
            // Sent from here rather than grouped in three different browsers,
            // for the reason `counts` is: one answer to "who do we codeshare
            // with, and how much", so a VA's own site, the route panel and the
            // network map cannot quote different figures. It is also what makes
            // a partner's logo something to click — a route list filtered to
            // one airline is the question a pilot actually has ("what can I fly
            // on Delta's metal?"), and grouping it here means the front end
            // only has to draw it.
            partners: codesharePartners(out),
            // So a pilot's route list can say "unlocks at First Officer" using
            // the VA's own words rather than an hours figure.
            ranks: crewRanks.normalizeLadder(va.ranks).map((r) => ({ name: r.name, minHours: r.minHours })),
        });
    } catch (err) { crewFail(res, err, { log: 'routes list error', message: 'Could not load routes.' }); }
});
/* Public: the same network, joined to real airport coordinates so it can be
 * drawn rather than listed.
 *
 * The crew center's network map has always asked for this. Until now nothing
 * answered, so it fell back to a thirty-airport table compiled into the page —
 * which meant a VA flying anywhere outside the world's majors watched its own
 * network render as a handful of arcs and a row of "unmapped" chips. The
 * coordinates were here the whole time: data/airport-coords.json is the same
 * ~5,900-field index the flight-event card draws its route map from.
 *
 * Shape is dictated by what the map already reads (see rmFetch in
 * crew-dashboard.html): every route carries `o`/`d` as [lat, lon] plus a
 * `mapped` flag, and `airports` is the same set aggregated per field with its
 * departure and arrival counts, which is what sizes the dots.
 *
 * Public for the reason /routes is: a route network is what a VA advertises,
 * and `publicRoute` still decides per-viewer what is locked.
 *
 * (AIRPORT_COORDS and routeDistanceNm are initialized further down this file.
 * Both are read at request time, long after the module has finished loading.)
 */
app.get('/api/crew/:slug/route-map', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const routes = await store.listRoutes();
        const viewer = await crewViewer(req, store);

        const coordsFor = (icao) => {
            const v = AIRPORT_COORDS[String(icao || '').trim().toUpperCase()];
            return (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) ? v : null;
        };

        // icao -> { dep, arr } as we walk the network, so a field's size on the
        // map is how much of the operation actually touches it.
        const touched = new Map();
        const bump = (icao, key) => {
            if (!icao) return;
            const e = touched.get(icao) || { dep: 0, arr: 0 };
            e[key] += 1;
            touched.set(icao, e);
        };

        const out = routes.map((r) => {
            const pub = publicRoute(r, va.ranks, viewer);
            const o = coordsFor(pub.origin);
            const d = coordsFor(pub.destination);
            if (o) bump(pub.origin, 'dep');
            if (d) bump(pub.destination, 'arr');
            return {
                ...pub,
                // A VA that never typed a distance still gets one on the map,
                // computed from the two ends we just resolved — the same
                // great-circle figure the flight-event card quotes.
                distanceNm: pub.distanceNm || (o && d ? (routeDistanceNm(pub.origin, pub.destination) || 0) : 0),
                o, d,
                mapped: !!(o && d),
            };
        });

        const airports = [...touched.entries()].map(([icao, c]) => {
            const [lat, lon] = coordsFor(icao);
            return { icao, lat, lon, dep: c.dep, arr: c.arr, routes: c.dep + c.arr, mapped: true };
        }).sort((a, b) => b.routes - a.routes || a.icao.localeCompare(b.icao));

        /* What the crew is actually flying, for whoever plans the network.
         *
         * A published route network is a plan; the flight log is what happened.
         * The gap between them is the question a route manager actually has —
         * "we have flown FAOR-SBGR eleven times and it isn't in our network" —
         * and until now the only way to see it was to read the PIREP list and
         * the route list side by side.
         *
         * Gated on routes.manage rather than public: aggregate counts are not
         * especially sensitive, but this exists to be acted on by the people
         * who maintain the network, and the public response stays exactly as
         * it was for everybody else.
         */
        const canManage = !(await requireCap(req, req.params.slug, 'routes.manage')).error;
        let flown = null;
        if (canManage) {
            // Approved only. A pending report is a claim, and a rejected one is
            // a claim the VA has already turned down — neither is evidence that
            // the airline flies a city pair.
            const pireps = await store.listPireps({ status: 'approved', limit: 5000 });
            const published = new Set(out.map((r) => `${r.origin}>${r.destination}`));
            const pairs = new Map();
            for (const p of pireps) {
                const origin = String(p.origin || '').trim().toUpperCase();
                const destination = String(p.destination || '').trim().toUpperCase();
                if (!origin || !destination || origin === destination) continue;
                const key = `${origin}>${destination}`;
                const e = pairs.get(key) || { origin, destination, flights: 0, minutes: 0 };
                e.flights += 1;
                e.minutes += Number(p.durationMin) || 0;
                pairs.set(key, e);
            }
            flown = [...pairs.entries()].map(([key, e]) => {
                const o = coordsFor(e.origin), d = coordsFor(e.destination);
                return { ...e, o, d, mapped: !!(o && d), published: published.has(key) };
            }).sort((a, b) => b.flights - a.flights);
        }

        const mapped = out.filter((r) => r.mapped).length;
        res.json({
            routes: out,
            airports,
            // Null rather than [] for a viewer who cannot see it, so the map can
            // tell "no flying yet" apart from "not yours to look at".
            flown,
            // `unmapped` is drawn as a warning chip on the map, so it counts
            // routes the VA can act on — a leg with an ICAO we cannot place.
            stats: {
                mapped,
                unmapped: out.length - mapped,
                airports: airports.length,
                // City pairs the crew has flown that the network does not list.
                unpublished: flown ? flown.filter((f) => !f.published).length : 0,
            },
        });
    } catch (err) { crewFail(res, err, { log: 'route map error', message: 'Could not load the route map.' }); }
});

app.post('/api/crew/:slug/routes', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'routes.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const r = await store.createRoute(cleanRoute(req.body));
        postRouteNotice(va, 'added', r, gate.p);
        res.status(201).json(withDrift(store, { route: publicRoute(r, va.ranks, null) }));
    } catch (err) { crewFail(res, err, { log: 'route add error', message: 'Could not add the route.' }); }
});
app.patch('/api/crew/:slug/routes/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'routes.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getRoute(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Route not found.' });
        const r = await store.updateRoute(req.params.id, cleanRoute({ ...existing, ...req.body }));
        postRouteNotice(va, 'updated', r, gate.p, existing);
        res.json(withDrift(store, { route: publicRoute(r, va.ranks, null) }));
    } catch (err) { crewFail(res, err, { log: 'route edit error', message: 'Could not update the route.' }); }
});
app.delete('/api/crew/:slug/routes/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'routes.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        // Read it before it goes, so the notice can name the leg rather than an
        // id nobody recognises.
        const existing = await store.getRoute(req.params.id).catch(() => null);
        await store.deleteRoute(req.params.id);
        if (existing) postRouteNotice(va, 'removed', existing, gate.p);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'route delete error', message: 'Could not remove the route.' }); }
});

// ---- Roster and routes as CSV ----
//
// A VA's data being in the VA's own database settles who owns it; being able to
// carry it out in a form a person can open settles whether that ownership is
// worth anything. These four endpoints are the same file in both directions —
// what export writes, import accepts — so a file that goes out and comes back
// untouched changes nothing.
//
// Import never deletes. A row that is in the crew center and not in the file is
// left where it is: a VA uploading the twelve pilots they recruited this month
// must not lose the other two hundred, and no amount of inspection tells that
// file apart from a complete one. See crewCsv.js.

const csvFilename = (slug, kind) => `${String(slug || 'crew').replace(/[^a-z0-9-]/gi, '')}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;

function sendCsv(res, slug, kind, spec, rows) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${csvFilename(slug, kind)}"`);
    res.set('Cache-Control', 'no-store');
    res.send(crewCsv.toCsv(spec, rows));
}

// Shared by both importers: plan it, and either report the plan or carry it out.
//
// The dry run is not an optimisation, it is the point — the dashboard shows a
// VA what an upload would do before it touches a live roster, and the commit
// replays that same plan rather than re-deciding.
async function runCsvImport({ req, res, spec, kind, existing, create, update, onDone, store }) {
    const csvText = String(req.body?.csv || '');
    if (!csvText.trim()) return res.status(400).json({ error: 'Attach a CSV file first.' });

    const plan = crewCsv.planImport(spec, csvText, existing);
    if (plan.error) return res.status(400).json({ error: plan.error });

    const summary = {
        kind,
        create: plan.create.length,
        update: plan.update.length,
        unchanged: plan.unchanged,
        errors: plan.errors.slice(0, 50),
        errorCount: plan.errors.length,
        matchedOn: plan.matchedOn,
        columns: plan.columns,
        missing: plan.missing,
        // A preview of what would change, so the confirm step can show the
        // first few rows rather than only a count.
        sample: {
            create: plan.create.slice(0, 5).map((r) => r.values),
            update: plan.update.slice(0, 5).map((r) => ({ id: r.id, before: r.before, values: r.values })),
        },
    };

    if (req.body?.dryRun !== false) return res.json({ dryRun: true, ...summary });

    // Refuse a file we could not fully read rather than applying the good half.
    // A partial import is the worst outcome available: the VA cannot tell what
    // landed, and re-uploading the fixed file re-applies everything that did.
    if (plan.errors.length) {
        return res.status(400).json({
            error: `Fix the ${plan.errors.length} problem row${plan.errors.length === 1 ? '' : 's'} and import again — nothing has been changed.`,
            ...summary,
        });
    }

    let created = 0; let updated = 0;
    const failures = [];
    for (const row of plan.create) {
        try { await create(row.values); created++; } catch (err) {
            failures.push({ line: row.line, message: err?.message || 'Could not add this row.' });
        }
    }
    for (const row of plan.update) {
        try { await update(row.id, row.values, row.before); updated++; } catch (err) {
            failures.push({ line: row.line, message: err?.message || 'Could not update this row.' });
        }
    }
    if (onDone) { try { onDone({ ...summary, created, updated }); } catch { /* never fail an import over a notice */ } }
    res.json(withDrift(store, { dryRun: false, ...summary, created, updated, failures }));
}

app.get('/api/crew/:slug/roster.csv', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const members = await store.listMembers();
        // Exported from the stored row, not from publicMember: the point of an
        // export is to hand back everything, including the Infinite Flight link
        // that the roster screen never shows.
        sendCsv(res, req.params.slug, 'roster', crewCsv.ROSTER_SPEC, (members || []).map((m) => ({
            id: m._id, name: m.name, callsign: m.callsign, hours: m.hours, role: m.role,
            aircraft: m.aircraft || [], status: m.status, ifcName: m.ifcName || '', ifUserId: m.ifUserId || '',
        })));
    } catch (err) { crewFail(res, err, { log: 'roster export error', message: 'Could not export the roster.' }); }
});

app.post('/api/crew/:slug/roster/import', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const members = await store.listMembers();
        await runCsvImport({
            req, res, store, kind: 'roster', spec: crewCsv.ROSTER_SPEC,
            existing: (members || []).map((m) => ({
                id: m._id, name: m.name, callsign: m.callsign, hours: m.hours, role: m.role,
                aircraft: m.aircraft || [], status: m.status, ifcName: m.ifcName || '', ifUserId: m.ifUserId || '',
            })),
            create: (values) => store.createMember(cleanMember(values)),
            // Merge over what is already there before cleaning, exactly as the
            // roster editor's PATCH does — a file with six columns must not
            // blank the three it never mentioned.
            update: (id, values, before) => store.updateMember(id, cleanMember({ ...before, ...values })),
        });
    } catch (err) { crewFail(res, err, { log: 'roster import error', message: 'Could not import the roster.' }); }
});

app.get('/api/crew/:slug/routes.csv', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'routes.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const routes = await store.listRoutes();
        // Every column the spec defines, including the v5 ones. Leaving them out
        // wrote a file whose `kind` and `minRank` cells were blank, and blank is
        // a value on the way back in — a VA who exported their network and
        // re-imported it unedited would have turned every codeshare into an own
        // route and dropped every rank gate. Export what import reads.
        sendCsv(res, req.params.slug, 'routes', crewCsv.ROUTES_SPEC, (routes || []).map((r) => ({
            id: r._id, flightNumber: r.flightNumber, origin: r.origin, destination: r.destination,
            aircraft: r.aircraft, distanceNm: r.distanceNm, notes: r.notes, active: r.active,
            kind: r.kind || 'own', partnerName: r.partnerName || '',
            partnerLogo: r.partnerLogo || '', minRank: r.minRank || '',
        })));
    } catch (err) { crewFail(res, err, { log: 'routes export error', message: 'Could not export the routes.' }); }
});

app.post('/api/crew/:slug/routes/import', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'routes.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const routes = await store.listRoutes();
        await runCsvImport({
            req, res, store, kind: 'routes', spec: crewCsv.ROUTES_SPEC,
            existing: (routes || []).map((r) => ({
                id: r._id, flightNumber: r.flightNumber, origin: r.origin, destination: r.destination,
                aircraft: r.aircraft, distanceNm: r.distanceNm, notes: r.notes, active: r.active,
                kind: r.kind, partnerName: r.partnerName, partnerLogo: r.partnerLogo, minRank: r.minRank,
            })),
            create: (values) => store.createRoute(cleanRoute(values)),
            update: (id, values, before) => store.updateRoute(id, cleanRoute({ ...before, ...values })),
            // One notice for the whole file. Posting per row would rate-limit a
            // VA importing a 200-route network and bury everything else.
            onDone: (summary) => postRouteImportNotice(va, summary, gate.p),
        });
    } catch (err) { crewFail(res, err, { log: 'routes import error', message: 'Could not import the routes.' }); }
});

// ---- The noticeboard ----
//
// What a VA tells its crew, and what the crew center tells them on the VA's
// behalf. The second kind is why this exists: a promotion, a new pilot, a
// published event all already happen inside the crew center, and until now the
// only trace was a Discord message that scrolls away by Thursday. A pilot who
// joined on Tuesday should still be able to see on Friday that they joined.
const cleanAnnouncement = (b) => {
    b = b || {};
    return {
        title: String(b.title || '').trim().slice(0, 160),
        body: String(b.body || '').trim().slice(0, 4000),
        // Only 'notice' can be written by hand. The other kinds are the crew
        // center's own record of things that happened, and a staff member
        // posting a hand-written "promotion" would be indistinguishable on the
        // board from one that actually occurred.
        kind: 'notice',
        pinned: !!b.pinned,
    };
};

const publicAnnouncement = (a) => ({
    id: a._id,
    title: a.title, body: a.body, kind: a.kind,
    // So a page can style what the crew center wrote differently from what a
    // human wrote, and so a cleanup job can tell them apart.
    auto: a.source === 'auto',
    pinned: a.pinned,
    refId: a.refId || null,
    authorName: a.authorName || '',
    createdAt: a.createdAt,
});

// Who may write to the noticeboard.
//
// `announcements.manage` was split out of `roster.manage`, which had made
// writing to the crew and administering the roster one job: a VA could not have
// somebody who posts notices without also handing them every pilot record.
// crewAuth's CAPABILITY_HEIRS keeps a role built before the split working, so
// this asks for the precise capability and gets the right answer either way.
const canManageNotices = async (req, slug) => !(await requireCap(req, slug, 'announcements.manage')).error;

// Public: a crew center's noticeboard is part of what it shows the world.
app.get('/api/crew/:slug/announcements', async (req, res) => {
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const canManage = await canManageNotices(req, req.params.slug);
        const list = await store.listAnnouncements({ limit: 50 });
        res.json({ announcements: list.map(publicAnnouncement), canManage });
    } catch (err) { crewFail(res, err, { log: 'announcements list error', message: 'Could not load the noticeboard.' }); }
});

app.post('/api/crew/:slug/announcements', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'announcements.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const body = cleanAnnouncement(req.body);
        if (!body.title) return res.status(400).json({ error: 'Give the notice a title.' });
        const a = await store.createAnnouncement({
            ...body, source: 'staff', authorName: (gate.p && gate.p.name) || '',
        });
        res.status(201).json(withDrift(store, { announcement: publicAnnouncement(a) }));
    } catch (err) { crewFail(res, err, { log: 'announcement add error', message: 'Could not post the notice.' }); }
});

app.patch('/api/crew/:slug/announcements/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'announcements.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getAnnouncement(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Notice not found.' });
        const b = req.body || {};
        const patch = {};
        // Pinning is the one thing that may be done to a generated row: staff
        // keeping a promotion at the top of the board is reasonable, rewriting
        // what the crew center recorded is not.
        if (b.pinned !== undefined) patch.pinned = !!b.pinned;
        if (existing.source !== 'auto') {
            if (b.title !== undefined) patch.title = String(b.title || '').trim().slice(0, 160);
            if (b.body !== undefined) patch.body = String(b.body || '').trim().slice(0, 4000);
        }
        const a = await store.updateAnnouncement(existing._id, patch);
        res.json(withDrift(store, { announcement: publicAnnouncement(a) }));
    } catch (err) { crewFail(res, err, { log: 'announcement edit error', message: 'Could not update the notice.' }); }
});

app.delete('/api/crew/:slug/announcements/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'announcements.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        await store.deleteAnnouncement(req.params.id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'announcement delete error', message: 'Could not remove the notice.' }); }
});

// ---- The Inflight partnership, as the VA's own crew center sees it ----
//
// A partnered VA has a relationship with us that lives in three places they
// have to go looking for: their directory listing, the Terms they accepted, and
// any warnings we have issued. All three are administered in the VA Partnership
// Portal, behind its own separate login (see vaPortal.js) — which is right,
// because that is where the VA's side of the partnership is actually managed.
//
// What was wrong was that a VA owner sitting in their crew center had no way to
// see ANY of it. Terms move, a warning gets issued, the flight-events feed is
// approved — and the person running the airline finds out when they next happen
// to sign into a different product.
//
// So this is a WINDOW, deliberately: it reads their standing and hands them a
// link to the place each thing is changed. Nothing here writes. Bridging a crew
// session into portal-authorised actions would mean one login quietly acquiring
// another login's powers, and the partnership is not the crew center's to
// administer.
//
// Owner-only (or Inflight oversight). A VA's staff run the airline; its
// standing with us — warnings especially — is the owner's business.
app.get('/api/crew/:slug/partnership', async (req, res) => {
    // The owner always; a staff member only if the owner has granted it.
    // Some VAs have a person who handles the partnership and is not the owner,
    // and the alternative to delegating it was that owner forwarding
    // screenshots of their own warnings.
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    const gate = await requireCap(req, req.params.slug, 'partnership.view');
    if (gate.error) {
        return res.status(gate.error).json({
            error: gate.error === 401
                ? 'Not authenticated.'
                : 'Only the owner, or a role they’ve given partnership access, can see this.',
        });
    }
    try {
        const { TOS_VERSION, TOS_EFFECTIVE_DATE, TOS_PAGE_PATH, TOS_PDF_PATH, getWarningLevel } = require('./vaTos');
        // Every link below has to be ABSOLUTE, and this is why.
        //
        // The portal and the Terms page are served by THIS process. The crew
        // center that reads this response is not — it is a static site on the
        // tracker's origin. A path like "/va-portal.html" therefore resolves
        // against the tracker, where no such page exists, and the owner who
        // presses "Open the portal" gets a blank tab. Same for the Terms link,
        // which landed on the tracker's own unrelated terms page.
        //
        // Built from the request rather than from a configured base URL on
        // purpose: this request arrived at the host that serves the portal, so
        // its own origin is the answer by construction and cannot drift out of
        // step with wherever the backend is deployed. `trust proxy` is set, so
        // protocol and host are the client-facing ones, not the internal hop.
        const selfOrigin = `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
        const onBackend = (p) => `${selfOrigin}${p}`;
        // Resolved the way every other crew route resolves a VA, then re-read
        // for the partnership fields specifically: crewStore.SELECT is the set
        // the crew center needs to run an airline, and none of standing,
        // featuring or the feed's approval state is in it.
        const found = await resolveCrewVa(req.params.slug);
        if (!found) return res.status(404).json({ error: 'Crew center not found.' });
        const va = await VirtualAirlineAd.findById(found._id).select(
            'name callsign status featured partnershipAnnouncedAt createdAt region hubs recruiting '
            + 'logoUrl bannerUrl websiteUrl discordUrl '
            + 'flightEventsApproved flightEventsEnabled flightEventsRequestedAt').lean();
        if (!va) return res.status(404).json({ error: 'This crew center has no VA listing.' });

        // Warnings and the acknowledging account are looked up together — both
        // are one indexed read, and a partnership panel that rendered in two
        // stages would show "in good standing" before correcting itself.
        const [warnings, acked] = await Promise.all([
            VaWarning.find({ vaAdId: va._id }).sort({ createdAt: -1 }).limit(50).lean().catch(() => []),
            VaPortalAccount.findOne({ vaAdId: va._id, tosAckVersion: TOS_VERSION })
                .sort({ tosAckAt: -1 }).select('tosAckVersion tosAckAt displayName username').lean().catch(() => null),
        ]);

        const active = (warnings || []).filter((w) => w.status === 'active');
        // The highest active rung is what the standing badge reads. Same rule
        // the portal uses, so the two cannot disagree about where a VA stands.
        let peak = null;
        for (const w of active) {
            const lvl = getWarningLevel(w.level);
            if (lvl && (!peak || lvl.order > peak.order)) peak = lvl;
        }

        res.json({
            partnership: {
                name: va.name || '',
                code: va.callsign || '',
                // 'approved' is the partnered state; anything else means the
                // listing is still being looked at, or has been taken down.
                status: va.status || '',
                partnered: va.status === 'approved',
                featured: !!va.featured,
                // When we announced them publicly. Null until the bot posts it,
                // which is also the VA's answer to "are we live yet?".
                announcedAt: va.partnershipAnnouncedAt || null,
                since: va.createdAt || null,
                region: va.region || '',
                hubs: Array.isArray(va.hubs) ? va.hubs : [],
                recruiting: va.recruiting !== false,
                logoUrl: va.logoUrl || null,
                bannerUrl: va.bannerUrl || null,
                websiteUrl: va.websiteUrl || null,
                discordUrl: va.discordUrl || null,
            },
            standing: {
                level: peak ? peak.key : 'clear',
                label: peak ? peak.label : 'In good standing',
                meaning: peak ? peak.meaning : '',
                palette: peak ? peak.palette : '',
                activeWarnings: active.length,
                // A terminated partnership is not a badge colour — it is the
                // headline, and the panel says so plainly rather than leaving
                // an owner to read it off a rung name.
                terminated: active.some((w) => w.level === 'termination'),
            },
            // Active warnings only, and only what the VA was told: the reason
            // and when. Who issued it and our internal handling stay with us.
            warnings: active.map((w) => ({
                id: w._id,
                level: w.level,
                label: (getWarningLevel(w.level) || {}).label || w.level,
                reason: w.reason || '',
                issuedAt: w.createdAt,
                termsVersion: w.termsVersion || '',
                acknowledged: !!w.acknowledgedAt,
                acknowledgedAt: w.acknowledgedAt || null,
            })),
            terms: {
                version: TOS_VERSION,
                effectiveDate: TOS_EFFECTIVE_DATE,
                pageUrl: onBackend(TOS_PAGE_PATH),
                pdfUrl: onBackend(TOS_PDF_PATH),
                // Acknowledgement is recorded against a PORTAL ACCOUNT, not the
                // VA — so the honest question here is "has anybody on this VA
                // accepted the current version?", and the answer names them.
                acknowledged: !!acked,
                acknowledgedAt: (acked && acked.tosAckAt) || null,
                acknowledgedBy: (acked && (acked.displayName || acked.username)) || '',
            },
            // The takeoff/landing feed into the VA's own Discord. Three states,
            // not two: never asked for, asked for and waiting on us, running.
            flightEvents: {
                requested: !!va.flightEventsRequestedAt,
                requestedAt: va.flightEventsRequestedAt || null,
                approved: !!va.flightEventsApproved,
                enabled: va.flightEventsEnabled !== false,
            },
            // Where each of these is actually changed. Sent rather than hardcoded
            // in the browser so moving the portal does not strand a crew center.
            // /va-portal, not /va-portal.html: the route is the documented one,
            // and it is what the rest of the product links to.
            portal: {
                url: onBackend('/va-portal'),
                submissionsUrl: onBackend('/va-portal#submissions'),
                warningsUrl: onBackend('/va-portal#warnings'),
                termsUrl: onBackend('/va-portal#terms'),
            },
        });
    } catch (err) {
        console.error('crew partnership error:', err);
        res.status(500).json({ error: 'Could not load your partnership.' });
    }
});

// ---- Events and the gate board ----
//
// An event is the thing a VA gathers around; the gate board is what stops
// twelve pilots spawning on top of each other at the same stand. Staff publish
// an event, pilots sign themselves up and claim a stand off a map, and the
// airline's own website reads the same rows — so the calendar a visitor sees is
// the one staff filled in rather than a copy kept by hand.
//
// Where the authority sits, because it is the whole design:
//   * WHO IS COMING is crew_event_signups — one row per pilot per event,
//     withdrawal deletes it.
//   * WHICH STAND IS THEIRS is a unique index on (event_id, upper(gate)). Not a
//     check in this file: two pilots tapping the same marker seconds after an
//     event is announced is the normal case, and any "is it free?" read
//     performed before the insert loses that race. We attempt the insert and
//     let Postgres arbitrate.
//   * WHAT STANDS EXIST is OpenStreetMap, cached below — no VA maintains a gate
//     list, and the tracker's dispatch gate picker already reads the same tags.

// The pure decisions — what an event may say, what it looks like to the world,
// which stands exist and which are held — live in crewEvents.js so they can be
// tested without standing up a server. This file keeps the routing, the auth
// and the notices.
const cleanEvent = crewEvents.sanitizeEvent;
const publicSignup = crewEvents.publicSignup;

// `viewer` is the pilot asking, when there is one, so an event can say whether
// their rank opens it — identical treatment to a rank-gated route, including
// showing it locked rather than hidden. `hoursUntilUnlock` is added here
// because it is the one field that needs the ladder maths.
const publicEvent = (e, opts = {}) => {
    const out = crewEvents.publicEvent(e, { ...opts, meetsRank: crewRanks.meetsRank });
    out.hoursUntilUnlock = out.locked
        ? crewRanks.hoursUntilRank(opts.ranks, opts.viewer.hours, e.minRank)
        : 0;
    return out;
};

// The pilot making this request: their login, their roster row, their hours.
// Staff and Inflight oversight come back with `account: null` — they can manage
// the board but they are not automatically ON it, and a manager who wants to
// fly the event signs up like anyone else.
async function crewPilot(req, store) {
    const p = verifyCrewRequest(req);
    if (!p) return null;
    try {
        // A pilot account in the VA's own store. The ordinary case.
        if (p.kind === 'crew') {
            const account = await store.getAccount(p.sub);
            if (!account || account.active === false) return null;
            const member = account.memberId ? await store.getMember(account.memberId) : null;
            return {
                accountId: account._id,
                memberId: member ? member._id : null,
                name: (member && member.name) || account.displayName || account.username || 'A pilot',
                callsign: (member && member.callsign) || '',
                hours: member ? Number(member.hours) || 0 : 0,
            };
        }

        // A VA staff or owner account — one of OUR accounts, not a row in their
        // project. These people fly too, and until they could be resolved here
        // they could publish a schedule and not book off it, open the events
        // panel and not sign up, review flight reports and not file one.
        //
        // They are a pilot only once they have said WHICH pilot they are: the
        // link is a roster row they claimed themselves (see
        // POST /api/crew/:slug/me/pilot). No link means no identity on the
        // roster, and every pilot endpoint keeps treating them as a manager
        // watching rather than a crew member taking a leg.
        //
        // `accountId` stays null on purpose. It is the crew_accounts id and
        // this person has none; the roster row is what identifies them, and the
        // signup/booking uniqueness indexes are partial precisely so a row with
        // a member and no account is a valid row.
        if (p.kind === 'va') {
            const VaPortalAccount = mongoose.model('VaPortalAccount');
            const acct = await VaPortalAccount.findById(p.sub).select('crewMemberId displayName username active').lean();
            if (!acct || acct.active === false || !acct.crewMemberId) return null;
            const member = await store.getMember(acct.crewMemberId);
            if (!member) return null;         // the roster row has since gone
            return {
                accountId: null,
                memberId: member._id,
                name: member.name || acct.displayName || acct.username || 'A pilot',
                callsign: member.callsign || '',
                hours: Number(member.hours) || 0,
            };
        }

        // Inflight oversight is not on anybody's roster, and must never be
        // silently booked onto a VA's flying.
        return null;
    } catch { return null; }
}

/**
 * Which pilot the signed-in person is, and letting them say so.
 *
 * Only ever about the CALLER's own identity — there is no path here to set
 * somebody else's, because claiming to be another pilot would let a staff
 * member book, withdraw and file flights in that pilot's name. Staff who need
 * to put a pilot on a departure do it through the assign endpoints, where it is
 * recorded as staff having done it.
 *
 * A crew-store account's link already lives in its own row and is set when the
 * account is created, so this is a no-op for them; it exists for our central
 * accounts, which have nowhere else to keep it.
 */
app.get('/api/crew/:slug/me/pilot', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const me = await crewPilot(req, store);
        // Only a central account can be re-pointed here; a store-backed pilot's
        // link belongs to their account row and is not theirs to swap.
        const linkable = p.kind === 'va';
        res.json({
            linkable,
            linked: !!(me && me.memberId),
            pilot: me && me.memberId
                ? { memberId: me.memberId, name: me.name, callsign: me.callsign, hours: me.hours }
                : null,
        });
    } catch (err) { crewFail(res, err, { log: 'me/pilot read error', message: 'Could not read your pilot record.' }); }
});

app.post('/api/crew/:slug/me/pilot', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    if (p.kind !== 'va') {
        return res.status(400).json({
            error: 'Your pilot record is already linked to your crew center account.',
            code: 'not_linkable',
        });
    }
    if (p.slug && p.slug !== String(req.params.slug).toLowerCase()) {
        return res.status(403).json({ error: 'Wrong crew center.' });
    }
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const wanted = String((req.body && req.body.memberId) || '').trim();

        // Clearing it is a legitimate thing to want: a staff member who has
        // stopped flying should be able to stop being offered a seat.
        if (!wanted) {
            await mongoose.model('VaPortalAccount').findByIdAndUpdate(p.sub, { crewMemberId: null });
            return res.json({ linked: false, pilot: null });
        }

        // The row has to exist on THIS VA's roster. The store is already scoped
        // to the slug, so a member id from another airline's project simply is
        // not found rather than being linked across.
        const member = await store.getMember(wanted);
        if (!member) return res.status(404).json({ error: 'That pilot isn’t on this roster.' });

        // One roster row, one person. Two staff accounts pointing at the same
        // pilot would each be able to book and cancel the other's flying, and
        // the schedule would show one name doing both.
        const taken = await mongoose.model('VaPortalAccount').findOne({
            vaAdId: p.vaId, crewMemberId: String(member._id), _id: { $ne: p.sub },
        }).select('_id').lean();
        if (taken) {
            return res.status(409).json({
                error: 'Another staff account is already flying as that pilot.',
                code: 'pilot_taken',
            });
        }

        await mongoose.model('VaPortalAccount').findByIdAndUpdate(p.sub, { crewMemberId: String(member._id) });
        res.json({
            linked: true,
            pilot: {
                memberId: member._id, name: member.name, callsign: member.callsign,
                hours: Number(member.hours) || 0,
            },
        });
    } catch (err) { crewFail(res, err, { log: 'me/pilot write error', message: 'Could not link your pilot record.' }); }
});

// Can this caller see drafts and edit the calendar?
const canManageEvents = async (req, slug) => !(await requireCap(req, slug, 'events.manage')).error;

// Where the backend keeps its airport coordinates, handed to crewEvents so that
// module does not have to know. Falls back to an Overpass lookup by ICAO tag
// for a field the coordinate set has never heard of.
const gateCoordsFor = (icao) => AIRPORT_COORDS[icao] || null;

/**
 * Our own stands for an airport, used only when every Overpass mirror has
 * refused.
 *
 * This dataset was already here — /api/gates/:icao serves it to the tracker —
 * and the gate board simply never asked it. The shapes differ (ours is a bare
 * list of names, or objects with a gate/name/ref field), so it is normalised to
 * what buildGateBoard expects. No lat/lon: these rows are not geocoded, and a
 * stand with no coordinates renders in the list and is marked off-map rather
 * than being dropped.
 */
async function localAirportGates(icao) {
    const doc = await AirportGate.findOne({ airportCode: String(icao).toUpperCase() }).lean();
    if (!doc || !doc.gates) return [];
    const raw = Array.isArray(doc.gates) ? doc.gates : Object.values(doc.gates);
    const seen = new Set();
    const out = [];
    for (const g of raw) {
        const ref = String(
            (g && typeof g === 'object' ? (g.ref || g.gate || g.name || g.stand) : g) || ''
        ).trim().slice(0, 20);
        if (!ref) continue;
        const key = ref.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const lat = g && typeof g === 'object' ? Number(g.lat ?? g.latitude) : NaN;
        const lon = g && typeof g === 'object' ? Number(g.lon ?? g.lng ?? g.longitude) : NaN;
        out.push({
            ref,
            lat: Number.isFinite(lat) ? lat : null,
            lon: Number.isFinite(lon) ? lon : null,
            kind: 'gate',
        });
    }
    return out;
}

// A gate clash, in the words of the person who just lost the race. The store
// tells us which uniqueness bit (see Postgrest.explain), so "that stand has
// just gone" is never guessed — a pilot who is simply already signed up gets
// their own, different sentence.
function eventConflict(err, res) {
    if (!(err instanceof crewStore.CrewStoreError) || err.code !== 'store_conflict') return false;
    if (String(err.constraint || '').includes('gate')) {
        res.status(409).json({
            error: 'That stand has just been taken — pick another one.',
            code: 'gate_taken',
        });
        return true;
    }
    res.status(409).json({ error: 'You are already signed up for this event.', code: 'already_signed_up' });
    return true;
}

// The calendar. Public: published and cancelled events, because a pilot who
// signed up for something that has been called off needs to see that it was.
// Drafts are added only for a caller who can manage them.
app.get('/api/crew/:slug/events', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const canManage = await canManageEvents(req, req.params.slug);
        const viewer = await crewPilot(req, store);
        const upcomingOnly = String(req.query.upcoming || '') === '1';

        const all = await store.listEvents({ upcomingOnly });
        const events = canManage ? all : all.filter((e) => e.status !== 'draft');

        // Attendance for the whole page in ONE query rather than one per event.
        // The count belongs on the card ("34 going"), and a sixty-event
        // calendar that fetched them separately would be sixty round trips to
        // the VA's project for a figure each card shows in small print.
        const counted = events.slice(0, 60);
        const allSignups = await store.listSignupsForEvents(counted.map((e) => e._id)).catch(() => []);
        const byEvent = new Map(counted.map((e) => [String(e._id), []]));
        for (const s of allSignups) {
            const list = byEvent.get(String(s.eventId));
            if (list) list.push(s);
        }
        const isMine = (s) => (viewer.accountId && s.accountId === viewer.accountId)
            || (viewer.memberId && s.memberId === viewer.memberId);

        res.json({
            events: counted.map((e) => publicEvent(e, {
                signups: byEvent.get(String(e._id)) || [], ranks: va.ranks, viewer, canManage,
            })),
            canManage,
            // So a pilot's own card can say "you're signed up, stand B24"
            // without a second request per event.
            mine: viewer
                ? allSignups.filter(isMine).map((s) => ({ eventId: s.eventId, ...publicSignup(s) }))
                : [],
            ranks: crewRanks.normalizeLadder(va.ranks).map((r) => ({ name: r.name, minHours: r.minHours })),
        });
    } catch (err) { crewFail(res, err, { log: 'events list error', message: 'Could not load events.' }); }
});

// One event, with who is attending. This is the endpoint the event page reads.
app.get('/api/crew/:slug/events/:id', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const canManage = await canManageEvents(req, req.params.slug);
        const event = await store.getEvent(req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found.' });
        if (event.status === 'draft' && !canManage) return res.status(404).json({ error: 'Event not found.' });

        const viewer = await crewPilot(req, store);
        const signups = await store.listSignups(event._id);
        const mine = viewer
            ? signups.find((s) => (viewer.accountId && s.accountId === viewer.accountId)
                || (viewer.memberId && s.memberId === viewer.memberId))
            : null;

        // What was actually flown, as opposed to who said they would turn up.
        // Best-effort: a project on an older schema has no event_id column, and
        // an event whose flights cannot be listed is still an event worth
        // opening.
        const flights = await store.listPirepsForEvent(event._id).catch(() => []);

        res.json({
            event: publicEvent(event, { signups, ranks: va.ranks, viewer, canManage }),
            attending: signups.map(publicSignup),
            mine: mine ? publicSignup(mine) : null,
            // Approved only for everyone but staff, matching the public flight
            // log: a pending report is staff business until a decision is made.
            flights: flights
                .filter((f) => canManage || f.status === 'approved')
                .map(publicPirep),
            // So the brief can say "you filed this" without a second request.
            myFlightFiled: !!(viewer && flights.some((f) => f.memberId && viewer.memberId
                && String(f.memberId) === String(viewer.memberId))),
            canManage,
        });
    } catch (err) { crewFail(res, err, { log: 'event read error', message: 'Could not load the event.' }); }
});

// The gate board: every mapped stand at the event's airport, marked taken or
// free. Public, like the attendee list — seeing which stands are left is the
// reason to open it.
app.get('/api/crew/:slug/events/:id/gates', async (req, res) => {
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const canManage = await canManageEvents(req, req.params.slug);
        const event = await store.getEvent(req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found.' });
        if (event.status === 'draft' && !canManage) return res.status(404).json({ error: 'Event not found.' });

        const icao = crewEvents.gateAirport(event);
        if (!icao) return res.json({ icao: '', gates: [], source: 'none' });

        const signups = await store.listSignups(event._id);
        let gates = [];
        let source = 'osm';
        try {
            gates = await crewEvents.fetchAirportGates(icao, gateCoordsFor, localAirportGates);
        } catch (err) {
            // OpenStreetMap being slow or blocked must not take the board with
            // it. The stands pilots have already claimed are ours, not OSM's,
            // and buildGateBoard puts them on the board either way — so a VA
            // sees who is parked where and simply cannot pick a NEW stand off
            // the map until Overpass answers again.
            console.warn('event gates: Overpass lookup failed —', err?.message || err);
            source = 'unavailable';
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            icao,
            gatesOpen: event.gatesOpen,
            gatesLocked: event.gatesLocked,
            gates: crewEvents.buildGateBoard(gates, signups),
            source,
        });
    } catch (err) { crewFail(res, err, { log: 'event gates error', message: 'Could not load the gate board.' }); }
});

app.post('/api/crew/:slug/events', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const e = await store.createEvent({ ...cleanEvent(req.body), createdBy: (gate.p && gate.p.name) || '' });
        if (e.status === 'published') postEventNotice(va, 'published', e, gate.p);
        res.status(201).json(withDrift(store, { event: publicEvent(e, { canManage: true }) }));
    } catch (err) { crewFail(res, err, { log: 'event add error', message: 'Could not create the event.' }); }
});

app.patch('/api/crew/:slug/events/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getEvent(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Event not found.' });
        // Merge over the current row before cleaning, so a partial PATCH (the
        // gate-lock toggle sends one field) keeps everything it didn't mention.
        const e = await store.updateEvent(req.params.id, cleanEvent({ ...existing, ...req.body }));

        // Which notice, if any. A draft becoming published is the announcement;
        // anything becoming cancelled is the one pilots must not miss. An edit
        // to a draft nobody can see is not news and stays quiet.
        if (existing.status !== 'published' && e.status === 'published') postEventNotice(va, 'published', e, gate.p);
        else if (existing.status !== 'cancelled' && e.status === 'cancelled') postEventNotice(va, 'cancelled', e, gate.p);
        else if (e.status === 'published') postEventNotice(va, 'updated', e, gate.p);

        const signups = await store.listSignups(e._id).catch(() => []);
        res.json(withDrift(store, { event: publicEvent(e, { signups, canManage: true }) }));
    } catch (err) { crewFail(res, err, { log: 'event edit error', message: 'Could not update the event.' }); }
});

app.delete('/api/crew/:slug/events/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        // Read it before it goes so the notice can name the event rather than
        // an id nobody recognises.
        const existing = await store.getEvent(req.params.id).catch(() => null);
        await store.deleteEvent(req.params.id);   // signups cascade with it
        if (existing && existing.status === 'published') postEventNotice(va, 'removed', existing, gate.p);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'event delete error', message: 'Could not remove the event.' }); }
});

// Event artwork. Same upload path as the crew badge, so a VA gets the same
// resizing and the same bucket rather than a second way to store an image.
app.post('/api/crew/:slug/events/:id/banner', upload.single('image'), async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
        const { store } = await resolveCrewStore(req.params.slug);
        const event = await store.getEvent(req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found.' });

        const slug = String(req.params.slug || '').toLowerCase();
        const va = await VirtualAirlineAd.findOne({ slug }).select('_id').lean();
        const url = await uploadVaImage(s3Client, req.file, va ? String(va._id) : slug, 'banner');
        const saved = await store.updateEvent(event._id, { bannerUrl: url });
        res.set('Cache-Control', 'no-store');
        res.json(withDrift(store, { url, event: publicEvent(saved, { canManage: true }) }));
    } catch (err) { crewFail(res, err, { log: 'event banner error', message: 'Could not upload the event image.' }); }
});

/* ---- Signing up ---------------------------------------------------------
 * The pilot's own place at an event. Any signed-in crew member may take one:
 * this is the one crew endpoint that is deliberately not staff-gated, because
 * an event pilots cannot sign themselves up for is a spreadsheet.
 */
app.post('/api/crew/:slug/events/:id/signup', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const viewer = await crewPilot(req, store);
        if (!viewer) return res.status(401).json({ error: 'Sign in to your crew center to join an event.' });

        const event = await store.getEvent(req.params.id);
        if (!event || event.status === 'draft') return res.status(404).json({ error: 'Event not found.' });
        if (event.status === 'cancelled') return res.status(409).json({ error: 'This event has been cancelled.' });
        if (event.minRank && !crewRanks.meetsRank(va.ranks, viewer.hours, event.minRank)) {
            return res.status(403).json({
                error: `This event opens at ${event.minRank}.`,
                code: 'rank_locked',
                hoursUntilUnlock: crewRanks.hoursUntilRank(va.ranks, viewer.hours, event.minRank),
            });
        }

        const b = req.body || {};
        const gateWanted = String(b.gate || '').trim().slice(0, 20).toUpperCase();
        if (gateWanted && (!event.gatesOpen || event.gatesLocked)) {
            return res.status(409).json({
                error: event.gatesLocked
                    ? 'Stands for this event are locked — talk to staff if you need a change.'
                    : 'This event isn’t using a gate board.',
                code: 'gates_closed',
            });
        }

        // Past the cap you are still coming, you are just on the waitlist — and
        // a waitlisted pilot holds no stand, because the stand belongs to the
        // event and someone who may not fly it should not be sitting on one.
        const waitlisted = crewEvents.isWaitlisted(event, await store.listSignups(event._id));

        const signup = await store.createSignup({
            eventId: event._id,
            memberId: viewer.memberId,
            accountId: viewer.accountId,
            pilotName: viewer.name,
            callsign: String(b.callsign || viewer.callsign || '').trim().slice(0, 20),
            aircraft: String(b.aircraft || event.aircraft || '').trim().slice(0, 60),
            gate: waitlisted ? '' : gateWanted,
            gateLat: waitlisted ? null : b.gateLat,
            gateLon: waitlisted ? null : b.gateLon,
            gateKind: waitlisted ? '' : String(b.gateKind || '').trim().slice(0, 30),
            note: String(b.note || '').trim().slice(0, 300),
            status: waitlisted ? 'waitlist' : 'going',
        });
        res.status(201).json(withDrift(store, { signup: publicSignup(signup), waitlisted }));
    } catch (err) {
        if (eventConflict(err, res)) return;
        crewFail(res, err, { log: 'event signup error', message: 'Could not sign you up.' });
    }
});

// Change your stand, your aircraft or your note. Same endpoint whether a pilot
// is picking a gate for the first time or swapping one — the unique index makes
// the swap safe without a "release then claim" dance that could lose both.
app.patch('/api/crew/:slug/events/:id/signup', async (req, res) => {
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const viewer = await crewPilot(req, store);
        if (!viewer) return res.status(401).json({ error: 'Sign in to your crew center first.' });

        const event = await store.getEvent(req.params.id);
        if (!event || event.status === 'draft') return res.status(404).json({ error: 'Event not found.' });
        const mine = await store.getSignupFor(event._id, { accountId: viewer.accountId, memberId: viewer.memberId });
        if (!mine) return res.status(404).json({ error: 'You are not signed up for this event.' });

        const b = req.body || {};
        if (b.gate !== undefined) {
            if (!event.gatesOpen || event.gatesLocked) {
                return res.status(409).json({
                    error: event.gatesLocked
                        ? 'Stands for this event are locked — talk to staff if you need a change.'
                        : 'This event isn’t using a gate board.',
                    code: 'gates_closed',
                });
            }
            if (mine.status === 'waitlist') {
                return res.status(409).json({
                    error: 'You’re on the waitlist for this event, so there’s no stand to hold yet.',
                    code: 'waitlisted',
                });
            }
        }
        // A pilot may change their own stand, aircraft, callsign and note — not
        // their name (it is their roster row's) and not their waitlist status
        // (that is the event's cap talking, not a preference).
        const saved = await store.updateSignup(mine._id, crewEvents.sanitizeSignupPatch(b));
        res.json(withDrift(store, { signup: publicSignup(saved) }));
    } catch (err) {
        if (eventConflict(err, res)) return;
        crewFail(res, err, { log: 'event signup edit error', message: 'Could not update your signup.' });
    }
});

// Withdraw. Deletes the row rather than flagging it, which is what frees the
// stand — see the schema note on why a withdrawn pilot must not keep one.
app.delete('/api/crew/:slug/events/:id/signup', async (req, res) => {
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const viewer = await crewPilot(req, store);
        if (!viewer) return res.status(401).json({ error: 'Sign in to your crew center first.' });
        const mine = await store.getSignupFor(req.params.id, { accountId: viewer.accountId, memberId: viewer.memberId });
        if (!mine) return res.json({ ok: true });   // already not going; nothing to undo
        await store.deleteSignup(mine._id);
        await promoteFromWaitlist(store, req.params.id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'event withdraw error', message: 'Could not withdraw you.' }); }
});

/**
 * A seat has come free, so the pilot who has waited longest gets it.
 *
 * Runs after any removal rather than being left for staff to notice. Who is
 * next is crewEvents.nextOffWaitlist; this is the part that talks to the store.
 *
 * Swallows its errors on purpose — a withdrawal that succeeded must not report
 * failure because the tidy-up afterwards did not.
 */
async function promoteFromWaitlist(store, eventId) {
    try {
        const event = await store.getEvent(eventId);
        if (!event || !event.slots) return;
        const next = crewEvents.nextOffWaitlist(event, await store.listSignups(eventId));
        if (next) await store.updateSignup(next._id, { status: 'going' });
    } catch (err) {
        console.warn('event waitlist promotion failed —', err?.message || err);
    }
}

// Staff putting someone on the board by hand: a guest from a partner VA, or a
// pilot who asked in Discord. No account is invented for them — the signup
// carries a name, which is all the board needs.
app.post('/api/crew/:slug/events/:id/signups', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const event = await store.getEvent(req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found.' });

        const b = req.body || {};
        const name = String(b.pilotName || '').trim().slice(0, 80);
        if (!name) return res.status(400).json({ error: 'Give the pilot a name.' });
        // A roster pilot gets their real row linked so the board can follow
        // them; a guest does not, and the unique index leaves guests alone.
        const member = b.memberId ? await store.getMember(b.memberId).catch(() => null) : null;

        const signup = await store.createSignup({
            eventId: event._id,
            memberId: member ? member._id : null,
            accountId: null,
            pilotName: member ? (member.name || name) : name,
            callsign: String(b.callsign || (member && member.callsign) || '').trim().slice(0, 20),
            aircraft: String(b.aircraft || event.aircraft || '').trim().slice(0, 60),
            gate: String(b.gate || '').trim().slice(0, 20).toUpperCase(),
            gateLat: b.gateLat, gateLon: b.gateLon,
            gateKind: String(b.gateKind || '').trim().slice(0, 30),
            note: String(b.note || '').trim().slice(0, 300),
            status: b.status === 'waitlist' ? 'waitlist' : 'going',
        });
        res.status(201).json(withDrift(store, { signup: publicSignup(signup) }));
    } catch (err) {
        if (eventConflict(err, res)) return;
        crewFail(res, err, { log: 'event guest add error', message: 'Could not add them to the event.' });
    }
});

// Staff editing somebody else's place — moving a pilot to a different stand
// during the final allocation, mostly.
app.patch('/api/crew/:slug/events/:id/signups/:signupId', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getSignup(req.params.signupId);
        if (!existing || existing.eventId !== req.params.id) return res.status(404).json({ error: 'Attendee not found.' });

        // Staff may move a pilot's stand even when the board is locked: locking
        // is what stops PILOTS shuffling, and the person doing the final
        // allocation is exactly who needs to move people at that point. They
        // may also change a name and a waitlist position, which a pilot editing
        // their own row may not — hence allowIdentity.
        const saved = await store.updateSignup(
            existing._id,
            crewEvents.sanitizeSignupPatch(req.body, { allowIdentity: true }),
        );
        res.json(withDrift(store, { signup: publicSignup(saved) }));
    } catch (err) {
        if (eventConflict(err, res)) return;
        crewFail(res, err, { log: 'event attendee edit error', message: 'Could not update the attendee.' });
    }
});

app.delete('/api/crew/:slug/events/:id/signups/:signupId', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'events.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getSignup(req.params.signupId);
        if (!existing || existing.eventId !== req.params.id) return res.status(404).json({ error: 'Attendee not found.' });
        await store.deleteSignup(existing._id);
        await promoteFromWaitlist(store, req.params.id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'event attendee remove error', message: 'Could not remove the attendee.' }); }
});

// ---- The schedule, and who is flying it ----
//
// A route says the airline flies LHR–JFK. A schedule says it flies at 18:40 on
// Thursday, and one pilot puts their name against it. Staff build the week
// (usually off the published network, sometimes ad hoc), pilots book a leg, and
// a flight report filed against a booking is what turns "booked" into "flown".
//
// Where the authority sits, because it is the whole design:
//   * WHICH SEAT IS WHOSE is a unique index on (schedule_id, seat). Not a count
//     taken before the insert — publishing a fortnight of flying puts every
//     pilot on the same page inside a minute, and that read loses the race. The
//     backend proposes the lowest free seat, Postgres arbitrates, and a lost
//     race is retried rather than reported.
//   * WHAT A DEPARTURE SAYS is crewSchedules.sanitizeSchedule, so a draft and a
//     published leg are cleaned by identical code.
//   * WHO MAY BOOK is the VA's rank ladder, read exactly as routes and events
//     read it — one place decides what a rank is worth.
const canManageSchedules = async (req, slug) => !(await requireCap(req, slug, 'schedules.manage')).error;

// Same treatment publicEvent gets, for the same reason: a pilot below the bar
// sees the departure LOCKED with how much further they have to fly, not hidden.
// `hoursUntilUnlock` is added here because it is the one field needing the
// ladder maths, which crewSchedules deliberately does not carry.
const publicSchedule = (s, opts = {}) => {
    const out = crewSchedules.publicSchedule(s, { ...opts, meetsRank: crewRanks.meetsRank });
    out.hoursUntilUnlock = out.locked
        ? crewRanks.hoursUntilRank(opts.ranks, opts.viewer.hours, s.minRank)
        : 0;
    return out;
};

// A booking clash, in the words of the pilot who just lost the race. The store
// tells us which uniqueness bit gave way (see Postgrest.explain), so "somebody
// just took that seat" is never guessed — a pilot who is simply already booked
// on the leg gets their own, different sentence.
function bookingConflict(err, res, { byStaff = false } = {}) {
    if (!(err instanceof crewStore.CrewStoreError) || err.code !== 'store_conflict') return false;
    if (String(err.constraint || '').includes('seat')) {
        res.status(409).json({
            error: 'Somebody just took that seat — try again.',
            code: 'seat_taken',
        });
        return true;
    }
    // Whose booking it is changes the sentence. A staff member assigning cover
    // is not "already booked on this departure" — the pilot they picked is, and
    // telling staff otherwise sends them looking for a booking of their own.
    res.status(409).json({
        error: byStaff
            ? 'That pilot is already on this departure.'
            : 'You are already booked on this departure.',
        code: 'already_booked',
    });
    return true;
}

/**
 * The VA's schedule rules, read fresh.
 *
 * `resolveCrewVa` selects only what running an airline needs (crewStore.SELECT)
 * and these are not in it, so they are read on the requests that enforce them.
 * One indexed lookup by id, and it must not be cached: an owner turning
 * self-service booking off expects the next pilot to be refused, not the one
 * after the cache expires.
 */
async function scheduleRules(vaId) {
    const doc = await VirtualAirlineAd.findById(vaId).select('crewSchedule').lean().catch(() => null);
    return crewSchedules.normalizeRules(doc && doc.crewSchedule);
}

/**
 * Put a pilot on a departure, retrying the seat if the race is lost.
 *
 * The retry is the point. nextFreeSeat() reads the bookings as they were a
 * moment ago; between that read and the insert another pilot may have taken the
 * seat it proposed. Rather than tell them the leg is full — which would be a
 * lie while other seats stand empty — the bookings are re-read and the next
 * free seat attempted. Bounded by the seat count, because a departure whose
 * every seat has genuinely gone must terminate with a plain "this leg is full"
 * rather than spinning.
 */
async function claimSeat(store, schedule, booking) {
    const seats = Math.max(1, Number(schedule.seats) || 1);
    let lastErr = null;
    for (let attempt = 0; attempt < seats; attempt += 1) {
        const taken = await store.listBookings(schedule._id);
        const seat = crewSchedules.nextFreeSeat(schedule, taken);
        if (!seat) return { full: true, booking: null };
        try {
            return { full: false, booking: await store.createBooking({ ...booking, seat }) };
        } catch (err) {
            const raced = err instanceof crewStore.CrewStoreError
                && err.code === 'store_conflict'
                && String(err.constraint || '').includes('seat');
            // Anything that is NOT two pilots meeting on one seat — already
            // booked, a dead store, a project on an older schema — is the
            // caller's to report. Only the seat race is ours to absorb.
            if (!raced) throw err;
            lastErr = err;
        }
    }
    // Every seat was contended on every attempt. Rare, and honest: by now the
    // leg really is full.
    if (lastErr) return { full: true, booking: null };
    return { full: true, booking: null };
}

// The schedule. Public: published and cancelled departures, because a pilot who
// booked something that has been called off needs to see that it was. Drafts
// are added only for a caller who can manage them.
app.get('/api/crew/:slug/schedules', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const canManage = await canManageSchedules(req, req.params.slug);
        const viewer = await crewPilot(req, store);
        const rules = await scheduleRules(va._id);
        const upcomingOnly = String(req.query.upcoming || '') === '1';

        const all = await store.listSchedules({ upcomingOnly });
        const schedules = canManage ? all : all.filter((s) => s.status !== 'draft');

        // Coverage for the whole page in ONE query rather than one per row. A
        // fortnight of flying is hundreds of departures, and every row shows
        // who has it — the same reasoning as the events calendar's counts.
        const listed = schedules.slice(0, 400);
        const allBookings = await store.listBookingsForSchedules(listed.map((s) => s._id)).catch(() => []);
        const bySchedule = new Map(listed.map((s) => [String(s._id), []]));
        for (const b of allBookings) {
            const list = bySchedule.get(String(b.scheduleId));
            if (list) list.push(b);
        }
        const isMine = (b) => (viewer.accountId && b.accountId === viewer.accountId)
            || (viewer.memberId && b.memberId === viewer.memberId);

        // Why this pilot cannot take each leg, decided HERE and sent with the
        // row rather than re-derived in the browser.
        //
        // The panel needs to grey a button and say why, and the obvious way to
        // do that is to reimplement the rules client-side — which is two
        // descriptions of one rule, and the two drift. So the server answers
        // the question it is already the authority on, once per row, and the
        // panel renders the sentence it is given. A pilot who bypassed the UI
        // hits the identical check in POST /book.
        //
        // `held` is counted once for the whole page, not per row.
        const held = viewer
            ? await countUpcomingHeld(store, allBookings.filter(isMine))
            : 0;
        const refusalFor = (s) => {
            if (!viewer) return null;                    // nobody is asking
            if (bySchedule.get(String(s._id) || '')?.some(isMine)) return null;  // already theirs
            const r = crewSchedules.bookingRefusal(s, rules, {
                held, hours: viewer.hours, ranks: va.ranks, meetsRank: crewRanks.meetsRank,
                // A staff member who builds the schedule and also flies is not
                // refused by the airline's own bidding rules — they can assign
                // themselves the leg either way, and a greyed button telling a
                // schedule manager that "staff assign the flying here" is the
                // system explaining their own rule back at them.
                byStaff: canManage,
            });
            return r ? { code: r.code, message: r.message, opensAt: r.opensAt || null } : null;
        };

        res.json({
            schedules: listed.map((s) => ({
                ...publicSchedule(s, {
                    bookings: bySchedule.get(String(s._id)) || [],
                    ranks: va.ranks, viewer, canManage,
                }),
                refusal: refusalFor(s),
            })),
            canManage,
            // So a pilot's own row can say "you have this one, seat 1" without a
            // second request per departure.
            mine: viewer
                ? allBookings.filter(isMine).map((b) => ({ scheduleId: b.scheduleId, ...crewSchedules.publicBooking(b) }))
                : [],
            // How this VA has chosen to run the schedule. Sent so the panel can
            // grey the right button and say why BEFORE a pilot presses it —
            // the same rules the endpoints below enforce, not a second copy.
            rules: crewSchedules.publicRules(rules),
            ranks: crewRanks.normalizeLadder(va.ranks).map((r) => ({ name: r.name, minHours: r.minHours })),
        });
    } catch (err) { crewFail(res, err, { log: 'schedules list error', message: 'Could not load the schedule.' }); }
});

// One departure, with who is flying it. The endpoint a booking page reads.
app.get('/api/crew/:slug/schedules/:id', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const canManage = await canManageSchedules(req, req.params.slug);
        const schedule = await store.getSchedule(req.params.id);
        if (!schedule) return res.status(404).json({ error: 'Departure not found.' });
        if (schedule.status === 'draft' && !canManage) return res.status(404).json({ error: 'Departure not found.' });

        const viewer = await crewPilot(req, store);
        const bookings = await store.listBookings(schedule._id);
        const mine = viewer
            ? bookings.find((b) => (viewer.accountId && b.accountId === viewer.accountId)
                || (viewer.memberId && b.memberId === viewer.memberId))
            : null;

        // What was actually flown, as opposed to who said they would fly it.
        // Best-effort: a project on an older schema has no schedule_id column,
        // and a departure whose flights cannot be listed is still worth opening.
        const flights = await store.listPirepsForSchedule(schedule._id).catch(() => []);

        res.json({
            schedule: publicSchedule(schedule, {
                bookings, ranks: va.ranks, viewer, canManage,
            }),
            crew: bookings.map(crewSchedules.publicBooking),
            mine: mine ? crewSchedules.publicBooking(mine) : null,
            // Approved only for everyone but staff, matching the public flight
            // log: a pending report is staff business until a decision is made.
            flights: flights.filter((f) => canManage || f.status === 'approved').map(publicPirep),
            canManage,
        });
    } catch (err) { crewFail(res, err, { log: 'schedule read error', message: 'Could not load the departure.' }); }
});

/**
 * Publish departures.
 *
 * One body, one to sixty rows: `repeat` and `count` turn a template into a week
 * or a fortnight of the same leg. That is not a convenience — a VA building
 * their schedule a row at a time is a VA that stops after Tuesday — and it is
 * done here rather than in the browser so the rows are created against one
 * sanitised template instead of sixty separately-typed ones.
 */
app.post('/api/crew/:slug/schedules', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'schedules.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const b = req.body || {};
        const template = crewSchedules.sanitizeSchedule(b);
        if (!template.origin || !template.destination) {
            return res.status(400).json({ error: 'A departure needs both a departure and an arrival airport.' });
        }
        // Asking to repeat something with no departure time is a mistake worth
        // naming: expandSeries would silently return one row (it refuses to
        // multiply an undated template), and staff who asked for fourteen would
        // get one with no explanation.
        const wantsSeries = ['daily', 'weekly'].includes(String(b.repeat || '')) && Number(b.count) > 1;
        if (wantsSeries && !template.departsAt) {
            return res.status(400).json({
                error: 'Give the first departure a time before repeating it.',
                code: 'series_needs_time',
            });
        }
        const series = crewSchedules.expandSeries({
            departsAt: template.departsAt, arrivesAt: template.arrivesAt,
            repeat: b.repeat, count: b.count,
        });

        const created = [];
        for (const times of series) {
            created.push(await store.createSchedule({
                ...template, ...times, createdBy: (gate.p && gate.p.name) || '',
            }));
        }

        // One notice for the batch, not sixty. A VA that published a fortnight
        // of flying wants their crew told once that the schedule is up — a
        // Discord channel with sixty identical embeds in it is the same thing
        // as no notice at all.
        if (template.status === 'published' && created.length) {
            postScheduleNotice(va, 'published', created[0], gate.p, created.length);
            postAnnouncement(va, {
                kind: 'schedule',
                title: created.length > 1
                    ? `${created.length} departures added to the schedule`
                    : `${crewSchedules.describeLeg(created[0]) || 'A departure'} is on the schedule`,
                body: created.length > 1 ? `Starting with ${crewSchedules.describeLeg(created[0])}.` : (template.notes || ''),
                refId: created[0]._id,
                authorName: (gate.p && gate.p.name) || '',
            });
        }

        res.status(201).json(withDrift(store, {
            schedules: created.map((s) => publicSchedule(s, { canManage: true })),
            created: created.length,
        }));
    } catch (err) { crewFail(res, err, { log: 'schedule add error', message: 'Could not add to the schedule.' }); }
});

app.patch('/api/crew/:slug/schedules/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'schedules.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const before = await store.getSchedule(req.params.id);
        if (!before) return res.status(404).json({ error: 'Departure not found.' });

        // Seats may not be cut below the HIGHEST SEAT ALREADY HELD — not below
        // the booking count, which is the same number only when the seats in
        // use happen to be contiguous.
        //
        // They often are not. Three pilots book seats 1, 2 and 3; the first two
        // give their legs back; one pilot remains, sitting in seat 3. Guarding
        // on the count would let staff cut the departure to one seat while seat
        // 3 is still occupied — and nextFreeSeat would then hand seat 1 to
        // somebody else, putting two pilots on a one-seat leg.
        //
        // Nobody is bumped by an edit either way: staff who need a pilot off
        // remove that booking themselves.
        const patch = crewSchedules.sanitizeSchedule({ ...before, ...req.body });
        const booked = await store.listBookings(before._id).catch(() => []);
        const highestHeld = booked.reduce((n, b) => Math.max(n, Number(b.seat) || 0), 0);
        if (highestHeld && patch.seats < highestHeld) {
            return res.status(409).json({
                error: booked.length === 1
                    ? `A pilot is holding seat ${highestHeld} on this departure — remove that booking before cutting the seats.`
                    : `${booked.length} pilots are booked, up to seat ${highestHeld} — remove a booking before cutting the seats.`,
                code: 'seats_below_booked',
            });
        }

        const s = await store.updateSchedule(before._id, patch);
        // Told once, on the crossing. A staff member correcting a typo on an
        // already-published leg must not re-announce it, and cancelling one
        // people have booked has to reach them.
        if (before.status !== 'published' && s.status === 'published') postScheduleNotice(va, 'published', s, gate.p, 1);
        else if (before.status !== 'cancelled' && s.status === 'cancelled') postScheduleNotice(va, 'cancelled', s, gate.p, 1);
        res.json(withDrift(store, { schedule: publicSchedule(s, { canManage: true }) }));
    } catch (err) { crewFail(res, err, { log: 'schedule edit error', message: 'Could not update the departure.' }); }
});

app.delete('/api/crew/:slug/schedules/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'schedules.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getSchedule(req.params.id);
        if (!existing) return res.json({ ok: true });
        await store.deleteSchedule(existing._id);
        // Only worth announcing if anybody could see it. Deleting a draft is
        // staff tidying up their own working copy.
        if (existing.status === 'published') postScheduleNotice(va, 'removed', existing, gate.p, 1);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'schedule remove error', message: 'Could not remove the departure.' }); }
});

// A pilot taking a leg. The seat is picked here, not sent by the browser — see
// claimSeat for why, and for what happens when two pilots ask at once.
app.post('/api/crew/:slug/schedules/:id/book', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const viewer = await crewPilot(req, store);
        if (!viewer) return res.status(401).json({ error: 'Sign in to your crew center to book a flight.' });

        const schedule = await store.getSchedule(req.params.id);
        const closed = crewSchedules.bookingClosedReason(schedule);
        if (closed === 'missing') return res.status(404).json({ error: 'Departure not found.' });
        if (closed === 'cancelled') return res.status(409).json({ error: 'This departure has been cancelled.', code: 'cancelled' });
        if (closed === 'departed') return res.status(409).json({ error: 'This departure has already gone.', code: 'departed' });

        // The airline's own rules: is the feature on, may pilots book at all,
        // has the bidding window opened, is this pilot already holding as many
        // legs as the VA allows? Refused with the reason, never a bare 403.
        //
        // `held` counts only what is still AHEAD of them. A pilot who flew four
        // legs last month is not "holding four" — counting history would ratchet
        // a per-pilot cap into a lifetime quota.
        const rules = await scheduleRules(va._id);
        const mineAll = await store.listBookingsForPilot(
            { accountId: viewer.accountId, memberId: viewer.memberId },
        ).catch(() => []);
        const held = await countUpcomingHeld(store, mineAll);

        const refused = crewSchedules.bookingRefusal(schedule, rules, {
            held, hours: viewer.hours, ranks: va.ranks, meetsRank: crewRanks.meetsRank,
            // Same override as the list: somebody who may assign this leg to
            // anybody may assign it to themselves, and routing them through the
            // staff endpoint to do it would only obscure who took it.
            byStaff: await canManageSchedules(req, req.params.slug),
        });
        if (refused) return res.status(403).json(refused.code === 'not_open_yet'
            ? { error: refused.message, code: refused.code, opensAt: refused.opensAt }
            : { error: refused.message, code: refused.code });

        // The per-departure gate, on top of the airline-wide one. Either can
        // refuse, so the effective bar is whichever is higher — and staff can
        // raise it for one leg without being able to lower it below the VA's.
        if (schedule.minRank && !crewRanks.meetsRank(va.ranks, viewer.hours, schedule.minRank)) {
            return res.status(403).json({
                error: `This departure opens at ${schedule.minRank}.`,
                code: 'rank_locked',
                hoursUntilUnlock: crewRanks.hoursUntilRank(va.ranks, viewer.hours, schedule.minRank),
            });
        }

        const b = req.body || {};
        const { full, booking } = await claimSeat(store, schedule, {
            scheduleId: schedule._id,
            memberId: viewer.memberId,
            accountId: viewer.accountId,
            pilotName: viewer.name,
            callsign: String(b.callsign || viewer.callsign || '').trim().slice(0, 20),
            note: String(b.note || '').trim().slice(0, 300),
            status: 'booked',
        });
        // No waitlist, unlike an event. A pilot who cannot have this leg needs
        // to know now so they can take another one — a queue for a single seat
        // is a pilot who does not fly and does not know it yet.
        if (full) return res.status(409).json({ error: 'Every seat on this departure has gone.', code: 'full' });

        res.status(201).json(withDrift(store, { booking: crewSchedules.publicBooking(booking) }));
    } catch (err) {
        if (bookingConflict(err, res)) return;
        crewFail(res, err, { log: 'schedule booking error', message: 'Could not book you onto that flight.' });
    }
});

/**
 * How many legs this pilot is still holding — ahead of them, not behind.
 *
 * One `in.()` read of the departures their bookings point at, rather than one
 * per booking: a pilot with a season of history would otherwise make the cap
 * check cost more than the booking it guards. A departure that cannot be read
 * (deleted under them, an older schema) is not counted, because refusing a
 * booking over a row we could not fetch would be the cap failing closed on the
 * pilot rather than on the rule.
 */
async function countUpcomingHeld(store, bookings) {
    const live = (bookings || []).filter((b) => b.status !== 'flown');
    if (!live.length) return 0;
    try {
        const rows = await store.listSchedulesByIds(live.map((b) => b.scheduleId));
        const now = Date.now();
        return rows.filter((s) => s
            && s.status === 'published'
            && (!s.departsAt || new Date(s.departsAt).getTime() > now)).length;
    } catch {
        return 0;
    }
}

// Change your callsign or your note on a leg you hold. Not your seat — that is
// the database's to arbitrate — and not your name, which is your roster row's.
app.patch('/api/crew/:slug/schedules/:id/book', async (req, res) => {
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const viewer = await crewPilot(req, store);
        if (!viewer) return res.status(401).json({ error: 'Sign in to your crew center first.' });
        const mine = await store.getBookingFor(req.params.id, { accountId: viewer.accountId, memberId: viewer.memberId });
        if (!mine) return res.status(404).json({ error: 'You are not booked on this departure.' });
        const saved = await store.updateBooking(mine._id, crewSchedules.sanitizeBookingPatch(req.body));
        res.json(withDrift(store, { booking: crewSchedules.publicBooking(saved) }));
    } catch (err) { crewFail(res, err, { log: 'schedule booking edit error', message: 'Could not update your booking.' }); }
});

// Give the leg back. Deletes the row rather than flagging it, which is what
// frees the seat — the same reasoning as withdrawing from an event.
app.delete('/api/crew/:slug/schedules/:id/book', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const viewer = await crewPilot(req, store);
        if (!viewer) return res.status(401).json({ error: 'Sign in to your crew center first.' });
        const mine = await store.getBookingFor(req.params.id, { accountId: viewer.accountId, memberId: viewer.memberId });
        if (!mine) return res.json({ ok: true });   // not booked; nothing to undo

        // A leg already flown is a record of something that happened, and
        // deleting it would erase who flew it — refused for everybody. A cutoff
        // close to departure is a courtesy to whoever has to find cover, and
        // only applies to the pilot.
        const schedule = await store.getSchedule(req.params.id).catch(() => null);
        const refused = crewSchedules.cancelRefusal(mine, schedule, await scheduleRules(va._id), {
            byStaff: await canManageSchedules(req, req.params.slug),
        });
        if (refused) return res.status(409).json({ error: refused.message, code: refused.code });

        await store.deleteBooking(mine._id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'schedule cancel error', message: 'Could not cancel your booking.' }); }
});

// Staff assigning a leg by hand: cover for a pilot who asked in Discord, or a
// guest crew from a partner VA. No account is invented for them — the booking
// carries a name, which is all the schedule needs.
app.post('/api/crew/:slug/schedules/:id/bookings', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'schedules.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const schedule = await store.getSchedule(req.params.id);
        if (!schedule) return res.status(404).json({ error: 'Departure not found.' });

        const b = req.body || {};
        const member = b.memberId ? await store.getMember(b.memberId).catch(() => null) : null;
        const name = String(b.pilotName || (member && member.name) || '').trim().slice(0, 80);
        if (!name) return res.status(400).json({ error: 'Name the pilot flying this leg.' });

        const { full, booking } = await claimSeat(store, schedule, {
            scheduleId: schedule._id,
            memberId: (member && member._id) || null,
            accountId: null,
            pilotName: name,
            callsign: String(b.callsign || (member && member.callsign) || '').trim().slice(0, 20),
            note: String(b.note || '').trim().slice(0, 300),
            status: 'booked',
        });
        if (full) return res.status(409).json({ error: 'Every seat on this departure has gone.', code: 'full' });
        res.status(201).json(withDrift(store, { booking: crewSchedules.publicBooking(booking) }));
    } catch (err) {
        if (bookingConflict(err, res, { byStaff: true })) return;
        crewFail(res, err, { log: 'schedule assign error', message: 'Could not assign that pilot.' });
    }
});

app.delete('/api/crew/:slug/schedules/:id/bookings/:bookingId', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'schedules.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const existing = await store.getBooking(req.params.bookingId);
        if (!existing || existing.scheduleId !== req.params.id) return res.status(404).json({ error: 'Booking not found.' });
        // Staff override the cutoff — finding cover is their job — but not the
        // flown record. Correcting a flight that was flown is the flight
        // report's business, not the booking's.
        const refused = crewSchedules.cancelRefusal(existing, null, null, { byStaff: true });
        if (refused) return res.status(409).json({ error: refused.message, code: refused.code });
        await store.deleteBooking(existing._id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'schedule booking remove error', message: 'Could not remove the booking.' }); }
});

// ---- Flight reports (PIREPs) — auto-captured from real IF history ----
const _norm = (s) => String(s || '').trim().toLowerCase();
// Loose aircraft-name match. Fleet types are the canonical IF names now, so an
// exact match is the norm; the contains fallback tolerates minor variants.
function aircraftMatches(a, b) {
    const x = _norm(a), y = _norm(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}
function pirepInFleet(fleet, aircraftName) {
    if (!Array.isArray(fleet) || !fleet.length || !aircraftName) return false;
    return fleet.some(f => aircraftMatches(f.type || f.name, aircraftName));
}
// Best route in the network for a flown leg: same origin+destination, preferring
// one whose aircraft also matches.
function matchRoute(routes, origin, dest, aircraftName) {
    if (!Array.isArray(routes)) return null;
    const o = _norm(origin), d = _norm(dest);
    if (!o || !d) return null;
    const cands = routes.filter(r => r.active !== false && _norm(r.origin) === o && _norm(r.destination) === d);
    if (!cands.length) return null;
    return cands.find(r => r.aircraft && aircraftMatches(r.aircraft, aircraftName)) || cands[0];
}
// Resolve a live flight's aircraft/livery UUIDs to canonical names via metadata.
function resolveFlightNames(flight, meta) {
    const livId = String(flight.liveryID || flight.liveryId || '').toLowerCase();
    const liv = livId && meta.livById && meta.livById.get(livId);
    let aircraftName = liv ? liv.aircraftName : '';
    const liveryName = liv ? liv.liveryName : '';
    if (!aircraftName) {
        const acId = String(flight.aircraftID || flight.aircraftId || '').toLowerCase();
        aircraftName = (acId && meta.acById && meta.acById.get(acId)) || '';
    }
    return { aircraftName, liveryName };
}
// Credit a PIREP's hours to its pilot exactly once. `hoursApplied` is the guard:
// it is flipped in the same store the hours landed in, so approving an
// already-approved report is a no-op rather than a double credit. Returns the
// updated report.
// `va` is optional and only enables the promotion notice — the hours are
// credited either way. Passing it makes this the one place a promotion can be
// detected, because it is the one place hours move: comparing the rank held
// before against the rank held after means a single long flight that clears two
// rungs reports the rung actually reached, and nothing else has to know the
// ladder exists.
async function applyPirepHours(store, pirep, va) {
    if (!pirep || pirep.hoursApplied || !pirep.memberId) return pirep;
    const hrs = (Number(pirep.durationMin) || 0) / 60;
    if (hrs > 0) {
        const before = va ? await store.getMember(pirep.memberId).catch(() => null) : null;
        await store.addMemberHours(pirep.memberId, hrs);
        if (before) {
            const after = await store.getMember(pirep.memberId).catch(() => null);
            if (after) {
                const promotion = crewRanks.promotionFor(va.ranks, before.hours, after.hours, after.checksPassed);
                if (promotion) {
                    postPromotionNotice(va, after, promotion);
                    postAnnouncement(va, {
                        kind: 'promotion',
                        title: `${after.name || 'A pilot'} is now ${promotion.to.name}`,
                        body: promotion.from ? `Up from ${promotion.from.name}.` : '',
                        refId: after._id,
                    });
                }
                // Or the hours took them to the door of a rung somebody has to
                // sign off. Fired once, on the crossing — comparing before and
                // after is what makes it once rather than on every subsequent
                // flight, which would be a weekly nag for a pilot nobody has
                // got round to yet.
                const wasWaiting = crewRanks.awaitingCheck(va.ranks, before.hours, before.checksPassed);
                const nowWaiting = crewRanks.awaitingCheck(va.ranks, after.hours, after.checksPassed);
                if (nowWaiting && (!wasWaiting || wasWaiting.name !== nowWaiting.name)) {
                    postCheckRideDueNotice(va, after, nowWaiting);
                }
            }
        }
    }
    return (await store.updatePirep(pirep._id, { hoursApplied: true })) || { ...pirep, hoursApplied: true };
}
// Roll a PIREP's credited hours back off its pilot (on reject/delete), clamped
// at 0 by the store.
async function reversePirepHours(store, pirep) {
    if (!pirep || !pirep.hoursApplied || !pirep.memberId) return pirep;
    const hrs = (Number(pirep.durationMin) || 0) / 60;
    if (hrs > 0) await store.addMemberHours(pirep.memberId, -hrs);
    return (await store.updatePirep(pirep._id, { hoursApplied: false })) || { ...pirep, hoursApplied: false };
}
const publicPirep = (p) => ({
    id: p._id, memberId: p.memberId, routeId: p.routeId, eventId: p.eventId || null,
    pilotName: p.pilotName, callsign: p.callsign, flightNumber: p.flightNumber,
    origin: p.origin, destination: p.destination,
    aircraftName: p.aircraftName, liveryName: p.liveryName,
    durationMin: p.durationMin, landings: p.landings, xp: p.xp, violations: p.violations,
    distanceNm: p.distanceNm, server: p.server, inFleet: p.inFleet,
    routeMatched: !!p.routeId,   // did this leg match a route in the network?
    source: p.source, status: p.status, flownAt: p.flownAt, createdAt: p.createdAt,
});

/* ===========================================================================
 * THE PILOT'S OWN FLYING
 *
 * The pilot home showed four invented Air Canada legs — CYYZ→CYVR, CYYZ→EGLL,
 * CYUL→KLGA, CYVR→RJTT — hardcoded into the page, plus a rank card reading
 * "First Officer → Captain, 214h of 250h". Every pilot at every VA saw the same
 * four flights and the same 214 hours, over a logbook that contained none of it.
 *
 * That is the same bug crewNotices.js was written to remove from the owner
 * dashboard's activity feed. It was fixed there and never here, which meant the
 * half of the product MOST people actually use was a mockup.
 *
 * One endpoint rather than four, because this is one screen: who the caller is,
 * what rank that makes them, what they have flown, and the totals underneath.
 * A page that has to stitch that together from /me/pilot + /pireps + /roster is
 * a page that renders three different half-truths while it waits.
 * ========================================================================= */
app.get('/api/crew/:slug/me/flying', async (req, res) => {
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const me = await crewPilot(req, store);

        // Not signed in, or signed in as somebody with no roster identity. Not
        // an error: the page shows its "link your pilot record" state, exactly
        // as the staff dashboard's My flying card does.
        if (!me || !me.memberId) {
            return res.json({ pilot: null, rank: null, flights: [], totals: null });
        }

        const member = await store.getMember(me.memberId);
        const hours = member ? Number(member.hours) || 0 : me.hours;
        const flights = await store.listPirepsForMember(me.memberId);

        // Totals from the pilot's OWN reports rather than the roster's hours
        // column, and approved-only — a pending report is not yet time flown,
        // and counting it would have the number drop when staff reject one.
        const approved = flights.filter((f) => f.status === 'approved');
        const since30d = Date.now() - 30 * 86400000;
        const minutes = (list) => list.reduce((s, f) => s + (Number(f.durationMin) || 0), 0);
        const recent = approved.filter((f) => {
            const t = new Date(f.flownAt || f.createdAt).getTime();
            return Number.isFinite(t) && t >= since30d;
        });

        res.set('Cache-Control', 'no-store');
        res.json({
            pilot: {
                memberId: me.memberId,
                name: me.name,
                callsign: me.callsign || '',
                hours,
                status: (member && member.status) || 'active',
            },
            // The whole ladder question answered server-side. The page draws a
            // bar; deciding what "next rank" means — including a pilot who has
            // the hours but is waiting on a check-ride — is not a thing to
            // reimplement in markup that cannot see the ladder.
            rank: crewRanks.memberRank(va.ranks, hours, member && member.checksPassed),
            flights: flights.map(publicPirep),
            totals: {
                flights: approved.length,
                pending: flights.filter((f) => f.status === 'pending').length,
                rejected: flights.filter((f) => f.status === 'rejected').length,
                minutes: minutes(approved),
                minutes30d: minutes(recent),
                flights30d: recent.length,
                lastFlightAt: approved.length ? (approved[0].flownAt || approved[0].createdAt) : null,
            },
        });
    } catch (err) { crewFail(res, err, { log: 'me/flying error', message: 'Could not load your flying.' }); }
});

// List PIREPs. Managers (flights.review) see everything and can filter by status;
// everyone else sees the approved flights only — a public flight log.
app.get('/api/crew/:slug/pireps', async (req, res) => {
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const gate = await requireCap(req, req.params.slug, 'flights.review');
        const isManager = !gate.error;
        let status = 'approved';   // non-managers see the public flight log only
        if (isManager) {
            const s = String(req.query.status || '');
            status = ['pending', 'approved', 'rejected'].includes(s) ? s : '';
        }
        const pireps = await store.listPireps({ status });
        res.json({ pireps: pireps.map(publicPirep), canReview: isManager });
    } catch (err) { crewFail(res, err, { log: 'pireps list error', message: 'Could not load flights.' }); }
});

// File a PIREP by hand. Any signed-in crew member of this VA can submit one.
// Crucially we compare the filed leg against the CURRENT route network to decide
// whether it's a real route: an active route with the same origin+destination
// (preferring an aircraft match) attaches its id + flight number, and the reply
// tells the caller whether the route checked out. Manual reports always land as
// pending for staff review.
app.post('/api/crew/:slug/pireps', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    if (p.kind !== 'inflight' && p.slug && p.slug !== String(req.params.slug).toLowerCase()) {
        return res.status(403).json({ error: 'Wrong crew center.' });
    }
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const b = req.body || {};
        const icao = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

        // Filing FROM an event's brief. The event supplies whatever the pilot
        // did not type — which, filing straight off the brief, is everything
        // except how long it took. Deliberately handled here rather than in a
        // second endpoint: an event flight is an ordinary flight that happens
        // to know why it was flown, and it must be reviewed, credited and
        // route-matched by exactly the same code as any other.
        let event = null;
        if (b.eventId) {
            event = await store.getEvent(b.eventId).catch(() => null);
            if (!event || event.status === 'draft') {
                return res.status(404).json({ error: 'That event isn’t available.' });
            }
        }

        // Filing against a scheduled departure, for the same reasons and by the
        // same route: the leg supplies what the pilot did not type, and the
        // report is otherwise an ordinary report. This is also the one moment a
        // booking can honestly become 'flown' — the pilot saying they flew it.
        let schedule = null;
        if (b.scheduleId) {
            schedule = await store.getSchedule(b.scheduleId).catch(() => null);
            if (!schedule || schedule.status === 'draft') {
                return res.status(404).json({ error: 'That departure isn’t available.' });
            }
        }

        const origin = icao(b.origin) || (event ? event.origin : '') || (schedule ? schedule.origin : '');
        const destination = icao(b.destination) || (event ? event.destination : '') || (schedule ? schedule.destination : '');
        if (!origin || !destination) return res.status(400).json({ error: 'Enter both a departure and an arrival airport.' });
        const aircraftName = String(b.aircraftName || b.aircraft || (event && event.aircraft) || (schedule && schedule.aircraft) || '').trim().slice(0, 60);
        const liveryName = String(b.liveryName || b.livery || '').trim().slice(0, 80);
        // Duration accepts either a minutes number or hours+minutes fields.
        let durationMin = Math.round(Number(b.durationMin) || 0);
        if (!durationMin && (b.hours || b.minutes)) durationMin = Math.round((Number(b.hours) || 0) * 60 + (Number(b.minutes) || 0));
        durationMin = Math.max(0, Math.min(100000, durationMin));
        const landings = Math.max(0, Math.min(100, Math.round(Number(b.landings) || 0)));

        // Optional: attribute to a roster pilot (so approving can credit hours).
        let member = null;
        if (b.memberId) member = await store.getMember(b.memberId);

        // Compare against the current network to judge whether the route is real.
        const vaFull = await VirtualAirlineAd.findById(va._id).select('crewFleet').lean();
        const routes = await store.listRoutes({ activeOnly: true });
        const route = matchRoute(routes, origin, destination, aircraftName);
        const inFleet = pirepInFleet((vaFull && vaFull.crewFleet) || [], aircraftName);
        // If the pilot typed a flight number, note when it disagrees with the route's.
        const claimedFlight = String(b.flightNumber || (event && event.flightNumber) || (schedule && schedule.flightNumber) || '').trim().slice(0, 12);
        const flightNumberMismatch = !!(route && route.flightNumber && claimedFlight && _norm(route.flightNumber) !== _norm(claimedFlight));

        const doc = await store.createPirep({
            memberId: (member && member._id) || null,
            // The route the LEG matched, falling back to the one the event was
            // built on. An event flown on a published route credits against it
            // even when the pilot's typed airports were the thing that matched.
            routeId: (route && route._id) || (event && event.routeId) || (schedule && schedule.routeId) || null,
            eventId: event ? event._id : null,
            scheduleId: schedule ? schedule._id : null,
            pilotName: (member && member.name) || p.name || '', callsign: String(b.callsign || (member && member.callsign) || '').slice(0, 20),
            flightNumber: (route && route.flightNumber) || claimedFlight, ifUserId: (member && member.ifUserId) || '',
            origin, destination, aircraftName, liveryName,
            durationMin, landings, distanceNm: (route && route.distanceNm) || 0,
            inFleet, source: 'manual', status: 'pending',
            flownAt: b.flownAt ? new Date(b.flownAt) : new Date(),
        });
        vaStats.recordEngagement(va._id, 'pirep', 1, va.name);
        // The booking has been flown. Best-effort and deliberately after the
        // report exists: a filed flight must not fail because the schedule row
        // it belongs to could not be marked, and a pilot who filed without
        // booking (they picked up the leg on the day) simply has nothing to
        // mark. Left as-is if they were never on the departure.
        if (schedule) {
            store.getBookingFor(schedule._id, {
                // A crew login's account id is its token subject; staff filing
                // on someone's behalf have none, so the roster row is what
                // finds the booking then.
                accountId: p.kind === 'crew' ? p.sub : '',
                memberId: (member && member._id) || '',
            })
                .then((bk) => bk && bk.status !== 'flown' && store.updateBooking(bk._id, { status: 'flown' }))
                .catch((err) => console.warn('booking not marked flown —', err?.message || err));
        }
        postPirepNotice(va, 'filed', doc, p);
        res.status(201).json({
            pirep: publicPirep(doc),
            routeMatched: !!route,
            flightNumberMismatch,
            route: route ? { id: route._id, flightNumber: route.flightNumber, origin: route.origin, destination: route.destination, aircraft: route.aircraft } : null,
        });
    } catch (err) { crewFail(res, err, { log: 'pirep file error', message: 'Could not file the flight.' }); }
});

// Auto-capture: pull each linked pilot's recent IF flights and turn any we
// haven't seen into PIREPs — matched to the fleet + route network by canonical
// names. In auto-approve mode a fleet match is credited immediately.
app.post('/api/crew/:slug/pireps/sync', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'flights.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const vaFull = await VirtualAirlineAd.findById(va._id).select('crewFleet crewPirepAutoApprove').lean();
        const autoApprove = !!(vaFull && vaFull.crewPirepAutoApprove);
        const fleet = (vaFull && vaFull.crewFleet) || [];
        const routes = await store.listRoutes({ activeOnly: true });
        // Only active pilots linked to an IF account can be auto-tracked. Cap the
        // batch so one sync can't run unbounded.
        const members = await store.listActiveLinkedMembers();
        let meta;
        try { meta = await loadAircraftMetadata(); } catch { meta = { acById: new Map(), livById: new Map() }; }

        let created = 0, approved = 0, scanned = 0;
        for (const m of members) {
            let flights = [];
            try {
                const r = await axios.get(`${ACARS_BACKEND_URL}/api/users/${encodeURIComponent(m.ifUserId)}/flights?page=1`, { timeout: 8000 });
                flights = Array.isArray(r.data && r.data.flights) ? r.data.flights : [];
            } catch { continue; }
            if (!flights.length) continue;
            const ids = flights.map(f => String(f.id || '')).filter(Boolean);
            const seen = await store.seenFlightIds(ids);
            for (const f of flights) {
                scanned++;
                const flightId = String(f.id || '');
                if (!flightId || seen.has(flightId)) continue;
                const { aircraftName, liveryName } = resolveFlightNames(f, meta);
                const origin = String(f.originAirport || '').toUpperCase();
                const destination = String(f.destinationAirport || '').toUpperCase();
                const inFleet = pirepInFleet(fleet, aircraftName);
                const route = matchRoute(routes, origin, destination, aircraftName);
                const durationMin = Math.max(0, Math.round(Number(f.totalTime) || 0));
                const landings = Array.isArray(f.landingStats) ? f.landingStats.length : Math.max(0, Math.round(Number(f.landingCount) || 0));
                const violations = Array.isArray(f.violations) ? f.violations.length : Math.max(0, Math.round(Number(f.violations) || 0));
                const willApprove = autoApprove && inFleet;
                let doc;
                try {
                    doc = await store.createPirep({
                        memberId: m._id, routeId: (route && route._id) || null,
                        pilotName: m.name || m.ifcName || '', callsign: String(f.callsign || m.callsign || '').slice(0, 20),
                        flightNumber: (route && route.flightNumber) || '', ifUserId: m.ifUserId, flightId,
                        origin, destination, aircraftName, liveryName,
                        durationMin, landings, xp: Math.round(Number(f.xp) || 0), violations,
                        distanceNm: (route && route.distanceNm) || 0, server: String(f.server || '').slice(0, 40),
                        inFleet, source: 'auto',
                        status: willApprove ? 'approved' : 'pending',
                        flownAt: f.created ? new Date(f.created) : null,
                        reviewedAt: willApprove ? new Date() : null,
                    });
                } catch { continue; } // a concurrent sync may have inserted the same flight
                created++;
                vaStats.recordEngagement(va._id, 'pirep', 1, va.name);
                // An auto-captured flight is still a flight report arriving, so
                // it posts like one. Auto-approved legs post twice on purpose —
                // filed, then approved — because that is what happened, and a
                // VA watching the feed should see the same two beats whether a
                // human pressed the button or the rule did.
                postPirepNotice(va, 'filed', doc, null);
                if (willApprove) {
                    await applyPirepHours(store, doc, va);
                    postPirepNotice(va, 'approved', doc, { name: 'Auto-approval' });
                    approved++;
                }
            }
        }
        res.json({ ok: true, created, approved, scanned, pilots: members.length });
    } catch (err) { crewFail(res, err, { log: 'pirep sync error', message: 'Sync failed.' }); }
});

// Approve / reject a PIREP. Approving credits the pilot's hours; rejecting an
// already-credited one rolls them back.
app.patch('/api/crew/:slug/pireps/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'flights.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        let p = await store.getPirep(req.params.id);
        if (!p) return res.status(404).json({ error: 'Flight not found.' });
        const action = String(req.body && req.body.action || '');
        if (action === 'approve') {
            // Only announce a real transition. Re-approving an approved report
            // is a no-op, and a feed that fires on those trains people to stop
            // reading it.
            if (p.status !== 'approved') {
                p = await store.updatePirep(p._id, { status: 'approved', reviewedAt: new Date() });
                p = await applyPirepHours(store, p, va);
                postPirepNotice(va, 'approved', p, gate.p);
            }
        } else if (action === 'reject') {
            const was = p.status;
            p = await reversePirepHours(store, p);
            p = await store.updatePirep(p._id, { status: 'rejected', reviewedAt: new Date() });
            if (was !== 'rejected') postPirepNotice(va, 'rejected', p, gate.p);
        } else return res.status(400).json({ error: 'Unknown action.' });
        res.json({ pirep: publicPirep(p) });
    } catch (err) { crewFail(res, err, { log: 'pirep review error', message: 'Could not update the flight.' }); }
});

// Remove a PIREP (rolling back its hours if they were credited).
app.delete('/api/crew/:slug/pireps/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'flights.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const p = await store.getPirep(req.params.id);
        if (!p) return res.status(404).json({ error: 'Flight not found.' });
        await reversePirepHours(store, p);
        await store.deletePirep(p._id);
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'pirep delete error', message: 'Could not remove the flight.' }); }
});

// ---- Recruitment: applications ----
// Submit a join application (public). Free mode creates the pilot instantly;
// application mode leaves it pending for staff. A min-grade gate blocks
// self-reported grades below the requirement.
app.post('/api/crew/:slug/apply', async (req, res) => {
    try {
        const raw = String(req.params.slug || '').trim().toLowerCase();
        // crewStore.SELECT carries the VA's data-store connection: the
        // application (and the pilot record a 'free' join creates) is written to
        // the VA's own project, not ours.
        const applyFields = `${crewStore.SELECT} joinMode minGrade callsignPrefix applicationForm joinRequirements +crewWebhookUrl`;
        let ad = await VirtualAirlineAd.findOne({ slug: raw, status: 'approved' })
            .select(applyFields).lean();
        if (!ad) ad = await VirtualAirlineAd.findOne({ callsign: raw.toUpperCase(), status: 'approved' })
            .select(applyFields).lean();
        if (!ad) return res.status(404).json({ error: 'Crew center not found.' });
        const store = await crewStore.forVa(ad);

        const b = req.body || {};
        let ifcName = String(b.ifcName || '').trim().slice(0, 60);
        if (!ifcName) return res.status(400).json({ error: 'Your Infinite Flight Community name is required.' });

        // Verify the account against Infinite Flight using our own tooling. When
        // the lookup succeeds we trust its grade over anything self-reported;
        // when the service is down we fall back to the self-reported grade so a
        // pilot is never blocked by our outage.
        const check = await verifyIfUser(ifcName);
        let ifVerified = false, ifUserId = '';
        let grade = Math.max(0, Math.min(5, Number(b.grade) || 0));
        if (check.ok && check.found) {
            ifVerified = true;
            ifUserId = check.userId;
            if (check.username) ifcName = check.username.slice(0, 60); // canonical spelling
            if (check.grade != null) grade = Math.max(0, Math.min(5, check.grade));
        } else if (check.ok && !check.found) {
            // We reached IF and it has no such account — reject clearly.
            return res.status(404).json({ error: `We couldn't find an Infinite Flight account named "${ifcName}". Check the spelling of your Community name.` });
        }
        // (check.ok === false → service unreachable → proceed unverified.)

        // Assemble the effective requirement set: the extensible list, plus the
        // legacy minGrade gate folded in (unless a grade requirement is already
        // present) so old VAs keep working.
        const reqs = Array.isArray(ad.joinRequirements) ? ad.joinRequirements.slice() : [];
        if (ad.minGrade > 0 && !reqs.some(r => r.type === 'grade')) reqs.push({ type: 'grade', value: ad.minGrade });

        const stats = check.stats || (ifVerified ? { grade } : null);
        const agreed = Array.isArray(b.agreed) ? b.agreed.slice(0, 20).map(x => String(x).slice(0, 200)) : [];
        const evalRes = evaluateRequirements(reqs, stats, agreed);
        if (!evalRes.ok) {
            // If the only reason we failed is that IF stats were unavailable, ask
            // them to retry rather than reject them outright.
            const onlyUnverified = evalRes.failures.every(f => f.unverified);
            if (onlyUnverified) {
                return res.status(422).json({ error: 'We couldn’t reach Infinite Flight to verify your stats. Please try again in a moment.', requirementFailures: evalRes.failures });
            }
            const human = evalRes.failures.filter(f => !f.unverified).map(f => {
                if (f.cmp === 'agree') return `You must accept: “${f.label}”`;
                const word = f.cmp === 'max' ? 'at most' : 'at least';
                const have = f.have == null ? '' : ` (you have ${f.have})`;
                return `${f.label}: ${word} ${f.need}${have}`;
            });
            return res.status(403).json({ error: `You don’t meet this VA’s requirements yet — ${human.join('; ')}.`, requirementFailures: evalRes.failures });
        }
        const prefix = (String(b.callsignPrefix || '').trim() || ad.callsignPrefix || ad.callsign || '').slice(0, 10);
        const number = String(b.callsignNumber || '').trim().slice(0, 10);
        const cs = (prefix + number).trim();
        const email = isEmail(b.email) ? String(b.email).trim().toLowerCase().slice(0, 120) : '';
        const answers = Array.isArray(b.answers)
            ? b.answers.slice(0, 50).map(x => ({ q: String(x.q || '').slice(0, 120), a: String(x.a || '').slice(0, 2000) })) : [];

        const statusToken = crypto.randomBytes(16).toString('hex');
        const status = ad.joinMode === 'free' ? 'accepted' : 'pending';
        const appDoc = await store.createApplication({
            ifcName, email, callsignPrefix: prefix, callsignNumber: number, grade,
            ifVerified, ifUserId, answers, statusToken,
            status, reviewedAt: status === 'accepted' ? new Date() : null,
        });
        vaStats.recordEngagement(ad._id, 'application', 1, ad.name);
        // A free-join VA accepts on the spot, so this is the moment that pilot
        // becomes crew — roster row and crew center login together. `credentials`
        // carries the one-time password: emailed below when they gave an address,
        // and returned in the response either way so the join page can show it
        // once to someone who didn't.
        let credentials = null;
        if (status === 'accepted') {
            const member = await store.createMember({
                name: ifcName, callsign: (prefix + number).trim(),
                hours: 0, role: '', aircraft: [], status: 'active',
                ifUserId: ifUserId || '', ifcName,
            });
            vaStats.recordEngagement(ad._id, 'crewJoin', 1, ad.name);
            // Best-effort, like the accept path: a pilot who is on the roster
            // but could not be issued a login is fixable from the dashboard,
            // and failing the join over it would be worse.
            try {
                const r = await crewAccounts.provisionPilotAccount(store, {
                    displayName: ifcName, memberId: member ? member._id : null,
                    email, createdByName: 'Join form', vaName: ad.name || '',
                });
                credentials = { username: r.username, password: r.password, created: r.created };
                // Keep the invitation on the application row as well as in this
                // response. The status link handed back below is the only
                // channel that still reaches an applicant who gave no email and
                // closed this page before writing the password down.
                if (r.created && r.password) {
                    await store.updateApplication(appDoc._id, crewInvite.issuePatch({
                        username: r.username, password: r.password, accountId: r.account && r.account._id,
                    })).catch((e) => console.error('join invite persist error:', e?.message || e));
                }
            } catch (err) {
                console.error('join account provision error:', err?.message || err);
            }
        }
        // Notify the VA's Discord (fire-and-forget). Free-mode joins and
        // pending applications both post so staff see activity in real time.
        if (ad.crewWebhookUrl) {
            postCrewNotice(ad.crewWebhookUrl, status === 'accepted' ? {
                title: `🎉 New pilot joined — ${ifcName}`,
                color: CREW_COLORS.accepted,
                fields: [
                    { name: 'Callsign', value: cs || '—', inline: true },
                    { name: 'Grade', value: grade ? `Grade ${grade}` : '—', inline: true },
                    { name: 'Verified', value: ifVerified ? '✓ yes' : 'no', inline: true },
                ],
            } : {
                title: `📝 New application — ${ifcName}`,
                description: 'Review it in your Crew Center → Roster → Applications.',
                color: CREW_COLORS.new,
                fields: [
                    { name: 'Callsign', value: cs || '—', inline: true },
                    { name: 'Grade', value: grade ? `Grade ${grade}` : '—', inline: true },
                    { name: 'Verified', value: ifVerified ? '✓ yes' : 'no', inline: true },
                ],
            }).catch(() => {});
        }
        // Acknowledge to the applicant by email (if they gave one). Free-mode
        // joins get a welcome; applications get a "received + your status link".
        if (email) {
            const emailCfg = await crewEmailConfigFor(ad._id);
            const slug = ad.slug || raw;
            const statusUrl = `${SITE_ORIGIN}/crew/${encodeURIComponent(slug)}/status?id=${statusToken}`;
            const centerUrl = `${SITE_ORIGIN}/crew/${encodeURIComponent(slug)}`;
            if (status === 'accepted') {
                sendCrewEmail(emailCfg, { to: email, subject: `Welcome to ${ad.name || 'the crew'}!`,
                    html: crewEmailHtml({ vaName: ad.name, accent: ad.crewAccent, heading: 'Welcome aboard! 🎉',
                        bodyHtml: `You’re now flying with <b>${escHtml(ad.name || 'the crew')}</b>${cs ? `, as <b>${escHtml(cs)}</b>` : ''}.`
                            + crewCredentialsHtml({ ...(credentials || {}), signInUrl: centerUrl }),
                        button: { label: credentials && credentials.password ? 'Sign in to the crew center' : 'Open the crew center', url: centerUrl } }) }).catch(() => {});
            } else {
                sendCrewEmail(emailCfg, { to: email, subject: `Application received — ${ad.name || 'Crew Center'}`,
                    html: crewEmailHtml({ vaName: ad.name, accent: ad.crewAccent, heading: 'Application received',
                        bodyHtml: `Thanks, <b>${escHtml(ifcName)}</b>. The ${escHtml(ad.name || 'VA')} team will review your application and we’ll email you here as soon as there’s a decision.`,
                        button: { label: 'Check your status', url: statusUrl } }) }).catch(() => {});
            }
        }
        res.json({
            status, callsign: cs, applicationId: appDoc._id, statusToken, ifVerified, grade,
            emailed: !!email,
            // Only ever populated on a free-mode join, and only the first time —
            // this is the sole copy of that password, and the join page shows it
            // once with a "write this down" warning.
            account: credentials,
        });
    } catch (err) { crewFail(res, err, { log: 'apply error', message: 'Could not submit your application.' }); }
});
// Public: verify an Infinite Flight Community name in real time so the join
// form can show a "✓ verified" badge and lock in the true grade before the
// pilot submits. Returns { found, username, grade } — never an error for a
// simple "not found", so the form can react smoothly.
app.post('/api/crew/:slug/verify-if', async (req, res) => {
    try {
        const name = String(req.body?.ifcName || '').trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'Enter your Infinite Flight Community name.' });
        const check = await verifyIfUser(name);
        if (!check.ok) return res.json({ available: false }); // service down; form falls back
        if (!check.found) return res.json({ available: true, found: false });
        res.json({ available: true, found: true, username: check.username, grade: check.grade, stats: check.stats || null });
    } catch (err) { console.error('verify-if error:', err); res.status(500).json({ error: 'Verification is unavailable right now.' }); }
});

// Everything a rendering of an invitation needs to know. One builder, used by
// the acceptance response, the applicant's status page and the staff clipboard,
// so the three cannot drift into saying different things about the same login.
function inviteContext(va, appDoc, slug) {
    return {
        vaName: (va && va.name) || '',
        ifcName: (appDoc && appDoc.ifcName) || '',
        callsign: (((appDoc && appDoc.callsignPrefix) || '') + ((appDoc && appDoc.callsignNumber) || '')).trim(),
        signInUrl: `${SITE_ORIGIN}/crew/${encodeURIComponent((va && va.slug) || slug)}`,
        discordInvite: (appDoc && appDoc.discordInvite) || '',
        staffMessage: (appDoc && appDoc.staffMessage) || '',
    };
}

// An invitation that has aged out still has a live password sitting in the row
// until something notices. Reads are where we notice, so drop it there — a
// best-effort write that must never fail the read it is riding on.
function sweepExpiredInvite(store, appDoc) {
    if (crewInvite.inviteState(appDoc) !== 'expired') return;
    Promise.resolve(store.updateApplication(appDoc._id, crewInvite.expirePatch()))
        .catch((e) => console.error('invite expiry sweep error:', e?.message || e));
}

// Public: an applicant checks the state of their application with the opaque
// token they were handed at submit time. No account or email needed. Includes
// any message staff left when they reviewed it, and — while the invitation is
// live — the login they were issued.
app.get('/api/crew/:slug/application-status/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!token) return res.status(400).json({ error: 'Missing status token.' });
        const { va, store } = await resolveCrewStore(req.params.slug);
        const appDoc = await store.getApplicationByToken(token);
        if (!appDoc) return res.status(404).json({ error: 'We could not find that application.' });
        sweepExpiredInvite(store, appDoc);
        // This response can carry a credential, so it must not be stored by a
        // browser cache or by anything between here and the applicant.
        res.set('Cache-Control', 'no-store');
        res.json({
            status: appDoc.status,
            message: appDoc.staffMessage || '',
            ifcName: appDoc.ifcName || '',
            callsign: ((appDoc.callsignPrefix || '') + (appDoc.callsignNumber || '')).trim(),
            // Only meaningful once accepted, and only ever set by the accept
            // handler from a validated invite.
            discordInvite: appDoc.status === 'accepted' ? (appDoc.discordInvite || '') : '',
            // The login they were issued, for as long as the invitation is live.
            // null once they have signed in, once staff have thrown it away, and
            // once it has aged out — the status link stops being a way in the
            // moment it stops needing to be one.
            credentials: appDoc.status === 'accepted'
                ? crewInvite.applicantCredentials(appDoc, inviteContext(va, appDoc, req.params.slug))
                : null,
            reviewedAt: appDoc.reviewedAt || null,
            submittedAt: appDoc.createdAt || null,
        });
    } catch (err) { crewFail(res, err, { log: 'application-status error', message: 'Could not load that application.' }); }
});

// An application on its way out to staff. The raw row carries the invitation's
// stored password, and handing that straight to the browser would show one that
// has quietly aged out — so the invite fields are replaced wholesale by the
// accessor that knows the difference. There is one shape, so there is one place
// to get this wrong.
function staffApplication(appDoc, va, slug) {
    const {
        inviteUsername, invitePassword, inviteIssuedAt, inviteClaimedAt,
        inviteRevokedAt, inviteAccountId, ...rest
    } = appDoc || {};
    return { ...rest, invite: crewInvite.staffInvite(appDoc, inviteContext(va, appDoc, slug)) };
}

// Staff: list applications (default pending).
app.get('/api/crew/:slug/applications', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'applications.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const wanted = String(req.query.status || '');
        const status = ['pending', 'accepted', 'declined'].includes(wanted) ? wanted : 'pending';
        const rows = await store.listApplications({ status });
        (rows || []).forEach((a) => sweepExpiredInvite(store, a));
        // Live passwords may be in here, so keep it out of every cache.
        res.set('Cache-Control', 'no-store');
        res.json({ applications: (rows || []).map((a) => staffApplication(a, va, req.params.slug)) });
    } catch (err) { crewFail(res, err, { log: 'applications list error', message: 'Could not load applications.' }); }
});
// Staff: accept / decline an application. Accept creates the pilot.
app.patch('/api/crew/:slug/applications/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'applications.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        let appDoc = await store.getApplication(req.params.id);
        if (!appDoc) return res.status(404).json({ error: 'Application not found.' });
        const action = String(req.body?.action || '');
        const message = String(req.body?.message || '').trim().slice(0, 2000);
        const patch = { reviewedAt: new Date() };

        // An address the reviewer typed in, for an applicant who left the email
        // field blank. It is the difference between a pilot receiving their
        // one-time password and a staff member having to read it out, so the
        // accept dialog asks for one whenever the application has none.
        //
        // It only ever FILLS a gap: an address the applicant gave themselves is
        // never overwritten from the review screen, because that would let staff
        // redirect someone else's credentials to an inbox of their choosing.
        if (!appDoc.email && req.body?.email !== undefined) {
            const typed = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
            if (typed && !isEmail(typed)) {
                return res.status(400).json({ error: 'That doesn’t look like an email address.' });
            }
            if (typed) { patch.email = typed; appDoc = { ...appDoc, email: typed }; }
        }

        // What the pilot gets handed along with the decision. `credentials` is
        // returned to the reviewing staff member exactly once — see below.
        let credentials = null;
        let invite = '';

        if (action === 'accept') {
            // The invite the pilot is sent: whatever the reviewer typed, else
            // the VA's stored default. Rejected outright if it isn't a real
            // Discord invite — we are about to put it in an email with our name
            // on it (see isDiscordInviteUrl).
            if (req.body?.discordInvite !== undefined) {
                invite = cleanDiscordInvite(req.body.discordInvite);
                if (invite === null) {
                    return res.status(400).json({ error: 'That is not a Discord invite link. Use a discord.gg or discord.com/invite address.' });
                }
            }
            if (!invite) {
                const withInvite = await VirtualAirlineAd.findById(va._id).select('crewDiscordInvite').lean();
                invite = (withInvite && withInvite.crewDiscordInvite) || '';
            }
            if (invite) patch.discordInvite = invite;

            // Only mint the pilot on the transition into 'accepted', so
            // re-accepting an already-accepted application can't duplicate them.
            let member = null;
            if (appDoc.status !== 'accepted') {
                member = await store.createMember({
                    name: appDoc.ifcName, callsign: (appDoc.callsignPrefix + appDoc.callsignNumber).trim(),
                    hours: 0, role: '', aircraft: [], status: 'active',
                    ifUserId: appDoc.ifUserId || '', ifcName: appDoc.ifcName || '',
                });
                vaStats.recordEngagement(va._id, 'crewJoin', 1, va.name);
                // Put them on the noticeboard. A new pilot's first visit to the
                // crew center is the one where they are most likely to be
                // looking, and "welcome aboard" being there for the crew to see
                // is worth more than the Discord line that scrolls away.
                postAnnouncement(va, {
                    kind: 'join',
                    title: `${member.name || 'A new pilot'} joined the crew`,
                    body: member.callsign ? `Flying as ${member.callsign}.` : '',
                    refId: member._id,
                });
            }

            // A crew center login, when the reviewer asked for one. It is
            // written into the VA's OWN data store next to the roster row it
            // belongs to — Inflight never holds a pilot's credentials.
            //
            // Best-effort: a pilot who is on the roster but could not be given
            // an account is a fixable annoyance, whereas failing the whole
            // acceptance over it would leave the application pending after we
            // already added them.
            if (req.body?.createAccount) {
                try {
                    const r = await crewAccounts.provisionPilotAccount(store, {
                        displayName: appDoc.ifcName || '',
                        memberId: member ? member._id : null,
                        email: appDoc.email || '',
                        createdByName: gate.p?.name || 'Crew Center',
                        vaName: va.name || '',
                    });
                    // A password comes back only on first creation; re-accepting
                    // someone who already has a login yields username-only.
                    credentials = { username: r.username, password: r.password, created: r.created };
                    // Fold the invitation into the same patch that records the
                    // decision, so the acceptance and the credential it produced
                    // are one write. It stays readable — to staff, and to the
                    // holder of the status link — until the pilot signs in, a
                    // staff member throws it away, or it ages out.
                    if (r.created && r.password) {
                        Object.assign(patch, crewInvite.issuePatch({
                            username: r.username, password: r.password, accountId: r.account && r.account._id,
                        }));
                    }
                } catch (err) {
                    console.error('pilot account provision error:', err?.message || err);
                    // An older schema is the one failure the VA can act on, so
                    // say that rather than the generic line.
                    credentials = {
                        error: err && err.code === 'store_accounts_missing'
                            ? 'The pilot was accepted, but your project needs the updated setup SQL before it can hold pilot logins (Settings → Data store).'
                            : 'The pilot was accepted, but their crew center account could not be created.',
                    };
                }
            }
            patch.status = 'accepted';
        } else if (action === 'decline') {
            patch.status = 'declined';
        } else return res.status(400).json({ error: 'Unknown action.' });
        if (message) patch.staffMessage = message;
        appDoc = (await store.updateApplication(appDoc._id, patch)) || { ...appDoc, ...patch };

        const cs = (appDoc.callsignPrefix + appDoc.callsignNumber).trim();
        const accepted = appDoc.status === 'accepted';
        // Post the decision (+ the staff's message) to the VA's Discord.
        const hook = await crewWebhookUrlFor(va._id);
        if (hook) {
            postCrewNotice(hook, {
                title: `${accepted ? '✅ Accepted' : '🚫 Declined'} — ${appDoc.ifcName}`,
                description: message || undefined,
                color: accepted ? CREW_COLORS.accepted : CREW_COLORS.declined,
                fields: accepted && cs ? [{ name: 'Callsign', value: cs, inline: true }] : [],
            }).catch(() => {});
        }
        // Email the applicant the decision + the staff's message (if they left one).
        if (appDoc.email) {
            const emailCfg = await crewEmailConfigFor(va._id);
            const slug = va.slug || req.params.slug;
            const statusUrl = `${SITE_ORIGIN}/crew/${encodeURIComponent(slug)}/status?id=${appDoc.statusToken}`;
            const centerUrl = `${SITE_ORIGIN}/crew/${encodeURIComponent(slug)}`;
            let body = (accepted
                ? `Great news — welcome to <b>${escHtml(va.name || 'the crew')}</b>${cs ? `, flying as <b>${escHtml(cs)}</b>` : ''}.`
                : `Thanks for applying to <b>${escHtml(va.name || 'the VA')}</b>. Unfortunately they weren’t able to accept your application this time.`)
                + (message ? `<br><br><b>Message from the team:</b><br>${escHtml(message).replace(/\n/g, '<br>')}` : '');
            // The two things a new pilot needs next: how to sign in, and where
            // the crew actually talks. The password is printed here because this
            // is the only copy — nothing stores it, here or in the VA's project
            // (see crewAccounts.provisionPilotAccount).
            if (accepted && credentials && credentials.password) {
                body += crewCredentialsHtml({ ...credentials, signInUrl: centerUrl });
            }
            if (accepted && invite) {
                body += `<br><br><b>Join the crew on Discord</b><br><a href="${escHtml(invite)}">${escHtml(invite)}</a>`;
            }
            const signInEmail = accepted && credentials && credentials.password;
            sendCrewEmail(emailCfg, { to: appDoc.email,
                subject: accepted ? `You’re in — ${va.name || 'Crew Center'}` : `Update on your application — ${va.name || 'Crew Center'}`,
                html: crewEmailHtml({ vaName: va.name, accent: va.crewAccent, heading: accepted ? 'You’re in! 🎉' : 'Application update',
                    bodyHtml: body,
                    button: accepted
                        ? { label: signInEmail ? 'Sign in to the crew center' : 'Open the crew center', url: centerUrl }
                        : { label: 'View your application', url: statusUrl } }) }).catch(() => {});
        }
        // `account` is the credential as it was just minted; `invite` is the
        // same thing as it will look on every later read, message included, so
        // the dashboard renders one card here and after a reload. This response
        // can carry a password, so it is not cacheable.
        res.set('Cache-Control', 'no-store');
        res.json({
            status: appDoc.status,
            message: appDoc.staffMessage || '',
            discordInvite: accepted ? (invite || '') : '',
            emailed: !!(accepted && appDoc.email),
            email: accepted ? (appDoc.email || '') : '',
            // Where the pilot signs in, so the reviewer can pass on a working
            // link with the credentials when there was no email to send them to.
            signInUrl: accepted ? `${SITE_ORIGIN}/crew/${encodeURIComponent(va.slug || req.params.slug)}` : '',
            account: credentials,
            invite: accepted
                ? crewInvite.staffInvite(appDoc, inviteContext(va, appDoc, req.params.slug))
                : null,
        });
    } catch (err) { crewFail(res, err, { log: 'application review error', message: 'Could not update the application.' }); }
});

// ---- The invitation on an accepted application ----
//
// An acceptance produces a login that somebody still has to deliver, usually by
// hand and usually later — an IFC message, a Discord DM. These three endpoints
// are that gap: read the invitation back (with the message ready to paste),
// mint a fresh one when the first never arrived, or throw it away.
//
// All three are gated on applications.review rather than owner-only. Whoever is
// trusted to accept a pilot is by definition trusted to hand them their login;
// making this owner-only would mean the person who did the accepting cannot
// finish the job.

// Locate the account an invitation belongs to. The id is recorded when the
// invitation is issued, but an invitation written before that (or one whose
// account was rebuilt) still resolves by the username it names.
async function inviteAccountFor(store, appDoc) {
    if (appDoc.inviteAccountId) {
        const byId = await store.getAccount(appDoc.inviteAccountId).catch(() => null);
        if (byId) return byId;
    }
    if (appDoc.inviteUsername) {
        return store.getAccountByUsername(String(appDoc.inviteUsername).toLowerCase()).catch(() => null);
    }
    return null;
}

// Read one invitation back, message included.
app.get('/api/crew/:slug/applications/:id/invite', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'applications.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const appDoc = await store.getApplication(req.params.id);
        if (!appDoc) return res.status(404).json({ error: 'Application not found.' });
        sweepExpiredInvite(store, appDoc);
        res.set('Cache-Control', 'no-store');
        res.json({ invite: crewInvite.staffInvite(appDoc, inviteContext(va, appDoc, req.params.slug)) });
    } catch (err) { crewFail(res, err, { log: 'invite read error', message: 'Could not load that invitation.' }); }
});

// Mint a fresh temporary password for a pilot who never got the first one.
//
// This resets the account's real password too — the two cannot be allowed to
// disagree, or the invitation would show a password that does not work. Which
// also means it invalidates whatever the pilot may already be holding, so the
// dashboard asks before calling it.
app.post('/api/crew/:slug/applications/:id/invite/regenerate', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'applications.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const appDoc = await store.getApplication(req.params.id);
        if (!appDoc) return res.status(404).json({ error: 'Application not found.' });
        if (appDoc.status !== 'accepted') {
            return res.status(400).json({ error: 'Only an accepted application has an invitation.' });
        }
        const account = await inviteAccountFor(store, appDoc);
        if (!account) {
            return res.status(404).json({ error: 'This pilot has no crew center login to reissue. Create one from the roster.' });
        }
        const reset = await crewAccounts.resetPassword(store, account._id);
        if (!reset) return res.status(404).json({ error: 'This pilot has no crew center login to reissue.' });
        const updated = await store.updateApplication(appDoc._id, crewInvite.issuePatch({
            username: reset.username, password: reset.password, accountId: account._id,
        })) || { ...appDoc };
        res.set('Cache-Control', 'no-store');
        res.json({ invite: crewInvite.staffInvite(updated, inviteContext(va, updated, req.params.slug)) });
    } catch (err) { crewFail(res, err, { log: 'invite regenerate error', message: 'Could not reissue that invitation.' }); }
});

// Throw the invitation away.
//
// Deliberately does NOT touch the pilot's account: an invitation nobody needs
// any more is not the same event as a pilot losing their login, and conflating
// them would make tidying up the applications list a way to lock somebody out.
// Suspending or deleting the account is its own action on the accounts screen.
app.delete('/api/crew/:slug/applications/:id/invite', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'applications.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const appDoc = await store.getApplication(req.params.id);
        if (!appDoc) return res.status(404).json({ error: 'Application not found.' });
        const updated = await store.updateApplication(appDoc._id, crewInvite.revokePatch()) || { ...appDoc };
        res.json({ invite: crewInvite.staffInvite(updated, inviteContext(va, updated, req.params.slug)) });
    } catch (err) { crewFail(res, err, { log: 'invite revoke error', message: 'Could not discard that invitation.' }); }
});

// ---- Public statistics ----
// "How many pilots, how many hours, how many flights?" — the figures a VA wants
// on their own homepage, and the ones the crew center dashboard leads with.
//
// Deliberately public and CORS-open (the global cors() sends
// Access-Control-Allow-Origin: *) so a VA can fetch it straight from their own
// site with no key and no proxy. It returns aggregates plus a small
// hours leaderboard — never an email address, never an application, never a
// status token. Everything is computed inside the VA's own database.
const CREW_STATS_TTL_MS = 60 * 1000;
const _crewStatsCache = new Map();   // slug -> { at, payload }

// How many people are queued up to join is the VA's business, not the public's:
// it says something about a private queue that no public page needs. The cache
// holds the full snapshot and these are dropped on the way out to anyone who
// can't review applications, so one cached entry serves both audiences.
const MANAGER_ONLY_STATS = ['applicationsPending', 'applicationsAccepted', 'applications30d'];
function scopeStats(payload, isManager) {
    if (isManager || !payload || !payload.stats) return payload;
    const stats = { ...payload.stats };
    MANAGER_ONLY_STATS.forEach((k) => delete stats[k]);
    return { ...payload, stats };
}

/* ===========================================================================
 * INSIGHTS — what this airline's flying actually looks like
 *
 * Separate from /stats on purpose. That endpoint answers "how big is this VA"
 * for a public homepage, is computed in Postgres by crew_stats() and cached.
 * This answers the questions a VA asks about its OWN operation — most flown
 * route, who is carrying the airline this month, which published routes nobody
 * has ever touched — every one of which is a GROUP BY that crew_stats does not
 * do.
 *
 * Computed in JS rather than added to the SQL so it needs no schema bump: it
 * works today on every VA, including those on an older schema and those still
 * on legacy managed storage.
 *
 * Staff-facing, gated on flights.review — this names individual pilots and
 * ranks them, which is roster business rather than something for the public
 * page. The window is the caller's choice; 0 means all time.
 * ========================================================================= */

/* ===========================================================================
 * THE ROSTER SWEEP
 *
 * Two endpoints, and the difference between them is the whole safety story.
 *
 *   GET  /retention   answers "who would this take?" and changes nothing.
 *   POST /retention/run  actually runs it, now, off the timer.
 *
 * The preview exists because an owner cannot reasonably be asked to switch on
 * something that deletes pilots and find out afterwards who it took. It is the
 * same code path as the real sweep with dryRun set, so the list it shows is the
 * list that would go — not a second implementation that could disagree.
 *
 * Owner-only, both of them, matching the settings gate in crewAuth.
 * ========================================================================= */
app.get('/api/crew/:slug/retention', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    if (!(p.kind === 'inflight' || p.role === 'owner')) {
        return res.status(403).json({ error: 'Only the owner can see the roster sweep.' });
    }
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const preview = await runRetentionSweep(va, { dryRun: true });
        res.json({
            rules: crewRetention.publicRules(va.crewRetention),
            // What a run right now would do. Empty lists on a VA that has the
            // feature switched off, which is the honest answer rather than an
            // error — the settings screen shows this next to the switches.
            preview: {
                checked: preview.checked,
                skipped: preview.skipped || '',
                warned: preview.warned,
                removed: preview.removed,
                deactivated: preview.deactivated,
            },
        });
    } catch (err) { crewFail(res, err, { log: 'retention preview error', message: 'Could not read the roster sweep.' }); }
});

app.post('/api/crew/:slug/retention/run', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    if (!(p.kind === 'inflight' || p.role === 'owner')) {
        return res.status(403).json({ error: 'Only the owner can run the roster sweep.' });
    }
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const rules = crewRetention.normalizeRules(va.crewRetention);
        if (!rules.enabled) return res.status(400).json({ error: 'The roster sweep is switched off.' });
        const out = await runRetentionSweep(va, { dryRun: false });
        res.json({
            ok: true,
            checked: out.checked,
            skipped: out.skipped || '',
            warned: out.warned,
            removed: out.removed,
            deactivated: out.deactivated,
            failed: out.failed,
        });
    } catch (err) { crewFail(res, err, { log: 'retention run error', message: 'Could not run the roster sweep.' }); }
});

app.get('/api/crew/:slug/insights', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'flights.review');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const allowed = [0, 30, 90, 365];
        const asked = parseInt(req.query.days, 10);
        const days = allowed.includes(asked) ? asked : 90;

        // A big read, so it is done once and sliced in memory rather than
        // re-queried per section. The ceiling is high enough for any VA that
        // exists and low enough that one request cannot hold their project open.
        const [pireps, members, routes, notices] = await Promise.all([
            store.listPireps({ status: '', limit: 5000 }),
            store.listMembers({ limit: 5000 }),
            store.listRoutes({ limit: 5000 }),
            // Best-effort: a project predating the noticeboard still has flying
            // worth reporting, and the crew-activity block is the only part
            // that needs these.
            Promise.resolve(store.listAnnouncements({ limit: 500 })).catch(() => []),
        ]);

        res.set('Cache-Control', 'no-store');
        res.json({
            ok: true,
            ...crewInsights.build({ pireps, members, routes, notices, days }),
            // So the screen can say "of 1,284 reports, 903 are approved" rather
            // than quietly reporting a subset as the whole.
            counted: { approved: pireps.filter((p) => p.status === 'approved').length, reports: pireps.length },
        });
    } catch (err) { crewFail(res, err, { log: 'crew insights error', message: 'Could not work out your statistics.' }); }
});

app.get('/api/crew/:slug/stats', async (req, res) => {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    try {
        // A signed-in reviewer additionally gets the application counters. The
        // gate is best-effort: an absent or invalid token just means "public".
        let isManager = false;
        try { isManager = !(await requireCap(req, slug, 'applications.review')).error; } catch { /* public */ }

        const fresh = String(req.query.fresh || '') === '1';
        const hit = _crewStatsCache.get(slug);
        if (!fresh && hit && (Date.now() - hit.at) < CREW_STATS_TTL_MS) {
            // Only the anonymous form is safe in a shared cache.
            res.set('Cache-Control', isManager ? 'no-store' : 'public, max-age=60');
            return res.json({ ...scopeStats(hit.payload, isManager), cached: true });
        }

        const va = await resolveCrewVa(slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });

        // A VA that hasn't connected a store yet is not an error on a public
        // page — it is a VA with no figures. Say so and let the page hide them.
        const store = await crewStore.forVaOrNull(va);
        if (!store) {
            return res.json({
                ok: true, slug: va.slug || slug, name: va.name || '', callsign: va.callsign || '',
                connected: false, stats: null,
            });
        }

        const stats = await store.stats();
        const payload = {
            ok: true,
            slug: va.slug || slug,
            name: va.name || '',
            callsign: va.callsign || '',
            connected: true,
            // Which backend answered. 'supabase' = the VA's own project (the
            // destination); 'managed' = our legacy collections, i.e. this VA
            // still needs to migrate.
            store: store.kind,
            selfHosted: !!store.owned,
            stats,
        };
        _crewStatsCache.set(slug, { at: Date.now(), payload });
        res.set('Cache-Control', isManager ? 'no-store' : 'public, max-age=60');
        res.json(scopeStats(payload, isManager));
    } catch (err) {
        // Serve a stale snapshot rather than breaking a VA's homepage because
        // their database blipped.
        const hit = _crewStatsCache.get(slug);
        if (hit) return res.json({ ...scopeStats(hit.payload, false), cached: true, stale: true });
        crewFail(res, err, { log: 'crew stats error', message: 'Could not load statistics.' });
    }
});

// ---- The VA's data store: health + migration ----
// Is the VA's project reachable, provisioned and on the current schema? Backs
// the tick (or the fix-this instruction) on the Settings → Data store screen.
app.get('/api/crew/:slug/store', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'settings.notifications');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const connected = crewStore.isConnected(va);
        const store = await crewStore.forVaOrNull(va);
        let health = store ? await store.health() : { ok: false, provisioned: false, code: 'store_not_connected' };

        // A project that is behind, and a token the VA gave us to fix exactly
        // that: run it now rather than showing them a warning about a thing we
        // were asked to handle. Silent when there is no token, when the VA
        // turned it off, or when it ran recently — see autoUpdateStore.
        const auto = await autoUpdateStore(va, health);
        if (auto && auto.ran && store) health = await store.health();

        const tokenMeta = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META).lean();
        // How much is still sitting in our managed collections? A non-zero count
        // is what the migrate button acts on.
        const pending = {
            members: await CrewMember.countDocuments({ vaAdId: va._id }),
            routes: await CrewRoute.countDocuments({ vaAdId: va._id }),
            pireps: await CrewPirep.countDocuments({ vaAdId: va._id }),
            applications: await CrewApplication.countDocuments({ vaAdId: va._id }),
            // Pilot logins we are still holding centrally. They move across with
            // everything else, and until they do, this VA's pilots are signing
            // in against our database rather than their own.
            accounts: await VaPortalAccount.countDocuments({ vaAdId: va._id, role: 'pilot' }),
        };
        res.set('Cache-Control', 'no-store');
        res.json({
            connected,
            url: va.supabaseUrl || '',
            hasServiceKey: !!va.supabaseServiceKey,
            kind: store ? store.kind : 'none',
            selfHosted: !!(store && store.owned),
            health,
            legacyRows: pending,
            legacyTotal: pending.members + pending.routes + pending.pireps + pending.applications + pending.accounts,
            schemaVersion: crewStore.EXPECTED_SCHEMA_VERSION,
            accountsSchemaVersion: crewStore.ACCOUNTS_SCHEMA_VERSION,
            eventsSchemaVersion: crewStore.EVENTS_SCHEMA_VERSION,
            storageSchemaVersion: crewStore.STORAGE_SCHEMA_VERSION,
            // The saved access token, described but never disclosed.
            token: tokenState(tokenMeta),
            // Set when this very request brought the project up to date, so the
            // screen can say what happened instead of just looking fine.
            autoUpdated: !!(auto && auto.ran),
        });
    } catch (err) { crewFail(res, err, { log: 'crew store health error', message: 'Could not check the data store.' }); }
});

// ---- How much room is the VA using? ----
//
// Supabase's free plan stops at half a gigabyte of database, and a project that
// hits the ceiling goes read-only: applications stop saving, PIREPs stop
// filing, and the crew center looks broken for a reason nothing in it explains.
// The number is on Supabase's dashboard — a place VA staff have no account for
// once the owner has finished the setup — so the crew center reports it here,
// with the per-table breakdown that makes it actionable.
//
// Staff-level, not owner-only, unlike the rest of the data-store screen: this
// is a thing to WATCH, and the person watching it is whoever runs the airline
// day to day. It reveals sizes and row counts, never row contents.
app.get('/api/crew/:slug/store/usage', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'settings.notifications');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        if (!crewStore.isConnected(va)) {
            return res.status(409).json({
                error: 'Connect your Supabase project first — there is nothing to measure yet.',
                code: 'store_not_connected',
            });
        }
        const store = new crewStore.SupabaseStore(va);
        const health = await store.health();
        // A project on an older schema has no crew_storage_usage() to call. Say
        // which thing is missing and let the screen offer the update, rather
        // than reporting a broken store over a project that is working fine.
        if (health.ok && health.provisioned && !health.storage) {
            return res.status(409).json({
                error: `Your database is on v${health.version}; the storage report arrived in v${crewStore.STORAGE_SCHEMA_VERSION}. Update your database and this fills in.`,
                code: 'store_storage_unsupported',
                health,
            });
        }

        const usage = await store.storageUsage();
        // What the numbers are being read against. Supabase's own limit is a
        // property of the VA's plan, which we cannot see from here — so this is
        // the free-plan figure, named as an assumption rather than presented as
        // fact, and overridable for a deployment whose VAs are on paid plans.
        const limitBytes = CREW_STORAGE_LIMIT_MB * 1024 * 1024;
        const used = Number(usage.databaseBytes || 0);
        res.set('Cache-Control', 'no-store');
        res.json({
            ...usage,
            limitBytes,
            limitLabel: `${CREW_STORAGE_LIMIT_MB} MB`,
            limitIsAssumed: true,
            percentUsed: limitBytes > 0 ? Math.min(100, Math.round((used / limitBytes) * 1000) / 10) : 0,
            url: va.supabaseUrl || '',
            projectRef: crewSetup.refFromUrl(va.supabaseUrl),
            health,
        });
    } catch (err) { crewFail(res, err, { log: 'crew store usage error', message: 'Could not read your database size.' }); }
});

// The ceiling the storage screen measures against, in MB. Supabase's free plan
// is 500 MB of database; a deployment whose VAs are on paid plans can raise it.
// Only ever a reference line — nothing enforces it, and the screen says so.
const CREW_STORAGE_LIMIT_MB = parseInt(process.env.CREW_STORAGE_LIMIT_MB, 10) || 500;

/* ===========================================================================
 * THE VA'S OWN DATA — what is in it, and getting rid of what they don't want
 *
 * The storage screen has been telling VAs "old flight reports are almost always
 * the biggest thing, export them and remove them" while giving them no way to
 * remove them except one bin at a time. This is that way.
 *
 * Owner only, deliberately. Every dataset here is one a staff role can already
 * edit row by row — but "delete four years of flight reports" is not the same
 * decision as "delete this flight report", and it is not one to hand to a
 * capability that was granted for day-to-day work.
 * ========================================================================= */

/** Owner (or Inflight) on the right crew center. The gate every route here uses. */
function requireCrewOwner(req, slug, what) {
    const p = verifyCrewRequest(req);
    if (!p) return { status: 401, error: 'Not authenticated.' };
    if (!(p.kind === 'inflight' || p.role === 'owner')) {
        return { status: 403, error: `Only the VA owner can ${what}.` };
    }
    if (p.kind !== 'inflight' && p.slug && p.slug !== String(slug).toLowerCase()) {
        return { status: 403, error: 'Wrong crew center.' };
    }
    return { p };
}

// How old a purge can be asked to reach. Anything under a week is almost
// certainly a mistyped number rather than an intention, and "older than 0 days"
// is a wipe wearing a purge's clothes — that has its own, confirmed route.
const PURGE_MIN_DAYS = 7;

// What's in the VA's data, dataset by dataset, and how much of it a purge at the
// requested age would take. Read-only: this is the screen that lets somebody
// decide, and it must be safe to open.
app.get('/api/crew/:slug/data', async (req, res) => {
    const gate = requireCrewOwner(req, req.params.slug, 'manage the crew center’s data');
    if (gate.status) return res.status(gate.status).json({ error: gate.error });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const days = Math.max(0, parseInt(req.query.olderThanDays, 10) || 0);
        const before = days ? new Date(Date.now() - days * 86400000).toISOString() : null;

        // One dataset failing must not blank the whole screen — a project on an
        // older schema simply has no crew_events table, and the honest answer
        // for that row is "not in this database", not a 500 for the other four.
        const datasets = await Promise.all(Object.entries(crewStore.PURGE_DATASETS).map(async ([id, set]) => {
            const base = { id, label: set.label, dateColumn: set.dateColumn };
            try {
                const total = await store.countPurgeable(id, {});
                const matching = before ? await store.countPurgeable(id, { before }) : total;
                return {
                    ...base,
                    total: total.count,
                    totalCapped: !!total.capped,
                    matching: matching.count,
                    matchingCapped: !!matching.capped,
                    unsupported: !!total.unsupported,
                };
            } catch (err) {
                return { ...base, total: 0, matching: 0, unavailable: true, reason: err.message || '' };
            }
        }));

        res.set('Cache-Control', 'no-store');
        res.json({ datasets, olderThanDays: days, before, minDays: PURGE_MIN_DAYS, storeKind: store.kind });
    } catch (err) { crewFail(res, err, { log: 'crew data summary error', message: 'Could not read what is in your data.' }); }
});

// Delete part of a dataset by age, or all of it.
//
// A wipe (`all: true`) must name the dataset back to us in `confirm`. That is
// not ceremony: the by-age path and the wipe path differ by one field, and a
// client bug that dropped `olderThanDays` would otherwise silently become
// "delete everything".
app.post('/api/crew/:slug/data/:dataset/purge', async (req, res) => {
    const gate = requireCrewOwner(req, req.params.slug, 'delete data in bulk');
    if (gate.status) return res.status(gate.status).json({ error: gate.error });

    const dataset = String(req.params.dataset || '');
    const set = crewStore.PURGE_DATASETS[dataset];
    if (!set) return res.status(400).json({ error: 'Unknown dataset.', code: 'unknown_dataset' });

    const all = req.body && req.body.all === true;
    const days = Math.max(0, parseInt(req.body && req.body.olderThanDays, 10) || 0);

    if (all) {
        const confirm = String((req.body && req.body.confirm) || '');
        if (confirm !== dataset) {
            return res.status(400).json({
                error: `Type “${dataset}” to confirm deleting all of it.`,
                code: 'confirm_required',
            });
        }
    } else if (days < PURGE_MIN_DAYS) {
        return res.status(400).json({
            error: `Pick an age of at least ${PURGE_MIN_DAYS} days, or choose to delete all of it.`,
            code: 'purge_window_too_small',
        });
    }

    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const before = all ? null : new Date(Date.now() - days * 86400000).toISOString();
        const out = await store.purge(dataset, { before });

        console.log(`crew data purge: ${req.params.slug} ${dataset} ${all ? 'ALL' : `older than ${days}d`} -> ${out.deleted} row(s)`);
        res.json({
            ...out,
            label: set.label,
            olderThanDays: all ? 0 : days,
            all,
        });
    } catch (err) { crewFail(res, err, { log: 'crew data purge error', message: 'Could not delete that data.' }); }
});

// Move a VA's remaining managed data into their own project. Owner (or
// Inflight) only — this is the one-way door out of our storage.
//
// Idempotent by construction: it copies in dependency order (members and routes
// first, so a PIREP can point at the ids they were given), and skips anything
// already present on the far side. Nothing is deleted from managed storage here
// — the VA verifies the copy first, then calls DELETE to release it.
app.post('/api/crew/:slug/store/migrate', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    if (!(p.kind === 'inflight' || p.role === 'owner')) {
        return res.status(403).json({ error: 'Only the VA owner can migrate the data store.' });
    }
    if (p.kind !== 'inflight' && p.slug && p.slug !== String(req.params.slug).toLowerCase()) {
        return res.status(403).json({ error: 'Wrong crew center.' });
    }
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        if (!crewStore.isConnected(va)) {
            return res.status(409).json({
                error: 'Connect your Supabase project first (Settings → Data store), then run the migration.',
                code: 'store_not_connected',
            });
        }
        const target = new crewStore.SupabaseStore(va);
        const health = await target.health();
        if (!health.provisioned) {
            return res.status(409).json({
                error: 'Your project is reachable but the crew center tables are missing. Run supabase/crew-center-schema.sql in the Supabase SQL editor first.',
                code: 'store_schema_missing', health,
            });
        }

        const source = new crewStore.LegacyStore(va);
        const moved = { members: 0, routes: 0, pireps: 0, applications: 0, accounts: 0, skipped: 0 };

        // 1) Roster. Keyed on callsign+name so a re-run doesn't duplicate.
        const existingMembers = await target.listMembers({ limit: 5000 });
        const memberKey = (m) => `${String(m.callsign || '').toLowerCase()}|${String(m.name || '').toLowerCase()}`;
        const seenMembers = new Map(existingMembers.map((m) => [memberKey(m), m._id]));
        const idMap = new Map();   // old Mongo _id -> new uuid
        for (const m of await source.listMembers({ limit: 5000 })) {
            const key = memberKey(m);
            if (seenMembers.has(key)) { idMap.set(String(m._id), seenMembers.get(key)); moved.skipped++; continue; }
            const created = await target.createMember(m);
            idMap.set(String(m._id), created._id);
            seenMembers.set(key, created._id);
            moved.members++;
        }

        // 2) Routes. Keyed on flight number + city pair.
        const existingRoutes = await target.listRoutes({ limit: 5000 });
        const routeKey = (r) => `${String(r.flightNumber || '').toLowerCase()}|${r.origin}|${r.destination}`;
        const seenRoutes = new Map(existingRoutes.map((r) => [routeKey(r), r._id]));
        const routeMap = new Map();
        for (const r of await source.listRoutes({ limit: 5000 })) {
            const key = routeKey(r);
            if (seenRoutes.has(key)) { routeMap.set(String(r._id), seenRoutes.get(key)); moved.skipped++; continue; }
            const created = await target.createRoute(r);
            routeMap.set(String(r._id), created._id);
            seenRoutes.set(key, created._id);
            moved.routes++;
        }

        // 3) Flight reports, re-pointed at the ids the roster and network just
        // got. A report whose pilot didn't come across keeps its denormalised
        // name and simply loses the link.
        const legacyPireps = await source.listPireps({ limit: 20000 });
        const seenFlights = await target.seenFlightIds(legacyPireps.map((x) => x.flightId).filter(Boolean));
        for (const x of legacyPireps) {
            if (x.flightId && seenFlights.has(x.flightId)) { moved.skipped++; continue; }
            await target.createPirep({
                ...x,
                memberId: idMap.get(String(x.memberId)) || null,
                routeId: routeMap.get(String(x.routeId)) || null,
            });
            moved.pireps++;
        }

        // 4) Applications, including decided ones — the status links handed to
        // applicants must keep resolving after the move.
        for (const status of ['pending', 'accepted', 'declined']) {
            for (const a of await source.listApplications({ status, limit: 5000 })) {
                if (a.statusToken && await target.getApplicationByToken(a.statusToken)) { moved.skipped++; continue; }
                await target.createApplication(a);
                moved.applications++;
            }
        }

        // 5) Pilot logins. The bcrypt HASH is copied, not the password — nobody
        // has the password, us included — so a pilot's existing credentials keep
        // working against the VA's project with nothing to re-issue and nothing
        // for the pilot to notice. Re-pointed at the roster row that came across
        // above where the names match, so the account and the pilot are linked
        // by id from here on.
        //
        // This step needs a v3 project. An older one is not a failure: the rest
        // of the migration is done and valid, and the VA is told to re-run the
        // SQL and repeat the (idempotent) migration to pick logins up.
        let accountsNote = '';
        try {
            const membersByName = new Map(
                (await target.listMembers({ limit: 5000 }))
                    .map((m) => [String(m.name || '').toLowerCase(), m._id]));
            for (const a of await source.listAccounts({ limit: 5000 })) {
                if (await target.getAccountByUsername(a.username)) { moved.skipped++; continue; }
                await target.createAccount({
                    username: a.username,
                    displayName: a.displayName,
                    passwordHash: a.passwordHash,
                    role: 'pilot',
                    memberId: membersByName.get(String(a.displayName || '').toLowerCase()) || null,
                    active: a.active,
                    mustChangePassword: a.mustChangePassword,
                    createdVia: a.createdVia || 'migrated',
                    createdByName: a.createdByName || '',
                    lastLoginAt: a.lastLoginAt || null,
                });
                moved.accounts++;
            }
        } catch (err) {
            if (err && err.code === 'store_accounts_missing') {
                accountsNote = 'Everything else moved across. Your project is on an older version of the setup SQL, which has no table for pilot logins — re-run it from Settings → Data store, then run this again to bring the logins over.';
            } else throw err;
        }

        _crewStatsCache.delete(String(va.slug || req.params.slug).toLowerCase());
        res.json({ ok: true, moved, accountsNote, stats: await target.stats() });
    } catch (err) { crewFail(res, err, { log: 'crew store migrate error', message: 'Could not migrate the data store.' }); }
});

// Release the managed copy once the VA has verified the migration. Separate
// from the migration itself on purpose: copying is safe and repeatable, and
// deleting is neither, so the VA has to ask for it explicitly.
app.delete('/api/crew/:slug/store/legacy', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    if (!(p.kind === 'inflight' || p.role === 'owner')) {
        return res.status(403).json({ error: 'Only the VA owner can release managed storage.' });
    }
    if (p.kind !== 'inflight' && p.slug && p.slug !== String(req.params.slug).toLowerCase()) {
        return res.status(403).json({ error: 'Wrong crew center.' });
    }
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        if (!crewStore.isConnected(va)) {
            return res.status(409).json({ error: 'No connected project to keep the data in.', code: 'store_not_connected' });
        }
        // Refuse to delete into a void: the VA's own project must hold at least
        // as many pilots and reports as we are about to drop.
        const target = new crewStore.SupabaseStore(va);
        const theirs = await target.stats();
        const ours = {
            members: await CrewMember.countDocuments({ vaAdId: va._id }),
            pireps: await CrewPirep.countDocuments({ vaAdId: va._id }),
            accounts: await VaPortalAccount.countDocuments({ vaAdId: va._id, role: 'pilot' }),
        };
        if (theirs.pilots < ours.members || theirs.pireps < ours.pireps) {
            return res.status(409).json({
                error: 'Your project holds fewer records than managed storage does. Run the migration again and re-check before releasing.',
                code: 'migration_incomplete',
                yours: { pilots: theirs.pilots, pireps: theirs.pireps }, managed: ours,
            });
        }
        // Pilot logins get their own check, against the account table rather
        // than the stats snapshot. Deleting a credential that did not make it
        // across locks a pilot out of their crew center with no way back, so
        // this refuses on a shortfall exactly like the records above do.
        if (ours.accounts) {
            const theirAccounts = (await target.listAccounts({ limit: 5000 }).catch(() => null));
            if (!theirAccounts || theirAccounts.length < ours.accounts) {
                return res.status(409).json({
                    error: 'Your project holds fewer pilot logins than we do. Run the migration again before releasing — deleting a login we still hold would lock that pilot out.',
                    code: 'migration_incomplete',
                    yours: { accounts: theirAccounts ? theirAccounts.length : 0 }, managed: { accounts: ours.accounts },
                });
            }
        }
        const q = { vaAdId: va._id };
        const [pireps, members, routes, applications, accounts] = await Promise.all([
            CrewPirep.deleteMany(q), CrewMember.deleteMany(q), CrewRoute.deleteMany(q), CrewApplication.deleteMany(q),
            // Pilot logins only. The VA's owner and staff accounts are how they
            // administer the partnership with us and stay exactly where they are.
            VaPortalAccount.deleteMany({ ...q, role: 'pilot' }),
        ]);
        crewStore.forgetLegacyData(va._id);   // the "has legacy rows?" probe is now stale
        res.json({
            ok: true,
            deleted: {
                pireps: pireps.deletedCount || 0, members: members.deletedCount || 0,
                routes: routes.deletedCount || 0, applications: applications.deletedCount || 0,
                accounts: accounts.deletedCount || 0,
            },
        });
    } catch (err) { crewFail(res, err, { log: 'crew store release error', message: 'Could not release managed storage.' }); }
});

// ---- Guided Supabase setup ----
//
// The manual path — create a project, find the SQL editor, paste the schema,
// then copy three values out of Settings → API without mixing up which is
// which — is the single biggest thing standing between a new VA and a working
// crew center. These two endpoints do it instead, given one Supabase access
// token.
//
// WHAT HAPPENS TO THE TOKEN. By default the same thing that always happened: it
// is read from the request body, used for the duration of the call, and
// dropped. It is never logged and never echoed back.
//
// The VA can now ask us to keep it — a tick on the setup screen, off unless
// they turn it on, withdrawable from the same screen. That is not a change of
// heart about how dangerous a personal access token is (it is not scoped to one
// project; it can do anything to the account that issued it) but an answer to a
// problem the "never store it" rule created: every release that adds a column
// leaves every existing VA's project behind, and catching up meant a trip back
// to supabase.com for a fresh token. Nobody made that trip. Their projects sat
// on old schemas and their saves quietly dropped fields.
//
// So a kept token is sealed with AES-256-GCM under a key from the environment
// (crewSecrets), is used for exactly one thing — running OUR schema file
// against the project this VA is already connected to — and is deleted the
// moment they ask. With no encryption key configured the offer is not made and
// nothing is kept.

// Owner (or Inflight) gate, shared by the setup routes. Connecting a data store
// is deliberately not delegable to staff: it is the VA's data and their
// Supabase account.
function crewOwnerGate(req, slug) {
    const p = verifyCrewRequest(req);
    if (!p) return { error: 401, message: 'Not authenticated.' };
    if (!(p.kind === 'inflight' || p.role === 'owner')) {
        return { error: 403, message: 'Only the VA owner can set up the data store.' };
    }
    if (p.kind !== 'inflight' && p.slug && p.slug !== String(slug || '').toLowerCase()) {
        return { error: 403, message: 'Wrong crew center.' };
    }
    return { p };
}

// ---------------------------------------------------------------------------
// The kept access token
//
// Everything that reads, writes or forgets one goes through here, so there is
// one place that knows a token is sealed, one place that decides when to stop
// trusting a stored one, and no handler that has to remember either.
// ---------------------------------------------------------------------------

// Non-secret fields the data-store screens need. Deliberately without
// +supabaseAccessToken: the state of the token is not the token, and the only
// two places that want the value itself ask for it explicitly below.
const CREW_TOKEN_META = 'supabaseTokenHint supabaseTokenSavedAt supabaseTokenUsedAt '
    + 'supabaseTokenFailedAt supabaseTokenError supabaseAutoUpdate supabaseAutoUpdatedAt supabaseAutoUpdatedTo';

/**
 * What the dashboard is told about a saved token: that there is one, which one,
 * when, and whether it last worked. Never the token.
 */
function tokenState(ad) {
    const savedAt = ad && ad.supabaseTokenSavedAt ? ad.supabaseTokenSavedAt : null;
    const saved = !!savedAt;
    return {
        saved,
        hint: saved ? (ad.supabaseTokenHint || '') : '',
        savedAt,
        lastUsedAt: (ad && ad.supabaseTokenUsedAt) || null,
        // A stored token Supabase has since refused. Kept rather than deleted so
        // the screen can say "the one you saved in March stopped working"
        // instead of silently reverting to asking for a token with no
        // explanation of where the last one went.
        failed: !!(ad && ad.supabaseTokenFailedAt),
        failedAt: (ad && ad.supabaseTokenFailedAt) || null,
        error: (ad && ad.supabaseTokenError) || '',
        autoUpdate: saved && ad.supabaseAutoUpdate !== false,
        autoUpdatedAt: (ad && ad.supabaseAutoUpdatedAt) || null,
        autoUpdatedTo: (ad && ad.supabaseAutoUpdatedTo) || 0,
        // Can this deployment keep one at all? When false the dashboard hides
        // the offer rather than showing a tick that silently does nothing.
        canSave: crewSecrets.available(),
        unavailableReason: crewSecrets.unavailableReason(),
    };
}

/** The stored token in the clear, or '' — for a wrong key as much as for none. */
async function readAccessToken(vaId) {
    const ad = await VirtualAirlineAd.findById(vaId).select('+supabaseAccessToken').lean();
    if (!ad || !ad.supabaseAccessToken) return '';
    return crewSecrets.open(ad.supabaseAccessToken);
}

/**
 * The token this request should use: the one pasted, or failing that the one
 * the VA saved. In that order deliberately — a VA who has just pasted a token
 * is correcting something, and the fresh one is the one they mean.
 */
async function requestAccessToken(req, va) {
    const given = String(req.body?.accessToken || '').trim();
    if (given) return { token: given, source: 'request' };
    const stored = va ? await readAccessToken(va._id) : '';
    return stored ? { token: stored, source: 'stored' } : { token: '', source: '' };
}

/**
 * Keep a token, or refuse to.
 *
 * Refusing is a real outcome, not an error: with no encryption key configured
 * we will not write an account-wide credential in the clear, and the caller
 * carries on having done the thing the VA actually asked for (the setup, the
 * update) while telling them the remembering part did not happen.
 */
async function storeAccessToken(vaId, token, { autoUpdate } = {}) {
    const sealed = crewSecrets.seal(token);
    if (!sealed) return { saved: false, reason: crewSecrets.unavailableReason() };
    await VirtualAirlineAd.updateOne({ _id: vaId }, {
        $set: {
            supabaseAccessToken: sealed,
            supabaseTokenHint: crewSecrets.hint(token),
            supabaseTokenSavedAt: new Date(),
            supabaseTokenFailedAt: null,
            supabaseTokenError: '',
            ...(autoUpdate === undefined ? {} : { supabaseAutoUpdate: !!autoUpdate }),
        },
    });
    return { saved: true, hint: crewSecrets.hint(token) };
}

/** Forget it. The VA still has to revoke it in Supabase; the screen says so. */
async function clearAccessToken(vaId) {
    await VirtualAirlineAd.updateOne({ _id: vaId }, {
        $set: {
            supabaseAccessToken: '', supabaseTokenHint: '', supabaseTokenSavedAt: null,
            supabaseTokenUsedAt: null, supabaseTokenFailedAt: null, supabaseTokenError: '',
        },
    });
}

const markTokenUsed = (vaId) => VirtualAirlineAd.updateOne({ _id: vaId },
    { $set: { supabaseTokenUsedAt: new Date(), supabaseTokenFailedAt: null, supabaseTokenError: '' } }).catch(() => {});

// Supabase said no. The token stays put — deleting it would lose the hint that
// explains what went wrong — but it is marked, and the automatic updater skips
// a marked one until a human replaces it.
const markTokenFailed = (vaId, message) => VirtualAirlineAd.updateOne({ _id: vaId },
    { $set: { supabaseTokenFailedAt: new Date(), supabaseTokenError: String(message || '').slice(0, 300) } }).catch(() => {});

/**
 * Bring a VA's project up to the current schema, unasked, using their kept
 * token.
 *
 * THE POINT OF IT. A release that adds a column has, until now, produced a
 * silent fleet of VAs whose projects cannot hold it. Each of them finds out
 * separately, later, through a save that did less than it said. This closes
 * that window: the first time we notice a project is behind and we hold a token
 * the VA gave us for this purpose, we run the same idempotent script the button
 * runs. It only ever adds, so it cannot undo an earlier fix.
 *
 * Bounded on purpose:
 *   * only when a token was saved AND auto-update is on,
 *   * never for a token Supabase has already refused,
 *   * once per VA per AUTO_UPDATE_COOLDOWN_MS, even across failures,
 *   * one at a time per VA (a second request finds the guard set and moves on).
 *
 * Returns quietly. The caller re-reads health afterwards if it cares — nothing
 * here is allowed to turn a page load into an error.
 */
const AUTO_UPDATE_COOLDOWN_MS = 30 * 60 * 1000;
const _autoUpdateSeen = new Map();          // vaId -> last attempt (ms)

async function autoUpdateStore(va, health) {
    if (!va || !health || !health.ok || !health.provisioned || !health.outdated) return null;
    const id = String(va._id);
    const last = _autoUpdateSeen.get(id) || 0;
    if (Date.now() - last < AUTO_UPDATE_COOLDOWN_MS) return null;
    _autoUpdateSeen.set(id, Date.now());     // set BEFORE the work, so a second
                                             // request during it does not stack

    const ad = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META + ' +supabaseAccessToken').lean();
    if (!ad || !ad.supabaseAccessToken || ad.supabaseAutoUpdate === false || ad.supabaseTokenFailedAt) return null;
    const accessToken = crewSecrets.open(ad.supabaseAccessToken);
    if (!accessToken) return null;           // key rotated — the VA re-saves one

    const ref = crewSetup.refFromUrl(va.supabaseUrl);
    if (!ref) return null;

    try {
        await crewSetup.updateSchema({ accessToken, ref, sql: readSetupSql() });
        crewStore.forgetSchemaDrift(va.supabaseUrl);
        _crewStatsCache.delete(String(va.slug || '').toLowerCase());
        await VirtualAirlineAd.updateOne({ _id: va._id }, {
            $set: {
                supabaseTokenUsedAt: new Date(),
                supabaseAutoUpdatedAt: new Date(),
                supabaseAutoUpdatedTo: crewStore.EXPECTED_SCHEMA_VERSION,
                supabaseTokenFailedAt: null, supabaseTokenError: '',
            },
        });
        console.log(`crew store auto-update: ${va.slug} -> v${crewStore.EXPECTED_SCHEMA_VERSION}`);
        return { ran: true, version: crewStore.EXPECTED_SCHEMA_VERSION };
    } catch (err) {
        const code = (err && err.code) || '';
        // A token that no longer opens the account is the VA's to replace; a
        // project that is paused, or Supabase having a bad minute, is not the
        // token's fault and must not condemn it.
        if (code === 'bad_token' || code === 'project_not_found') {
            await markTokenFailed(va._id, err.message);
        }
        console.warn(`crew store auto-update failed (${va.slug}):`, err && err.message ? err.message : err);
        return { ran: false, error: err && err.message ? err.message : 'Update failed.' };
    }
}

function setupFail(res, err, log) {
    if (err instanceof crewSetup.SetupError) {
        if (err.detail) console.warn(`crew setup [${err.code}]:`, err.detail);
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof crewStore.CrewStoreError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(`${log}:`, err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Setup could not be completed.' });
}

// What the VA can see with the token they just pasted: their projects, and the
// organizations a new project could go in. POST, not GET, so the token travels
// in a body rather than in a URL that would land in every access log between
// here and there.
app.post('/api/crew/:slug/store/projects', async (req, res) => {
    const gate = crewOwnerGate(req, req.params.slug);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    try {
        // A VA who kept a token does not have to fetch a new one to move to a
        // different project, which is most of the reason they kept it.
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const { token: accessToken, source } = await requestAccessToken(req, va);
        if (!accessToken) return res.status(400).json({ error: 'Paste a Supabase access token first.', code: 'no_token' });
        const mgmt = new crewSetup.Management(accessToken);
        // Organizations are a nice-to-have (they only matter for creating a new
        // project); a token that cannot list them still lists projects fine.
        const [projects, organizations] = await Promise.all([
            mgmt.listProjects(),
            mgmt.listOrganizations().catch(() => []),
        ]);
        if (source === 'stored') markTokenUsed(va._id);
        res.set('Cache-Control', 'no-store');
        res.json({
            projects: (Array.isArray(projects) ? projects : []).map(crewSetup.publicProject),
            organizations: (Array.isArray(organizations) ? organizations : [])
                .map((o) => ({ id: o.id || o.slug || '', name: o.name || '' })).filter((o) => o.id),
            regions: CREW_SUPABASE_REGIONS,
            usedSavedToken: source === 'stored',
        });
    } catch (err) { setupFail(res, err, 'crew setup projects error'); }
});

// Regions offered when we create a project for a VA. Supabase has more; this is
// a short, geographically spread list, because a VA picking where their
// database lives wants "near my pilots", not a catalogue.
const CREW_SUPABASE_REGIONS = [
    { id: 'us-east-1',      label: 'United States · East' },
    { id: 'us-west-1',      label: 'United States · West' },
    { id: 'ca-central-1',   label: 'Canada' },
    { id: 'eu-west-2',      label: 'United Kingdom' },
    { id: 'eu-central-1',   label: 'Europe · Frankfurt' },
    { id: 'ap-south-1',     label: 'India · Mumbai' },
    { id: 'ap-southeast-1', label: 'Singapore' },
    { id: 'ap-northeast-1', label: 'Japan · Tokyo' },
    { id: 'ap-southeast-2', label: 'Australia · Sydney' },
    { id: 'sa-east-1',      label: 'Brazil · São Paulo' },
];

// Do the setup: install the schema into the chosen project, read its keys back,
// store the connection and verify it over the path real writes take.
//
// Resumable rather than long-running. Creating a Supabase project takes a
// minute or two, so when the project is not up yet this answers
// { ready: false, projectRef } and the dashboard polls with the same token and
// ref until it is. Every stage is safe to repeat.
app.post('/api/crew/:slug/store/provision', async (req, res) => {
    const gate = crewOwnerGate(req, req.params.slug);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const slug = String(va.slug || req.params.slug).toLowerCase();
        const { token: accessToken, source } = await requestAccessToken(req, va);
        if (!accessToken) return res.status(400).json({ error: 'Paste a Supabase access token first.', code: 'no_token' });
        // Remembering is opt-in and asked for per request. A polling call in the
        // middle of a provisioning wait carries the same flag, so the answer
        // does not depend on which poll happened to be the one that finished.
        const remember = req.body?.remember === true || req.body?.remember === 'true';

        const create = req.body?.create ? {
            name: String(req.body.create.name || `${slug}-crew-center`).slice(0, 60),
            organizationId: String(req.body.create.organizationId || ''),
            region: CREW_SUPABASE_REGIONS.some((r) => r.id === req.body.create.region)
                ? req.body.create.region : 'us-east-1',
        } : null;

        const out = await crewSetup.provision({
            accessToken,
            projectRef: String(req.body?.projectRef || '').trim(),
            create,
            sql: readSetupSql(),
            // Store what setup produced. The service key is written to the
            // select:false field and, as everywhere else, never comes back out
            // to a browser — the reply below reports only that we have one.
            save: async ({ url, anonKey, serviceKey }) => {
                const ad = await VirtualAirlineAd.findById(va._id).select('+supabaseServiceKey');
                if (!ad) throw new crewSetup.SetupError('Crew center not found.', { status: 404, code: 'va_not_found' });
                ad.supabaseUrl = url;
                if (anonKey) ad.supabaseAnonKey = anonKey;
                ad.supabaseServiceKey = serviceKey;
                await ad.save();
            },
            verify: ({ url, serviceKey }) => new crewStore.SupabaseStore({
                slug, supabaseUrl: url, supabaseServiceKey: serviceKey,
            }).health(),
        });

        // A VA that had been on managed storage is now on their own project, so
        // the cached "does this VA have legacy rows?" answer is stale.
        crewStore.forgetLegacyData(va._id);
        // The schema we just ran is the current one, so whatever we had learned
        // about this project's missing columns is now wrong. Clearing it here
        // means the first write after a setup carries the full row again.
        crewStore.forgetSchemaDrift(out && out.url);
        _crewStatsCache.delete(slug);

        // Keep the token only once the setup it was pasted for has actually
        // finished. A token saved against a half-provisioned project would be a
        // credential held for a connection that never came up.
        let keptToken = null;
        if (out && out.ready) {
            if (remember) keptToken = await storeAccessToken(va._id, accessToken, { autoUpdate: true });
            else if (source === 'stored') markTokenUsed(va._id);
        }
        const meta = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META).lean();

        res.set('Cache-Control', 'no-store');
        res.json({
            ...out,
            projectRef: out.project ? out.project.ref : '',
            connected: !!out.ready,
            hasServiceKey: !!out.ready,
            usedSavedToken: source === 'stored',
            // Whether the "remember this" tick took effect, and if not, why —
            // a silent no would leave the VA believing they never have to paste
            // a token again.
            tokenSaved: !!(keptToken && keptToken.saved),
            tokenSaveError: keptToken && !keptToken.saved ? keptToken.reason : '',
            token: tokenState(meta),
        });
    } catch (err) { setupFail(res, err, 'crew setup provision error'); }
});

// Push the current schema to a project that is ALREADY connected.
//
// WHY THIS IS A SEPARATE THING FROM SETUP
// ---------------------------------------
// A VA sets their database up once. The code then keeps moving — v4 gave
// applications an invitation, v5 split the network into own and codeshare and
// gated routes on rank — and every one of those releases added columns the VA's
// project has never heard of. Until now the only way to catch up was to walk
// the whole setup wizard again, which reads as "connect a database" to someone
// who already has one, so nobody did it, and the first they heard about the gap
// was a write failing.
//
// This is that upgrade as its own action: same token, same idempotent script,
// no project picking and no keys touched. The connection the VA already has
// keeps working throughout — the script only ever adds.
//
// The token comes from the request, or from the one the VA chose to keep. A VA
// with a kept token presses one button here and pastes nothing; one without is
// exactly where they were. Either way the token is used only to run our own
// script against the project this crew center is already connected to.
app.post('/api/crew/:slug/store/upgrade', async (req, res) => {
    const gate = crewOwnerGate(req, req.params.slug);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        if (!crewStore.isConnected(va)) {
            return res.status(409).json({
                error: 'Connect a Supabase project first — there is nothing to update yet.',
                code: 'store_not_connected',
            });
        }
        const { token: accessToken, source } = await requestAccessToken(req, va);
        if (!accessToken) {
            return res.status(400).json({
                error: 'Paste a Supabase access token first.',
                code: 'no_token',
            });
        }
        const remember = req.body?.remember === true || req.body?.remember === 'true';
        // The project to run against is the one we are already talking to, read
        // from the stored URL rather than taken from the request: this endpoint
        // updates THIS crew center's database and must not be steerable into
        // running our DDL against some other project on the account.
        const ref = crewSetup.refFromUrl(va.supabaseUrl);
        if (!ref) {
            return res.status(409).json({
                error: 'Your stored project URL doesn’t look like a Supabase project. Re-connect it under “Set up automatically”.',
                code: 'bad_project_url',
            });
        }

        let project;
        try {
            // Fails with a clear message if the token belongs to a different
            // Supabase account than the project does — the single likeliest
            // thing to go wrong here, since the VA made that token months after
            // setup (or, with a kept one, revoked it since).
            ({ project } = await crewSetup.updateSchema({ accessToken, ref, sql: readSetupSql() }));
        } catch (err) {
            // A kept token that Supabase has refused gets marked, so the screen
            // says which token stopped working and the automatic updater stops
            // trying it. A pasted one is the VA's problem in the moment and
            // needs no bookkeeping.
            if (source === 'stored' && (err.code === 'bad_token' || err.code === 'project_not_found')) {
                await markTokenFailed(va._id, err.message);
            }
            throw err;
        }

        // The columns are there now, so stop leaving them out of writes.
        crewStore.forgetSchemaDrift(va.supabaseUrl);
        _crewStatsCache.delete(String(va.slug || req.params.slug).toLowerCase());

        let keptToken = null;
        if (remember && source === 'request') keptToken = await storeAccessToken(va._id, accessToken, { autoUpdate: true });
        else if (source === 'stored') markTokenUsed(va._id);
        const meta = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META).lean();

        // Report the version the project now answers with, over the same path
        // real writes take — "we ran the script" is not the same claim as "your
        // database is now on v5", and only the second one is worth showing.
        const health = await (await crewStore.forVa(va)).health();
        res.set('Cache-Control', 'no-store');
        res.json({
            ok: true,
            project,
            health,
            schemaVersion: crewStore.EXPECTED_SCHEMA_VERSION,
            usedSavedToken: source === 'stored',
            tokenSaved: !!(keptToken && keptToken.saved),
            tokenSaveError: keptToken && !keptToken.saved ? keptToken.reason : '',
            token: tokenState(meta),
        });
    } catch (err) { setupFail(res, err, 'crew store upgrade error'); }
});

// ---- The kept token, on its own ----
//
// Save one without doing anything else (a VA who set up before this existed, or
// whose old one has been revoked), and throw one away. Both owner-only, like
// every other data-store action.
//
// Saving VERIFIES first. A token that does not open the project this crew
// center is connected to is refused rather than stored, because the failure it
// would otherwise cause arrives weeks later, in an automatic update nobody is
// watching, and would look like the update feature being broken.
app.post('/api/crew/:slug/store/token', async (req, res) => {
    const gate = crewOwnerGate(req, req.params.slug);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    const accessToken = String(req.body?.accessToken || '').trim();
    const hasAuto = req.body?.autoUpdate !== undefined;
    const autoUpdate = req.body?.autoUpdate === true || req.body?.autoUpdate === 'true';

    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });

        // Just flipping the automatic-update switch on a token we already hold.
        if (!accessToken && hasAuto) {
            const existing = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META + ' +supabaseAccessToken').lean();
            if (!existing || !existing.supabaseAccessToken) {
                return res.status(409).json({ error: 'There is no saved token to change.', code: 'no_saved_token' });
            }
            await VirtualAirlineAd.updateOne({ _id: va._id }, { $set: { supabaseAutoUpdate: autoUpdate } });
            const meta = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META).lean();
            res.set('Cache-Control', 'no-store');
            return res.json({ ok: true, token: tokenState(meta) });
        }

        if (!accessToken) return res.status(400).json({ error: 'Paste a Supabase access token first.', code: 'no_token' });
        if (!crewSecrets.available()) {
            return res.status(503).json({ error: crewSecrets.unavailableReason(), code: 'sealing_unavailable' });
        }
        if (!crewStore.isConnected(va)) {
            return res.status(409).json({
                error: 'Connect a Supabase project first — a saved token has nothing to act on yet.',
                code: 'store_not_connected',
            });
        }
        const ref = crewSetup.refFromUrl(va.supabaseUrl);
        if (!ref) {
            return res.status(409).json({
                error: 'Your stored project URL doesn’t look like a Supabase project. Re-connect it under “Set it up for me”.',
                code: 'bad_project_url',
            });
        }
        // Throws bad_token for a revoked one and project_not_found for a token
        // from a different Supabase account, which are different mistakes with
        // different fixes.
        await crewSetup.checkAccess(accessToken, ref);

        const saved = await storeAccessToken(va._id, accessToken, { autoUpdate: hasAuto ? autoUpdate : true });
        if (!saved.saved) return res.status(503).json({ error: saved.reason, code: 'sealing_unavailable' });
        const meta = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META).lean();
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true, token: tokenState(meta) });
    } catch (err) { setupFail(res, err, 'crew store token save error'); }
});

// Forget it. Deleting our copy is all we can do — the token still exists in the
// VA's Supabase account until they revoke it there, and the reply says so
// rather than letting "forgotten" be mistaken for "revoked".
app.delete('/api/crew/:slug/store/token', async (req, res) => {
    const gate = crewOwnerGate(req, req.params.slug);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        await clearAccessToken(va._id);
        const meta = await VirtualAirlineAd.findById(va._id).select(CREW_TOKEN_META).lean();
        res.set('Cache-Control', 'no-store');
        res.json({
            ok: true,
            token: tokenState(meta),
            revokeUrl: 'https://supabase.com/dashboard/account/tokens',
        });
    } catch (err) { setupFail(res, err, 'crew store token delete error'); }
});

// ---- Pilot logins ----
// Every one of these reads and writes the VA's OWN store (crew_accounts in
// their project), so a pilot's credentials never exist on our side. Passwords
// are never returned except the one time they are generated.

// Staff: the VA's pilot logins. Never a hash — publicAccount is the only shape
// that leaves this file.
app.get('/api/crew/:slug/accounts', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const accounts = await store.listAccounts();
        res.set('Cache-Control', 'no-store');
        res.json({ accounts: accounts.map(crewAccounts.publicAccount) });
    } catch (err) { crewFail(res, err, { log: 'crew accounts list error', message: 'Could not load pilot logins.' }); }
});

// Staff: create a login for a pilot already on the roster — the counterpart to
// ticking "create an account" while accepting someone.
app.post('/api/crew/:slug/accounts', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { va, store } = await resolveCrewStore(req.params.slug);
        const memberId = String(req.body?.memberId || '').trim();
        const member = memberId ? await store.getMember(memberId) : null;
        if (memberId && !member) return res.status(404).json({ error: 'That pilot is not on the roster.' });
        const displayName = String(req.body?.displayName || (member && member.name) || '').trim();
        if (!displayName) return res.status(400).json({ error: 'Which pilot is this login for?' });

        const r = await crewAccounts.provisionPilotAccount(store, {
            displayName,
            memberId: member ? member._id : null,
            email: String(req.body?.email || '').trim(),
            createdByName: gate.p?.name || 'Crew Center',
            vaName: va.name || '',
        });
        // The password is here once and nowhere else, exactly as when a pilot is
        // accepted. `created: false` means they already had a login and this
        // reply carries no password to show.
        res.status(r.created ? 201 : 200).json({
            account: crewAccounts.publicAccount(r.account),
            created: r.created,
            username: r.username,
            password: r.password,
        });
    } catch (err) { crewFail(res, err, { log: 'crew account create error', message: 'Could not create the login.' }); }
});

// Staff: suspend or restore a login. Deactivating is how you take someone's
// access away without deleting the account and its history.
app.patch('/api/crew/:slug/accounts/:id', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        if (req.body?.active === undefined) return res.status(400).json({ error: 'Nothing to change.' });
        const account = await store.updateAccount(req.params.id, { active: !!req.body.active });
        if (!account) return res.status(404).json({ error: 'Login not found.' });
        res.json({ account: crewAccounts.publicAccount(account) });
    } catch (err) { crewFail(res, err, { log: 'crew account update error', message: 'Could not update the login.' }); }
});

// Staff: mint a new password for a pilot who has lost theirs. There is no
// recovery — nothing anywhere holds the old one — so a reset is the only route
// back in, and the new password is shown once.
app.post('/api/crew/:slug/accounts/:id/reset-password', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'roster.manage');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const out = await crewAccounts.resetPassword(store, req.params.id);
        if (!out) return res.status(404).json({ error: 'Login not found.' });
        res.json({ username: out.username, password: out.password });
    } catch (err) { crewFail(res, err, { log: 'crew account reset error', message: 'Could not reset the password.' }); }
});

// A pilot changing their own password — which every pilot must, since the one
// they were given was generated for them. Requires the current password: a live
// session is not proof enough to replace the credential that recovers it.
app.post('/api/crew/:slug/account/password', async (req, res) => {
    const p = verifyCrewRequest(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated.' });
    // Only accounts that live in the VA's store. An owner/staff/Inflight login
    // is a central account and changes its password through the partnership
    // portal, which is where it lives.
    if (p.kind !== 'crew') {
        return res.status(400).json({ error: 'Change this account’s password in the partnership portal.', code: 'not_a_crew_account' });
    }
    if (p.slug && p.slug !== String(req.params.slug).toLowerCase()) {
        return res.status(403).json({ error: 'Wrong crew center.' });
    }
    try {
        const { store } = await resolveCrewStore(req.params.slug);
        const out = await crewAccounts.changePassword(store, p.sub, req.body?.currentPassword, req.body?.newPassword);
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json({ ok: true });
    } catch (err) { crewFail(res, err, { log: 'crew password change error', message: 'Could not change the password.' }); }
});

// Staff: read the crew webhook state (never the secret URL itself, just a hint).
app.get('/api/crew/:slug/webhook', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'settings.notifications');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const doc = await VirtualAirlineAd.findById(va._id).select('+crewWebhookUrl +crewWebhooks').lean();
        const hooks = (doc && doc.crewWebhooks) || {};
        res.set('Cache-Control', 'no-store');
        res.json({
            configured: !!(doc && doc.crewWebhookUrl),
            hint: maskWebhookUrl(doc && doc.crewWebhookUrl),
            // Per-feed state. `usingDefault` is the bit that matters in the UI:
            // it says "this feed is going to your main channel" rather than
            // leaving a blank box that looks like nothing is configured.
            feeds: CREW_FEEDS.reduce((acc, feed) => {
                const url = hooks[feed] || '';
                acc[feed] = {
                    configured: !!url,
                    hint: maskWebhookUrl(url),
                    usingDefault: !url && !!(doc && doc.crewWebhookUrl),
                };
                return acc;
            }, {}),
        });
    } catch (err) { console.error('crew webhook get error:', err); res.status(500).json({ error: 'Could not load the webhook.' }); }
});
// Staff: set / clear ('' clears) / test the crew Discord webhook.
app.post('/api/crew/:slug/webhook', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'settings.notifications');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const ad = await VirtualAirlineAd.findById(va._id).select('+crewWebhookUrl +crewWebhooks name callsign');
        if (!ad) return res.status(404).json({ error: 'Crew center not found.' });
        const b = req.body || {};
        // Which feed is being configured. Absent means the main webhook, which
        // is what every existing caller sends — so the old request shape keeps
        // working untouched.
        const feed = CREW_FEEDS.includes(b.feed) ? b.feed : '';

        if (b.webhookUrl !== undefined) {
            const raw = String(b.webhookUrl || '').trim();
            if (raw && !isDiscordWebhookUrl(raw)) {
                return res.status(400).json({ error: 'That doesn’t look like a Discord webhook URL (https://discord.com/api/webhooks/…).' });
            }
            if (feed) {
                if (!ad.crewWebhooks) ad.crewWebhooks = {};
                // '' clears the override, which puts the feed back on the main
                // channel rather than switching it off — that is what a VA
                // emptying the box means, and silently muting a feed instead
                // would be a very quiet way to lose notifications.
                ad.crewWebhooks[feed] = raw;
                ad.markModified('crewWebhooks');
            } else {
                ad.crewWebhookUrl = raw || null;
            }
            await ad.save();
        }

        if (b.test) {
            // Test what this feed would actually use, fallback included — the
            // question a VA is asking is "will my messages arrive", not "is
            // this box full".
            const target = feed
                ? ((ad.crewWebhooks && ad.crewWebhooks[feed]) || ad.crewWebhookUrl)
                : ad.crewWebhookUrl;
            if (!target) return res.status(400).json({ error: 'Add a webhook URL first.' });
            const blurb = {
                recruitment: 'New applications, and accept / decline decisions, will show up here.',
                pireps: 'Flight reports — filed, approved and rejected — and pilot promotions will show up here.',
                routes: 'Route network changes will show up here.',
                events: 'Events published, changed and cancelled will show up here. Signups will not — a busy event would fire dozens of them in an evening.',
            }[feed] || 'Your Crew Center is connected. New applications and accept / decline decisions will show up here.';
            const ok = await postCrewNotice(target, {
                title: `🔔 ${ad.name || 'Crew Center'} — test message`,
                description: blurb,
                color: CREW_COLORS.new,
            });
            if (!ok) return res.status(502).json({ error: 'We couldn’t deliver a message to that webhook. Double-check the URL.' });
        }

        const hooks = ad.crewWebhooks || {};
        res.set('Cache-Control', 'no-store');
        res.json({
            configured: !!ad.crewWebhookUrl,
            hint: maskWebhookUrl(ad.crewWebhookUrl),
            feeds: CREW_FEEDS.reduce((acc, f) => {
                const url = hooks[f] || '';
                acc[f] = { configured: !!url, hint: maskWebhookUrl(url), usingDefault: !url && !!ad.crewWebhookUrl };
                return acc;
            }, {}),
        });
    } catch (err) { console.error('crew webhook set error:', err); res.status(500).json({ error: 'Could not save the webhook.' }); }
});

// Staff: read the VA's email-provider config (never the secret key). Reports
// whether the platform fallback is available so the UI can explain what happens.
app.get('/api/crew/:slug/email', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'settings.notifications');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const doc = await VirtualAirlineAd.findById(va._id).select('+crewEmailKey crewEmailProvider crewEmailFrom crewEmailReplyTo crewEmailDomain crewEmailRegion').lean();
        res.set('Cache-Control', 'no-store');
        res.json({
            provider: (doc && doc.crewEmailProvider) || '',
            from: (doc && doc.crewEmailFrom) || '',
            replyTo: (doc && doc.crewEmailReplyTo) || '',
            domain: (doc && doc.crewEmailDomain) || '',
            region: (doc && doc.crewEmailRegion) || 'us',
            keyHint: maskKey(doc && doc.crewEmailKey),
            configured: !!(doc && doc.crewEmailProvider && doc.crewEmailKey && doc.crewEmailFrom),
        });
    } catch (err) { console.error('crew email get error:', err); res.status(500).json({ error: 'Could not load email settings.' }); }
});
// Staff: set / clear (provider:'') / test the VA's own email provider.
app.post('/api/crew/:slug/email', async (req, res) => {
    const gate = await requireCap(req, req.params.slug, 'settings.notifications');
    if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Not allowed.' });
    try {
        const va = await resolveCrewVa(req.params.slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });
        const ad = await VirtualAirlineAd.findById(va._id).select('+crewEmailKey crewEmailProvider crewEmailFrom crewEmailReplyTo crewEmailDomain crewEmailRegion name contactEmail crewAccent slug');
        if (!ad) return res.status(404).json({ error: 'Crew center not found.' });
        const b = req.body || {};

        // Empty provider clears the whole BYO config (falls back to platform).
        if (b.provider !== undefined) {
            const p = String(b.provider || '').toLowerCase();
            if (p && !CREW_EMAIL_PROVIDERS.includes(p)) return res.status(400).json({ error: 'Unknown email provider.' });
            ad.crewEmailProvider = p;
            if (!p) { ad.crewEmailKey = ''; ad.crewEmailFrom = ''; ad.crewEmailReplyTo = ''; ad.crewEmailDomain = ''; }
        }
        if (b.from !== undefined) {
            const from = String(b.from || '').trim().slice(0, 160);
            if (from && !isEmail(parseAddress(from).email)) return res.status(400).json({ error: 'From must be a valid email (optionally "Name <email>").' });
            ad.crewEmailFrom = from;
        }
        if (b.replyTo !== undefined) {
            const rt = String(b.replyTo || '').trim().slice(0, 160);
            if (rt && !isEmail(rt)) return res.status(400).json({ error: 'Reply-to must be a valid email.' });
            ad.crewEmailReplyTo = rt;
        }
        if (b.domain !== undefined) ad.crewEmailDomain = String(b.domain || '').trim().slice(0, 120);
        if (b.region !== undefined) ad.crewEmailRegion = b.region === 'eu' ? 'eu' : 'us';
        // Only overwrite the key when a non-empty one is sent (blank means "keep").
        if (typeof b.apiKey === 'string' && b.apiKey.trim()) ad.crewEmailKey = b.apiKey.trim().slice(0, 400);
        // Keep the non-secret mirror in sync for the public join page.
        ad.crewEmailConfigured = !!(ad.crewEmailProvider && ad.crewEmailKey && ad.crewEmailFrom);
        await ad.save();

        if (b.test) {
            const to = isEmail(b.testTo) ? String(b.testTo).trim() : (ad.contactEmail || '');
            if (!isEmail(to)) return res.status(400).json({ error: 'Enter a valid address to send the test to.' });
            const cfg = { provider: ad.crewEmailProvider, key: ad.crewEmailKey, from: ad.crewEmailFrom, replyTo: ad.crewEmailReplyTo || ad.contactEmail || '', domain: ad.crewEmailDomain || '', region: ad.crewEmailRegion || 'us' };
            if (!emailCfgReady(cfg)) return res.status(400).json({ error: 'Add a provider, From address and API key first.' });
            const ok = await sendCrewEmail(cfg, {
                to, subject: `${ad.name || 'Crew Center'} — email test`,
                html: crewEmailHtml({ vaName: ad.name, accent: ad.crewAccent, heading: 'Email is working 🎉',
                    bodyHtml: 'This is a test from your Crew Center. Applicant notifications will be delivered through your own provider.' }),
            });
            if (!ok) return res.status(502).json({ error: 'The provider rejected the test — double-check the From address, API key and (for Mailgun) the sending domain.' });
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            provider: ad.crewEmailProvider || '', from: ad.crewEmailFrom || '', replyTo: ad.crewEmailReplyTo || '',
            domain: ad.crewEmailDomain || '', region: ad.crewEmailRegion || 'us', keyHint: maskKey(ad.crewEmailKey),
            configured: ad.crewEmailConfigured,
        });
    } catch (err) { console.error('crew email set error:', err); res.status(500).json({ error: 'Could not save email settings.' }); }
});

// Crew Center badge-image upload — owner/staff (or Inflight) upload their own
// rank/role badge art. Reuses the VA image pipeline (WebP, alpha preserved).
// Bearer-authed (no cookie), so CORS stays simple.
app.post('/api/crew/:slug/badge-image', upload.single('image'), async (req, res) => {
    try {
        const p = verifyCrewRequest(req);
        if (!p) return res.status(401).json({ error: 'Not authenticated.' });
        if (!(p.kind === 'inflight' || p.role === 'owner' || p.role === 'staff')) {
            return res.status(403).json({ error: 'Not allowed to upload badges.' });
        }
        const slug = String(req.params.slug || '').toLowerCase();
        if (p.kind !== 'inflight' && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }
        if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

        let va = await VirtualAirlineAd.findOne({ slug }).select('_id').lean();
        if (!va) va = await VirtualAirlineAd.findOne({ callsign: slug.toUpperCase() }).select('_id').lean();
        const ref = va ? String(va._id) : slug;
        const url = await uploadVaImage(s3Client, req.file, ref, 'logo'); // 512² profile, keeps transparency
        res.set('Cache-Control', 'no-store');
        res.json({ url });
    } catch (err) {
        console.error('Crew badge upload error:', err);
        res.status(500).json({ error: 'Could not upload the badge image.' });
    }
});

// Health Check — public, unauthenticated (for uptime/platform monitors).
// NOTE: the site is staff-only, so the homepage ("/") is gated below; point any
// platform health check at /healthz instead of "/".
app.get('/healthz', (req, res) => {
    res.send('Community Aircraft Backend is Running.');
});

// Live backend diagnostics feed for the /diagnostics terminal. Admin-only: it
// exposes internal memory/CPU/route/gateway state. Cheap — reads pre-sampled
// ring buffers, does no DB or network work.
app.get('/api/admin/diagnostics', requireAdmin, (req, res) => {
    try {
        res.json(diagnostics.getSnapshot());
    } catch (e) {
        console.error('diagnostics snapshot error:', e);
        res.status(500).json({ message: 'Failed to build diagnostics snapshot.' });
    }
});

// Mapbox map-load guard controls for the Staff Hub's /map-usage console.
// The guard itself (mounted further down) stays public for the tracker; these
// admin endpoints expose the monthly counter and the switches — force-free-map
// and the monthly limit — plus a counter reset.
const mapLoadsGuard = require('./routes/mapLoads');

app.get('/api/admin/maploads', requireAdmin, (req, res) => {
    res.json(mapLoadsGuard.admin.state());
});

app.patch('/api/admin/maploads', requireAdmin, (req, res) => {
    try {
        const { forceFreeMap, limit } = req.body || {};
        res.json(mapLoadsGuard.admin.update({ forceFreeMap, limit }));
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.post('/api/admin/maploads/reset', requireAdmin, (req, res) => {
    res.json(mapLoadsGuard.admin.resetMonth());
});

// At-a-glance counters for the Staff Hub overview cards. Cheap countDocuments
// calls — no heavy aggregation. Any signed-in staff member (incl. VA reps) may
// read this; the figures are non-sensitive operational totals.
app.get('/api/staff/overview', requireAuth, async (req, res) => {
    try {
        const [vaTotal, vaPending, vaApproved, vaFeatured, aircraft, airports, partnerships] =
            await Promise.all([
                VirtualAirlineAd.countDocuments({}),
                VirtualAirlineAd.countDocuments({ status: 'pending' }),
                VirtualAirlineAd.countDocuments({ status: 'approved' }),
                VirtualAirlineAd.countDocuments({ featured: true }),
                CommunityAircraft.countDocuments({}),
                AirportGate.countDocuments({}),
                VaTermsAcceptance.countDocuments({}),
            ]);
        res.json({
            va: { total: vaTotal, pending: vaPending, approved: vaApproved, featured: vaFeatured },
            aircraft,
            airports,
            partnerships,
        });
    } catch (err) {
        console.error('Staff overview error:', err);
        res.status(500).json({ error: 'Could not load overview.' });
    }
});

// GET /api/staff/inbox — STAFF. The "needs attention" feed for the staff home:
// VAs that have requested flight-event webhook delivery but aren't approved yet,
// plus the most recent open partner submissions (tickets). Surfaced at a glance
// so staff don't have to dig through the VA editor / submissions inbox to act.
app.get('/api/staff/inbox', requireAuth, async (req, res) => {
    try {
        const [pendingAds, openSubs, ticketsOpen] = await Promise.all([
            // Requested + not yet approved. The webhook URL is a secret, so we only
            // expose a masked hint and a boolean for whether one is on file.
            VirtualAirlineAd
                .find({ flightEventsRequestedAt: { $ne: null }, flightEventsApproved: { $ne: true } })
                .select('+flightEventsWebhookUrl name callsign callsigns flightEventsEnabled flightEventsRequestedAt')
                .sort({ flightEventsRequestedAt: 1 })
                .limit(50)
                .lean(),
            VaSubmission
                .find({ status: { $in: ['open', 'in_review'] } })
                .sort({ createdAt: -1 })
                .limit(12)
                .lean(),
            VaSubmission.countDocuments({ status: { $in: ['open', 'in_review'] } }),
        ]);

        const webhookApprovals = pendingAds.map(ad => ({
            id: ad._id,
            name: ad.name || ad.callsign || (ad.callsigns && ad.callsigns[0]) || 'Unnamed VA',
            code: ad.callsign || (ad.callsigns && ad.callsigns[0]) || '',
            requestedAt: ad.flightEventsRequestedAt,
            enabled: !!ad.flightEventsEnabled,
            configured: !!ad.flightEventsWebhookUrl,
            hint: maskWebhookUrl(ad.flightEventsWebhookUrl),
        }));

        const tickets = openSubs.map(s => ({
            id: s._id,
            title: s.title || '(untitled)',
            category: s.category || 'other',
            status: s.status || 'open',
            vaName: s.vaName || '',
            submittedByName: s.submittedByName || '',
            createdAt: s.createdAt,
        }));

        res.json({
            webhookApprovals,
            tickets,
            counts: {
                webhookPending: webhookApprovals.length,
                ticketsOpen,
            },
        });
    } catch (err) {
        console.error('Staff inbox error:', err);
        res.status(500).json({ error: 'Could not load the staff inbox.' });
    }
});


/* =========================
 * GATES API (MONGODB INTEGRATION)
 * ========================= */

// POST: Import gates.json into MongoDB using fast Bulk Upsert
app.post('/api/gates/import', requireAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'JSON file is required.' });
        }

        const rawData = fs.readFileSync(req.file.path, 'utf8');
        const gatesData = JSON.parse(rawData);

        // Clean up the temp file from disk immediately to save space
        fs.unlink(req.file.path, () => {});

        const bulkOps = [];

        // Logic to dynamically handle different standard JSON map formats
        if (Array.isArray(gatesData)) {
            // If the JSON is an array of objects: [ { icao: "KJFK", gates: [...] } ]
            for (const item of gatesData) {
                const code = item.icao || item.airport || item.airportCode || item.id;
                if (code) {
                    bulkOps.push({
                        updateOne: {
                            filter: { airportCode: code.toUpperCase() },
                            update: { $set: { gates: item.gates || item, updatedAt: new Date() } },
                            upsert: true
                        }
                    });
                }
            }
        } else {
            // If the JSON is an object with airport codes as keys: { "KJFK": [...], "EGLL": [...] }
            for (const [code, gates] of Object.entries(gatesData)) {
                bulkOps.push({
                    updateOne: {
                        filter: { airportCode: code.toUpperCase() },
                        update: { $set: { gates: gates, updatedAt: new Date() } },
                        upsert: true
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await AirportGate.bulkWrite(bulkOps);
            res.json({ message: `✅ Successfully imported gates for ${bulkOps.length} airports into MongoDB.` });
        } else {
            res.status(400).json({ message: 'Could not parse airport codes from the provided JSON structure.' });
        }

    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        console.error('Gates Import Error:', error);
        res.status(500).json({ message: 'Failed to import gates data to MongoDB.' });
    }
});

// GET: Fetch gates for a specific airport (Optimized for constant calling)
app.get('/api/gates/:icao', async (req, res) => {
    try {
        const airportCode = req.params.icao.toUpperCase();
        const airportData = await AirportGate.findOne({ airportCode }).lean(); // .lean() makes query faster

        if (!airportData) {
            return res.status(404).json({ message: `No gates found for airport ${airportCode}` });
        }

        res.json(airportData.gates);
    } catch (error) {
        console.error('Gates Fetch Error:', error);
        res.status(500).json({ message: 'Failed to fetch gates.' });
    }
});

// GET: Fetch all gates (Use with caution if dataset is massive)
app.get('/api/gates', async (req, res) => {
    try {
        const allGates = await AirportGate.find({}).lean();
        res.json(allGates);
    } catch (error) {
        console.error('Global Gates Fetch Error:', error);
        res.status(500).json({ message: 'Failed to fetch global gates dataset.' });
    }
});


/* =========================
 * LEADERBOARD API
 * ========================= */

// POST: Track a view (Counts unique viewers per flight per day)
// Strategy: try to claim a (date, pilot, flight, viewer) slot via insert. If
// the unique index rejects with E11000, this viewer already counted this
// flight today and we short-circuit. Otherwise atomically `$inc` the stats
// counter — no growing arrays, no full-doc rewrites, safe under concurrency.
//
// `flightId` is optional for backwards compatibility with older clients; when
// absent we bucket into NO_FLIGHT so the view still counts somewhere.
app.post('/api/leaderboard/track', async (req, res) => {
    try {
        const { pilotUserId, pilotName, flightId } = req.body;
        if (!pilotUserId || !pilotName) {
            return res.status(400).json({ message: 'Missing pilot info' });
        }

        const date = getTodayString();
        const viewerIp = req.ip || req.connection.remoteAddress;
        const viewerHash = hashIp(viewerIp);
        const fid = (typeof flightId === 'string' && flightId.length) ? flightId : NO_FLIGHT;

        try {
            await DailyPilotView.create({ date, pilotUserId, flightId: fid, viewerHash });
        } catch (err) {
            if (err && err.code === 11000) {
                return res.json({ success: true, counted: false });
            }
            throw err;
        }

        await DailyPilotStats.updateOne(
            { date, pilotUserId, flightId: fid },
            {
                $inc: { viewCount: 1 },
                $set: { pilotName },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
        );

        res.json({ success: true, counted: true });
    } catch (error) {
        console.error('Track View Error:', error);
        res.status(500).json({ message: 'Error tracking view' });
    }
});

// GET: Top Most Tracked flights today.
//
//   ?limit=N          Cap how many rows to return (default 3, max 50).
//   ?groupBy=pilot    Aggregate per pilot instead of per flight (legacy
//                     shape). Useful for callers that don't care which
//                     specific flight is being tracked.
//
// Per-flight rows include `pilotUserId` and `flightId` so the caller can
// pinpoint exactly which live flight to focus on. NO_FLIGHT buckets are
// filtered out of per-flight responses (they represent pre-flightId
// clients with no flight to point at) but still feed the pilot rollup.
app.get('/api/leaderboard/top', async (req, res) => {
    try {
        const date = getTodayString();
        const rawLimit = parseInt(req.query.limit, 10);
        const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 3 : rawLimit, 50));
        const groupBy = (req.query.groupBy || '').toLowerCase();

        if (groupBy === 'pilot') {
            const rows = await DailyPilotStats.aggregate([
                { $match: { date } },
                { $group: {
                    _id: '$pilotUserId',
                    pilotName: { $last: '$pilotName' },
                    viewCount: { $sum: '$viewCount' }
                } },
                { $sort: { viewCount: -1 } },
                { $limit: limit },
                { $project: {
                    _id: 0,
                    pilotUserId: '$_id',
                    pilotName: 1,
                    viewCount: 1
                } }
            ]);
            return res.json(rows);
        }

        const rows = await DailyPilotStats
            .find({ date, flightId: { $ne: NO_FLIGHT } })
            .sort({ viewCount: -1 })
            .limit(limit)
            .select('pilotName pilotUserId flightId viewCount -_id')
            .lean();

        res.json(rows);
    } catch (error) {
        console.error('Leaderboard Fetch Error:', error);
        res.status(500).json({ message: 'Error fetching leaderboard' });
    }
});


/* =========================
 * IMAGE PROXY FOR SCREENSHOTS
 * ========================= */
app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('No URL provided');
    }

    try {
        // Fetch the external image as a stream
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream'
        });

        // 1. Force Allow Origin * (The magic permission slip)
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type");

        // 2. Forward the content type (png, jpg, webp, etc.)
        if (response.headers['content-type']) {
            res.header("Content-Type", response.headers['content-type']);
        }

        // 3. Pipe the image data straight to the frontend
        response.data.pipe(res);

    } catch (error) {
        console.error("Image Proxy Error:", error.message);
        res.status(500).send('Failed to fetch image');
    }
});

/* =========================
 * FLIGHT TRAILS STORAGE
 * ========================= */

// GET: Fetch ALL available replays, across every user.
// Lets the front end browse the full library of stored flight trails and pick
// any flight from any user to play back — not just its own. Returns a flat list
// so the client can group by userId (or filter) however it likes.
app.get('/api/trails', async (req, res) => {
    try {
        const prefix = 'trails/';
        const trails = [];
        let ContinuationToken;

        // S3 lists at most 1000 keys per call, so page through until exhausted.
        do {
            const cmd = new ListObjectsV2Command({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Prefix: prefix,
                ContinuationToken
            });
            const data = await s3Client.send(cmd);

            for (const f of data.Contents || []) {
                // Keys look like: trails/{userId}/{flightId}.json
                const rest = f.Key.slice(prefix.length);
                const slash = rest.indexOf('/');
                if (slash === -1) continue; // skip anything not under a user folder
                const userId = rest.slice(0, slash);
                const flightId = rest.slice(slash + 1).replace(/\.json$/, '');
                if (!userId || !flightId) continue;

                trails.push({
                    userId,
                    flightId,
                    date: f.LastModified,
                    size: f.Size,
                    url: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${f.Key}`
                });
            }

            ContinuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
        } while (ContinuationToken);

        // Sort Newest First
        trails.sort((a, b) => b.date - a.date);

        res.json(trails);
    } catch (e) {
        console.error("All Trails Fetch Error:", e);
        res.status(500).json({ message: "Failed to fetch trails" });
    }
});

// GET: Fetch a user's trails
app.get('/api/trails/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const prefix = `trails/${userId}/`;
        const cmd = new ListObjectsV2Command({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Prefix: prefix
        });
        const data = await s3Client.send(cmd);
        
        if (!data.Contents || data.Contents.length === 0) {
            return res.json([]);
        }

        // Return list of trails with public URLs
        const trails = data.Contents.map(f => ({
            flightId: f.Key.split('/').pop().replace('.json', ''),
            date: f.LastModified,
            size: f.Size,
            url: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${f.Key}`
        }));

        // Sort Newest First
        trails.sort((a, b) => b.date - a.date);

        res.json(trails);
    } catch (e) {
        console.error("Trail Fetch Error:", e);
        res.status(500).json({ message: "Failed to fetch trails" });
    }
});

// POST: Save or Append to a completed flight trail
app.post('/api/trails', async (req, res) => {
    try {
        const { userId, flightId, trail } = req.body;
        
        if (!userId || !flightId || !trail || !Array.isArray(trail)) {
            return res.status(400).json({ message: 'Missing data or invalid trail format' });
        }

        const folderPrefix = `trails/${userId}/`;
        const newFileKey = `${folderPrefix}${flightId}.json`;
        
        let finalTrail = trail;
        let isUpdate = false;

        // 1. CHECK & MERGE: Look for existing trail in S3
        try {
            console.log(`🔍 Checking for existing trail: ${newFileKey}`);
            const getCmd = new GetObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: newFileKey
            });
            
            const { Body } = await s3Client.send(getCmd);
            const existingData = await streamToString(Body);
            const existingJson = JSON.parse(existingData);

            if (Array.isArray(existingJson)) {
                console.log(`🧩 Found existing trail (${existingJson.length} points). Merging...`);
                
                // Combine old + new
                finalTrail = existingJson.concat(trail);

                // OPTIONAL: Sort by timestamp to ensure correct order
                finalTrail.sort((a, b) => a.t - b.t);

                // OPTIONAL: Deduplicate (remove points with identical timestamps)
                finalTrail = finalTrail.filter((item, index, self) => 
                    index === 0 || item.t !== self[index - 1].t
                );
                
                isUpdate = true;
            }
        } catch (err) {
            // NoSuchKey means file doesn't exist yet, which is fine. We just create it.
            if (err.name !== 'NoSuchKey') {
                console.error("⚠️ Error checking S3 for existing trail:", err.message);
            }
        }

        // 2. PRUNE: Remove files older than 48 hours (Only runs if this is a NEW file)
        // We skip this heavy listing operation on mere updates to save performance
        if (!isUpdate) {
            const listCmd = new ListObjectsV2Command({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Prefix: folderPrefix
            });
            
            const existing = await s3Client.send(listCmd);
            const files = existing.Contents || [];

            const limitTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const keepFiles = [];
            const deletePromises = [];

            for (const file of files) {
                if (file.LastModified < limitTime) {
                    console.log(`🗑️ Expiring old trail: ${file.Key}`);
                    deletePromises.push(s3Client.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET_NAME, Key: file.Key
                    })));
                } else {
                    keepFiles.push(file);
                }
            }

            // LIMIT: Max 3 recent flights
            keepFiles.sort((a, b) => a.LastModified - b.LastModified);
            
            // Check if we are accidentally creating a 4th file
            // (Note: We already know this is not an update to an existing file key)
            if (keepFiles.length >= 3) {
                const oldest = keepFiles[0];
                console.log(`🗑️ Max 3 reached. Deleting oldest: ${oldest.Key}`);
                deletePromises.push(s3Client.send(new DeleteObjectCommand({
                    Bucket: process.env.AWS_S3_BUCKET_NAME, Key: oldest.Key
                })));
            }

            if (deletePromises.length > 0) await Promise.all(deletePromises);
        }

        // 3. SAVE FINAL TRAIL (Compressed JSON)
        const bodyBuffer = Buffer.from(JSON.stringify(finalTrail));

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: newFileKey,
            Body: bodyBuffer,
            ContentType: 'application/json',
            CacheControl: 'no-cache' 
        }));

        console.log(`💾 Saved trail: ${newFileKey} (Total: ${finalTrail.length} points)`);
        res.json({ ok: true, merged: isUpdate });

    } catch (e) {
        console.error("Trail Save Error:", e);
        res.status(500).json({ message: "Failed to save trail" });
    }
});


// GET: Fetch all aircraft contributions
app.get('/api/aircraft', async (req, res) => {
    try {
        // .lean(): this returns the whole collection on every homepage load, so
        // skip Mongoose document hydration (change-tracking, getters/setters) and
        // hand back plain objects. Cuts both the CPU per request and the peak RSS
        // of the response by several times — the result is only serialized to JSON.
        const aircraft = await CommunityAircraft.find().sort({ uploadedAt: -1 }).lean();
        res.json(aircraft);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching aircraft.' });
    }
});

// GET: Find aircraft by Type AND Livery (or return a placeholder)
app.get('/api/aircraft/lookup', async (req, res) => {
    try {
        // 1. Support both internal names (type/tail) and JSON names (model/registration)
        const { type, model, livery, liveryName, tail, registration } = req.query; 

        // 2. Normalize values: prioritize provided data, then fall back
        const finalType = type || model;
        const finalLivery = liveryName || livery;
        const finalTail = (tail || registration || "").toUpperCase();

        if (!finalType && !finalLivery && !finalTail) {
            return res.status(400).json({ message: 'At least one search parameter is required.' });
        }

        // 3. Build the MongoDB Query
        let query = {};
        if (finalType) query.aircraftType = { $regex: finalType, $options: 'i' };
        if (finalLivery) query.liveryName = { $regex: finalLivery, $options: 'i' };
        if (finalTail) query.tailNumber = finalTail;

        // .lean(): results are only inspected and serialized (no doc methods),
        // so return plain objects and skip Mongoose hydration.
        const results = await CommunityAircraft.find(query).lean();

        // 4. FIX: If no results found, return placeholder using the normalized 'finalTail'
        if (results.length === 0) {
            return res.json({
                contributorName: "System",
                aircraftType: finalType || "Unknown",
                liveryName: finalLivery || "Standard",
                tailNumber: finalTail || "N/A", // This will now correctly show "3B-NBP"
                imageUrl: null,
                imageUrls: [],
                isPlaceholder: true,
                uploadedAt: new Date()
            });
        }

        // --- EXISTING INTELLIGENT SORTING LOGIC ---
        if (finalLivery) {
            const searchLower = finalLivery.toLowerCase();
            const exactMatch = results.find(
                item => item.liveryName.toLowerCase() === searchLower
            );
            if (exactMatch) return res.json(exactMatch);
        }

        res.json(results[0]); 

    } catch (error) {
        console.error('Error looking up aircraft:', error);
        res.status(500).json({ message: 'Error performing lookup.' });
    }
});

// GET: Admin System Stats (S3 & DB stats) — public read, like the other GET
// data endpoints (va-ads, airports). Consumed by external frontends; the
// write APIs and the homepage UI remain staff-only.
app.get('/api/admin/stats', async (req, res) => {
    try {
        // 1. Get MongoDB Stats
        const dbStats = await mongoose.connection.db.stats();
        const docCount = await CommunityAircraft.countDocuments();
        
        // 2. Get Server Memory Usage (RSS = Resident Set Size)
        const memoryUsage = process.memoryUsage();

        // 3. Get S3 Storage Metrics from CloudWatch (Fast & Cheap)
        let s3SizeBytes = 0;

        try {
            const command = new GetMetricStatisticsCommand({
                Namespace: 'AWS/S3',
                MetricName: 'BucketSizeBytes',
                Dimensions: [
                    { Name: 'BucketName', Value: process.env.AWS_S3_BUCKET_NAME },
                    { Name: 'StorageType', Value: 'StandardStorage' }
                ],
                StartTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), 
                EndTime: new Date(),
                Period: 86400, 
                Statistics: ['Maximum'] 
            });
            
            const data = await cloudWatchClient.send(command);
            
            if (data.Datapoints && data.Datapoints.length > 0) {
                data.Datapoints.sort((a, b) => b.Timestamp - a.Timestamp);
                s3SizeBytes = data.Datapoints[0].Maximum;
            }
        } catch (s3Error) {
            console.error('S3 Stats Error (Non-fatal):', s3Error);
        }
        
        res.json({
            status: 'online',
            aircraftCount: docCount,
            dbSizeBytes: dbStats.storageSize, 
            dbDataSizeBytes: dbStats.dataSize, 
            serverMemoryBytes: memoryUsage.rss,
            uptimeSeconds: process.uptime(),
            s3SizeBytes: s3SizeBytes
        });
    } catch (error) {
        console.error('Stats Error:', error);
        res.status(500).json({ message: 'Error fetching system stats.' });
    }
});

// POST: Upload a new aircraft (supports up to MAX_AIRCRAFT_IMAGES images)
app.post('/api/aircraft', requireAuth, uploadAircraftImages, async (req, res) => {
    const files = collectUploadedImages(req);
    try {
        if (files.length === 0) return res.status(400).json({ message: 'At least one image file is required.' });

        // Destructure with mapping support for incoming external JSON keys
        const {
            contributorName = "System",
            aircraftType,
            model,
            liveryName,
            livery,
            tailNumber,
            registration
        } = req.body;

        // Resolve which values to use (internal names vs incoming json names)
        const finalType = aircraftType || model;
        const finalLivery = liveryName || livery;
        const finalTail = (tailNumber || registration || "").toUpperCase();

        if (!finalType || !finalLivery || !finalTail) {
            // Clean up temp files if validation fails
            cleanupTempFiles(files);
            return res.status(400).json({ message: 'All fields (Type/Model, Livery, Tail/Registration) are required.' });
        }

        // Process and upload each image to S3 (order preserved)
        const imageUrls = [];
        for (const file of files) {
            imageUrls.push(await processAndUploadAircraftImage(file, finalTail));
        }

        // Clean up local temp files to free up disk space
        cleanupTempFiles(files);

        const newEntry = new CommunityAircraft({
            contributorName,
            aircraftType: finalType,
            liveryName: finalLivery,
            tailNumber: finalTail,
            imageUrls,
            imageUrl: imageUrls[0], // Primary image kept in sync for backward compatibility
            // All images in a single upload come from the same submitter
            imageContributors: imageUrls.map(() => ({ name: contributorName, id: null }))
        });

        await newEntry.save();

        await sendDiscordWebhook(newEntry);

        res.status(201).json({ message: 'Aircraft uploaded successfully!', data: newEntry });

    } catch (error) {
        // Ensure cleanup happens even on error
        cleanupTempFiles(files);

        console.error('Upload Error:', error);
        res.status(500).json({ message: 'Server error during upload.' });
    }
});

// Origins allowed to submit community aircraft photos. The submitting site is
// trusted by its Origin (the browser sets it and page JS can't forge it) rather
// than a shared secret. Override with a comma-separated COMMUNITY_SUBMIT_ORIGINS
// list; the default covers the live site plus the Netlify production + preview
// hosts. Entries may contain `*` as a wildcard that matches one host segment
// (no dots) — so `deploy-preview-*--indgo-va.netlify.app` matches EVERY numbered
// deploy preview. A lone `*` entry disables the check (accept any origin).
const COMMUNITY_SUBMIT_ORIGINS = (() => {
    const raw = process.env.COMMUNITY_SUBMIT_ORIGINS || [
        'https://inflight.info',
        'https://indgo-va.netlify.app',
        'https://deploy-preview-*--indgo-va.netlify.app',
        'https://*--indgo-va.netlify.app', // branch deploys
        process.env.PUBLIC_BASE_URL || '',
    ].join(',');
    return raw.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
})();

// Precompile each allow-list entry into a matcher. Plain entries match exactly;
// entries containing `*` become an anchored regex where `*` matches one host
// segment ([^.]*), so the deploy-preview NUMBER varies freely without matching a
// different domain (the `$` anchor stops any suffix like `.attacker.com`).
const COMMUNITY_SUBMIT_MATCHERS = COMMUNITY_SUBMIT_ORIGINS.map((entry) => {
    if (entry === '*') return () => true;
    if (!entry.includes('*')) return (o) => o === entry;
    const rx = new RegExp('^' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^.]*') + '$');
    return (o) => rx.test(o);
});

// Is this request coming from an allowed origin? Uses the Origin header, falling
// back to the Referer's origin (some clients send only Referer).
const isAllowedSubmitOrigin = (req) => {
    let origin = (req.get('origin') || '').trim().replace(/\/+$/, '');
    if (!origin) {
        const ref = req.get('referer') || '';
        try { origin = new URL(ref).origin; } catch (_) { origin = ''; }
    }
    if (!origin) return false;
    return COMMUNITY_SUBMIT_MATCHERS.some((match) => match(origin));
};

// POST /api/community/aircraft/submit — PUBLIC endpoint that lets our front-end
// site submit aircraft photos. It differs from POST /api/aircraft (staff-auth,
// which writes straight to the database) in these ways:
//   • it is called cross-origin from the browser — the global cors() already
//     sends Access-Control-Allow-Origin: *, and access is gated by the request's
//     Origin (see COMMUNITY_SUBMIT_ORIGINS) rather than a staff session;
//   • the type/livery/tail are auto-matched exactly like a Discord DM submission
//     (normalize against the catalog + registration lookup for a missing tail); and
//   • nothing is written to the database here. Each image is optimized and handed
//     to the SAME Discord admin review flow as DM submissions — attached to the
//     review message (so it renders immediately), and only a staff approval moves
//     it to S3 and writes the record. The collaborator to credit comes from the
//     submitting site's identity (a linked Discord id when it has one, else a name).
// Up to MAX_AIRCRAFT_IMAGES photos are accepted; each gets its own review card so
// staff can slot them into the aircraft's up-to-3 gallery individually.
app.post('/api/community/aircraft/submit', uploadAircraftImages, async (req, res) => {
    const files = collectUploadedImages(req);
    try {
        if (!isAllowedSubmitOrigin(req)) {
            cleanupTempFiles(files);
            return res.status(403).json({ message: 'Origin not allowed to submit.' });
        }

        if (files.length === 0) {
            return res.status(400).json({ message: 'At least one image file is required.' });
        }

        const {
            aircraftType, model,
            liveryName, livery,
            tailNumber, registration,
            collaboratorId,
            collaboratorName, collaborator,
            sourceSite,
        } = req.body;

        const rawType = (aircraftType || model || '').trim();
        const rawLivery = (liveryName || livery || '').trim();
        const rawTail = (tailNumber || registration || '').trim();

        if (!rawType || !rawLivery) {
            cleanupTempFiles(files);
            return res.status(400).json({ message: 'aircraftType (or model) and liveryName (or livery) are required.' });
        }

        // Auto-match once for the whole submission (all its images share the same
        // aircraft): normalize the type/livery and auto-fill the tail if missing.
        const matched = await resolveAircraftMatch(rawType, rawLivery, rawTail);

        // Collaborator identity supplied by the submitting site. A numeric id is
        // treated as a linked Discord account; the name is the human-readable
        // credit shown/used when there is no linked id.
        const collabId = /^\d{5,}$/.test(String(collaboratorId || '')) ? String(collaboratorId) : null;
        const collabName = (collaboratorName || collaborator || '').trim().slice(0, 60) || 'Anonymous';
        const site = (sourceSite || req.get('origin') || '').toString().trim().slice(0, 80) || null;

        // Optimize + route each image one at a time — the sharp queue serializes
        // the decode, and processing sequentially keeps only one image buffer alive.
        let routed = 0;
        for (const file of files) {
            const imageBuffer = await optimizeAircraftImageBuffer(file);
            await submitWebAircraftReview({
                aircraftType: matched.type,
                liveryName: matched.livery,
                tailNumber: matched.tail,
                imageBuffer,
                collaboratorId: collabId,
                collaboratorName: collabName,
                sourceSite: site,
            });
            routed++;
        }

        cleanupTempFiles(files);
        return res.status(202).json({
            message: 'Submitted for review.',
            images: routed,
            matched: { aircraftType: matched.type, liveryName: matched.livery, tailNumber: matched.tail },
        });
    } catch (error) {
        cleanupTempFiles(files);
        if (error && /bot not ready/i.test(error.message || '')) {
            console.error('Community submission rejected — Discord bot not ready.');
            return res.status(503).json({ message: 'Review service temporarily unavailable. Please retry shortly.' });
        }
        console.error('Community submission error:', error);
        return res.status(500).json({ message: 'Server error during submission.' });
    }
});

const syncAircraftDatabase = async (jsonList) => {
    for (const ac of jsonList) {
        // Map the JSON keys to your local variables
        const registration = ac.registration ? ac.registration.toUpperCase() : null; 
        const model = ac.model || "Unknown";
        const livery = ac.livery || "Standard";

        if (!registration || registration === "N/A") continue;

        // 1. Check if a valid record already exists for this registration
        const exists = await CommunityAircraft.findOne({ tailNumber: registration });

        if (!exists) {
            // 2. SEARCH FOR "BROKEN" RECORDS: 
            // Look for a record that matches this Type/Livery but has no valid Registration
            const placeholder = await CommunityAircraft.findOne({
                aircraftType: model,
                liveryName: livery,
                $or: [
                    { tailNumber: "N/A" },
                    { tailNumber: "" },
                    { tailNumber: { $exists: false } },
                    { tailNumber: null }
                ]
            });

            if (placeholder) {
                console.log(`🔧 Patching placeholder for ${model} (${livery}) with Registration: ${registration}`);
                placeholder.tailNumber = registration;
                await placeholder.save();
            } else {
                // 3. If no placeholder exists, create a fresh record
                console.log(`🆕 Pre-creating record for: ${registration}`);
                await CommunityAircraft.create({
                    contributorName: "System",
                    aircraftType: model, 
                    liveryName: livery,
                    tailNumber: registration,
                    imageUrl: null 
                });
            }
        }
    }
};

// PATCH: Toggle the "needs update" flag
app.patch('/api/aircraft/:id/flag', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const entry = await CommunityAircraft.findById(id);

        if (!entry) return res.status(404).json({ message: 'Aircraft not found.' });

        // Flip the boolean
        entry.needsUpdate = !entry.needsUpdate;
        await entry.save();

        res.json({ message: 'Update flag toggled successfully.', data: entry });
    } catch (error) {
        console.error('Flag Toggle Error:', error);
        res.status(500).json({ message: 'Server error during flag toggle.' });
    }
});

// PUT: Update an existing aircraft (replaces the full image set when new images are sent)
app.put('/api/aircraft/:id', requireAuth, uploadAircraftImages, async (req, res) => {
    const files = collectUploadedImages(req);
    try {
        const { id } = req.params;

        // Map mapping support for incoming external JSON keys
        const {
            contributorName,
            aircraftType,
            model,
            liveryName,
            livery,
            tailNumber,
            registration
        } = req.body;

        const finalType = aircraftType || model;
        const finalLivery = liveryName || livery;
        const finalTail = tailNumber || registration;

        const existingEntry = await CommunityAircraft.findById(id);
        if (!existingEntry) {
            // Clean up if files uploaded but record not found
            cleanupTempFiles(files);
            return res.status(404).json({ message: 'Aircraft not found.' });
        }

        if (files.length > 0) {
            console.log(`Processing ${files.length} new image(s) for update: ${id}`);

            const tailRef = finalTail || existingEntry.tailNumber;
            const newImageUrls = [];
            for (const file of files) {
                newImageUrls.push(await processAndUploadAircraftImage(file, tailRef));
            }

            // Delete the previous image set now that new ones are in place
            await deleteAircraftImages(existingEntry);

            existingEntry.imageUrls = newImageUrls;
            existingEntry.imageUrl = newImageUrls[0];

            // The full set was replaced by this editor, so attribute every new
            // image to them (fall back to the entry's existing contributor).
            const who = contributorName || existingEntry.contributorName || "System";
            existingEntry.imageContributors = newImageUrls.map(() => ({
                name: who,
                id: existingEntry.contributorId || null
            }));

            // Clean up local temp files
            cleanupTempFiles(files);

            // CLEAR THE FLAG: New images were uploaded, so it no longer needs an update
            existingEntry.needsUpdate = false;
        }

        if (contributorName) {
            existingEntry.contributorName = contributorName;
            // Editing the contributor name updates the primary (slot 0) image's
            // contributor; the other slots keep their own attribution.
            const contributors = getEntryContributors(existingEntry);
            if (contributors.length > 0) {
                contributors[0] = { name: contributorName, id: existingEntry.contributorId || null };
                existingEntry.imageContributors = contributors;
            }
        }
        if (finalType) existingEntry.aircraftType = finalType;
        if (finalLivery) existingEntry.liveryName = finalLivery;
        if (finalTail) existingEntry.tailNumber = finalTail.toUpperCase();

        syncPrimaryContributor(existingEntry);
        await existingEntry.save();

        res.json({ message: 'Aircraft updated successfully!', data: existingEntry });

    } catch (error) {
        // FIX: Ensure cleanup on error
        cleanupTempFiles(files);

        console.error('Update Error:', error);
        res.status(500).json({ message: 'Server error during update.' });
    }
});

// DELETE: Remove an aircraft
app.delete('/api/aircraft/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const entry = await CommunityAircraft.findById(id);

        if (!entry) return res.status(404).json({ message: 'Aircraft not found.' });

        await deleteAircraftImages(entry);
        await CommunityAircraft.findByIdAndDelete(id);

        res.json({ message: 'Aircraft deleted successfully.' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ message: 'Server error during deletion.' });
    }
});

/* =========================
 * PER-SLOT AIRCRAFT IMAGE MANAGEMENT
 * Lets the dashboard add / replace / remove any individual image (slot 0-2)
 * without touching the others. `imageUrl` always mirrors imageUrls[0].
 * ========================= */

// POST: Append a new image to an aircraft (up to MAX_AIRCRAFT_IMAGES)
app.post('/api/aircraft/:id/images', requireAuth, upload.single('image'), async (req, res) => {
    const file = req.file;
    try {
        if (!file) return res.status(400).json({ message: 'Image file is required.' });

        const entry = await CommunityAircraft.findById(req.params.id);
        if (!entry) {
            cleanupTempFiles([file]);
            return res.status(404).json({ message: 'Aircraft not found.' });
        }

        const images = getEntryImages(entry);
        if (images.length >= MAX_AIRCRAFT_IMAGES) {
            cleanupTempFiles([file]);
            return res.status(400).json({ message: `An aircraft can have at most ${MAX_AIRCRAFT_IMAGES} images.` });
        }

        const url = await processAndUploadAircraftImage(file, entry.tailNumber);
        cleanupTempFiles([file]);

        const contributors = getEntryContributors(entry);
        images.push(url);
        contributors.push({
            name: req.body.contributorName || entry.contributorName || "System",
            id: req.body.contributorId || null
        });
        entry.imageUrls = images;
        entry.imageContributors = contributors;
        syncPrimaryImage(entry);
        syncPrimaryContributor(entry);
        await entry.save();

        res.status(201).json({ message: 'Image added.', data: entry });
    } catch (error) {
        cleanupTempFiles([file]);
        console.error('Add Image Error:', error);
        res.status(500).json({ message: 'Server error while adding image.' });
    }
});

// PUT: Replace (or set) the image at a specific slot index
app.put('/api/aircraft/:id/images/:index', requireAuth, upload.single('image'), async (req, res) => {
    const file = req.file;
    try {
        if (!file) return res.status(400).json({ message: 'Image file is required.' });

        const index = parseInt(req.params.index, 10);
        if (isNaN(index) || index < 0 || index >= MAX_AIRCRAFT_IMAGES) {
            cleanupTempFiles([file]);
            return res.status(400).json({ message: `Slot must be between 0 and ${MAX_AIRCRAFT_IMAGES - 1}.` });
        }

        const entry = await CommunityAircraft.findById(req.params.id);
        if (!entry) {
            cleanupTempFiles([file]);
            return res.status(404).json({ message: 'Aircraft not found.' });
        }

        const images = getEntryImages(entry);
        // Only allow replacing an existing slot or appending to the very next one (no gaps)
        if (index > images.length) {
            cleanupTempFiles([file]);
            return res.status(400).json({ message: 'Cannot leave an empty image slot.' });
        }

        const url = await processAndUploadAircraftImage(file, entry.tailNumber);
        cleanupTempFiles([file]);

        const contributors = getEntryContributors(entry);
        // Whoever supplies this image becomes its contributor; if none is provided
        // (e.g. an admin re-upload) keep the slot's existing attribution.
        const slotContributor = {
            name: req.body.contributorName || (contributors[index] && contributors[index].name) || entry.contributorName || "System",
            id: req.body.contributorId || (contributors[index] && contributors[index].id) || null
        };

        if (index < images.length) {
            const oldUrl = images[index];
            images[index] = url;
            contributors[index] = slotContributor;
            if (oldUrl) await deleteS3Object(oldUrl); // Remove the replaced image from S3
        } else {
            images.push(url);
            contributors.push(slotContributor);
        }

        entry.imageUrls = images;
        entry.imageContributors = contributors;
        syncPrimaryImage(entry);
        syncPrimaryContributor(entry);
        await entry.save();

        res.json({ message: 'Image replaced.', data: entry });
    } catch (error) {
        cleanupTempFiles([file]);
        console.error('Replace Image Error:', error);
        res.status(500).json({ message: 'Server error while replacing image.' });
    }
});

// DELETE: Remove the image at a specific slot index
app.delete('/api/aircraft/:id/images/:index', requireAuth, async (req, res) => {
    try {
        const index = parseInt(req.params.index, 10);
        if (isNaN(index) || index < 0) {
            return res.status(400).json({ message: 'Invalid slot index.' });
        }

        const entry = await CommunityAircraft.findById(req.params.id);
        if (!entry) return res.status(404).json({ message: 'Aircraft not found.' });

        const images = getEntryImages(entry);
        if (index >= images.length) {
            return res.status(404).json({ message: 'No image at that slot.' });
        }

        const contributors = getEntryContributors(entry);
        const [removed] = images.splice(index, 1);
        contributors.splice(index, 1);
        entry.imageUrls = images;
        entry.imageContributors = contributors;
        syncPrimaryImage(entry);
        syncPrimaryContributor(entry);
        await entry.save();

        if (removed) await deleteS3Object(removed); // Remove the deleted image from S3

        res.json({ message: 'Image removed.', data: entry });
    } catch (error) {
        console.error('Remove Image Error:', error);
        res.status(500).json({ message: 'Server error while removing image.' });
    }
});

// PATCH: Update only the contributor name of a specific slot, without touching the
// image itself. Lets the dashboard correct/reattribute who spotted each photo.
app.patch('/api/aircraft/:id/images/:index/contributor', requireAuth, async (req, res) => {
    try {
        const index = parseInt(req.params.index, 10);
        if (isNaN(index) || index < 0 || index >= MAX_AIRCRAFT_IMAGES) {
            return res.status(400).json({ message: `Slot must be between 0 and ${MAX_AIRCRAFT_IMAGES - 1}.` });
        }

        const contributorName = (req.body.contributorName || '').trim();
        if (!contributorName) {
            return res.status(400).json({ message: 'Contributor name is required.' });
        }

        const entry = await CommunityAircraft.findById(req.params.id);
        if (!entry) return res.status(404).json({ message: 'Aircraft not found.' });

        const images = getEntryImages(entry);
        if (index >= images.length) {
            return res.status(404).json({ message: 'No image at that slot.' });
        }

        // Re-attribute this slot only; the other slots keep their own contributor.
        const contributors = getEntryContributors(entry);
        contributors[index] = {
            name: contributorName,
            id: (contributors[index] && contributors[index].id) || null
        };
        entry.imageContributors = contributors;
        syncPrimaryContributor(entry); // keep the legacy top-level field aligned to slot 0
        await entry.save();

        res.json({ message: 'Contributor updated.', data: entry });
    } catch (error) {
        console.error('Update Contributor Error:', error);
        res.status(500).json({ message: 'Server error while updating contributor.' });
    }
});

/* =========================
 * AIRPORT IMAGES API
 * ========================= */

// POST: Upload Airport Image
app.post('/api/airports', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const { icao, contributorName } = req.body;

        if (!req.file || !icao) {
            if (req.file) fs.unlink(req.file.path, () => {});
            return res.status(400).json({ message: 'ICAO and Image are required.' });
        }

        const imageUrl = await uploadAirportImage(s3Client, req.file, icao, contributorName);
        
        res.status(201).json({ 
            message: 'Airport image uploaded!', 
            url: imageUrl 
        });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        console.error('Airport Upload Error:', error);
        res.status(500).json({ message: 'Error uploading airport image.' });
    }
});

// GET: Lookup Airport Info
app.get('/api/airports/:icao', async (req, res) => {
    try {
        const info = await getAirportInfo(s3Client, req.params.icao);
        if (!info) {
            return res.status(404).json({ message: 'No image found for this airport.' });
        }
        res.json(info);
    } catch (error) {
        console.error('Airport Lookup Error:', error);
        res.status(500).json({ message: 'Error fetching airport info.' });
    }
});

// ICAO -> [lat, lon] for the majors, shared with the flight-event route map
// (vaEventCardImage.js loads the same file). Powers /api/airport/:icao below.
let AIRPORT_COORDS = {};
try { AIRPORT_COORDS = require('./data/airport-coords.json'); } catch { AIRPORT_COORDS = {}; }

// GET /api/airport/:icao — PUBLIC. The embed's airport window (aerial hero, hub
// pins, on-map runway/taxiway layout) needs the field's coordinates; everything
// else on that view is client-side (OSM + Esri imagery). CORS-open like
// /api/embed/resolve (global cors() sends Access-Control-Allow-Origin: *).
// See EMBEDBACKEND.md §3.
app.get('/api/airport/:icao', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    const icao = String(req.params.icao || '').trim().toUpperCase();
    const coords = AIRPORT_COORDS[icao];
    if (!coords || !Array.isArray(coords) || coords.length < 2) {
        return res.status(404).json({ ok: false, error: 'unknown airport' });
    }
    const [latitude, longitude] = coords;
    // name defaults to the ICAO (the coord set is code-keyed only); lat/lon are
    // what the client actually requires. Aliases lat/lon are sent too so either
    // field name the widget reads resolves.
    res.json({ ok: true, icao, name: icao, latitude, longitude, lat: latitude, lon: longitude });
});

/**
 * DELETE: Remove all images/data for an airport
 */
app.delete('/api/airports/:icao', requireAuth, async (req, res) => {
    try {
        const success = await deleteAirportImages(s3Client, req.params.icao);
        if (!success) return res.status(404).json({ message: 'No images found for this ICAO.' });
        
        res.json({ message: `All data for ${req.params.icao.toUpperCase()} deleted successfully.` });
    } catch (error) {
        console.error('Airport Delete Error:', error);
        res.status(500).json({ message: 'Error deleting airport data.' });
    }
});

// GET: Fetch all airports that have images
app.get('/api/airports', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Prefix: 'airports/', // Look in the airports folder
        });

        const data = await s3Client.send(command);
        
        if (!data.Contents) return res.json([]);

        // Filter for .webp or .png files and extract ICAO from filename
        // Filename format: airports/icao-timestamp.webp
        const airportList = data.Contents
            .filter(item => item.Key.includes('-'))
            .map(item => {
                const filename = item.Key.split('/').pop();
                const icao = filename.split('-')[0].toUpperCase();
                return {
                    icao: icao,
                    imageUrl: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`,
                    lastUpdated: item.LastModified
                };
            });

        // Remove duplicates (if multiple images exist for one ICAO)
        const uniqueAirports = Array.from(new Map(airportList.map(item => [item.icao, item])).values());

        res.json(uniqueAirports);
    } catch (error) {
        console.error('Error fetching airport list:', error);
        res.status(500).json({ message: 'Error fetching gallery.' });
    }
});

/**
 * PUT: Update airport data or replace image
 */
app.put('/api/airports/:icao', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const { icao } = req.params;
        const { contributorName } = req.body;

        // SCENARIO 1: Replacing the image
        if (req.file) {
            // Delete old images first to keep bucket clean
            await deleteAirportImages(s3Client, icao);
            // Upload new one
            const newUrl = await uploadAirportImage(s3Client, req.file, icao, contributorName);
            return res.json({ message: 'Airport image replaced!', url: newUrl });
        }

        // SCENARIO 2: Updating metadata only (Contributor name)
        if (contributorName) {
            await updateAirportMetadata(s3Client, icao, contributorName);
            return res.json({ message: 'Airport contributor updated!' });
        }

        res.status(400).json({ message: 'Provide a new image or contributor name to update.' });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        console.error('Airport Update Error:', error);
        res.status(500).json({ message: 'Error updating airport data.' });
    }
});

/* =========================
 * VIRTUAL AIRLINE ADVERTISEMENT API
 *
 * A directory of Infinite Flight VAs/VOs. Public visitors see only `approved`
 * ads; admins manage moderation. Banner + logo are uploaded as multipart and
 * optimized to WebP via vaAds.js.
 * ========================= */

// Multer config for VA ads: one banner + one logo.
const uploadVaImages = upload.fields([
    { name: 'banner', maxCount: 1 },
    { name: 'logo', maxCount: 1 }
]);

// Helper: parse a field that may arrive as a JSON array string, a comma-separated
// string, or an already-parsed array (depending on how the client sends it).
const parseListField = (value) => {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (typeof value !== 'string' || !value.trim()) return [];
    const raw = value.trim();
    if (raw.startsWith('[')) {
        try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr.map(v => String(v).trim()).filter(Boolean);
        } catch (_) { /* fall through to CSV parsing */ }
    }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
};

// Helper: pull a single uploaded file (banner/logo) out of a multer .fields() req.
const getUploadedField = (req, field) =>
    (req.files && Array.isArray(req.files[field]) && req.files[field][0]) || null;

// Helper: announce a newly added VA ad to Discord (optional; admin-authored).
const sendVaAdWebhook = async (ad) => {
    if (!process.env.DISCORD_WEBHOOK_URL) return;
    try {
        const payload = {
            embeds: [{
                title: '📣 New VA Advertisement Added',
                description: ad.tagline || ad.description?.slice(0, 200) || 'No description provided.',
                color: 3447003, // Blue
                fields: [
                    { name: 'Name', value: ad.name, inline: true },
                    { name: 'Type', value: ad.type, inline: true },
                    { name: 'Callsign', value: formatCallsignDisplay(ad.callsign) || '—', inline: true },
                    { name: 'Region', value: ad.region || '—', inline: true },
                    { name: 'Recruiting', value: ad.recruiting ? 'Yes' : 'No', inline: true },
                    { name: 'Status', value: ad.status, inline: true }
                ],
                image: ad.bannerUrl ? { url: ad.bannerUrl } : undefined,
                thumbnail: ad.logoUrl ? { url: ad.logoUrl } : undefined,
                timestamp: new Date().toISOString(),
                footer: { text: 'VA Advertisement System' }
            }]
        };
        await axios.post(process.env.DISCORD_WEBHOOK_URL, payload);
        console.log(`🔔 VA ad added: ${ad.name}`);
    } catch (error) {
        console.error('❌ Failed to send VA ad webhook:', error.message);
    }
};

// GET: List VA ads.
//   ?status=approved|pending|rejected|all   (default: approved — the public view)
//   ?region=Asia                            filter by region (case-insensitive)
//   ?type=VA|VO
//   ?recruiting=true|false
//   ?featured=true
//   ?icao=VABB                              only VAs that hub at this airport (one or more, comma-separated)
//   ?search=text                            full-text search across name/tagline/description/tags
//   ?page=1&limit=20                         pagination (limit capped at 100)
//   ?sort=newest|oldest|popular|name        (default: featured first, then newest)
app.get('/api/va-ads', async (req, res) => {
    try {
        const {
            status = 'approved',
            region,
            type,
            recruiting,
            featured,
            icao,
            search,
            sort
        } = req.query;

        const query = {};

        // status=all returns everything (admin view); otherwise filter to one status.
        if (status && status !== 'all') {
            if (!VA_AD_STATUSES.includes(status)) {
                return res.status(400).json({ message: `Invalid status. Use one of: ${VA_AD_STATUSES.join(', ')}, all.` });
            }
            query.status = status;
        }
        if (region) query.region = { $regex: `^${region}$`, $options: 'i' };
        if (type && VA_AD_TYPES.includes(type)) query.type = type;
        // icao: match VAs whose hub list contains the airport(s). hubs are stored
        // uppercased on save, so normalize the query the same way. Accepts a single
        // ICAO or a comma-separated list (e.g. ?icao=VABB,VIDP).
        if (icao && icao.trim()) {
            const codes = icao.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
            if (codes.length) query.hubs = { $in: codes };
        }
        if (recruiting === 'true') query.recruiting = true;
        if (recruiting === 'false') query.recruiting = false;
        if (featured === 'true') query.featured = true;
        if (search && search.trim()) query.$text = { $search: search.trim() };

        // Pagination
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
        const skip = (page - 1) * limit;

        // Sorting
        let sortSpec;
        switch ((sort || '').toLowerCase()) {
            case 'oldest': sortSpec = { createdAt: 1 }; break;
            case 'popular': sortSpec = { views: -1, clicks: -1 }; break;
            case 'name': sortSpec = { name: 1 }; break;
            case 'newest': sortSpec = { createdAt: -1 }; break;
            default: sortSpec = { featured: -1, createdAt: -1 }; // default: pinned first, then newest
        }

        const [ads, total] = await Promise.all([
            VirtualAirlineAd.find(query).sort(sortSpec).skip(skip).limit(limit).lean(),
            VirtualAirlineAd.countDocuments(query)
        ]);

        res.json({
            data: ads,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error('VA Ads List Error:', error);
        res.status(500).json({ message: 'Error fetching VA advertisements.' });
    }
});

// GET: Banner(s) for an airport.
// Convenience endpoint for embedding a VA banner on an airport page/screen:
// returns the approved, banner-having VAs that hub at :icao, featured first.
//   ?pick=random   return a single randomly-chosen ad (good for rotating slots)
//   ?limit=N       cap how many ads come back (default 10, max 50)
// Declared before '/api/va-ads/:id' for clarity (the two routes have different
// segment counts, so Express wouldn't confuse them either way).
app.get('/api/va-ads/banner/:icao', async (req, res) => {
    try {
        const code = String(req.params.icao || '').trim().toUpperCase();
        if (!code) return res.status(400).json({ message: 'ICAO is required.' });

        const query = {
            status: 'approved',
            hubs: code,
            bannerUrl: { $ne: null }
        };

        if ((req.query.pick || '').toLowerCase() === 'random') {
            // Sample one at random so an airport slot can rotate between VAs.
            const [ad] = await VirtualAirlineAd.aggregate([
                { $match: query },
                { $sample: { size: 1 } }
            ]);
            if (!ad) return res.status(404).json({ message: `No VA banners found for ${code}.` });
            return res.json({ icao: code, data: ad });
        }

        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50));
        const ads = await VirtualAirlineAd
            .find(query)
            .sort({ featured: -1, createdAt: -1 })
            .limit(limit)
            .lean();

        res.json({ icao: code, count: ads.length, data: ads });
    } catch (error) {
        console.error('VA Ad Banner Error:', error);
        res.status(500).json({ message: 'Error fetching VA banners for airport.' });
    }
});

// GET: Crew Center branding by slug — powers the branded login served at
// inflight.info/crew/<slug>. Public + CORS-open (global cors() sends
// Access-Control-Allow-Origin: *), returns ONLY presentational fields (never any
// secret). Resolves by slug first, then falls back to callsign so existing VAs
// work before their slugs are backfilled (e.g. /crew/aca). Accent comes from the
// VA's embed config (its brand colour) when present, else empty so the login can
// derive one from the logo. Registered before /api/va-ads/:id — matched by the
// two-segment path, so it never collides with the id route.
app.get('/api/va-ads/by-slug/:slug', async (req, res) => {
    try {
        const raw = String(req.params.slug || '').trim().toLowerCase();
        if (!raw) return res.status(404).json({ message: 'Unknown crew center.' });

        const fields = 'name slug callsign tagline logoUrl bannerUrl websiteUrl layout allowedLayouts loginLook crewTopicMode crewAccent ranks roles crewFleet crewPirepAutoApprove crewSchedule joinMode minGrade callsignPrefix applicationForm joinRequirements crewEmailConfigured crewDiscordInvite supabaseUrl supabaseAnonKey';
        let ad = await VirtualAirlineAd.findOne({ slug: raw, status: 'approved' })
            .select(fields).lean();
        if (!ad) {
            ad = await VirtualAirlineAd.findOne({ callsign: raw.toUpperCase(), status: 'approved' })
                .select(fields).lean();
        }
        if (!ad) return res.status(404).json({ message: 'Unknown crew center.' });

        // Brand accent: the VA's own crewAccent wins; otherwise the embed-config
        // accent's first stop, then the legacy brandColor; '' means "decide".
        let accent = ad.crewAccent || '';
        if (!accent) {
            const cfg = await EmbedConfig.findOne({ vaAdId: ad._id }).select('accent brandColor').lean();
            if (cfg) accent = (Array.isArray(cfg.accent) && cfg.accent[0]) || cfg.brandColor || '';
        }

        // Daily statistics: one Crew Center load. Cached for 5 minutes below, so
        // this under-counts repeat visits from the same browser — it's a floor,
        // which is the honest read for a cached endpoint.
        vaStats.recordEngagement(ad._id, 'crewCenter', 1, ad.name);

        res.set('Cache-Control', 'public, max-age=300'); // 5 min — branding rarely changes
        res.json({
            slug: ad.slug || null,
            code: ad.callsign || null,
            name: ad.name,
            tagline: ad.tagline || '',
            logo: ad.logoUrl || '',
            banner: ad.bannerUrl || '',
            website: ad.websiteUrl || '',
            accent,
            layout: ad.layout || 'editorial',
            allowedLayouts: (Array.isArray(ad.allowedLayouts) && ad.allowedLayouts.length)
                ? ad.allowedLayouts : ['editorial', 'console', 'split', 'classic'],
            loginLook: ad.loginLook || 'center',
            // The crew's default for how a topic opens. Public for the same
            // reason the layout is: the crew center reads it before it has a
            // session, and it decides how the page is laid out on first paint.
            topicMode: ad.crewTopicMode || 'sheet',
            ranks: Array.isArray(ad.ranks) ? ad.ranks : [],
            roles: Array.isArray(ad.roles) ? ad.roles : [],
            fleet: Array.isArray(ad.crewFleet) ? ad.crewFleet : [],
            pirepAutoApprove: !!ad.crewPirepAutoApprove,
            // How this VA runs its schedule. Public because the crew center
            // reads it before it has a session — a VA that does not use the
            // schedule should not show a Schedule button to a signed-out
            // visitor either. Nothing here is a secret; it is the same class of
            // thing as the rank ladder sitting above it.
            schedule: crewSchedules.publicRules(ad.crewSchedule),
            join: {
                mode: ad.joinMode || 'application',
                minGrade: ad.minGrade || 0,
                callsignPrefix: ad.callsignPrefix || ad.callsign || '',
                form: Array.isArray(ad.applicationForm) ? ad.applicationForm : [],
                requirements: Array.isArray(ad.joinRequirements) ? ad.joinRequirements : [],
                emailEnabled: !!ad.crewEmailConfigured,
                // The VA's default Discord invite. Public by nature (it is
                // meant to be shared) and read by the dashboard so the accept
                // dialog can pre-fill it.
                discordInvite: ad.crewDiscordInvite || '',
            },
            // Public Supabase connection (never the secret service key).
            supabase: {
                url: ad.supabaseUrl || '',
                anonKey: ad.supabaseAnonKey || '',
                connected: !!(ad.supabaseUrl && ad.supabaseAnonKey),
            },
        });
    } catch (err) {
        console.error('Crew center by-slug error:', err);
        res.status(500).json({ message: 'Error resolving crew center.' });
    }
});

// ---- Crew Center admin (staff hub "Crew Centers" tool) ----
// List VAs with their crew center handle + account counts, for the staff manager.
app.get('/api/crew-admin/vas', requireAuth, async (req, res) => {
    try {
        const search = String(req.query.search || '').trim();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 300));
        const query = {};
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { callsign: { $regex: `^${search}`, $options: 'i' } },
                { slug: { $regex: search, $options: 'i' } },
            ];
        }
        const ads = await VirtualAirlineAd.find(query)
            .select('name callsign slug logoUrl bannerUrl status layout allowedLayouts')
            .sort({ name: 1 }).limit(limit).lean();

        // Portal-account counts per VA, grouped by role (owner/staff/pilot).
        const VaPortalAccount = mongoose.model('VaPortalAccount');
        const ids = ads.map(a => a._id);
        const grouped = ids.length ? await VaPortalAccount.aggregate([
            { $match: { vaAdId: { $in: ids }, active: true } },
            { $group: { _id: { va: '$vaAdId', role: '$role' }, n: { $sum: 1 } } },
        ]) : [];
        const byVa = {};
        for (const g of grouped) {
            const k = String(g._id.va);
            (byVa[k] = byVa[k] || {})[g._id.role] = g.n;
        }

        res.json({
            vas: ads.map(a => ({
                id: a._id, name: a.name, code: a.callsign || null, slug: a.slug || null,
                logo: a.logoUrl || '', banner: a.bannerUrl || '', status: a.status,
                layout: a.layout || 'editorial',
                allowedLayouts: (a.allowedLayouts && a.allowedLayouts.length) ? a.allowedLayouts : ['editorial','console','split','classic'],
                accounts: byVa[String(a._id)] || {},
            })),
        });
    } catch (err) {
        console.error('crew-admin list error:', err);
        res.status(500).json({ error: 'Could not load crew centers.' });
    }
});

// Update a VA's crew center slug (URL handle). A blank value re-derives it from
// the VA name. The model's pre-save hook slugifies the value and guarantees
// uniqueness, so we just set it and save; the response returns the final slug.
app.patch('/api/crew-admin/vas/:id', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id);
        if (!ad) return res.status(404).json({ error: 'VA not found.' });
        if (typeof req.body.slug === 'string') {
            ad.slug = req.body.slug.trim() || null;
        }
        // Which layout presets this VA may choose from (staff allow-list).
        const CREW_LAYOUTS = ['editorial', 'console', 'split', 'classic'];
        if (Array.isArray(req.body.allowedLayouts)) {
            const allowed = req.body.allowedLayouts
                .map(l => String(l).toLowerCase()).filter(l => CREW_LAYOUTS.includes(l));
            ad.allowedLayouts = allowed.length ? [...new Set(allowed)] : ['editorial'];
            if (!ad.allowedLayouts.includes(ad.layout || 'editorial')) ad.layout = ad.allowedLayouts[0];
        }
        if (typeof req.body.layout === 'string') {
            const l = req.body.layout.toLowerCase();
            const allowed = (Array.isArray(ad.allowedLayouts) && ad.allowedLayouts.length) ? ad.allowedLayouts : CREW_LAYOUTS;
            if (CREW_LAYOUTS.includes(l) && allowed.includes(l)) ad.layout = l;
        }
        await ad.save();
        res.json({
            id: ad._id, name: ad.name, code: ad.callsign || null, slug: ad.slug || null,
            layout: ad.layout || 'editorial',
            allowedLayouts: (ad.allowedLayouts && ad.allowedLayouts.length) ? ad.allowedLayouts : CREW_LAYOUTS,
        });
    } catch (err) {
        console.error('crew-admin patch error:', err);
        res.status(500).json({ error: 'Could not update the crew center address.' });
    }
});

// GET: A single VA ad by id.
//   ?track=view   atomically increment the view counter (for the detail page).
app.get('/api/va-ads/:id', async (req, res) => {
    try {
        const ad = req.query.track === 'view'
            ? await VirtualAirlineAd.findByIdAndUpdate(
                req.params.id, { $inc: { views: 1 } }, { new: true }
            ).lean()
            : await VirtualAirlineAd.findById(req.params.id).lean();

        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        // A tracked fetch is the VA's detail panel being opened — the same event
        // the daily report calls a "profile view".
        if (req.query.track === 'view') vaStats.recordEngagement(ad._id, 'profile', 1, ad.name);
        res.json(ad);
    } catch (error) {
        console.error('VA Ad Fetch Error:', error);
        res.status(500).json({ message: 'Error fetching VA advertisement.' });
    }
});

// POST: Submit a new VA ad (multipart: banner + logo + fields).
app.post('/api/va-ads', requireAuth, uploadVaImages, async (req, res) => {
    const bannerFile = getUploadedField(req, 'banner');
    const logoFile = getUploadedField(req, 'logo');
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            cleanupTempFiles([bannerFile, logoFile].filter(Boolean));
            return res.status(400).json({ message: 'VA name is required.' });
        }

        // Reject duplicate names early (the schema also enforces this).
        const existing = await VirtualAirlineAd.findOne({ name: name.trim() }).lean();
        if (existing) {
            cleanupTempFiles([bannerFile, logoFile].filter(Boolean));
            return res.status(409).json({ message: 'A VA with that name has already been submitted.' });
        }

        // Accept either a single `callsign` or a `callsigns` list (the new
        // multi-callsign field). The pre-save hook reconciles the two.
        const callsigns = parseListField(req.body.callsigns).map(cleanCallsignInput).filter(Boolean);
        const callsign = cleanCallsignInput(req.body.callsign) || callsigns[0] || null;
        if (callsign && !callsigns.length) callsigns.push(callsign);
        const ref = callsign || name;
        const bannerUrl = bannerFile ? await uploadVaImage(s3Client, bannerFile, ref, 'banner') : null;
        const logoUrl = logoFile ? await uploadVaImage(s3Client, logoFile, ref, 'logo') : null;

        const ad = new VirtualAirlineAd({
            name: name.trim(),
            callsign,
            callsigns,
            type: VA_AD_TYPES.includes(req.body.type) ? req.body.type : 'VA',
            tagline: req.body.tagline,
            description: req.body.description,
            bannerUrl,
            logoUrl,
            websiteUrl: req.body.websiteUrl || null,
            discordUrl: req.body.discordUrl || null,
            ifcThreadUrl: req.body.ifcThreadUrl || null,
            applicationUrl: req.body.applicationUrl || null,
            region: req.body.region || 'Global',
            hubs: parseListField(req.body.hubs).map(h => h.toUpperCase()),
            fleet: parseListField(req.body.fleet),
            pilotCount: parseInt(req.body.pilotCount, 10) || 0,
            recruiting: req.body.recruiting === undefined ? true : req.body.recruiting !== 'false',
            minGrade: req.body.minGrade ? parseInt(req.body.minGrade, 10) : 0,
            requirements: req.body.requirements,
            tags: parseListField(req.body.tags),
            ownerName: req.body.ownerName || 'Unknown',
            ownerId: req.body.ownerId || null,
            contactEmail: req.body.contactEmail || null,
            // Admin-authored, so default to live; pass status to stage a draft.
            status: VA_AD_STATUSES.includes(req.body.status) ? req.body.status : 'approved'
        });

        await ad.save();
        await sendVaAdWebhook(ad);

        res.status(201).json({ message: 'VA advertisement created.', data: ad });
    } catch (error) {
        cleanupTempFiles([bannerFile, logoFile].filter(Boolean));
        if (error.code === 11000) {
            return res.status(409).json({ message: 'A VA with that name already exists.' });
        }
        if (error && error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('VA Ad Create Error:', error);
        res.status(500).json({ message: 'Server error while creating VA advertisement.' });
    }
});

// PUT: Update an existing VA ad. Any provided field is updated; banner/logo are
// replaced (old S3 image deleted) only when a new file is uploaded.
app.put('/api/va-ads/:id', requireAuth, uploadVaImages, async (req, res) => {
    const bannerFile = getUploadedField(req, 'banner');
    const logoFile = getUploadedField(req, 'logo');
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id);
        if (!ad) {
            cleanupTempFiles([bannerFile, logoFile].filter(Boolean));
            return res.status(404).json({ message: 'VA advertisement not found.' });
        }

        const ref = req.body.callsign || ad.callsign || req.body.name || ad.name;

        // Replace images if new ones were sent.
        if (bannerFile) {
            const newUrl = await uploadVaImage(s3Client, bannerFile, ref, 'banner');
            if (ad.bannerUrl) await deleteVaImage(s3Client, ad.bannerUrl);
            ad.bannerUrl = newUrl;
        }
        if (logoFile) {
            const newUrl = await uploadVaImage(s3Client, logoFile, ref, 'logo');
            if (ad.logoUrl) await deleteVaImage(s3Client, ad.logoUrl);
            ad.logoUrl = newUrl;
        }

        // Scalar/text fields: only overwrite when the key is present in the body.
        const b = req.body;
        if (b.name !== undefined) ad.name = b.name.trim();
        // callsigns[] is authoritative; a lone legacy `callsign` maps into it so
        // the pre-save reconciliation doesn't silently revert the edit.
        if (b.callsigns !== undefined) {
            ad.callsigns = parseListField(b.callsigns).map(cleanCallsignInput).filter(Boolean);
        } else if (b.callsign !== undefined) {
            const cs = cleanCallsignInput(b.callsign);
            ad.callsigns = cs ? [cs] : [];
        }
        if (b.callsign !== undefined) ad.callsign = cleanCallsignInput(b.callsign);
        if (b.type !== undefined && VA_AD_TYPES.includes(b.type)) ad.type = b.type;
        if (b.tagline !== undefined) ad.tagline = b.tagline;
        if (b.description !== undefined) ad.description = b.description;
        if (b.websiteUrl !== undefined) ad.websiteUrl = b.websiteUrl || null;
        if (b.discordUrl !== undefined) ad.discordUrl = b.discordUrl || null;
        if (b.ifcThreadUrl !== undefined) ad.ifcThreadUrl = b.ifcThreadUrl || null;
        if (b.applicationUrl !== undefined) ad.applicationUrl = b.applicationUrl || null;
        if (b.region !== undefined) ad.region = b.region || 'Global';
        if (b.hubs !== undefined) ad.hubs = parseListField(b.hubs).map(h => h.toUpperCase());
        if (b.fleet !== undefined) ad.fleet = parseListField(b.fleet);
        if (b.pilotCount !== undefined) ad.pilotCount = parseInt(b.pilotCount, 10) || 0;
        if (b.recruiting !== undefined) ad.recruiting = b.recruiting !== 'false' && b.recruiting !== false;
        if (b.minGrade !== undefined) ad.minGrade = b.minGrade ? parseInt(b.minGrade, 10) : 0;
        if (b.requirements !== undefined) ad.requirements = b.requirements;
        if (b.tags !== undefined) ad.tags = parseListField(b.tags);
        if (b.ownerName !== undefined) ad.ownerName = b.ownerName || 'Unknown';
        if (b.contactEmail !== undefined) ad.contactEmail = b.contactEmail || null;
        if (b.status !== undefined && VA_AD_STATUSES.includes(b.status)) ad.status = b.status;
        if (b.featured !== undefined) ad.featured = b.featured === true || b.featured === 'true';
        // Staff approval gate for VA-managed flight-event delivery (requested in
        // the portal). Approving without a webhook on file is harmless — nothing
        // sends until the VA has also saved one.
        if (b.flightEventsApproved !== undefined) ad.flightEventsApproved = b.flightEventsApproved === true || b.flightEventsApproved === 'true';

        await ad.save();

        // Keep linked embeds in sync with the head: push the ad's name/logo onto
        // every embed that points at it (and adopt embeds newly matched by a
        // just-edited callsign). Fire-and-forget — never block the ad save on it.
        syncEmbedsToAd(ad).catch((e) => console.error('embed sync on ad update:', e.message));

        res.json({ message: 'VA advertisement updated.', data: ad });
    } catch (error) {
        cleanupTempFiles([bannerFile, logoFile].filter(Boolean));
        if (error.code === 11000) {
            return res.status(409).json({ message: 'A VA with that name already exists.' });
        }
        if (error && error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('VA Ad Update Error:', error);
        res.status(500).json({ message: 'Server error while updating VA advertisement.' });
    }
});

// PATCH: Moderate an ad — set its status to approved/rejected/pending.
app.patch('/api/va-ads/:id/status', requireAuth, async (req, res) => {
    try {
        const { status } = req.body;
        if (!VA_AD_STATUSES.includes(status)) {
            return res.status(400).json({ message: `Status must be one of: ${VA_AD_STATUSES.join(', ')}.` });
        }
        const ad = await VirtualAirlineAd.findByIdAndUpdate(
            req.params.id, { status }, { new: true }
        );
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        res.json({ message: `VA advertisement ${status}.`, data: ad });
    } catch (error) {
        console.error('VA Ad Status Error:', error);
        res.status(500).json({ message: 'Server error while updating status.' });
    }
});

// PATCH: Toggle (or set) the featured flag to pin an ad to the top.
app.patch('/api/va-ads/:id/feature', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id);
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });

        // Accept an explicit boolean, otherwise flip the current value.
        ad.featured = typeof req.body.featured === 'boolean' ? req.body.featured : !ad.featured;
        await ad.save();
        res.json({ message: `Featured set to ${ad.featured}.`, data: ad });
    } catch (error) {
        console.error('VA Ad Feature Error:', error);
        res.status(500).json({ message: 'Server error while toggling featured.' });
    }
});

// Shape the (secret-free) flight-event webhook status for a VA ad. The raw URL
// is never returned — only whether one is configured plus a masked hint.
const flightEventsStatus = (ad) => ({
    id: ad._id,
    name: ad.name || ad.callsign || '',
    code: ad.callsign || (ad.callsigns && ad.callsigns[0]) || '',
    configured: !!ad.flightEventsWebhookUrl,
    hint: maskWebhookUrl(ad.flightEventsWebhookUrl),
    enabled: !!ad.flightEventsEnabled,
    approved: !!ad.flightEventsApproved,
    requestedAt: ad.flightEventsRequestedAt || null,
    // The (normalized) card customization, so editors can render the current state.
    card: normalizeCardOptions(ad.flightEventsCard || {}),
});

// GET: Diagnose why a live callsign did/didn't deliver to a partner webhook.
// STAFF. Paste the exact callsign you saw flying and this reports the bases we
// reduce it to, the VA that owns one of those bases (ignoring the opt-in gates),
// and the precise gate that's blocking delivery — so a silent miss becomes a
// one-line answer. Declared before '/api/va-ads/:id/...' but the 'flight-events'
// literal segment keeps the two from colliding.
app.get('/api/va-ads/flight-events/diagnose', requireAuth, async (req, res) => {
    try {
        const callsign = String(req.query.callsign || '').trim();
        if (!callsign) {
            return res.status(400).json({ message: 'Pass ?callsign=… (the live callsign you saw flying).' });
        }
        const basesTried = [...new Set([
            normalizeCallsignBase(callsign),
            callsignAirlineBase(callsign),
        ].filter(Boolean))];

        const ad = await VirtualAirlineAd.findOne({ callsigns: { $in: callsignQueryVariants(basesTried) } })
            .select('+flightEventsWebhookUrl name callsigns flightEventsApproved flightEventsEnabled flightEventsRequestedAt')
            .lean();

        if (!ad) {
            return res.json({
                callsign, basesTried, matched: false, reason: 'no_va_owns_this_callsign',
                hint: 'No VA in the directory has any of these base callsigns. Check the VA’s stored callsign(s) — they must be the base, e.g. "OCEAN".',
            });
        }

        const configured = !!ad.flightEventsWebhookUrl;
        // Delivery no longer re-checks the live callsign format — the ACARS sender
        // already attributed the flight to this VA, so the only gates left are the
        // opt-in ones. We still report whether the callsign fits "<base> ###VA" as
        // informational (it can explain why the SENDER didn't attribute a flight),
        // but it never blocks delivery here.
        const callsignFitsFormat = !!matchVaCallsign(callsign, ad.callsigns);
        let reason = 'would_deliver';
        if (!configured) reason = 'no_webhook_saved';
        else if (!ad.flightEventsApproved) reason = 'not_approved';
        else if (!ad.flightEventsEnabled) reason = 'disabled';

        // Point at whatever is actually blocking delivery. The opt-in gates are
        // the only blockers now; the callsign format is informational only.
        const hints = {
            no_webhook_saved: `${ad.name} has no Discord webhook saved. Paste one in the VA portal (Flight events).`,
            not_approved: `${ad.name}'s flight events aren't approved yet. Approve them in the VA Ads manager.`,
            disabled: `${ad.name} has flight events turned off. Re-enable them in the VA portal.`,
        };

        res.json({
            callsign, basesTried, matched: true,
            va: { id: ad._id, name: ad.name, callsigns: ad.callsigns || [] },
            approved: !!ad.flightEventsApproved,
            enabled: !!ad.flightEventsEnabled,
            configured,
            callsignFitsFormat,
            webhookHint: maskWebhookUrl(ad.flightEventsWebhookUrl),
            reason,
            ...(hints[reason] ? { hint: hints[reason] } : {}),
        });
    } catch (err) {
        console.error('VA Ad flight-events diagnose error:', err);
        res.status(500).json({ message: 'Diagnose failed.' });
    }
});

// GET: Resolve the VA ad a code/callsign belongs to and return its flight-event
// webhook status. STAFF. Lets the embed manager light up the webhook panel from
// the embed's stored va.code alone — server-side, so it doesn't depend on the
// client-side directory list (which is paged) re-finding the VA on reopen.
app.get('/api/va-ads/flight-events/by-code', requireAuth, async (req, res) => {
    try {
        const code = String(req.query.code || '').trim();
        if (!code) return res.status(400).json({ message: 'Pass ?code=…' });
        const bases = [...new Set([normalizeCallsignBase(code), callsignAirlineBase(code)].filter(Boolean))];

        const sel = '+flightEventsWebhookUrl name callsign callsigns flightEventsEnabled flightEventsApproved flightEventsRequestedAt flightEventsCard';
        // Prefer a base-callsign match; fall back to an exact (case-insensitive)
        // name match so embeds linked by name still resolve.
        let ad = bases.length
            ? await VirtualAirlineAd.findOne({ callsigns: { $in: callsignQueryVariants(bases) } }).select(sel).lean()
            : null;
        if (!ad) {
            const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            ad = await VirtualAirlineAd.findOne({ name: new RegExp('^' + escaped + '$', 'i') }).select(sel).lean();
        }
        if (!ad) return res.status(404).json({ message: 'No VA ad found for that code.', code, basesTried: bases });
        res.json({ data: flightEventsStatus(ad) });
    } catch (err) {
        console.error('VA Ad flight-events by-code error:', err);
        res.status(500).json({ message: 'Lookup failed.' });
    }
});

// GET: Flight-event webhook status for one VA. STAFF. Backs the approval controls
// on the staff home page and in the embed manager (which mirror the same webhook,
// keyed to the VA ad — one source of truth, see VA-ADMIN-MANUAL.md).
app.get('/api/va-ads/:id/flight-events', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id)
            .select('+flightEventsWebhookUrl name callsign callsigns flightEventsEnabled flightEventsApproved flightEventsRequestedAt flightEventsCard')
            .lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        res.json({ data: flightEventsStatus(ad) });
    } catch (error) {
        console.error('VA Ad flight-events status error:', error);
        res.status(500).json({ message: 'Server error while loading flight-event status.' });
    }
});

// PATCH: Update a VA's flight-event webhook. STAFF. Accepts any of:
//   approved   — the staff gate that lets delivery actually fire
//   enabled    — the on/off switch (independent of approval)
//   webhookUrl — set/replace the Discord webhook on the VA's behalf ('' clears it)
// This is the single place staff approve the webhook, shared by the staff home
// page and the embed manager.
app.patch('/api/va-ads/:id/flight-events', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id).select('+flightEventsWebhookUrl');
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });

        const b = req.body || {};
        if (b.webhookUrl !== undefined) {
            const raw = String(b.webhookUrl || '').trim();
            if (raw && !isDiscordWebhookUrl(raw)) {
                return res.status(400).json({ message: 'That doesn’t look like a Discord webhook URL.' });
            }
            ad.flightEventsWebhookUrl = raw || null;
            // Setting a webhook for the first time counts as a request, so it shows
            // up in the approval queue even when staff paste it on the VA's behalf.
            if (raw && !ad.flightEventsRequestedAt) ad.flightEventsRequestedAt = new Date();
        }
        if (b.approved !== undefined) ad.flightEventsApproved = b.approved === true || b.approved === 'true';
        if (b.enabled !== undefined) ad.flightEventsEnabled = b.enabled === true || b.enabled === 'true';
        // Card customization (colours / layout / fields). Normalized before store
        // so an invalid payload can never produce a broken card.
        if (b.card !== undefined) ad.flightEventsCard = normalizeCardOptions(b.card);

        await ad.save();
        res.json({ message: 'Flight-event webhook updated.', data: flightEventsStatus(ad) });
    } catch (error) {
        console.error('VA Ad flight-events update error:', error);
        res.status(500).json({ message: 'Server error while updating flight-event webhook.' });
    }
});

// POST: Fire a sample takeoff card to the VA's saved webhook. STAFF. Lets staff
// confirm the webhook URL itself works without waiting for a real flight — it
// deliberately bypasses approval / enabled / callsign matching, so a success here
// means "the URL is good" and the only remaining variable is the live match.
app.post('/api/va-ads/:id/flight-events/test', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id)
            .select('+flightEventsWebhookUrl name callsign callsigns logoUrl flightEventsCard');
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        if (!ad.flightEventsWebhookUrl) {
            return res.status(400).json({ message: 'No webhook saved for this VA yet.' });
        }
        if (!isDiscordWebhookUrl(ad.flightEventsWebhookUrl)) {
            return res.status(400).json({ message: 'The saved webhook is not a valid Discord webhook URL.' });
        }
        await sendVaTestEvent(ad);
        res.json({ message: 'Test event sent — check the VA’s Discord channel.' });
    } catch (error) {
        const status = error.response && error.response.status;
        console.error('VA Ad flight-events test error:', status || '', error.message);
        res.status(502).json({
            message: status
                ? `Discord rejected the webhook (HTTP ${status}). The URL may be wrong, revoked or deleted.`
                : 'Could not reach the webhook URL.',
        });
    }
});

// POST: Render a live preview of the card for arbitrary (unsaved) options. STAFF.
// Renders only — nothing is posted to Discord — so the manager can show staff how
// the current settings will look before they save.
app.post('/api/va-ads/:id/flight-events/preview', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id)
            .select('name callsign callsigns logoUrl').lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        const preview = await renderCardPreview(ad, (req.body && req.body.card) || {});
        res.json(preview);
    } catch (error) {
        console.error('VA Ad flight-events preview error:', error.message);
        res.status(500).json({ message: 'Could not render a preview.' });
    }
});

// --- VA pilot roster (STAFF) -------------------------------------------------
// A VA's list of Infinite Flight usernames, stored in the VaPilot collection.
// Store-only for now (managed here + in the VA portal); a later change can use
// it to attribute flights to a VA by pilot. All four routes are scoped to the
// VA id in the path so one VA's roster can't touch another's.

// GET: list a VA's roster (optional ?q= search, ?limit=/?skip= paging).
app.get('/api/va-ads/:id/pilots', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id).select('_id').lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        const out = await vaPilots.listPilots(VaPilot, ad._id, {
            q: req.query.q, limit: req.query.limit, skip: req.query.skip,
        });
        res.json(out);
    } catch (error) {
        console.error('VA Ad pilots list error:', error);
        res.status(500).json({ message: 'Server error while loading the pilot roster.' });
    }
});

// POST: add one or many usernames. Body: { usernames } (array | CSV/blob | JSON
// array string). Returns { added, skipped, total }.
app.post('/api/va-ads/:id/pilots', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id).select('_id name').lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        const input = (req.body && (req.body.usernames !== undefined ? req.body.usernames : req.body.username));
        const who = (req.staff && (req.staff.displayName || req.staff.username)) || 'staff';
        const out = await vaPilots.addPilots(VaPilot, ad._id, input, who);
        res.json({ message: `Added ${out.added}, skipped ${out.skipped} duplicate${out.skipped === 1 ? '' : 's'}.`, ...out });
    } catch (error) {
        console.error('VA Ad pilots add error:', error);
        res.status(500).json({ message: 'Server error while adding pilots.' });
    }
});

// DELETE: remove one roster entry by its id.
app.delete('/api/va-ads/:id/pilots/:pilotId', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id).select('_id').lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        const out = await vaPilots.removePilot(VaPilot, ad._id, req.params.pilotId);
        res.json({ message: out.removed ? 'Pilot removed.' : 'Pilot not found.', ...out });
    } catch (error) {
        console.error('VA Ad pilots remove error:', error);
        res.status(500).json({ message: 'Server error while removing the pilot.' });
    }
});

// DELETE: clear a VA's whole roster.
app.delete('/api/va-ads/:id/pilots', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id).select('_id').lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        const out = await vaPilots.clearPilots(VaPilot, ad._id);
        res.json({ message: `Cleared ${out.removed} pilot${out.removed === 1 ? '' : 's'}.`, ...out, total: 0 });
    } catch (error) {
        console.error('VA Ad pilots clear error:', error);
        res.status(500).json({ message: 'Server error while clearing the roster.' });
    }
});

// --- VA pilot roster + events (PUBLIC, read-only) ----------------------------
// No auth: these back a VA's own website, called cross-origin (global cors()
// sends Access-Control-Allow-Origin: *). The :id is the VA's ad id — the same
// one the public GET /api/va-ads listing returns. Only display-safe fields go
// out: the roster drops the addedBy audit trail and row ids, and both routes
// 404 (not 500) on a malformed id.

// GET /api/public/va/:id/pilots?q=&limit=&skip= — the VA's pilot roster.
// Same search/paging as the staff route: q is a case-insensitive username
// match, limit defaults to 500 (max 2000).
app.get('/api/public/va/:id/pilots', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(404).json({ message: 'VA not found.' });
        }
        const ad = await VirtualAirlineAd.findById(req.params.id).select('_id name').lean();
        if (!ad) return res.status(404).json({ message: 'VA not found.' });
        const out = await vaPilots.listPilots(VaPilot, ad._id, {
            q: req.query.q, limit: req.query.limit, skip: req.query.skip,
        });
        res.set('Cache-Control', 'public, max-age=60');
        res.json({
            va: { id: String(ad._id), name: ad.name },
            total: out.total,
            rosterTotal: out.rosterTotal,
            pilots: out.pilots.map(p => ({ username: p.username, addedAt: p.addedAt })),
        });
    } catch (error) {
        console.error('Public VA pilots error:', error);
        res.status(500).json({ message: 'Server error while loading the pilot roster.' });
    }
});

// GET /api/public/va/:id/events — the VA's upcoming events (anything starting
// later than 12h ago), soonest first. Mirrors the portal's window/limit so the
// VA's site and the portal always agree on what "upcoming" means.
app.get('/api/public/va/:id/events', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(404).json({ message: 'VA not found.' });
        }
        const ad = await VirtualAirlineAd.findById(req.params.id).select('_id name').lean();
        if (!ad) return res.status(404).json({ message: 'VA not found.' });
        const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const events = await VaEvent.find({ vaAdId: ad._id, startsAt: { $gte: since } })
            .sort({ startsAt: 1 }).limit(50).lean();
        res.set('Cache-Control', 'public, max-age=60');
        res.json({
            va: { id: String(ad._id), name: ad.name },
            events: events.map(e => ({
                id: String(e._id),
                title: e.title,
                description: e.description || '',
                link: e.link || '',
                departureIcao: e.departureIcao || '',
                bannerUrl: e.bannerUrl || '',
                // Set once the event's formation is airborne and its owner has
                // minted a group link — the tracker turns this into "watch live".
                groupCode: e.groupCode || '',
                startsAt: e.startsAt,
                createdAt: e.createdAt,
            })),
        });
    } catch (error) {
        console.error('Public VA events error:', error);
        res.status(500).json({ message: 'Server error while loading events.' });
    }
});

// GET /api/public/va-events/upcoming — EVERY partner VA's upcoming events in
// one response, each carrying enough of its VA (name, logo, accent) to be drawn
// without a second lookup.
//
// The per-VA route above is the right shape for a VA's own site; the live map
// needs the opposite — every VA at once — and asking it per VA would be one
// request per partner on a map that may be showing dozens. Only events with a
// departure airport are returned, since a map pin has to go somewhere.
//   ?window=<hours>  how far ahead to look (default 72, max 336)
/* ---------------------------------------------------------------------------
 * Crew centre events, for the live map
 *
 * The feed below has only ever carried VaEvent rows — the ones a VA creates on
 * its directory listing. A VA that runs a crew centre builds its calendar
 * THERE, in its own Supabase project, and none of it reached the map. Two event
 * systems, one of them invisible.
 *
 * Reading them means one query per connected VA, which is why this is cached
 * hard and bounded: the map asks on every load, and a hundred partner VAs must
 * not become a hundred round trips to a hundred different databases behind one
 * public request.
 *
 * Failure is per-VA and silent. One airline's project being asleep is not a
 * reason for the map to lose everybody else's events.
 * ------------------------------------------------------------------------- */
let _crewMapEventCache = { at: 0, events: [] };
const CREW_MAP_EVENT_TTL_MS = 5 * 60 * 1000;
const CREW_MAP_EVENT_VA_CAP = 120;      // partner VAs read per refresh
const CREW_MAP_EVENT_CONCURRENCY = 8;

async function crewCentreMapEvents(sinceMs, untilMs) {
    if (Date.now() - _crewMapEventCache.at < CREW_MAP_EVENT_TTL_MS) return _crewMapEventCache.events;

    const vas = await VirtualAirlineAd.find({
        status: 'approved',
        slug: { $nin: ['', null] },
        supabaseUrl: { $nin: ['', null] },
    }).select('_id name slug logoUrl callsign supabaseUrl supabaseServiceKey').limit(CREW_MAP_EVENT_VA_CAP).lean();

    const out = [];
    for (let i = 0; i < vas.length; i += CREW_MAP_EVENT_CONCURRENCY) {
        const batch = vas.slice(i, i + CREW_MAP_EVENT_CONCURRENCY);
        await Promise.all(batch.map(async (va) => {
            try {
                const store = await crewStore.forVaOrNull(va);
                if (!store) return;
                const events = await store.listEvents({ upcomingOnly: true });
                for (const e of events || []) {
                    if (e.status !== 'published') continue;      // drafts are not public
                    const t = new Date(e.startsAt).getTime();
                    if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
                    const icao = crewEvents.gateAirport(e);
                    if (!icao) continue;                          // a pin has to go somewhere
                    out.push({
                        id: `crew:${va.slug}:${e._id}`,
                        source: 'crew',
                        title: e.title,
                        description: e.description || '',
                        // Straight to the event in the VA's own crew centre.
                        link: `/crew/${encodeURIComponent(va.slug)}?event=${encodeURIComponent(e._id)}`,
                        departureIcao: String(icao).toUpperCase(),
                        arrivalIcao: String(e.destination || '').toUpperCase(),
                        bannerUrl: e.bannerUrl || '',
                        groupCode: '',
                        startsAt: e.startsAt,
                        aircraft: e.aircraft || '',
                        flightNumber: e.flightNumber || '',
                        // What makes a crew-centre event worth pinning rather
                        // than merely listing: you can see the stands.
                        gates: { open: !!e.gatesOpen, locked: !!e.gatesLocked, icao: String(icao).toUpperCase() },
                        va: {
                            id: String(va._id), slug: va.slug, name: va.name,
                            logo: va.logoUrl || '', callsign: va.callsign || '',
                        },
                    });
                }
            } catch (_) { /* one VA's project being down is not everyone's problem */ }
        }));
    }

    _crewMapEventCache = { at: Date.now(), events: out };
    return out;
}

app.get('/api/public/va-events/upcoming', async (req, res) => {
    try {
        const hours = Math.max(1, Math.min(336, parseInt(req.query.window, 10) || 72));
        // Started up to 12h ago stays in: an event under way is exactly what a
        // live map wants to show, and it matches the per-VA route's window.
        const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const until = new Date(Date.now() + hours * 60 * 60 * 1000);

        const events = await VaEvent.find({
            startsAt: { $gte: since, $lte: until },
            departureIcao: { $nin: ['', null] },
        }).sort({ startsAt: 1 }).limit(300).lean();

        // The other half of the calendar: events VAs build in their own crew
        // centres. Best-effort — the directory events are already in hand and
        // must not be lost because somebody's Supabase project timed out.
        const crewList = await crewCentreMapEvents(since.getTime(), until.getTime()).catch(() => []);

        if (!events.length && !crewList.length) {
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ events: [] });
        }

        // One lookup for every VA involved, rather than one per event.
        const vaIds = [...new Set(events.map(e => String(e.vaAdId)).filter(Boolean))];
        const ads = await VirtualAirlineAd.find({ _id: { $in: vaIds }, status: 'approved' })
            .select('_id name logoUrl callsign slug').lean();
        const adById = new Map(ads.map(a => [String(a._id), a]));

        const directory = events
            // Drop events whose VA is gone or no longer approved — the map
            // shouldn't advertise a listing the directory won't show.
            .filter(e => adById.has(String(e.vaAdId)))
            .map(e => {
                const ad = adById.get(String(e.vaAdId));
                return {
                    id: String(e._id),
                    source: 'directory',
                    title: e.title,
                    description: e.description || '',
                    link: e.link || '',
                    departureIcao: e.departureIcao || '',
                    arrivalIcao: '',
                    bannerUrl: e.bannerUrl || '',
                    groupCode: e.groupCode || '',
                    startsAt: e.startsAt,
                    aircraft: '',
                    flightNumber: '',
                    gates: null,
                    va: {
                        id: String(ad._id),
                        slug: ad.slug || '',
                        name: ad.name,
                        logo: ad.logoUrl || '',
                        callsign: ad.callsign || '',
                    },
                };
            });

        // Both calendars, soonest first. A VA that runs both a listing and a
        // crew centre can legitimately have an event in each — they are not
        // de-duplicated, because we cannot tell whether two events at the same
        // field an hour apart are one thing entered twice or two things.
        const all = [...directory, ...crewList]
            .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

        res.set('Cache-Control', 'public, max-age=60');
        res.json({
            events: all,
            // So the map can offer "show only these airlines" without a second
            // request, and show the list even while no events are near you.
            vas: [...new Map(all.map(e => [e.va.id, e.va])).values()]
                .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        });
    } catch (error) {
        console.error('Upcoming VA events error:', error);
        res.status(500).json({ message: 'Server error while loading events.' });
    }
});

// POST: Track a click-through (e.g. on the join/apply link). Returns the target
// URL so the frontend can redirect after recording the click.
//   ?type=apply|website|discord  attribute the click to a specific destination
//                                in the daily statistics (defaults to "apply",
//                                which is what the join link has always been).
app.post('/api/va-ads/:id/click', async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findByIdAndUpdate(
            req.params.id, { $inc: { clicks: 1 } }, { new: true }
        ).select('applicationUrl websiteUrl discordUrl clicks name').lean();
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });
        // Daily statistics: an outbound click-through, plus the generic click
        // counter that the reach/CTR figures are computed from.
        const kind = ['apply', 'website', 'discord'].includes(String(req.query.type)) ? String(req.query.type) : 'apply';
        vaStats.recordEngagement(ad._id, kind, 1, ad.name);
        vaStats.recordEngagement(ad._id, 'click', 1, ad.name);
        res.json({
            success: true,
            clicks: ad.clicks,
            redirectUrl: ad.applicationUrl || ad.websiteUrl || ad.discordUrl || null
        });
    } catch (error) {
        console.error('VA Ad Click Error:', error);
        res.status(500).json({ message: 'Server error while tracking click.' });
    }
});

// DELETE: Remove a VA ad and clean up its S3 images.
app.delete('/api/va-ads/:id', requireAuth, async (req, res) => {
    try {
        const ad = await VirtualAirlineAd.findById(req.params.id);
        if (!ad) return res.status(404).json({ message: 'VA advertisement not found.' });

        await Promise.all([
            deleteVaImage(s3Client, ad.bannerUrl),
            deleteVaImage(s3Client, ad.logoUrl)
        ]);
        await VirtualAirlineAd.findByIdAndDelete(req.params.id);

        res.json({ message: 'VA advertisement deleted.' });
    } catch (error) {
        console.error('VA Ad Delete Error:', error);
        res.status(500).json({ message: 'Server error while deleting VA advertisement.' });
    }
});

/* =========================
 * VA TAKEOFF / LANDING EVENTS
 *
 * Webhook receiver for the ACARS backend (see VA-ADMIN-MANUAL.md). The sender
 * matches every VA by callsign and POSTs one event per takeoff and per landing
 * to VA_BOT_FORWARD_URL=https://<this-server>/api/va-events.
 *
 * Contract from the sender side:
 *   - Each (flightId, event) is sent AT MOST ONCE (deduped on the ACARS side,
 *     even across restarts), so this receiver needs no dedupe of its own.
 *   - Fire-and-forget: the sender does NOT retry and drops slow responses, so we
 *     must ack with a 2xx fast and do the slow work (Discord post) asynchronously.
 *   - If VA_BOT_FORWARD_TOKEN is set on the sender, requests carry
 *     Authorization: Bearer <token>; we check it against the same env var here.
 *
 * Events are EPHEMERAL. The sender broadcasts every VA's flights at us. Every
 * incoming event is kept for just 10 minutes in a small in-memory feed that
 * powers the staff hub's "is this actually working?" panel — long enough to see
 * what's flying (including VAs not yet wired to a webhook) without ever building
 * up history. Delivery is a separate concern: only events something is hooked to
 * (the central Discord webhook and/or an opted-in partner VA's webhook) get
 * enriched, rendered and posted; an un-hooked event just rides the 10-minute
 * feed and does no other work. Nothing is written to MongoDB (the old
 * VaFlightEvent collection is gone — its TTL index drains leftovers).
 * ========================= */

// Shared secret expected on inbound VA event requests. Optional: if unset, the
// endpoint accepts unauthenticated posts (matches the sender leaving the token
// blank). Keep this in sync with VA_BOT_FORWARD_TOKEN on the ACARS backend.
const VA_EVENT_TOKEN = process.env.VA_BOT_FORWARD_TOKEN || null;

// --- In-memory staff feed (replaces the old VaFlightEvent collection) --------
// EVERY incoming takeoff/landing lands here as a trimmed copy (no position, no
// raw payload), newest first — including events that AREN'T hooked to any
// webhook. Seeing an un-hooked VA fly is exactly what you want when wiring its
// webhook up, and it's proof the ACARS sender is reaching us at all. Each entry
// ERASES 10 minutes after it arrives: this is a live "what's flying right now"
// view, not a history log, so nothing accumulates (a hard count cap is a
// belt-and-braces bound on top of the time window). Counters are cumulative
// since process start; the 24h counter prunes itself on every touch.
const VA_EVENT_FEED_TTL = 10 * 60 * 1000;   // erase each entry 10 min after arrival
const VA_EVENT_FEED_MAX = 200;
const vaEventFeed = [];
const vaEventStats = { total: 0, takeoffs: 0, landings: 0, lastReceivedAt: null };
const vaEventTimes = []; // arrival timestamps (ms), pruned to the last 24h

const pruneVaEventTimes = () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    while (vaEventTimes.length && vaEventTimes[0] < cutoff) vaEventTimes.shift();
};

// Drop feed entries older than the 10-minute window. Entries are newest-first,
// so the stale ones cluster at the tail — pop until we hit a fresh one. Cheap
// enough to call on every read and write.
const pruneVaEventFeed = () => {
    const cutoff = Date.now() - VA_EVENT_FEED_TTL;
    while (vaEventFeed.length && vaEventFeed[vaEventFeed.length - 1].ts < cutoff) {
        vaEventFeed.pop();
    }
};

// Record one incoming event for the staff feed. `targets` lists where it was (or
// will be) delivered — e.g. ['central', 'Air Canada Virtual'] — or is empty when
// nothing is hooked to it, which the staff UI surfaces so a missing hook is
// obvious at a glance.
const recordVaEventForFeed = (e, targets = []) => {
    const now = new Date();
    const ac = e.aircraft || {};
    vaEventFeed.unshift({
        ts: now.getTime(),
        event: e.event,
        flightId: e.flightId,
        va: { code: e.va?.code || '', name: e.va?.name || '' },
        callsign: e.callsign || '',
        username: e.username || '',
        server: e.server || '',
        aircraft: { aircraftName: ac.aircraftName || '', liveryName: ac.liveryName || '' },
        delivered: targets.length > 0,
        targets,
        receivedAt: now,
    });
    pruneVaEventFeed();
    if (vaEventFeed.length > VA_EVENT_FEED_MAX) vaEventFeed.length = VA_EVENT_FEED_MAX;
    vaEventStats.total += 1;
    if (e.event === 'takeoff') vaEventStats.takeoffs += 1; else vaEventStats.landings += 1;
    vaEventStats.lastReceivedAt = now;
    vaEventTimes.push(now.getTime());
    pruneVaEventTimes();
};

// Belt-and-braces dedupe of (flightId, event). The sender promises at-most-once
// delivery, but the DB unique index used to make a buggy double-post harmless —
// this bounded Map keeps that guarantee without storing anything. Insertion
// order == age, so pruning stops at the first fresh entry.
const VA_EVENT_SEEN_TTL = 6 * 60 * 60 * 1000;
const VA_EVENT_SEEN_MAX = 2000;
const vaEventSeen = new Map();
const isDuplicateVaEvent = (e) => {
    const key = `${e.flightId}:${e.event}`;
    const now = Date.now();
    for (const [k, ts] of vaEventSeen) {
        if (now - ts > VA_EVENT_SEEN_TTL) vaEventSeen.delete(k); else break;
    }
    if (vaEventSeen.has(key)) return true;
    vaEventSeen.set(key, now);
    if (vaEventSeen.size > VA_EVENT_SEEN_MAX) {
        vaEventSeen.delete(vaEventSeen.keys().next().value);
    }
    return false;
};

// The Discord embed card for a takeoff/landing lives in its own pure module so it
// can be unit-tested in isolation and shared verbatim by every delivery path. The
// DB-backed media lookups that feed it (aircraft photo, VA logo) stay here.
const {
    buildVaEventPayload, extractRoute, isHttpUrl: isHttpImageUrl, clip: clipEmbed,
    trackUrl, resolveAccent, normalizeCardOptions, DEFAULT_CARD_OPTIONS,
    PUBLIC_BASE_URL: CARD_PUBLIC_BASE_URL,
    // Also read by the crew route-map endpoint, so a VA's network map quotes
    // the same leg distances the flight-event card does.
    routeDistanceNm,
} = require('./vaEventCard');
const { renderVaEventCard, renderVaRouteMapImage } = require('./vaEventCardImage');
const { RouteMapCache } = require('./routeMapCache');

/* --- Public route map image ---------------------------------------------------
 *
 * GET /api/route-map?dep=EGLL&arr=KJFK
 *      [&lat=&lon=]                     live aircraft position, drawn as a dot
 *      [&deplat=&deplon=&arrlat=&arrlon=]  explicit endpoints (see below)
 *      [&style=dark|midnight|light|mono]
 *      [&line=%23rrggbb]                route/marker colour
 *      [&size=banner|og]                1200x420 (default) or 1200x630
 *
 * The same renderer the Discord webhook uses, exposed as a plain PNG so the
 * tracker can show a flight's route without shipping a map provider or a key.
 * Public and unauthenticated on purpose — a link-preview crawler cannot present
 * a credential, and the image reveals nothing that isn't already on the map.
 *
 * Three things keep it from becoming a way to burn the container down:
 *
 *  1. A cache, because a shared link is fetched by many crawlers within seconds
 *     of being posted and they all want the identical image. Entries with a live
 *     aircraft position expire quickly; a bare route is fixed geometry and is
 *     held far longer.
 *  2. In-flight de-duplication, so a burst on a cold key renders ONCE and every
 *     waiter is served that render rather than queueing a render each.
 *  3. A ceiling on concurrent misses. Renders funnel through the process-wide
 *     single-slot queue that webhook delivery also uses (see queueRender in
 *     vaEventCardImage.js), so an unbounded miss storm would sit in front of real
 *     flight events. Past the ceiling this sheds load with a 503 instead.
 */
const ROUTE_MAP_TTL_LIVE_MS = 5 * 60 * 1000;         // has a moving aircraft on it
const ROUTE_MAP_TTL_STATIC_MS = 12 * 60 * 60 * 1000; // route geometry only

const routeMapCache = new RouteMapCache({ max: 300, maxInflight: 4 });

const ICAO_PARAM_RE = /^[A-Z0-9]{3,4}$/;
const numParam = (v, limit) => {
    const n = Number(v);
    return (Number.isFinite(n) && Math.abs(n) <= limit) ? n : null;
};

app.get('/api/route-map', async (req, res) => {
    try {
        const q = req.query || {};
        const dep = String(q.dep || '').trim().toUpperCase();
        const arr = String(q.arr || '').trim().toUpperCase();
        if (!ICAO_PARAM_RE.test(dep) || !ICAO_PARAM_RE.test(arr)) {
            return res.status(400).json({ message: 'dep and arr must be 3-4 character airport codes.' });
        }

        const depLat = numParam(q.deplat, 90), depLon = numParam(q.deplon, 180);
        const arrLat = numParam(q.arrlat, 90), arrLon = numParam(q.arrlon, 180);
        const posLat = numParam(q.lat, 90), posLon = numParam(q.lon, 180);
        const hasPos = posLat !== null && posLon !== null;

        // normalizeCardOptions validates style/size/colour and falls back to the
        // defaults, so an unknown value is ignored rather than rejected — a
        // crawler following a stale link still gets an image.
        const opts = normalizeCardOptions({
            mapStyle: q.style,
            mapSize: q.size,
            mapLine: q.line,
        });

        // Round the position into the cache key. A cache keyed on raw decimals
        // never hits: the aircraft moves a few metres between two crawlers and
        // they each pay for a render of a visually identical map.
        const r2 = (n) => (n === null ? '' : n.toFixed(2));
        const key = [
            dep, arr, opts.mapStyle, opts.mapSize, opts.mapLine || '',
            r2(depLat), r2(depLon), r2(arrLat), r2(arrLon), r2(posLat), r2(posLon),
        ].join('|');

        const send = (buf) => {
            const maxAge = Math.floor((hasPos ? ROUTE_MAP_TTL_LIVE_MS : ROUTE_MAP_TTL_STATIC_MS) / 1000);
            res.set('Content-Type', 'image/png');
            res.set('Cache-Control', `public, max-age=${maxAge}`);
            res.set('Access-Control-Allow-Origin', '*');
            res.send(buf);
        };

        const ttl = hasPos ? ROUTE_MAP_TTL_LIVE_MS : ROUTE_MAP_TTL_STATIC_MS;
        const { value: png, status } = await routeMapCache.run(
            key,
            () => renderVaRouteMapImage({
                departureIcao: dep,
                arrivalIcao: arr,
                depCoords: (depLat !== null && depLon !== null) ? [depLat, depLon] : undefined,
                arrCoords: (arrLat !== null && arrLon !== null) ? [arrLat, arrLon] : undefined,
                position: hasPos ? { lat: posLat, lon: posLon } : undefined,
            }, opts),
            // A miss is not cached: an unmappable route is cheap to re-answer,
            // and caching the null would keep serving 404 for a field that has
            // since been added to the coords index.
            (buf) => (buf ? ttl : 0),
        );

        if (status === 'shed') {
            res.set('Retry-After', '5');
            return res.status(503).json({ message: 'Route map renderer is busy — try again shortly.' });
        }
        // Null means neither endpoint could be placed. That is a legitimate
        // answer, not a server fault: the caller falls back to its own image.
        if (!png) return res.status(404).json({ message: 'Route could not be mapped.' });

        send(png);
    } catch (error) {
        console.error('Route map render error:', error.message);
        res.status(500).json({ message: 'Could not render the route map.' });
    }
});

/* --- IFC profile stats card ---------------------------------------------------
 *
 * A pilot's Infinite Flight stats as a PNG they can paste into their Infinite
 * Flight Community "About me". IFC is Discourse; a bio holds markdown and
 * nothing else, so an image at a stable URL is the only way stats can live
 * there at all.
 *
 * Three routes, and the split between them is the product:
 *
 *   POST /api/if-card          make/replace MY card   (Supabase bearer required)
 *   GET  /api/if-card/preview  render without saving  (the generator's preview)
 *   GET  /api/if-card/:file    serve <slug>.png or <slug>.json  (public)
 *
 * The image is public and unauthenticated because it has to be: the fetcher is
 * a forum, a CDN, or a stranger's browser, none of which can present a
 * credential. Nothing on the card is private — it is the same stat block the IF
 * API hands out for any community username — and the slug is unguessable, so a
 * card that is never pasted anywhere is never seen.
 *
 * THE REFRESH ACTUALLY REACHES THE PROFILE, and that is not luck. Discourse
 * rehosts hotlinked images (download_remote_images_to_local) via a job that
 * operates strictly on Post — there is no equivalent for user profiles, and
 * CookedPostProcessor, which builds lightboxes and thumbnails, does not run on
 * a bio either. A bio keeps the bare <img> pointing here, so every viewer's
 * browser fetches the current card from us and the only staleness in the
 * system is the Cache-Control below. If Discourse ever changes that, a Pro
 * card silently freezes at whatever the forum cached, and this comment is the
 * thing to re-check.
 *
 * WRITING is a different matter, and is where the Supabase session comes in. A
 * card is minted from the IF username on the requester's own Inflight account,
 * never from a name in the request body, so nobody can mint a card in someone
 * else's name. The same verified session is what tells us whether they are Pro,
 * which decides whether the numbers are allowed to refresh themselves. Trusting
 * a client-sent `pro: true` would make the paywall a suggestion.
 */
const {
    renderIfProfileCard, fetchIfStats, normalizeFields, normalizeTheme, normalizeFavourites,
    needsRefresh, refreshDueAt,
    FIELDS: IF_CARD_FIELDS, DEFAULT_FIELDS: IF_CARD_DEFAULT_FIELDS,
    MAX_FIELDS: IF_CARD_MAX_FIELDS, THEME_KEYS: IF_CARD_THEMES, DEFAULT_THEME: IF_CARD_DEFAULT_THEME,
    MAX_VAS: IF_CARD_MAX_VAS,
} = require('./ifProfileCard');

const IfProfileCardSchema = new mongoose.Schema({
    slug:        { type: String, required: true, unique: true, index: true },
    // The Supabase account that owns the card. One card per account: the URL
    // ends up pasted into a profile, so re-generating has to update THAT card
    // rather than mint a second one and silently leave the pasted one stale.
    ownerId:     { type: String, required: true, unique: true, index: true },
    ifUsername:  { type: String, required: true },
    ifUserId:    { type: String, default: null },
    fields:      { type: [String], default: () => [...IF_CARD_DEFAULT_FIELDS] },
    theme:       { type: String, default: IF_CARD_DEFAULT_THEME },
    // The pilot's own answers, not the API's. Stored on the card rather than
    // folded into `stats` because a refresh replaces the stat block wholesale
    // and must not take their favourites down with it.
    favourites:  { type: mongoose.Schema.Types.Mixed, default: null },
    // A favourite aircraft is drawn as a photo band unless they ask otherwise.
    showPhoto:   { type: Boolean, default: true },
    // The VAs whose colours the pilot flies, in the order they want them worn.
    // Stored as listing ids rather than names, so a VA that renames itself
    // renames on every card at once — and so the roster re-check at render time
    // has something exact to match. An empty list is "no VA on the card"; there
    // is no separate show/hide flag because unticking every VA already says it.
    vaAdIds:     { type: [String], default: () => [] },
    // The single-VA field these cards were born with. Kept readable so a card
    // saved before multi-VA still wears its badge until the pilot next saves;
    // nothing writes it any more.
    vaAdId:      { type: String, default: null },
    // Pro-only, and re-checked against Supabase on every save — a lapsed
    // membership must stop the refresh, not keep it running off a stale flag.
    autoRefresh: { type: Boolean, default: false },
    pro:         { type: Boolean, default: false },
    // The snapshot the image is drawn from. Free cards keep the one they were
    // born with; Pro cards have it replaced at the turn of each month.
    stats:       { type: mongoose.Schema.Types.Mixed, default: null },
    statsAt:     { type: Date, default: Date.now },
    // Bookkeeping so a card that stops refreshing can be explained.
    lastRefreshAttempt: { type: Date, default: null },
    views:       { type: Number, default: 0 },
}, { timestamps: true });
const IfProfileCard = mongoose.models.IfProfileCard || mongoose.model('IfProfileCard', IfProfileCardSchema);

// Supabase holds Inflight accounts and the is_pro flag. Both values below are
// public by design (the anon key ships in the tracker's HTML); the private half
// of this exchange is the CALLER's access token, which is what actually proves
// who they are.
const IF_CARD_SUPABASE_URL = (process.env.SUPABASE_URL || 'https://lcgaoiqwwpyqndaucyzu.supabase.co').replace(/\/+$/, '');
const IF_CARD_SUPABASE_ANON = process.env.SUPABASE_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjZ2FvaXF3d3B5cW5kYXVjeXp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNjkyOTksImV4cCI6MjA4NzY0NTI5OX0.9TO21knXR_P9E80pea7gUOu-gTjb17sCGk7BYgRRe3U';

/**
 * Who is calling, according to Supabase.
 *
 * We do not verify the JWT ourselves — we spend the token at Supabase and let
 * it answer. That means no JWT secret on this box, and a revoked or expired
 * session fails here exactly as it would anywhere else, rather than continuing
 * to pass a local signature check until it expires on paper.
 *
 * `profiles` is read with the caller's OWN token, so the existing row-level
 * policy that lets a member read their own profile is the whole authorization
 * story.
 *
 * ENTITLEMENT IS THE APP'S RULE, NOT A STRICTER ONE OF OUR OWN. This route used
 * to answer `profiles.is_pro === true` and nothing else, which is why a paying
 * pilot could hold Pro everywhere in Inflight and still be told the card's
 * monthly refresh needs Pro. `profiles.is_pro` is documented in the tracker as
 * frequently null or false for real paying accounts (see refreshProStatus in
 * flight.js, and the same rule in authUI.js and MobileDashboardUI.js): it is
 * trusted only as an explicit true, and a FREE account is identified positively
 * instead, by the `user_metadata.is_pro === false` stamp that free sign-up
 * writes. Anything else signed in is a legacy or paid Pro account.
 *
 * Two surfaces disagreeing about who is Pro is worse than either answer, so
 * this now matches the client rather than second-guessing it. The stakes here
 * are one monthly stat re-read, and the same rule already gates far more.
 *
 * @returns {Promise<{id,email,ifUsername,isPro}|null>} null when unauthenticated
 */
async function supabaseCaller(req) {
    const header = String(req.get('authorization') || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;

    let user;
    try {
        const resp = await axios.get(`${IF_CARD_SUPABASE_URL}/auth/v1/user`, {
            timeout: 8000,
            headers: { apikey: IF_CARD_SUPABASE_ANON, Authorization: `Bearer ${token}` },
        });
        user = resp?.data;
    } catch (_) { return null; }
    if (!user || !user.id) return null;

    let profilePro = null;   // null = we could not read the row at all
    try {
        const resp = await axios.get(`${IF_CARD_SUPABASE_URL}/rest/v1/profiles`, {
            timeout: 8000,
            params: { id: `eq.${user.id}`, select: 'is_pro' },
            headers: { apikey: IF_CARD_SUPABASE_ANON, Authorization: `Bearer ${token}` },
        });
        profilePro = resp?.data?.[0]?.is_pro === true;
    } catch (_) { /* falls through to the metadata stamp below */ }

    // A stamped-free account is the only thing that is definitely not Pro. An
    // unreadable profiles row therefore does not demote anybody — it just leaves
    // the stamp as the deciding evidence, which is the same failure direction
    // the client takes.
    const stampedFree = user.user_metadata?.is_pro === false;
    const isPro = profilePro === true ? true : !stampedFree;

    return {
        id: String(user.id),
        email: user.email || null,
        ifUsername: String(user.user_metadata?.if_username || '').trim(),
        isPro,
    };
}

// Slugs are the card's whole privacy story, so they are drawn from crypto and
// long enough that guessing one is not a strategy.
const ifCardSlug = () => require('crypto').randomBytes(9).toString('base64url');

// Rendered PNGs, memoized. A profile view can fan out into several fetches of
// the identical image (the reader's browser, the forum's own preview, whatever
// proxy sits between), and every one of them would otherwise queue a render
// behind live VA webhook cards. Same cache class, same load-shedding, as the
// route map above.
const ifCardRenderCache = new RouteMapCache({ max: 200, maxInflight: 3 });
const IF_CARD_RENDER_TTL_MS = 10 * 60 * 1000;
// Browser/CDN caching. Deliberately modest: it has to be long enough that a
// popular profile is not re-rendering constantly, and short enough that a
// pilot who has just changed their card sees the change without being told to
// clear anything.
//
// Fifteen minutes turned out to be the wrong side of that trade. The pilot's
// own browser is the one holding the stale copy, and a pilot who has just
// edited their card goes straight to their IFC profile to look at it — waiting
// a quarter of an hour there is indistinguishable from the card being broken.
// Five minutes fresh, then served stale while we re-render behind it, keeps the
// render load roughly where it was without the wait being the pilot's problem.
const IF_CARD_MAX_AGE_S = 300;
const IF_CARD_SWR_S = 900;

const ifCardCacheKey = (c) => [
    // Previews all share the 'preview' slug, so the username has to be in the
    // key or two of them rendered in the same millisecond could serve each
    // other's card.
    c.slug || 'preview', c.stats?.username || '',
    c.theme, (c.fields || []).join('.'), c.pro ? 'p' : 'f',
    c.statsAt ? new Date(c.statsAt).getTime() : 0,
    // The favourites are part of the picture — as tiles, and as the photo band's
    // caption — so they have to be part of the key. Two cards identical but for
    // a favourite airport are not the same PNG.
    ['airport', 'airportName', 'aircraft', 'livery'].map((k) => c.stats?.fav?.[k] || '').join('~'),
    c.photoUrl || '',
    // Same for the VA badges. Keyed on the resolved name+logo rather than the id
    // so a VA changing either one invalidates every card wearing it.
    (c.vas || []).map((v) => `${v.name}~${v.logoUrl || ''}`).join('+'),
].join('|');

/**
 * The approved VA listings whose roster this IFC username actually appears on.
 *
 * This is the VERIFICATION behind repping a VA, and the reason the card cannot
 * simply take a VA name from the pilot the way it takes their favourite
 * aircraft: a logo is a claim about somebody else's organisation. A pilot may
 * only fly the colours of a VA that has put their name on its roster.
 *
 * Same path the flight-event attribution uses (resolveVaEventPartnerByRoster):
 * the reverse index on `usernameLower` alone, then the ads by id. Restricted to
 * approved listings, because a pending or rejected one is not a VA anyone
 * should be wearing.
 *
 * The lookup goes through `rosterMatchKeys` rather than a bare `toLowerCase()`.
 * A roster is typed by VA staff and the name we match it against comes off the
 * Infinite Flight API, so the two disagree about separators far more often than
 * they disagree about the pilot — see the note on that helper. Matching on the
 * raw lowercase alone is what made a pilot who IS on a roster see no VA at all.
 *
 * Returns [] on any failure — the badge is the thing that disappears, never the
 * card.
 */
async function ifCardVaOptions(ifUsername) {
    const keys = vaPilots.rosterMatchKeys(ifUsername);
    if (!keys.length) return [];
    try {
        const rows = await VaPilot.find({ usernameLower: { $in: keys } }).select('vaAdId').lean();
        const ids = [...new Set(rows.map((r) => String(r.vaAdId)))];
        if (!ids.length) return [];
        const ads = await VirtualAirlineAd.find({ _id: { $in: ids }, status: 'approved' })
            .select('name logoUrl').sort({ name: 1 }).lean();
        return ads.map((a) => ({ id: String(a._id), name: a.name, logoUrl: a.logoUrl || null }));
    } catch (err) {
        console.error('[if-card] VA roster lookup failed:', err?.message || err);
        return [];
    }
}

/**
 * The VA ids a card asks for, tolerant of the single-id shape older cards hold.
 *
 * Capped at the renderer's own ceiling (IF_CARD_MAX_VAS) — a pilot can fly for
 * more VAs than a card header can hold marks for, and the limit belongs beside
 * the layout that imposes it rather than duplicated here.
 */
const ifCardWantedVaIds = (src) => {
    const raw = Array.isArray(src?.vaAdIds) && src.vaAdIds.length
        ? src.vaAdIds
        : (src?.vaAdId ? [src.vaAdId] : []);
    const out = [];
    for (const v of raw) {
        const id = String(v || '').trim();
        if (id && !out.includes(id)) out.push(id);
        if (out.length >= IF_CARD_MAX_VAS) break;
    }
    return out;
};

/**
 * The VAs a card should actually display, re-checked against the roster.
 *
 * Deliberately re-resolved on every render rather than trusted from the saved
 * card: a pilot who leaves a VA stops repping it, without anybody having to
 * remember to clear the field. The render cache bounds how often this runs, so
 * the badges follow roster changes within that TTL rather than instantly —
 * which is the right trade for a picture on a forum profile.
 *
 * Returned in the pilot's chosen order, so the VA they put first is the one
 * that leads the header.
 */
async function ifCardVasFor(card) {
    const wanted = ifCardWantedVaIds(card);
    if (!wanted.length) return [];
    const options = await ifCardVaOptions(card.ifUsername);
    return wanted.map((id) => options.find((o) => o.id === id)).filter(Boolean);
}

/**
 * The community photo URL for a favourite aircraft, or null.
 *
 * Reads `CommunityAircraft` directly rather than calling our own
 * /api/aircraft/lookup over HTTP: it is the same process and the same
 * collection, and a server that fetches itself is a request that can time out
 * for no reason.
 *
 * Matching mirrors that endpoint — type is required, livery narrows it, and an
 * exact livery match wins over a loose one — so the photo a pilot gets here is
 * the photo they would see anywhere else in the product.
 */
async function ifCardPhotoUrl(fav) {
    const type = String(fav?.aircraft || '').trim();
    if (!type) return null;
    const livery = String(fav?.livery || '').trim();
    try {
        const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const query = { aircraftType: { $regex: esc(type), $options: 'i' } };
        if (livery) query.liveryName = { $regex: esc(livery), $options: 'i' };
        const rows = await CommunityAircraft.find(query).lean().limit(20);
        if (!rows.length) return null;
        const exact = livery
            ? rows.find((r) => String(r.liveryName || '').toLowerCase() === livery.toLowerCase())
            : null;
        const pick = exact || rows[0];
        const url = pick.imageUrl || (Array.isArray(pick.imageUrls) ? pick.imageUrls[0] : null);
        return url || null;
    } catch (err) {
        console.error('[if-card] photo lookup failed:', err?.message || err);
        return null;
    }
}

/** Render + reply, with the cache and shedding in front. Shared by both GETs. */
async function sendIfCard(res, card) {
    const { value: png, status } = await ifCardRenderCache.run(
        ifCardCacheKey(card),
        () => renderIfProfileCard(card),
        () => IF_CARD_RENDER_TTL_MS,
    );
    if (status === 'shed') {
        res.set('Retry-After', '5');
        return res.status(503).json({ message: 'Card renderer is busy — try again shortly.' });
    }
    if (!png) return res.status(500).json({ message: 'Could not render the card.' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', `public, max-age=${IF_CARD_MAX_AGE_S}, stale-while-revalidate=${IF_CARD_SWR_S}`);
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(png);
}

// The catalogue, so the generator page offers exactly what the renderer can
// draw instead of keeping its own copy of the list to drift out of sync.
app.get('/api/if-card/options', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
        ok: true,
        fields: Object.entries(IF_CARD_FIELDS).map(([key, spec]) => ({ key, label: spec.label })),
        themes: IF_CARD_THEMES,
        defaults: { fields: IF_CARD_DEFAULT_FIELDS, theme: IF_CARD_DEFAULT_THEME },
        maxFields: IF_CARD_MAX_FIELDS,
        maxVas: IF_CARD_MAX_VAS,
    });
});

/*
 * Which VAs a given community username may wear.
 *
 * Public and username-taking, for the same reason the preview is: the generator
 * page has to answer "are you on anyone's roster?" the moment a name is typed,
 * before there is a session or a card. Without this the picker could only ever
 * be filled from /mine — so a pilot who typed their username saw NO VA options
 * at all, however many rosters they were on, which is exactly the "it doesn't
 * show up" this fixes.
 *
 * It reveals nothing a VA has not already published: the listings are the public
 * partner directory, and the answer is only ever "this name appears on these
 * approved rosters".
 */
app.get('/api/if-card/vas', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
        const username = String(req.query.user || '').trim();
        if (!username) return res.status(400).json({ message: 'A community username is required.' });
        res.json({ ok: true, username, maxVas: IF_CARD_MAX_VAS, vaOptions: await ifCardVaOptions(username) });
    } catch (error) {
        console.error('IF card VA lookup error:', error.message);
        res.status(500).json({ message: 'Could not check your VA rosters.' });
    }
});

/*
 * Live preview for the generator page: render whatever the pilot is currently
 * ticking, save nothing.
 *
 * Unauthenticated and takes a username, because it is used before a card
 * exists and the page has to show something the moment a name is typed. That
 * is safe precisely because it writes nothing and reveals nothing the IF API
 * would not hand over for the same name — and the `pro` flag here only ever
 * changes a line of footer text, never whether a stored card may refresh.
 */
app.get('/api/if-card/preview', async (req, res) => {
    try {
        const username = String(req.query.user || '').trim();
        if (!username) return res.status(400).json({ message: 'A community username is required.' });

        const stats = await fetchIfStats(username);
        if (!stats) return res.status(404).json({ message: `No Infinite Flight account found for “${username}”.` });

        const fav = normalizeFavourites({
            airport: req.query.favAirport,
            airportName: req.query.favAirportName,
            aircraft: req.query.favAircraft,
            livery: req.query.favLivery,
        });
        const photoUrl = req.query.photo === '0' ? null : await ifCardPhotoUrl(fav);

        // The preview verifies the roster exactly as a save would. A pilot
        // cannot preview themselves into a VA they are not on — which matters,
        // because a preview is a PNG somebody could otherwise link to directly.
        const vas = await ifCardVasFor({
            vaAdIds: String(req.query.va || '').split(',').map((v) => v.trim()).filter(Boolean),
            ifUsername: stats.username,
        });

        return await sendIfCard(res, {
            stats: { ...stats, fav },
            fields: normalizeFields(req.query.fields),
            theme: normalizeTheme(req.query.theme),
            pro: req.query.pro === '1',
            statsAt: new Date(),
            photoUrl,
            vas,
        });
    } catch (error) {
        console.error('IF card preview error:', error.message);
        res.status(500).json({ message: 'Could not render the preview.' });
    }
});

/**
 * Create or update the caller's card.
 *
 * Body: { fields?: string[], theme?: string, autoRefresh?: boolean }
 *
 * The IF username comes from the verified account, not the body. `autoRefresh`
 * is honoured only for a Pro member; asking for it without Pro is not an error
 * (the card is still made) but the response says plainly that it was not
 * granted, so the page can show the upsell rather than a lie.
 */
app.post('/api/if-card', async (req, res) => {
    try {
        const caller = await supabaseCaller(req);
        if (!caller) return res.status(401).json({ message: 'Sign in to Inflight to make your card.' });
        if (!caller.ifUsername) {
            return res.status(400).json({ message: 'Add your Infinite Flight Community username to your Inflight profile first.' });
        }

        const stats = await fetchIfStats(caller.ifUsername);
        if (!stats) {
            return res.status(404).json({
                message: `We couldn't find an Infinite Flight account for “${caller.ifUsername}”. Check the username on your profile.`,
            });
        }

        const wantsRefresh = req.body?.autoRefresh === true;
        const favourites = normalizeFavourites(req.body?.favourites);

        // Verified against the roster here, not taken on the client's word — a
        // VA logo is a claim about somebody else's organisation.
        const vaOptions = await ifCardVaOptions(stats.username);
        const wantedVas = ifCardWantedVaIds(req.body);
        const vaChoices = wantedVas.filter((id) => vaOptions.some((o) => o.id === id));
        const update = {
            ifUsername: stats.username,
            ifUserId: stats.userId,
            fields: normalizeFields(req.body?.fields),
            theme: normalizeTheme(req.body?.theme),
            favourites,
            showPhoto: req.body?.showPhoto !== false,
            // Only VAs this pilot is genuinely on the roster of survive the
            // save; anything else is dropped rather than rejected, so a pilot
            // whose roster entry was removed still gets their card.
            vaAdIds: vaChoices,
            // The card no longer writes the single-id field, but leaving a
            // stale value behind would resurrect a badge the pilot has just
            // taken off, since that field is still read as a fallback. Cleared
            // on every save.
            vaAdId: null,
            pro: caller.isPro,
            autoRefresh: wantsRefresh && caller.isPro,
            stats,
            statsAt: new Date(),
        };

        // Upsert on the owner, minting a slug only when there isn't one — the
        // pilot's existing URL is already pasted into their IFC bio and must
        // survive every edit they ever make.
        const card = await IfProfileCard.findOneAndUpdate(
            { ownerId: caller.id },
            { $set: update, $setOnInsert: { ownerId: caller.id, slug: ifCardSlug() } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );

        res.json({
            ok: true,
            slug: card.slug,
            imageUrl: `${req.protocol}://${req.get('host')}/api/if-card/${card.slug}.png`,
            fields: card.fields,
            theme: card.theme,
            favourites: card.favourites,
            showPhoto: card.showPhoto,
            // Whether their favourite aircraft actually has a photo behind it.
            // The page can then say "we have no photo of that one" instead of
            // leaving them wondering why the band never appeared.
            photoFound: card.showPhoto ? !!(await ifCardPhotoUrl(card.favourites)) : false,
            vaAdIds: card.vaAdIds,
            vaOptions,
            // Asked for VAs and did not get all of them: they are not on those
            // rosters. Said plainly, because the alternative is a badge that
            // silently never appears.
            vaDenied: wantedVas.length > vaChoices.length,
            pro: card.pro,
            autoRefresh: card.autoRefresh,
            // Told plainly rather than silently ignored.
            refreshDenied: wantsRefresh && !caller.isPro,
            nextRefresh: card.autoRefresh ? refreshDueAt(card.statsAt) : null,
            statsAt: card.statsAt,
        });
    } catch (error) {
        console.error('IF card save error:', error.message);
        res.status(500).json({ message: 'Could not save your card.' });
    }
});

/** The caller's own card, or null. Lets the generator page resume where it left off. */
app.get('/api/if-card/mine', async (req, res) => {
    try {
        const caller = await supabaseCaller(req);
        if (!caller) return res.status(401).json({ message: 'Sign in to Inflight to see your card.' });
        const card = await IfProfileCard.findOne({ ownerId: caller.id }).lean();
        // Offered from the roster, so the page can only present VAs this pilot
        // is actually on rather than a free-text box and a disappointment.
        const vaOptions = await ifCardVaOptions(caller.ifUsername);
        res.json({
            ok: true,
            isPro: caller.isPro,
            ifUsername: caller.ifUsername || null,
            maxVas: IF_CARD_MAX_VAS,
            vaOptions,
            card: card ? {
                slug: card.slug,
                imageUrl: `${req.protocol}://${req.get('host')}/api/if-card/${card.slug}.png`,
                fields: card.fields, theme: card.theme,
                favourites: card.favourites, showPhoto: card.showPhoto,
                // Old single-VA cards fold into the list, so a pilot returning
                // to one sees their VA already ticked rather than blank.
                vaAdIds: ifCardWantedVaIds(card),
                pro: card.pro, autoRefresh: card.autoRefresh,
                statsAt: card.statsAt,
                nextRefresh: card.autoRefresh ? refreshDueAt(card.statsAt) : null,
            } : null,
        });
    } catch (error) {
        console.error('IF card read error:', error.message);
        res.status(500).json({ message: 'Could not read your card.' });
    }
});

/*
 * The card itself: `<slug>.png` for the image, `<slug>.json` for its state.
 *
 * One route rather than two because a path parameter followed by a literal
 * extension is exactly the pattern that behaves differently across
 * path-to-regexp versions; splitting the suffix here is unambiguous and stays
 * that way across an Express upgrade.
 *
 * THE MONTHLY REFRESH LIVES HERE. Being lazy is what makes it free: no
 * scheduler, no queue of cards to sweep, and a card nobody ever looks at never
 * costs a render or an API call. The pilot's own profile view is the tick.
 */
app.get('/api/if-card/:file', async (req, res) => {
    try {
        const raw = String(req.params.file || '');
        const m = raw.match(/^([A-Za-z0-9_-]{4,32})\.(png|json)$/);
        if (!m) return res.status(404).json({ message: 'No such card.' });
        const [, slug, ext] = m;

        const card = await IfProfileCard.findOne({ slug });
        if (!card) return res.status(404).json({ message: 'No such card.' });

        // Re-read the numbers when the month has turned over. Failure is
        // deliberately quiet and non-destructive: we keep serving the stats we
        // already hold, and `lastRefreshAttempt` stops a persistently
        // unreachable API from being re-asked on every single view.
        const RETRY_FLOOR_MS = 60 * 60 * 1000;
        const recentlyTried = card.lastRefreshAttempt
            && (Date.now() - card.lastRefreshAttempt.getTime()) < RETRY_FLOOR_MS;
        if (needsRefresh(card) && !recentlyTried) {
            card.lastRefreshAttempt = new Date();
            const fresh = await fetchIfStats(card.ifUsername);
            if (fresh) {
                card.stats = fresh;
                card.statsAt = new Date();
                card.ifUserId = fresh.userId;
            }
            await card.save().catch(() => {});
        }

        if (ext === 'json') {
            res.set('Access-Control-Allow-Origin', '*');
            return res.json({
                ok: true,
                slug: card.slug, ifUsername: card.ifUsername,
                fields: card.fields, theme: card.theme,
                favourites: card.favourites, showPhoto: card.showPhoto,
                vaAdIds: ifCardWantedVaIds(card),
                pro: card.pro, autoRefresh: card.autoRefresh,
                statsAt: card.statsAt,
                nextRefresh: card.autoRefresh ? refreshDueAt(card.statsAt) : null,
                stats: card.stats,
            });
        }

        // A view counter, incremented without waiting and without letting a
        // write failure cost the pilot their image.
        IfProfileCard.updateOne({ _id: card._id }, { $inc: { views: 1 } }).catch(() => {});

        return await sendIfCard(res, {
            slug: card.slug,
            // Favourites live beside the stat block rather than inside it, so a
            // monthly refresh replacing `stats` cannot quietly drop them.
            stats: { ...(card.stats || {}), fav: normalizeFavourites(card.favourites) },
            fields: card.fields,
            theme: card.theme,
            pro: card.pro && card.autoRefresh,
            statsAt: card.statsAt,
            photoUrl: card.showPhoto ? await ifCardPhotoUrl(card.favourites) : null,
            // Re-checked against the roster on every render, so leaving a VA
            // takes its colours off the card without the pilot doing anything.
            vas: await ifCardVasFor(card),
        });
    } catch (error) {
        console.error('IF card render error:', error.message);
        res.status(500).json({ message: 'Could not render the card.' });
    }
});

// Shared roster helpers (parse/normalize usernames + thin DB ops on the VaPilot
// model). Same module backs the VA portal so both surfaces behave identically.
const vaPilots = require('./vaPilots');

// Pull a VA ad's saved card customization into a normalized options object. A
// plain ad (or the central feed) yields the default look. Kept in one place so
// every delivery path applies the VA's config identically.
const resolveCardOpts = (ad) => normalizeCardOptions((ad && ad.flightEventsCard) || {});

// Deliver one event to a Discord webhook as our composite image card plus (when
// the route can be mapped) a separate route-map image in the same message: two
// embeds, so the map sits full-width BELOW the card instead of being squeezed
// into it. If card rendering fails, fall back to the plain JSON embed so the
// notification still goes out. Used by every delivery path (central feed,
// partner webhook, staff test) so they all render identically. Neither PNG
// depends on the VA logo (that lives in the embed), so a caller posting the
// same event to several webhooks can render once and pass the buffers in as
// `prerendered` ({ card, map }).
const postVaEventCard = async (webhookUrl, e, media, prerendered, opts) => {
    const o = normalizeCardOptions(opts || {});
    // Compact layout: skip the image entirely and post the plain (customized)
    // Discord embed. The brand mark still rides in that embed's footer.
    if (o.layout === 'compact') {
        return axios.post(webhookUrl, buildVaEventPayload(e, media, o));
    }

    const pre = prerendered || {};
    const png = pre.card !== undefined ? pre.card : await renderVaEventCard(e, media, o);
    if (!png) return axios.post(webhookUrl, buildVaEventPayload(e, media, o));
    // Route map only when the VA hasn't turned it off.
    const mapPng = !o.showMap ? null
        : (pre.map !== undefined ? pre.map : await renderVaRouteMapImage(e, o));

    const isTakeoff = e.event === 'takeoff';
    const { dep, arr } = extractRoute(e);
    const routeTag = (dep || arr) ? `  ·  ${dep || '????'} → ${arr || '????'}` : '';
    const track = trackUrl();
    const accentInt = resolveAccent(e, o).int;
    const vaName = e.va?.name || e.va?.code || 'Virtual Airline';
    // The Inflight brand mark ALWAYS rides in the footer icon — not customizable.
    const brandIcon = `${CARD_PUBLIC_BASE_URL}/assets/brand/inflight-logo.png`;
    // 'large' image style: leave the card/map files UNREFERENCED by any embed so
    // Discord renders them as standalone attachments at full message width —
    // bigger, and not boxed inside the embed container. The text embed (author,
    // title, description, footer) still rides above them for context. Default
    // 'embed' style frames the card inside the embed via attachment://card.png.
    const largeImages = o.imageStyle === 'large';
    const embed = {
        color: accentInt,
        // The VA's own logo lives here, in the message (the card image carries our
        // brand). Author icon = small round logo next to the VA name.
        author: {
            name: clipEmbed(`${vaName} · ${isTakeoff ? 'Departure' : 'Arrival'}`, 256),
            ...(isHttpImageUrl(media && media.vaLogoUrl) ? { icon_url: media.vaLogoUrl } : {}),
        },
        // Clip title/description: an over-long callsign/VA name must not 400 the POST.
        // A VA custom title wins; otherwise the route rides in the title so it
        // reads at a glance (the card image below repeats it big anyway).
        title: clipEmbed(o.title || `${isTakeoff ? '🛫' : '🛬'} ${e.callsign || 'Flight'}${routeTag}`, 256),
        ...(isHttpImageUrl(track) ? { url: track } : {}),
        description: clipEmbed(
            `**${e.username || 'A pilot'}** ${isTakeoff ? 'departed' : 'landed'} on **${e.server || 'unknown'}**.`
            + (isHttpImageUrl(track) ? `\n[🔭 Track on Inflight](${track})` : ''),
            2048),
        ...(largeImages ? {} : { image: { url: 'attachment://card.png' } }),
        footer: {
            text: 'Powered by Inflight',
            ...(isHttpImageUrl(brandIcon) ? { icon_url: brandIcon } : {}),
        },
        timestamp: new Date(Number(e.timestamp) || Date.now()).toISOString(),
    };
    // Two delivery shapes below, chosen by image style. No map (unknown airports,
    // a render hiccup, or the VA turned it off) simply means the map step is
    // skipped in either shape.
    //
    // Default 'embed' style: ONE message — the card framed inside the text embed
    // (attachment://card.png) and, when mapped, the route map as a second embed
    // stacked full-width beneath it. The multipart upload can still fail (a
    // transient Discord error, an oversize/edge-case attachment); on ANY upload
    // error fall back to the plain JSON embed so the notification still goes out.
    if (!largeImages) {
        const embeds = [embed];
        const attachments = [{ id: 0, filename: 'card.png' }];
        if (mapPng) {
            embeds.push({ color: accentInt, image: { url: 'attachment://map.png' } });
            attachments.push({ id: 1, filename: 'map.png' });
        }
        try {
            const form = new FormData();
            form.append('payload_json', JSON.stringify({ embeds, attachments }));
            form.append('files[0]', new Blob([png], { type: 'image/png' }), 'card.png');
            if (mapPng) form.append('files[1]', new Blob([mapPng], { type: 'image/png' }), 'map.png');
            return await axios.post(webhookUrl, form);
        } catch (err) {
            console.warn('[va-events] card upload failed, falling back to embed:', err.message);
            return axios.post(webhookUrl, buildVaEventPayload(e, media));
        }
    }

    // 'large' style: the images are meant to stand on their own at full width.
    // Packing the text embed and both standalone files into ONE message makes
    // Discord squish them together and render out of order. Post them as SEPARATE
    // messages instead — the card, then the route map, then the text embed — so
    // each picture shows big on its own and the text sits by itself. Sent
    // sequentially (awaited) so Discord preserves that order.
    const postImageMessage = (buf, name) => {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ attachments: [{ id: 0, filename: name }] }));
        form.append('files[0]', new Blob([buf], { type: 'image/png' }), name);
        return axios.post(webhookUrl, form);
    };
    let last = null;
    try {
        last = await postImageMessage(png, 'card.png');
        if (mapPng) last = await postImageMessage(mapPng, 'map.png');
        last = await axios.post(webhookUrl, { embeds: [embed] }); // the text stuff, on its own
        return last;
    } catch (err) {
        console.warn('[va-events] split card post failed:', err.message);
        // Nothing landed yet → guarantee the notification with a plain embed. If
        // some messages already went out, don't re-post (avoids a duplicate).
        if (!last) return axios.post(webhookUrl, buildVaEventPayload(e, media));
        return last;
    }
};

// A representative sample takeoff for the "send test" buttons (staff editor + VA
// portal): a real-looking CYYZ->KJFK departure so the route, map and aircraft
// photo all render. Built from the VA's own callsign/name/logo so the card looks
// like one of theirs. Shared so every test path posts an identical card.
const buildVaSampleEvent = (ad = {}) => {
    const base = ad.callsign || (ad.callsigns && ad.callsigns[0]) || ad.name || 'VA';
    return {
        event: 'takeoff',
        flightId: 'test-' + Date.now(),
        va: { code: base, name: ad.name || base },
        callsign: `${base} 01`,
        username: 'Test Pilot',
        server: 'Expert',
        aircraft: { aircraftName: 'Boeing 737-800', liveryName: 'Test Livery' },
        position: { lat: 43.6777, lon: -79.6248, alt_ft: 4200, gs_kt: 250 },
        departure: 'CYYZ',
        arrival: 'KJFK',
        timestamp: Date.now(),
    };
};

// Render + post a sample card to a VA's saved webhook. Used by both the staff and
// VA-portal "send test" buttons. Throws on a delivery failure so the caller can
// report Discord's status back to whoever clicked the button.
const sendVaTestEvent = async (ad) => {
    const sample = buildVaSampleEvent(ad);
    const media = await enrichEventMedia(sample);
    if (ad.logoUrl) media.vaLogoUrl = ad.logoUrl;
    // Post the sample with the VA's own card customization so the test preview
    // matches exactly what their real flights will look like.
    await postVaEventCard(ad.flightEventsWebhookUrl, sample, media, undefined, resolveCardOpts(ad));
};

// Render a live preview of the card + route map for the given (unsaved) options,
// WITHOUT posting anything to Discord — powers the "see how it looks" preview in
// the VA portal and the staff webhook manager. Returns data-URI PNGs (or a
// compact flag when the layout is text-only). Reuses the exact renderers the
// live delivery uses, so the preview is faithful. Best-effort: a render miss
// just yields nulls rather than throwing.
const renderCardPreview = async (ad, rawOpts) => {
    const opts = normalizeCardOptions(rawOpts || {});
    const sample = buildVaSampleEvent(ad || {});
    const media = await enrichEventMedia(sample);
    if (ad && ad.logoUrl) media.vaLogoUrl = ad.logoUrl;
    if (opts.layout === 'compact') {
        // No image in compact mode; hand back the embed so the UI can show a
        // faithful text preview of what will be posted.
        return { layout: 'compact', embed: buildVaEventPayload(sample, media, opts).embeds[0] };
    }
    const [card, map] = await Promise.all([
        renderVaEventCard(sample, media, opts),
        opts.showMap ? renderVaRouteMapImage(sample, opts) : null,
    ]);
    const dataUri = (buf) => buf ? 'data:image/png;base64,' + buf.toString('base64') : null;
    return { layout: 'card', card: dataUri(card), map: dataUri(map) };
};

// Find a real community photo of the flown aircraft (type + livery) to use as the
// card thumbnail — an actual "plane image" rather than a generic icon. Tries an
// exact type+livery match first, then falls back to any photo of the same type.
// Never throws: a lookup miss or DB hiccup just yields null (no thumbnail).
const lookupAircraftPhoto = async (aircraftName, liveryName) => {
    if (!aircraftName) return null;
    const exact = (s) => new RegExp('^' + String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    try {
        const typeRx = exact(aircraftName);
        let doc = liveryName
            ? await CommunityAircraft.findOne({ aircraftType: typeRx, liveryName: exact(liveryName), imageUrl: { $ne: null } })
                .select('imageUrl imageUrls').lean()
            : null;
        if (!doc) {
            doc = await CommunityAircraft.findOne({ aircraftType: typeRx, imageUrl: { $ne: null } })
                .select('imageUrl imageUrls').lean();
        }
        return doc ? (doc.imageUrl || (Array.isArray(doc.imageUrls) ? doc.imageUrls[0] : null)) : null;
    } catch (err) {
        console.error('[va-events] aircraft photo lookup failed:', err.message);
        return null;
    }
};

// Resolve the flying VA's logo (for the embed author icon) from the VA directory,
// matched on the event's VA code / callsign base or exact name. Best-effort only.
const lookupVaLogo = async (e) => {
    try {
        const bases = [...new Set([
            normalizeCallsignBase(e.va?.code),
            callsignAirlineBase(e.va?.code),
            normalizeCallsignBase(e.callsign),
            callsignAirlineBase(e.callsign),
        ].filter(Boolean))];
        const name = String(e.va?.name || e.va?.code || '').trim();
        const or = [];
        if (bases.length) or.push({ callsigns: { $in: callsignQueryVariants(bases) } });
        if (name) or.push({ name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
        if (!or.length) return null;
        const ad = await VirtualAirlineAd.findOne({ $or: or }).select('logoUrl').lean();
        return ad?.logoUrl || null;
    } catch (err) {
        console.error('[va-events] VA logo lookup failed:', err.message);
        return null;
    }
};

// Gather the async media (aircraft photo + VA logo) a card wants to render. Kept
// separate from buildVaEventPayload so that function stays pure/synchronous.
const enrichEventMedia = async (e) => {
    const ac = e.aircraft || {};
    const [aircraftImageUrl, vaLogoUrl] = await Promise.all([
        lookupAircraftPhoto(ac.aircraftName, ac.liveryName),
        lookupVaLogo(e),
    ]);
    return { aircraftImageUrl, vaLogoUrl };
};

// Resolve which opted-in partner VA (if any) this event should be delivered to.
// The ACARS backend has ALREADY attributed the flight to a VA (it did the
// prefix/suffix callsign matching on its side and set e.va.code / e.va.name), so
// here we just look the ONE listing that owns the webhook up off that
// attribution — we do NOT re-impose a second, stricter callsign filter of our
// own. That extra gate used to silently discard any flight whose live callsign
// didn't fit "<base> ###VA" exactly, which is the "matching the VA to the
// callsign every time" pain this removes. Returns the ad (with webhook URL) or
// null; every gate that can't produce a target just resolves to null. Never throws.
// Only an opted-in partner (staff-approved + enabled + a live webhook) can ever
// receive an event; this is the shared gate every attribution path applies.
const OPTED_IN_PARTNER_FILTER = {
    flightEventsApproved: true,   // staff-granted; requests alone don't deliver
    flightEventsEnabled: true,
    flightEventsWebhookUrl: { $ne: null },
};
const PARTNER_SELECT = 'name callsigns logoUrl flightEventsCard +flightEventsWebhookUrl';

// Attribute an event to an opted-in VA by PILOT ROSTER: the flight's pilot
// (e.username) is on that VA's roster of Infinite Flight usernames. This is what
// lets a VA say "these are our pilots" and catch their members' flights even
// when the live callsign doesn't fit the VA's registered pattern. Used only as a
// fallback (see resolveVaEventPartner) so it never redirects a flight away from
// the VA the sender explicitly attributed it to. Returns an opted-in ad or null.
const resolveVaEventPartnerByRoster = async (e) => {
    const u = String(e.username || '').trim().toLowerCase();
    if (!u) return null;
    let vaIds;
    try {
        const rows = await VaPilot.find({ usernameLower: u }).select('vaAdId').lean();
        vaIds = [...new Set(rows.map((r) => String(r.vaAdId)))];
    } catch (err) {
        console.error('[va-events] roster lookup failed:', err.message);
        return null;
    }
    if (!vaIds.length) return null;

    let ads;
    try {
        ads = await VirtualAirlineAd.find({ _id: { $in: vaIds }, ...OPTED_IN_PARTNER_FILTER })
            .select(PARTNER_SELECT).sort({ name: 1 }).lean();
    } catch (err) {
        console.error('[va-events] roster partner lookup failed:', err.message);
        return null;
    }
    const valid = ads.filter((a) => a.flightEventsWebhookUrl && isDiscordWebhookUrl(a.flightEventsWebhookUrl));
    if (!valid.length) return null;
    // A pilot on several opted-in rosters is ambiguous; pick deterministically
    // (name-sorted) and log it so the overlap is visible rather than silent.
    if (valid.length > 1) {
        console.warn(`[va-events] pilot "${e.username}" is on ${valid.length} opted-in rosters — attributing to "${valid[0].name}"`);
    } else {
        console.log(`[va-events] attributed by roster: pilot "${e.username}" → "${valid[0].name}"`);
    }
    return valid[0];
};

const resolveVaEventPartner = async (e) => {
    // The event ALREADY arrives attributed to a VA — the ACARS sender resolved it
    // and set e.va.code / e.va.name. We're not re-identifying the flight here; we
    // just need the ONE VA listing that owns the webhook to post to (the webhook
    // lives on the listing, not in the event). So match the listing off that
    // attribution — its code/name — and only fall back to the raw callsign.
    //
    // The two signals are NOT equivalent and must not share one $or.
    //
    // The sender's attribution (e.va.code / e.va.name) is authoritative: it says
    // which VA this flight was flown for. The raw callsign is a guess, and a bad
    // one on its own, because callsignAirlineBase throws the trailing tag away —
    // "OCEAN 12XY" and "OCEAN 12VA" both reduce to "OCEAN". Pooled into a single
    // query, a pilot flying for somebody else — or for nobody — landed in the
    // webhook of whichever VA happened to own that base. That is the whole bug:
    // VAs were getting other airlines' pilots posted into their feed.
    //
    // So attribution is tried first and trusted. The callsign is a fallback, and
    // one that has to earn it: the live callsign must actually fit one of THAT
    // listing's stored callsigns, tag and all ("<BASE> <number>VA"), not merely
    // share a base with it.
    const attrBases = [...new Set([
        normalizeCallsignBase(e.va?.code),
        callsignAirlineBase(e.va?.code),
    ].filter(Boolean))];
    const callsignBases = [...new Set([
        normalizeCallsignBase(e.callsign),
        callsignAirlineBase(e.callsign),
    ].filter(Boolean))];
    const codeBases = [...new Set([...attrBases, ...callsignBases])]; // logging only
    const names = [...new Set([e.va?.name, e.va?.code]
        .map(s => String(s || '').trim()).filter(Boolean))];

    const findPartner = async (or) => {
        if (!or.length) return null;
        try {
            return await VirtualAirlineAd.findOne({ $and: [{ $or: or }, OPTED_IN_PARTNER_FILTER] })
                .select(PARTNER_SELECT).lean();
        } catch (err) {
            console.error('[va-events] partner lookup failed:', err.message);
            return null;
        }
    };

    // 1. The sender said who this is. No callsign gate — re-checking the sender's
    //    own answer against a strict "<base> ###VA" pattern is what used to drop
    //    legitimate flights, codeshare legs above all.
    const attrOr = [];
    if (attrBases.length) attrOr.push({ callsigns: { $in: callsignQueryVariants(attrBases) } });
    for (const n of names) attrOr.push({ name: new RegExp('^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
    let ad = await findPartner(attrOr);

    // 2. Nothing attributed. Now the callsign may speak — but only if it really
    //    is one of this listing's callsigns, tag included. A pilot flying
    //    "OCEAN 12" or "OCEAN 12XY" is not flying for the VA that owns "OCEAN".
    if (!ad && callsignBases.length) {
        const guess = await findPartner([{ callsigns: { $in: callsignQueryVariants(callsignBases) } }]);
        if (guess && matchVaCallsign(e.callsign, guess.callsigns || [])) {
            ad = guess;
        } else if (guess) {
            console.log(`[va-events] callsign "${e.callsign}" shares a base with "${guess.name}" but carries no matching VA tag — not delivering`);
        }
    }

    // Primary (sender/callsign) attribution found an opted-in partner. Deliver to
    // it — but re-validate the URL at send time (a URL stored before validation
    // tightened, or a host that should no longer be trusted, must not be posted
    // to blindly). A bad URL here means SKIP, not roster-fallback: the sender was
    // explicit about which VA this is, so we don't hand its flight to another.
    //
    // NOTE: no callsign re-check happens here. Where `ad` came from the sender's
    // attribution the sender already identified the VA, and a second strict
    // "<base> ###VA" gate used to drop legitimate flights — codeshare legs above
    // all, since those carry the partner airline's callsign and not the VA tag.
    // Where `ad` came from the callsign fallback the gate has already been
    // applied, up in step 2, which is the only place it belongs.
    if (ad && ad.flightEventsWebhookUrl) {
        if (isDiscordWebhookUrl(ad.flightEventsWebhookUrl)) return ad;
        console.warn('[va-events] partner webhook not a valid Discord webhook, skipping:', ad.name);
        return null;
    }

    // No opted-in partner by callsign/name → try the PILOT ROSTER: is the pilot a
    // known member of an opted-in VA? This is the path that makes a roster useful.
    const rosterAd = await resolveVaEventPartnerByRoster(e);
    if (rosterAd) return rosterAd;

    // Still nothing — log what we tried so a miss is diagnosable (usually a gate
    // that's off: not approved / disabled / no webhook — not a failure to
    // identify the VA, which already happened on the sender).
    console.log(`[va-events] no opted-in partner for VA "${e.va?.name || e.va?.code || e.callsign}" — codes [${codeBases.join(', ')}] names [${names.join(', ')}] pilot "${e.username || ''}"`);
    return null;
};

// Attribute an event to a VA listing for STATISTICS. Deliberately looser than
// resolveVaEventPartner: a VA that never asked for a webhook (or is still
// waiting on staff approval) should still accumulate its own numbers, so this
// drops the opted-in gate and matches on the same code/name signals. Cached for
// a few minutes because every takeoff and landing hits it, and the answer only
// changes when a listing is renamed. Returns { _id, name } or null; never throws.
const VA_STATS_RESOLVE_TTL = 5 * 60 * 1000;
const vaStatsResolveCache = new Map(); // signature -> { at, va }

const resolveVaAdForStats = async (e) => {
    const codeBases = [...new Set([
        normalizeCallsignBase(e.va?.code),
        callsignAirlineBase(e.va?.code),
        normalizeCallsignBase(e.callsign),
        callsignAirlineBase(e.callsign),
    ].filter(Boolean))];
    const names = [...new Set([e.va?.name, e.va?.code]
        .map(s => String(s || '').trim()).filter(Boolean))];
    if (!codeBases.length && !names.length) return null;

    const sig = `${codeBases.join('|')}::${names.join('|').toLowerCase()}`;
    const hit = vaStatsResolveCache.get(sig);
    if (hit && Date.now() - hit.at < VA_STATS_RESOLVE_TTL) return hit.va;

    const or = [];
    if (codeBases.length) or.push({ callsigns: { $in: callsignQueryVariants(codeBases) } });
    for (const n of names) or.push({ name: new RegExp('^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });

    let va = null;
    try {
        va = await VirtualAirlineAd.findOne({ $or: or }).select('_id name').lean();
    } catch (err) {
        console.warn('[va-stats] listing lookup failed:', err.message);
        return null;
    }
    // Cache misses too — an unknown callsign shouldn't re-query on every event.
    vaStatsResolveCache.set(sig, { at: Date.now(), va });
    if (vaStatsResolveCache.size > 500) {
        vaStatsResolveCache.delete(vaStatsResolveCache.keys().next().value);
    }
    return va;
};

// Slow-path handler, run after we've already acked the sender. Anything that
// can throw lives here so the route handler stays synchronous and fast.
//
// Filter-first pipeline: figure out WHO wants this event before doing any heavy
// work on it. EVERY non-duplicate event is recorded in the 10-minute staff feed
// (even one nothing is hooked to — that's what you watch when wiring a VA up),
// but the expensive delivery work (media lookup, card render, webhook posts) only
// runs when there's an actual target. A wanted event is rendered ONCE, posted to
// every target, and then everything (payload, media, PNG buffer) goes out of
// scope and is garbage-collected; the trimmed feed entry erases 10 minutes later.
const handleVaEvent = async (e) => {
    if (isDuplicateVaEvent(e)) {
        console.log('[va-events] duplicate ignored:', e.event, e.flightId);
        return;
    }

    // Central feed: prefers a dedicated VA-events webhook so flight chatter can
    // live in its own channel, falling back to the shared DISCORD_WEBHOOK_URL.
    const centralWebhook = process.env.VA_EVENTS_DISCORD_WEBHOOK_URL
        || process.env.DISCORD_WEBHOOK_URL || null;
    const partnerAd = await resolveVaEventPartner(e);

    // Record every incoming event for the staff feed, tagged with where it's
    // headed (or nothing, when it's un-hooked). The entry self-erases after 10m.
    const targets = [];
    if (centralWebhook) targets.push('central');
    if (partnerAd) targets.push(partnerAd.name);
    recordVaEventForFeed(e, targets);

    // Statistics. Runs for EVERY event, hooked or not — a VA's takeoff/landing
    // counts, airborne time and "who's flying right now" shouldn't depend on
    // whether it has a Discord webhook. Prefer the delivery partner we already
    // resolved (no second query in the common case) and fall back to the looser
    // listing lookup so non-partner VAs still get their numbers. Best-effort:
    // stats can never break or delay delivery.
    try {
        const statsAd = partnerAd || await resolveVaAdForStats(e);
        vaStats.recordFlightEvent(e, statsAd);
    } catch (err) {
        console.warn('[va-stats] flight event not recorded:', err.message);
    }

    // Nothing is hooked to this event — it still lives in the feed for 10 minutes,
    // but there's no delivery to do, so skip all the expensive work.
    if (!centralWebhook && !partnerAd) {
        console.log('[va-events] no delivery target — kept 10m in feed, not posted:', e.event, e.flightId);
        return;
    }

    // One media lookup shared by every target. The central feed ALWAYS uses the
    // default card, so render that once (only when a central webhook exists) and
    // share it. A partner VA may have customized its card, so it renders its own
    // unless its config is the default look (then it reuses the central render).
    const media = await enrichEventMedia(e);
    const partnerOpts = partnerAd ? resolveCardOpts(partnerAd) : null;

    let centralPre;
    if (centralWebhook) {
        const [card, map] = await Promise.all([
            renderVaEventCard(e, media),
            renderVaRouteMapImage(e),
        ]);
        centralPre = { card, map };
    }

    // Independent try/catches so one broken webhook can't suppress the other.
    if (centralWebhook) {
        try {
            await postVaEventCard(centralWebhook, e, media, centralPre);
            console.log(`🔔 VA ${e.event}: ${e.callsign} (${e.username}) on ${e.server}`);
        } catch (err) {
            console.error('[va-events] central Discord post failed:', err.message);
        }
    }
    if (partnerAd) {
        try {
            // The matched VA owns this card — prefer its own logo for the author icon.
            const partnerMedia = partnerAd.logoUrl ? { ...media, vaLogoUrl: partnerAd.logoUrl } : media;
            // Reuse the central render only when this VA hasn't customized the card
            // (same default look) and we actually rendered it; otherwise let
            // postVaEventCard render to the VA's own spec (or skip it for compact).
            const isDefault = JSON.stringify(partnerOpts) === JSON.stringify(DEFAULT_CARD_OPTIONS);
            const pre = (isDefault && centralPre) ? centralPre : undefined;
            await postVaEventCard(partnerAd.flightEventsWebhookUrl, e, partnerMedia, pre, partnerOpts);
            console.log(`🔔 partner VA ${e.event} → ${partnerAd.name} (${e.callsign})`);
        } catch (err) {
            console.error(`[va-events] partner webhook post failed for ${partnerAd.name}:`, err.message);
        }
    }
};

// POST /api/va-events — receive a single takeoff/landing event from the ACARS
// backend. Public route (no staff auth) guarded by the optional shared secret;
// the sender is an external service, not a logged-in user.
app.post('/api/va-events', (req, res) => {
    // Optional shared-secret check (matches VA_BOT_FORWARD_TOKEN on the sender).
    if (VA_EVENT_TOKEN && req.get('authorization') !== `Bearer ${VA_EVENT_TOKEN}`) {
        return res.sendStatus(401);
    }

    const e = req.body || {};
    if ((e.event !== 'takeoff' && e.event !== 'landing') || !e.flightId) {
        return res.sendStatus(400);
    }

    // Ack first so we never hold the fire-and-forget sender open, then do the
    // slow work (Discord post) asynchronously — its outcome can't affect the ack.
    res.sendStatus(204);

    handleVaEvent(e).catch(err =>
        console.error('[va-events] handler failed:', err.message));
});

// GET /api/va-events/recent — staff-only. Powers the "VA Flight Activity" panel
// in the staff hub: the last 10 minutes of takeoffs/landings (hooked or not)
// plus summary counters, so staff can confirm at a glance that the ACARS sender
// is actually reaching this receiver — and spot a VA that's flying but not yet
// wired to a webhook. Served entirely from the in-memory feed, which self-erases
// each entry after 10 minutes; the cumulative counters reset on restart.
app.get('/api/va-events/recent', requireAuth, (req, res) => {
    try {
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 100));
        pruneVaEventFeed();
        pruneVaEventTimes();

        res.json({
            events: vaEventFeed.slice(0, limit),
            stats: {
                total: vaEventStats.total,
                takeoffs: vaEventStats.takeoffs,
                landings: vaEventStats.landings,
                last24h: vaEventTimes.length,
                lastReceivedAt: vaEventStats.lastReceivedAt,
                tokenProtected: !!VA_EVENT_TOKEN,
            },
        });
    } catch (err) {
        console.error('VA events recent error:', err);
        res.status(500).json({ error: 'Could not load flight events.' });
    }
});

/* =========================
 * EMBED WIDGET ENDPOINTS
 *
 * Public resolver (called cross-origin by the embed widget on the VA's site)
 * plus staff-only CRUD to mint, edit, revoke and delete token configs.
 * ========================= */

// Normalize a "list" field that may arrive as an array, a comma-separated
// string, or be missing. Trims, drops blanks, and dedupes.
const toStringList = (raw) => {
    let arr;
    if (Array.isArray(raw)) arr = raw;
    else if (typeof raw === 'string') arr = raw.split(',');
    else return [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const v = String(item).trim();
        if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
};

// Normalize a header/brand colour to a "#rrggbb" hex string. Accepts "#rgb",
// "#rrggbb" or the same without the leading "#" (case-insensitive). Anything
// that isn't a valid hex colour — including a blank value — becomes '', which
// tells the widget to fall back to sampling the VA logo.
const normalizeHexColor = (raw) => {
    let v = String(raw == null ? '' : raw).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map(c => c + c).join(''); // #abc -> #aabbcc
    return /^[0-9a-fA-F]{6}$/.test(v) ? '#' + v.toLowerCase() : '';
};

// Colour names the flight-card accepts besides hex / rgb() (mirrors the widget's
// palette in EMBEDBACKEND.md §1). Kept lowercase for case-insensitive matching.
const CARD_COLOR_NAMES = new Set([
    'white', 'black', 'red', 'crimson', 'orange', 'amber', 'yellow', 'gold',
    'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'navy', 'indigo',
    'violet', 'purple', 'magenta', 'pink', 'rose', 'slate', 'gray', 'grey', 'silver',
]);

// Normalize a flight-card colour: accepts a hex string (→ "#rrggbb"), an
// rgb()/rgba() expression (passed through), or one of the named colours above
// (lowercased). Anything else — including blank — becomes '', telling the widget
// to fall back to its default card colour.
const normalizeCardColor = (raw) => {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) return '';
    const hex = normalizeHexColor(v);
    if (hex) return hex;
    if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)$/i.test(v)) return v;
    if (CARD_COLOR_NAMES.has(v.toLowerCase())) return v.toLowerCase();
    return '';
};

// Build the public resolve payload from a stored config — only the fields the
// widget needs, with the same defaults documented in EMBEDBACKEND.md.
const toResolvePayload = (cfg) => ({
    ok: true,
    // Which VA ad this embed is tied to — lets the Events+Calendar companion
    // widget fetch this VA's events via GET /api/public/va/:id/events.
    vaAdId: cfg.vaAdId ? String(cfg.vaAdId) : '',
    va: { code: cfg.va.code, name: cfg.va.name || cfg.va.code, logo: cfg.va.logo || '' },
    callsignPrefixes: (cfg.callsignPrefixes && cfg.callsignPrefixes.length) ? cfg.callsignPrefixes : [cfg.va.code],
    callsignSuffixes: cfg.callsignSuffixes || [],
    regularCallsigns: cfg.regularCallsigns || [],
    // 'strict' = only this VA's registered callsign shapes; 'broad' = also the
    // bare prefix, which finds more members and can also find somebody else's.
    // See the field's note on the schema for why this is a choice and not a fix.
    callsignMatch: cfg.callsignMatch === 'broad' ? 'broad' : 'strict',
    hubs: cfg.hubs || [],
    mode: cfg.mode || 'roster',
    provider: cfg.provider || (cfg.mapboxToken ? 'mapbox' : 'free'),
    mapboxToken: cfg.mapboxToken || '',
    mapStyle: cfg.mapStyle || 'mapbox://styles/mapbox/dark-v11',
    freeStyle: cfg.freeStyle || 'dark',
    theme: cfg.theme || 'dark',
    // Legacy single colour for older widget builds; mirrors accent's first stop.
    brandColor: cfg.brandColor || (cfg.accent && cfg.accent[0]) || '',
    servers: cfg.servers || [],
    // Header & appearance customization. accent is served as a CSV string
    // ("#0ea5e9,#8b5cf6"); '' lets the widget sample the VA logo.
    header: cfg.header || 'on',
    headerPos: cfg.headerPos || 'top',
    accent: (cfg.accent && cfg.accent.length) ? cfg.accent.join(',') : '',
    gradient: cfg.gradient || 'auto',
    gradientAngle: (cfg.gradientAngle == null) ? 120 : cfg.gradientAngle,
    compact: !!cfg.compact,
    ...(cfg.radius == null ? {} : { radius: cfg.radius }), // omit => widget default
    // Events + calendar companion widget opt-in + chosen layout preset.
    events: cfg.events || 'off',
    eventsTemplate: cfg.eventsTemplate || 1,
    // Flight-card customization (map mode). Served as a nested object, only when
    // at least one field is set, so the widget keeps its defaults otherwise.
    ...(() => {
        const c = cfg.card || {};
        const out = {};
        if (c.color)          out.color   = c.color;
        if (c.text)           out.text    = c.text;
        if (c.opacity != null) out.opacity = c.opacity;
        if (c.blur != null)    out.blur    = c.blur;
        return Object.keys(out).length ? { card: out } : {};
    })(),
});

// GET /api/embed/resolve?token=…&origin=… — PUBLIC. The widget runs in the VA's
// browser on their own domain, so this is called cross-origin (global cors()
// already sends Access-Control-Allow-Origin: *). Never cache it.
app.get('/api/embed/resolve', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const token = String(req.query.token || '').trim();
    const origin = String(req.query.origin || '').trim();
    if (!token) return res.status(404).json({ ok: false, error: 'unknown token' });

    try {
        const cfg = await EmbedConfig.findOne({ token }).lean();
        if (!cfg)        return res.status(404).json({ ok: false, error: 'unknown token' });
        if (cfg.revoked) return res.status(410).json({ ok: false, error: 'revoked' });
        if (cfg.expiresAt && Date.now() > new Date(cfg.expiresAt).getTime())
                         return res.status(410).json({ ok: false, error: 'expired' });

        // Optional per-token origin lock. We only enforce it when the widget
        // actually reports an origin (some browsers strip the referrer).
        if (Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.length &&
            origin && !cfg.allowedOrigins.includes(origin)) {
            return res.status(403).json({ ok: false, error: 'origin not allowed' });
        }

        // Best-effort usage tally — don't block the response on it.
        EmbedConfig.updateOne(
            { _id: cfg._id },
            { $inc: { resolveCount: 1 }, $set: { lastResolvedAt: new Date() } }
        ).catch(() => {});
        // Same event in the VA's daily statistics: their widget loaded on their
        // own site. Only counted when the embed is linked to a VA listing.
        if (cfg.vaAdId) vaStats.recordEngagement(cfg.vaAdId, 'embed', 1, (cfg.va && cfg.va.name) || '');

        return res.json(toResolvePayload(cfg));
    } catch (error) {
        console.error('Embed Resolve Error:', error);
        return res.status(500).json({ ok: false, error: 'server error' });
    }
});

// Apply the writable fields from a request body onto a config doc (create/edit).
const applyEmbedFields = (cfg, body) => {
    if (body.label !== undefined) cfg.label = String(body.label || '').trim();

    // Explicit VA link (the embed manager sends this when a VA is picked). An
    // empty/invalid value clears it; linkEmbedToVa() below can still re-derive
    // it from va.code on save.
    if (body.vaAdId !== undefined) {
        cfg.vaAdId = (body.vaAdId && mongoose.Types.ObjectId.isValid(String(body.vaAdId)))
            ? body.vaAdId : null;
    }

    const va = body.va || {};
    if (va.code !== undefined) cfg.va.code = String(va.code || '').trim().toUpperCase();
    if (va.name !== undefined) cfg.va.name = String(va.name || '').trim();
    if (va.logo !== undefined) cfg.va.logo = String(va.logo || '').trim();

    // Prefixes are full airline names ("Air Canada") — preserve case so they
    // match the in-game callsign. Suffixes are short tags, normalized uppercase.
    if (body.callsignPrefixes !== undefined) cfg.callsignPrefixes = toStringList(body.callsignPrefixes);
    if (body.callsignSuffixes !== undefined) cfg.callsignSuffixes = toStringList(body.callsignSuffixes).map(s => s.toUpperCase());
    // Untagged, prefix-only callsigns (always included). Accepts the "callsigns"
    // alias too. Full names, case preserved — matched like prefixes, never tags.
    if (body.regularCallsigns !== undefined || body.callsigns !== undefined) {
        cfg.regularCallsigns = toStringList(body.regularCallsigns ?? body.callsigns);
    }
    // Which error this VA would rather have on its map. Anything unrecognised
    // means 'strict', because showing somebody else's pilot as yours is the
    // error a VA has not agreed to.
    if (body.callsignMatch !== undefined) {
        cfg.callsignMatch = String(body.callsignMatch) === 'broad' ? 'broad' : 'strict';
    }
    // hubs accepts the body keys "hubs", "icao" or "hub"; stored uppercase ICAO.
    if (body.hubs !== undefined || body.icao !== undefined || body.hub !== undefined) {
        cfg.hubs = toStringList(body.hubs ?? body.icao ?? body.hub).map(s => s.toUpperCase());
    }

    if (body.mode !== undefined) cfg.mode = EMBED_MODES.includes(body.mode) ? body.mode : 'roster';
    if (body.provider !== undefined) cfg.provider = EMBED_PROVIDERS.includes(body.provider) ? body.provider : null;
    if (body.mapboxToken !== undefined) cfg.mapboxToken = String(body.mapboxToken || '').trim();
    if (body.mapStyle !== undefined) cfg.mapStyle = String(body.mapStyle || '').trim();
    if (body.freeStyle !== undefined) cfg.freeStyle = String(body.freeStyle || '').trim() || 'dark';
    if (body.theme !== undefined) cfg.theme = EMBED_THEMES.includes(body.theme) ? body.theme : 'dark';
    if (body.brandColor !== undefined) cfg.brandColor = normalizeHexColor(body.brandColor);
    if (body.servers !== undefined) cfg.servers = toStringList(body.servers);

    // --- Header & appearance customization ---
    // header/gradient accept their string forms ('off') or a boolean for
    // convenience (header:false hides, gradient:false = flat).
    if (body.header !== undefined) {
        cfg.header = (body.header === false || String(body.header).trim().toLowerCase() === 'off') ? 'off' : 'on';
    }
    if (body.headerPos !== undefined) {
        cfg.headerPos = EMBED_HEADER_POSITIONS.includes(body.headerPos) ? body.headerPos : 'top';
    }
    if (body.accent !== undefined) {
        // Accepts an array or CSV of up to 3 hex stops; invalid entries drop out.
        // No brandColor mirroring here — toResolvePayload derives the legacy
        // colour from accent[0] at read time, so there's one source of truth.
        cfg.accent = toStringList(body.accent).map(normalizeHexColor).filter(Boolean).slice(0, 3);
    }
    if (body.gradient !== undefined) {
        cfg.gradient = (body.gradient === false || String(body.gradient).trim().toLowerCase() === 'off') ? 'off' : 'auto';
    }
    if (body.gradientAngle !== undefined) {
        const n = Number(body.gradientAngle);
        cfg.gradientAngle = (body.gradientAngle === '' || body.gradientAngle === null || !Number.isFinite(n))
            ? 120 : ((Math.round(n) % 360) + 360) % 360; // wrap into 0–359
    }
    if (body.compact !== undefined) {
        cfg.compact = body.compact === true || body.compact === 1 || body.compact === '1' || body.compact === 'true';
    }
    if (body.radius !== undefined) {
        const n = Number(body.radius);
        cfg.radius = (body.radius === '' || body.radius === null || !Number.isFinite(n))
            ? null : Math.min(32, Math.max(0, Math.round(n)));
    }

    // --- Events + calendar companion widget ---
    if (body.events !== undefined) cfg.events = normalizeEventsFlag(body.events);
    if (body.eventsTemplate !== undefined) cfg.eventsTemplate = normalizeEventsTemplate(body.eventsTemplate);

    // --- Flight-card customization (map mode). Accepts a nested `card` object
    // or the flat aliases cardColor/cardBg, cardText/textColor,
    // cardOpacity/opacity, cardBlur (see EMBEDBACKEND.md §1). ---
    if (!cfg.card) cfg.card = {};
    const card = (body.card && typeof body.card === 'object') ? body.card : {};
    const firstDefined = (...vals) => vals.find(x => x !== undefined);
    const cColor   = firstDefined(card.color,   body.cardColor,   body.cardBg);
    const cText    = firstDefined(card.text,    body.cardText,    body.textColor);
    const cOpacity = firstDefined(card.opacity, body.cardOpacity, body.opacity);
    const cBlur    = firstDefined(card.blur,    body.cardBlur);
    if (cColor !== undefined) cfg.card.color = normalizeCardColor(cColor);
    if (cText !== undefined)  cfg.card.text  = normalizeCardColor(cText);
    if (cOpacity !== undefined) {
        const n = Number(cOpacity);
        // 0–1 or 0–100 are both valid (the widget interprets the scale); clamp to
        // the outer 0–100 bound and drop anything non-numeric back to the default.
        cfg.card.opacity = (cOpacity === '' || cOpacity === null || !Number.isFinite(n))
            ? null : Math.min(100, Math.max(0, n));
    }
    if (cBlur !== undefined) {
        const n = Number(cBlur);
        cfg.card.blur = (cBlur === '' || cBlur === null || !Number.isFinite(n))
            ? null : Math.min(40, Math.max(0, Math.round(n)));
    }

    if (body.allowedOrigins !== undefined) cfg.allowedOrigins = toStringList(body.allowedOrigins);
    if (body.revoked !== undefined) cfg.revoked = !!body.revoked;
    if (body.expiresAt !== undefined) {
        const v = body.expiresAt;
        cfg.expiresAt = v ? new Date(v) : null;
        if (cfg.expiresAt && isNaN(cfg.expiresAt.getTime())) cfg.expiresAt = null;
    }
};

// Establish (or refresh) the trail from an embed to its VA "head". If the embed
// already names a vaAdId, that VA wins; otherwise we find the single VA whose
// callsigns include the embed's va.code. Once resolved, the link is stored and
// the display snapshot (name/logo) is refreshed from the ad so the embed can't
// drift out of sync. A no-op when nothing matches or the code is ambiguous (we
// never guess between two VAs). Returns the linked ad, or null.
const linkEmbedToVa = async (cfg) => {
    try {
        let ad = null;
        if (cfg.vaAdId) {
            ad = await VirtualAirlineAd.findById(cfg.vaAdId).select('name logoUrl').lean();
            if (!ad) cfg.vaAdId = null; // stale reference — fall through to code match
        }
        if (!ad) {
            const code = String((cfg.va && cfg.va.code) || '').trim().toUpperCase();
            if (!code) return null;
            const matches = await VirtualAirlineAd
                .find({ callsigns: { $in: callsignQueryVariants([code]) } })
                .select('name logoUrl').limit(2).lean();
            if (matches.length !== 1) return null; // none or ambiguous → don't guess
            ad = matches[0];
            cfg.vaAdId = ad._id;
        }
        if (!cfg.va) cfg.va = {};
        if (ad.name) cfg.va.name = ad.name;
        if (ad.logoUrl) cfg.va.logo = ad.logoUrl;
        return ad;
    } catch (err) {
        console.error('linkEmbedToVa error:', err.message);
        return null;
    }
};

// Backfill the vaAdId link for every legacy embed that predates it, matching by
// callsign. Idempotent and cheap (skips already-linked embeds); runs once on
// boot so "every embed leads to its VA" holds without a manual step.
const backfillEmbedVaLinks = async () => {
    try {
        const orphans = await EmbedConfig.find({ $or: [{ vaAdId: null }, { vaAdId: { $exists: false } }] })
            .select('va vaAdId');
        let linked = 0;
        for (const cfg of orphans) {
            const ad = await linkEmbedToVa(cfg);
            if (ad) { await cfg.save(); linked++; }
        }
        if (linked) console.log(`[embed-link] backfilled ${linked}/${orphans.length} embed(s) to their VA`);
    } catch (err) {
        console.error('backfillEmbedVaLinks error:', err.message);
    }
};

// Push a VA ad's identity onto its embeds so they never drift from the head:
//   1) refresh name/logo on every embed already linked by vaAdId, and
//   2) adopt any still-unlinked embed whose va.code matches one of the ad's
//      callsigns (e.g. after a callsign edit), stamping the vaAdId link on it.
// Never steals an embed already linked to a different VA.
const syncEmbedsToAd = async (ad) => {
    if (!ad || !ad._id) return;
    const snapshot = { 'va.name': ad.name || '', 'va.logo': ad.logoUrl || '', updatedAt: new Date() };
    await EmbedConfig.updateMany({ vaAdId: ad._id }, { $set: snapshot });

    const codes = (Array.isArray(ad.callsigns) && ad.callsigns.length ? ad.callsigns : [ad.callsign])
        .filter(Boolean).map((c) => String(c).toUpperCase());
    if (codes.length) {
        await EmbedConfig.updateMany(
            { 'va.code': { $in: codes }, $or: [{ vaAdId: null }, { vaAdId: { $exists: false } }] },
            { $set: { ...snapshot, vaAdId: ad._id } },
        );
    }
};

// The cosmetic-only subset of the fields above — safe to hand to a VA editing
// its OWN embed from the partner portal. It restyles the widget (mode, theme,
// header, accent/gradient, corner radius, map-card colours) but deliberately
// touches NOTHING that changes what the embed tracks or who may host it:
// no va identity/callsign matching, hubs, servers, provider/mapbox token,
// allowedOrigins, revoked or expiry. Validation mirrors applyEmbedFields so the
// portal and staff manager coerce values identically. Returns the config.
const applyEmbedAppearance = (cfg, body = {}) => {
    if (body.mode !== undefined) cfg.mode = EMBED_MODES.includes(body.mode) ? body.mode : cfg.mode;
    if (body.theme !== undefined) cfg.theme = EMBED_THEMES.includes(body.theme) ? body.theme : cfg.theme;
    if (body.freeStyle !== undefined) cfg.freeStyle = String(body.freeStyle || '').trim() || 'dark';

    if (body.header !== undefined) {
        cfg.header = (body.header === false || String(body.header).trim().toLowerCase() === 'off') ? 'off' : 'on';
    }
    if (body.headerPos !== undefined) {
        cfg.headerPos = EMBED_HEADER_POSITIONS.includes(body.headerPos) ? body.headerPos : 'top';
    }
    if (body.accent !== undefined) {
        cfg.accent = toStringList(body.accent).map(normalizeHexColor).filter(Boolean).slice(0, 3);
    }
    if (body.gradient !== undefined) {
        cfg.gradient = (body.gradient === false || String(body.gradient).trim().toLowerCase() === 'off') ? 'off' : 'auto';
    }
    if (body.gradientAngle !== undefined) {
        const n = Number(body.gradientAngle);
        cfg.gradientAngle = (body.gradientAngle === '' || body.gradientAngle === null || !Number.isFinite(n))
            ? 120 : ((Math.round(n) % 360) + 360) % 360;
    }
    if (body.compact !== undefined) {
        cfg.compact = body.compact === true || body.compact === 1 || body.compact === '1' || body.compact === 'true';
    }
    if (body.radius !== undefined) {
        const n = Number(body.radius);
        cfg.radius = (body.radius === '' || body.radius === null || !Number.isFinite(n))
            ? null : Math.min(32, Math.max(0, Math.round(n)));
    }

    if (!cfg.card) cfg.card = {};
    const card = (body.card && typeof body.card === 'object') ? body.card : {};
    const firstDefined = (...vals) => vals.find((x) => x !== undefined);
    const cColor   = firstDefined(card.color,   body.cardColor,   body.cardBg);
    const cText    = firstDefined(card.text,    body.cardText,    body.textColor);
    const cOpacity = firstDefined(card.opacity, body.cardOpacity, body.opacity);
    const cBlur    = firstDefined(card.blur,    body.cardBlur);
    if (cColor !== undefined) cfg.card.color = normalizeCardColor(cColor);
    if (cText !== undefined)  cfg.card.text  = normalizeCardColor(cText);
    if (cOpacity !== undefined) {
        const n = Number(cOpacity);
        cfg.card.opacity = (cOpacity === '' || cOpacity === null || !Number.isFinite(n))
            ? null : Math.min(100, Math.max(0, n));
    }
    if (cBlur !== undefined) {
        const n = Number(cBlur);
        cfg.card.blur = (cBlur === '' || cBlur === null || !Number.isFinite(n))
            ? null : Math.min(40, Math.max(0, Math.round(n)));
    }

    // Events + calendar companion widget (the VA's choice + chosen layout).
    if (body.events !== undefined) cfg.events = normalizeEventsFlag(body.events);
    if (body.eventsTemplate !== undefined) cfg.eventsTemplate = normalizeEventsTemplate(body.eventsTemplate);
    return cfg;
};

// GET /api/embed/configs — STAFF. List every token config (newest first).
app.get('/api/embed/configs', requireAuth, async (req, res) => {
    try {
        const configs = await EmbedConfig.find().sort({ createdAt: -1 }).lean();
        res.json({ data: configs });
    } catch (error) {
        console.error('Embed Config List Error:', error);
        res.status(500).json({ message: 'Error fetching embed configs.' });
    }
});

// POST /api/embed/configs — STAFF. Mint a new token config.
app.post('/api/embed/configs', requireAuth, async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.va || !String(body.va.code || '').trim()) {
            return res.status(400).json({ message: 'va.code is required.' });
        }
        const cfg = new EmbedConfig({ token: 'tok_' + crypto.randomBytes(16).toString('hex'), va: {} });
        applyEmbedFields(cfg, body);
        await linkEmbedToVa(cfg); // plug the new embed into its VA head
        await cfg.save();
        res.status(201).json(cfg.toObject());
    } catch (error) {
        console.error('Embed Config Create Error:', error);
        res.status(500).json({ message: 'Error creating embed config.' });
    }
});

// PATCH /api/embed/configs/:id — STAFF. Update a config (token stays the same).
app.patch('/api/embed/configs/:id', requireAuth, async (req, res) => {
    try {
        const cfg = await EmbedConfig.findById(req.params.id);
        if (!cfg) return res.status(404).json({ message: 'Embed config not found.' });
        applyEmbedFields(cfg, req.body || {});
        if (!cfg.va.code) return res.status(400).json({ message: 'va.code is required.' });
        await linkEmbedToVa(cfg); // keep the VA link + name/logo snapshot current
        await cfg.save();
        res.json(cfg.toObject());
    } catch (error) {
        console.error('Embed Config Update Error:', error);
        res.status(500).json({ message: 'Error updating embed config.' });
    }
});

// POST /api/embed/configs/:id/revoke — STAFF. Toggle the kill switch.
// Body: { revoked: true|false } (defaults to true).
app.post('/api/embed/configs/:id/revoke', requireAuth, async (req, res) => {
    try {
        const revoked = req.body && req.body.revoked === false ? false : true;
        const cfg = await EmbedConfig.findByIdAndUpdate(
            req.params.id, { $set: { revoked, updatedAt: new Date() } }, { new: true }
        ).lean();
        if (!cfg) return res.status(404).json({ message: 'Embed config not found.' });
        res.json(cfg);
    } catch (error) {
        console.error('Embed Config Revoke Error:', error);
        res.status(500).json({ message: 'Error updating embed config.' });
    }
});

// POST /api/embed/configs/:id/rotate — STAFF. Issue a fresh token (invalidates
// the old iframe URL while keeping all other settings).
app.post('/api/embed/configs/:id/rotate', requireAuth, async (req, res) => {
    try {
        const cfg = await EmbedConfig.findByIdAndUpdate(
            req.params.id,
            { $set: { token: 'tok_' + crypto.randomBytes(16).toString('hex'), updatedAt: new Date() } },
            { new: true }
        ).lean();
        if (!cfg) return res.status(404).json({ message: 'Embed config not found.' });
        res.json(cfg);
    } catch (error) {
        console.error('Embed Config Rotate Error:', error);
        res.status(500).json({ message: 'Error rotating embed token.' });
    }
});

// DELETE /api/embed/configs/:id — STAFF. Remove a config entirely.
app.delete('/api/embed/configs/:id', requireAuth, async (req, res) => {
    try {
        const cfg = await EmbedConfig.findByIdAndDelete(req.params.id).lean();
        if (!cfg) return res.status(404).json({ message: 'Embed config not found.' });
        res.json({ message: 'Embed config deleted.' });
    } catch (error) {
        console.error('Embed Config Delete Error:', error);
        res.status(500).json({ message: 'Error deleting embed config.' });
    }
});

// server.js

// Staff-only surfaces — gate both the clean route and the raw file (and the
// manual's Markdown source) BEFORE express.static can serve them by filename.
// Non-sensitive frontend assets (airports.js, etc.) stay public; the data they
// touch is protected by requireAuth on the APIs.
const STAFF_ONLY_PATHS = new Set([
    '/', '/index.html', '/aircraft.json',
    '/va-ads', '/va-ads.html',
    '/airports', '/airports.html',
    '/va-admin-manual', '/va-admin-manual.html',
    '/VA-ADMIN-MANUAL.md',
    '/embeds', '/embeds.html',
    '/EMBEDBACKEND.md',
    '/webhooks', '/webhooks.html',
    '/graphic-designer', '/graphic-designer.html',
    '/va-submissions', '/va-submissions.html',
    '/crew-centers', '/crew-centers.html',
]);
app.use((req, res, next) => {
    if (req.method === 'GET' && STAFF_ONLY_PATHS.has(req.path)) {
        return requireAuthPage(req, res, next);
    }
    next();
});

// The staff portal itself (login + tool launcher + user admin). Public so staff
// can reach the login form; the page calls /api/auth/me to decide what to show.
app.get('/staff', (req, res) => {
    res.sendFile(path.join(__dirname, 'staff.html'));
});

// Backend diagnostics terminal. The page shell is public (like /staff); the
// data endpoint it calls (/api/admin/diagnostics) is admin-gated, so a non-admin
// just sees an access-denied banner.
app.get('/diagnostics', (req, res) => {
    res.sendFile(path.join(__dirname, 'diagnostics.html'));
});

// Map usage & limits console — the Mapbox map-load counter and its switches.
// Same pattern as /diagnostics: public page shell, admin-gated data endpoints
// (/api/admin/maploads*), so a non-admin just sees an access-denied banner.
app.get('/map-usage', (req, res) => {
    res.sendFile(path.join(__dirname, 'map-usage.html'));
});

// The VA Partnership Portal login + dashboard. Public so partner VAs can reach
// the login form; the page calls /api/va-portal/auth/me to decide what to show.
// This is a SEPARATE login from the staff hub (partners are not staff).
app.get('/va-portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'va-portal.html'));
});

// Crew Centers manager (staff hub tool) — set each VA's crew center slug and copy
// the link. Staff-only (gated by the STAFF_ONLY_PATHS guard above); its data
// endpoints (/api/crew-admin/*) are requireAuth.
app.get('/crew-centers', (req, res) => {
    res.sendFile(path.join(__dirname, 'crew-centers.html'));
});

// Public Terms & Conditions page (mirrors the signed PDF). Rendered client-side
// from GET /api/va-terms so the page and the PDF share one source (vaTermsContent.js).
app.get(['/terms', '/va-terms'], (req, res) => {
    res.sendFile(path.join(__dirname, 'terms.html'));
});

// Structured Terms content + version/changelog for the Terms page and portal.
// Public: the Terms are not secret.
app.get('/api/va-terms', (req, res) => {
    const terms = require('./vaTermsContent');
    const { TOS_CHANGELOG, TOS_SUMMARY, WARNING_LEVELS, TOS_PDF_PATH } = require('./vaTos');
    res.json({
        title: terms.TITLE,
        subtitle: terms.SUBTITLE,
        version: terms.VERSION,
        effectiveDate: terms.EFFECTIVE_DATE,
        pdfUrl: TOS_PDF_PATH,
        intro: terms.INTRO,
        clauses: terms.CLAUSES,
        changelog: TOS_CHANGELOG,
        summary: TOS_SUMMARY,
        warningLevels: WARNING_LEVELS.map(l => ({ key: l.key, label: l.label, meaning: l.meaning })),
    });
});

// Mapbox map-load quota guard (POST/GET /api/maploads/hit, GET /api/maploads/status).
// The flight tracker calls this once per page-session to decide whether to render
// with billed Mapbox GL or the free MapLibre + OpenFreeMap engine, so we never bill
// past Mapbox's free tier. Sends Access-Control-Allow-Origin: * itself (browser call).
app.use(mapLoadsGuard);

// VA statistics — the public tracking beacon + live "who's airborne" feed, the
// partner-facing dashboard behind the portal session, and the staff console.
// Registered here, BEFORE the static handler and the SPA catch-all below, so the
// /api paths resolve instead of falling through to index.html.
vaStats.registerVaStatsRoutes(app, { requireAuth, requireAdmin, requirePortal: requireVaPortalSession });
// Group-flight claim/publish/watch routes, plus the /g/<code> preview page that
// makes a pasted link unfurl on the IFC. Registered here for the same reason:
// the SPA catch-all below would otherwise swallow both.
vaGroupFlights.registerGroupFlightRoutes(app, { VirtualAirlineAd, VaEvent, requireAuth, vaStats });
// Boot the day-boundary scheduler: at the end of each stats day it posts every
// VA's daily report to their Discord webhook, posts the network report to the
// central feed, and then ERASES that day's raw takeoff/landing records.
vaStats.start();

// 1. Serve static files from the root directory
// This allows the browser to find airports.js, images, and CSS
app.use(express.static(__dirname));

// 2. Specific route for the Airport Manager
// Accessible via yoursite.com/airports (staff-only — see guard above)
app.get('/airports', (req, res) => {
    res.sendFile(path.join(__dirname, 'airports.html'));
});

// Specific route for the VA Advertisement Manager (admin/staff dashboard)
// Accessible via yoursite.com/va-ads (staff-only — see guard above)
app.get('/va-ads', (req, res) => {
    res.sendFile(path.join(__dirname, 'va-ads.html'));
});

// Specific route for the Embed Manager (mint/revoke embed widget tokens)
// Accessible via yoursite.com/embeds (staff-only — see guard above)
app.get('/embeds', (req, res) => {
    res.sendFile(path.join(__dirname, 'embeds.html'));
});

// Specific route for the Webhooks Manager (per-VA flight-event webhook + card
// appearance). Standalone so staff never have to open an embed to manage a
// webhook. Accessible via yoursite.com/webhooks (staff-only — see guard above)
app.get('/webhooks', (req, res) => {
    res.sendFile(path.join(__dirname, 'webhooks.html'));
});

// Specific route for the VA Admin Manual (staff reference, rendered from Markdown)
// Accessible via yoursite.com/va-admin-manual (staff-only — see guard above)
app.get('/va-admin-manual', (req, res) => {
    res.sendFile(path.join(__dirname, 'va-admin-manual.html'));
});

// Specific route for the Graphic Designer workspace (brand assets, logo +
// banner specs and usage guidelines). Accessible via yoursite.com/graphic-designer
// (staff-only — see guard above; scoped to admin/staff/graphic_designer).
app.get('/graphic-designer', (req, res) => {
    res.sendFile(path.join(__dirname, 'graphic-designer.html'));
});

// Specific route for the VA Submissions oversight page (admin/staff/va_rep):
// every partner VA's submissions, the portal activity feed, and portal account
// management. Accessible via yoursite.com/va-submissions (staff-only — see guard above).
app.get('/va-submissions', (req, res) => {
    res.sendFile(path.join(__dirname, 'va-submissions.html'));
});

// 3. The Aircraft Database app (homepage) — staff-only.
app.get('/', requireAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Catch-all for the SPA — also staff-only (the whole site sits behind login).
app.get(/(.*)/, requireAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 5. START SERVER
// Memory diagnostics. The container OOM-kills the process with no application log
// ("just crashes"), so we periodically log RSS/heap and, when RSS crosses a share
// of the configured cap, emit a loud WARN — turning a silent kill into a visible
// pre-crash trail that points at what was growing. Set MEMORY_LIMIT_MB to the
// container's memory cap to enable the threshold warning (logging runs regardless).
const MEMORY_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB, 10) || 0;
const MEMORY_WARN_RATIO = 0.85;
const mb = (bytes) => Math.round(bytes / 1024 / 1024);
setInterval(() => {
    const m = process.memoryUsage();
    const rssMb = mb(m.rss);
    const line = `[mem] rss=${rssMb}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB`;
    if (MEMORY_LIMIT_MB && rssMb >= MEMORY_LIMIT_MB * MEMORY_WARN_RATIO) {
        console.warn(`⚠️  ${line} — near ${MEMORY_LIMIT_MB}MB cap (${Math.round((rssMb / MEMORY_LIMIT_MB) * 100)}%)`);
    } else {
        console.log(line);
    }
}, 5 * 60 * 1000).unref();

// ---- The roster sweep, on a timer ----
//
// Every six hours, and the interval is deliberately not shorter. The rules are
// day-granular, so running more often cannot change an outcome — it would only
// mean touching every VA's Supabase project four times as much for the same
// answer. Nothing here is time-critical: a pilot whose window closed at 02:00
// being removed at 06:00 is the same removal.
//
// Re-running is safe by construction. A removed member is not there to remove
// twice; a member already inactive is exempt; a warning is not repeated because
// its timestamp is compared against an anchor that only flying moves. That is
// what lets this be a plain interval rather than a scheduler with state.
//
// The first run waits a few minutes after boot so a deploy that crash-loops
// cannot sweep a roster on every restart. RETENTION_SWEEP_DISABLED=1 turns it
// off entirely, which is the switch to reach for if a VA ever reports something
// unexpected — the endpoints stay available for a manual, supervised run.
const RETENTION_SWEEP_MS = 6 * 3600 * 1000;
const RETENTION_FIRST_RUN_MS = 5 * 60 * 1000;
if (String(process.env.RETENTION_SWEEP_DISABLED || '').toLowerCase() !== '1') {
    let sweeping = false;
    const sweep = async () => {
        // A sweep across many projects can outlast the interval. Overlapping
        // runs would double every webhook and race two deletes of the same row.
        if (sweeping) return console.warn('[retention] previous sweep still running — skipping this tick');
        sweeping = true;
        const started = Date.now();
        try {
            const t = await runRetentionSweepAll();
            if (t.vas) console.log(`[retention] swept ${t.vas} VA(s) in ${Math.round((Date.now() - started) / 1000)}s — ${t.warned} warned, ${t.removed} removed, ${t.deactivated} inactive`);
        } catch (err) {
            console.error('[retention] sweep failed:', err && err.message);
        } finally { sweeping = false; }
    };
    setTimeout(() => { sweep(); setInterval(sweep, RETENTION_SWEEP_MS).unref(); }, RETENTION_FIRST_RUN_MS).unref();
}

// Boot the live diagnostics sampler and feed it the two external state sources
// the terminal reports on: the Discord client (gateway health + cache sizes +
// the in-memory maps that have leaked before) and the Mongo connection.
diagnostics.start({ memoryLimitMb: MEMORY_LIMIT_MB });
diagnostics.registerSource('discord', () => (typeof getBotStats === 'function' ? getBotStats() : null));
diagnostics.registerSource('mongo', () => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const conn = mongoose.connection;
    return {
        state: states[conn.readyState] || String(conn.readyState),
        host: conn.host || null,
        name: conn.name || null,
        models: Object.keys(conn.models || {}).length,
    };
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
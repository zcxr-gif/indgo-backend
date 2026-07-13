/* =========================================================================
 * SHARED VA TERMS-OF-SERVICE + ENFORCEMENT CONFIG
 *
 * Single source of truth for:
 *   • the current VA Advertisement Program Terms version + effective date,
 *   • where the human-readable Terms page and the signed PDF live,
 *   • the short summary / changelog the portal + Discord card render, and
 *   • the enforcement ladder (verbal → first → second → final → termination).
 *
 * Imported by server.js, bot.js and vaPortal.js so the version string, the
 * warning levels, and the Terms links never drift apart between the Discord
 * ticket, the partner portal, and the API. Bump TOS_VERSION whenever the
 * Terms text (or the PDF) changes — the portal compares a partner's last
 * acknowledged version against this and re-prompts them when it moves.
 * ========================================================================= */

'use strict';

// Bump this whenever the Terms text or the PDF changes. Previous accepters are
// re-prompted in their portal (and can be re-notified in Discord) when it moves.
const TOS_VERSION = 'v3';

// Human-readable effective date of the current version (shown on the Terms
// page, the PDF, and the portal banner).
const TOS_EFFECTIVE_DATE = '2026-07-13';

// Where partners find the Terms. The PDF is served statically from the repo
// root; the page is a public route (see server.js).
const TOS_PDF_PATH = '/VA-Advertisement-Terms.pdf';
const TOS_PAGE_PATH = '/terms';

// Short, plain-language contact for Terms questions.
const TOS_CONTACT_EMAIL = 'inflightcustomer@gmail.com';

// The enforcement ladder for VAs that do not follow the Terms. Order matters:
// `order` is the escalation rank (0 = lightest). Each level carries the copy
// used consistently across the portal badge, the Discord delivery embed, and
// the Terms document, plus a Discord-friendly integer colour and a CSS palette
// hint the portal maps to Tailwind classes.
const WARNING_LEVELS = [
    {
        key: 'verbal',
        order: 0,
        label: 'Verbal Warning',
        short: 'Verbal',
        // Discord embed colour (amber) + portal palette hint.
        color: 0xF59E0B,
        palette: 'amber',
        // What the level means, reused in the portal, Discord embed and PDF.
        meaning: 'An informal, on-the-record notice that something needs to change. No penalty yet — please correct it.',
    },
    {
        key: 'first',
        order: 1,
        label: 'First Warning',
        short: '1st',
        color: 0xF97316,
        palette: 'orange',
        meaning: 'A formal first warning. The issue was raised before and remains unresolved, or is serious enough to warrant a formal record.',
    },
    {
        key: 'second',
        order: 2,
        label: 'Second Warning',
        short: '2nd',
        color: 0xEA580C,
        palette: 'deep-orange',
        meaning: 'A formal second warning. Repeated or continuing breach of the Terms. Your listing may be suspended if this continues.',
    },
    {
        key: 'final',
        order: 3,
        label: 'Final Warning',
        short: 'Final',
        color: 0xDC2626,
        palette: 'red',
        meaning: 'Your last opportunity to comply. A further breach will lead to termination of your partnership and removal of your listing.',
    },
    {
        key: 'termination',
        order: 4,
        label: 'Contract Termination',
        short: 'Terminated',
        color: 0x111827,
        palette: 'black',
        meaning: 'Your partnership agreement has been terminated. Your listing and associated placements will be removed from the platform.',
    },
];

const WARNING_LEVEL_KEYS = WARNING_LEVELS.map((l) => l.key);
const WARNING_LEVEL_MAP = WARNING_LEVELS.reduce((m, l) => { m[l.key] = l; return m; }, {});
const getWarningLevel = (key) => WARNING_LEVEL_MAP[key] || null;

// Key obligations, rendered as bullet points in the Discord ToS card, the
// Terms page, and the portal. Kept short — the PDF holds the full contract.
const TOS_SUMMARY = [
    'Free program — a directory advertising your VA across our platform, subject to staff approval.',
    'Partner benefits — every participating VA is entitled to a free live embed (a widget for your own website showing your VA’s live flights and pilot roster) and a Discord flight-events webhook (automatic takeoff/landing cards posted to your own server).',
    'Official tracking provider — by joining, you accept Inflight as your VA’s official flight-tracking provider. This does not require every individual pilot to use Inflight, but whenever you post or run an event, it must be tracked with Inflight and Inflight is credited as the tracker.',
    'Event tracking — any event you announce or run must be tracked using Inflight, evidenced by a screenshot from our tracker.',
    'Accurate content — listing info, logos and banners must be accurate, owned by you, and not offensive or infringing.',
    'Staff authority — Inflight may review, edit, approve, decline, feature or remove any listing at our discretion.',
    'Enforcement — breaches are handled through a warning ladder (verbal → first → second → final warning) and may end in contract termination.',
    'Changes/suspension — required changes not made within 7 days of contact may lead to suspension.',
];

// What changed in the current version, shown on the Terms page + portal banner
// so partners can see why they are being asked to re-acknowledge.
const TOS_CHANGELOG = [
    {
        version: 'v3',
        date: TOS_EFFECTIVE_DATE,
        notes: [
            'Added: every VA participating in the Program is entitled to a free live embed — a widget for your VA’s own website showing your live flights map and pilot roster, powered by the Inflight tracker.',
            'Added: every participating VA is also entitled to a Discord flight-events webhook — takeoff and landing cards for flights flown under your VA, posted automatically to a channel in your own Discord server.',
        ],
    },
    {
        version: 'v2',
        date: '2026-07-11',
        notes: [
            'Added: Inflight is your VA’s official flight-tracking provider. Not every pilot must use Inflight, but events you post or run are tracked with Inflight and credit Inflight as the tracker.',
            'Added: a formal enforcement ladder — verbal, first, second and final warnings, then contract termination — for VAs that do not follow the Terms. Warnings are delivered to your Discord and recorded in your portal.',
            'Added: whenever the Terms change, partners are notified in their portal and asked to acknowledge the new version.',
        ],
    },
    {
        version: 'v1',
        date: 'Initial release',
        notes: ['Initial VA Advertisement Program Terms & Conditions.'],
    },
];

module.exports = {
    TOS_VERSION,
    TOS_EFFECTIVE_DATE,
    TOS_PDF_PATH,
    TOS_PAGE_PATH,
    TOS_CONTACT_EMAIL,
    WARNING_LEVELS,
    WARNING_LEVEL_KEYS,
    WARNING_LEVEL_MAP,
    getWarningLevel,
    TOS_SUMMARY,
    TOS_CHANGELOG,
};

/* =========================================================================
 * VA ADVERTISEMENT PROGRAM — TERMS & CONDITIONS (structured source)
 *
 * The full contract, as structured data, so the SAME text drives:
 *   • the signed PDF (scripts/build-va-terms-pdf.js), and
 *   • the public Terms page (/terms → GET /api/va-terms → terms.html).
 *
 * Edit the clauses here, then run `node scripts/build-va-terms-pdf.js` to
 * rebuild VA-Advertisement-Terms.pdf. Bump TOS_VERSION in vaTos.js when you do.
 *
 * Each clause is { heading, blocks }, where a block is either:
 *   { p: '…' }                 a paragraph, or
 *   { list: ['…', '…'] }       a bullet list.
 * ========================================================================= */

'use strict';

const { TOS_VERSION, TOS_EFFECTIVE_DATE, TOS_CONTACT_EMAIL } = require('./vaTos');

const INTRO = 'These Terms & Conditions (the “Terms”) govern participation in the VA Advertisement Program (the '
    + '“Program”) operated by Inflight (“we”, “us”, “our”). “Inflight” also refers to our flight tracker. By '
    + 'submitting a listing or accepting an invitation to be featured, the virtual airline or virtual organisation '
    + '(“you”, “the VA”) agrees to these Terms.';

const CLAUSES = [
    {
        heading: '1. The Program',
        blocks: [
            { p: 'The Program is a directory that advertises Infinite Flight virtual airlines (VA) and virtual organisations (VO). A listing may include your name, callsign, logo, banner, description, links, and operational details to help pilots discover and apply to your VA. Participation is offered free of charge.' },
        ],
    },
    {
        heading: '2. What We Offer in Return',
        blocks: [
            { p: 'In return for participation, we offer advertising of your VA across our platform. This may include placement in flight information windows, badges, airport information windows, and other surfaces, as well as additional placements a VA may request. All such placements are offered subject to our approval and are not guaranteed.' },
            { p: 'In addition, every VA that participates in the Program is entitled, free of charge, to the following partner benefits:' },
            { list: [
                'A live embed — a widget you can place on your VA’s own website (as a simple iframe) that displays your VA’s live flights map and/or pilot roster in real time, powered by the Inflight tracker and styled to match your branding.',
                'A flight-events webhook — a Discord webhook that automatically posts takeoff and landing cards for flights flown under your VA’s callsign directly into a channel in your own Discord server, so your community sees your operations live without leaving Discord.',
            ] },
            { p: 'These benefits are provided on request and configured together with our staff. They remain available for as long as your VA participates in the Program and are withdrawn if your participation ends.' },
        ],
    },
    {
        heading: '3. Eligibility',
        blocks: [
            { list: [
                'Your VA/VO must be a genuine, active Infinite Flight community group.',
                'The person submitting or accepting a listing must be the VA’s CEO, owner, or an authorised representative.',
                'You must own or have permission to use all images, logos, and content provided.',
            ] },
        ],
    },
    {
        heading: '4. Official Tracking Provider',
        blocks: [
            { p: 'By joining the Program, you accept and appoint Inflight as your VA’s official flight-tracking provider.' },
            { list: [
                'This does not require every individual pilot in your VA to use Inflight for their personal flying.',
                'It does mean that whenever your VA posts, announces, hosts, or runs an event, that event is tracked using Inflight, and Inflight is credited and recognised as the tracking provider for it.',
                'You will not present a competing tracker as the official tracker of an event you advertise through, or in connection with, the Program.',
            ] },
            { p: 'This appointment is a core condition of participation and works together with the Event & Tracker Requirement below.' },
        ],
    },
    {
        heading: '5. Event & Tracker Requirement',
        blocks: [
            { p: 'The following applies to events you run:' },
            { list: [
                'If you announce or run an event, that event must be tracked using Inflight (our tracker). This applies to every event, regardless of size.',
                'You may announce events however you wish — for example, in your VA’s Discord or on the Infinite Flight Community (IFC) forum — but any announcement must be accompanied by a picture showcasing your event in our tracker.',
            ] },
            { p: 'Running or publicising an event without using Inflight may result in enforcement action under “Compliance, Warnings & Enforcement” below, up to suspension or removal at our discretion.' },
        ],
    },
    {
        heading: '6. Content Standards',
        blocks: [
            { list: [
                'Information you provide must be accurate and kept reasonably up to date.',
                'Banners, logos, and text must not contain offensive, misleading, illegal, or infringing material.',
                'You are responsible for the content of any external links (website, Discord, application, IFC thread) included in your listing.',
            ] },
        ],
    },
    {
        heading: '7. Copyright & Takedown Requests',
        blocks: [
            { p: 'We respect intellectual-property rights. If a company or rights holder contacts us directly requesting the removal of a VA listing that infringes upon their copyrights or trademarks, we will take the required steps to take that listing down. You are solely responsible for ensuring you hold the rights to any branding, logos, or imagery used in your listing.' },
        ],
    },
    {
        heading: '8. Platform Availability (iOS App)',
        blocks: [
            { p: 'The Program is displayed through our web platform. We also operate an iOS app. Due to the stricter copyright and trademark policies enforced by Apple on iOS, VA listings will NOT be displayed within the iOS app. This exclusion is for copyright-compliance reasons and does not affect your listing on our other channels.' },
        ],
    },
    {
        heading: '9. Required Changes & Suspension',
        blocks: [
            { p: 'If we determine that a listing requires immediate changes, our Admin will contact the VA’s CEO or an authorised representative. If no action is taken within 7 days of that contact, the VA’s listing will be suspended until the required action is completed.' },
        ],
    },
    {
        heading: '10. Compliance, Warnings & Enforcement',
        blocks: [
            { p: 'Where a VA does not follow these Terms, we operate a staged enforcement process. We may begin at any stage appropriate to the seriousness of the breach, and we may skip stages for serious or repeated breaches. Each warning is delivered to your VA’s Discord and recorded in your partner portal, where you can review and acknowledge it. The stages are:' },
            { list: [
                'Verbal Warning — an informal, on-the-record notice that something needs to change. No penalty; please correct it.',
                'First Warning — a formal first warning, recorded against your VA.',
                'Second Warning — a formal second warning for a repeated or continuing breach; your listing may be suspended if it continues.',
                'Final Warning — your last opportunity to comply. A further breach will lead to termination.',
                'Contract Termination — your partnership agreement is ended and your listing and placements are removed from the platform.',
            ] },
            { p: 'Acknowledging a warning confirms you have received it; it is not a requirement to agree with it, and questions can be raised with our VA Rep. Failure to acknowledge or respond does not pause the process.' },
        ],
    },
    {
        heading: '11. Quality, Moderation & Listing Management',
        blocks: [
            { p: 'To maintain the utmost quality, Inflight staff have full authority to accept or reject any material submitted to the Program. We further reserve the right, at our sole discretion and without prior notice, to review, edit, approve, decline, withhold, archive, feature, or remove any listing — including for breach of these Terms, inaccurate information, or inactivity. Being invited or listed does not guarantee continued or permanent placement.' },
        ],
    },
    {
        heading: '12. Data & Analytics',
        blocks: [
            { p: 'The Program records basic, non-personal engagement metrics for each listing, such as view and click counts, to measure advertisement performance. Any contact details you supply are used solely for administering the Program.' },
        ],
    },
    {
        heading: '13. No Warranty & Limitation of Liability',
        blocks: [
            { p: 'The Program is provided “as is”, without warranties of any kind. We do not guarantee any level of visibility, traffic, recruitment, or availability. To the fullest extent permitted by law, we are not liable for any loss or damage arising from participation in the Program or from reliance on any listing.' },
        ],
    },
    {
        heading: '14. Intellectual Property',
        blocks: [
            { p: 'You retain ownership of your logos, banners, and brand. By submitting them, you grant us a non-exclusive, royalty-free licence to display and reproduce that content for the purpose of operating and promoting the Program. We will remove your content from active listings upon valid request or termination.' },
        ],
    },
    {
        heading: '15. Termination',
        blocks: [
            { p: 'You may withdraw from the Program at any time by requesting removal of your listing. We may end this agreement and remove your listing at any time — for a reason, for no reason, and without justification — including as the final stage of the enforcement process above. On termination, your listing and associated images will be removed from the public directory.' },
        ],
    },
    {
        heading: '16. Changes to These Terms',
        blocks: [
            { p: 'We may update these Terms from time to time. When we do, we increment the Terms version and notify partners in their portal (and, where appropriate, in their Discord), asking them to acknowledge the new version. Continued participation after a change takes effect constitutes acceptance of the revised Terms.' },
        ],
    },
    {
        heading: '17. Contact',
        blocks: [
            { p: `Questions about the Program or these Terms can be directed to ${TOS_CONTACT_EMAIL}.` },
        ],
    },
];

module.exports = {
    TITLE: 'Inflight VA Advertisement Program',
    SUBTITLE: 'Terms & Conditions',
    VERSION: TOS_VERSION,
    EFFECTIVE_DATE: TOS_EFFECTIVE_DATE,
    INTRO,
    CLAUSES,
};

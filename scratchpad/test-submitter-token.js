'use strict';
// Conformance test for recovering WHO submitted a photo from its review card.
//
// A pending aircraft review card carries the submitter in its footer as
// `User: <token>`, and that token has two shapes:
//
//   • a Discord snowflake — a DM submission, or a site submission from an
//     account with a linked Discord identity
//   • the literal 'web' — a site submission with no Discord identity, whose
//     display name rides in the same footer as `Collab: <name>`
//
// Both readers used to parse it as /User: (\d+)/, which cannot see 'web'. The
// consequences were not symmetrical:
//
//   * refreshPendingReviewsFor skipped web cards, so their buttons never
//     refreshed when a duplicate photo appeared
//   * the admin-edit handler fell back to `interaction.user.id` — the
//     MODERATOR — and baked that id into the rebuilt approve buttons. Approval
//     read it back, resolved it to a guild member, and published the photo
//     credited to the staff member who had edited the card. Every site
//     submission an admin touched before approving came out under a staff name,
//     which is the bug this file exists to keep fixed.
//
// The helpers live inside the bot's client closure and are not exported, so
// they are lifted out of bot.js by name. Brittle on purpose: a rename fails
// here with "could not find" rather than quietly stopping the test.
//
// Run:  node scratchpad/test-submitter-token.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

// `const <name> = ...;` up to the semicolon that ends the statement, tracking
// depth so a one-line arrow and a multi-line body both read correctly.
function lift(name) {
    const start = SRC.indexOf(`const ${name} = `);
    if (start === -1) throw new Error(`could not find ${name} in bot.js`);
    let depth = 0;
    let inLine = false, inBlock = false, quote = '';
    for (let i = start; i < SRC.length; i++) {
        const c = SRC[i], next = SRC[i + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = '';
            continue;
        }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (c === ';' && depth === 0) return SRC.slice(start, i + 1);
    }
    throw new Error(`could not find the end of ${name} in bot.js`);
}

const NAMES = ['submitterTokenFrom', 'submitterTokenFromComponents'];
// eslint-disable-next-line no-new-func
const H = new Function(`${NAMES.map(lift).join('\n')}\nreturn { ${NAMES.join(', ')} };`)();

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const MOD_ID = '999999999999999999';   // the moderator clicking Edit
const USER_ID = '111111111111111111';  // the person who actually submitted

// Footers exactly as the two writers produce them (bot.js — the DM path and
// _submitWebAircraftReviewImpl).
const DM_FOOTER = `Pending | User: ${USER_ID} | Msg: 555 | Ch: 777`;
const WEB_LINKED_FOOTER = `Pending | User: ${USER_ID} | Msg: 555`;
const WEB_ANON_FOOTER = 'Pending | User: web | Msg: 555 | Collab: Jamie Okafor | Src: inflight.info';
const WEB_ANON_NO_SRC = 'Pending | User: web | Msg: 555 | Collab: Jamie Okafor';

console.log('\nsubmitterTokenFrom — reading the footer');
T('a DM submission yields the submitter id', H.submitterTokenFrom(DM_FOOTER), USER_ID);
T('a linked site submission yields the submitter id', H.submitterTokenFrom(WEB_LINKED_FOOTER), USER_ID);
// The regression. A digits-only parse returned nothing here, and the caller's
// fallback was the moderator.
T('an anonymous site submission yields "web"', H.submitterTokenFrom(WEB_ANON_FOOTER), 'web');
T('…with or without a Src segment', H.submitterTokenFrom(WEB_ANON_NO_SRC), 'web');
T('the Collab name is not mistaken for the token',
    H.submitterTokenFrom(WEB_ANON_FOOTER) === 'web', true);
T('a missing footer yields nothing', H.submitterTokenFrom(''), '');
T('an unrelated footer yields nothing', H.submitterTokenFrom('Verified | Msg: 555'), '');
T('null is handled', H.submitterTokenFrom(null), '');

console.log('\nsubmitterTokenFromComponents — reading the buttons');
const card = (customId) => ({ components: [{ components: [{ customId }] }] });
T('the new button format yields its token', H.submitterTokenFromComponents(card('approve_add_1_web')), 'web');
T('…for a replace too', H.submitterTokenFromComponents(card(`approve_replace_2_${USER_ID}`)), USER_ID);
T('the older slot format still reads', H.submitterTokenFromComponents(card(`approve_1_${USER_ID}`)), USER_ID);
T('the legacy single-photo format still reads', H.submitterTokenFromComponents(card(`approve_${USER_ID}`)), USER_ID);
// Airport approvals share the prefix and must not be mistaken for aircraft ones.
T('an airport button is ignored', H.submitterTokenFromComponents(card(`approve_apt_${USER_ID}_EGLL`)), '');
T('a reject button is ignored', H.submitterTokenFromComponents(card(`reject_${USER_ID}`)), '');
T('a card with no components yields nothing', H.submitterTokenFromComponents({}), '');
T('null is handled', H.submitterTokenFromComponents(null), '');
T('the approve button is found among others', H.submitterTokenFromComponents({
    components: [{ components: [{ customId: 'edit_1' }, { customId: 'approve_add_1_web' }] }],
}), 'web');

console.log('\nthe admin-edit fallback chain — what actually got credited');
// Mirrors the resolution in the admin_edit_modal handler.
const resolve = (footerText, message) =>
    H.submitterTokenFrom(footerText) || H.submitterTokenFromComponents(message) || 'web';

T('a DM card keeps its submitter', resolve(DM_FOOTER, card(`approve_add_1_${USER_ID}`)), USER_ID);
T('an anonymous site card keeps "web"', resolve(WEB_ANON_FOOTER, card('approve_add_1_web')), 'web');
T('a footerless card falls back to its buttons', resolve('', card('approve_add_1_web')), 'web');
T('a card with neither falls back to "web", never to the moderator',
    resolve('', {}), 'web');
// The whole point: the moderator's id must not be reachable from any of these.
T('the moderator id appears in no outcome',
    [DM_FOOTER, WEB_ANON_FOOTER, WEB_LINKED_FOOTER, '']
        .map((f) => resolve(f, {}))
        .includes(MOD_ID),
    false);

console.log('\nwhat approval would then credit');
// Mirrors the approve handler: a numeric token is resolved to a Discord member,
// anything else credits the footer's Collab name.
const collabFrom = (footerText) =>
    String(footerText || '').match(/Collab: ([^|]+?)\s*(?:\||$)/)?.[1]?.trim() || '';
const creditedName = (token, footerText, guildDisplayName) =>
    (/^\d{5,}$/.test(String(token)) ? guildDisplayName : (collabFrom(footerText) || 'Anonymous'));

T('an edited site submission credits the submitter, not the moderator',
    creditedName(resolve(WEB_ANON_FOOTER, card('approve_add_1_web')), WEB_ANON_FOOTER, 'ModeratorName'),
    'Jamie Okafor');
T('a DM submission still credits the Discord member',
    creditedName(resolve(DM_FOOTER, card(`approve_add_1_${USER_ID}`)), DM_FOOTER, 'Real Submitter'),
    'Real Submitter');
T('a site submission with no name given credits Anonymous',
    creditedName('web', 'Pending | User: web | Msg: 555', 'ModeratorName'),
    'Anonymous');

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

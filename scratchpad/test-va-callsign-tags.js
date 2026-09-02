'use strict';
// Conformance test for VA callsign masks whose suffix tag is NOT "VA".
//
// A VA registers its callsign as a mask — "OCEAN ##VA", "SHAMROCK ###EX",
// "UPS ##UP" — where the "#" stand in for the pilot's flight number and the
// trailing letters are the airline's tag. vaCallsignParts reads both halves out
// of any mask, and everything that compares a live in-game callsign to a stored
// one is supposed to go through it.
//
// Two helpers did not. They stripped a LITERAL "VA" with hard-coded regexes,
// which is correct for exactly the VAs whose tag happens to be "VA" and wrong
// for every other one:
//
//   * callsignSharesVaBase reduced "UPS ##UP" to "UPSUP" instead of "UPS", so a
//     real "UPS 123UP" did not start with it. That is the loose half of callsign
//     matching — 'strict' and 'broad' mode, and the roster fallback's "is this
//     pilot flying OUR airline" preference — so a UPS-style VA matched nothing
//     at all: no webhook, no embed row, and roster attribution falling through
//     to the codeshare path or to nowhere.
//   * formatCallsignDisplay rendered "UPS ##UP" as "UPS ##UP ##VA" — the exact
//     suffix doubling it exists to prevent, wearing another airline's tag.
//
// The cases below are the ones where a tag other than "VA" has to behave
// identically to "VA", because a VA does not get to be a special case for
// having picked different letters.
//
// Run:  node scratchpad/test-va-callsign-tags.js

const path = require('path');
const Module = require('module');

// server.js is not requireable (it opens a database and a port), so the three
// helpers under test are read out of its source and evaluated on their own.
// Brittle by nature, and deliberately loud about it: if a helper is renamed or
// reshaped this fails with "could not find", which is the correct outcome for a
// test that has stopped testing the real thing.
const fs = require('fs');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Take `const <name> = ...;` and stop at the semicolon that actually ends the
// statement — tracking depth, so a one-line arrow and a multi-line body are both
// read correctly. A naive "find the next \n};" swallows every one-liner into the
// function after it, which then declares the same name twice.
function lift(name) {
    const start = SRC.indexOf(`const ${name} = `);
    if (start === -1) throw new Error(`could not find ${name} in server.js`);
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
    throw new Error(`could not find the end of ${name} in server.js`);
}

// Order matters: the later helpers close over the earlier ones.
const NAMES = [
    'VA_CALLSIGN_MATCH_MODES',
    'VA_ROSTER_TRUST_MODES',
    'vaCallsignParts',
    'normalizeCallsignBase',
    'compactCallsign',
    'callsignSharesVaBase',
    'formatCallsignDisplay',
    'tokenHasSuffixTag',
    'callsignCarriesVaTag',
    'vaCallsignBases',
    'vaCallsignMode',
    'VA_WEIGHT_WORDS',
    'liveCallsignTokens',
    'VA_ROSTER_WATCH_TRUST_MODES',
    'isDistinctiveVaTag',
    'vaDistinctiveTags',
    'callsignTailHasTag',
    'callsignFitsVaMode',
    'callsignFitsVa',
    'embedCallsignsFromAd',
];
const source = NAMES.map(lift).join('\n');
// eslint-disable-next-line no-new-func
const H = new Function(`${source}\nreturn { ${NAMES.join(', ')} };`)();

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

console.log('\nvaCallsignParts — reading a mask');
T('a "VA" mask splits into base and tag', H.vaCallsignParts('OCEAN ##VA'), { base: 'OCEAN', tag: 'VA' });
T('so does one with any other tag', H.vaCallsignParts('UPS ##UP'), { base: 'UPS', tag: 'UP' });
T('…and a longer one', H.vaCallsignParts('SHAMROCK ###EX'), { base: 'SHAMROCK', tag: 'EX' });
T('a tagless mask has no tag', H.vaCallsignParts('BAW ###'), { base: 'BAW', tag: '' });
T('a multi-word airline keeps its spaces', H.vaCallsignParts('AIR CANADA ##VA'), { base: 'AIR CANADA', tag: 'VA' });

console.log('\ncallsignSharesVaBase — the airline, tag ignored');
// The regression. Every one of these was false before the fix except the two
// that happen to use the tag "VA".
T('a tagged UPS flight is UPS', H.callsignSharesVaBase('UPS 123UP', ['UPS ##UP']), true);
T('an untagged UPS flight still shares the airline', H.callsignSharesVaBase('UPS 123', ['UPS ##UP']), true);
T('an "EX" tag works the same', H.callsignSharesVaBase('SHAMROCK 1EX', ['SHAMROCK ###EX']), true);
T('the "VA" case still works', H.callsignSharesVaBase('OCEAN 12VA', ['OCEAN ##VA']), true);
T('a tagless mask still works', H.callsignSharesVaBase('BAW 42', ['BAW ###']), true);
T('a multi-word airline matches however it is spaced',
    H.callsignSharesVaBase('AIRCANADA 001VA', ['AIR CANADA ##VA']), true);

// The loosening must not become a free-for-all: this helper deliberately
// ignores the TAG, but never the airline.
T('somebody else’s airline is still not ours',
    H.callsignSharesVaBase('ETIHAD 456FR', ['UPS ##UP']), false);
T('a different airline sharing our tag is still not ours',
    H.callsignSharesVaBase('DELTA 12UP', ['UPS ##UP']), false);
T('an empty callsign matches nothing', H.callsignSharesVaBase('', ['UPS ##UP']), false);
T('no registered callsigns match nothing', H.callsignSharesVaBase('UPS 123UP', []), false);
T('one of several registered airlines is enough',
    H.callsignSharesVaBase('SHAMROCK 1EX', ['UPS ##UP', 'SHAMROCK ###EX']), true);

console.log('\nformatCallsignDisplay — showing it back');
T('a bare base gains the default suffix', H.formatCallsignDisplay('OCEAN'), 'OCEAN ##VA');
T('a "VA" mask is not doubled', H.formatCallsignDisplay('OCEAN ##VA'), 'OCEAN ##VA');
T('another tag is not doubled either', H.formatCallsignDisplay('UPS ##UP'), 'UPS ##UP');
T('…and keeps its own tag rather than being given "VA"', H.formatCallsignDisplay('SHAMROCK ###EX'), 'SHAMROCK ##EX');
T('a tagless mask is not handed a tag it never had', H.formatCallsignDisplay('BAW ###'), 'BAW ###');
T('nothing in, nothing out', H.formatCallsignDisplay(''), null);

/* ===========================================================================
 * callsignCarriesVaTag — the other half, for rosterTrust: 'tagged'
 *
 * 'airline' lets the roster waive the suffix, which is right for most VAs and
 * wrong for one whose suffix is the entire point of having one: a rostered
 * pilot's untagged "UPS 123" arrived in the UPS feed because the callsign rule
 * the roster widens ignores the tag. 'tagged' keeps the widening — the rest of
 * the callsign's shape is still forgiven — but never for a missing tag.
 * ======================================================================== */

console.log('\ntokenHasSuffixTag — a tag, not a coincidence');
T('a tag glued to a flight number counts', H.tokenHasSuffixTag('123UP', 'UP'), true);
T('a tag standing alone counts', H.tokenHasSuffixTag('UP', 'UP'), true);
// The rule that stops every Russian airline joining somebody's VA.
T('a word merely ending in the letters does not', H.tokenHasSuffixTag('MOSKVA', 'VA'), false);
T('…nor another one', H.tokenHasSuffixTag('NOVA', 'VA'), false);
T('a different tag does not', H.tokenHasSuffixTag('123EX', 'UP'), false);
T('no tag, no match', H.tokenHasSuffixTag('123UP', ''), false);

console.log('\ncallsignCarriesVaTag — does this flight wear our tag?');
const UPS = { callsigns: ['UPS ##UP'] };
T('a tagged flight does', H.callsignCarriesVaTag('UPS 123UP', UPS), true);
T('an untagged one does not', H.callsignCarriesVaTag('UPS 123', UPS), false);
// The reason the window is the last TWO tokens: pilots append a second word.
T('a trailing word does not hide the tag', H.callsignCarriesVaTag('UPS 123UP Cargo', UPS), true);
T('…nor does a weight class', H.callsignCarriesVaTag('UPS 123UP Heavy', UPS), true);
// Deliberately true — this helper answers "is our tag present", and the AIRLINE
// is checked separately by callsignFitsVa. Asserted so that stays a decision.
T('our tag on another airline is still our tag (the airline is checked elsewhere)',
    H.callsignCarriesVaTag('DELTA 9UP', UPS), true);
T('a VA with several callsigns accepts either tag',
    H.callsignCarriesVaTag('SHAMROCK 1EX', { callsigns: ['UPS ##UP', 'SHAMROCK ###EX'] }), true);
T('a VA with a tagless mask has no tag to carry',
    H.callsignCarriesVaTag('BAW 42', { callsigns: ['BAW ###'] }), false);
T('a VA with no registered callsigns has nothing to check',
    H.callsignCarriesVaTag('UPS 123UP', {}), false);
T('the single-callsign field is read too',
    H.callsignCarriesVaTag('UPS 123UP', { callsign: 'UPS ##UP' }), true);

/* ===========================================================================
 * callsignFitsVa — the three modes a VA actually chooses between
 *
 * The portal offers "exactly my callsigns" / "only my VA callsigns" / "catch
 * more of my pilots", and the middle one is the default every VA starts on. It
 * used to be neither of the things it claimed: callsignFitsVa answered 'strict'
 * with a bare airline test (so it was 'broad', tag ignored, other VAs' pilots on
 * the same airline delivered) while the callsign-fallback path answered the same
 * mode with the exact-shape regex (so it was 'exact', and a member who appended
 * a division tag or flew a heavy was dropped). One matcher now answers all three
 * in one place; these are the rows that distinguish them.
 * ======================================================================== */
const ad = (mode, ...callsigns) => ({ callsignMatch: mode, callsigns });

console.log('\ncallsignFitsVa — exact');
T('the registered shape fits', H.callsignFitsVa('OCEAN 12VA', ad('exact', 'OCEAN ##VA')), true);
T('spacing does not matter', H.callsignFitsVa('OCEAN12VA', ad('exact', 'OCEAN ##VA')), true);
T('a second trailing tag does not', H.callsignFitsVa('OCEAN 12VA CX', ad('exact', 'OCEAN ##VA')), false);
T('a missing tag does not', H.callsignFitsVa('OCEAN 12', ad('exact', 'OCEAN ##VA')), false);
T('another airline does not', H.callsignFitsVa('DELTA 12VA', ad('exact', 'OCEAN ##VA')), false);
T('a non-"VA" tag behaves identically',
    H.callsignFitsVa('SHAMROCK 4EX', ad('exact', 'SHAMROCK ###EX')), true);
T('a tagless mask wants the bare number', H.callsignFitsVa('BAW 42', ad('exact', 'BAW ###')), true);
T('…and nothing after it', H.callsignFitsVa('BAW 42VA', ad('exact', 'BAW ###')), false);
// Each mask is held to ITS OWN tag — not the cross-product of every base
// against every tag the listing happens to carry.
T('a VA with two masks does not mix them',
    H.callsignFitsVa('OCEAN 4EX', ad('exact', 'OCEAN ##VA', 'SHAMROCK ###EX')), false);
T('…while each mask still fits itself',
    H.callsignFitsVa('SHAMROCK 4EX', ad('exact', 'OCEAN ##VA', 'SHAMROCK ###EX')), true);

console.log('\ncallsignFitsVa — strict (the default, and the one that was broken)');
T('the registered shape fits', H.callsignFitsVa('OCEAN 12VA', ad('strict', 'OCEAN ##VA')), true);
T('a second trailing tag is allowed', H.callsignFitsVa('OCEAN 12VA CX', ad('strict', 'OCEAN ##VA')), true);
T('a weight class does not hide the tag', H.callsignFitsVa('OCEAN 12VA Heavy', ad('strict', 'OCEAN ##VA')), true);
// The leak: an untagged stranger on the VA's airline used to be delivered,
// because 'strict' was answered with the tag-blind test.
T('an untagged callsign on our airline does NOT', H.callsignFitsVa('OCEAN 12', ad('strict', 'OCEAN ##VA')), false);
T('somebody else’s tag on our airline does not', H.callsignFitsVa('OCEAN 12XY', ad('strict', 'OCEAN ##VA')), false);
T('our tag on somebody else’s airline does not', H.callsignFitsVa('DELTA 12VA', ad('strict', 'OCEAN ##VA')), false);
T('a non-"VA" tag behaves identically', H.callsignFitsVa('SHAMROCK 4EX', ad('strict', 'SHAMROCK ###EX')), true);
T('…and its untagged form is refused too', H.callsignFitsVa('SHAMROCK 4', ad('strict', 'SHAMROCK ###EX')), false);
// A VA that registered no tag has nothing to require, so strict is the airline.
T('a tagless mask matches on the airline alone', H.callsignFitsVa('BAW 42', ad('strict', 'BAW ###')), true);
T('a multi-word airline is matched whole, not on its first word',
    H.callsignFitsVa('AIR FRANCE 001VA', ad('strict', 'AIR CANADA ##VA')), false);

console.log('\ncallsignFitsVa — broad');
T('the tag is waived', H.callsignFitsVa('OCEAN 12', ad('broad', 'OCEAN ##VA')), true);
T('so is a foreign tag', H.callsignFitsVa('OCEAN 12XY', ad('broad', 'OCEAN ##VA')), true);
T('the airline is not', H.callsignFitsVa('DELTA 12VA', ad('broad', 'OCEAN ##VA')), false);

console.log('\ncallsignFitsVa — the edges');
T('an unknown mode is strict, never the loosest',
    H.callsignFitsVa('OCEAN 12', ad('whatever', 'OCEAN ##VA')), false);
T('a listing with no callsigns fits nothing', H.callsignFitsVa('OCEAN 12VA', ad('broad')), false);
T('an empty callsign fits nothing', H.callsignFitsVa('', ad('broad', 'OCEAN ##VA')), false);
T('the legacy single-callsign field is read too',
    H.callsignFitsVa('OCEAN 12VA', { callsignMatch: 'strict', callsigns: [], callsign: 'OCEAN ##VA' }), true);
T('a legacy bare base is read as the "VA" tag',
    H.callsignFitsVa('OCEAN 12VA', ad('strict', 'OCEAN')), true);

/* ===========================================================================
 * embedCallsignsFromAd — what the live map is handed to match on
 *
 * An embed created without prefix/suffix lists used to fall back to the bare
 * `va.code` and NO suffix, so the tag the VA had registered never reached the
 * widget: "only my VA callsigns" was selected, and the map showed every flight
 * on the airline anyway. Worse, `va.code` is read as a single token by the
 * widget, so a two-word airline matched on its first word alone.
 * ======================================================================== */
console.log('\nembedCallsignsFromAd — the embed inherits what the VA registered');
const cfgOf = (over) => Object.assign({ va: { code: 'OCEAN' }, callsignPrefixes: [], callsignSuffixes: [] }, over);

T('an empty embed inherits the airline and the tag',
    H.embedCallsignsFromAd(cfgOf(), { callsigns: ['OCEAN ##VA'] }),
    { prefixes: ['OCEAN'], suffixes: ['VA'] });
T('…including a tag that is not "VA"',
    H.embedCallsignsFromAd(cfgOf(), { callsigns: ['SHAMROCK ###EX'] }),
    { prefixes: ['SHAMROCK'], suffixes: ['EX'] });
T('a two-word airline arrives whole, not as its first word',
    H.embedCallsignsFromAd(cfgOf({ va: { code: 'AIR CANADA' } }), { callsigns: ['AIR CANADA ##VA'] }),
    { prefixes: ['AIR CANADA'], suffixes: ['VA'] });
T('every registered callsign contributes',
    H.embedCallsignsFromAd(cfgOf(), { callsigns: ['OCEAN ##VA', 'SHAMROCK ###EX'] }),
    { prefixes: ['OCEAN', 'SHAMROCK'], suffixes: ['VA', 'EX'] });
T('a VA that registered no tag hands the widget none',
    H.embedCallsignsFromAd(cfgOf(), { callsigns: ['BAW ###'] }),
    { prefixes: ['BAW'], suffixes: [] });
T('what staff typed on the embed always wins',
    H.embedCallsignsFromAd(cfgOf({ callsignPrefixes: ['Jazz'], callsignSuffixes: ['JZ'] }), { callsigns: ['OCEAN ##VA'] }),
    { prefixes: ['Jazz'], suffixes: ['JZ'] });
T('with no listing to read, the embed code is reduced to its airline',
    H.embedCallsignsFromAd(cfgOf({ va: { code: 'OCEAN ##VA' } }), null),
    { prefixes: ['OCEAN'], suffixes: [] });

/* ===========================================================================
 * 'tag' mode — the codeshare case the whole dial used to miss
 *
 * Norwegian registers "RED NOSE ##NV" and its pilots keep the "NV" when they
 * fly a partner's metal: "Shamrock 12NV". Every rule tested the AIRLINE first
 * and returned early, so the tag could confirm a flight on Red Nose but never
 * claim one on Shamrock — and the ACARS matcher dropped the leg before the feed
 * ever saw it. 'tag' asks about the tag first.
 * ======================================================================== */
const NORWEGIAN = (mode) => ({ callsignMatch: mode, callsigns: ['RED NOSE ##NV'] });

console.log('\ncallsignFitsVa — tag mode (the codeshare answer)');
T('own metal still counts', H.callsignFitsVa('RED NOSE 12NV', NORWEGIAN('tag')), true);
T('a codeshare carrying our tag counts', H.callsignFitsVa('SHAMROCK 12NV', NORWEGIAN('tag')), true);
T('…however it is spaced', H.callsignFitsVa('Shamrock 12NV', NORWEGIAN('tag')), true);
T('…with a trailing word', H.callsignFitsVa('SHAMROCK 12NV Cargo', NORWEGIAN('tag')), true);
T('…or a weight class', H.callsignFitsVa('SHAMROCK 12NV Heavy', NORWEGIAN('tag')), true);
T('the same codeshare WITHOUT our tag does not', H.callsignFitsVa('SHAMROCK 12', NORWEGIAN('tag')), false);
T('somebody else\u2019s tag does not', H.callsignFitsVa('SHAMROCK 12EX', NORWEGIAN('tag')), false);
T('our airline untagged still needs the tag', H.callsignFitsVa('RED NOSE 12', NORWEGIAN('tag')), false);
// The regression this mode exists for: every other mode says no.
T('strict rejects the codeshare', H.callsignFitsVa('SHAMROCK 12NV', NORWEGIAN('strict')), false);
T('broad rejects it too — it tests the airline, not the tag',
    H.callsignFitsVa('SHAMROCK 12NV', NORWEGIAN('broad')), false);
T('exact rejects it', H.callsignFitsVa('SHAMROCK 12NV', NORWEGIAN('exact')), false);

console.log('\ntag mode — a tag has to identify ONE VA to claim a flight alone');
T('"VA" is not distinctive', H.isDistinctiveVaTag('VA'), false);
T('a single letter is not', H.isDistinctiveVaTag('X'), false);
T('"NV" is', H.isDistinctiveVaTag('NV'), true);
T('a VA whose tag is "VA" gains nothing on another airline',
    H.callsignFitsVa('SHAMROCK 12VA', { callsignMatch: 'tag', callsigns: ['OCEAN ##VA'] }), false);
T('…but its own airline still matches',
    H.callsignFitsVa('OCEAN 12VA', { callsignMatch: 'tag', callsigns: ['OCEAN ##VA'] }), true);
T('only the distinctive tag of a mixed listing claims other airlines',
    H.callsignFitsVa('SHAMROCK 9NV', { callsignMatch: 'tag', callsigns: ['OCEAN ##VA', 'RED NOSE ##NV'] }), true);

/* ===========================================================================
 * rosterTrust: 'tagged' — the mirror image of 'airline', not a tighter one
 *
 * It used to demand the airline AND the tag, which made it strictly narrower
 * than 'airline' and useless for the case it is named after. It keeps the tag
 * and waives the AIRLINE.
 * ======================================================================== */
console.log('\nrosterTrust — which half of the callsign each level keeps');
const NOR = { callsigns: ['RED NOSE ##NV'] };
// Mirrors the `recognised` filter in resolveVaEventPartnerByRoster.
const vouches = (trust, callsign, va) => {
    if (trust === 'off') return false;
    if (trust === 'tagged') return H.callsignCarriesVaTag(callsign, va);
    if (trust === 'airline') return H.callsignSharesVaBase(callsign, va.callsigns);
    return H.callsignSharesVaBase(callsign, va.callsigns) || H.callsignCarriesVaTag(callsign, va);
};
T('tagged: a rostered pilot\u2019s codeshare with our tag counts',
    vouches('tagged', 'SHAMROCK 12NV', NOR), true);
T('tagged: the same codeshare untagged does not', vouches('tagged', 'SHAMROCK 12', NOR), false);
T('tagged: our own airline with the tag counts', vouches('tagged', 'RED NOSE 12NV', NOR), true);
T('tagged: our own airline WITHOUT the tag does not', vouches('tagged', 'RED NOSE 12', NOR), false);
T('airline: our airline untagged counts', vouches('airline', 'RED NOSE 12', NOR), true);
T('airline: the tagged codeshare does NOT — that is what tagged is for',
    vouches('airline', 'SHAMROCK 12NV', NOR), false);
T('off: neither counts', vouches('off', 'SHAMROCK 12NV', NOR), false);

/* ===========================================================================
 * The tag written as its own token — "000 NV"
 *
 * Pilots type the tag both glued to the number ("000NV") and spaced off it
 * ("000 NV"). tokenHasSuffixTag accepts a standalone tag, but the tail window is
 * only two tokens wide, so anything appended after it — a division word, a
 * weight class, or both — has to be peeled off first or the tag falls out of
 * range. callsignCarriesVaTag used a raw split and did not peel.
 * ======================================================================== */
console.log('\nthe tag as a separate token');
const NORW = { callsigns: ['RED NOSE ##NV'] };
T('a standalone tag is carried', H.callsignCarriesVaTag('Shamrock 000 NV', NORW), true);
T('…behind a weight class', H.callsignCarriesVaTag('Shamrock 000 NV Heavy', NORW), true);
T('…behind a word and a weight class', H.callsignCarriesVaTag('Shamrock 000 NV Cargo Heavy', NORW), true);
T('…on the VA\u2019s own airline too', H.callsignCarriesVaTag('Red Nose 000 NV', NORW), true);
T('a standalone foreign tag is not ours', H.callsignCarriesVaTag('Shamrock 000 EX', NORW), false);
T('no tag at all', H.callsignCarriesVaTag('Shamrock 000', NORW), false);

T('tag mode takes the spaced codeshare',
    H.callsignFitsVa('Shamrock 000 NV', { callsignMatch: 'tag', ...NORW }), true);
T('strict takes the spaced tag on our own airline',
    H.callsignFitsVa('Red Nose 000 NV', { callsignMatch: 'strict', ...NORW }), true);
T('exact takes it too — it compacts before testing the shape',
    H.callsignFitsVa('Red Nose 000 NV', { callsignMatch: 'exact', ...NORW }), true);

/* ===========================================================================
 * Which rosters the ACARS matcher has to watch by name
 *
 * That side forwards on the CALLSIGN RULE, which for a VA with a tag requires
 * the tag. Every rosterTrust level except 'off' waives some part of that rule,
 * so every one of them needs its pilots watched — otherwise the flight the
 * level exists for is dropped before delivery can apply the roster at all.
 *
 * 'airline' is the default, and it was missing: an untagged "Red Nose 000" by a
 * member showed on the VA's map (the widget holds the roster itself) and never
 * once reached Discord.
 * ======================================================================== */
console.log('\nroster-watch eligibility');
T('airline is watched — the tag it waives is what the matcher requires',
    H.VA_ROSTER_WATCH_TRUST_MODES.includes('airline'), true);
T('tagged is watched — the airline it waives is a partner\u2019s',
    H.VA_ROSTER_WATCH_TRUST_MODES.includes('tagged'), true);
T('any is watched', H.VA_ROSTER_WATCH_TRUST_MODES.includes('any'), true);
T('off is NOT watched — it waives nothing, so the callsign rule covers it',
    H.VA_ROSTER_WATCH_TRUST_MODES.includes('off'), false);
T('and it stays derived from the real list, never a second hand-kept copy',
    H.VA_ROSTER_WATCH_TRUST_MODES.length, H.VA_ROSTER_TRUST_MODES.length - 1);

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

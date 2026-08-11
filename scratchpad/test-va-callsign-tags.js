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
const source = [
    lift('vaCallsignParts'),
    lift('compactCallsign'),
    lift('callsignSharesVaBase'),
    lift('formatCallsignDisplay'),
].join('\n');
// eslint-disable-next-line no-new-func
const H = new Function(`${source}\nreturn { vaCallsignParts, compactCallsign, callsignSharesVaBase, formatCallsignDisplay };`)();

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

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

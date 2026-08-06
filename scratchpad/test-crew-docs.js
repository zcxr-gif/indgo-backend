'use strict';
// Conformance test for crewDocs — the library, and who may read what.
//
// The cases checked here are the ones that would either leak a gated document or
// hand a pilot the wrong version of the manual:
//
//   * a source switch CLEARS the fields it is not using, so a VA who pastes a
//     link over a half-written body does not leave a second, stale copy of the
//     manual behind for the reader to be given at random
//   * a missing `source` is inferred most-specific-first (file, link, body)
//     rather than defaulting everything to an empty text document
//   * a gated document reaches a short-of-the-rung pilot with EVERY content
//     field stripped — body, link, file URL, and the file's name and size
//   * the same document is withheld entirely from the public, because a stranger
//     has no rung to be short of
//   * staff see drafts and gated rows; a pilot never sees a draft
//   * a lapsed gate (the VA renamed the rung) opens rather than locking the
//     library, matching crewRanks.meetsRank
//   * `revisedAt` moves for content and for a new revision label, and does NOT
//     move for a retitle — the marker has to mean something or pilots learn to
//     ignore it
//   * publishing refuses a document whose content is empty, per source
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const D = require(path.join('..', 'crewDocs.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// A three-rung ladder. Captain requires 100h.
const ranks = [
    { name: 'Cadet', minHours: 0 },
    { name: 'First Officer', minHours: 25 },
    { name: 'Captain', minHours: 100 },
];

console.log('\ncrewDocs — one source, and only one');

T('a link clears a body left behind',
    (() => { const d = D.normalizeDocument({ title: 'Ops', source: 'link', body: 'old draft', linkUrl: 'https://x/y' });
        return [d.source, d.body, d.linkUrl]; })(),
    ['link', '', 'https://x/y']);

T('a file clears both the body and the link',
    (() => { const d = D.normalizeDocument({ source: 'file', body: 'b', linkUrl: 'https://x', fileUrl: 'https://s3/m.pdf', fileName: 'm.pdf', fileSize: 42 });
        return [d.body, d.linkUrl, d.fileUrl, d.fileSize]; })(),
    ['', '', 'https://s3/m.pdf', 42]);

T('text clears a stale file name and size',
    (() => { const d = D.normalizeDocument({ source: 'text', body: 'words', fileUrl: 'https://s3/old.pdf', fileName: 'old.pdf', fileSize: 99 });
        return [d.fileUrl, d.fileName, d.fileSize]; })(),
    ['', '', 0]);

console.log('\ncrewDocs — inferring a missing source');

T('a file URL alone means file',   D.resolveSource({ fileUrl: 'https://s3/a.pdf' }), 'file');
T('a link alone means link',       D.resolveSource({ linkUrl: 'https://x/y' }), 'link');
T('a body alone means text',       D.resolveSource({ body: 'words' }), 'text');
T('nothing at all means text',     D.resolveSource({}), 'text');
T('file wins over link and body',  D.resolveSource({ body: 'w', linkUrl: 'https://x', fileUrl: 'https://s3/a' }), 'file');
T('a bogus source is re-inferred', D.resolveSource({ source: 'telepathy', linkUrl: 'https://x' }), 'link');

console.log('\ncrewDocs — the gate');

const gated = D.normalizeDocument({
    title: 'Captain SOP', summary: 'Long-haul.', kind: 'sop', source: 'file', status: 'published',
    minRank: 'Captain', fileUrl: 'https://s3/sop.pdf', fileName: 'sop.pdf', fileSize: 4200,
});
const open = D.normalizeDocument({ title: 'Ops Manual', kind: 'manual', source: 'text', body: 'Everyone.', status: 'published' });
const draft = D.normalizeDocument({ title: 'Half-written', source: 'text', body: 'wip', status: 'draft' });

const shortOf = D.visibleTo(gated, { viewer: { hours: 62 }, ranks });
T('a short-of-the-rung pilot still SEES it', !!shortOf, true);
T('…locked, with the hours to go',           [shortOf.locked, shortOf.hoursUntilUnlock], [true, 38]);
T('…and the title and summary survive',      [shortOf.title, shortOf.summary], ['Captain SOP', 'Long-haul.']);
T('…but every content field is stripped',
    [shortOf.body, shortOf.linkUrl, shortOf.fileUrl, shortOf.fileName, shortOf.fileSize],
    ['', '', '', '', 0]);

const captain = D.visibleTo(gated, { viewer: { hours: 140 }, ranks });
T('a Captain gets the file',      [captain.locked, captain.fileUrl], [false, 'https://s3/sop.pdf']);
T('…with its name and size back', [captain.fileName, captain.fileSize], ['sop.pdf', 4200]);

T('the public does not see a gated document at all',
    D.visibleTo(gated, { viewer: null, ranks }), null);
T('the public does see an ungated published one',
    (D.visibleTo(open, { viewer: null, ranks }) || {}).body, 'Everyone.');
T('a pilot never sees a draft',
    D.visibleTo(draft, { viewer: { hours: 999 }, ranks }), null);
T('staff see a draft',
    (D.visibleTo(draft, { staff: true, ranks }) || {}).body, 'wip');
T('staff are never marked locked',
    (D.visibleTo(gated, { staff: true, ranks }) || {}).locked, false);

T('a gate naming a rung the ladder no longer has lapses open',
    (() => { const d = D.normalizeDocument({ title: 'x', source: 'text', body: 'b', status: 'published', minRank: 'Commodore' });
        const v = D.visibleTo(d, { viewer: { hours: 0 }, ranks });
        return [!!v, v && v.locked, v && v.body]; })(),
    [true, false, 'b']);

console.log('\ncrewDocs — the library as one viewer sees it');

const all = [draft, gated, open, D.normalizeDocument({ title: 'Uniform form', kind: 'form', source: 'text', body: 'f', status: 'published' })];

T('a pilot short of Captain gets three of the four, draft excluded',
    D.libraryFor(all, { viewer: { hours: 10 }, ranks }).map((d) => d.title),
    ['Ops Manual', 'Captain SOP', 'Uniform form']);
T('the public gets only the ungated two',
    D.libraryFor(all, { viewer: null, ranks }).map((d) => d.title),
    ['Ops Manual', 'Uniform form']);
T('staff get everything',
    D.libraryFor(all, { staff: true, ranks }).length, 4);

T('kinds sort in the order a VA thinks about them — manual first, generic last',
    D.libraryFor([
        D.normalizeDocument({ title: 'Anything', source: 'text', body: 'd', status: 'published' }),
        D.normalizeDocument({ title: 'A form', kind: 'form', source: 'text', body: 'f', status: 'published' }),
        D.normalizeDocument({ title: 'The manual', kind: 'manual', source: 'text', body: 'm', status: 'published' }),
    ], { staff: true, ranks }).map((d) => d.title),
    ['The manual', 'A form', 'Anything']);

T('pinned sorts above everything, regardless of kind',
    D.libraryFor([
        D.normalizeDocument({ title: 'Forms', kind: 'form', source: 'text', body: 'f', status: 'published' }),
        D.normalizeDocument({ title: 'Read me first', kind: 'form', source: 'text', body: 'p', status: 'published', pinned: true }),
    ], { staff: true, ranks }).map((d) => d.title),
    ['Read me first', 'Forms']);

T('the summary counts what is shut to the pilot asking',
    (() => { const s = D.librarySummary(all, { viewer: { hours: 10 }, ranks });
        return [s.total, s.open, s.locked]; })(),
    [3, 2, 1]);

console.log('\ncrewDocs — what counts as a revision');

const before = { source: 'text', body: 'v1 text', revision: 'Rev A', linkUrl: '', fileUrl: '' };
T('a body rewrite is substantive',      D.isSubstantiveChange(before, { body: 'v2 text' }), true);
T('a new revision label is substantive', D.isSubstantiveChange(before, { revision: 'Rev B' }), true);
T('changing where the words live is too', D.isSubstantiveChange(before, { source: 'link' }), true);
T('a retitle is NOT',                    D.isSubstantiveChange(before, { title: 'Ops Manual (2026)' }), false);
T('pinning is NOT',                      D.isSubstantiveChange(before, { pinned: true }), false);
T('re-saving the same body is NOT',      D.isSubstantiveChange(before, { body: 'v1 text' }), false);
T('re-typing the same revision is NOT',  D.isSubstantiveChange(before, { revision: 'Rev A' }), false);

console.log('\ncrewDocs — publishing');

T('a titleless document is refused',
    !!D.publishProblem(D.normalizeDocument({ source: 'text', body: 'b' })), true);
T('an empty text document is refused',
    !!D.publishProblem(D.normalizeDocument({ title: 'T', source: 'text' })), true);
T('a link document with no link is refused',
    !!D.publishProblem(D.normalizeDocument({ title: 'T', source: 'link' })), true);
T('a file document with nothing uploaded is refused',
    !!D.publishProblem(D.normalizeDocument({ title: 'T', source: 'file' })), true);
T('a complete one is allowed',
    D.publishProblem(D.normalizeDocument({ title: 'T', source: 'text', body: 'words' })), '');

console.log(failures ? `\n${failures} failed ❌\n` : '\nAll good ✅\n');
process.exit(failures ? 1 : 0);

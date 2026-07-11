'use strict';
// Offline conformance test for vaPilots.parsePilotUsernames — the shared parser
// that turns whatever staff/VAs paste or upload (a plain list, a CSV/TSV/
// semicolon table, a JSON array, an Excel export with a BOM) into a clean,
// de-duplicated username list. No DB, no network.
//
// vaPilots.js pulls in mongoose only for its DB helpers, so stub the module
// before requiring it — the parser itself never touches the database.
const path = require('path');
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'mongoose') {
        return {
            Types: { ObjectId: { isValid: () => true } },
            Schema: function () { this.index = () => {}; },
            models: {}, model: () => ({}),
        };
    }
    return origLoad.call(this, req, ...rest);
};

const { parsePilotUsernames, MAX_BULK } = require(path.join('..', 'vaPilots.js'));

let failures = 0;
const names = (v) => parsePilotUsernames(v).map((p) => p.username);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const T = (label, input, expected) => {
    const got = names(input);
    if (eq(got, expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ❌', label, '\n     got', JSON.stringify(got), '\n     exp', JSON.stringify(expected));
};

console.log('• plain & delimited lists');
T('newline list', 'Antony\nBob\nCharlie', ['Antony', 'Bob', 'Charlie']);
T('comma list on one line stays a list', 'JohnDoe, Jane_Doe', ['JohnDoe', 'Jane_Doe']);
T('semicolon list', 'Antony; Bob; Charlie', ['Antony', 'Bob', 'Charlie']);
T('mixed newlines + commas', 'Antony, Bob\nCharlie', ['Antony', 'Bob', 'Charlie']);
T('leading @ and case-insensitive de-dupe', '@Antony\nantony\nBOB', ['Antony', 'BOB']);
T('multi-column but no header = flat list', 'Antony, Bob\nCharlie, Dave', ['Antony', 'Bob', 'Charlie', 'Dave']);
T('multi-word usernames are not split on spaces', 'Antony R\nJane Doe', ['Antony R', 'Jane Doe']);

console.log('• CSV / TSV / semicolon tables with headers');
T('csv, username in 2nd column', 'id,username,rank\n1,Antony,Capt\n2,Bob,FO', ['Antony', 'Bob']);
T('csv, IFC header first column', 'IFC,Hours\nantony_r,120\nbobk,80', ['antony_r', 'bobk']);
T('csv, multi-word header picks username col', 'Name,IFC Username\nAntony R,antony_r\nBob K,bobk', ['antony_r', 'bobk']);
T('tsv with header', 'username\trank\nAntony\tCapt\nBob\tFO', ['Antony', 'Bob']);
T('semicolon table with header', 'pilot;grade\nAntony;3\nBob;4', ['Antony', 'Bob']);
T('quoted field containing a comma', '"username","note"\n"Antony","hi, there"\n"Bob","x"', ['Antony', 'Bob']);
T('lone header line dropped', 'username\nAntony\nBob', ['Antony', 'Bob']);
T('CRLF + UTF-8 BOM (Excel export)', '﻿username,rank\r\nAntony,Capt\r\nBob,FO', ['Antony', 'Bob']);

console.log('• JSON');
T('json array of strings', '["Antony","Bob"]', ['Antony', 'Bob']);
T('json array of objects (username key)', '[{"username":"Antony"},{"username":"Bob"}]', ['Antony', 'Bob']);
T('json array of objects (ifc key + extras)', '[{"ifc":"antony_r","h":1},{"ifc":"bobk"}]', ['antony_r', 'bobk']);
T('json single object', '{"username":"Antony"}', ['Antony']);

console.log('• native array inputs (API clients)');
T('array of strings with a dupe', ['Antony', 'Bob', 'Antony'], ['Antony', 'Bob']);
T('array of record objects', [{ username: 'Antony' }, { pilot: 'Bob' }], ['Antony', 'Bob']);

console.log('• degenerate');
T('empty string', '', []);
T('whitespace only', '   \n  ', []);
T(`caps at MAX_BULK (${MAX_BULK})`, Array.from({ length: MAX_BULK + 500 }, (_, i) => 'p' + i),
    Array.from({ length: MAX_BULK }, (_, i) => 'p' + i));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll parser format checks passed ✅');
process.exit(failures ? 1 : 0);

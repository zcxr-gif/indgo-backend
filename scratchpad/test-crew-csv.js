'use strict';
// Conformance test for crewCsv — taking a roster or route network out to a
// spreadsheet and bringing it back.
//
// The properties worth protecting here are the ones that would quietly corrupt
// a live roster rather than throw:
//
//   * a file exported and re-imported unedited changes NOTHING. If this breaks,
//     every VA who opens their export in Excel and saves it duplicates their
//     whole roster.
//   * a row carrying its id updates that row; a row without one is matched on
//     the identifying fields, and matched to at most one thing
//   * a partial file (fewer columns) leaves the columns it omitted alone
//   * import never deletes, never touches rows the file didn't mention
//   * a file that lists the same person twice yields one person
//   * bad cells are reported by line number, and a file with any bad cell
//     applies none of itself
//   * the messy realities survive: quoted commas, semicolon lists, CRLF, a BOM,
//     header spellings that have been through three spreadsheet apps
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const crewCsv = require(path.join('..', 'crewCsv.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const ROSTER = [
    { id: 'm1', name: 'Ana Peña', callsign: 'AMX101', hours: 42.5, role: 'Captain', aircraft: ['A320', 'B738'], status: 'active', ifcName: 'anap', ifUserId: 'if-1' },
    { id: 'm2', name: 'Jo Smith, Jr.', callsign: 'AMX102', hours: 0, role: '', aircraft: [], status: 'loa', ifcName: '', ifUserId: '' },
];

const ROUTES = [
    { id: 'r1', flightNumber: 'AMX10', origin: 'MMMX', destination: 'KLAX', aircraft: 'B738', distanceNm: 1240, notes: 'Daily', active: true },
    { id: 'r2', flightNumber: '', origin: 'MMMX', destination: 'MMUN', aircraft: 'A320', distanceNm: 0, notes: '', active: false },
];

console.log('\ncrewCsv\n');

// --- Export shape -----------------------------------------------------------
console.log(' export');
const rosterCsv = crewCsv.toCsv(crewCsv.ROSTER_SPEC, ROSTER);
T('starts with a BOM so Excel reads UTF-8', rosterCsv.startsWith(crewCsv.BOM), true);
T('header names every column',
    rosterCsv.replace(crewCsv.BOM, '').split('\r\n')[0],
    'id,name,callsign,hours,role,aircraft,status,ifcName,ifUserId');
T('a comma inside a name is quoted, not escaped away',
    rosterCsv.includes('"Jo Smith, Jr."'), true);
T('aircraft lists join on semicolons', rosterCsv.includes('A320; B738'), true);
T('non-ASCII survives', rosterCsv.includes('Ana Peña'), true);
T('booleans are written as words', crewCsv.toCsv(crewCsv.ROUTES_SPEC, ROUTES).includes('true'), true);

// --- The round trip ---------------------------------------------------------
// The single most important property in this file.
console.log('\n round trip');
let plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, rosterCsv, ROSTER);
T('re-importing an untouched export creates nothing', plan.create.length, 0);
T('  …updates nothing', plan.update.length, 0);
T('  …and counts every row as unchanged', plan.unchanged, ROSTER.length);
T('  …with no errors', plan.errors, []);

const routesCsv = crewCsv.toCsv(crewCsv.ROUTES_SPEC, ROUTES);
plan = crewCsv.planImport(crewCsv.ROUTES_SPEC, routesCsv, ROUTES);
T('same for routes: nothing to do', [plan.create.length, plan.update.length, plan.unchanged], [0, 0, 2]);

// --- Editing an exported file ----------------------------------------------
console.log('\n edits');
const edited = rosterCsv.replace('42.5', '61.25').replace('Captain', 'Senior Captain');
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, edited, ROSTER);
T('an edited cell becomes one update', [plan.create.length, plan.update.length], [0, 1]);
T('  …targeting the row by its id', plan.update[0].id, 'm1');
T('  …carrying only what changed', plan.update[0].values, { hours: 61.25, role: 'Senior Captain' });
T('  …and leaving the other row alone', plan.unchanged, 1);

// --- Matching without ids ---------------------------------------------------
console.log('\n matching a hand-typed file');
const typed = 'name,callsign,hours\nAna Peña,AMX101,50\nNew Person,AMX999,3\n';
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, typed, ROSTER);
T('an existing callsign matches the existing pilot', plan.update.length, 1);
T('  …by callsign, not by id', plan.matchedOn, 'callsign');
T('  …and updates only the changed field', plan.update[0].values, { hours: 50 });
T('an unknown callsign is a new pilot', plan.create.length, 1);
T('  …with the values from the file', plan.create[0].values.name, 'New Person');
// The roster has m1 and m2; the file mentions only m1. m2 must appear nowhere
// in the plan — not as an update, not as a deletion, not at all.
T('a pilot in the roster but not in the file is untouched',
    plan.update.some((u) => u.id === 'm2'), false);
T('  …and the plan accounts for exactly the two file rows',
    plan.create.length + plan.update.length + plan.unchanged, 2);

// --- Partial columns --------------------------------------------------------
console.log('\n partial files');
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'callsign,hours\nAMX101,99\n', ROSTER);
T('a two-column file updates only that column', plan.update[0].values, { hours: 99 });
T('  …and reports what it did not carry',
    plan.missing.includes('role') && plan.missing.includes('status'), true);

// --- Duplicates within one file --------------------------------------------
console.log('\n duplicate lines');
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name,callsign,hours\nFresh One,AMX500,1\nFresh One,AMX500,2\n', []);
T('the same new pilot twice is created once', plan.create.length, 1);
T('  …and the second line updates the first', plan.update.length, 1);

// --- Header tolerance -------------------------------------------------------
console.log('\n header spellings');
plan = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'Flight Number,From,To,Distance NM\nAMX10,MMMX,KLAX,1300\n', ROUTES);
T('“Flight Number”, “From”, “To”, “Distance NM” all resolve', plan.errors, []);
T('  …and match the existing route', plan.update.length, 1);
T('  …updating just the distance', plan.update[0].values, { distanceNm: 1300 });

// --- Bad input --------------------------------------------------------------
console.log('\n bad input');
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name,hours\nOK Person,12\nBad Person,twelve\n', []);
T('a non-numeric number is reported', plan.errors.length, 1);
T('  …by line number, counting the header', plan.errors[0].line, 3);
T('  …and the good row is still planned', plan.create.length, 1);

plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name,status\nX,retired\n', []);
T('an unknown status is rejected with the allowed values',
    /active/.test(plan.errors[0].message), true);

plan = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'origin,destination\nQQ,KLAX\n', []);
T('a two-letter airport code is rejected', plan.errors.length, 1);

plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'id,name\nnope,Someone\n', ROSTER);
T('an id that matches nothing is an error, not a silent insert', plan.errors.length, 1);
T('  …and nothing is created from it', plan.create.length, 0);

T('an empty file is refused', !!crewCsv.planImport(crewCsv.ROSTER_SPEC, '   ', []).error, true);
T('a file with no recognisable header is refused',
    !!crewCsv.planImport(crewCsv.ROSTER_SPEC, 'colour,shape\nred,round\n', []).error, true);

// `required` is about creating a row, not about the file. A VA fixing hours for
// existing pilots sends two columns and must not be told to add a name column.
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'callsign,hours\nAMX101,4\n', ROSTER);
T('a file with no name column still updates matched pilots', plan.update.length, 1);
T('  …with no complaint about the missing column', plan.errors, []);
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'callsign,hours\nAMX404,4\n', ROSTER);
T('  …but an unmatched row in that file cannot be created', plan.create.length, 0);
T('  …and says why', /name/.test(plan.errors[0].message), true);
plan = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'flightNumber\nAMX999\n', ROUTES);
T('a new route with no airports is rejected per row', plan.errors.length, 1);

// --- Spreadsheet realities --------------------------------------------------
console.log('\n spreadsheet realities');
plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, '﻿name,callsign\r\nBOM Person,AMX700\r\n', []);
T('a BOM and CRLF line endings parse', plan.create.length, 1);
T('  …without the BOM sticking to the first header', plan.create[0].values.name, 'BOM Person');

plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name,aircraft\nList Person,"A320; B738; E190"\n', []);
T('a semicolon list becomes an array', plan.create[0].values.aircraft, ['A320', 'B738', 'E190']);

plan = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'origin,destination,active\nMMMX,KLAX,yes\nMMMX,MMUN,0\n', []);
T('“yes” and “0” both read as booleans',
    [plan.create[0].values.active, plan.create[1].values.active], [true, false]);

plan = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name,hours\n\n\nSpaced Out,5\n\n', []);
T('blank lines are skipped', plan.create.length, 1);

// --- Limits -----------------------------------------------------------------
const huge = 'name\n' + Array.from({ length: crewCsv.MAX_ROWS + 1 }, (_, i) => `P${i}`).join('\n') + '\n';
T('an absurdly large file is refused outright', !!crewCsv.planImport(crewCsv.ROSTER_SPEC, huge, []).error, true);

console.log(failures ? `\n${failures} failing check(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);

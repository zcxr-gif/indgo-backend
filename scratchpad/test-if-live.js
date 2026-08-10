'use strict';
// Conformance test for ifLive + the pure half of ifOAuth — Infinite Flight's
// PublicApi v3 preview, as this codebase understands it.
//
// WHAT IS ACTUALLY WORTH TESTING HERE, and why these cases and not others.
//
// This is an integration against an API whose own documentation says its
// "endpoint paths, scopes, response fields, enum values, validation rules, rate
// limits, access rules and app review behavior may change". So the failure this
// file is written to catch is not "we got a field wrong" — a deploy fixes that.
// It is the class of failure where a CHANGE AT INFINITE FLIGHT'S END TAKES THE
// CREW CENTER DOWN, which no deploy of ours can pre-empt:
//
//   * an enum value we have not been told about must be a label, never a throw
//     and never a silent coercion to Unknown (ScheduledFlightStatus has a
//     visible hole at 5 today — that is the case in the file);
//   * a field we have never seen must be KEPT, so a rename degrades to "not
//     drawn yet" rather than "data gone";
//   * a validation rule must never be STRICTER than the published one, or we
//     refuse things Infinite Flight would have accepted.
//
// Then the parts where being wrong is expensive rather than merely broken:
// PKCE (the whole security of a public client), the reorder plan (a rota is
// what an aeroplane actually flies), and the crew-schedule bridge (a mapping
// error here duplicates legs on somebody's real aircraft).
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const L = require(path.join('..', 'ifLive.js'));
const O = require(path.join('..', 'ifOAuth.js'));
const crypto = require('crypto');

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const OK = (label, cond) => T(label, !!cond, true);

// ---------------------------------------------------------------------------
console.log('\nEnums — a value we have not been told about');
// ---------------------------------------------------------------------------

T('a documented status decodes', L.describeEnum(L.SCHEDULE_STATUS, 6),
    { value: 6, name: 'InFlight', label: 'In flight' });

// 5 is genuinely absent from the published ScheduledFlightStatus table, sitting
// between TaxiingToRunway (4) and InFlight (6). The day Infinite Flight fills it
// in, every crew center in the fleet receives it at once.
T('an undocumented status is labelled, not rejected', L.describeEnum(L.SCHEDULE_STATUS, 5),
    { value: 5, name: '', label: 'Status 5' });
T('an undocumented status is NOT coerced to Unknown',
    L.describeEnum(L.SCHEDULE_STATUS, 5).name === 'Unknown', false);
T('a wildly out-of-range value still answers', L.describeEnum(L.FLIGHT_TYPE, 999),
    { value: 999, name: '', label: 'Status 999' });
T('null is an absence, not a zero', L.describeEnum(L.FLIGHT_TYPE, null),
    { value: null, name: '', label: '' });
// Zero is a real value in every one of these tables (None, Unknown, AutoJoin,
// Solo, Active), so it must not be swallowed by a falsy check.
T('zero is a value, not an absence', L.describeEnum(L.WORLD_TYPE, 0),
    { value: 0, name: 'Solo', label: 'Solo' });

T('a name resolves to its value', L.enumValue(L.FLIGHT_TYPE, 'Cargo'), 3);
T('a name resolves case-insensitively', L.enumValue(L.FLIGHT_TYPE, 'cargo'), 3);
T('an unknown name falls back', L.enumValue(L.FLIGHT_TYPE, 'Spaceflight', 1), 1);

// ---------------------------------------------------------------------------
console.log('\nShapes — a field we have never seen is kept');
// ---------------------------------------------------------------------------

const rawSchedule = {
    id: 'fd0f8a7c-fab2-4fd0-baf7-4b87e8f7cc2f',
    status: 1, callsign: 'PJX421',
    organizationId: '1337830a-abf9-4315-9488-e8cebd7f485a',
    aircraftId: '28fb4508-9eca-4120-abe4-3c4f06f6e71c',
    flightType: 1, originIcao: 'KLAX', destinationIcao: 'KJFK',
    scheduledDepartureUtc: '2026-07-03T18:30:00Z',
    scheduledArrivalUtc: '2026-07-03T23:45:00Z',
    actualDepartureUtc: null, actualArrivalUtc: null,
    briefing: 'Scheduled transcontinental service.',
    debriefing: null, flightPlan: 'KLAX DCT KJFK', sequence: 1,
    createdAt: '2026-07-03T12:00:00Z', updatedAt: '2026-07-03T12:00:00Z',
    // The thing this test exists for.
    gateAssignment: '42B',
};
const sched = L.publicSchedule(rawSchedule);
T('a documented field survives', sched.callsign, 'PJX421');
T('block time is derived', sched.blockMinutes, 315);
T('an unexpected field is kept', sched.extra, { gateAssignment: '42B' });
T('the leg reads as words', L.describeSchedule(sched), 'PJX421 · KLAX → KJFK');
// A VA that fills the airports in later gets the callsign, not empty arrows.
T('a half-filled leg does not print empty arrows',
    L.describeSchedule({ callsign: 'BA117', originIcao: '', destinationIcao: '' }), 'BA117');

const rawAircraft = {
    id: '28fb4508-9eca-4120-abe4-3c4f06f6e71c',
    aircraftId: '3f78766a-30c8-4d65-95ae-ebc2fb758aac',
    organizationId: '1337830a-abf9-4315-9488-e8cebd7f485a',
    registration: 'N682XL', status: 0, visibility: 1,
    fleetPriority: 1000, fleetRank: 1, isFleetActiveSlot: true,
    createdAt: '2026-07-03T12:00:00Z',
};
const ac = L.publicAircraft(rawAircraft);
// The two ids are different things and the preview is blunt about it. Getting
// them the wrong way round is a 404 against a fleet you are looking at.
T('the persistent id is `id`, not `aircraftId`', ac.id, '28fb4508-9eca-4120-abe4-3c4f06f6e71c');
T('the content id is preserved separately', ac.aircraftId, '3f78766a-30c8-4d65-95ae-ebc2fb758aac');
T('an in-slot visible aircraft is active', ac.storage, 'active');
T('out of slot but visible reads as storage',
    L.publicAircraft({ ...rawAircraft, isFleetActiveSlot: false }).storage, 'storage');
// Hangared beats out-of-slot: an aircraft that is both is put away, and saying
// "storage" about it would suggest the fleet order is the reason.
T('hangared beats out-of-slot',
    L.publicAircraft({ ...rawAircraft, visibility: 2, isFleetActiveSlot: false }).storage, 'hangared');

// ---------------------------------------------------------------------------
console.log('\nPositions — a stored reading is not a live one');
// ---------------------------------------------------------------------------

const now = Date.parse('2026-07-03T12:10:00Z');
const fresh = L.publicPosition({
    id: 'x', state: 2, isOnGround: false, latitude: 27.3172, longitude: 48.6787,
    altitude: 34750, heading: 83.4, speed: 451.2, verticalSpeed: 0,
    lastPilotUsername: 'Chhettri22', updatedAt: '2026-07-03T12:05:00Z',
}, now);
T('a recent reading is not stale', fresh.stale, false);
T('a recent reading has a fix', fresh.hasFix, true);
T('its age is in milliseconds', fresh.ageMs, 5 * 60 * 1000);

const old = L.publicPosition({ id: 'x', state: 2, latitude: 1, longitude: 1, updatedAt: '2026-07-03T10:00:00Z' }, now);
T('a two-hour-old reading is stale', old.stale, true);
// 0,0 is very nearly always "we have never had one" rather than the Gulf of
// Guinea, and a fleet board that drops a pin there looks broken.
T('a null island position is not a fix',
    L.publicPosition({ id: 'x', latitude: 0, longitude: 0, updatedAt: '2026-07-03T12:09:00Z' }, now).hasFix, false);
T('no timestamp at all counts as stale',
    L.publicPosition({ id: 'x', latitude: 5, longitude: 5 }, now).stale, true);

// ---------------------------------------------------------------------------
console.log('\nScheduleRequest — no stricter than the published rules');
// ---------------------------------------------------------------------------

const good = L.scheduleRequest({
    callsign: 'PJX421', flightType: 1,
    originIcao: 'klax', destinationIcao: 'kjfk',
    scheduledDepartureUtc: '2026-07-03T18:30:00Z',
    scheduledArrivalUtc: '2026-07-03T23:45:00Z',
    briefing: 'Scheduled transcontinental service.',
    flightPlan: 'KLAX DCT KJFK',
});
OK('a valid schedule passes', good.ok);
T('ICAOs are stored uppercase', [good.value.originIcao, good.value.destinationIcao], ['KLAX', 'KJFK']);
T('times come out as UTC instants', good.value.scheduledDepartureUtc, '2026-07-03T18:30:00.000Z');

// "Control characters are not allowed." Stripped rather than refused — a
// callsign pasted out of a spreadsheet routinely carries a stray tab.
T('control characters are stripped from the callsign',
    L.scheduleRequest({ ...good.value, callsign: 'PJX\t421 ' }).value.callsign, 'PJX 421');

T('arrival before departure is refused',
    L.scheduleRequest({ ...good.value, scheduledArrivalUtc: '2026-07-03T17:00:00Z' }).ok, false);
T('arrival EQUAL to departure is refused',
    L.scheduleRequest({ ...good.value, scheduledArrivalUtc: good.value.scheduledDepartureUtc }).ok, false);
T('a missing callsign is refused', L.scheduleRequest({ ...good.value, callsign: '   ' }).ok, false);
T('a refusal names the field it is about',
    L.scheduleRequest({ ...good.value, originIcao: '' }).field, 'originIcao');

// The published rule is 1..8 alphanumeric. Anything inside that must pass —
// being stricter than the API is how a client refuses a request the API would
// have taken, and Infinite Flight's own example set includes non-ICAO codes.
OK('a three-character code is accepted', L.scheduleRequest({ ...good.value, originIcao: 'LAX' }).ok);
OK('an eight-character code is accepted', L.scheduleRequest({ ...good.value, originIcao: 'ABCDEFGH' }).ok);
T('a 32-character callsign is accepted',
    L.scheduleRequest({ ...good.value, callsign: 'A'.repeat(32) }).value.callsign.length, 32);
T('a briefing at exactly the limit is accepted',
    L.scheduleRequest({ ...good.value, briefing: 'x'.repeat(4000) }).ok, true);
// Refused, not truncated: a briefing silently cut off at 4,000 characters is a
// briefing that has lost its diversion plan without telling anyone.
T('an over-long briefing is refused rather than truncated',
    L.scheduleRequest({ ...good.value, briefing: 'x'.repeat(4001) }).ok, false);
T('an over-long flight plan is refused',
    L.scheduleRequest({ ...good.value, flightPlan: 'x'.repeat(16001) }).ok, false);

T('a flight type given by name is accepted',
    L.scheduleRequest({ ...good.value, flightType: 'Cargo' }).value.flightType, 3);
// An omitted type means a line flight, not None — None is what you pick on
// purpose.
T('an omitted flight type defaults to Commercial',
    L.scheduleRequest({ callsign: 'X1', originIcao: 'A', destinationIcao: 'B', scheduledDepartureUtc: '2026-01-01T00:00:00Z', scheduledArrivalUtc: '2026-01-01T01:00:00Z' }).value.flightType, 1);
// But an EXPLICIT None must survive, or a VA can never file one.
T('an explicit None survives', L.scheduleRequest({ ...good.value, flightType: 0 }).value.flightType, 0);

console.log('\nFlight plan and reorder requests');
T('an empty flight plan clears it', L.flightPlanRequest({ flightPlan: '' }),
    { ok: true, value: { flightPlan: null }, cleared: true });
T('null clears it too', L.flightPlanRequest({ flightPlan: null }).cleared, true);
T('a plan survives', L.flightPlanRequest({ flightPlan: 'KLAX DCT LAS DCT KJFK' }).value.flightPlan, 'KLAX DCT LAS DCT KJFK');

const A = 'fd0f8a7c-fab2-4fd0-baf7-4b87e8f7cc2f';
const B = '95d422b5-3c18-486d-95a7-1f8e06f10f57';
const C = '11111111-2222-3333-4444-555555555555';
T('afterId null means top', L.reorderRequest({ scheduleId: A, afterId: null }).value, { scheduleId: A, afterId: null });
T('an omitted afterId is sent as an explicit null', L.reorderRequest({ scheduleId: A }).value, { scheduleId: A, afterId: null });
T('a non-uuid is refused', L.reorderRequest({ scheduleId: 'nope' }).ok, false);
T('moving a schedule after itself is refused', L.reorderRequest({ scheduleId: A, afterId: A }).ok, false);

// ---------------------------------------------------------------------------
console.log('\nThe reorder plan — an arrangement becomes moves');
// ---------------------------------------------------------------------------

const rota = [{ id: A, status: 1 }, { id: B, status: 6 }, { id: C, status: 1 }];
T('the first goes to the top and the rest chain', L.reorderPlan([C, A, B], rota), [
    { scheduleId: C, afterId: null },
    { scheduleId: A, afterId: C },
    { scheduleId: B, afterId: A },
]);
// "Only schedules with status Scheduled or InFlight are reordered" — spending a
// call to be told so is waste.
T('a cancelled schedule is dropped from the plan',
    L.reorderPlan([A, B], [{ id: A, status: 9 }, { id: B, status: 1 }]),
    [{ scheduleId: B, afterId: null }]);
T('an arrived schedule is dropped too',
    L.reorderPlan([A], [{ id: A, status: 11 }]), []);
// But an unknown status is NOT dropped — refusing to move one because we have
// not heard of it is exactly the failure this integration is written to avoid.
T('an unknown status is still movable',
    L.reorderPlan([A], [{ id: A, status: 5 }]), [{ scheduleId: A, afterId: null }]);
T('a repeated id is not moved twice', L.reorderPlan([A, A, B], rota),
    [{ scheduleId: A, afterId: null }, { scheduleId: B, afterId: A }]);
T('junk in the list is ignored', L.reorderPlan(['', null, A], rota), [{ scheduleId: A, afterId: null }]);

// ---------------------------------------------------------------------------
console.log('\nThe bridge to the crew center\'s own schedule');
// ---------------------------------------------------------------------------

const crewRow = {
    _id: 'row-1', flightNumber: 'BA117', origin: 'EGLL', destination: 'KJFK',
    departsAt: '2026-07-03T18:30:00Z', blockMinutes: 420,
    notes: 'Evening service.', seats: 2, minRank: 'Captain', status: 'published',
};
const pushed = L.fromCrewSchedule(crewRow);
OK('a crew departure converts', pushed.ok);
T('the flight number becomes the callsign', pushed.value.callsign, 'BA117');
// Ours stores a departure and a block time; theirs wants two instants.
T('block time becomes an arrival', pushed.value.scheduledArrivalUtc, '2026-07-04T01:30:00.000Z');
T('an explicit arrival wins over the block time',
    L.fromCrewSchedule({ ...crewRow, arrivesAt: '2026-07-04T02:00:00Z' }).value.scheduledArrivalUtc,
    '2026-07-04T02:00:00.000Z');
// Ours makes an arrival optional and theirs does not. That leg is skipped by the
// push with a reason, not silently given an invented arrival time.
T('a departure with no arrival and no block time is refused',
    L.fromCrewSchedule({ ...crewRow, blockMinutes: 0 }).ok, false);

const pulled = L.toCrewSchedule(rawSchedule);
T('an import carries only the shared fields', Object.keys(pulled).sort(),
    ['blockMinutes', 'departsAt', 'destination', 'flightNumber', 'flightPlan', 'ifAircraftId', 'ifScheduleId', 'notes', 'origin'].sort());
// The crew center's own business: seats, the rank gate, draft/published, and
// the pilots who have booked. An import must never reset any of them.
OK('an import never carries seats', pulled.seats === undefined);
OK('an import never carries the rank gate', pulled.minRank === undefined);
OK('an import never carries publication status', pulled.status === undefined);
T('an import remembers where it came from', pulled.ifScheduleId, rawSchedule.id);

// Z against +00:00 is not a change, and treating it as one would make the panel
// claim every schedule had been edited in the app.
T('a timezone spelling is not a difference',
    L.scheduleDiff(good.value, { ...rawSchedule, scheduledDepartureUtc: '2026-07-03T18:30:00+00:00', briefing: good.value.briefing }),
    []);
T('a real change is reported',
    L.scheduleDiff(good.value, { ...rawSchedule, callsign: 'PJX999', briefing: good.value.briefing }),
    ['callsign']);

// ---------------------------------------------------------------------------
console.log('\nScopes — the panel offers what was granted, not what we asked');
// ---------------------------------------------------------------------------

T('openid is always present', L.normalizeScopes([]), ['openid']);
T('an unknown scope is dropped', L.normalizeScopes(['openid', 'live:launch.missiles']), ['openid']);
T('a duplicate is dropped', L.normalizeScopes(['openid', 'openid', 'profile']), ['openid', 'profile']);
T('a space-delimited string is accepted', L.normalizeScopes('openid profile'), ['openid', 'profile']);
T('the default set includes offline_access', L.DEFAULT_SCOPES.includes('offline_access'), true);
// A read-only grant must not produce a screen with save buttons on it.
T('read-only scopes cannot write', L.canWriteSchedules(L.READ_SCOPES), false);
T('the default scopes can write', L.canWriteSchedules(L.DEFAULT_SCOPES), true);

// ---------------------------------------------------------------------------
console.log('\nErrors — a queue and an answer are different things');
// ---------------------------------------------------------------------------

T('429 is worth retrying', L.isRetryable(429), true);
T('503 is worth retrying', L.isRetryable(503), true);
// A 403 will say no just as firmly the second time; retrying it is how an
// integration ends up hammering an endpoint that will never say yes.
T('403 is not worth retrying', L.isRetryable(403), false);
T('404 is not worth retrying', L.isRetryable(404), false);
OK('a write 403 explains the owner/admin rule',
    /owner or admin/.test(L.statusMessage(403, { write: true })));
OK('a read 403 explains membership and app testing',
    /member|testing/.test(L.statusMessage(403)));
OK('401 says to reconnect', /[Rr]econnect/.test(L.statusMessage(401)));

// ---------------------------------------------------------------------------
console.log('\nPKCE and the authorization request');
// ---------------------------------------------------------------------------

const p = O.pkce();
// RFC 7636 permits 43..128; 43 is what 32 random bytes base64url gives.
T('the verifier is 43 characters', p.verifier.length, 43);
OK('the verifier is base64url with no padding', /^[A-Za-z0-9_-]{43}$/.test(p.verifier));
T('the challenge is the S256 of the verifier',
    p.challenge, crypto.createHash('sha256').update(p.verifier).digest('base64url'));
T('the method is S256', p.method, 'S256');
OK('two verifiers differ', O.pkce().verifier !== O.pkce().verifier);

const url = O.authorizeUrl({
    clientId: 'ifc_your_client_id',
    redirectUri: 'https://example.com/oauth/callback',
    scopes: ['openid', 'profile', 'live:organizations.read', 'live:aircraft.read'],
    state: 'random_state', challenge: p.challenge,
});
OK('it is the documented authorize endpoint', url.startsWith('https://api.infiniteflight.com/auth/v2/connect/authorize?'));
OK('response_type is code', url.includes('response_type=code'));
OK('the redirect URI is percent-encoded', url.includes('redirect_uri=https%3A%2F%2Fexample.com%2Foauth%2Fcallback'));
// The published examples percent-encode the scope separator. URLSearchParams
// would have written '+', which is legal but is not what the docs show.
OK('scopes are space-delimited as %20', url.includes('scope=openid%20profile%20live%3Aorganizations.read'));
OK('the challenge method travels', url.includes('code_challenge_method=S256'));
// Off by default, so a returning VA can skip a repeat consent screen.
OK('prompt is absent unless asked for', !url.includes('prompt='));
OK('prompt=consent can be forced', O.authorizeUrl({
    clientId: 'c', redirectUri: 'https://e.com/cb', scopes: ['openid'],
    state: 's', challenge: p.challenge, prompt: 'consent',
}).includes('prompt=consent'));

OK('state comparison accepts a match', O.safeEqual('abc', 'abc'));
OK('state comparison rejects a mismatch', !O.safeEqual('abc', 'abd'));
OK('state comparison rejects different lengths', !O.safeEqual('abc', 'abcd'));
// Two empty states must not compare equal, or a callback carrying no state at
// all would authenticate against a row that also had none.
OK('two empty states are not equal', !O.safeEqual('', ''));

console.log(failures ? `\n${failures} failing\n` : '\nAll passing\n');
process.exit(failures ? 1 : 0);

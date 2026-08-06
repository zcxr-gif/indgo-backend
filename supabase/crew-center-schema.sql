-- ============================================================================
-- Inflight Crew Center — the schema a VA runs in their OWN Supabase project.
--
-- READ THIS FIRST
-- ---------------
-- A VA's operational data is the VA's property and lives in the VA's own
-- Postgres. Inflight does NOT keep a copy. What we keep centrally is only:
--
--     * the VA's *staff* logins (owner + team — usernames and bcrypt hashes),
--     * the VA's directory/branding metadata (name, slug, colours, fleet
--       definitions, rank ladder, join requirements),
--     * the connection details for the project defined below.
--
-- Everything with operational weight — who flies for the VA, how many hours
-- they have logged, every flight report, every membership application, the
-- applicant's email address, every EVENT and who signed up for it, every
-- SCHEDULED DEPARTURE and who booked it, every OPERATIONS DOCUMENT the VA
-- publishes to its crew, every MESSAGE sent to a pilot, and every
-- PILOT ACCOUNT (see crew_accounts) — is
-- created here, in this file's tables, inside the VA's project. If the VA
-- leaves the platform they keep the lot and we have nothing to hand back,
-- because we never held it.
--
-- HOW TO INSTALL
-- --------------
-- The crew dashboard installs this for you: Settings → Data store → Set up
-- automatically, paste a Supabase access token, pick a project. It runs this
-- exact file against the project and copies the keys back itself.
--
-- By hand, if you would rather:
-- 1. Supabase dashboard → SQL Editor → New query.
-- 2. Paste this whole file and Run. It is idempotent: running it again on an
--    already-provisioned project upgrades it in place and changes no data.
-- 3. Settings → API: copy the Project URL, the `anon` key and the
--    `service_role` key into Crew Center → Settings → Data store.
--
-- HOW TO UPDATE, LATER
-- --------------------
-- This file gains columns as the crew center gains features, and a project set
-- up a year ago has not got them. Crew dashboard → Settings → Data store →
-- Update my database runs the current version against the project you are
-- already connected to: your keys do not change, your data is not touched, and
-- it is safe to run as often as you like. Re-running the SQL by hand does the
-- same thing.
--
-- If you let the crew center keep your Supabase access token when you set up
-- (one tick, and you can withdraw it whenever you like), that update needs no
-- token pasted — and with "keep my database up to date" left on, it happens on
-- its own the first time the crew center notices this file has moved ahead of
-- your project. Nothing about what runs changes: it is this script, unmodified,
-- against the project you are already connected to.
--
-- Until then the crew center keeps working and simply cannot store what your
-- project has no column for — it says so at the time rather than failing the
-- write.
--
-- WHICH KEY DOES WHAT
-- -------------------
--   anon key          Public, safe in a browser. RLS (below) limits it to the
--                     things a crew center shows the world: the roster, the
--                     active route network and approved flight reports.
--   service_role key  Full access, bypasses RLS. Held only by the Inflight
--                     backend so it can write on the VA's behalf (accept an
--                     application, credit hours, capture a PIREP). Never send
--                     it to a browser.
--
-- MULTI-BRAND PROJECTS
-- --------------------
-- Every table carries `va_slug`. One project can therefore back several crew
-- centers (a parent brand plus a regional subsidiary, say) without their data
-- mixing — every query the backend issues is filtered by slug, and the unique
-- indexes are scoped by slug too.
-- ============================================================================

-- gen_random_uuid()
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Provisioning marker. The backend reads this to tell "connected but empty"
-- apart from "connected and ready", and to know whether the project is running
-- an older shape than the code expects.
-- ----------------------------------------------------------------------------
create table if not exists crew_schema_info (
    id          int primary key default 1 check (id = 1),
    version     int not null,
    installed_at timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Roster. One row per pilot flying for the VA.
--
-- `hours` is the credited total and is the number the rank ladder is read
-- against — rank itself is deliberately NOT stored, it is derived from hours
-- against the ladder the VA configures in the crew center, so editing the
-- ladder re-ranks everyone at once instead of leaving stale titles behind.
-- ----------------------------------------------------------------------------
create table if not exists crew_members (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    name        text not null default '',
    callsign    text not null default '',
    hours       numeric(12,4) not null default 0 check (hours >= 0),
    role        text not null default '',
    aircraft    text[] not null default '{}',
    status      text not null default 'active' check (status in ('active','loa','inactive')),
    -- Infinite Flight identity, carried over from the accepted application.
    -- A member with an if_user_id is eligible for automatic PIREP capture.
    if_user_id  text not null default '',
    ifc_name    text not null default '',
    -- ------------------------------------------------------------------------
    -- v7. Check-rides.
    --
    -- The names of the rungs this pilot has been signed off for. A VA can mark
    -- any rung of their ladder "requires a check-ride" (crew center settings →
    -- ranks), and a pilot who has the hours for such a rung does NOT hold it
    -- until their name appears here — they sit at the rung below, marked as
    -- ready, and staff sign them off.
    --
    -- Names, not indexes, for the reason min_rank is a name: a VA reordering
    -- their ladder must not silently un-promote their whole roster. A rung that
    -- is renamed lets the requirement lapse, so the failure mode is "the pilot
    -- gets promoted" rather than "the pilot is stuck and nobody knows why".
    -- ------------------------------------------------------------------------
    checks_passed text[] not null default '{}',
    -- ------------------------------------------------------------------------
    -- v10. The roster sweep.
    --
    -- When this pilot was last warned that they were running out of time —
    -- either to fly their first flight inside the VA's probation window, or to
    -- fly at all inside its inactivity window. Null means never warned.
    --
    -- It is never cleared. The sweep compares it against the anchor for the
    -- state the pilot is in (their join date on probation, their last flight
    -- otherwise), so a warning recorded before that anchor belongs to a cycle
    -- that has already ended — which is what "they flew, then went quiet again"
    -- looks like. Flying moves the anchor past the old warning and the next
    -- silence warns afresh, with nothing to reset.
    -- ------------------------------------------------------------------------
    retention_warned_at timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
-- v7. Added separately so a project provisioned at v1–v6 picks it up on re-run.
alter table crew_members add column if not exists checks_passed text[] not null default '{}';
-- v10. Same, for the roster sweep's warning stamp.
alter table crew_members add column if not exists retention_warned_at timestamptz;
create index if not exists crew_members_va_idx      on crew_members (va_slug);
create index if not exists crew_members_hours_idx   on crew_members (va_slug, hours desc);
create index if not exists crew_members_if_idx      on crew_members (va_slug, if_user_id) where if_user_id <> '';

-- ----------------------------------------------------------------------------
-- Crew center logins. v3.
--
-- A pilot's ACCOUNT — the thing they sign in with — is the VA's data like
-- everything else here, so it lives in the VA's project rather than in ours.
-- Accepting an application writes the row below; signing in at the crew center
-- reads it. Inflight holds no copy, which means a VA that leaves takes their
-- pilots' logins with them and we cannot sign in as anyone's pilot.
--
-- SECURITY: this table holds bcrypt password hashes. Like crew_applications it
-- has NO anon policy and NO grant — it is unreachable with a browser key, and
-- the RLS block at the bottom of this file is what enforces that. Passwords
-- themselves are never stored anywhere, in any form: a generated password is
-- shown to the pilot once and only its hash lands here.
--
-- `role` is constrained to the three crew center roles rather than to 'pilot'
-- alone, so a VA that later brings its staff logins over needs no migration —
-- only pilot rows are written today.
-- ----------------------------------------------------------------------------
create table if not exists crew_accounts (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    -- Lower-cased on write; the unique index below is what makes a username
    -- one-per-crew-center rather than one-per-project.
    username      text not null,
    display_name  text not null default '',
    password_hash text not null,
    role          text not null default 'pilot' check (role in ('pilot','staff','owner')),
    -- The roster row this login belongs to. `on delete set null`: removing a
    -- pilot from the roster leaves their account behind for staff to deal with
    -- deliberately, rather than deleting a credential as a side effect.
    member_id     uuid references crew_members (id) on delete set null,
    email         text not null default '',
    active        boolean not null default true,
    -- Set when we generated the password. The crew center nags until it is
    -- cleared by a password change.
    must_change_password boolean not null default false,
    created_via   text not null default 'crew-center',
    created_by_name text not null default '',
    last_login_at timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index if not exists crew_accounts_username_idx
    on crew_accounts (va_slug, lower(username));
create index if not exists crew_accounts_member_idx on crew_accounts (va_slug, member_id);

-- ----------------------------------------------------------------------------
-- Membership applications submitted through the crew center's join form.
--
-- PRIVACY: this table holds applicant email addresses and the opaque
-- `status_token` that lets someone read their own application. RLS below gives
-- the anon key NO access to it whatsoever — it is service-key only.
-- ----------------------------------------------------------------------------
create table if not exists crew_applications (
    id              uuid primary key default gen_random_uuid(),
    va_slug         text not null,
    ifc_name        text not null default '',
    email           text not null default '',
    callsign_prefix text not null default '',
    callsign_number text not null default '',
    grade           int  not null default 0,
    -- Did our Infinite Flight lookup confirm the account exists? When true,
    -- `grade` came from IF rather than from the applicant.
    if_verified     boolean not null default false,
    if_user_id      text not null default '',
    -- The applicant's answers to the VA's custom form: [{ q, a }, …]
    answers         jsonb not null default '[]'::jsonb,
    status          text not null default 'pending' check (status in ('pending','accepted','declined')),
    staff_message   text not null default '',
    status_token    text not null default '',
    -- The Discord invite this pilot was sent when they were accepted. Kept so
    -- their status page can show it again: an emailed invite is easy to lose,
    -- and an applicant who gave no email has the status link as their only copy.
    discord_invite  text not null default '',
    -- ------------------------------------------------------------------------
    -- The invitation. v4.
    --
    -- An accepted applicant is handed a temporary password. It is kept HERE, in
    -- readable form, which is a deliberate reversal of the rule the rest of this
    -- file follows for credentials — crew_accounts stores only a bcrypt hash and
    -- nothing anywhere stores a password. The reason is that a temporary
    -- password nobody can read again is a temporary password that only works if
    -- the applicant catches it on first sight: an applicant who gave no email
    -- had one screenful, and staff passing it on by hand (IFC DM, Discord) had
    -- one screenful too. Reissuing on every miss trains everyone to reissue.
    --
    -- So the trade is stated plainly rather than hidden: this column holds a
    -- live credential until it is used. What keeps that bounded is that it
    -- deletes itself — cleared the moment the pilot signs in (invite_claimed_at),
    -- when staff throw the invitation away (invite_revoked_at), or when it ages
    -- out. It is never a permanent store of anyone's password, because the
    -- account's real password is the bcrypt hash in crew_accounts and this one
    -- must be changed on first use (must_change_password).
    --
    -- It is not encrypted, on purpose. Encrypting a VA's own data with a key
    -- Inflight holds would mean the VA no longer owns the contents of their own
    -- database, which is the one thing this whole schema exists to guarantee.
    -- The protection is the same one that covers applicant emails and password
    -- hashes in this table: no anon policy AND no grant, so a browser key is
    -- refused at the door (see the RLS block at the foot of this file).
    -- ------------------------------------------------------------------------
    invite_username   text not null default '',
    invite_password   text not null default '',
    invite_issued_at  timestamptz,
    invite_claimed_at timestamptz,
    invite_revoked_at timestamptz,
    invite_account_id uuid,
    reviewed_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
-- v2. Added separately so a project provisioned at v1 picks it up on re-run
-- rather than needing the table dropped.
alter table crew_applications add column if not exists discord_invite text not null default '';
-- v4. Same reasoning: a project provisioned at v1–v3 picks these up on re-run.
alter table crew_applications add column if not exists invite_username   text not null default '';
alter table crew_applications add column if not exists invite_password   text not null default '';
alter table crew_applications add column if not exists invite_issued_at  timestamptz;
alter table crew_applications add column if not exists invite_claimed_at timestamptz;
alter table crew_applications add column if not exists invite_revoked_at timestamptz;
alter table crew_applications add column if not exists invite_account_id uuid;
-- Finding the invitation belonging to an account that has just signed in, so it
-- can be cleared. This runs on every pilot sign-in, so it is not optional.
create index if not exists crew_applications_invite_idx
    on crew_applications (va_slug, invite_account_id) where invite_account_id is not null;
create index if not exists crew_applications_va_idx     on crew_applications (va_slug, status, created_at desc);
-- The status link must resolve to exactly one application.
create unique index if not exists crew_applications_token_idx
    on crew_applications (va_slug, status_token) where status_token <> '';

-- ----------------------------------------------------------------------------
-- The VA's route network — the legs pilots can pick up. A filed PIREP is
-- checked against this table to decide whether the leg flown was a real route.
-- ----------------------------------------------------------------------------
create table if not exists crew_routes (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    flight_number text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft      text not null default '',
    distance_nm   numeric(10,2) not null default 0 check (distance_nm >= 0),
    notes         text not null default '',
    active        boolean not null default true,
    -- ------------------------------------------------------------------------
    -- v5.
    --
    -- `kind` splits the network in two. A VA's own routes are what the airline
    -- flies; a codeshare is a leg it sells under a partner's metal. They are
    -- listed apart and drawn apart on the map, because a network map that mixes
    -- them overstates what the airline actually operates — which is the one
    -- thing that map is for.
    --
    -- `min_rank` names a rung on the VA's ladder (crew center settings → ranks)
    -- rather than storing an hours figure. The VA sets what a rank is worth in
    -- one place; move the threshold and every route gated on it moves with it.
    -- Empty means open to everyone, which is the default and the common case.
    --
    -- Deliberately a NAME and not an index: a VA reordering their ladder would
    -- otherwise silently re-gate their whole network. A name that no longer
    -- exists lets the gate lapse (see crewRanks.meetsRank) — a VA who renames a
    -- rank gets an open route, never a network that quietly shrinks.
    -- ------------------------------------------------------------------------
    kind          text not null default 'own' check (kind in ('own','codeshare')),
    partner_name  text not null default '',
    partner_logo  text not null default '',
    min_rank      text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists crew_routes_va_idx  on crew_routes (va_slug, flight_number);
create index if not exists crew_routes_od_idx  on crew_routes (va_slug, origin, destination) where active;
-- v5. Added separately so a project provisioned at v1–v4 picks them up on a
-- re-run rather than needing the table rebuilt. The check constraint goes on
-- afterwards for the same reason, and is skipped if it is already there.
alter table crew_routes add column if not exists kind         text not null default 'own';
alter table crew_routes add column if not exists partner_name text not null default '';
alter table crew_routes add column if not exists partner_logo text not null default '';
alter table crew_routes add column if not exists min_rank     text not null default '';
do $$
begin
    alter table crew_routes add constraint crew_routes_kind_chk check (kind in ('own','codeshare'));
exception
    when duplicate_object then null;
end $$;
-- The network map and the route panel both split on this.
create index if not exists crew_routes_kind_idx on crew_routes (va_slug, kind) where active;

-- ----------------------------------------------------------------------------
-- Flight reports. Either captured automatically from a linked pilot's real
-- Infinite Flight history (`source = 'auto'`) or filed by hand (`'manual'`).
--
-- `hours_applied` is the double-credit guard: hours move onto the pilot's total
-- exactly once, and approving an already-approved report is a no-op.
-- ----------------------------------------------------------------------------
create table if not exists crew_pireps (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    member_id     uuid references crew_members (id) on delete set null,
    route_id      uuid references crew_routes  (id) on delete set null,
    -- v7. The event this flight was flown for, when it was flown for one.
    -- Set when a pilot files from an event's brief, which is what lets the
    -- event show what has actually been flown rather than only who said they
    -- would turn up.
    --
    -- The foreign key is added further down, once crew_events exists — this
    -- table is created before it, and a reference to a table that is not there
    -- yet fails a FRESH install while looking fine on an upgrade. The column is
    -- declared bare here and constrained there.
    event_id      uuid,
    -- v8. The scheduled departure this report was filed against, when it was
    -- flown off the schedule rather than freely. Declared bare here and
    -- constrained below crew_schedules, for the same file-ordering reason as
    -- event_id above.
    schedule_id   uuid,
    -- Denormalised so a report still reads correctly after the pilot or route
    -- it points at has been deleted.
    pilot_name    text not null default '',
    callsign      text not null default '',
    flight_number text not null default '',
    if_user_id    text not null default '',
    -- The Infinite Flight flight id. This is the dedupe key that stops a repeat
    -- sync from capturing the same flight twice (see the unique index below).
    flight_id     text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft_name text not null default '',
    livery_name   text not null default '',
    duration_min  int not null default 0 check (duration_min >= 0),
    landings      int not null default 0 check (landings >= 0),
    xp            int not null default 0,
    violations    int not null default 0 check (violations >= 0),
    distance_nm   numeric(10,2) not null default 0 check (distance_nm >= 0),
    server        text not null default '',
    in_fleet      boolean not null default false,
    source        text not null default 'auto'    check (source in ('auto','manual')),
    status        text not null default 'pending' check (status in ('pending','approved','rejected')),
    hours_applied boolean not null default false,
    flown_at      timestamptz,
    reviewed_at   timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
-- v7. Added separately so a project provisioned at v1–v6 picks it up on re-run.
-- The constraint that ties it to crew_events waits until that table exists —
-- see the block below crew_event_signups.
alter table crew_pireps add column if not exists event_id uuid;
create index if not exists crew_pireps_va_idx     on crew_pireps (va_slug, status, flown_at desc);
create index if not exists crew_pireps_member_idx on crew_pireps (va_slug, member_id);
-- What has been flown for an event. Partial: almost no flight belongs to one.
create index if not exists crew_pireps_event_idx  on crew_pireps (va_slug, event_id) where event_id is not null;
-- One row per real Infinite Flight flight. Enforced in the database rather than
-- in application code so two concurrent syncs cannot both insert the same leg.
create unique index if not exists crew_pireps_flight_idx
    on crew_pireps (va_slug, flight_id) where flight_id <> '';

-- ----------------------------------------------------------------------------
-- Events. v6.
--
-- The thing a VA actually gathers around: a group departure, a fly-in, a
-- long-haul night. An event is published from the crew center, pilots sign
-- themselves up (crew_event_signups below), and the airline's own website reads
-- the same rows — so the calendar a visitor sees is the calendar staff filled
-- in, not a copy of it maintained by hand.
--
-- `gate_icao` is the airport whose stands the gate board covers, and it is
-- stored rather than derived because the answer is not always the origin: a
-- group departure parks everyone at the field they leave from, a fly-in parks
-- them at the field they arrive at. An empty value means "the origin", which is
-- the common case and what the crew center fills in for you.
--
-- `slots` is a cap, and 0 means uncapped. Signing up past the cap is not
-- refused — it lands on the waitlist (see the signups table), because an event
-- that quietly turns pilots away is one staff find out about too late.
--
-- `min_rank` names a rung on the VA's ladder, exactly as crew_routes.min_rank
-- does, and for the same reason: the VA sets what a rank is worth in one place.
-- ----------------------------------------------------------------------------
create table if not exists crew_events (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    title         text not null default '',
    description   text not null default '',
    -- Event artwork, shown on the card in the crew center and on the VA's site.
    -- Rendered in an <img>, so the backend only ever stores an https URL here.
    banner_url    text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft      text not null default '',
    flight_number text not null default '',
    -- ------------------------------------------------------------------------
    -- v7. The leg this event is flown on, when it is one of the VA's own.
    --
    -- Optional, and the leg details above are kept alongside it rather than
    -- read through it. An event is often a route the airline already publishes
    -- — picking it fills the fields in and ties the two together, so a PIREP
    -- filed for the event credits against the route like any other flight. But
    -- plenty of events are one-offs (a fly-in from anywhere, a charter to a
    -- field the network does not serve), so the leg has to stand on its own.
    --
    -- `on delete set null`: retiring a route must not delete the event that was
    -- flown on it, nor quietly blank the leg everybody signed up for.
    -- ------------------------------------------------------------------------
    route_id      uuid references crew_routes (id) on delete set null,
    -- Which Infinite Flight server this is being flown on. Free text: the
    -- server list is Infinite Flight's to change, not ours to constrain.
    server        text not null default '',
    starts_at     timestamptz,
    ends_at       timestamptz,
    slots         int not null default 0 check (slots >= 0),
    -- The gate board. `gates_open` is what a VA turns off for an event where
    -- stands are irrelevant (a formation over the ocean); `gates_locked` is
    -- what they turn on once the allocation is final, which freezes the board
    -- without deleting anybody's stand.
    gates_open    boolean not null default true,
    gates_locked  boolean not null default false,
    gate_icao     text not null default '',
    min_rank      text not null default '',
    -- Draft is the default on purpose: an event is written over several
    -- sittings and must not appear on the airline's public calendar (or in a
    -- pilot's list) until staff say so. Cancelled is kept rather than deleted —
    -- pilots who signed up need to be told, and a row that vanished tells
    -- nobody anything.
    status        text not null default 'draft' check (status in ('draft','published','cancelled')),
    created_by    text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
-- v7. Added separately so a project provisioned at v6 picks it up on a re-run.
alter table crew_events add column if not exists route_id uuid references crew_routes (id) on delete set null;
create index if not exists crew_events_va_idx     on crew_events (va_slug, starts_at desc);
create index if not exists crew_events_public_idx on crew_events (va_slug, starts_at) where status = 'published';

-- ----------------------------------------------------------------------------
-- Who is attending, and from which stand. v6.
--
-- One row per pilot per event. Withdrawing DELETES the row rather than flagging
-- it: a withdrawn pilot still holding a gate is the bug this whole table exists
-- to prevent, and "who is coming" is a question a list of live rows answers
-- exactly.
--
-- THE GATE IS CLAIMED IN THE DATABASE, NOT IN THE BROWSER. The unique index
-- below is what makes a stand belong to one pilot: two people tapping the same
-- marker at the same moment is not a rare case at an event that has just been
-- announced, and any check performed before the insert loses that race. The
-- second insert fails, the crew center says the stand has just gone, and the
-- board is never wrong about who is parked where.
--
-- `member_id` links to the roster where there is one; it is nullable so staff
-- can put a guest on the board (a partner VA flying in) without inventing a
-- roster row for them. `account_id` is the login that signed up — deliberately
-- NOT a foreign key onto crew_accounts, because deleting an account must not
-- cascade a pilot off an event that has already been planned around them.
-- ----------------------------------------------------------------------------
create table if not exists crew_event_signups (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    -- Cascade: an event that is gone has no attendees. This is the one place a
    -- cascade is right — the rows have no meaning apart from their event.
    event_id    uuid not null references crew_events (id) on delete cascade,
    member_id   uuid references crew_members (id) on delete set null,
    account_id  uuid,
    -- Denormalised so the board still reads correctly after the pilot's roster
    -- row has been removed, the same way a PIREP keeps its pilot's name.
    pilot_name  text not null default '',
    callsign    text not null default '',
    aircraft    text not null default '',
    -- The stand itself, plus where it is, so the board can be drawn without
    -- asking OpenStreetMap again — and can still be drawn years later for an
    -- airport whose mapping has since changed.
    gate        text not null default '',
    gate_lat    double precision,
    gate_lon    double precision,
    gate_kind   text not null default '',
    note        text not null default '',
    -- 'waitlist' is what a signup becomes past the event's slot cap. It is a
    -- real attendance record — it just does not hold a gate.
    status      text not null default 'going' check (status in ('going','waitlist')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists crew_event_signups_event_idx
    on crew_event_signups (va_slug, event_id, created_at);
-- One stand, one aircraft. Case-insensitive because "b24" and "B24" are the
-- same gate to everyone except a database.
create unique index if not exists crew_event_signups_gate_idx
    on crew_event_signups (event_id, upper(gate)) where gate <> '';
-- One signup per pilot per event, whichever way we know them. Both are partial
-- so a staff-added guest — no account, no roster row — is never blocked by
-- another guest.
create unique index if not exists crew_event_signups_account_idx
    on crew_event_signups (event_id, account_id) where account_id is not null;
create unique index if not exists crew_event_signups_member_idx
    on crew_event_signups (event_id, member_id) where member_id is not null;

-- v7. crew_pireps.event_id points at an event, and can only say so once
-- crew_events exists — which, in file order, is here. `on delete set null`:
-- deleting an event must not delete anybody's logbook entry, and a flight that
-- was flown was still flown after the event it belonged to is gone.
--
-- Wrapped because `add constraint` has no `if not exists`, and this file is run
-- again on every upgrade.
do $$
begin
    alter table crew_pireps
        add constraint crew_pireps_event_fk
        foreign key (event_id) references crew_events (id) on delete set null;
exception
    when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- Announcements. v7.
--
-- The noticeboard on a pilot's home page. Two kinds of row live here and they
-- are deliberately the same shape:
--
--   * what staff write — "July schedule is live", pinned notices, briefings;
--   * what the crew center writes for them — a pilot promoted, a pilot joined,
--     an event published.
--
-- The second kind is the point. A VA's own good news already happens inside the
-- crew center and was visible only as a Discord message that scrolls away; a
-- pilot who joins on Tuesday should still see on Friday that they joined, and
-- that two other people did too. `kind` is what lets the page draw them
-- differently without needing a second table, and `source = 'auto'` is what
-- stops a staff member's hand-written notice being tidied up by a job that
-- prunes generated ones.
--
-- `ref_id` points at whatever caused an automatic row (a member, an event). It
-- is deliberately NOT a foreign key: an announcement is a record of something
-- that happened, and it stays true after the pilot leaves or the event is
-- deleted. Nothing reads it back as a join — it is there so a page can offer a
-- link when the target still exists.
-- ----------------------------------------------------------------------------
create table if not exists crew_announcements (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    title       text not null default '',
    body        text not null default '',
    kind        text not null default 'notice'
                check (kind in ('notice','promotion','join','event','checkride')),
    source      text not null default 'staff' check (source in ('staff','auto')),
    -- Pinned notices sort above everything regardless of age: "read the new
    -- rules before you file" has to stay at the top of the board.
    pinned      boolean not null default false,
    ref_id      uuid,
    author_name text not null default '',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists crew_announcements_va_idx
    on crew_announcements (va_slug, pinned desc, created_at desc);
-- v8. 'schedule' joins the list: a fortnight of flying going up is exactly the
-- kind of thing the board exists to tell the crew about. Replaced rather than
-- widened in place because the constraint is an inline column check, and a
-- project provisioned at v7 carries the old five-value version — a row it has
-- never heard of is refused, and the notice would vanish with no explanation.
do $$
begin
    alter table crew_announcements drop constraint if exists crew_announcements_kind_check;
    alter table crew_announcements add constraint crew_announcements_kind_check
        check (kind in ('notice','promotion','join','event','checkride','schedule'));
end $$;

-- ----------------------------------------------------------------------------
-- The schedule. v8.
--
-- A route says the airline flies LHR–JFK. A schedule says it flies at 18:40 on
-- Thursday, in a 787, and one pilot can put their name against it. That gap is
-- why this table exists and is not a column on crew_routes: the network is what
-- the VA operates, the schedule is when, and the same leg appears in it as many
-- times as it is flown.
--
-- HOW IT RELATES TO EVENTS. An event is everyone at once — twenty pilots, one
-- departure, a gate board to keep them off each other. A schedule is the
-- ordinary week: many departures, each flown by one pilot (or a small crew),
-- nobody gathering. They stay separate tables because the questions asked of
-- them are different — "who is coming?" versus "is this leg covered?" — and
-- collapsing them would mean every ordinary Tuesday departure carrying an
-- attendee list it never uses.
--
-- `route_id` is optional and the leg details are kept alongside it rather than
-- read through it, exactly as crew_events does: picking a route fills the
-- fields in, but a schedule may be built for a leg the network does not
-- publish, and retiring a route must not blank a departure pilots have already
-- booked.
--
-- `seats` is how many pilots may fly this departure. One is the common case and
-- the default; a VA running two-crew long-hauls sets two. Unlike an event's
-- `slots` there is no waitlist and no zero-means-uncapped: a departure with
-- nobody assignable is not a schedule entry, and a pilot who cannot have the
-- leg needs to be told now so they can book another.
-- ----------------------------------------------------------------------------
create table if not exists crew_schedules (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    route_id      uuid references crew_routes (id) on delete set null,
    flight_number text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft      text not null default '',
    -- Both stored, both optional after the departure. An arrival time is what
    -- makes the schedule readable as a day of flying rather than a list of
    -- start times, but plenty of VAs publish only the push-back.
    departs_at    timestamptz,
    arrives_at    timestamptz,
    seats         int not null default 1 check (seats > 0),
    -- Names a rung on the VA's ladder, as crew_routes.min_rank and
    -- crew_events.min_rank do. Set on the schedule rather than inherited from
    -- the route, because the same leg can be open to everyone midweek and
    -- captain-only on the Friday night rotation.
    min_rank      text not null default '',
    notes         text not null default '',
    -- Draft is the default for the reason it is on events: a schedule is built
    -- a fortnight at a time and must not appear in a pilot's list until staff
    -- say so. Cancelled is kept rather than deleted — a pilot who booked the
    -- leg is owed the notice, and a row that vanished tells them nothing.
    status        text not null default 'draft' check (status in ('draft','published','cancelled')),
    created_by    text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists crew_schedules_va_idx     on crew_schedules (va_slug, departs_at);
create index if not exists crew_schedules_public_idx on crew_schedules (va_slug, departs_at) where status = 'published';
-- Which departures a route is carrying — read when a route is retired, and by
-- the route panel's "next departure" line. Partial: an ad-hoc leg has no route.
create index if not exists crew_schedules_route_idx  on crew_schedules (va_slug, route_id) where route_id is not null;

-- ----------------------------------------------------------------------------
-- Bookings. v8.
--
-- One row per pilot per departure they have taken. Cancelling DELETES the row,
-- for the reason withdrawing from an event does: the seat is the thing being
-- held, and a cancelled booking that still occupies one is the bug this table
-- exists to prevent.
--
-- THE SEAT IS CLAIMED IN THE DATABASE, NOT IN THE BROWSER. `seat` is a small
-- integer, 1..seats, and the unique index below is what makes it exclusive. Two
-- pilots tapping "book" on the last seat of a popular leg at the same moment is
-- not a rare case — it is what happens the minute a schedule is published — and
-- any count taken before the insert loses that race. The backend picks the
-- lowest free seat and inserts; the loser's insert fails, is retried against
-- what is now free, and is told the leg is full only when it genuinely is.
--
-- That is the same mechanism as the event gate board, deliberately. A seat is a
-- stand with the map taken away.
--
-- `member_id` links to the roster where there is one and is nullable so staff
-- can assign a leg to a guest crew. `account_id` is the login that booked and
-- is deliberately NOT a foreign key onto crew_accounts, because deleting an
-- account must not cascade a pilot off a departure the week has been planned
-- around.
-- ----------------------------------------------------------------------------
create table if not exists crew_bookings (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    -- Cascade: a departure that is gone has no bookings. Same reasoning as
    -- event signups — these rows have no meaning apart from their schedule.
    schedule_id uuid not null references crew_schedules (id) on delete cascade,
    member_id   uuid references crew_members (id) on delete set null,
    account_id  uuid,
    -- Denormalised so the schedule still reads correctly after the pilot's
    -- roster row has been removed, the same way a PIREP keeps its pilot's name.
    pilot_name  text not null default '',
    callsign    text not null default '',
    seat        int not null default 1 check (seat > 0),
    note        text not null default '',
    -- 'flown' is set when a flight report is matched to the booking, which is
    -- what lets a schedule show coverage — booked, flown, or nobody — instead
    -- of only intent.
    status      text not null default 'booked' check (status in ('booked','flown')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists crew_bookings_schedule_idx on crew_bookings (va_slug, schedule_id, seat);
create index if not exists crew_bookings_member_idx   on crew_bookings (va_slug, member_id) where member_id is not null;
-- One seat, one pilot. The claim that makes the race above safe.
create unique index if not exists crew_bookings_seat_idx
    on crew_bookings (schedule_id, seat);
-- One booking per pilot per departure, whichever way we know them. Both are
-- partial so a staff-assigned guest — no account, no roster row — is never
-- blocked by another guest.
create unique index if not exists crew_bookings_account_idx
    on crew_bookings (schedule_id, account_id) where account_id is not null;
create unique index if not exists crew_bookings_pilot_idx
    on crew_bookings (schedule_id, member_id) where member_id is not null;

-- v8. crew_pireps.schedule_id points at the departure a report was filed
-- against, and can only say so once crew_schedules exists — which, in file
-- order, is here. `on delete set null` for the same reason event_id uses it: a
-- flight that was flown was still flown after the schedule it belonged to has
-- been torn up.
alter table crew_pireps add column if not exists schedule_id uuid;
do $$
begin
    alter table crew_pireps
        add constraint crew_pireps_schedule_fk
        foreign key (schedule_id) references crew_schedules (id) on delete set null;
exception
    when duplicate_object then null;
end $$;
create index if not exists crew_pireps_schedule_idx
    on crew_pireps (va_slug, schedule_id) where schedule_id is not null;

-- ----------------------------------------------------------------------------
-- The document library. v11.
--
-- Every VA has an operations manual, and until now every VA hosted it
-- somewhere else — a Google Doc, a Discord pin, a PDF in a channel nobody can
-- search. The crew center already knows who each pilot is and what rung they
-- are on, which is exactly what deciding "may this person read this" needs, so
-- the library belongs here rather than behind a link.
--
-- THREE KINDS OF CONTENT, ONE TABLE
-- `source` says where the words actually are, and only one of the three fields
-- is ever filled:
--
--   'text'   written in the crew center. `body` holds it. Best for the short
--            standing orders a VA rewrites often, because editing is one panel
--            rather than a round trip through someone else's editor.
--   'link'   somewhere else already — a Doc, a Notion page, a shared drive.
--            `link_url` points at it. The VA keeps their existing workflow and
--            still gets the gating and the index.
--   'file'   uploaded to us. `file_url` is the hosted copy; `file_name` and
--            `file_size` are kept so the list can say "Ops Manual.pdf, 4.2 MB"
--            without fetching the thing to find out.
--
-- Storing which one it is, rather than inferring it from whichever column is
-- non-empty, means a document whose link is temporarily blank is still a link
-- document with a missing link — a fixable state that says so — instead of
-- silently becoming an empty text document.
--
-- `min_rank` is the rank gate, deliberately the same shape as crew_routes and
-- crew_events use: a rung name read against the VA's own ladder, so editing the
-- ladder re-gates the library at once and no rank is stored twice. Note what
-- this means for RLS below — unlike a route, a document's CONTENT is the thing
-- being gated, so a gated row is not readable with a browser key at all.
--
-- `revision` and `revised_at` are the pair that makes a library trustworthy. A
-- pilot who has read the manual needs to know whether the change since then was
-- a typo or a new fuel policy, and only the person editing it knows which. So
-- the revision label is theirs to write and `revised_at` moves only when they
-- say the change was substantive — it is NOT `updated_at`, which moves on every
-- keystroke saved and would mark the whole roster unread for a fixed comma.
-- ----------------------------------------------------------------------------
create table if not exists crew_documents (
    id           uuid primary key default gen_random_uuid(),
    va_slug      text not null,
    title        text not null default '',
    summary      text not null default '',
    kind         text not null default 'document'
                 check (kind in ('manual','sop','handbook','policy','briefing','form','document')),
    source       text not null default 'text' check (source in ('text','link','file')),
    body         text not null default '',
    link_url     text not null default '',
    file_url     text not null default '',
    file_name    text not null default '',
    file_size    bigint not null default 0 check (file_size >= 0),
    min_rank     text not null default '',
    pinned       boolean not null default false,
    -- 'archived' rather than deleting: a superseded manual is the thing you want
    -- when a pilot asks why they were told something different last month.
    status       text not null default 'draft' check (status in ('draft','published','archived')),
    revision     text not null default '',
    revised_at   timestamptz,
    author_name  text not null default '',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
-- The library as a pilot reads it: what is published, pinned first.
create index if not exists crew_documents_va_idx
    on crew_documents (va_slug, status, pinned desc, title);
-- And as staff file it: everything of one kind, newest revision first.
create index if not exists crew_documents_kind_idx
    on crew_documents (va_slug, kind, updated_at desc);

-- ----------------------------------------------------------------------------
-- The pilot's inbox. v11.
--
-- The noticeboard (crew_announcements) is the airline talking to everybody at
-- once, and it is the wrong shape for half of what a VA needs to say. "Your
-- application was accepted", "you are on Thursday's LHR–JFK", "your Captain
-- check-ride is booked" are addressed to ONE pilot, and putting them on a board
-- either tells the whole roster somebody else's business or does not get said
-- at all. So this table is the other half: one row per pilot per thing.
--
-- ADDRESSING. `account_id` is the login that reads it and is the key the inbox
-- is actually queried by. It is deliberately NOT a foreign key onto
-- crew_accounts, for the reason crew_bookings.account_id is not either — an
-- account being reset or replaced must not silently delete the record of what
-- the pilot was told.
--
-- `member_id` is the roster row, kept alongside so staff can address a message
-- to a pilot they picked off the roster without first looking up which login
-- belongs to them. This one DOES cascade: a pilot removed from the roster
-- should not leave their correspondence behind in the VA's project.
--
-- `read_at` null means unread, and it is a timestamp rather than a boolean
-- because "when did they see this" is the question staff actually ask — after
-- posting the new fuel policy, the useful answer is which pilots have opened it
-- and when, not a count of ticks.
--
-- WHY NOT DISCORD. Most VAs do reach their pilots through Discord, and the crew
-- center still posts there. But a Discord message is gone in a week, cannot be
-- addressed to "everyone above Senior First Officer", and is invisible to a
-- pilot who joined after it was sent. This is the durable copy, and it is in
-- the VA's own project where the rest of their operational record lives.
-- ----------------------------------------------------------------------------
create table if not exists crew_notifications (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    account_id  uuid,
    member_id   uuid references crew_members (id) on delete cascade,
    title       text not null default '',
    body        text not null default '',
    kind        text not null default 'message'
                check (kind in ('message','application','promotion','booking',
                                'event','document','checkride','system')),
    -- What it is about, when it is about something — an event, a departure, a
    -- document. Untyped on purpose: `kind` says which table to read it against,
    -- and a hard reference to seven of them would make deleting any one of
    -- those a cascade through the inbox.
    ref_id      uuid,
    -- Where tapping it should go. Held rather than derived so a message about a
    -- thing that has since moved still lands somewhere sensible.
    link_url    text not null default '',
    sender_name text not null default '',
    read_at     timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
-- The inbox itself: one pilot's messages, newest first.
create index if not exists crew_notifications_account_idx
    on crew_notifications (va_slug, account_id, created_at desc) where account_id is not null;
-- The badge. Partial so the count a pilot's every page load asks for reads an
-- index of only what is unread, which is the small set, not the whole history.
create index if not exists crew_notifications_unread_idx
    on crew_notifications (va_slug, account_id, created_at desc)
    where read_at is null and account_id is not null;
create index if not exists crew_notifications_member_idx
    on crew_notifications (va_slug, member_id) where member_id is not null;

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------
create or replace function crew_touch_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array['crew_members','crew_accounts','crew_applications','crew_routes','crew_pireps','crew_events','crew_event_signups','crew_announcements','crew_schedules','crew_bookings','crew_documents','crew_notifications','crew_schema_info']
    loop
        execute format('drop trigger if exists %I on %I', t || '_touch', t);
        execute format(
            'create trigger %I before update on %I for each row execute function crew_touch_updated_at()',
            t || '_touch', t);
    end loop;
end;
$$;

-- ============================================================================
-- Statistics
--
-- The crew center and the VA's public website both ask "how many pilots, how
-- many hours, how many flights?". Answering that with four separate PostgREST
-- round trips is wasteful and can tear (counts taken microseconds apart), so it
-- is one function returning one jsonb snapshot, computed in a single statement.
--
-- SECURITY: this is the ONE thing an unauthenticated visitor is allowed to
-- compute, because it is what a VA wants on their homepage. It returns
-- aggregates and a small leaderboard of pilot names — never emails, never
-- tokens, never application contents.
-- ============================================================================
create or replace function crew_stats(p_va_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    with m as (
        select
            count(*)                                        as pilots,
            count(*) filter (where status = 'active')       as pilots_active,
            count(*) filter (where status = 'loa')          as pilots_loa,
            count(*) filter (where if_user_id <> '')        as pilots_linked,
            coalesce(sum(hours), 0)                         as hours,
            count(*) filter (where created_at > now() - interval '30 days') as joined_30d
        from crew_members where va_slug = p_va_slug
    ),
    p as (
        select
            count(*)                                            as pireps,
            count(*) filter (where status = 'approved')          as pireps_approved,
            count(*) filter (where status = 'pending')           as pireps_pending,
            count(*) filter (where status = 'rejected')          as pireps_rejected,
            coalesce(sum(duration_min) filter (where status = 'approved'), 0) as flown_min,
            coalesce(sum(landings)     filter (where status = 'approved'), 0) as landings,
            coalesce(sum(distance_nm)  filter (where status = 'approved'), 0) as distance_nm,
            count(*) filter (where status = 'approved'
                             and coalesce(flown_at, created_at) > now() - interval '30 days') as flights_30d,
            coalesce(sum(duration_min) filter (where status = 'approved'
                             and coalesce(flown_at, created_at) > now() - interval '30 days'), 0) as flown_min_30d,
            max(coalesce(flown_at, created_at)) filter (where status = 'approved') as last_flight_at
        from crew_pireps where va_slug = p_va_slug
    ),
    r as (
        select
            count(*)                                as routes,
            count(*) filter (where active)          as routes_active,
            count(distinct destination) filter (where active and destination <> '') as destinations
        from crew_routes where va_slug = p_va_slug
    ),
    a as (
        select
            count(*) filter (where status = 'pending')  as applications_pending,
            count(*) filter (where status = 'accepted') as applications_accepted,
            count(*) filter (where status = 'pending'
                             and created_at > now() - interval '30 days') as applications_30d
        from crew_applications where va_slug = p_va_slug
    ),
    -- v6. "Upcoming" means published and not yet started, which is the figure a
    -- VA quotes and the one the dashboard's events tile shows.
    ev as (
        select
            count(*)                                                       as events,
            count(*) filter (where status = 'published'
                             and starts_at > now())                        as events_upcoming,
            min(starts_at) filter (where status = 'published'
                             and starts_at > now())                        as next_event_at
        from crew_events where va_slug = p_va_slug
    ),
    -- v8. The schedule, answered the way staff ask about it: how much of what
    -- we published is actually covered? `seats_open` is the figure that sends
    -- someone to the schedule panel — legs nobody has taken, on published
    -- departures that have not left yet.
    sch as (
        select
            count(*) filter (where status = 'published'
                             and departs_at > now())                       as schedules_upcoming,
            min(departs_at) filter (where status = 'published'
                             and departs_at > now())                       as next_departure_at,
            coalesce(sum(seats) filter (where status = 'published'
                             and departs_at > now()), 0)                   as seats_upcoming
        from crew_schedules where va_slug = p_va_slug
    ),
    bk as (
        select count(*) as booked_upcoming
        from crew_bookings b
        join crew_schedules s on s.id = b.schedule_id
        where b.va_slug = p_va_slug and s.status = 'published' and s.departs_at > now()
    ),
    -- v11. The library. `to_regclass` is not needed here the way it is in
    -- crew_storage_usage — this function is replaced by the same script that
    -- creates the table, so by the time it can be called the table exists.
    doc as (
        select
            count(*) filter (where status = 'published')      as documents,
            count(*) filter (where status = 'published'
                             and min_rank <> '')              as documents_gated
        from crew_documents where va_slug = p_va_slug
    ),
    -- A small "top pilots by hours" board. Names only, and only pilots who have
    -- actually flown, so an empty roster doesn't produce a wall of zeroes.
    top as (
        select coalesce(jsonb_agg(t), '[]'::jsonb) as top_pilots from (
            select name, callsign, round(hours::numeric, 1) as hours
            from crew_members
            where va_slug = p_va_slug and status = 'active' and hours > 0
            order by hours desc, name asc
            limit 10
        ) t
    )
    select jsonb_build_object(
        'pilots',               m.pilots,
        'pilotsActive',         m.pilots_active,
        'pilotsLoa',            m.pilots_loa,
        'pilotsLinked',         m.pilots_linked,
        'pilotsJoined30d',      m.joined_30d,
        -- Credited roster hours: the figure the rank ladder is read against.
        'hours',                round(m.hours, 1),
        'pireps',               p.pireps,
        'pirepsApproved',       p.pireps_approved,
        'pirepsPending',        p.pireps_pending,
        'pirepsRejected',       p.pireps_rejected,
        -- Hours actually recorded on approved reports. Usually tracks `hours`
        -- closely; they diverge when staff hand-adjust a pilot's total.
        'flightHours',          round((p.flown_min / 60.0)::numeric, 1),
        'flightHours30d',       round((p.flown_min_30d / 60.0)::numeric, 1),
        'flights30d',           p.flights_30d,
        'landings',             p.landings,
        'distanceNm',           round(p.distance_nm, 0),
        'lastFlightAt',         p.last_flight_at,
        'routes',               r.routes,
        'routesActive',         r.routes_active,
        'destinations',         r.destinations,
        'applicationsPending',  a.applications_pending,
        'applicationsAccepted', a.applications_accepted,
        'applications30d',      a.applications_30d,
        'events',               ev.events,
        'eventsUpcoming',       ev.events_upcoming,
        'nextEventAt',          ev.next_event_at,
        'schedulesUpcoming',    sch.schedules_upcoming,
        'nextDepartureAt',      sch.next_departure_at,
        'seatsOpen',            greatest(sch.seats_upcoming - bk.booked_upcoming, 0),
        'seatsBooked',          bk.booked_upcoming,
        'documents',            doc.documents,
        'documentsGated',       doc.documents_gated,
        'topPilots',            top.top_pilots,
        'generatedAt',          now()
    )
    from m, p, r, a, ev, sch, bk, doc, top;
$$;

-- ============================================================================
-- v9. How much room is this crew center using?
--
-- Supabase's free plan gives a project half a gigabyte of database, and a VA
-- who blows through it discovers that fact when writes start failing — the
-- project goes read-only and the crew center looks broken. The number is on
-- Supabase's own dashboard, but that is a place VA staff do not otherwise go
-- and, once the crew center is set up, have no reason to have an account for.
--
-- So the crew center answers it directly: total database size, what each crew
-- table costs, and what else is in the project (a VA may keep their own tables
-- alongside ours, and if something is eating the plan it is worth seeing which
-- thing). Sizes include indexes and TOAST — pg_total_relation_size is what the
-- plan is actually measured against, so a figure that left them out would read
-- low and reassure a VA who is about to run out.
--
-- SECURITY: definer, because the sizes live in catalogues an ordinary caller
-- cannot read, and because storage.objects belongs to another schema. It
-- returns sizes and counts — no row contents, no names of anything but tables.
-- Execute is granted to service_role only: the browser key has no business with
-- it, and everything the dashboard shows comes through the backend anyway.
-- ============================================================================
create or replace function crew_storage_usage(p_va_slug text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    crew_tables text[] := array[
        'crew_members','crew_accounts','crew_applications','crew_routes','crew_pireps',
        'crew_events','crew_event_signups','crew_announcements','crew_schedules',
        'crew_bookings','crew_documents','crew_notifications','crew_schema_info'];
    t              text;
    rel            regclass;
    tbl_bytes      bigint;
    tbl_rows       bigint;
    tbl_mine       bigint;
    tables_json    jsonb := '[]'::jsonb;
    crew_bytes     bigint := 0;
    db_bytes       bigint := 0;
    other_json     jsonb := '[]'::jsonb;
    other_bytes    bigint := 0;
    storage_bytes  bigint := 0;
    storage_files  bigint := 0;
begin
    foreach t in array crew_tables loop
        rel := to_regclass('public.' || t);
        continue when rel is null;                   -- project predates this table
        tbl_bytes := pg_total_relation_size(rel);
        execute format('select count(*) from public.%I', t) into tbl_rows;
        -- Rows belonging to THIS crew center, where the table is per-VA. One
        -- project can back several brands (see the multi-brand note above), so
        -- "your rows" and "rows in here" are different questions and staff
        -- looking at a shared project need both.
        tbl_mine := null;
        if p_va_slug is not null and t <> 'crew_schema_info' then
            execute format('select count(*) from public.%I where va_slug = $1', t)
                into tbl_mine using p_va_slug;
        end if;
        crew_bytes := crew_bytes + tbl_bytes;
        tables_json := tables_json || jsonb_build_object(
            'table', t, 'bytes', tbl_bytes, 'rows', tbl_rows, 'vaRows', tbl_mine);
    end loop;

    db_bytes := pg_database_size(current_database());

    -- Anything else the VA keeps in this project. Named, because "something is
    -- using 400 MB" is only actionable if you can see what.
    select coalesce(sum(bytes), 0),
           coalesce(jsonb_agg(jsonb_build_object('table', name, 'bytes', bytes)
                    order by bytes desc) filter (where rn <= 8), '[]'::jsonb)
      into other_bytes, other_json
      from (
        select c.relname::text as name,
               pg_total_relation_size(c.oid) as bytes,
               row_number() over (order by pg_total_relation_size(c.oid) desc) as rn
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r','p','m')
           and not (c.relname = any (crew_tables))
      ) s;

    -- Supabase Storage, if the project uses it. Its own schema, so a project
    -- where it is absent or locked down reports zero rather than failing the
    -- whole call — this figure is a nice-to-have next to the database size.
    begin
        execute 'select coalesce(sum((metadata->>''size'')::bigint), 0), count(*) from storage.objects'
            into storage_bytes, storage_files;
    exception when others then
        storage_bytes := 0; storage_files := 0;
    end;

    return jsonb_build_object(
        'databaseBytes',  db_bytes,
        'crewBytes',      crew_bytes,
        'otherBytes',     other_bytes,
        'storageBytes',   storage_bytes,
        'storageFiles',   storage_files,
        'tables',         tables_json,
        'otherTables',    other_json,
        'vaSlug',         p_va_slug,
        'generatedAt',    now()
    );
end;
$$;

-- ============================================================================
-- Row Level Security
--
-- Default deny on every table. The anon key then gets back exactly the three
-- public reads a crew center needs, and nothing else. Note what is absent:
-- there is no anon policy on crew_applications or crew_accounts at all, so
-- applicant emails, status tokens and password hashes are unreachable with a
-- browser key even if it leaks.
--
-- Writes have no policy for any role. They happen through the service key,
-- which bypasses RLS — so every mutation goes through the Inflight backend and
-- its permission checks rather than straight from a page.
-- ============================================================================
alter table crew_members       enable row level security;
alter table crew_accounts      enable row level security;
alter table crew_applications  enable row level security;
alter table crew_routes        enable row level security;
alter table crew_pireps        enable row level security;
alter table crew_events        enable row level security;
alter table crew_event_signups enable row level security;
alter table crew_announcements enable row level security;
alter table crew_schedules     enable row level security;
alter table crew_bookings      enable row level security;
alter table crew_documents     enable row level security;
alter table crew_notifications enable row level security;
alter table crew_schema_info   enable row level security;

drop policy if exists crew_members_public_read on crew_members;
create policy crew_members_public_read on crew_members
    for select to anon, authenticated using (true);

drop policy if exists crew_routes_public_read on crew_routes;
create policy crew_routes_public_read on crew_routes
    for select to anon, authenticated using (active);

-- A public flight log: approved reports only. Pending and rejected ones are
-- staff business and stay invisible until a decision has been made.
drop policy if exists crew_pireps_public_read on crew_pireps;
create policy crew_pireps_public_read on crew_pireps
    for select to anon, authenticated using (status = 'approved');

-- Published events only. A draft is staff's working copy and stays invisible
-- until they publish it; a cancelled one stays readable, because pilots who
-- signed up are owed the notice.
drop policy if exists crew_events_public_read on crew_events;
create policy crew_events_public_read on crew_events
    for select to anon, authenticated using (status in ('published','cancelled'));

-- The attendee board, but only for events that are actually public. Tying the
-- policy to the event rather than granting the table outright means a draft's
-- signups cannot be read back through its attendees — which would otherwise
-- leak both the draft's existence and who staff had penciled in.
drop policy if exists crew_event_signups_public_read on crew_event_signups;
create policy crew_event_signups_public_read on crew_event_signups
    for select to anon, authenticated using (
        exists (
            select 1 from crew_events e
            where e.id = crew_event_signups.event_id
              and e.status in ('published','cancelled')
        )
    );

-- The noticeboard is what a VA tells its crew, and a crew center shows it to
-- anyone looking at the airline. Nothing sensitive goes in it — staff write the
-- notices, and the generated ones carry names that are already on the public
-- roster.
drop policy if exists crew_announcements_public_read on crew_announcements;
create policy crew_announcements_public_read on crew_announcements
    for select to anon, authenticated using (true);

-- Published and cancelled departures, matching the events rule exactly: a
-- draft schedule is staff's working copy, and a cancelled leg stays readable
-- because the pilot who booked it is owed the notice.
drop policy if exists crew_schedules_public_read on crew_schedules;
create policy crew_schedules_public_read on crew_schedules
    for select to anon, authenticated using (status in ('published','cancelled'));

-- Who is flying what, but only for departures that are actually public. Tying
-- the policy to the schedule rather than granting the table outright keeps a
-- draft's bookings from leaking both the draft's existence and who staff had
-- pencilled in — the same reasoning as crew_event_signups_public_read.
drop policy if exists crew_bookings_public_read on crew_bookings;
create policy crew_bookings_public_read on crew_bookings
    for select to anon, authenticated using (
        exists (
            select 1 from crew_schedules s
            where s.id = crew_bookings.schedule_id
              and s.status in ('published','cancelled')
        )
    );

-- v11. The library, and the one place in this file where a rank gate has to be
-- enforced by RLS rather than by the backend.
--
-- Compare crew_routes: a gated route is READ by everyone and the crew center
-- draws it as locked, because "the airline flies LHR–JFK, Captains only" is not
-- a secret — the gate is about who may fly it. A document is the opposite. Its
-- content IS the gated thing, so a Captains-only SOP that anon could select
-- would be gated on the screen and readable with a browser key, which is not a
-- gate at all.
--
-- So the browser key gets published, UNGATED documents only. Anything with a
-- min_rank is reachable exclusively through the Inflight backend, which knows
-- the pilot's hours and reads them against the VA's ladder before returning a
-- word of it. Staff drafts and archived revisions stay out for the same reason
-- a draft event does.
drop policy if exists crew_documents_public_read on crew_documents;
create policy crew_documents_public_read on crew_documents
    for select to anon, authenticated using (status = 'published' and min_rank = '');

-- crew_notifications gets NO policy at all, and no grant below.
--
-- A notification is addressed to ONE pilot. There is no filter available here
-- that could scope a browser key to "mine" — the anon key is one shared
-- credential with no identity behind it, so any policy permissive enough to let
-- a pilot read their own inbox would let anybody read the whole airline's. That
-- is a pilot's correspondence, including what staff said about their
-- application, so the table is unreachable with a browser key by construction
-- and every read goes through the backend against a signed-in session.

drop policy if exists crew_schema_info_public_read on crew_schema_info;
create policy crew_schema_info_public_read on crew_schema_info
    for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on crew_members, crew_routes, crew_pireps, crew_events, crew_event_signups,
    crew_announcements, crew_schedules, crew_bookings, crew_documents, crew_schema_info to anon, authenticated;
-- Deliberately NOT granted on crew_applications or crew_accounts. The first
-- holds applicant emails and unclaimed invitation passwords, the second holds
-- password hashes; neither has a policy above, and revoking the grant means a
-- browser key is refused at the door rather than at the row.
revoke all on crew_applications from anon, authenticated;
revoke all on crew_accounts     from anon, authenticated;
-- v11. Same treatment, for the reason spelt out at crew_notifications' absent
-- policy: one shared browser credential cannot express "only mine".
revoke all on crew_notifications from anon, authenticated;

-- crew_stats is security definer so it can aggregate rows the caller cannot
-- read row-by-row (pending reports feed the "awaiting review" counter). It
-- returns only aggregates, so this widens what can be counted, never what can
-- be read.
grant execute on function crew_stats(text) to anon, authenticated;

-- crew_storage_usage is the opposite call: definer over the size catalogues and
-- another schema's tables, so it is kept away from the browser key entirely.
-- The backend reads it with the service key and shows staff the result.
revoke all on function crew_storage_usage(text) from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function crew_storage_usage(text) to service_role';
    end if;
end $$;

-- ----------------------------------------------------------------------------
-- Stamp the version last, so a half-applied script does not advertise itself as
-- a complete install.
-- ----------------------------------------------------------------------------
insert into crew_schema_info (id, version) values (1, 11)
on conflict (id) do update set version = excluded.version, updated_at = now();

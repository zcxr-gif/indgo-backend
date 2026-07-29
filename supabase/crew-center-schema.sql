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
-- applicant's email address, every EVENT and who signed up for it, and every
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
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
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
create index if not exists crew_pireps_va_idx     on crew_pireps (va_slug, status, flown_at desc);
create index if not exists crew_pireps_member_idx on crew_pireps (va_slug, member_id);
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
    foreach t in array array['crew_members','crew_accounts','crew_applications','crew_routes','crew_pireps','crew_events','crew_event_signups','crew_schema_info']
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
        'topPilots',            top.top_pilots,
        'generatedAt',          now()
    )
    from m, p, r, a, ev, top;
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

drop policy if exists crew_schema_info_public_read on crew_schema_info;
create policy crew_schema_info_public_read on crew_schema_info
    for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on crew_members, crew_routes, crew_pireps, crew_events, crew_event_signups, crew_schema_info to anon, authenticated;
-- Deliberately NOT granted on crew_applications or crew_accounts. The first
-- holds applicant emails and unclaimed invitation passwords, the second holds
-- password hashes; neither has a policy above, and revoking the grant means a
-- browser key is refused at the door rather than at the row.
revoke all on crew_applications from anon, authenticated;
revoke all on crew_accounts     from anon, authenticated;

-- crew_stats is security definer so it can aggregate rows the caller cannot
-- read row-by-row (pending reports feed the "awaiting review" counter). It
-- returns only aggregates, so this widens what can be counted, never what can
-- be read.
grant execute on function crew_stats(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Stamp the version last, so a half-applied script does not advertise itself as
-- a complete install.
-- ----------------------------------------------------------------------------
insert into crew_schema_info (id, version) values (1, 6)
on conflict (id) do update set version = excluded.version, updated_at = now();

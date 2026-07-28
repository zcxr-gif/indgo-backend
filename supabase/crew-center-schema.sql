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
-- applicant's email address, and every PILOT ACCOUNT (see crew_accounts) — is
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
    reviewed_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
-- v2. Added separately so a project provisioned at v1 picks it up on re-run
-- rather than needing the table dropped.
alter table crew_applications add column if not exists discord_invite text not null default '';
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
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists crew_routes_va_idx  on crew_routes (va_slug, flight_number);
create index if not exists crew_routes_od_idx  on crew_routes (va_slug, origin, destination) where active;

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
    foreach t in array array['crew_members','crew_accounts','crew_applications','crew_routes','crew_pireps','crew_schema_info']
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
        'topPilots',            top.top_pilots,
        'generatedAt',          now()
    )
    from m, p, r, a, top;
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
alter table crew_members      enable row level security;
alter table crew_accounts     enable row level security;
alter table crew_applications enable row level security;
alter table crew_routes       enable row level security;
alter table crew_pireps       enable row level security;
alter table crew_schema_info  enable row level security;

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

drop policy if exists crew_schema_info_public_read on crew_schema_info;
create policy crew_schema_info_public_read on crew_schema_info
    for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on crew_members, crew_routes, crew_pireps, crew_schema_info to anon, authenticated;
-- Deliberately NOT granted on crew_applications or crew_accounts. The first
-- holds applicant emails, the second holds password hashes; neither has a
-- policy above, and revoking the grant means a browser key is refused at the
-- door rather than at the row.
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
insert into crew_schema_info (id, version) values (1, 3)
on conflict (id) do update set version = excluded.version, updated_at = now();

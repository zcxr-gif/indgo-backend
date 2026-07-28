# The VA's own database

A VA's crew data belongs to the VA and lives in the VA's own Supabase project.
Inflight does not keep a copy.

What we store centrally, and all we store centrally:

- **staff logins** — usernames and bcrypt password hashes, so people can sign in
- **the VA's directory and branding metadata** — name, slug, callsigns, colours,
  layout, fleet definitions, the rank ladder, join requirements, the connection
  details for the project below

What lives in the VA's project:

- the roster, and every pilot's credited hours
- the route network
- every flight report
- every membership application, including the applicant's email address and the
  opaque token that lets them check their own status

If a VA leaves the platform they keep all of it, and we have nothing to hand
back because we never held it.

## Setting one up

1. The VA creates a Supabase project.
2. SQL Editor → paste `crew-center-schema.sql` → Run. It is idempotent; running
   it again upgrades in place and changes no data. The crew dashboard's **Copy
   setup SQL** button fetches this exact file from `GET /api/crew/setup-sql`, so
   there is only ever one copy of the schema.
3. Settings → API → copy the Project URL, the `anon` key and the `service_role`
   key into Crew Center → Settings → Data store.

### Which key does what

| key | who holds it | what it can do |
|---|---|---|
| `anon` | any browser | read the roster, active routes and approved flight reports; call `crew_stats()`. Nothing else, and no writes. |
| `service_role` | the Inflight backend only | everything. Bypasses RLS. Never sent to a browser. |

Row-level security is default-deny. Note what has no public policy at all:
`crew_applications`. Applicant emails and status tokens are unreachable with a
browser key even if that key leaks.

## Endpoints

| endpoint | auth | what it does |
|---|---|---|
| `GET /api/crew/setup-sql` | public | the schema, served from the copy in this repo |
| `GET /api/crew/:slug/stats` | public | aggregate figures. Application counters are added only for a caller who can review applications. |
| `GET /api/crew/:slug/store` | staff | is the project reachable, provisioned, on the current schema — and how much is still in managed storage |
| `POST /api/crew/:slug/store/migrate` | owner | copy managed rows into the VA's project |
| `DELETE /api/crew/:slug/store/legacy` | owner | delete our copy afterwards |

Everything else under `/api/crew/:slug/*` (roster, routes, pireps,
applications) reads and writes through `crewStore.js`, which hides which
backend is answering.

## Migrating an existing VA

Copying and deleting are separate calls on purpose: copying is safe and
repeatable, deleting is neither.

`store/migrate` copies in dependency order — members and routes first, so a
flight report can point at the ids they were given — and skips anything already
present on the far side, so re-running it is a re-sync rather than a duplicate.
Decided applications come across too, because the status links already handed
to applicants must keep resolving.

`store/legacy` then releases our copy. It refuses if the VA's project holds
fewer pilots or reports than we do, so a half-finished migration cannot delete
the original.

## The legacy path

`crewStore.LegacyStore` still reads and writes our old Mongo collections. It
exists only for VAs onboarded before this, and is handed out only to a VA that
already has rows there — a VA with no connection and no legacy rows gets a
`409 store_not_connected` telling them to connect a project.

Setting `CREW_STORE_REQUIRE_OWN=false` reopens managed storage to everyone.
That is an escape hatch for an incident, not a supported configuration.

## Changing the schema

Bump `version` in the final `insert` of `crew-center-schema.sql` **and**
`EXPECTED_SCHEMA_VERSION` in `crewStore.js`. A project on an older version keeps
working — every column the code reads has existed since v1 — but
`GET /api/crew/:slug/store` reports `outdated: true` and the dashboard tells the
VA to re-run the SQL.

Only ever add nullable columns or new tables. A VA runs this script by hand
against their own production data, and there is no way to coordinate a
breaking change across every project at once.

## Accepting a pilot

Accepting an application (`PATCH /api/crew/:slug/applications/:id` with
`action: "accept"`) can do three things beyond flipping the status:

- **Adds them to the roster** — always, in the VA's project.
- **Creates a crew center login** when `createAccount` is set. A `pilot`-role
  account (see `PORTAL_ROLES` in `vaPortal.js`) is provisioned centrally, since
  logins are the one thing we do keep. The generated password is returned in the
  response **once** and is never stored — only its bcrypt hash is. It is emailed
  to the applicant when they gave an address, and shown to the reviewing staff
  member either way, because an applicant without an email has no other route to
  it. Accepting the same person twice returns their existing account rather than
  minting a second login.
- **Sends a Discord invite** — `discordInvite` on the request, falling back to
  the VA's stored `crewDiscordInvite`. It goes into the acceptance email and is
  saved on the application so the applicant's status page can show it again.

The invite is validated by `cleanDiscordInvite` in `crewAuth.js` and it is a
security boundary, not a formatting nicety: that string lands in an email we
send under our own name, and as a link on a page we serve. Anything that is not
literally a `discord.gg` or `discord.com/invite` URL is rejected outright rather
than sanitised, and what is stored is rebuilt from the parsed URL so a pilot is
never shown a path-traversal or a tracking query as their invite link.

## Tests

`node scratchpad/test-crew-store.js` drives the Supabase adapter against an
in-process PostgREST impersonator — mapping, slug scoping, flight-id dedupe,
hours credit/reverse and the error taxonomy. No network, no database.

`node scratchpad/test-discord-invite.js` covers the invite validator: the real
formats, lookalike hosts, non-invite Discord paths, scheme downgrades, and the
three-way `'' / url / null` contract that lets a handler tell "clear this" from
"the caller sent junk".

The schema itself is worth checking against a real Postgres when it changes:
create the `anon` and `authenticated` roles (Supabase provides them; a bare
cluster does not), run the file twice to confirm idempotency, then check
`crew_stats()` and the RLS boundaries as `anon`.

# The VA's own database

A VA's crew data belongs to the VA and lives in the VA's own Supabase project.
Inflight does not keep a copy.

What we store centrally, and all we store centrally:

- **the VA's staff logins** — the owner and their team: usernames and bcrypt
  password hashes, so the people who administer the partnership can sign in.
  Pilots are not in this list; see below.
- **the VA's directory and branding metadata** — name, slug, callsigns, colours,
  layout, fleet definitions, the rank ladder, join requirements, the connection
  details for the project below

What lives in the VA's project:

- the roster, and every pilot's credited hours
- **every pilot's crew center login** — username, bcrypt hash, and whether they
  still owe us a password change
- the route network
- every flight report
- every membership application, including the applicant's email address and the
  opaque token that lets them check their own status

If a VA leaves the platform they keep all of it, and we have nothing to hand
back because we never held it. That now includes their pilots' accounts: we
cannot sign in as anyone's pilot, and a pilot's password is not ours to reset.

## Setting one up

The crew dashboard does it: **Settings → Data store → Set it up for me**. The
VA pastes a Supabase [access token](https://supabase.com/dashboard/account/tokens),
picks a project (or asks for a new one), and the backend installs the schema,
reads the project's API keys back and stores the connection itself. About a
minute, one paste, nothing to copy.

**The access token is never stored.** It is used for the duration of that
request and dropped — not written to the database, not logged, not returned to
the browser. A Supabase personal access token is not scoped to one project, so
holding one at rest would make us a far more attractive target than the service
key we do keep, and nothing at run time needs it. The setup screen says so and
tells the VA to delete the token afterwards.

By hand, if a VA would rather (still supported, under "I'll do it myself"):

1. The VA creates a Supabase project.
2. SQL Editor → paste `crew-center-schema.sql` → Run. It is idempotent; running
   it again upgrades in place and changes no data. The **Copy setup SQL** button
   fetches this exact file from `GET /api/crew/setup-sql`, and the automatic
   path above executes those same bytes, so there is only ever one copy of the
   schema.
3. Settings → API → copy the Project URL, the `anon` key and the `service_role`
   key into Crew Center → Settings → Data store.

### Which key does what

| key | who holds it | what it can do |
|---|---|---|
| `anon` | any browser | read the roster, active routes and approved flight reports; call `crew_stats()`. Nothing else, and no writes. |
| `service_role` | the Inflight backend only | everything. Bypasses RLS. Never sent to a browser. |
| access token | nobody, after setup | used once to install the schema and read the two keys above. Not stored. |

Row-level security is default-deny. Note what has no public policy at all:
`crew_applications` and `crew_accounts`. Applicant emails, status tokens and
password hashes are unreachable with a browser key even if that key leaks — and
the `grant` is revoked as well, so such a request is refused at the door rather
than at the row.

## Endpoints

| endpoint | auth | what it does |
|---|---|---|
| `GET /api/crew/setup-sql` | public | the schema, served from the copy in this repo |
| `POST /api/crew/:slug/store/projects` | owner | list the Supabase projects a pasted access token can see |
| `POST /api/crew/:slug/store/provision` | owner | install the schema, fetch the keys, connect and verify |
| `POST /api/crew/:slug/store/upgrade` | owner | re-run the current schema on the project already connected. Keys untouched |
| `GET /api/crew/:slug/stats` | public | aggregate figures. Application counters are added only for a caller who can review applications. |
| `GET /api/crew/:slug/store` | staff | is the project reachable, provisioned, on the current schema — and how much is still in managed storage |
| `POST /api/crew/:slug/store/migrate` | owner | copy managed rows into the VA's project |
| `DELETE /api/crew/:slug/store/legacy` | owner | delete our copy afterwards |
| `GET/POST /api/crew/:slug/accounts` | staff | list pilot logins / issue one for a pilot already on the roster |
| `PATCH /api/crew/:slug/accounts/:id` | staff | suspend or restore a login |
| `POST /api/crew/:slug/accounts/:id/reset-password` | staff | mint a new one-time password |
| `POST /api/crew/:slug/account/password` | the pilot | change their own, current password required |
| `GET /api/crew/:slug/applications/:id/invite` | staff | read the invitation back, message included |
| `POST /api/crew/:slug/applications/:id/invite/regenerate` | staff | mint a fresh temporary password (resets the account's too) |
| `DELETE /api/crew/:slug/applications/:id/invite` | staff | discard the invitation. Does **not** touch the account |
| `GET /api/crew/:slug/routes` | public | the network, split into own/codeshare counts, with each route marked locked or open for the pilot asking |
| `GET /api/crew/:slug/events` | public | the calendar. Drafts are added only for a caller who can manage events |
| `GET /api/crew/:slug/events/:id` | public | one event with its attendee board and gate allocation |
| `POST/PATCH/DELETE /api/crew/:slug/events[/:id]` | `events.manage` | publish, edit and remove events |
| `POST /api/crew/:slug/events/:id/banner` | `events.manage` | upload the event's artwork |
| `POST/PATCH/DELETE /api/crew/:slug/events/:id/signup` | the pilot | sign up, change gate or aircraft, withdraw |
| `POST/DELETE /api/crew/:slug/events/:id/signups[/:signupId]` | `events.manage` | add a guest to the board, or remove an attendee |
| `GET /api/crew/:slug/events/:id/gates` | public | the gate board — every mapped stand at the airport, marked taken or free |
| `GET/POST /api/crew/:slug/webhook` | staff | read/set the main webhook, or one feed's override (`feed: recruitment\|pireps\|routes`) |
| `GET /api/crew/:slug/roster.csv` | staff | the roster as a spreadsheet, every column |
| `POST /api/crew/:slug/roster/import` | staff | upsert from CSV. `dryRun` defaults true |
| `GET /api/crew/:slug/routes.csv` | staff | the route network as a spreadsheet |
| `POST /api/crew/:slug/routes/import` | staff | upsert from CSV. `dryRun` defaults true |

Everything else under `/api/crew/:slug/*` (roster, routes, pireps,
applications) reads and writes through `crewStore.js`, which hides which
backend is answering.

`/store/provision` is resumable, not long-running: a project Supabase has just
created takes a minute or two to boot, so the call returns `ready: false` with a
`projectRef` and the dashboard polls with the same token until it is up. Every
stage is safe to repeat.

## Pilot accounts

A pilot's login is a `crew_accounts` row in the VA's project. `crewAccounts.js`
owns provisioning, authentication, password changes and staff resets; the schema
table carries a unique index on `(va_slug, lower(username))`, so a username is
one-per-crew-center and two VAs may each have a `j.smith`.

**The account's credential is a bcrypt hash and nothing else.** That is all
`crew_accounts` ever holds. A pilot is issued a temporary password when they are
accepted (or immediately, at a VA that accepts everyone), and
`must_change_password` makes the crew center demand a replacement before it
shows them anything.

### The invitation

The temporary password is also kept, readably, on the application row that
produced it — `crew_applications.invite_password`. This is a deliberate
exception to the rule above and it is worth being explicit about why.

A password that exists only for the length of one HTTP response is the right
shape for a password and the wrong shape for an invitation. Delivery does not
happen at that moment: an applicant who gave no email address had one screenful
before the dialog closed, most of these pilots are reached by hand on the IFC or
Discord some time later, and the answer to every miss was to reset the password
and try again — which teaches staff that credentials are disposable and leaves a
trail of live ones behind.

So the invitation is a small state machine (`crewInvite.js`) instead:

| state | what it means | is the password readable? |
|---|---|---|
| `live` | issued, not yet used | yes — to staff, and to whoever holds the status link |
| `claimed` | the pilot signed in | no. Cleared at that moment |
| `revoked` | staff discarded it | no. Cleared |
| `expired` | unused past `CREW_INVITE_TTL_DAYS` (default 30) | no. Cleared on the next read |

What keeps this bounded: it covers one account that must change its password on
first use, it is bounded in time, and it deletes itself at the first sign it is
no longer needed. Nothing may read `invite_password` directly — every path goes
through `crewInvite.inviteState()`, because a password still physically present
but claimed, revoked or expired must not be shown to anyone.

**It is not encrypted, on purpose.** Encrypting a VA's own data with a key
Inflight holds would mean the VA no longer owns the contents of their own
database, which is the single thing this schema exists to guarantee. The
protection is the same one covering applicant emails and password hashes in this
table: no anon policy *and* no grant, so a browser key is refused at the door.

Where an invitation shows up: the acceptance email, the applicant's own status
link, and **Crew Center → Roster → Invitations**, where it stays until the pilot
signs in or a staff member throws it away. All three render from one message
builder, so a pilot cannot be told two different stories about their own login.

Sign-in (`POST /api/crew/:slug/login`) tries the VA's store first, then our
central staff accounts, then Inflight staff. A store that cannot answer is
treated as "not this identity" rather than an error, so a VA mid-setup — or one
whose project is briefly unreachable — can still get into the dashboard they
would use to fix it.

### Migrating existing pilot accounts

`store/migrate` brings them across with everything else, copying the bcrypt
**hash** rather than a password nobody has. Pilots keep signing in with what
they already use; there is nothing to re-issue and nothing for them to notice.

Logins need a v3 project. Against an older one the rest of the migration still
completes and the response carries an `accountsNote` telling the VA to re-run
the SQL and repeat the (idempotent) migration.

`store/legacy` refuses to release our copy while the VA's project holds fewer
logins than we do — deleting a credential that did not make it across would lock
a pilot out with no way back.

## Migrating an existing VA

Copying and deleting are separate calls on purpose: copying is safe and
repeatable, deleting is neither.

`store/migrate` copies in dependency order — members and routes first, so a
flight report can point at the ids they were given — and skips anything already
present on the far side, so re-running it is a re-sync rather than a duplicate.
Decided applications come across too, because the status links already handed
to applicants must keep resolving.

`store/legacy` then releases our copy. It refuses if the VA's project holds
fewer pilots, reports or logins than we do, so a half-finished migration cannot
delete the original. Owner and staff accounts are deliberately untouched: those
are ours to keep.

## The legacy path

`crewStore.LegacyStore` still reads and writes our old Mongo collections —
including pilot logins, which for a not-yet-migrated VA are still
`VaPortalAccount` rows with `role: 'pilot'`. It exists only for VAs onboarded
before this, and is handed out only to a VA that already has rows there — a VA
with no connection and no legacy rows gets a `409 store_not_connected` telling
them to connect a project.

Setting `CREW_STORE_REQUIRE_OWN=false` reopens managed storage to everyone.
That is an escape hatch for an incident, not a supported configuration.

## Ranks

`crewRanks.js`. A VA defines a ladder — a name and a minimum hours figure per
rung — in crew center settings. That has existed for a while; what is new is
that the **server** resolves it.

**Rank is derived from hours, never stored.** There is no `rank` column on
`crew_members` and there should not be one: the moment a rank is stored it can
disagree with the hours printed next to it, and it would — on every approved
flight, every rolled-back rejection, and every time a VA moves a threshold.
Moving a threshold would need a migration. A derived rank is simply correct.

Two rules worth knowing:

- **The lowest rung is the entry rank, whatever number is next to it.** A VA
  whose ladder starts at "Second Officer, 25h" would otherwise leave a brand-new
  pilot with no rank at all, on the day they are most likely to be looking at
  their own profile. `rankForHours` floors it; every rung above still requires
  its hours.
- **A gate naming a rank that no longer exists lapses open.** A VA who renames
  or deletes a rank gets an open route, never a network that quietly shrank.

Promotions are detected where hours actually move (`applyPirepHours`, and a
staff edit of the hours field) by comparing the rank held before against the
rank held after. That makes it immune to how the hours moved: one long flight
clearing two rungs reports the rung reached. **A rollback announces nothing** —
an admin correcting a mistyped figure must never publish "Jo has been demoted"
to a Discord channel.

## Codeshares and rank-gated routes

`crew_routes.kind` is `own` or `codeshare`. The split is not decoration: a
network map that draws someone else's metal identically to your own overstates
what the airline operates, which is the one thing that map is for. Codeshares
are listed under their own filter, drawn dashed and muted on the map, excluded
from the map's glow layer, and counted separately so "our network is 120 routes"
cannot quietly mean "40 of ours and 80 of somebody else's". A partner name and
an optional https logo ride along.

`min_rank` names a rung on the VA's ladder rather than storing an hours figure,
so the VA sets what a rank is worth in one place and every route gated on it
moves with the threshold. It is a **name, not an index** — a VA reordering their
ladder would otherwise silently re-gate their whole network.

A pilot below the bar sees the route **locked, not hidden**, with how much
further they have to fly. A route you can see and are working toward is the
point of a ladder; a route that simply is not there is indistinguishable from a
network smaller than advertised. Staff and the public are never marked locked —
the gate is about what a pilot may fly.

## Events and the gate board

`crew_events` is what a VA gathers around — a group departure, a fly-in, a
long-haul night. `crew_event_signups` is who is coming, and from which stand.

An event starts as a **draft**. Drafts are the working copy staff write over
several sittings and are invisible everywhere until published — the anon policy
on `crew_events` only returns `published` and `cancelled`. Cancelled is kept
rather than deleted, because pilots who signed up are owed the notice and a row
that vanished tells nobody anything.

`slots` caps attendance and `0` means uncapped. Signing up past the cap is not
refused: the signup lands on the **waitlist**, which is a real attendance record
that simply does not hold a gate. An event that quietly turns pilots away is one
staff find out about too late.

### The gate board

`gate_icao` names the airport whose stands the board covers, stored rather than
derived because the answer is not always the origin — a group departure parks
everyone at the field they leave from, a fly-in parks them at the field they
arrive at. Empty means "the origin", which is the common case.

Stands come from OpenStreetMap (`aeroway=gate|stand|parking_position`, the same
query the tracker's dispatch gate picker uses), so no gate list has to be
maintained per airport. A pilot picks one off a map: taken stands are drawn in
use and name whoever is parked there, free ones are pickable.

**The claim happens in the database, not in the browser.** This unique index is
the whole mechanism:

```sql
create unique index crew_event_signups_gate_idx
    on crew_event_signups (event_id, upper(gate)) where gate <> '';
```

Two pilots tapping the same marker seconds after an event is announced is not a
rare case, and any "is this gate free?" check performed before the insert loses
that race. The second insert fails on the index, the crew center says the stand
has just gone, and the board is never wrong about who is parked where. Upper-cased
because `b24` and `B24` are the same gate to everyone except a database.

`gates_open` is what a VA turns off for an event where stands are irrelevant (a
formation over the ocean). `gates_locked` freezes the allocation once it is
final without deleting anybody's stand.

Withdrawing **deletes** the signup row rather than flagging it. A withdrawn
pilot still holding a gate is the bug the table exists to prevent.

`member_id` is nullable so staff can put a guest on the board — a partner VA
flying in — without inventing a roster row for them. `account_id` is
deliberately *not* a foreign key onto `crew_accounts`: deleting a login must not
cascade a pilot off an event that has already been planned around them.

## Notification feeds

A VA sets one Discord webhook and everything posts to that channel. That is the
default and it is what most VAs want.

Three feeds can each be pointed somewhere else instead:

| feed | what posts |
|---|---|
| `recruitment` | new applications, accept / decline decisions |
| `pireps` | flight reports **filed, approved and rejected** — one feed — plus promotions |
| `routes` | routes added, edited, removed, or imported |

Each is an override, not a switch: an empty value means "use the main webhook",
never "off", so tidying up in the UI cannot silently mute a VA's notifications.
Every existing VA keeps receiving everything on the hook they already set,
because `crewWebhookUrlFor` falls back to it.

Filed / approved / rejected deliberately share one feed. They are three moments
in the same conversation and splitting them across channels means nobody can
follow a report end to end; the colour and the verb carry the difference. Two
noise rules are enforced: re-approving an already-approved report posts nothing,
and a CSV import posts **one** summary rather than one embed per row — a VA
pasting a 200-route network would otherwise rate-limit themselves.

## Taking it out as a spreadsheet

`crewCsv.js`, behind the four CSV endpoints above and the **CSV** button on the
roster and route panels.

"Your data is yours" is only worth something if you can pick it up and carry it,
and a Postgres table is not a form a volunteer airline manager can use. Most VAs
here were running on a spreadsheet the day before they signed up.

The design is one property: **export writes exactly what import accepts**, so a
file that goes out and comes back unedited is a no-op. That is why the `id`
column is exported — a row carrying its id updates precisely, with no guessing.
A file typed from scratch has no ids, so rows are matched on callsign then name
(roster) or flight number then the airport pair (routes). Nothing matches on a
field a VA is likely to bulk-edit, because a match that breaks when someone
fixes a typo silently duplicates the whole roster.

**Import never deletes.** A row in the crew center and absent from the file is
left alone: a VA uploading the twelve pilots they recruited this month must not
lose the other two hundred, and nothing distinguishes that file from a complete
one. Removing a pilot is its own action on the roster screen.

Two other rules worth keeping:

- `required` means "required to create a new row", not "this column must be in
  the file" — a VA correcting hours sends two columns and should not be told to
  add a name column.
- A file with any unreadable row applies **none** of itself. A partial import is
  the worst available outcome: the VA cannot tell what landed, and re-uploading
  the fixed file re-applies whatever did.

Uploads are planned first (`dryRun`, the default) and the dashboard shows the
count before anything is written.

## Changing the schema

Every VA is on their own Postgres, so a release that needs a column is a release
that has to reach every one of those databases. Four steps, and none of them is
optional:

1. Add the column to its `create table` **and** to the
   `alter table … add column if not exists` block below it, so a project
   provisioned at any earlier version picks it up on a re-run.
2. Bump `version` in the final `insert` of `crew-center-schema.sql` **and**
   `EXPECTED_SCHEMA_VERSION` in `crewStore.js`.
3. Add the column to `LATE_COLUMNS` in `crewStore.js` — the set of columns a
   write may drop when the project has not got them (below).
4. Add a line to the version history at the end of this section.

Only ever add nullable columns or new tables. A VA runs this script against
their own production data and there is no way to coordinate a breaking change
across every project at once.

### Getting the change onto the VA's database

**Settings → Data store → Update my database.** The VA pastes an access token
and `POST /api/crew/:slug/store/upgrade` runs this file against the project they
are already connected to — no project picking, no keys touched, nothing to copy.
The token is used for that request and dropped, exactly as in setup.

The project it runs against is read from the stored `supabaseUrl`
(`crewSetup.refFromUrl`) rather than taken from the request, so the endpoint
updates *this* crew center's database and cannot be steered into running our DDL
against some other project on the account.

The button appears on its own when `GET /api/crew/:slug/store` reports
`outdated: true`, and whenever a write has just had to leave a column out.

### Until they press it

A project on an older version keeps working, and specifically it keeps working
for writes, which it did not used to. PostgREST rejects the **whole row** when it
names a column the project has not got, so before this a VA who had not re-run
the SQL got a bare `502` from "add a route" — our error code for their upgrade.

`LATE_COLUMNS` in `crewStore.js` is the set of columns added after v1. A write
naming one the project lacks has that column dropped and is retried; the row
lands, the store records what it left out, and the handler returns the row with
a `warning` and `code: 'store_schema_outdated'` so the dashboard can say *"saved
— but your database can't hold codeshare routes yet"* and offer the button. What
the project is missing is remembered for ten minutes, so this costs one wasted
round trip rather than one per write, and installing a schema clears it
immediately (`crewStore.forgetSchemaDrift`).

**Only columns in `LATE_COLUMNS` are ever dropped.** Each one is additive with a
default, so a row written without it is a valid row on the old shape — that is
what makes dropping it safe rather than lossy. A column that is in no schema at
all, and a genuine constraint violation, both still fail loudly.

A missing *table* is still a hard failure (`store_schema_missing`): a project
with no `crew_routes` has nothing to degrade to.

Version history:

- **v1** — roster, routes, flight reports, applications, `crew_stats()`
- **v2** — `crew_applications.discord_invite`
- **v3** — `crew_accounts`: pilot logins move out of our database into the VA's
- **v4** — `crew_applications.invite_*`: the temporary password an accepted
  applicant is handed now outlives the request that created it
- **v5** — `crew_routes.kind` / `partner_name` / `partner_logo` / `min_rank`:
  codeshares are separated from the airline's own metal, and a route can open at
  a rank
- **v6** — `crew_events` and `crew_event_signups`: events, who is attending, and
  a gate board whose allocation is enforced by a unique index rather than by the
  browser

Note what v6 is not: it adds two **tables**, so there is nothing for
`LATE_COLUMNS` to degrade to. A project still on v5 has no events tables at all,
and the crew center says exactly that (`store_events_missing` → *"re-run the
setup SQL"*) rather than reporting the generic missing-tables error over a crew
center whose roster, routes and flight reports are all working fine. Same
reasoning as `crew_accounts` in v3.

## Accepting a pilot

Accepting an application (`PATCH /api/crew/:slug/applications/:id` with
`action: "accept"`) can do three things beyond flipping the status:

- **Adds them to the roster** — always, in the VA's project.
- **Creates a crew center login** when `createAccount` is set, in the VA's
  project, linked to the roster row it was created alongside. The generated
  password is returned in the response **once** and is never stored — only its
  bcrypt hash is. It is emailed to the applicant when they gave an address, and
  shown to the reviewing staff member either way, because an applicant without
  an email has no other route to it. Accepting the same person twice returns
  their existing account rather than minting a second login.
- **Sends a Discord invite** — `discordInvite` on the request, falling back to
  the VA's stored `crewDiscordInvite`. It goes into the acceptance email and is
  saved on the application so the applicant's status page can show it again.

The reviewer may also supply an `email` for an applicant who left the field
blank, so the credentials can be sent rather than read out. It only ever fills a
gap: an address the applicant gave themselves is never overwritten from the
review screen, because that would let staff redirect someone else's credentials
to an inbox of their choosing.

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

`node scratchpad/test-crew-accounts.js` drives the pilot-login module against
the same kind of impersonator: that a password survives a round trip and its
plaintext never lands in a row, that provisioning twice yields one account,
that usernames are unique per crew center and only per crew center, that wrong
password / unknown user / disabled account are indistinguishable, and that a
pre-v3 project fails with something the VA can act on.

`node scratchpad/test-supabase-setup.js` drives the guided setup against a
Management API impersonator — that the access token reaches Supabase and
nothing else, that a project still booting parks the flow instead of failing it,
that the SQL executed is this repo's own file, and that the service key reaches
storage but never the reply.

`node scratchpad/test-crew-invite.js` drives the invitation lifecycle: that a
claimed, revoked or expired invitation never yields its password to staff or to
the status link even while the column still holds one, that claiming and
revoking actually blank the value rather than only flagging it, that a reissue
clears the previous outcome, that the applicant's view is strictly narrower than
the staff view, and that every channel renders the same message.

`node scratchpad/test-crew-ranks.js` drives the ladder: that a pilot at zero
hours holds a rank even when the ladder starts at 25, that a gate on a rank that
no longer exists lapses open rather than shrinking the network, that a promotion
reports the rung actually reached and a rollback reports nothing at all, and
that normalising a ladder never mutates the caller's array.

`node scratchpad/test-crew-events.js` drives events and the gate board: that a
misspelt status becomes a draft rather than reaching a VA's public calendar,
that the board's airport falls back origin → destination but always yields to
what the VA chose, that a claimed stand reads as taken whatever case it was
typed in, that a stand OpenStreetMap has never heard of still appears on the
board when somebody holds it, that attendance is `null` rather than `0` when
nobody counted it, that the waitlist fills past the cap and drains oldest-first,
and that a pilot editing their own place can change their stand but not their
name or their waitlist position.

The gate race itself is checked in `test-crew-store.js`, against an
impersonator that enforces the schema's unique indexes: a second pilot cannot
take a claimed stand, lower case is not a way around it, and the store reports
*which* rule bit so the handler can say "that stand has just gone" instead of
"that record already exists".

`node scratchpad/test-crew-csv.js` drives the spreadsheet round trip: that an
untouched export re-imports as a no-op, that ids update precisely and hand-typed
rows match on the fallback fields, that a partial file leaves unmentioned
columns alone, that nothing is ever deleted, that duplicate lines collapse, and
that the messy realities survive — quoted commas, semicolon lists, CRLF, a BOM,
and header spellings that have been through three spreadsheet apps.

`node scratchpad/test-crew-schema-drift.js` puts the adapter in front of a
project stuck on v4 — the "502 when I add a route" case. It asserts that the
route is written rather than refused, that only the columns the project lacks
are dropped and the store names them in words a VA reads, that the second write
does not re-learn the same thing, that a schema upgrade restores the full row —
and, in the other direction, that a column belonging to no schema and a
not-null violation both still fail.

`node scratchpad/test-discord-invite.js` covers the invite validator: the real
formats, lookalike hosts, non-invite Discord paths, scheme downgrades, and the
three-way `'' / url / null` contract that lets a handler tell "clear this" from
"the caller sent junk".

The schema itself is worth checking against a real Postgres when it changes:
create the `anon` and `authenticated` roles (Supabase provides them; a bare
cluster does not), run the file twice to confirm idempotency, then check
`crew_stats()` and the RLS boundaries as `anon` — including that
`crew_accounts` is unreadable.

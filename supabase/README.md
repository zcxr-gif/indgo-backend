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

**The access token is not stored unless the VA asks us to keep it.** By default
it is used for the duration of that request and dropped — not written to the
database, not logged, not returned to the browser. A Supabase personal access
token is not scoped to one project, so holding one at rest makes us a more
attractive target than the service key we do keep.

### Keeping the token, on purpose

The setup screen offers one tick: *keep this token so updates are one click*.
Off unless the VA turns it on, withdrawable from the same screen.

It exists because "never store it" had a cost that only showed up later.
`crew-center-schema.sql` gains columns every time the crew center gains a
feature, and catching a project up meant the VA going back to supabase.com,
minting a fresh token and pasting it — months after they last thought about any
of this. In practice nobody did, projects sat on old schemas, and the first sign
of the gap was a save that quietly dropped a field.

What a kept token is, and is not:

- **Sealed at rest.** AES-256-GCM (`crewSecrets.js`) under `CREW_SECRET_KEY`
  from the environment, never a value in the document. A dump of the collection
  is ciphertext. With no key configured the offer is not made and nothing is
  kept — we would rather lose the convenience than hold an account-wide
  credential in the clear.
- **Used for exactly one thing**: running *this repo's* schema file against the
  project this crew center is already connected to. The project ref comes from
  the stored `supabaseUrl`, never from a request, so a kept token cannot be
  steered at another project on the account.
- **Never disclosed.** The dashboard is told there is one, which one
  (`sbp_…9f3a`), when it was saved and whether it last worked. Never the value.
- **The VA's to withdraw.** `DELETE /store/token` deletes our copy; the reply
  says plainly that revoking it in Supabase is a separate act, because
  "forgotten" is not "revoked".
- **Allowed to go stale.** A token Supabase refuses is marked rather than
  deleted, so the screen can say *the one you saved in March stopped working*
  instead of silently reverting to asking for a token with no explanation. The
  automatic updater skips a marked token until a human replaces it.

With a token kept, `supabaseAutoUpdate` (on by default; saving the token is the
consent, the switch is how to take it back) lets the backend run the update
itself the first time it notices the project is behind — see *Getting the change
onto the VA's database* below.

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
| access token | nobody, unless the VA opts in | installs the schema and reads the two keys above. Dropped after the request, or sealed and kept — only to re-run *our* schema on the project already connected. |

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
| `POST /api/crew/:slug/store/upgrade` | owner | re-run the current schema on the project already connected. Keys untouched. Uses the kept token when no token is pasted |
| `POST /api/crew/:slug/store/token` | owner | save (and verify) an access token to keep, or flip `autoUpdate` on the one already kept |
| `DELETE /api/crew/:slug/store/token` | owner | forget the kept token. Revoking it in Supabase is the VA's separate act |
| `GET /api/crew/:slug/store/usage` | staff | how much room the project is using — database total, per-table, and what else is in there |
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
| `POST /api/crew/:slug/pireps` | the pilot | file a flight. `eventId` ties it to an event and fills the leg in from it |
| `POST /api/crew/:slug/roster/:id/checkride` | `roster.manage` | pass (or revoke) a pilot's check-ride for a rank |
| `GET /api/crew/:slug/announcements` | public | the noticeboard |
| `POST/PATCH/DELETE /api/crew/:slug/announcements[/:id]` | `roster.manage` | post, pin and remove notices |
| `GET/POST /api/crew/:slug/webhook` | staff | read/set the main webhook, or one feed's override (`feed: recruitment\|pireps\|routes\|events`) |
| `GET /api/crew/:slug/roster.csv` | staff | the roster as a spreadsheet, every column |
| `POST /api/crew/:slug/roster/import` | staff | upsert from CSV. `dryRun` defaults true |
| `GET /api/crew/:slug/routes.csv` | staff | the route network as a spreadsheet |
| `POST /api/crew/:slug/routes/import` | staff | upsert from CSV. `dryRun` defaults true |
| `GET /api/crew/:slug/if` | staff | the Infinite Flight connection's state. Client details are added for the owner only |
| `POST/DELETE /api/crew/:slug/if/client` | owner | register (or forget) the VA's own OAuth2 client |
| `POST /api/crew/:slug/if/connect` | owner | begin the OAuth2 sign-in. Returns the URL to send the browser to |
| `GET /api/crew/if/callback` | public | where Infinite Flight redirects back. Authenticated by the OAuth `state` alone — see below |
| `DELETE /api/crew/:slug/if/connection` | owner | forget our copy of the grant |
| `GET /api/crew/:slug/if/organizations[/:id]` | staff | the Live organizations this account belongs to |
| `POST /api/crew/:slug/if/organization` | owner | point this crew center at one of them |
| `GET /api/crew/:slug/if/aircraft` | staff | the organization's fleet, in fleet order |
| `GET /api/crew/:slug/if/fleet` | staff | the fleet with every aircraft's last position attached, in one call |
| `GET /api/crew/:slug/if/aircraft/:id` | staff | one aircraft, its position and its rota |
| `GET /api/crew/:slug/if/aircraft/:id/position` | staff | just the last stored position |
| `GET /api/crew/:slug/if/airframes` | staff | the fleet reduced to a picker. **Answers `[]` rather than 409** when nothing is connected |
| `GET /api/crew/:slug/if/utilisation` | staff | what every aircraft is doing: legs booked, block scheduled, days since it last flew, which are idle |
| `GET /api/crew/:slug/if/aircraft/:id/schedules` | staff | the aircraft's rota, in sequence, marked with which legs the crew center already has |
| `POST /api/crew/:slug/if/aircraft/:id/schedules` | `schedules.manage` | add a leg to the end of the rota |
| `PUT /api/crew/:slug/if/schedules/:id` | `schedules.manage` | change a leg |
| `PUT /api/crew/:slug/if/schedules/:id/flightplan` | `schedules.manage` | replace just the flight plan. Empty clears it |
| `POST /api/crew/:slug/if/aircraft/:id/schedules/order` | `schedules.manage` | send the whole arrangement; the backend turns it into the API's single moves |
| `DELETE /api/crew/:slug/if/schedules/:id` | `schedules.manage` | remove a leg. The linked crew departure is **unlinked, never deleted** |
| `POST /api/crew/:slug/if/sync` | `schedules.manage` | which aircraft the crew schedule pushes to, and whether it does |
| `POST /api/crew/:slug/if/push` | `schedules.manage` | push published upcoming departures onto that aircraft's rota |
| `POST /api/crew/:slug/if/pull` | `schedules.manage` | import the aircraft's rota into the crew center as drafts |
| `GET /api/crew/:slug/if/board` | any crew login | the pilot's read-only view: the fleet, where it is, what is going out next |

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

## Check-rides

Hours decide rank — except on a rung the VA marks `requiresCheck`. Most VAs
gate none, some gate one (the step up to Captain). It is a per-rung choice in
Settings → Crew, with a note saying what the check-ride actually is.

On a gated rung the hours carry a pilot to the **door and no further**: they
hold the rung below, the roster shows them as *ready for their Captain
check-ride*, and a staff member signs them off from there
(`POST /api/crew/:slug/roster/:id/checkride`). The rung's name lands in
`crew_members.checks_passed`.

Rank is still derived — from two inputs now instead of one. What is stored is
the **sign-off**, which is a different kind of thing: a record of something a
person did. It does not go stale when the ladder is edited and it cannot
disagree with the hours beside it.

Three rules, all in `crewRanks.js` and all covered by
`scratchpad/test-crew-ranks.js`:

- **A gated rung is never leapfrogged.** A pilot with the hours for two rungs
  above the gate still stops at the gate. A ladder is a ladder.
- **A rename lets the requirement lapse**, promoting the pilot — the same
  direction of failure `meetsRank` chose for route gating. A pilot stuck below a
  rank because of a rename nobody remembers is a support ticket nobody can
  answer.
- **Crossing into a gated rung announces nothing.** Arriving at a door is not a
  promotion, and "Jo is now a Captain" is not a thing to say and then walk back.
  The sign-off is what announces it, and it earns the same notice an
  hours-driven promotion does — from the pilot's side they are the same event.

The moment a pilot arrives at the door fires its own notice, once, to the
`pireps` feed and the noticeboard. Without it the pilot quietly stops being
promoted and nobody — them or staff — ever finds out why.

## Events on a route, and flights flown for an event

`crew_events.route_id` ties an event to a leg the airline already publishes.
Picking one in the editor fills the leg in; leaving it off is right for a
one-off (a fly-in from anywhere, a charter to a field the network does not
serve), which is why the leg fields are kept alongside rather than read through
the route.

Filing goes through `POST /api/crew/:slug/pireps` with an `eventId` — the same
endpoint every other manual report uses. An event flight is an ordinary flight
that happens to know why it was flown, and it must be reviewed, credited and
route-matched by exactly the same code as any other. The event supplies whatever
the pilot did not type, which filing straight off the brief is everything except
how long it took.

`crew_pireps.event_id` is what lets the brief show what was actually **flown**,
as opposed to who said they would turn up.

## Codeshare partners

`GET /api/crew/:slug/routes` returns a `partners` array beside the routes: one
entry per codeshare airline with its name, logo, leg count, destination count
and how many of those legs are locked to the pilot asking.

Grouped server-side for the reason `counts` is — so the route panel, the network
map and a VA's own website cannot quote different figures — and case-folded on
the partner name, because a VA typing "Delta Virtual" and "delta virtual" on
different routes means one airline to everybody except a `groupBy`.

It is also what makes a partner's **logo** something to click: a route list
filtered to one airline is the question a pilot actually has ("what can I fly on
Delta's metal?"), which a flat list of two hundred legs does not answer.

## The noticeboard

`crew_announcements`. Two kinds of row in one shape: what staff write, and what
the crew center writes for them — a promotion, a pilot joining, someone ready
for a check-ride.

The second kind is the point. Those all already happen inside the crew center
and used to leave no trace but a Discord line that scrolls away by Thursday. A
pilot who joined on Tuesday should still see on Friday that they joined.

`source` tells them apart. A generated row cannot be rewritten through the API —
only pinned — because staff editing what the crew center recorded would make the
board untrustworthy, and `kind` is forced to `notice` on anything posted by
hand so a hand-written "promotion" cannot be mistaken for one that happened.

Writing a notice is always **fire-and-forget** for the thing that caused it: a
promotion that happened must never be reported as a failure because the
announcement about it could not be written.

## How much room is left

**Crew Center → Settings → Storage**, backed by `GET /api/crew/:slug/store/usage`
and `crew_storage_usage()` in the schema.

Supabase's free plan stops at 500 MB of database, and a project that reaches the
ceiling goes **read-only**: applications stop saving, PIREPs stop filing, and
the crew center looks broken for a reason nothing inside it explains. The figure
has always been on Supabase's own dashboard — which is a place VA staff have no
account for once the owner has finished the setup.

So the project reports its own size. Three things are on the screen and each
answers a different question:

| figure | the question |
|---|---|
| database total, against the plan ceiling | *are we about to be cut off?* |
| per crew table, with row counts | *what is growing?* |
| everything else in the project, named | *what is that 300 MB that isn't us?* |

Sizes are `pg_total_relation_size` — indexes and TOAST included — because that
is what the plan is measured against. Adding up the rows we think we wrote would
report comfortably low and reassure a VA who is about to run out, which is the
opposite of what this screen is for.

Two deliberate choices:

- **Staff, not owner-only**, unlike the rest of the data-store screen. This is a
  thing to *watch*, and the person watching it is whoever runs the airline day to
  day. It reveals sizes and counts, never row contents.
- **The ceiling is an assumption, and says so.** Supabase's real limit comes
  from the VA's plan, which we cannot see. `CREW_STORAGE_LIMIT_MB` (default 500)
  is the reference line the bar is drawn against; nothing enforces it.

Where one project backs several brands, each table reports both its total rows
and this crew center's share — `vaRows` — because on a shared project those are
different questions.

## Notification feeds

A VA sets one Discord webhook and everything posts to that channel. That is the
default and it is what most VAs want.

Three feeds can each be pointed somewhere else instead:

| feed | what posts |
|---|---|
| `recruitment` | new applications, accept / decline decisions |
| `pireps` | flight reports **filed, approved and rejected** — one feed — plus promotions |
| `routes` | routes added, edited, removed, or imported |
| `events` | events published, changed and cancelled — **not** signups |

Each is an override, not a switch: an empty value means "use the main webhook",
never "off", so tidying up in the UI cannot silently mute a VA's notifications.
Every existing VA keeps receiving everything on the hook they already set,
because `crewWebhookUrlFor` falls back to it.

Signups deliberately do **not** post to the events feed. A popular event would
fire forty embeds in an evening, which is how a channel gets muted, and "who is
coming" is a question the event's own attendee board answers better than a
scroll-back.

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

Three ways, in the order a VA will meet them:

1. **Nothing at all.** A VA who kept their token with `autoUpdate` on gets the
   update run for them the first time we notice their project is behind —
   `autoUpdateStore` in `server.js`, triggered from `GET /api/crew/:slug/store`.
   It runs the same idempotent script the button runs, at most once per VA per
   30 minutes, never for a token Supabase has already refused, and it logs what
   it did. Nothing about the script changes: it only ever adds, so it cannot
   undo an earlier fix.
2. **Settings → Data store → Update my database**, with nothing to paste,
   because the kept token is used when the request carries none.
3. **The same button, pasting a token** — the original path, unchanged, and the
   only one available to a VA who has not kept one.

The project it runs against is read from the stored `supabaseUrl`
(`crewSetup.refFromUrl`) rather than taken from the request, so the endpoint
updates *this* crew center's database and cannot be steered into running our DDL
against some other project on the account. All three paths go through
`crewSetup.updateSchema`, so "I pressed update" and "it updated itself" cannot
drift apart in what they do to a VA's database.

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
- **v7** — `crew_members.checks_passed`, `crew_events.route_id`,
  `crew_pireps.event_id`, and `crew_announcements`: a rank can require a
  check-ride, an event can be built on a route and flown against it, and the
  crew center keeps a noticeboard of its own
- **v8** — `crew_schedules` and `crew_bookings`: the VA publishes departures and
  pilots book a seat on one, with the seat arbitrated by a unique index
- **v9** — `crew_storage_usage()`: the project reports its own size, so VA staff
  can see how close they are to their Supabase plan's ceiling from inside the
  crew center
- **v13** — `crew_schedules.if_schedule_id` / `if_aircraft_id` /
  `if_registration` / `if_synced_at`: a departure can name the specific airframe
  that flies it, and record the Infinite Flight Live schedule it was pushed to —
  so the second push is an update rather than the same leg twice on somebody's
  real aircraft

Note what v13 is not: it is not what makes the Live panel work. The fleet, the
positions and the Live schedules all come from Infinite Flight, so a project on
v12 gets the whole feature — what it cannot do is *remember* which of its own
departures it has pushed. The three columns are in `LATE_COLUMNS`, so the push
degrades to "sent, but this crew center could not record it" with the update
button attached, rather than failing.

Note what v9 is not: it adds no columns and no tables, only a function, so
nothing degrades on a project that has not got it. `GET /store/usage` answers
`store_storage_unsupported` and the screen offers the update button instead of
showing a broken panel over a project that is otherwise working perfectly.

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

## Infinite Flight Live

A VA runs two things that could not see each other. One is this crew center. The
other is their Live **organization** inside Infinite Flight: the aircraft they
actually own, in fleet order, each with a rota of flights it is going to fly and
a last-known position. Infinite Flight's PublicApi v3 opened that up over OAuth2,
and `ifOAuth.js` / `ifLive.js` are it wired in.

**Note the API is a preview.** Infinite Flight say its paths, fields, enum
values, validation rules and rate limits may change before general availability.
Two consequences run through the whole implementation: an enum value we have not
been told about becomes a *label* rather than an exception (a
`ScheduledFlightStatus` of 5 renders as "Status 5" and the fleet board keeps
painting), an unrecognised **field** is carried through untouched under `extra`
so a rename degrades to "not drawn yet" rather than "data gone", and every base
URL is environment-overridable so a moved path is a config change.

### Who can do what

| | who |
|---|---|
| connect the account, register the OAuth client, pick the organization, disconnect | **owner** |
| read the fleet, positions and rotas in the staff panel | **staff** |
| add / edit / re-plan / reorder / remove a Live schedule, push or pull the crew schedule | **`schedules.manage`** |
| the read-only fleet board on the pilot page | **any crew login** |

Above all of that sits a ceiling we do not impose and cannot route around.
Everything is done as **one** Infinite Flight user — the staff member who pressed
Connect — so Infinite Flight's own rules apply: reads need membership of the
organization, writes need owner or admin of it. A crew center can never do more
to a VA's Live organization than that person could do by hand. Where their grant
is narrower than the screen, the screen narrows: `canWrite` is read off the
scopes Infinite Flight actually **granted**, not off what we asked for, so a VA
who declined schedule writes gets a read-only panel rather than a save button
that 403s.

Pilots never hold a token, cannot reach any of the fleet or schedule endpoints,
and cannot address any organization but the one their VA selected. `/if/board`
is the only Live endpoint a pilot session can call.

### The credential

Both tokens are sealed with `crewSecrets` (AES-256-GCM, key from the
environment) exactly as the Supabase access token is, and neither is ever sent
to a browser. **`CREW_SECRET_KEY` is required**: the connect flow refuses to
start without one rather than walking a VA through consent and then dropping the
token on the floor.

Refresh tokens rotate, so `ifTokenFor()` **writes the new pair before it returns
the new access token**. A crash between those two would otherwise leave the VA
holding a refresh token Infinite Flight has already retired — indistinguishable
from a revoked connection, and fixable only by reconnecting.

Disconnecting deletes *our* copy. It does not revoke the authorization at
Infinite Flight, and the reply says so, because "forgotten" is not "revoked" —
the same honesty the Supabase token deletion offers.

### The callback is authenticated by `state` alone

`GET /api/crew/if/callback` is public by necessity: it is a navigation from
Infinite Flight's own site carrying none of our cookies. So `state` does all the
work. It names a row in `CrewIfAuthState` holding the PKCE verifier, the VA, the
staff member and the scopes; the row is **deleted by the same call that reads
it** (single use), expires on a TTL index after ten minutes, and is compared in
constant time. A callback whose state does not resolve gets a flat refusal — a
helpful distinction there is a helpful distinction for whoever is probing.

### Whose OAuth client

Either the platform's (`IF_OAUTH_CLIENT_ID`) or one the VA registers themselves,
and **the VA's is preferred**. Infinite Flight limit a new client to "the owner
and invited test users until the app is reviewed and approved", so a platform
client works for nobody but us until that review lands, while a client the VA
creates at infiniteflight.com/account/api-keys has the VA as its owner and works
for them today. A stored client secret is sealed like everything else; without
one the client is public and leans on PKCE, which is supported and is what the
preview expects of browser and native apps. PKCE is used for **both** types.

### The bridge to the crew schedule — a link, not a merge

The two kinds of schedule are different objects and are deliberately not
conflated:

- **`crew_schedules`** — a departure with *seats*, which pilots book, gated on a
  rank, drafted before it is published.
- **an Infinite Flight schedule** — a leg attached to one real aeroplane, with a
  sequence in that aeroplane's running order and a status driven by the flight
  actually happening.

So a crew departure may *refer* to the Live schedule it was pushed to, and that
is all: `if_schedule_id`, `if_aircraft_id`, `if_synced_at` (v13, and in
`LATE_COLUMNS`, so a project on v12 keeps working and simply cannot record the
link). Three rules the sync follows:

- **A push never deletes.** A leg that has gone from the crew center's week is
  left alone in Infinite Flight — "this disappeared from one list" is not enough
  to justify removing a flight from somebody's aircraft, and a bug in that loop
  would be expensive and quiet. Removing is a deliberate act on the panel.
- **A pull always imports as drafts**, and never touches seats, the rank gate,
  publication status or bookings. `ifLive.toCrewSchedule` returns only the
  fields that mean the same thing on both sides, which is what makes that
  guarantee structural rather than a promise.
- **Deleting a Live schedule unlinks the crew departure, it does not delete it.**
  That row has bookings hanging off it and pilots who took those seats.

### Which aeroplane, as opposed to which type

`crew_schedules.aircraft` is the **type** and livery — "Boeing 787-9" — and has
always been there. `if_aircraft_id` + `if_registration` name a **specific
airframe** out of the VA's Live organization, and reach the world as
`airframe: { id, registration }` (or `null`, never `{}` — "no airframe" must not
be mistakable for one whose registration is blank).

The registration is denormalised on purpose. It is the only part a pilot reads
("you're on N682XL"), and resolving it from the id would mean calling Infinite
Flight to draw a schedule — on a page the whole roster loads, for a VA who may
not have connected an organization at all. The id is the truth; this is the
label. A stale label on a re-registered airframe is a much smaller problem than
a schedule that cannot render unless a third party answers.

`GET /if/airframes` exists so the schedule editor can offer the picker without
understanding the Live connection: it answers **200 with an empty list** for a
crew center with no organization, no grant or an expired one, rather than the
409 the fleet endpoints correctly return. A schedule form should not have to
handle three failure codes to draw one dropdown, and "nothing to offer" is a
perfectly good answer to "what may I offer?".

### The automatic sync — two consents, two questions

`syncScheduleToIf` in `server.js` runs off the crew center's own schedule
routes: publish a departure and it appears on the aircraft's Live rota, edit it
and the rota follows, cancel or delete it and the leg comes off.

Two settings, deliberately answering different questions:

| | says |
|---|---|
| assigning an airframe to a departure | **which** aeroplane it is flown by |
| `ifSyncSchedules` | **whether** we may write to that aeroplane's real rota |

Keeping them apart matters: assigning an airframe is something a VA does
constantly while building a week, and treating it as permission to start editing
their live fleet would be a surprise nobody asked for. With the switch off the
airframe is purely a label — pilots see the registration, the rota is untouched,
and the manual Push button still works. `ifSyncAircraftId` is the fallback for
departures with no airframe of their own; leaving it unset while the switch is
on is a legitimate setup (only assigned departures sync) and the reply says so,
because it is *also* what a half-finished setup looks like.

**Why cancelling deletes when a push never does.** The bulk push leaves alone
anything that has merely gone from its list — "it stopped matching my query" is
not evidence, and a bug in that loop would quietly strip somebody's aircraft.
Cancelling or deleting a departure is not that: it is a person deciding, about
one flight, that it is not happening.

**Nothing in the sync may fail a request.** Every call is fire-and-forget with
its own catch, in the mould of `postScheduleNotice`. A VA's schedule is theirs
and lives in their database; Infinite Flight being slow, rate-limiting us or
refusing a scope must never turn "publish this departure" into an error. The one
failure logged loudly is a push that succeeded but could not be recorded — that
is the one that duplicates a leg next time.

### Fleet utilisation

`GET /if/utilisation` answers the expensive question a rota read one aeroplane
at a time cannot: **which aircraft is nobody using?** Per airframe — legs
booked, block hours scheduled, next departure, days since it last flew — plus a
roll-up, sorted so the aircraft to act on is first (never-flown above
long-idle).

Three rules it holds, all of them the "don't invent" rule wearing different
clothes:

- **A rota that failed to load is `unknown`, not empty.** "This aircraft has
  nothing scheduled" is the headline finding here, and producing it from a
  failed read would send a VA hunting a problem that is not there.
- **Only an *actual* arrival counts as flown.** A schedule in the past that
  nobody flew is a plan, not evidence.
- **In storage is not idle.** That is a decision somebody made, not neglect.

One call per aircraft, so it is its own tab rather than part of the fleet
board's refresh — and it shares cache keys with the schedule tab, so opening one
after the other is free.

### Naming the aircraft type

PublicApi v3 returns `aircraftId` — "the Infinite Flight aircraft **or livery**
content identifier", and deliberately vague about which. On its own that is
unusable: a fleet board can show a registration and nothing about what the
aeroplane is.

`ifWithTypes` resolves it against the same aircraft/livery catalogue live
flights already use (`resolveFlightNames`), trying both maps because the id may
be either kind, and attaches `type: { name, livery }` — or `null`, so a caller
can tell "we don't know what this is" from "a 787 with no livery recorded".

Never fatal. The catalogue is a third party's; a fleet board that refused to
draw because it could not name a type would trade something useful for something
cosmetic. Every fleet read goes through one `ifFleet()` helper so the cache key
and the enrichment cannot drift apart — a sixth caller that remembered the cache
and forgot the types would produce a board where some aircraft have a picture
and some do not, depending on which screen warmed the cache first.

### Reordering

The API moves one schedule at a time relative to another; a drag-and-drop list
hands back a whole arrangement. `ifLive.reorderPlan` turns the arrangement into
the moves — first to the top (`afterId: null`), then each after its predecessor.
That is *n* calls rather than the theoretical minimum, on purpose: the minimum
needs to know the current order at the moment each call lands, and it cannot,
because somebody else may be reordering the same aircraft. Every call states an
absolute intention, so a lost one leaves the rota closer to right rather than
shuffled. Schedules the API will not move (cancelled, arrived, diverted) are
dropped from the plan rather than spent as calls that will be refused — but a
status we do not recognise is **kept**, because refusing to move something we
have not heard of is exactly the preview failure mode above.

### "Flying now"

`/live/aircraft/{id}/position` is the *last persisted* state and "can be stale
when the aircraft is not actively reporting". The v3 docs say what to do about
that: compare the aircraft id with `FlightEntry.flightId` from the v2 multiplayer
feed. The tracker service already polls that feed, so
`POST /api/live/aircraft-active` (in `live_flights.cjs`) answers it from the
cache the poller has already filled — no extra calls against anyone's rate
limit. It is strictly a bonus: it adds a green dot, and a board without one is
still a board.

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

`node scratchpad/test-crew-token-vault.js` covers the kept token. On the sealing
side: that with no key configured `seal()` returns nothing rather than falling
back to plaintext (checked in a child process, because the module resolves its
key once), that an edited or truncated blob opens to `''` instead of to some
other string, and that the hint drops the middle of the token rather than
masking it. On the updating side, against a Management API impersonator: that
the file executed is this repo's own, that it runs against the project it was
given and no other, that a paused project is refused rather than half-updated,
and that a revoked token and a token from somebody else's account come back as
*different* codes — they are different mistakes with different fixes.

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

`node scratchpad/test-if-live.js` covers the Infinite Flight Live integration's
pure half. Most of it is written against one failure class rather than against
the happy path: the API is a preview, so the cases that matter are the ones
where a change at *their* end takes the crew center down — an undocumented enum
value (`ScheduledFlightStatus` has a real hole at 5), a field we have never
seen, a validation rule we might accidentally make stricter than theirs. Then
the parts where being wrong is expensive: PKCE (the whole security of a public
client), the reorder plan (a rota is what an aeroplane actually flies), and the
crew-schedule bridge, where a mapping error would duplicate legs on somebody's
real aircraft — so it pins that an import carries *no* seats, rank gate or
publication status, and that a departure with no arrival time is skipped with a
reason rather than given an invented one. The utilisation block is written
against the two ways to get "which aircraft is nobody using?" wrong, both worse
than not answering: calling an aircraft idle when its rota merely failed to
load, and calling it busy on the strength of a schedule nobody flew.

`bash scratchpad/test-schema-postgres.sh` runs the schema against a **real**
Postgres, which is the only thing that catches what the impersonators cannot: it
installs the previous committed version, puts rows in, upgrades in place, and
checks the VA's data survived. Then it checks the RLS boundaries as `anon`
(including that `crew_accounts` is unreadable) and that `crew_storage_usage()`
reports real figures to the service key while being refused to a browser key.
Run it whenever `crew-center-schema.sql` changes.

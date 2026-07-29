#!/usr/bin/env bash
# Runs supabase/crew-center-schema.sql against a REAL Postgres.
#
# The other tests in here drive JavaScript against an impersonator. This one
# checks the thing the impersonator cannot: that the SQL a VA pastes into their
# own project actually applies. The failures it is looking for are the ones that
# only a real server finds, and every one of them has bitten this file:
#
#   * a fresh install failing on a foreign key to a table declared LATER in the
#     file, while the same statement looks fine on an upgrade (the reason
#     crew_pireps.event_id is constrained further down than it is declared);
#   * a re-run failing because `add constraint` has no `if not exists`;
#   * an upgrade dropping or rewriting a VA's rows instead of adding columns
#     beside them;
#   * an RLS boundary that is described in a comment and not enforced.
#
# It installs the PREVIOUS committed version first, puts real rows in, and then
# upgrades — because "works on an empty database" is not the case a VA is in.
#
# Usage:  bash scratchpad/test-schema-postgres.sh
# Needs:  a local PostgreSQL (initdb/pg_ctl/psql on PATH, or /usr/lib/postgresql/*/bin).
#         Nothing is written outside $TMP, and any running cluster is untouched.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$REPO/supabase/crew-center-schema.sql"
TMP="$(mktemp -d)"
PREV_REF="${PREV_REF:-HEAD}"     # which commit's schema counts as "the version a VA already has"

for d in /usr/lib/postgresql/*/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done
command -v initdb >/dev/null || { echo "no PostgreSQL on PATH — skipping"; exit 0; }

fail=0
ok()  { echo "  ✓ $1"; }
bad() { fail=$((fail+1)); echo "  ✗ $1${2:+ — $2}"; }
is()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "got '$2', want '$3'"; }

# Postgres refuses to run as root, so a fresh install needs an unprivileged
# owner for the data directory. Reuse one if it is already there.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
    id pgtest >/dev/null 2>&1 || useradd -m pgtest >/dev/null 2>&1
    RUNAS="pgtest"
    chown -R pgtest "$TMP"
fi
run() { if [ -n "$RUNAS" ]; then su "$RUNAS" -c "PATH=$PATH $*"; else eval "$*"; fi; }

cleanup() {
    run "pg_ctl -D $TMP/data stop -m immediate" >/dev/null 2>&1
    rm -rf "$TMP"
}
trap cleanup EXIT

echo "• standing up a scratch cluster"
run "initdb -D $TMP/data -A trust -U postgres" >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
run "pg_ctl -D $TMP/data -o '-k $TMP -h \"\"' -l $TMP/log start" >/dev/null 2>&1
sleep 2
PSQL="psql -h $TMP -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -c 'select 1' >/dev/null 2>&1 || { echo "cluster did not come up"; cat "$TMP/log"; exit 1; }

# Supabase provides these two roles. A bare cluster does not, and the schema's
# grants name them — so a VA's project has them and this has to as well.
newdb() {
    $PSQL -c "create database $1" >/dev/null
    $PSQL -d "$1" -c "create role anon nologin; create role authenticated nologin" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
echo "• a fresh install, twice"
# ---------------------------------------------------------------------------
newdb fresh
if $PSQL -d fresh -f "$SCHEMA" >/dev/null 2>"$TMP/e1"; then ok "applies to an empty database"
else bad "applies to an empty database" "$(head -3 "$TMP/e1" | tr '\n' ' ')"; fi

if $PSQL -d fresh -f "$SCHEMA" >/dev/null 2>"$TMP/e2"; then ok "and again — it is idempotent"
else bad "and again — it is idempotent" "$(head -3 "$TMP/e2" | tr '\n' ' ')"; fi

WANT_VERSION="$(grep -oE "insert into crew_schema_info \(id, version\) values \(1, [0-9]+\)" "$SCHEMA" | grep -oE '[0-9]+\)$' | tr -d ')')"
is "it stamps the version the file declares" \
   "$($PSQL -d fresh -tAc 'select version from crew_schema_info')" "$WANT_VERSION"

# ---------------------------------------------------------------------------
echo "• the upgrade a live VA actually performs"
# ---------------------------------------------------------------------------
git -C "$REPO" show "$PREV_REF:supabase/crew-center-schema.sql" > "$TMP/prev.sql" 2>/dev/null
if [ ! -s "$TMP/prev.sql" ]; then
    echo "  (no previous schema at $PREV_REF — skipping the upgrade path)"
else
    newdb upgraded
    $PSQL -d upgraded -f "$TMP/prev.sql" >/dev/null 2>&1
    PREV_VERSION="$($PSQL -d upgraded -tAc 'select version from crew_schema_info')"

    # Rows first. "Works on an empty database" is not the case a VA is in.
    $PSQL -d upgraded >/dev/null 2>&1 <<'SQL'
insert into crew_members (va_slug,name,callsign,hours) values ('amv','Antony','AMX101',120);
insert into crew_routes (va_slug,flight_number,origin,destination) values ('amv','AM404','MMMX','KJFK');
insert into crew_pireps (va_slug,flight_number,origin,destination,duration_min,status)
    values ('amv','AM404','MMMX','KJFK',300,'approved');
insert into crew_accounts (va_slug,username,password_hash) values ('amv','jo','$2b$notarealhash');
insert into crew_applications (va_slug,ifc_name,email) values ('amv','Someone','a@b.c');
SQL

    if $PSQL -d upgraded -f "$SCHEMA" >/dev/null 2>"$TMP/e3"; then
        ok "v$PREV_VERSION upgrades in place"
    else
        bad "v$PREV_VERSION upgrades in place" "$(head -3 "$TMP/e3" | tr '\n' ' ')"
    fi
    is "…to the current version" "$($PSQL -d upgraded -tAc 'select version from crew_schema_info')" "$WANT_VERSION"
    is "…and the VA's rows are all still there" \
       "$($PSQL -d upgraded -tAc "select (select count(*) from crew_members)||'/'||(select count(*) from crew_routes)||'/'||(select count(*) from crew_pireps)||'/'||(select count(*) from crew_accounts)")" \
       "1/1/1/1"
    is "…with the pilot's hours untouched" \
       "$($PSQL -d upgraded -tAc "select hours from crew_members")" "120.0000"
    is "crew_stats() still answers on the upgraded project" \
       "$($PSQL -d upgraded -tAc "select (crew_stats('amv')->>'pilots')")" "1"
fi

# ---------------------------------------------------------------------------
echo "• what a browser key can see"
#
# The security claims in this file's comments, enforced rather than described.
# A leaked anon key is the threat being modelled, so each of these is checked as
# the anon role rather than as the owner.
# ---------------------------------------------------------------------------
$PSQL -d fresh >/dev/null 2>&1 <<'SQL'
insert into crew_members (va_slug,name,hours) values ('amv','A Pilot',10);
insert into crew_routes (va_slug,origin,destination,active) values ('amv','MMMX','KJFK',true);
insert into crew_pireps (va_slug,origin,destination,status) values ('amv','MMMX','KJFK','approved');
insert into crew_pireps (va_slug,origin,destination,status) values ('amv','MMMX','KSFO','pending');
insert into crew_events (va_slug,title,status) values ('amv','Published one','published');
insert into crew_events (va_slug,title,status) values ('amv','Secret draft','draft');
insert into crew_event_signups (va_slug,event_id,pilot_name,gate)
    select 'amv',id,'On the published one','B24' from crew_events where title='Published one';
insert into crew_event_signups (va_slug,event_id,pilot_name,gate)
    select 'amv',id,'Penciled into the draft','C1' from crew_events where title='Secret draft';
insert into crew_accounts (va_slug,username,password_hash) values ('amv','jo','$2b$notarealhash');
insert into crew_applications (va_slug,ifc_name,email,invite_password) values ('amv','Someone','a@b.c','TEMPORARY');
insert into crew_announcements (va_slug,title,body) values ('amv','July schedule','New rotations.');
-- v8. A published departure and a draft one, each with somebody on it. The
-- draft's booking is the leak being checked for: it would give away both the
-- draft's existence and who staff had pencilled in.
insert into crew_schedules (va_slug,origin,destination,seats,status)
    values ('amv','EGLL','KJFK',2,'published');
insert into crew_schedules (va_slug,origin,destination,seats,status)
    values ('amv','EGLL','LFPG',1,'draft');
insert into crew_bookings (va_slug,schedule_id,pilot_name,seat)
    select 'amv',id,'On the published one',1 from crew_schedules where destination='KJFK';
insert into crew_bookings (va_slug,schedule_id,pilot_name,seat)
    select 'amv',id,'Pencilled into the draft',1 from crew_schedules where destination='LFPG';
SQL

asanon() { $PSQL -d fresh -tAc "set role anon; $1" 2>/dev/null; }

# Deliberately NOT `psql … | grep -q`. `set -o pipefail` (top of this file) makes
# a pipeline report the failure of ANY stage, and psql exits non-zero on the very
# error being looked for — so the pipeline came back non-zero even when grep had
# matched, and a correctly refused query reported as allowed. Capturing first and
# matching the string keeps the two questions apart.
saidno() {
    local out
    out="$($PSQL -d fresh -tAc "set role anon; $1" 2>&1)"
    case "$out" in *[Pp]"ermission denied"*|*violates*) echo yes ;; *) echo no ;; esac
}

is "the roster is public"                 "$(asanon 'select count(*) from crew_members')" "1"
is "the active network is public"         "$(asanon 'select count(*) from crew_routes')" "1"
is "the noticeboard is public"            "$(asanon 'select count(*) from crew_announcements')" "1"
is "only APPROVED flights are public"     "$(asanon 'select count(*) from crew_pireps')" "1"
is "a draft event is invisible"           "$(asanon 'select count(*) from crew_events')" "1"
is "…and so is who was penciled into it"  "$(asanon 'select count(*) from crew_event_signups')" "1"
is "a draft departure is invisible"          "$(asanon 'select count(*) from crew_schedules')" "1"
is "…and so is who was pencilled onto it"   "$(asanon 'select count(*) from crew_bookings')" "1"
is "pilot logins are refused at the door" "$(saidno 'select 1 from crew_accounts')" "yes"
is "so are applications (emails, invites)" "$(saidno 'select 1 from crew_applications')" "yes"
is "anon cannot write, even to a public table" \
   "$(saidno "insert into crew_members (va_slug,name) values ('amv','Intruder')")" "yes"
# The claim the whole booking design rests on: the seat is arbitrated by the
# database, not by a count taken in the backend before the insert. Checked as
# the owner, because this is not a permission boundary — it is the unique index.
sold_twice() {
    local out
    out="$($PSQL -d fresh -tAc "insert into crew_bookings (va_slug,schedule_id,pilot_name,seat) select 'amv',id,'Second claimant',1 from crew_schedules where destination='KJFK'" 2>&1)"
    case "$out" in *"duplicate key"*|*violates*) echo refused ;; *) echo allowed ;; esac
}
is "one seat cannot be sold twice" "$(sold_twice)" "refused"

is "crew_stats is callable by anon (it is what a VA's homepage shows)" \
   "$(asanon "select (crew_stats('amv')->>'pilots')")" "1"

# ---------------------------------------------------------------------------
echo "• the storage report (v9)"
#
# It reads Postgres' own size catalogues and another schema's tables, so it is
# definer — which makes "who may call it" the thing to check, not just "does it
# answer". The backend calls it with the service key; a browser key must not be
# able to, and the numbers it returns have to be real ones rather than zeroes.
# ---------------------------------------------------------------------------
usage() { $PSQL -d fresh -tAc "select (crew_storage_usage('amv')->>'$1')"; }

is "it counts this crew center's rows separately from the project's" \
   "$($PSQL -d fresh -tAc "select (t->>'vaRows') from jsonb_array_elements(crew_storage_usage('amv')->'tables') t where t->>'table'='crew_members'")" \
   "1"
[ "$(usage databaseBytes)" -gt 0 ] 2>/dev/null \
    && ok "it reports a real database size" || bad "it reports a real database size" "got '$(usage databaseBytes)'"
[ "$(usage crewBytes)" -gt 0 ] 2>/dev/null \
    && ok "…and what the crew tables cost inside it" || bad "…and what the crew tables cost inside it"
# Supabase Storage lives in another schema that a bare cluster has not got. The
# function has to survive that rather than failing the whole call — a VA whose
# project locks it down still gets their database size.
is "a project without Supabase Storage still reports" "$(usage storageFiles)" "0"
# Called without a slug (the shape a shared project's operator would use), the
# per-VA column is absent rather than wrong.
is "no slug means no per-VA claim" \
   "$($PSQL -d fresh -tAc "select coalesce((t->>'vaRows'),'null') from jsonb_array_elements(crew_storage_usage()->'tables') t where t->>'table'='crew_members'")" \
   "null"
is "a browser key cannot call it" "$(saidno "select crew_storage_usage('amv')")" "yes"

echo
if [ "$fail" -gt 0 ]; then echo "$fail check(s) failed"; exit 1; fi
echo "Schema applies, upgrades and holds its boundaries ✅"

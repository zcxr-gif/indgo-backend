# Inflight VA Advertisement Program — Staff & Admin Manual

**Audience:** Inflight VA Admin and moderation staff
**Purpose:** A single reference your VA Admin can use to recruit, vet, accept,
edit, suspend, and remove virtual airlines (VAs) and virtual organisations (VOs)
**on their own authority**, without escalating every decision.
**Governing documents:** This manual operationalises the *Inflight VA
Advertisement Program — Terms & Conditions* ("the Terms"). Where this manual and
the Terms disagree, the Terms win. The full Terms ship as a PDF
(**[VA-Advertisement-Terms.pdf](/VA-Advertisement-Terms.pdf)**) and are attached
automatically to every **VA Partnership** ticket the bot opens (Section 8C).
**Contact of record:** inflightcustomer@gmail.com

> **One-line policy:** We list **IFVARB-approved** Infinite Flight VAs/VOs, plus
> a small set of explicitly defined exceptions (Section 3). Everything else is
> declined. Quality and accuracy over quantity, always.

---

## 1. The Admin's Authority (read this first)

Per Section 9 of the Terms, **Inflight staff have full authority to accept or
reject any material** submitted to the Program, and may *review, edit, approve,
decline, withhold, archive, feature, or remove* any listing at sole discretion,
without prior notice. Section 13 lets us remove a listing **"for a reason, for
no reason, and without justification."**

What that means for you, the VA Admin, day to day:

- You **do not need sign-off** to approve, reject, edit, feature, suspend, or
  delete a listing that falls inside the rules in this manual.
- **Escalate to the owner (inflightcustomer@gmail.com) only** for the situations
  in Section 11 ("When to escalate").
- "Being invited or listed does not guarantee continued or permanent
  placement." A VA being live today is not a promise it stays live. Re-vetting
  on inactivity or breach is expected, not hostile.
- Use the discretion the Terms give you, but **apply it consistently** — the
  decision log (Section 10) is how we stay fair and defensible.

---

## 2. Eligibility — the hard gates (Terms §3)

A listing can only exist if **all** of these are true. If any fails, decline.

- [ ] It is a **genuine, active** Infinite Flight community group (VA or VO).
- [ ] The person submitting/accepting is the **CEO, owner, or an authorised
      representative** of that VA.
- [ ] They **own or have permission** to use every image, logo, and banner
      provided (see Section 6, Copyright).
- [ ] The VA is **IFVARB-approved**, OR qualifies under a documented exception
      in Section 3.

**"Active" — concrete test.** Don't guess; apply these thresholds. A VA is
**active** if it meets **at least two** of the following, with **no hard
disqualifier** present:

*Active signals (need ≥ 2):*
- **Discord:** public messages in the **last 30 days** and a **working** invite.
- **Events/operations:** at least **one event or organised flight in the last 60
  days** (Inflight-tracked, per Terms §4).
- **IFC thread:** an official thread updated/posted in within the **last 90 days**.
- **Pilots:** a plausible, non-zero active roster (not a number pulled from thin
  air).
- **Links:** website and application/join link both **resolve and work**.

*Hard disqualifiers (any one → treat as inactive, regardless of the above):*
- Discord invite **dead/expired** or server **empty/abandoned**.
- **No event or operation in the last 90 days.**
- Primary application/join link **broken** with no working alternative.

Borderline (exactly the minimum, or recently relaunched)? List as **Draft
(pending)**, give them a courtesy note, and re-check in ~2 weeks before going
Live.

---

## 3. The IFVARB Rule & Approved Exceptions

### 3.1 Default: IFVARB-approved only

The **Infinite Flight Virtual Airline Regulatory Board (IFVARB)** vets VAs for
the Infinite Flight community. By default we **only list VAs that hold a current
IFVARB approval.** This is our baseline quality filter and it does most of the
vetting work for us.

**How to verify:**
1. Ask the applicant for their IFVARB approval (approval post / IFC thread /
   board listing) and the VA name exactly as approved.
2. Confirm the approval is **current** (not withdrawn/expired) and the **name and
   callsign match** what they're submitting to us.
3. Record the verification in the decision log (Section 10).

If you cannot verify it, treat the VA as **not approved** and fall to 3.2.

### 3.2 Minor exceptions (the only ones)

You may list a **non-IFVARB** group **only** if it clearly fits one of these and
you log which exception was used:

| # | Exception | What still must be true |
|---|-----------|--------------------------|
| E1 | **Virtual Organisations (VOs)** that fall outside IFVARB's VA remit (e.g. event groups, training orgs, ATC/comms groups). | Genuine, active, established community presence; meets all Content & Eligibility standards. |
| E2 | **Established legacy VAs** with a long, demonstrable track record that predate or sit outside IFVARB but are well-known and in good standing in the community. | Strong public reputation, active operations, clean content. Treat as rare. |
| E3 | **IFVARB application in progress** — a credible VA that has submitted to IFVARB and is awaiting a decision. | List as a **Draft (pending)** only — do **not** go Live until IFVARB approves. If IFVARB declines, the listing is rejected/archived. |
| E4 | **Owner-directed special cases** — a specific VA the Inflight owner has explicitly asked you to list. | Must be confirmed by the owner in writing; log the instruction. |

**Anything that is not IFVARB-approved and not E1–E4 → decline.** Do not invent
new exceptions. If you think a fifth exception is warranted, escalate
(Section 11) — do not self-authorise it.

> Exceptions are *minor* by design. If you find yourself using them more than
> occasionally, the bar has slipped — tighten back up.

---

## 4. Content Standards (Terms §5) — the editorial bar

Every listing you approve or keep live must meet all of these. You are
authorised to **edit a listing into compliance** rather than reject it outright,
when the issue is cosmetic (typo, casing, oversized banner). Reject when the
problem is substantive (ineligible, infringing, misleading).

**Accuracy**
- Information must be **accurate and reasonably up to date** (pilot count, hubs,
  fleet, recruiting status, links all plausible and current).
- Callsign must match how the VA actually flies in Infinite Flight.

**Imagery & text**
- Banner, logo, and text must **not** be offensive, misleading, illegal, or
  infringing.
- No real-world airline trademarks/logos the VA has no right to use (this is the
  #1 takedown risk — see Section 6).
- Banner reads cleanly at directory size; logo is a clean square/roundel.

**Links**
- The VA is **responsible for its own external links** (website, Discord,
  application, IFC thread). You are not, but a **broken or dead** primary link is
  an accuracy failure — fix or flag it.
- Every link should resolve and be safe (no logins, no malware, no off-topic
  redirects). A dead Discord invite is a common reason to mark a VA stale.

---

## 5. Field-by-Field Reference (the Add/Edit form)

This maps every field in the **VA Ads Manager** (`/va-ads`) to what you should
expect and enforce. Backed by the data model in `server.js`
(`VirtualAirlineAdSchema`) and the form in `va-ads.html`.

| Field | Required? | Standard to enforce |
|-------|-----------|---------------------|
| **VA Name** | **Yes** | Exact, unique. Duplicates are rejected by the system (HTTP 409). Must match IFVARB approval. |
| **Callsign** | No (strongly preferred) | Enter the **base only** (e.g. `OCEAN`). The system stores the base and displays it as `OCEAN ##VA`; pilots substitute their pilot number. Don't type the `##VA` suffix — it's stripped/added automatically. |
| **Type** | Yes | `VA` (virtual airline) or `VO` (virtual organisation). Drives the IFVARB-vs-exception path in Section 3. |
| **Tagline** | No | One-line hook, **max 140 chars**. No clickbait, no false claims. |
| **Description** | No | Up to 4000 chars. Accurate, on-brand, no infringing copy. |
| **Banner** | No (recommended) | Wide marketing image (stored ~1600×600 WebP). Must be theirs to use. |
| **Logo** | No (recommended) | Square logo/roundel (stored ≤512×512 WebP). This is what pins to the map hub marker and shows on the callsign badge. |
| **Region** | No | Defaults to `Global`. Use real regions (Asia, Europe, …) when known. |
| **Hubs** | No | Comma-separated **ICAO** codes (e.g. `VABB, VIDP`). Auto-uppercased. These drive the **airport banner** and **VA hub map markers** — accuracy matters because wrong ICAOs pin the logo to the wrong airport. |
| **Fleet** | No | Comma-separated aircraft types (e.g. `A320, B777`). |
| **Pilots** | No | Integer ≥ 0. Should be plausible; don't list inflated numbers. |
| **Min Grade** | No | Infinite Flight grade requirement **1–5**, if any. Leave blank if none. |
| **Joining Requirements** | No | Free text. Keep factual. |
| **Website / Discord / IFC Thread / Application** | No | Valid URLs. Test them. The **Application** link is the click-through we count as a conversion. |
| **Owner / Contact Name** | No | Who submitted; defaults to `Unknown`. Capture a real contact — you'll need it for the §8 change/suspension process. |
| **Contact Email** | No | Used **solely** to administer the Program (Terms §10). |
| **Status** | Yes | `approved` (Live) / `pending` (Draft) / `rejected` (Archived). See Section 7. |
| **Recruiting** | Toggle | On = "accepting applications". Off = shown as "Closed". Doesn't hide the listing. |
| **Featured** | Toggle | Pins to top of the directory. See Section 9. |

Fields the **system/bot** sets — not you, normally: `views`, `clicks`,
`discordRoleId`, `discordChannelId`, `createdAt`, `updatedAt`.

---

## 6. Copyright, Trademarks & Takedowns (Terms §6, §12)

This is where the real legal risk lives. The VA warrants it owns/has rights to
its branding; **we** are the one who gets the takedown request.

- The VA is **solely responsible** for holding rights to any branding, logos, or
  imagery in its listing (Terms §6). Don't accept a listing built on an obvious
  real-world airline's trademark unless the VA can show permission.
- If a **company or rights holder contacts us** asking to remove an infringing
  listing → **take it down promptly**, then notify the VA. Do not argue the
  merits with the rights holder; comply and log it (Section 10). Escalate to the
  owner in parallel (Section 11).
- IP ownership stays with the VA; by submitting, they grant us a non-exclusive,
  royalty-free licence to display it (Terms §12). On removal/termination, **their
  images come out of the public directory** — deleting the ad in the manager also
  deletes its banner + logo from storage.

---

## 7. The Listing Lifecycle & Status Field

Statuses (one show/hide switch with three values):

- **Live (approved)** — publicly visible across all surfaces.
- **Draft (pending)** — staged, not public. Use for E3 (IFVARB pending) and for
  anything you're still vetting. **Every `/va_apply` submission lands here
  automatically** until a staff member approves it (Section 8B).
- **Archived (rejected)** — hidden but **not deleted**. Use this to suspend or
  retire a listing while keeping its record and analytics.

**Prefer Archive over Delete.** Delete is irreversible and removes the banner +
logo from storage. Archive when there's any chance the VA returns or you may need
the record. Delete only for spam, duplicates, or a clean permanent exit / valid
takedown.

### 7.1 Required Changes & 7-Day Suspension (Terms §8)

When a **live** listing needs a fix (inaccurate info, borderline content, dead
links):

1. **Contact the VA's CEO / authorised rep** (use the stored contact) describing
   the required change. **Start the clock** — log the date.
2. If **no action within 7 days** of that contact → set status to **Archived
   (rejected)** to suspend it. It stays suspended **until the required action is
   completed**, then flip back to Live.
3. Log every step (Section 10).

### 7.2 Inactivity & event-tracking breaches (Terms §4, §9)

- **Event & Tracker Requirement:** if a VA announces or runs an event, it **must
  be tracked using Inflight**, *every* event regardless of size, and any
  announcement (Discord, IFC, anywhere) **must include a picture showing the
  event in our tracker**. Running or publicising an event **without** using
  Inflight is grounds to **suspend or remove** the listing at your discretion.
- **Inactivity:** a VA that **fails the "active" test in Section 2** (hits a hard
  disqualifier, or drops below two active signals) may be archived. Courtesy-
  contact first where practical, start the §8 clock if a fix is possible, then
  archive if it stays dark.

---

## 8. Day-to-Day Workflows (the tool: `/va-ads`)

The **VA Ads Manager** at `yoursite.com/va-ads` is your console. Search/filter by
status, type, and sort; each card has **Edit**, **Feature** (star), and **Delete**.

### 8.0 VA Application / Intake Template

Send this to any VA before you create a listing **or** before you click **Approve
& Create** on a `/va_apply` submission (Section 8B) — the Discord form only
captures the basics, so you still need this proof either way. It collects
everything the manager form needs (Section 5) and the proof you need to vet under
Sections 2–3. Copy-paste it into Discord/email; don't approve or create a Live
listing until the **required** items are answered and verified.

```
INFLIGHT VA ADVERTISEMENT — APPLICATION

— Eligibility & verification (required) —
1. VA / VO name (exactly as approved):
2. Are you the CEO, owner, or an authorised representative?  (yes/no + your role)
3. IFVARB approval — link to the approval post/thread:
   • If not IFVARB-approved: which applies?  (a) VO outside IFVARB's remit
     (b) established legacy VA  (c) IFVARB application in progress  (d) other
   • If "in progress", link to your submission:
4. Do you own or have permission to use ALL logos/banners/images you're sending?
   (yes/no)

— Identity (required: name; preferred: callsign, type) —
5. Type:  VA  /  VO
6. Base callsign (base word only — we add "##VA" automatically, e.g. OCEAN):
7. Region (e.g. Asia / Europe / Global):

— Copy —
8. Tagline (one line, max 140 chars):
9. Short description:

— Operations (for the "active" test, Section 2) —
10. Primary hub ICAO code(s), comma-separated (e.g. VABB, VIDP):
11. Fleet / aircraft types (comma-separated):
12. Approx. active pilot count:
13. Minimum Infinite Flight grade to join (1–5, or "none"):
14. Joining requirements (free text):
15. Date of your most recent event/operation, and was it tracked on Inflight?
    (Terms §4 — every event must be tracked on Inflight)

— Links (test each before submitting) —
16. Website:
17. Discord invite (must be live/non-expiring):
18. IFC thread:
19. Application / join link:

— Contact —
20. Owner / contact name:
21. Contact email:

— Assets —
22. Attach: square LOGO (≈512px) and wide BANNER (≈1600×600). Must be yours to use.

By submitting, you agree to the Inflight VA Advertisement Program Terms &
Conditions, including the event-tracking requirement and our right to edit,
suspend, or remove listings at our discretion.
```

**Admin vetting pass after intake:** confirm Q2 (authorised), Q3 (IFVARB or a
valid exception), Q4 (image rights), the **active** test from Section 2, and that
links Q16–Q19 all resolve. Then create the listing per Section 8.1, logging the
decision (Section 10).

### 8.1 Accept a new VA (decision flow)

```
New submission / invitation
        │
        ├─ Eligible? (genuine, active, authorised rep, owns imagery)  ──No──▶ DECLINE (log reason)
        │   yes
        ├─ IFVARB-approved & verified?  ──No──▶ Fits exception E1–E4?  ──No──▶ DECLINE (log)
        │   yes                                   yes (E3 only → keep as Draft)
        ├─ Content standards pass? (imagery, links, trademarks)  ──No──▶ Edit to fix OR DECLINE
        │   yes
        └─ APPROVE → create listing, set Status, test all links, log decision
```

This same flow applies whether the VA reaches you via the **web manager** or a
**Discord `/va_apply`** submission (Section 8B) — only the buttons differ. A bot
application lands as **pending** with a review card (Approve & Create / Request
Edits / Reject); a web listing you author directly.

**To create (web):** click **Add VA** → fill fields per Section 5 → upload banner +
logo → set **Status** (Live for verified IFVARB; Draft for E3/pending vetting) →
Save. Names must be unique (the system blocks duplicates).

**To accept (bot):** vet with the intake template first, then click **Approve &
Create** — this also provisions the VA's Discord role + channel (Section 8B.2).

### 8.2 Edit a listing
Click **Edit** on the card. Only the fields you change are updated; uploading a
new banner/logo replaces and deletes the old image. Use edits to bring borderline
listings into compliance instead of rejecting good-faith VAs.

### 8.3 Suspend / archive
Edit → set **Status = Archived (rejected)** → Save. Use for the §8 7-day rule,
inactivity, or event-tracking breaches. Reversible.

### 8.4 Delete
**Delete** button → confirm. Irreversible; removes banner + logo from storage.
Spam / duplicates / valid takedown / permanent clean exit only.

### 8.5 Recruiting toggle
Flip **Recruiting** off when a VA says applications are closed — keeps the listing
visible but honestly labelled "Closed".

---

## 8B. The Discord Bot Workflow (the other front door)

Listings reach the directory **two ways**. Section 8 covered the web manager,
where you author a listing directly (defaults to **Live**). The other path is the
**Discord bot**, where VA owners self-apply and you approve from a review channel.
Both write to the same `VirtualAirlineAd` records — a VA created on one shows up
on the other. **Know both, because each does something the other doesn't.**

> **A guided front door, too:** new VAs can also reach the bot's `/va_apply`
> form **without typing a command** by opening a **VA Partnership** ticket, which
> walks them through the Terms first. That flow — plus the **Inflight VA Rep**
> role — is documented in **Section 8C**. It still lands as a `pending`
> application you review exactly as below.

> **The one distinction that matters most:** approving in the **bot** (the
> **Approve & Create** button) both sets the listing Live **and provisions Discord**
> (role + private channel + rep access). Approving in the **web manager** (setting
> Status = Live) **only** changes visibility — it does **not** create any Discord
> space. If a VA needs its Discord role/channel, the approval must go through the
> bot, or be provisioned via the staff commands below.

### 8B.1 How an application arrives (`/va_apply`)
- A VA owner runs **`/va_apply`** and fills a short modal: name, base callsign,
  type (VA/VO), tagline, and website + Discord links.
- The bot creates (or updates) the record as **`pending`** (Draft) — never Live on
  submission — and posts a **review card** to the staff applications channel,
  pinging the admin role.
- A re-application for the same name by the **same owner** updates their existing
  pending row; a name already owned by **someone else** is refused, and an
  already-**approved** name is rejected as a duplicate. (Name uniqueness is
  enforced everywhere.)

### 8B.2 The review card — your three buttons
On each pending application you get:

| Button | What it does | When to use it |
|--------|--------------|----------------|
| **✅ Approve & Create** | Sets status **approved/Live**, **provisions** the VA's Discord role + private channel, grants the owner the **VA role + shared "VA Rep" role**, DMs the owner, and posts a **setup card** in their new channel. | Only after the VA passes Sections 2–3 (active + IFVARB/exception + owns imagery). This is the real "accept". |
| **✏️ Request Edits** | Prompts you for what needs changing; the note is **sent to the applicant**. Leaves status pending. | Borderline/incomplete — missing IFVARB proof, weak imagery rights, broken links. Pairs with the §8 7-day clock. |
| **❌ Reject** | Prompts for a reason (sent to the applicant) and sets status **rejected** (Archived). | Ineligible, not IFVARB and no exception, infringing, or inactive. |

These three buttons are usable by **admins and the Inflight VA Rep** (Section
8C.1); the Discord-teardown slash commands in 8B.5 stay admin-only.

**Vet before you click Approve & Create.** The `/va_apply` modal only captures the
basics — it does **not** collect IFVARB proof or image-rights confirmation. Get
those (use the intake template in Section 8.0) **before** approving, because
approval immediately provisions real Discord space and tells the owner they're
live.

### 8B.3 What provisioning creates (and how it self-heals)
On **Approve & Create**, the bot (`provisionVaSpace`) idempotently:
1. Creates a **VA-specific role** (named after the VA) — or reuses the linked one.
2. Ensures the shared **"VA Rep"** role exists and can see the reps chat.
3. Creates a **private VA channel** under the VA category, visible to the VA role
   and admins only; pins an info embed and posts the **setup card**.
4. Grants the **owner** the VA role + the VA Rep role.
5. Saves `discordRoleId` / `discordChannelId` back onto the listing.

Because it's idempotent (reuses anything already linked), re-running approval or a
rep command **repairs** missing wiring rather than duplicating it.

### 8B.4 The owner's setup card (post-approval)
Right after provisioning, the owner sees a card in their channel to fill in
everything the short form missed — **Add Details** (description, region, hubs,
fleet, requirements), **Links & Recruiting** (apply link, IFC thread, min grade,
pilot count, tags), and **Upload Banner / Logo** (sent as an image message, pushed
to S3). Only the **VA's owner or staff** (`canManageVa`) can edit it. The card
lists what's **still missing** — a quick way for you to see if a card is
directory-ready. You can always fill or fix the same fields yourself from the web
manager.

### 8B.5 Staff slash commands (admin-role only)
These manage the Discord side of an already-provisioned VA:

| Command | Effect | Notes |
|---------|--------|-------|
| **`/va_addrep`** `<va> <user>` | Grants the user the VA role **and** the shared VA Rep role → access to the VA channel + reps chat. | Use to add a CEO's authorised reps. The VA must be provisioned first. |
| **`/va_removerep`** `<va> <user>` | Removes the **VA-specific** role only. | Keeps the shared VA Rep role (they may rep other VAs) — strip it manually if they rep none. |
| **`/va_remove`** `<va>` | **Deletes** the VA's Discord **role and channel** and clears the linkage. | This is the **Discord teardown only** — it does **not** delete the directory listing. To pull the *listing*, set Status = Archived (or Delete) in the web manager. |

If a role/command fails, it's almost always permissions: the bot needs **Manage
Roles** + **Manage Channels**, and its own role must sit **above** the VA roles.

### 8B.6 Two-front consistency (don't let the surfaces drift apart)
Because both fronts edit the same record, keep them coherent:
- **Reject/Archive should match teardown.** If you reject or archive a provisioned
  VA for good, also run **`/va_remove`** so a dead listing isn't leaving a live
  role + channel behind (and vice-versa — don't `/va_remove` a VA you intend to
  keep listed).
- **Web "approve" ≠ Discord provision.** If you flip a bot-originated pending VA to
  Live from the web manager, it won't get a role/channel. Either approve it via the
  bot button, or accept that it's directory-only by design.
- **`ownerId`/`ownerName`** are set by the bot from the Discord user. For
  web-created listings, capture a real **Owner/Contact** so the §8 change process
  has someone to reach.
- The **callsign** is stored as the base everywhere (bot and web strip `##VA`); the
  suffix is added only at display time. Enter the base in both places.

---

## 8C. The Inflight VA Rep & VA Partnership Tickets

A third, **guided** intake path sits in front of `/va_apply`: the **VA
Partnership** ticket. It exists so a prospective VA reads and accepts the Terms
**before** anything is provisioned, and so a dedicated **Inflight VA Rep** can
shepherd them through it. Nothing here bypasses your review — a partnership
ticket still ends in a normal `pending` `/va_apply` application (Section 8B).

### 8C.1 The "Inflight VA Rep" role — two hats

The name covers **two distinct roles** that share a purpose (front-line VA
relations):

| Where | What it grants | Scope |
|-------|----------------|-------|
| **Discord role** (`Inflight VA Rep`, ID `1518665927254605925`) | Auto-added to **every provisioned VA channel** (and self-heals onto older channels on the next approval/rep command), is **pinged + pulled into** every VA Partnership ticket, and **may review `/va_apply` applications** — the **Approve & Create / Request Edits / Reject** buttons (Section 8B.2). The bot self-heals their view access to the applications channel and pings them on each new application. | Lets the rep run the full review/approval flow and answer questions in all VA channels + partnership tickets. Does **not** grant **teardown** powers — staff slash commands (`/va_addrep`, `/va_removerep`, `/va_remove`, Section 8B.5) remain admin-role only. |
| **Staff-portal role** (`va_rep`) | A scoped login to the web Staff Hub. | Sees **only** the **VA Ads Manager** (`/va-ads`) and **this manual** (`/va-admin-manual`). The Aircraft Database, Airport Manager, Embed Manager, and staff-account admin are hidden and blocked. Create it from the Staff Hub's **Add staff** dialog (role = *Inflight VA Rep*), or cycle an existing account's role from the staff table. |

Use the staff-portal `va_rep` role when you want someone managing VA listings
and reading this manual **without** handing them the rest of the database.

### 8C.2 The VA Partnership ticket flow

From the **🎫 Inflight Support** ticket panel (`/setup_tickets`), a user picks
**🤝 VA Partnership**. The bot then:

1. Opens a **private partnership ticket** (thread) and adds the user.
2. **Pings the Inflight VA Rep** and pulls the rep(s) into the ticket so they can
   help in real time.
3. **Drops the Terms** — the full **[VA-Advertisement-Terms.pdf](/VA-Advertisement-Terms.pdf)**
   is attached, with a summary card telling the user to read it and to ask the
   Inflight VA Rep **here in the ticket** if they have questions.
4. Shows an **✅ I Accept** button.

When the user clicks **I Accept**:

- The acceptance is **saved to the database** (`VaTermsAcceptance` — Discord user
  ID, username, terms version, ticket channel, timestamp). This is our **proof of
  agreement** to the Terms, recorded before any listing exists.
- The ToS card locks (it can't be re-accepted), and a follow-up card appears with
  a **🛫 Start VA Application** button.
- **Start VA Application** opens the same `/va_apply` form (Section 8B.1) — so the
  user never has to type the command. From there it's the **normal pending review
  flow**: it posts a review card to the staff applications channel for you to
  **Approve & Create / Request Edits / Reject**.

> **Your job is unchanged.** Acceptance of the Terms is **not** approval. A
> partnership ticket only guarantees the user has seen and agreed to the Terms —
> you still vet IFVARB/exception status, image rights, and the "active" test
> (Sections 2–3) before clicking **Approve & Create**.

### 8C.3 Subscription (Inflight Pro) tickets

The same ticket panel offers **💳 Subscription Issue (Inflight Pro)** for users
with problems on our **Inflight Pro** subscription. These open a standard support
ticket (description modal → private thread pinging the admin role) — they are
**not** part of the VA flow and don't touch the directory. Triage them like any
other support ticket; loop in the relevant owner/admin for billing.

### 8C.4 `/va_help` — the AI assistant

Not sure how to handle something? Run **`/va_help question:<your question>`** in
Discord. It answers **from this manual and the Terms** — vetting, the Add/Replace
slot rules, the 7-day suspension clock, partnership flow, Discord provisioning,
the IFVARB exceptions, etc. — cites the relevant section/clause, and tells you to
escalate (inflightcustomer@gmail.com) when something isn't covered rather than
guessing. Usable by **admins and the Inflight VA Rep**; replies are private
(ephemeral).

It's a **convenience, not an authority**: answers are AI-generated from the docs
and flagged "verify before acting." When the assistant and this manual (or the
Terms) disagree, the documents win. Requires `ANTHROPIC_API_KEY` to be set; if it
isn't, the command politely says it's unavailable.

---

## 9. Featuring (promotion)

**Featured** pins a listing to the top of the directory (and is sorted first).
Treat it as scarce and editorial — it is advertising weight we hand out.

Reasonable reasons to feature: a strong, fully-complete, IFVARB-approved listing;
a launch we want to spotlight; a high-quality VA running an Inflight-tracked
event. Rotate it; don't let the same VA sit featured forever. Featuring is never
*owed* — placements are "subject to our approval and are not guaranteed"
(Terms §2) and being listed never guarantees featuring.

---

## 10. The Decision Log (do this every time)

Consistency is what makes "sole discretion" fair instead of arbitrary. For every
accept / decline / edit-for-compliance / suspend / delete / takedown, record:

- **Date** and **your name**
- **VA name** and listing ID
- **Action** taken and **status** before/after
- **Reason** in one line (e.g. "IFVARB verified, approved" / "Exception E1, VO
  training org" / "Suspended §8 — dead Discord, contacted 06-21, no reply by
  06-28" / "Takedown: rights holder request")
- **IFVARB approval reference** (link/thread) or which **exception** was used
- For contact-clock items: **date of first contact** and the **7-day deadline**
- For bot actions: note the **front door** (web vs `/va_apply`) and whether Discord
  was **provisioned** (Approve & Create) or **torn down** (`/va_remove`)

Keep it wherever the team already works (staff Discord channel, shared doc, or a
pinned thread). The point is a paper trail you can stand behind.

---

## 11. When to Escalate (don't self-authorise these)

Handle everything else yourself. **Escalate to the owner
(inflightcustomer@gmail.com)** only for:

1. **Legal / takedown** requests from a company or rights holder (comply first,
   then escalate in parallel — Section 6).
2. A **new exception** you think is justified but that isn't E1–E4. Don't invent
   exceptions on your own.
3. **Owner-directed special cases** (E4) — confirm the instruction in writing.
4. Anything touching **money, paid/business partnerships, or platform features**
   beyond listing management. (Routine **VA partnership onboarding** via tickets
   is normal §8C work — this means commercial deals, not a VA joining the
   directory.)
5. A **dispute** with a VA that escalates beyond a routine decline/suspension
   (threats, public callouts, harassment).

Note for the iOS app (Terms §7): VA listings are **not** shown in the iOS app for
copyright-compliance reasons. That's expected — don't "fix" a missing listing on
iOS; it's by design and doesn't affect web placement.

---

## 12. Where a Listing Actually Appears (so you know what you're approving)

Approving a VA isn't just adding a row — it lights up several surfaces. Knowing
this tells you which fields matter most. (Source: `vaAds.js` /
`window.InflightVaAds`, rendered by `flight.js`.)

1. **Callsign badge** — a live flight whose callsign matches the VA shows that
   VA's **logo badge** on the hover card and flight info window.
   → *So the **callsign** and **logo** must be correct.*
2. **Airport banner** — when a user opens an airport, VAs **hubbed there** are
   surfaced. → *So **hubs** (ICAO) must be accurate.*
3. **Partner directory** — the slide-over (toolbar button + "Browse VA Partners"
   in Settings) lists every partner with website + Discord links.
   → *So **website** and **Discord** must work.*
4. **VA hub markers on the map** *(opt-in, off by default)* — the VA's **logo** is
   pinned to each **hub airport** on the live map; tapping it opens that VA in the
   directory. Deduped per ICAO. Controlled by `mapFilters.showVaHubMarkers`.
   → *Wrong ICAO = logo pinned at the wrong airport. Double-check hubs.*

The directory data is loaded once via `loadDirectory()` and cached in `allAds`;
helpers include `matchCallsign()`, `partnersForIcao(icao)`, `allPartners()`, and
`openPartners(id?)`. The toggle for hub markers lives in the **VA** tab of
desktop Global Settings and the **Virtual Airlines** section of the mobile
settings sheet — default **off**, user opts in.

---

## 13. Analytics (Terms §10)

Each listing records basic, **non-personal** engagement metrics — **views**
(detail impressions) and **clicks** (join/apply click-throughs) — shown on the
card in the manager. Use them to judge listing performance and to inform
featuring. Contact details a VA supplies are used **solely** to administer the
Program. We make **no guarantee** of visibility, traffic, or recruitment
(Terms §11) — never promise a VA results.

---

## 14. Quick Reference Card

**List it only if:** genuine + **active** (≥2 signals, no hard disqualifier — §2)
+ authorised rep + owns imagery + **IFVARB approved** (or exception **E1–E4**) +
content standards pass.

**Decline if:** not IFVARB and not E1–E4 · inactive/fake · infringing branding ·
misleading/offensive content · unauthorised submitter.

**Status:** Live = public · Draft = staged/E3-pending (and every `/va_apply` lands
here) · Archived = suspended (not deleted). **Prefer Archive over Delete.**

**Two front doors:** web manager (you author, defaults Live) **and** Discord
`/va_apply` (owner applies → pending → you **Approve & Create**). A **🤝 VA
Partnership** ticket is a guided third entry (Terms PDF → **I Accept** recorded in
the DB → **Start VA Application**) that funnels into the same `/va_apply` pending
review (§8C). Only the bot's Approve **provisions Discord** (role + channel + rep
access); web "Live" does not. `/va_remove` tears down the Discord space but
**not** the listing — archive/delete that separately.

**Inflight VA Rep (§8C):** Discord role `1518665927254605925` is auto-added to
every VA channel + pinged into partnership tickets; the `va_rep` **staff-portal**
role logs in to **VA Ads + this manual only**. Terms acceptance is logged
(`VaTermsAcceptance`) but is **not** approval — still vet before Approve & Create.

**The clock (§8):** required change → contact CEO/rep → **7 days** → no action →
Archive until fixed.

**Events (§4):** every event must be tracked on Inflight + announcements need a
tracker screenshot. No tracker = grounds to suspend/remove.

**Escalate only:** takedowns · new exceptions · owner special cases · money/
features · serious disputes. Everything else is yours to decide.

**Log everything:** date · who · VA · action · reason · IFVARB ref / exception.

---

*This manual implements the Inflight VA Advertisement Program Terms & Conditions.
The Terms control where they conflict. Questions:
inflightcustomer@gmail.com.*

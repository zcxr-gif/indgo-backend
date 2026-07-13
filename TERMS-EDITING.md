# How to Update the VA Terms & Conditions

The Terms live in **one place** as plain text — you never edit the PDF itself.
The same source drives the public **/terms** page, the **VA Portal** compliance
tab, the **Discord ToS card**, and the downloadable
**VA-Advertisement-Terms.pdf** (rebuilt automatically on every deploy).

## The two files that matter

| File | What you edit there |
|------|---------------------|
| `vaTermsContent.js` | The full contract text — intro + numbered clauses. |
| `vaTos.js` | The version number, effective date, short summary bullets, and changelog. |

## Step-by-step

1. **Edit the contract text** in `vaTermsContent.js`.
   Each clause looks like this — a heading plus paragraph (`p`) and/or bullet
   list (`list`) blocks, in the order they should appear:

   ```js
   {
       heading: '5. Event & Tracker Requirement',
       blocks: [
           { p: 'A paragraph of normal text.' },
           { list: [
               'First bullet point.',
               'Second bullet point.',
           ] },
       ],
   },
   ```

   Add, remove, or reword clauses freely. Renumber the headings by hand if you
   insert or delete one.

2. **Bump the version** in `vaTos.js`:
   - `TOS_VERSION` — e.g. `'v3'` → `'v4'`.
   - `TOS_EFFECTIVE_DATE` — today's date, `'YYYY-MM-DD'`.
   - Add a new entry at the **top** of `TOS_CHANGELOG` describing what changed
     (these notes are shown on the Terms page, in the portal banner, and inside
     the Discord notice).
   - If the change affects the short summary, update `TOS_SUMMARY` too.

   > Bumping the version is what makes every partner get re-prompted to
   > acknowledge the new Terms in their portal. If you skip it, nobody is asked
   > to re-accept and the PDF keeps the old version stamp.

3. **(Optional) Preview the PDF locally:**

   ```
   npm install        # first time only — pdfkit is a dev dependency
   npm run build:terms
   ```

   This regenerates `VA-Advertisement-Terms.pdf` in the repo root; open it and
   check the layout. Committing the regenerated PDF is nice for the repo but
   **not required** — the deploy rebuilds it either way (see below).

4. **Commit and deploy.** The `build` script in `package.json` runs
   `scripts/build-va-terms-pdf.js` during every Heroku build, so the served PDF
   is always regenerated from the current text. The /terms page, portal, and
   Discord card read the same source at runtime — no rebuild needed for them.

5. **Notify the partners.** After the deploy, press **“Notify VAs: ToS
   updated”** in the VA Ads Manager (or “Announce update” in the VA Portal
   console). Every VA gets an embed in their own Discord channel with the
   version, effective date, and your changelog notes — and their portal will
   already be asking them to acknowledge the new version.

## Where each piece shows up

- **`CLAUSES` / `INTRO`** (`vaTermsContent.js`) → the /terms page and the PDF.
- **`TOS_SUMMARY`** (`vaTos.js`) → the bullet summary on /terms, the portal,
  and the Discord partnership/ToS card.
- **`TOS_CHANGELOG`** (`vaTos.js`) → the “what changed” list on /terms, the
  portal banner, and the “What changed” field of the Discord notice.
- **`TOS_VERSION` / `TOS_EFFECTIVE_DATE`** → stamped on all of the above plus
  the PDF header/footer, and compared against each partner's last acknowledged
  version to decide who gets re-prompted.

/* =========================================================================
 * Give approved VAs the Crew Center handle they should have got on approval.
 *
 * Usage:  node scripts/backfill-crew-slugs.js          # dry run, changes nothing
 *         node scripts/backfill-crew-slugs.js --apply  # write the handles
 *
 * Why this exists
 * ---------------
 * A VA's crew center address is derived by a pre-save hook on the model. The
 * approve action (PATCH /api/va-ads/:id/status) used to update the status with
 * findByIdAndUpdate, which bypasses that hook — so a VA approved through it went
 * live with slug:null and had no working inflight.info/crew/<slug> at all. The
 * endpoint now saves through the model, but VAs approved before that fix are
 * still sitting without a handle; this backfills them.
 *
 * Handles are derived with the same vaSlug.js rules the model uses, so a VA gets
 * exactly the address it would have got had approval worked, and collisions fall
 * back to -2, -3, … against handles already in the collection (including ones
 * assigned earlier in this same run).
 *
 * Only ever fills a MISSING handle. A VA that already has one is never touched,
 * because its address is a live URL its members have bookmarked.
 *
 * Requires MONGO_URI (the same one the server uses).
 * ========================================================================= */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { deriveUniqueVaSlug } = require('../vaSlug');

const APPLY = process.argv.includes('--apply');

// A loose model bound to the real collection: this script must not re-validate
// or re-save whole VA documents, it only ever sets one field.
const VaAd = mongoose.model(
    'VaAdSlugBackfill',
    new mongoose.Schema({}, { strict: false, collection: 'virtualairlineads' })
);

const MISSING = { $or: [{ slug: null }, { slug: '' }, { slug: { $exists: false } }] };

async function main() {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set — point it at the same database the server uses.');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log(APPLY ? 'Applying handles.\n' : 'DRY RUN — nothing will be written. Re-run with --apply.\n');

    const targets = await VaAd.find({ status: 'approved', ...MISSING })
        .select('_id name callsign slug').sort({ name: 1 }).lean();

    if (!targets.length) {
        console.log('Every approved VA already has a crew center handle. Nothing to do.');
        return;
    }

    // Handles assigned during this run are not in the collection yet in dry-run
    // mode, so track them here too — otherwise two similarly-named VAs would
    // both be reported as taking the same address.
    const claimed = new Set();
    const isTaken = async (s) =>
        claimed.has(s) || !!(await VaAd.exists({ slug: s }));

    let filled = 0, skipped = 0;
    for (const va of targets) {
        const slug = await deriveUniqueVaSlug('', va.name, isTaken);
        if (!slug) {
            // No name we can turn into a URL. The callsign fallback in
            // lookupCrewVa still reaches this VA, so it is not stranded.
            console.log(`  skip  ${va.name || '(unnamed)'} — no usable handle from the name`);
            skipped++;
            continue;
        }
        claimed.add(slug);
        if (APPLY) await VaAd.updateOne({ _id: va._id }, { $set: { slug } });
        console.log(`  ${APPLY ? 'set ' : 'would set'}  ${va.name}  ->  /crew/${slug}`);
        filled++;
    }

    console.log(`\n${APPLY ? 'Filled' : 'Would fill'} ${filled} handle(s)${skipped ? `, skipped ${skipped}` : ''}.`);
    if (!APPLY) console.log('Re-run with --apply to write them.');
}

main()
    .catch((err) => { console.error('Backfill failed:', err); process.exitCode = 1; })
    .finally(() => mongoose.connection.close());

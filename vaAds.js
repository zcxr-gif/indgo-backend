// vaAds.js
// S3 image helpers for the Virtual Airline Advertisement system.
//
// Mirrors the structure of airports.js: image processing + upload live here so
// the route handlers in server.js stay lean. A VA ad has two distinct images:
//   - banner : wide marketing banner shown on the directory card / detail page.
//   - logo   : square airline logo / roundel.
// Both are normalized to WebP for storage efficiency, exactly like the rest of
// the project's media pipeline.

const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const fs = require('fs');
const { uploadOpts, isPixelLimitError, PIXEL_LIMIT_MESSAGE } = require('./imageLimits');

// Per-kind sizing. Banners keep their aspect ratio but are capped so we never
// store a 4K upload; logos are fit inside a square box without enlarging.
const IMAGE_PROFILES = {
    banner: { width: 1600, height: 600, fit: 'inside' },
    logo:   { width: 512,  height: 512, fit: 'inside' },
    // Event banners are the hero image on an event card. A wide 16:9-ish cap
    // keeps them crisp on a big card without ever storing a full-res upload.
    event:  { width: 1600, height: 900, fit: 'inside' }
};

// Animated banners/logos are re-encoded as animated WebP, keeping EVERY frame
// and the full loop. Encoding cost is dominated by decoding + resizing every
// frame, so the frame COUNT (not just resolution) drives how long the request
// takes — a tight dimension cap keeps both the output small AND the encode fast
// enough to finish inside the HTTP timeout.
const ANIMATED_PROFILES = {
    banner: { width: 720, height: 270, fit: 'inside' },
    logo:   { width: 320, height: 320, fit: 'inside' },
    event:  { width: 720, height: 405, fit: 'inside' }
};

// Hard ceiling on total source pixels to decode for an animated upload
// (frames × width × height). Above this the synchronous encode would risk
// exceeding the request timeout, so we reject fast with a clear message instead
// of letting the request hang. ~120 MP ≈ a ~4s GIF at 720p, or a longer one at
// lower resolution — comfortably covers normal banner GIFs.
const MAX_ANIMATED_SOURCE_PIXELS = 120 * 1000 * 1000;

// Build a clean, collision-resistant S3 key for a VA image.
const buildKey = (vaRef, kind) => {
    const cleanRef = (vaRef || 'va').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'va';
    return `va-ads/${kind}/${cleanRef}-${Date.now()}-${Math.round(Math.random() * 1e6)}.webp`;
};

/**
 * Optimize a single VA image (banner or logo) and upload it to S3.
 * Accepts both Multer disk files (file.path) and raw buffers (file.buffer),
 * so the same helper works from the web dashboard and from a bot/automation.
 *
 * Animation is preserved: an animated source (GIF or animated WebP) is
 * re-encoded as ANIMATED WebP with every frame resized, so event banners can
 * move. A still image takes the normal single-frame path. Output is always
 * `.webp` at the same key/content-type, so the URL, the public API and the
 * widget's <img> are identical whether or not the banner animates.
 *
 * Returns the public URL.
 */
const uploadVaImage = async (s3Client, file, vaRef, kind = 'banner') => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;

    const inputSource = file.path ? file.path : file.buffer;

    // Probe the source. metadata() only reads the header, so this is cheap and
    // tells us the frame count (pages) and per-frame dimensions up front.
    let meta = {};
    try { meta = await sharp(inputSource, uploadOpts()).metadata(); } catch { meta = {}; }
    const frames = meta.pages || 1;
    const animated = frames > 1;

    // Fast-fail an animation that's too long/large to re-encode inside the
    // request timeout (the encode decodes + resizes EVERY frame). Rejecting here
    // — before the multi-second encode — turns a hung "saving…" into an instant,
    // clear message. Tagged so the route can surface it as a 413.
    if (animated) {
        const sourcePixels = frames * (meta.width || 0) * (meta.height || 0);
        if (sourcePixels > MAX_ANIMATED_SOURCE_PIXELS) {
            const err = new Error(
                'That animated banner is too long or too high-resolution to process. ' +
                'Please use a shorter GIF, or one at a smaller resolution.'
            );
            err.status = 413;
            if (file.path) fs.unlink(file.path, () => {});
            throw err;
        }
    }

    const profile = (animated ? ANIMATED_PROFILES : IMAGE_PROFILES)[kind]
        || (animated ? ANIMATED_PROFILES : IMAGE_PROFILES).banner;

    // Animated path: keep every frame + the loop (full-length animation), but
    // squeeze size hard — lower quality, smart chroma subsampling and a tight
    // dimension cap. effort:4 (not 6) keeps the encode fast; frame decode already
    // dominates, so max effort buys little size but a lot of time.
    // A still upload decodes under the ordinary upload ceiling. The animated
    // path needs its own, because `animated: true` decodes EVERY frame into one
    // tall image — the pixel count that matters is frames x w x h, which is what
    // the fast-fail above measures. The two numbers are deliberately the same:
    // when they differ, the gap between them is reachable by any upload whose
    // metadata() probe failed (frames falls back to 1, so the fast-fail never
    // runs) — which is exactly the malformed input least worth trusting.
    const readOpts = animated
        ? { animated: true, limitInputPixels: MAX_ANIMATED_SOURCE_PIXELS }
        : uploadOpts();
    const webpOpts = animated
        ? { quality: 58, effort: 4, smartSubsample: true }
        : { quality: 82 };

    // Tagged the same way the animated fast-fail above tags itself, because the
    // callers key off `err.status` (see the crew/portal upload routes) and an
    // untagged sharp error would reach a VA admin as a 400 reading "Input image
    // exceeds pixel limit" — true, and useless. The two refusals are the same
    // refusal for the same reason, so they should read alike.
    let optimizedBuffer;
    try {
        optimizedBuffer = await sharp(inputSource, readOpts)
            .resize({ ...profile, withoutEnlargement: true })
            .webp(webpOpts)
            .toBuffer();
    } catch (err) {
        if (file.path) fs.unlink(file.path, () => {});
        if (isPixelLimitError(err)) {
            const e = new Error(PIXEL_LIMIT_MESSAGE);
            e.status = 413;
            throw e;
        }
        throw err;
    }

    const key = buildKey(vaRef, kind);

    await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: optimizedBuffer,
        ContentType: 'image/webp'
    }));

    // Clean up the temp upload only if it came from disk (Multer).
    if (file.path) fs.unlink(file.path, () => {});

    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};

/**
 * Delete a VA image from S3 given its public URL. Safe to call with null/empty.
 */
const deleteVaImage = async (s3Client, imageUrl) => {
    if (!imageUrl) return;
    try {
        const key = new URL(imageUrl).pathname.substring(1); // strip leading '/'
        await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key
        }));
    } catch (error) {
        // Non-fatal: a missing/oddly-formed URL shouldn't break the request.
        console.error(`Error deleting VA image: ${imageUrl}`, error.message);
    }
};

module.exports = { uploadVaImage, deleteVaImage };

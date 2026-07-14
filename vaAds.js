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

// Per-kind sizing. Banners keep their aspect ratio but are capped so we never
// store a 4K upload; logos are fit inside a square box without enlarging.
const IMAGE_PROFILES = {
    banner: { width: 1600, height: 600, fit: 'inside' },
    logo:   { width: 512,  height: 512, fit: 'inside' },
    // Event banners are the hero image on an event card. A wide 16:9-ish cap
    // keeps them crisp on a big card without ever storing a full-res upload.
    event:  { width: 1600, height: 900, fit: 'inside' }
};

// Animated banners/logos are re-encoded as animated WebP, where file size is
// (roughly) per-frame size × frame count. We keep EVERY frame and the full loop
// — the animation runs as long as the source — but shrink each frame to hold the
// total size down: a tighter dimension cap than the still profiles, plus more
// aggressive WebP settings applied in uploadVaImage.
const ANIMATED_PROFILES = {
    banner: { width: 1280, height: 480, fit: 'inside' },
    logo:   { width: 384,  height: 384, fit: 'inside' },
    event:  { width: 1280, height: 720, fit: 'inside' }
};

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

    // Probe for animation. metadata() only reads the header, so this is cheap;
    // pages > 1 means a multi-frame (animated) source.
    let animated = false;
    try { animated = ((await sharp(inputSource).metadata()).pages || 1) > 1; }
    catch { animated = false; }

    const profile = (animated ? ANIMATED_PROFILES : IMAGE_PROFILES)[kind]
        || (animated ? ANIMATED_PROFILES : IMAGE_PROFILES).banner;

    // Animated path: keep every frame + the loop (full-length animation), but
    // squeeze size hard — max encoder effort, lower quality, smart chroma
    // subsampling, tighter dimensions. A long animation decodes to a lot of
    // pixels (frames × w × h), so lift sharp's input-pixel guard; the 15MB
    // upload cap still bounds the real work.
    const readOpts = animated ? { animated: true, limitInputPixels: 500_000_000 } : {};
    const webpOpts = animated
        ? { quality: 55, effort: 6, smartSubsample: true }
        : { quality: 82 };

    const optimizedBuffer = await sharp(inputSource, readOpts)
        .resize({ ...profile, withoutEnlargement: true })
        .webp(webpOpts)
        .toBuffer();

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

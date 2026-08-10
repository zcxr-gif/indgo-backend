'use strict';

/*
 * imageLimits.js — the decoded-pixel ceiling every untrusted image passes under.
 *
 * WHY THIS EXISTS
 * ---------------
 * The process is OOM-killed by the container with no application log: it runs
 * fine for hours, then vanishes. Everything already in place bounds the wrong
 * number.
 *
 *   • `maxContentLength: 8MB` on the image fetches bounds the COMPRESSED bytes.
 *   • multer's limits bound the bytes that arrive on an upload.
 *   • routeMapCache's `maxBytes` bounds what we RETAIN afterwards.
 *   • sharp.concurrency(1) and the single-slot render queues bound how many
 *     pipelines run at once.
 *
 * None of them bounds the one figure that actually kills the process: how much
 * memory libvips needs to hold the image once it is DECODED. That is a function
 * of pixel count, not file size, and the two are barely related — compression
 * ratios of 100:1 are ordinary and 1000:1 is achievable on purpose. A 2 MB JPEG
 * at 20000x12000 is inside every limit above and decodes to roughly 960 MB of
 * raw RGBA.
 *
 * That allocation is fatal in a way a normal one is not:
 *
 *   • It lives outside the V8 heap, so `--max-old-space-size` does not cap it
 *     and there is no heap-limit error to catch — the container's cgroup kills
 *     the process, which is why there is no stack afterwards.
 *   • It happens inside a single synchronous-ish decode, so the memory janitor
 *     shedding caches cannot get in front of it. The caches are not the problem;
 *     by the time RSS is visible the decode has already claimed the memory.
 *   • Serializing renders does not help. One is enough.
 *
 * sharp's own default ceiling is 0x3FFF x 0x3FFF — about 268 megapixels, over a
 * gigabyte decoded. That is a guard against pathology, not a budget for a
 * container, so we set our own.
 *
 * WHAT THE NUMBERS ARE
 * --------------------
 * Peak decoded cost is roughly `pixels * 4` bytes, plus libvips working space.
 * The ceilings below are picked to be far above any legitimate input and far
 * below the container:
 *
 *   UPLOAD (40 MP, ~160 MB decoded) — a photograph a contributor took. Has to
 *   clear real cameras: 40 MP covers every phone and all but medium-format
 *   bodies, and everything here is resized to 1920px wide anyway, so the only
 *   thing a larger source buys is detail we immediately discard.
 *
 *   REMOTE (24 MP, ~96 MB decoded) — an image at a URL in a database row that a
 *   contributor or a VA typed in. Already published on the web and composited
 *   at around 1100x300, so 24 MP is generous by two orders of magnitude. Tighter
 *   than the upload ceiling because we control neither the bytes nor who points
 *   us at them.
 *
 * Both are overridable, because the right answer depends on the container this
 * is running in and that is not knowable from here.
 *
 * WHAT HAPPENS AT THE CEILING
 * ---------------------------
 * sharp throws before allocating. That is the whole point — the failure becomes
 * a catchable error on one request instead of the death of the process serving
 * every other request. Callers already handle it correctly in both shapes:
 * card renderers catch and drop the element (a card without a photo), and
 * uploads surface it as a 413 telling the contributor to send something smaller.
 */

const envPixels = (name, fallback) => {
    const raw = parseInt(process.env[name], 10);
    // A nonsensical override is ignored rather than obeyed: this is the guard
    // that keeps the process alive, so "someone set it to 0" must not silently
    // mean "unlimited".
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/** Ceiling for images a contributor uploads to us. ~160 MB decoded. */
const MAX_UPLOAD_PIXELS = envPixels('MAX_UPLOAD_PIXELS', 40_000_000);

/** Ceiling for images we fetch from a URL someone else supplied. ~96 MB decoded. */
const MAX_REMOTE_PIXELS = envPixels('MAX_REMOTE_PIXELS', 24_000_000);

/**
 * sharp options for decoding something a contributor uploaded.
 *
 * Spread into the constructor: `sharp(input, uploadOpts())`.
 *
 * A fresh object each call because sharp may retain what it is handed, and a
 * shared literal that something mutates would silently change the ceiling for
 * every later decode in the process.
 */
const uploadOpts = (extra) => ({ limitInputPixels: MAX_UPLOAD_PIXELS, ...extra });

/** sharp options for decoding an image fetched from a third-party URL. */
const remoteOpts = (extra) => ({ limitInputPixels: MAX_REMOTE_PIXELS, ...extra });

/**
 * Is this error sharp refusing an oversized image?
 *
 * Matched on the message because sharp throws a plain Error with no code. Used
 * by upload routes to answer 413 with something a contributor can act on,
 * rather than a 500 that reads as our fault — the image is not corrupt and
 * retrying will not help, it is simply too big to process.
 */
const isPixelLimitError = (err) => /exceeds pixel limit|Input image exceeds/i.test(String(err?.message || ''));

/**
 * The message a contributor should see when their image is refused.
 *
 * The figure is derived rather than written out: the ceiling is an env
 * override, and a message naming a number the process is not actually using
 * sends someone to resize to a limit that will refuse them again.
 */
const PIXEL_LIMIT_MESSAGE =
    'That image is too high-resolution to process. Please upload a smaller version '
    + `(anything up to about ${Math.round(MAX_UPLOAD_PIXELS / 1_000_000)} megapixels is fine).`;

module.exports = {
    MAX_UPLOAD_PIXELS,
    MAX_REMOTE_PIXELS,
    uploadOpts,
    remoteOpts,
    isPixelLimitError,
    PIXEL_LIMIT_MESSAGE,
};

/*
 * assets/va-chip.js
 * An airline's mark, small, immediately before its name.
 *
 * WHY A SHARED FILE FOR SOMETHING THIS SMALL
 * ------------------------------------------
 * Because the two decisions in it are easy to get wrong, and getting them
 * wrong looks bad on every page at once.
 *
 * 1. A VA LOGO IS NOT A SQUARE. Marks arrive as roundels AND as wordmarks,
 *    about equally. Force a 3:1 wordmark into an 18x18 box and you render the
 *    airline's name at a size nobody can read, next to the airline's name at a
 *    size everybody can. So the HEIGHT is fixed — that is what makes a column
 *    of these line up — and the width is free up to a ceiling, with the image
 *    contained rather than cropped. ifProfileCard.js reached the same
 *    conclusion for the profile-card badges; this is that rule for HTML.
 *
 * 2. A LOGO IS OPTIONAL AND URLS ROT. A VA with no logo yet, and a VA whose S3
 *    object has gone, must both come out as a readable row rather than a
 *    broken-image glyph. Both fall back to a monogram built from the name, and
 *    a logo that fails to load swaps itself for one at runtime.
 *
 * USAGE
 *   VaChip.html(va)                      -> '<span class="va-chip">…</span>'
 *   VaChip.html(va, { size: 22, link: true, mono: 'Unattributed' })
 *
 * `va` is the shape vaIdentity.js serves: { name, code, slug, logoUrl }. A bare
 * string is accepted too and renders as a monogram plus that name, which keeps
 * the call site the same on surfaces whose API hasn't been taught to attach an
 * identity yet.
 *
 * Returns a STRING, because every page here builds its lists by concatenating
 * HTML. It escapes everything it is given.
 */
(function (global) {
    'use strict';

    var STYLE_ID = 'va-chip-css';
    // Height is the one dimension a caller sets; everything else derives from
    // it so a 14px chip and a 28px chip are the same design, not two designs.
    var CSS = [
        '.va-chip{display:inline-flex;align-items:center;gap:.45em;min-width:0;max-width:100%;',
        'vertical-align:baseline;text-decoration:none;color:inherit}',
        'a.va-chip:hover .va-chip-name{text-decoration:underline}',
        '.va-chip-mark{height:var(--va-chip-h,18px);width:auto;max-width:calc(var(--va-chip-h,18px) * 3.2);',
        'object-fit:contain;border-radius:calc(var(--va-chip-h,18px) / 5);flex:none;background:transparent}',
        '.va-chip-mono{height:var(--va-chip-h,18px);width:var(--va-chip-h,18px);flex:none;',
        'border-radius:calc(var(--va-chip-h,18px) / 5);display:inline-flex;align-items:center;justify-content:center;',
        'font-size:calc(var(--va-chip-h,18px) * .44);font-weight:800;letter-spacing:.02em;line-height:1;',
        'background:#e4e4e7;color:#3f3f46}',
        '.dark .va-chip-mono{background:#3f3f46;color:#e4e4e7}',
        '.va-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('');

    function injectCss() {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
        var el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = CSS;
        (document.head || document.documentElement).appendChild(el);
    }

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Two letters from two words, else the first two of one. "Ocean Virtual"
    // -> OV; "Rednose" -> RE; nothing usable -> VA. Punctuation is dropped
    // first so a name like "A&B Virtual" monograms as AV, not A&.
    function initials(name) {
        var words = String(name || '')
            .split(/[^0-9A-Za-z\u00C0-\u024F]+/)
            .filter(Boolean);
        if (!words.length) return 'VA';
        var out = words.length >= 2 ? (words[0][0] + words[1][0]) : words[0].slice(0, 2);
        return out.toUpperCase();
    }

    // Only http(s) URLs reach an <img src>. Everything else — javascript:,
    // data:, a half-written value out of the database — becomes a monogram.
    function safeUrl(url) {
        var s = String(url || '').trim();
        return /^https?:\/\//i.test(s) ? s : '';
    }

    function monogram(name) {
        return '<span class="va-chip-mono" aria-hidden="true">' + esc(initials(name)) + '</span>';
    }

    /**
     * @param {object|string} va   { name, code, slug, logoUrl } or a plain name
     * @param {object} [opts]
     * @param {number} [opts.size=18]   mark height in px
     * @param {boolean}[opts.link=false] wrap in a link to /crew/<slug> when there is one
     * @param {string} [opts.mono='—']  what to print when there is no VA at all
     * @param {string} [opts.className='']  extra classes for the outer element
     * @param {boolean}[opts.nameOnly=false] hide the name, keep the mark (tight columns)
     * @returns {string} HTML
     */
    function html(va, opts) {
        injectCss();
        var o = opts || {};
        var v = (typeof va === 'string') ? { name: va } : (va || {});
        var name = v.name || v.vaName || '';
        var size = Number(o.size) > 0 ? Number(o.size) : 18;

        if (!name) return '<span class="va-chip-name">' + esc(o.mono === undefined ? '—' : o.mono) + '</span>';

        var url = safeUrl(v.logoUrl);
        // The onerror hands the <img> its own replacement rather than hiding it,
        // so a dead URL leaves the row exactly as tall as its neighbours.
        var mark = url
            ? '<img class="va-chip-mark" src="' + esc(url) + '" alt="" loading="lazy" decoding="async"' +
              ' onerror="this.outerHTML=' + esc(JSON.stringify(monogram(name))) + '">'
            : monogram(name);

        var label = o.nameOnly ? '' : '<span class="va-chip-name">' + esc(name) + '</span>';
        var attrs = 'class="va-chip ' + esc(o.className || '') + '" style="--va-chip-h:' + size + 'px"' +
            ' title="' + esc(name + (v.code ? ' · ' + v.code : '')) + '"';

        if (o.link && v.slug) {
            return '<a ' + attrs + ' href="/crew/' + esc(v.slug) + '">' + mark + label + '</a>';
        }
        return '<span ' + attrs + '>' + mark + label + '</span>';
    }

    global.VaChip = { html: html, initials: initials, escape: esc };
})(typeof window !== 'undefined' ? window : this);

/*
 * The public pilot profile, on the open web.
 *
 * Everything else in this file's neighbourhood is behind a staff login or a
 * partner login. This is the opposite: it is a page for strangers, and the
 * whole point of it is that somebody can paste a link into a forum post, a
 * Discord message or a bio and have it open for a person who has never heard
 * of us and does not have the app.
 *
 * RENDERED ON THE SERVER, and that is the only interesting decision here. The
 * iOS app reads exactly the same `pilot_profile_*` functions from the client
 * and draws them natively; a browser page could do the same in twenty lines of
 * fetch. It does not, because a client-rendered page has no <title> and no
 * Open Graph tags until its JavaScript has run, and the things that actually
 * fetch this URL — the forum's link preview, Discord's unfurler, iMessage,
 * every crawler — do not run JavaScript. A profile whose link previews as a
 * blank card is a profile nobody clicks.
 *
 * WHAT IT MAY SHOW IS NOT DECIDED HERE. Every read goes through a `security
 * definer` function that applies the profile's own visibility, the blocks, the
 * report threshold and the Pro gating on the banner — called with the anon key,
 * which is precisely the "signed-out stranger" case those functions are written
 * for. This module gets a row or it gets nothing, and renders whichever it got.
 * There is deliberately no service-role key anywhere in this file.
 */

const axios = require('axios');

const TIMEOUT = 8000;

/**
 * Reads a public profile, exactly as a signed-out browser would.
 *
 * Returns null for "no such handle", for "not public", for "hidden by reports"
 * and for "the reader is blocked" — the server does not distinguish them, and
 * neither should this. Telling them apart would turn the page into a way of
 * enumerating private accounts.
 */
async function fetchPilotProfile({ supabaseUrl, anonKey, handle }) {
    const call = async (fn, body) => {
        const resp = await axios.post(`${supabaseUrl}/rest/v1/rpc/${fn}`, body, {
            timeout: TIMEOUT,
            headers: {
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
                'Content-Type': 'application/json',
            },
        });
        return resp?.data;
    };

    let card;
    try {
        const rows = await call('pilot_profile_card', { p_handle: handle });
        card = Array.isArray(rows) ? rows[0] : rows;
    } catch (err) {
        console.error('[pilot] card lookup failed:', err?.message || err);
        return null;
    }
    if (!card || !card.handle) return null;

    // The rest is decoration: a profile that renders without its badges is a
    // worse page, and a profile that 500s because one of four calls timed out
    // is no page at all.
    const settle = async (promise, fallback) => {
        try { return (await promise) ?? fallback; } catch (_) { return fallback; }
    };

    const [friends, badges, summary, logbook] = await Promise.all([
        settle(call('pilot_profile_friends', { p_handle: handle, p_limit: 18 }), []),
        settle(call('pilot_badges', { p_handle: handle }), []),
        settle(call('pilot_logbook_summary', { p_handle: handle }), []),
        settle(call('pilot_logbook_entries', { p_handle: handle, p_limit: 10 }), []),
    ]);

    return {
        card,
        friends: Array.isArray(friends) ? friends : [],
        badges: Array.isArray(badges) ? badges : [],
        summary: Array.isArray(summary) ? summary[0] : summary,
        logbook: Array.isArray(logbook) ? logbook : [],
    };
}

/** The public address of an image in one of the profile buckets. */
function imageUrl(supabaseUrl, bucket, path) {
    if (!path) return null;
    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodeURI(path)}`;
}

/**
 * A URL safe to drop inside `url('…')` in a style attribute.
 *
 * `escapeHtml` is not enough on its own here and the reason is worth writing
 * down: an attribute value is HTML-decoded BEFORE the CSS in it is parsed, so
 * an apostrophe written as `&#39;` arrives at the CSS parser as an apostrophe
 * and closes the `url('`. Object paths are minted by the `profile-image` Edge
 * Function out of a uuid and an extension, so none of them can contain one
 * today — this is here so that stays true if anything ever writes that column
 * by another route.
 */
function cssUrl(url) {
    return String(url).replace(/['"()\s\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/*
 * The painted banners, matching `BannerPreset` in the iOS app.
 *
 * Duplicated rather than shared because there is nothing to share them
 * through — one is Swift and one is CSS — and because six pairs of colours
 * that must stay in step is a smaller problem than a build step to generate
 * them. The names are the contract: `banner_preset` is a string in the
 * database and both ends look it up here.
 */
const BANNERS = {
    dusk: ['#2b3369', '#944f70', '#eb8c5c'],
    dawn: ['#1f3d70', '#5c8cb8', '#fbcc99'],
    flight_level: ['#0d1c45', '#2a599a', '#9ecced'],
    night: ['#080a1f', '#1a2148', '#404773'],
    desert: ['#6b4229', '#c28547', '#f2d499'],
    ocean: ['#053349', '#0d6b82', '#70c2bf'],
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "6h 20m", or "45m" under the hour. */
function blockTime(minutes) {
    const value = Number(minutes) || 0;
    const hours = Math.floor(value / 60);
    return hours > 0 ? `${hours}h ${value % 60}m` : `${value}m`;
}

/**
 * The page.
 *
 * One string, no framework, no external stylesheet and no script. It is a
 * profile — text, a handful of images and some numbers — and every dependency
 * added to it is another thing between a stranger and the page loading.
 */
function renderPilotPage({ data, supabaseUrl, siteOrigin, aircraftPhotoUrl }) {
    const { card, friends, badges, summary, logbook } = data;

    const name = card.display_name || card.handle;
    const avatar = imageUrl(supabaseUrl, 'pilot-avatars', card.avatar_path);
    const banner = imageUrl(supabaseUrl, 'pilot-banners', card.banner_path);
    const stops = BANNERS[card.banner_preset] || BANNERS.dusk;
    const canonical = `${siteOrigin}/pilot/${encodeURIComponent(card.handle)}`;

    // The accent is a Pro column and arrives already blanked for an account
    // whose subscription has ended, so there is nothing to check here — but it
    // is still validated before going anywhere near a stylesheet, because a
    // colour that reaches CSS unchecked is a stylesheet somebody else can write.
    const accent = /^#[0-9a-f]{6}$/i.test(card.accent || '') ? card.accent : '#e0873f';

    // What a link preview shows. The banner where there is one, because it is
    // the only image on the page shaped like a preview card; the avatar
    // otherwise, which unfurls as a square and still reads as a person.
    const previewImage = banner || avatar || null;

    const description = card.bio
        ? card.bio
        : [
            card.favourite_aircraft ? `Flies the ${card.favourite_aircraft}` : null,
            card.home_airport ? `out of ${card.home_airport}` : null,
        ].filter(Boolean).join(' ') || `${name} on Inflight.`;

    const earned = badges.filter((b) => b.earned);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} (@${escapeHtml(card.handle)}) · Inflight</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Inflight">
<meta property="og:title" content="${escapeHtml(name)} (@${escapeHtml(card.handle)})">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
${previewImage ? `<meta property="og:image" content="${escapeHtml(previewImage)}">` : ''}
<meta name="twitter:card" content="${previewImage ? 'summary_large_image' : 'summary'}">
<meta name="theme-color" content="#0b0d16">
<style>
:root {
  --accent: ${accent};
  --bg: #f5f5f7;
  --card: #ffffff;
  --text: #16181f;
  --dim: #6b7080;
  --line: rgba(0,0,0,.09);
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0b0d16; --card:#151827; --text:#f2f3f7; --dim:#8990a6; --line:rgba(255,255,255,.10); }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.wrap { max-width: 640px; margin: 0 auto; padding: 0 0 48px; }
.banner {
  height: 172px; background: linear-gradient(180deg, ${stops[0]}, ${stops[1]}, ${stops[2]});
  background-size: cover; background-position: center;
}
.head { padding: 0 20px; margin-top: -46px; }
.avatar {
  width: 92px; height: 92px; border-radius: 50%; object-fit: cover; display: block;
  border: 4px solid var(--bg); background: var(--accent);
}
.initials {
  width: 92px; height: 92px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center;
  font-size: 34px; font-weight: 800; color: #fff; background: var(--accent);
  border: 4px solid var(--bg);
}
h1 { font-size: 25px; margin: 12px 0 2px; letter-spacing: -.4px; }
.handle { color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.pro {
  display: inline-block; vertical-align: middle; margin-left: 8px;
  font-size: 10px; font-weight: 800; letter-spacing: .6px;
  background: var(--accent); color: #fff; padding: 3px 7px; border-radius: 99px;
}
.bio { margin: 14px 0 0; color: var(--text); }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  margin: 18px 20px 0; overflow: hidden;
}
.stats { display: flex; }
.stat { flex: 1; text-align: center; padding: 15px 4px; }
.stat b { display: block; font-size: 19px; letter-spacing: -.3px; }
.stat span { font-size: 10px; font-weight: 700; letter-spacing: .7px; color: var(--dim); }
.label { font-size: 10px; font-weight: 700; letter-spacing: .9px; color: var(--dim); margin: 22px 22px 0; }
.plane img { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; }
.plane .meta { padding: 13px 16px; }
.plane .meta b { display: block; font-size: 16px; }
.plane .meta span { color: var(--dim); font-size: 13px; }
.friends { display: flex; gap: 14px; overflow-x: auto; padding: 16px; }
.friend { text-align: center; width: 62px; flex: 0 0 auto; text-decoration: none; }
.friend img, .friend .fi {
  width: 48px; height: 48px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 5px;
  background: var(--accent); color: #fff; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.friend span { font-size: 10px; color: var(--dim); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badges { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px; }
.badge {
  border: 1px solid var(--line); border-radius: 99px; padding: 6px 12px; font-size: 12px;
  background: var(--accent); color: #fff; border-color: transparent;
}
.rows > div { display: flex; justify-content: space-between; gap: 12px; padding: 11px 16px; border-top: 1px solid var(--line); }
.rows > div:first-child { border-top: 0; }
.rows b { font-weight: 600; }
.rows small { color: var(--dim); display: block; font-weight: 400; }
.rows time { color: var(--dim); font-size: 12px; white-space: nowrap; }
.foot { color: var(--dim); font-size: 12px; padding: 26px 22px 0; }
.foot a { color: var(--accent); }
.empty { padding: 60px 24px; text-align: center; }
.empty h1 { font-size: 21px; }
.empty p { color: var(--dim); }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner"${banner ? ` style="background-image:url('${escapeHtml(cssUrl(banner))}')"` : ''}></div>

  <div class="head">
    ${avatar
        ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" width="92" height="92">`
        : `<div class="initials">${escapeHtml(initialsOf(name))}</div>`}
    <h1>${escapeHtml(name)}${card.is_pro ? '<span class="pro">PRO</span>' : ''}</h1>
    <div class="handle">@${escapeHtml(card.handle)}</div>
    ${card.bio ? `<p class="bio">${escapeHtml(card.bio)}</p>` : ''}
  </div>

  <div class="card stats">
    <div class="stat"><b>${card.friend_count || 0}</b><span>FRIENDS</span></div>
    <div class="stat"><b>${card.follower_count || 0}</b><span>FOLLOWERS</span></div>
    <div class="stat"><b>${card.following_count || 0}</b><span>FOLLOWING</span></div>
  </div>

  ${summary && summary.flights ? `
  <div class="card stats">
    <div class="stat"><b>${summary.flights}</b><span>FLIGHTS</span></div>
    <div class="stat"><b>${Math.floor((summary.minutes || 0) / 60)}</b><span>HOURS</span></div>
    <div class="stat"><b>${summary.airports || 0}</b><span>FIELDS</span></div>
  </div>` : ''}

  ${card.favourite_aircraft ? `
  <div class="label">FAVOURITE AIRCRAFT</div>
  <div class="card plane">
    ${aircraftPhotoUrl ? `<img src="${escapeHtml(aircraftPhotoUrl)}" alt="${escapeHtml(card.favourite_aircraft)}" loading="lazy">` : ''}
    <div class="meta">
      <b>${escapeHtml(card.favourite_aircraft)}</b>
      ${card.favourite_livery ? `<span>${escapeHtml(card.favourite_livery)}</span>` : ''}
      ${card.home_airport ? `<span>Flies out of ${escapeHtml(card.home_airport)}</span>` : ''}
    </div>
  </div>` : (card.home_airport ? `
  <div class="label">HOME</div>
  <div class="card"><div class="meta" style="padding:13px 16px"><b>${escapeHtml(card.home_airport)}</b></div></div>` : '')}

  ${friends.length ? `
  <div class="label">FLIES WITH</div>
  <div class="card">
    <div class="friends">
      ${friends.map((f) => {
          const face = imageUrl(supabaseUrl, 'pilot-avatars', f.avatar_path);
          const to = `/pilot/${encodeURIComponent(f.handle)}`;
          return `<a class="friend" href="${escapeHtml(to)}">${
              face
                  ? `<img src="${escapeHtml(face)}" alt="" loading="lazy">`
                  : `<div class="fi">${escapeHtml(initialsOf(f.display_name || f.handle))}</div>`
          }<span>${escapeHtml(f.display_name || f.handle)}</span></a>`;
      }).join('')}
    </div>
  </div>` : ''}

  ${earned.length ? `
  <div class="label">EARNED</div>
  <div class="card"><div class="badges">
    ${earned.map((b) => `<span class="badge" title="${escapeHtml(b.detail)}">${escapeHtml(b.title)}</span>`).join('')}
  </div></div>` : ''}

  ${logbook.length ? `
  <div class="label">LOGBOOK</div>
  <div class="card rows">
    ${logbook.map((entry) => `<div>
      <b>${escapeHtml(entry.origin_icao || '————')} &rarr; ${escapeHtml(entry.destination_icao || '————')}
        <small>${escapeHtml([entry.aircraft, entry.callsign].filter(Boolean).join(' · ') || 'Flight')}</small></b>
      <time datetime="${escapeHtml(entry.landed_at || '')}">${blockTime(entry.minutes)}</time>
    </div>`).join('')}
    ${logbook[0] && logbook[0].truncated
        ? `<div><small>${escapeHtml(name)} is on a free account, so the most recent flights are shown.</small></div>`
        : ''}
  </div>` : ''}

  <p class="foot">
    ${card.if_username
        ? (card.if_username_verified
            ? `Flies as ${escapeHtml(card.if_username)} on Infinite Flight. `
            : `Says they fly as ${escapeHtml(card.if_username)} on Infinite Flight — we haven't checked. `)
        : ''}
    ${friends.length ? `${escapeHtml(plural(card.friend_count || 0, 'friend', 'friends'))} on Inflight. ` : ''}
    <a href="https://inflight.info">Inflight</a> tracks Infinite Flight in real time.
  </p>
</div>
</body>
</html>`;
}

/**
 * What a stranger gets for a handle that is not there.
 *
 * One page for "no such pilot", "their profile is private", "it has been hidden
 * while it is looked at" and "you are blocked", because the server does not
 * tell this module which of those it was — on purpose. Distinguishing them here
 * would make the page a way to enumerate private accounts and to find out who
 * has blocked you.
 */
function renderPilotMissing(handle) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No such pilot · Inflight</title>
<meta name="robots" content="noindex">
<style>
body { margin:0; background:#0b0d16; color:#f2f3f7; font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
@media (prefers-color-scheme: light) { body { background:#f5f5f7; color:#16181f; } }
.box { max-width:420px; margin:0 auto; padding:22vh 24px; text-align:center; }
h1 { font-size:22px; margin:0 0 8px; }
p { opacity:.7; }
a { color:#e0873f; }
</style>
</head>
<body><div class="box">
<h1>Nobody here</h1>
<p>@${escapeHtml(handle)} hasn't set up an Inflight profile, or theirs isn't public.</p>
<p><a href="https://inflight.info">Inflight</a> tracks Infinite Flight in real time.</p>
</div></body>
</html>`;
}

function initialsOf(name) {
    const words = String(name || '').split(/[\s._-]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

/** Handles are lowercase, 3–20 of letters, digits and underscores. */
const HANDLE_RE = /^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/;

module.exports = {
    fetchPilotProfile,
    renderPilotPage,
    renderPilotMissing,
    HANDLE_RE,
    BANNERS,
};

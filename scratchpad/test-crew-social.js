'use strict';
// Conformance test for the crew center's Instagram wall.
//
// The wall is the one crew-center field whose values are typed by a staff
// member and then handed to a browser as an iframe `src`. That is the shape of
// bug that ends with somebody else's script running on a VA's page, so the
// cases here are the ones where getting it wrong is a security bug rather than
// a cosmetic one:
//
//   * a share link is reduced to {kind, code} and the URL is NOT kept
//   * a host that merely ENDS with instagram.com is refused
//     (instagram.com.evil.test, notinstagram.com)
//   * a non-http scheme is refused (javascript:, data:)
//   * what comes back out is rebuilt from the code, so `embedUrl` is ours
//   * a round trip — store, publish, save again — does not empty the wall,
//     which is what would happen if sanitize only accepted pasted strings
//   * duplicates collapse and the wall is capped
//   * an unparseable row is DROPPED, not fatal: one stale link must not take
//     the other eleven down with it
//
// Pure module test — no network, no database. mongoose is stubbed because
// crewAuth pulls it in at require time for its models.

const path = require('path');
const Module = require('module');

const realResolve = Module._resolveFilename;
const STUBS = {
    mongoose: { model: () => ({}), models: {}, Schema: function Schema() {} },
    bcryptjs: { hashSync: () => '', compareSync: () => false, genSaltSync: () => '' },
    jsonwebtoken: { sign: () => '', verify: () => ({}) },
    axios: { get: async () => ({}), post: async () => ({}), create: () => ({}) },
};
Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return request;
    return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return realLoad.call(this, request, ...rest);
};

const A = require(path.join('..', 'crewAuth.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) { failures++; console.log(`  FAIL  ${label}\n        got      ${JSON.stringify(got)}\n        expected ${JSON.stringify(expected)}`); }
    else console.log(`  ok    ${label}`);
};

console.log('\nparseSocialPost — what survives');
T('share link, tracking junk dropped',
    A.parseSocialPost('https://www.instagram.com/p/ABC123_-x/?utm_source=ig_web_copy_link'),
    { kind: 'p', code: 'ABC123_-x' });
T('reel behind a profile segment',
    A.parseSocialPost('instagram.com/aeromexicovirtual/reel/XY9/'),
    { kind: 'reel', code: 'XY9' });
T('/reels/ normalises to reel',
    A.parseSocialPost('https://instagram.com/reels/Q7/'),
    { kind: 'reel', code: 'Q7' });
T('igtv kept as tv',
    A.parseSocialPost('https://www.instagram.com/tv/TV1/'),
    { kind: 'tv', code: 'TV1' });

console.log('\nparseSocialPost — what does not');
T('look-alike host', A.parseSocialPost('https://instagram.com.evil.test/p/HACK/'), null);
T('suffix host', A.parseSocialPost('https://notinstagram.com/p/HACK/'), null);
T('javascript: scheme', A.parseSocialPost('javascript:alert(1)'), null);
T('data: scheme', A.parseSocialPost('data:text/html,<script>1</script>'), null);
T('a profile, not a post', A.parseSocialPost('https://instagram.com/aeromexicovirtual/'), null);
T('empty', A.parseSocialPost(''), null);
T('not a string', A.parseSocialPost({ url: 1 }), null);

console.log('\nsanitizeSocial — the stored shape');
const stored = A.sanitizeSocial({
    handle: '@aeromexicovirtual',
    posts: [
        'https://www.instagram.com/p/AAA/?utm_source=x',
        'https://www.instagram.com/p/AAA/',            // duplicate
        'https://instagram.com.evil.test/p/HACK/',      // dropped, not fatal
        'https://www.instagram.com/reel/BBB/',
    ],
});
T('handle loses its @', stored.handle, 'aeromexicovirtual');
T('duplicate collapsed, hostile dropped, rest kept',
    stored.posts, [{ kind: 'p', code: 'AAA' }, { kind: 'reel', code: 'BBB' }]);
T('no url field is stored at all',
    stored.posts.every(p => !('url' in p)), true);
T('a non-object config is refused outright', A.sanitizeSocial('nope'), null);
T('an array is not a config either', A.sanitizeSocial(['https://instagram.com/p/AAA/']), null);

const capped = A.sanitizeSocial({
    posts: Array.from({ length: A.MAX_SOCIAL_POSTS + 5 }, (_, i) => `https://instagram.com/p/c${i}/`),
});
T('wall is capped', capped.posts.length, A.MAX_SOCIAL_POSTS);

console.log('\npublicSocial — the address is rebuilt, never echoed');
const out = A.publicSocial({ crewSocial: stored });
T('embed address is assembled from the code',
    out.posts[0].embedUrl, 'https://www.instagram.com/p/AAA/embed/');
T('canonical link too', out.posts[0].url, 'https://www.instagram.com/p/AAA/');
T('a row with a kind nobody recognises is not published',
    A.publicSocial({ crewSocial: { posts: [{ kind: 'javascript', code: 'x' }] } }).posts, []);
T('an empty wall is still a wall, not an absence',
    A.publicSocial({}), { handle: '', posts: [] });

console.log('\nthe round trip — publish, then save what was published');
const again = A.sanitizeSocial(out);
T('stored → published → stored keeps every post', again.posts, stored.posts);
T('…and the handle', again.handle, stored.handle);

console.log(failures ? `\n${failures} failing\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);

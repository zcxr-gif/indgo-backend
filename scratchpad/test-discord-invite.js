'use strict';
// Conformance test for crewAuth's Discord invite validator.
//
// This is a security boundary, not a formatting nicety. The string it guards is
// put in front of an accepted pilot inside an email that WE send, with our name
// on it, and is rendered as a link on the applicant's status page. An
// unvalidated "invite" field would let a VA point either of those anywhere and
// have it read as coming from Inflight.
//
// So the rule under test is: anything that is not literally a Discord invite is
// REJECTED (null), never sanitised into something plausible. Empty is the one
// benign non-invite — it means "clear the stored invite".
//
// No DB, no network. crewAuth pulls in mongoose for its route handlers, so stub
// it before requiring — the validator itself touches nothing.

const path = require('path');
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'mongoose') {
        return { Schema: function () { this.index = () => {}; }, models: {}, model: () => ({}) };
    }
    return origLoad.call(this, req, ...rest);
};

const { isDiscordInviteUrl, cleanDiscordInvite } = require(path.join('..', 'crewAuth.js'));

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ❌', label, '\n     got', JSON.stringify(got), '\n     exp', JSON.stringify(expected));
};
const accepts = (url) => T(`accepts  ${url}`, isDiscordInviteUrl(url), true);
const rejects = (url) => T(`rejects  ${JSON.stringify(url)}`, isDiscordInviteUrl(url), false);

console.log('• the real thing');
accepts('https://discord.gg/abc123');
accepts('https://discord.gg/aeromexico-va');          // vanity URLs carry hyphens
accepts('https://discord.gg/abc123/');                 // a trailing slash is fine
accepts('https://discord.com/invite/abc123');
accepts('https://discordapp.com/invite/abc123');       // the legacy domain
accepts('https://canary.discord.com/invite/abc123');
accepts('https://ptb.discord.com/invite/abc123');

console.log('• not Discord at all');
rejects('https://example.com/invite/abc123');
rejects('https://discord.gg.evil.com/abc123');         // suffix, not the host
rejects('https://notdiscord.gg/abc123');
rejects('https://evil.com/?x=https://discord.gg/abc');

console.log('• Discord, but not an invite');
rejects('https://discord.com/abc123');                 // bare code only valid on discord.gg
rejects('https://discord.com/invite/abc/extra');       // no smuggled path segments
rejects('https://discord.gg/');                        // no code
rejects('https://discord.com/api/webhooks/1/tok');     // that's the webhook, a secret

console.log('• not a URL, or not https');
rejects('http://discord.gg/abc123');                   // plaintext downgrade
rejects('javascript:alert(1)');
rejects('discord.gg/abc123');                          // scheme-less
rejects('');
rejects(null);
rejects(undefined);
rejects(12345);

console.log('• cleanDiscordInvite: cleared vs rejected are different answers');
T('empty means "clear the stored invite"', cleanDiscordInvite(''), '');
T('whitespace only also clears', cleanDiscordInvite('   '), '');
T('undefined clears', cleanDiscordInvite(undefined), '');
T('a valid invite comes back trimmed', cleanDiscordInvite('  https://discord.gg/abc123  '), 'https://discord.gg/abc123');
T('a trailing slash is normalised off', cleanDiscordInvite('https://discord.gg/abc123/'), 'https://discord.gg/abc123');
T('junk is REJECTED, not silently blanked', cleanDiscordInvite('https://evil.com/x'), null);
T('a webhook URL is rejected', cleanDiscordInvite('https://discord.com/api/webhooks/1/tok'), null);

// Canonicalisation. Path traversal cannot leave discord.gg — the URL parser
// resolves it before the host is ever checked — but the stored string is what a
// pilot is shown, and it should read like an invite rather than like an attack.
T('traversal collapses to the resolved path',
    cleanDiscordInvite('https://discord.gg/abc/../../joinme'), 'https://discord.gg/joinme');
T('a query string is dropped', cleanDiscordInvite('https://discord.gg/abc123?ref=spam'), 'https://discord.gg/abc123');
T('a fragment is dropped', cleanDiscordInvite('https://discord.gg/abc123#x'), 'https://discord.gg/abc123');
T('the host is lowercased by the parser', cleanDiscordInvite('https://DISCORD.GG/abc123'), 'https://discord.gg/abc123');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll Discord invite checks passed ✅');
process.exit(failures ? 1 : 0);

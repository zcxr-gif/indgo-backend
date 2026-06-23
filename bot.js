// bot.js
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder,
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, 
    AttachmentBuilder, 
    ComponentType,
    ChannelType,
    PermissionsBitField, // Added for Mod Permissions
    Options 
} = require('discord.js');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const fsPromises = require('fs').promises; 
const os = require('os');
const path = require('path');
const stream = require('stream');
const util = require('util');

// Import the local aircraft registry for auto-registration lookup
const aircraftRegistry = require('./aircraft.json');
// --- NEW AIRPORT CONFIGURATION ---
const AIRPORT_SUBMISSION_CHANNEL_ID = '1463634001020325959';
const AIRPORT_ADMIN_CHANNEL_ID = '1463636133685628989';

// Import airport helpers (Ensure these are exported in airports.js)
const { uploadAirportImage, getAirportInfo, deleteAirportImages } = require('./airports');

// Import VA image helpers so the bot can accept banner/logo uploads in-channel
// and push them to S3, exactly like the web dashboard does.
const { uploadVaImage, deleteVaImage } = require('./vaAds');

// Promisify pipeline for efficient stream handling
const pipeline = util.promisify(stream.pipeline);

// MEMORY FIX: Disable Sharp's internal cache
sharp.cache(false);
// MEMORY FIX: limit concurrency to prevent CPU/RAM saturation
sharp.concurrency(1); 

// CONFIGURATION - REPLACE THESE WITH YOUR REAL CHANNEL IDS
const ADMIN_CHANNEL_ID = '1448137363795742942'; 
const PUBLIC_FEED_CHANNEL_ID = '1448138153335586988'; 
const WELCOME_CHANNEL_ID = '1442462899451858975'; 
const SUBMISSION_CHANNEL_ID = '1442461970371444880'; 

// --- NEW CONFIGURATION ---
const MEMBER_ROLE_ID = '1442472513849397248';          
const CONTRIBUTOR_ROLE_ID = '1442534816863223888';     
const LEADERBOARD_CHANNEL_ID = '1448178846875521064';  
const TOP_CONTRIBUTOR_ROLE_ID = '1448179466722611291'; 
const ADMIN_ROLE_ID = '1442258765016469649'; // Admin Role for Mod Commands

// --- TICKET SYSTEM CONFIGURATION ---
const TICKET_PANEL_CHANNEL_ID = '1442462474489299115';
const TRANSCRIPT_CHANNEL_ID = '1442471030642966548'; // Used for Tickets AND Mod Logs

// --- GIVEAWAY CONFIGURATION ---
const GIVEAWAY_MOD_CHANNEL_ID = ADMIN_CHANNEL_ID;        // moderation/staff channel for winner fulfillment
const GIVEAWAY_TICKET_CHANNEL_ID = TICKET_PANEL_CHANNEL_ID; // parent channel for winner help tickets
const DEFAULT_GIVEAWAY_PRIZE = 'Inflight Pro — 1 Month Subscription';

// --- VA (VIRTUAL AIRLINE) SYSTEM CONFIGURATION ---
// Pilots apply with /va_apply; the application posts to the review channel for
// staff to Approve / Reject / Request edits. On approval the bot provisions a
// private VA channel under the category, a VA-specific role, and grants the
// shared "VA Rep" role (which unlocks the reps general chat).
const VA_CATEGORY_ID = '1517173854206693416';            // parent category for per-VA channels
const VA_REPS_CHAT_ID = '1517174670334361732';           // shared reps general chat
const VA_APPLICATION_CHANNEL_ID = '1517177121422835852'; // where applications post for review
const VA_REP_ROLE_NAME = 'VA Rep';                       // shared role gating the reps chat

// The "Inflight VA Rep" staff role. Added to every per-VA channel the bot
// provisions, and pinged + pulled into VA partnership tickets so they can field
// questions about the partnership and our Inflight Pro subscription.
const INFLIGHT_VA_REP_ROLE_ID = '1518665927254605925';

const METADATA_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api/metadata';
const BASE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api';

// --- CACHE SYSTEMS ---
let cachedAircraftData = []; 
let lastAircraftCacheUpdate = 0;
let cachedLiveries = {}; 

// --- SESSION MANAGEMENT ---
const userSessions = new Map();

// --- GIVEAWAY STATE ---
// Keyed by the giveaway message ID. This is the live in-memory mirror; the
// source of truth is the Giveaway collection so active giveaways survive a
// restart (they are reloaded on `ready` and their end timers re-armed).
const activeGiveaways = new Map();

// ===================== UNIFIED VISUAL THEME =====================
// A clean white / dark-gray palette so every embed reads as one product.
// THEME.WHITE renders as a crisp white accent bar; THEME.GRAY blends into
// Discord's dark surface for neutral/secondary content.
const THEME = {
    WHITE: 0xFFFFFF,   // primary accent — active, verified, info, highlights
    GRAY:  0x2B2D31,   // neutral surface — pending, comparisons, dormant
};
const BRAND_FOOTER = 'Aircraft Database';

// Submission lifecycle states. `badge` is shown in the embed body and updates
// live as a submission moves Pending → Verified / Rejected.
const SUB_STATE = {
    PENDING:  { color: THEME.GRAY,  badge: '🟡 Awaiting Review' },
    VERIFIED: { color: THEME.WHITE, badge: '🟢 Verified' },
    REJECTED: { color: THEME.GRAY,  badge: '🔴 Rejected' },
};

// Build a consistently-branded embed. Defaults to the white accent.
const themedEmbed = (color = THEME.WHITE) =>
    new EmbedBuilder().setColor(color).setFooter({ text: BRAND_FOOTER });


// Helper to strip non-ASCII characters for AWS S3 Metadata compatibility
const sanitizeMetadata = (str) => {
    // Removes emojis, special fonts, and non-standard symbols
    const sanitized = str.replace(/[^\x00-\x7F]/g, "").trim();
    // Fallback to 'User' if the entire name was special characters
    return sanitized || "User";
};

/**
 * Converts fancy stylized fonts (NFKC normalization) to standard letters
 * and strips any remaining non-ASCII characters for S3.
 */
const normalizeContributorName = (str) => {
    if (!str) return "User";
    
    // 1. Convert fancy fonts (like 𝑺 -> S) to normal compatibility characters
    const normal = str.normalize('NFKC');
    
    // 2. Strip everything except standard printable ASCII (A-Z, 0-9, space, etc.)
    const clean = normal.replace(/[^\x20-\x7E]/g, "").trim();
    
    // 3. Fallback if the name was entirely symbols
    return clean || "User";
};

const escapeRegex = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// MEMORY FIX: Use TypedArrays to prevent heap fragmentation during high-volume lookups
const levenshteinDistance = (s, t) => {
    if (s === t) return 0;
    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    // Optimization: Always ensure we iterate over the shorter string to minimize array size
    if (s.length > t.length) [s, t] = [t, s];

    // Use TypedArray for fixed memory allocation (no object overhead)
    const v0 = new Uint16Array(t.length + 1);
    const v1 = new Uint16Array(t.length + 1);

    // Initialize v0
    for (let i = 0; i < v0.length; i++) v0[i] = i;

    for (let i = 0; i < s.length; i++) {
        v1[0] = i + 1;

        for (let j = 0; j < t.length; j++) {
            const cost = s[i] === t[j] ? 0 : 1;
            v1[j + 1] = Math.min(
                v1[j] + 1,       // Deletion
                v0[j + 1] + 1,   // Insertion
                v0[j] + cost     // Substitution
            );
        }

        // Swap arrays for next iteration (copy v1 to v0)
        for (let j = 0; j < v0.length; j++) v0[j] = v1[j];
    }

    return v1[t.length];
};

const getSimilarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
};

const fetchAircraftMetadata = async () => {
    if (Date.now() - lastAircraftCacheUpdate < 3600000 && cachedAircraftData.length > 0) {
        return cachedAircraftData;
    }
    try {
        const response = await axios.get(METADATA_API_URL);
        if (response.data && response.data.aircraft) {
            cachedAircraftData = response.data.aircraft.map(a => ({
                name: a.name,
                id: a.id
            })).sort((a, b) => b.name.length - a.name.length); 
            
            lastAircraftCacheUpdate = Date.now();
            console.log(`✈️  Cached ${cachedAircraftData.length} aircraft types.`);
        }
        return cachedAircraftData;
    } catch (error) {
        console.error('❌ Failed to fetch aircraft metadata:', error.message);
        return [];
    }
};

const LIVERY_CACHE_MAX = 200; // hard cap so the janitor isn't the only thing keeping us bounded

const fetchLiveriesForAircraft = async (aircraftId) => {
    const now = Date.now();
    if (cachedLiveries[aircraftId] && (now - cachedLiveries[aircraftId].timestamp < 300000)) {
        return cachedLiveries[aircraftId].data;
    }

    try {
        const url = `${BASE_API_URL}/aircraft/${aircraftId}/liveries`;
        const response = await axios.get(url);
        let liveryList = [];
        if (response.data && response.data.liveries) {
            liveryList = response.data.liveries.map(l => l.name).sort();
        }
        cachedLiveries[aircraftId] = { timestamp: now, data: liveryList };

        // Evict the oldest entry if we're over the cap.
        const keys = Object.keys(cachedLiveries);
        if (keys.length > LIVERY_CACHE_MAX) {
            let oldestKey = keys[0];
            let oldestTs = cachedLiveries[oldestKey].timestamp;
            for (const k of keys) {
                if (cachedLiveries[k].timestamp < oldestTs) {
                    oldestKey = k;
                    oldestTs = cachedLiveries[k].timestamp;
                }
            }
            delete cachedLiveries[oldestKey];
        }

        return liveryList;
    } catch (error) {
        console.error(`❌ Failed to fetch liveries for ID ${aircraftId}:`, error.message);
        return [];
    }
};

const lookupRegistration = (aircraftType, liveryName) => {
    if (!aircraftRegistry || !Array.isArray(aircraftRegistry)) return null;

    const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const targetType = clean(aircraftType);
    const targetLivery = clean(liveryName);
    
    const useFuzzy = targetType.length > 3 && targetLivery.length > 3;

    let bestMatch = null;
    let highestScore = 0;

    for (const entry of aircraftRegistry) {
        let score = 0;

        const jsonMan = clean(entry.manufacturer);
        const jsonMod = clean(entry.model);
        const jsonLivery = clean(entry.livery);
        const jsonFullPlane = jsonMan + jsonMod; 

        let liveryScore = 0;
        
        if (targetLivery === jsonLivery) liveryScore = 20;
        else if (targetLivery.includes(jsonLivery) || jsonLivery.includes(targetLivery)) liveryScore = 15;
        else if (useFuzzy) {
            const sim = getSimilarity(targetLivery, jsonLivery);
            if (sim > 0.8) liveryScore = 10 * sim; 
        }

        if (liveryScore < 5) continue; 
        score += liveryScore;

        let aircraftScore = 0;

        if (targetType === jsonMod) aircraftScore = 50;
        else if (targetType === jsonFullPlane) aircraftScore = 60;
        
        else if (targetType.includes(jsonMod)) {
            aircraftScore = 40;
            if (targetType.includes(jsonMan)) aircraftScore += 10;
        }
        else if (jsonFullPlane.includes(targetType)) aircraftScore = 20;

        else if (useFuzzy) {
            const modSim = getSimilarity(targetType, jsonMod);
            const fullSim = getSimilarity(targetType, jsonFullPlane);
            
            if (modSim > 0.85) aircraftScore = 30 * modSim;
            else if (fullSim > 0.85) aircraftScore = 35 * fullSim;
        }

        if (aircraftScore === 0) continue;

        score += aircraftScore;

        if (score > highestScore) {
            highestScore = score;
            bestMatch = entry;
        }
    }

    return (bestMatch && highestScore > 15) ? bestMatch.registration : null;
};

const normalizeData = async (rawType, rawLivery) => {
    let finalType = rawType.trim();
    let finalLivery = rawLivery.trim();
    let aircraftId = null;

    let matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase() === finalType.toLowerCase());
    
    if (!matchedAircraft) {
        matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase().includes(finalType.toLowerCase()));
    }

    if (!matchedAircraft && finalType.length > 4) {
        let bestFuzzy = null;
        let bestScore = 0;
        
        for (const ac of cachedAircraftData) {
            const sim = getSimilarity(finalType.toLowerCase(), ac.name.toLowerCase());
            if (sim > 0.7 && sim > bestScore) { 
                bestScore = sim;
                bestFuzzy = ac;
            }
        }
        if (bestFuzzy) matchedAircraft = bestFuzzy;
    }

    if (matchedAircraft) {
        finalType = matchedAircraft.name; 
        aircraftId = matchedAircraft.id;  
    }

    if (aircraftId) {
        const validLiveries = await fetchLiveriesForAircraft(aircraftId);
        
        let matchedLivery = validLiveries.find(l => l.toLowerCase() === finalLivery.toLowerCase());
        
        if (!matchedLivery) {
            matchedLivery = validLiveries.find(l => l.toLowerCase().includes(finalLivery.toLowerCase()));
        }

        if (!matchedLivery && finalLivery.length > 4) {
            let bestLiv = null;
            let bestScore = 0;
            for (const l of validLiveries) {
                const sim = getSimilarity(finalLivery.toLowerCase(), l.toLowerCase());
                if (sim > 0.75 && sim > bestScore) {
                    bestScore = sim;
                    bestLiv = l;
                }
            }
            if (bestLiv) matchedLivery = bestLiv;
        }

        if (matchedLivery) {
            finalLivery = matchedLivery; 
        }
    }

    return { type: finalType, livery: finalLivery };
};

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region, models = {}) => {
    const { DailyPilotStats, VirtualAirlineAd, Giveaway, VaTermsAcceptance } = models;

    // NOTE: `Options.cacheEverything()` is the *opposite* of what we want — it
    // caches everything with no caps and silently ignores the limits passed to
    // it. `cacheWithLimits` is the API that actually honours these numbers and
    // keeps memory bounded.
    const client = new Client({
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: 50,
            UserManager: 100,
            GuildMemberManager: 100,
            ThreadManager: 10,
            PresenceManager: 0,
            VoiceStateManager: 0,
            GuildEmojiManager: 0,
            GuildStickerManager: 0,
            ReactionManager: 0,
            ReactionUserManager: 0,
            StageInstanceManager: 0,
            GuildInviteManager: 0,
            GuildScheduledEventManager: 0,
            AutoModerationRuleManager: 0,
            BaseGuildEmojiManager: 0
        }),
        sweepers: {
            ...Options.DefaultSweeperSettings,
            messages: { interval: 300, lifetime: 900 },
            users: {
                interval: 3600,
                filter: () => user => user.id !== client.user.id
            },
            threads: { interval: 3600, lifetime: 3600 }
        },
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent
        ]
    });

    // Discord client error surface — without these, transport errors bubble up
    // as unhandled rejections and (without the process-level guards in server.js)
    // would take down the whole API.
    client.on('error', (err) => console.error('🤖 Discord client error:', err && err.message ? err.message : err));
    client.on('shardError', (err) => console.error('🤖 Discord shard error:', err && err.message ? err.message : err));
    client.on('warn', (msg) => console.warn('🤖 Discord warn:', msg));
    client.on('invalidated', () => console.error('🤖 Discord session invalidated — login required.'));

    // --- HELPER: LOG MODERATION ACTION ---
    const logModAction = async (actionType, executor, target, reason, details = '') => {
        try {
            const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
            if (!transcriptChannel) return;

            const colorMap = {
                'KICK': 0xFFA500, // Orange
                'BAN': 0xFF0000, // Red
                'UNBAN': 0x00FF00, // Green
                'TIMEOUT': 0xFFFF00, // Yellow
                'UNTIMEOUT': 0x00FF99, // Teal
                'WARN': 0xFFD700, // Gold
                'PURGE': 0x808080, // Grey
                'LOCK': 0xFF0000, // Red
                'UNLOCK': 0x00FF00, // Green
                'ANNOUNCE': 0x0099FF // Blue
            };

            const logEmbed = new EmbedBuilder()
                .setTitle(`🛡️ Admin Action: ${actionType}`)
                .setColor(colorMap[actionType] || 0xFFFFFF)
                .addFields(
                    { name: 'Executor', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
                    { name: 'Target', value: target ? `${target.tag || target.user?.tag || target} (<@${target.id || target}>)` : 'N/A', inline: true },
                    { name: 'Reason', value: reason || 'No reason provided', inline: false }
                )
                .setTimestamp();

            if (details) logEmbed.addFields({ name: 'Additional Details', value: details });

            await transcriptChannel.send({ embeds: [logEmbed] });
        } catch (error) {
            console.error('❌ Failed to log mod action:', error);
        }
    };

    // --- HELPER: PERSIST A GIVEAWAY (upsert the live state to the database) ---
    // Called on create, on every entry, and when a giveaway ends so the DB
    // always reflects the in-memory state and can rebuild it after a restart.
    const persistGiveaway = async (messageId) => {
        if (!Giveaway) return;
        const g = activeGiveaways.get(messageId);
        if (!g) return;
        try {
            await Giveaway.updateOne(
                { messageId },
                {
                    messageId,
                    channelId: g.channelId,
                    prize: g.prize,
                    delivery: g.delivery,
                    hostId: g.hostId,
                    entrants: Array.from(g.entrants),
                    endsAt: new Date(g.endsAt),
                    ended: g.ended
                },
                { upsert: true }
            );
        } catch (e) {
            console.error('❌ Failed to persist giveaway:', e);
        }
    };

    // --- HELPER: SCHEDULE A GIVEAWAY'S END ---
    // setTimeout overflows for delays beyond ~24.8 days (its max is a signed
    // 32-bit int of milliseconds), silently firing immediately instead. Clamp
    // long delays and re-arm in chunks; fire now if the end time has passed.
    const MAX_TIMEOUT_MS = 2147483647;
    const scheduleGiveawayEnd = (messageId, endsAt) => {
        const delay = endsAt - Date.now();
        if (delay <= 0) {
            endGiveaway(messageId);
            return;
        }
        if (delay > MAX_TIMEOUT_MS) {
            setTimeout(() => scheduleGiveawayEnd(messageId, endsAt), MAX_TIMEOUT_MS);
            return;
        }
        setTimeout(() => endGiveaway(messageId), delay);
    };

    // --- HELPER: END A GIVEAWAY (pick a winner, announce, hand off to staff) ---
    const endGiveaway = async (messageId) => {
        const g = activeGiveaways.get(messageId);
        if (!g || g.ended) return;
        g.ended = true;

        try {
            const channel = await client.channels.fetch(g.channelId).catch(() => null);
            const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;

            const entrants = Array.from(g.entrants);
            const winnerId = entrants.length ? entrants[Math.floor(Math.random() * entrants.length)] : null;

            const endedEmbed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Ended')
                .setColor(THEME.WHITE)
                .setFooter({ text: BRAND_FOOTER })
                .addFields(
                    { name: 'Prize', value: g.prize, inline: false },
                    { name: 'Entries', value: `${entrants.length}`, inline: true },
                    { name: 'Winner', value: winnerId ? `<@${winnerId}>` : 'No valid entries 😢', inline: true }
                )
                .setTimestamp();

            // Lock the original message (remove the Enter button).
            if (message) await message.edit({ embeds: [endedEmbed], components: [] }).catch(() => {});

            if (!winnerId) {
                if (channel) await channel.send('🎉 The giveaway ended but nobody entered — no winner this time!').catch(() => {});
                return;
            }

            const winnerTag = `<@${winnerId}>`;

            // Public announcement in the giveaway channel.
            if (channel) {
                await channel.send({ content: `🎉 Congratulations ${winnerTag}! You won **${g.prize}**!`, embeds: [endedEmbed] }).catch(() => {});
            }

            // Hand the winner off to staff so the prize can be fulfilled.
            if (g.delivery === 'ticket') {
                try {
                    const ticketParent = await client.channels.fetch(GIVEAWAY_TICKET_CHANNEL_ID).catch(() => null);
                    if (ticketParent && ticketParent.threads) {
                        const thread = await ticketParent.threads.create({
                            name: `giveaway-winner-${winnerId}`,
                            type: ChannelType.PrivateThread,
                            reason: 'Giveaway winner prize fulfillment'
                        });
                        await thread.members.add(winnerId).catch(() => {});
                        const tEmbed = new EmbedBuilder()
                            .setTitle('🎁 Giveaway Winner — Prize Fulfillment')
                            .setColor(THEME.WHITE)
                            .setDescription('Please deliver the prize to the winner and close this ticket when done.')
                            .addFields(
                                { name: 'Winner', value: winnerTag, inline: true },
                                { name: 'Prize', value: g.prize, inline: true },
                                { name: 'Hosted by', value: `<@${g.hostId}>`, inline: true }
                            )
                            .setTimestamp();
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
                        );
                        await thread.send({ content: `<@&${ADMIN_ROLE_ID}> ${winnerTag}`, embeds: [tEmbed], components: [row] });
                    }
                } catch (e) { console.error('❌ Failed to open giveaway winner ticket:', e); }
            } else {
                try {
                    const modChannel = await client.channels.fetch(GIVEAWAY_MOD_CHANNEL_ID).catch(() => null);
                    if (modChannel) {
                        const mEmbed = new EmbedBuilder()
                            .setTitle('🎁 Giveaway Winner — Action Needed')
                            .setColor(THEME.WHITE)
                            .setDescription('Please deliver the prize to the winner below.')
                            .addFields(
                                { name: 'Winner', value: winnerTag, inline: true },
                                { name: 'Prize', value: g.prize, inline: true },
                                { name: 'Hosted by', value: `<@${g.hostId}>`, inline: true },
                                { name: 'Total Entries', value: `${entrants.length}`, inline: true }
                            )
                            .setTimestamp();
                        await modChannel.send({ content: `<@&${ADMIN_ROLE_ID}>`, embeds: [mEmbed] });
                    }
                } catch (e) { console.error('❌ Failed to send giveaway winner mod message:', e); }
            }
        } catch (e) {
            console.error('❌ endGiveaway error:', e);
        } finally {
            // Mark it ended in the DB so a restart won't resurrect it, then
            // drop the in-memory copy.
            if (Giveaway) {
                await Giveaway.updateOne({ messageId }, { ended: true }).catch(() => {});
            }
            activeGiveaways.delete(messageId);
        }
    };

    // ===================== VA (VIRTUAL AIRLINE) SYSTEM =====================

    // Turn a VA name into a valid Discord channel slug.
    const vaChannelSlug = (name) => {
        const slug = (name || 'va').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
        return slug || 'virtual-airline';
    };

    // Render a VA's stored base radio callsign in Infinite Flight VA format.
    // We store just the base (e.g. "OCEAN"); pilots fly as "OCEAN ##VA", with the
    // "##" standing in for their individual pilot number — like Discover Virtual's
    // "Ocean ##VA". Tolerates a base that already carries the suffix so we never
    // double it up (e.g. "OCEAN VA" or "OCEAN ##VA" → "OCEAN ##VA").
    const formatVaCallsign = (base) => {
        if (!base) return null;
        const clean = String(base).trim().toUpperCase()
            .replace(/\s*#+\s*VA$/i, '')   // strip an existing "##VA"
            .replace(/\s+VA$/i, '')         // ...or a bare trailing "VA"
            .trim();
        return clean ? `${clean} ##VA` : null;
    };

    // The card pinned inside a VA's private channel (and shown on approval).
    const buildVaInfoEmbed = (ad) => {
        const embed = new EmbedBuilder()
            .setTitle(`✈️ ${ad.name}`)
            .setColor(THEME.WHITE)
            .setFooter({ text: BRAND_FOOTER })
            .setTimestamp();
        if (ad.tagline) embed.setDescription(ad.tagline);

        const fields = [{ name: 'Type', value: ad.type || 'VA', inline: true }];
        if (ad.callsign) fields.push({ name: 'Callsign', value: formatVaCallsign(ad.callsign), inline: true });
        if (ad.region) fields.push({ name: 'Region', value: ad.region, inline: true });
        if (ad.hubs && ad.hubs.length) fields.push({ name: 'Hubs', value: ad.hubs.join(', '), inline: true });
        fields.push({ name: 'Recruiting', value: ad.recruiting ? 'Yes ✅' : 'No', inline: true });

        const links = [];
        if (ad.websiteUrl) links.push(`[Website](${ad.websiteUrl})`);
        if (ad.applicationUrl) links.push(`[Apply](${ad.applicationUrl})`);
        if (ad.discordUrl) links.push(`[Discord](${ad.discordUrl})`);
        if (ad.ifcThreadUrl) links.push(`[IFC Thread](${ad.ifcThreadUrl})`);
        if (links.length) fields.push({ name: 'Links', value: links.join(' • '), inline: false });

        embed.addFields(fields);
        if (ad.logoUrl) { try { embed.setThumbnail(ad.logoUrl); } catch (_) {} }
        if (ad.bannerUrl) { try { embed.setImage(ad.bannerUrl); } catch (_) {} }
        return embed;
    };

    // The embed staff see in the review channel for a pending application.
    const buildVaReviewEmbed = (ad) => new EmbedBuilder()
        .setTitle('🆕 VA Application — Pending Review')
        .setColor(THEME.GRAY)
        .addFields(
            { name: 'Name', value: ad.name, inline: true },
            { name: 'Type', value: ad.type || 'VA', inline: true },
            { name: 'Callsign', value: formatVaCallsign(ad.callsign) || '—', inline: true },
            { name: 'Owner', value: ad.ownerId ? `<@${ad.ownerId}>` : (ad.ownerName || 'Unknown'), inline: true },
            { name: 'Tagline', value: ad.tagline || '—', inline: false },
            { name: 'Links', value: [ad.websiteUrl, ad.discordUrl].filter(Boolean).join('\n') || '—', inline: false }
        )
        .setFooter({ text: `Application ID: ${ad._id}` })
        .setTimestamp();

    const buildVaReviewButtons = (id) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`va_approve_${id}`).setLabel('Approve & Create').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`va_edit_${id}`).setLabel('Request Edits').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId(`va_reject_${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    // The short /va_apply form only captures the basics. Once a VA is approved and
    // its private channel exists, we post this card so the owner can fill in
    // everything the directory card wants — banner, logo, description, hubs, etc.
    // Buttons carry the ad id so the handlers know which VA they're editing.
    const buildVaSetupCard = (ad) => {
        const missing = [];
        if (!ad.bannerUrl) missing.push('banner');
        if (!ad.logoUrl) missing.push('logo');
        if (!ad.description) missing.push('description');
        if (!ad.region || ad.region === 'Global') missing.push('region');
        if (!ad.hubs || !ad.hubs.length) missing.push('hubs');
        if (!ad.fleet || !ad.fleet.length) missing.push('fleet');

        const embed = new EmbedBuilder()
            .setTitle('🧩 Finish setting up your VA listing')
            .setColor(THEME.WHITE)
            .setDescription(
                "Your VA is approved and live, but the application only captured the basics. " +
                "Tap the buttons below to plug in the rest so your directory card looks complete.\n\n" +
                "• **Add Details** — description, region, hubs, fleet, requirements\n" +
                "• **Links & Recruiting** — apply link, IFC thread, min grade, pilot count, tags\n" +
                "• **Upload Banner / Logo** — send the image as your next message here" +
                (missing.length
                    ? `\n\n**Still missing:** ${missing.join(', ')}`
                    : "\n\n✅ Everything's filled in — thanks!")
            )
            .setFooter({ text: BRAND_FOOTER });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`va_setup_details_${ad._id}`).setLabel('Add Details').setStyle(ButtonStyle.Primary).setEmoji('📝'),
            new ButtonBuilder().setCustomId(`va_setup_links_${ad._id}`).setLabel('Links & Recruiting').setStyle(ButtonStyle.Secondary).setEmoji('🔗'),
            new ButtonBuilder().setCustomId(`va_setup_banner_${ad._id}`).setLabel('Upload Banner').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
            new ButtonBuilder().setCustomId(`va_setup_logo_${ad._id}`).setLabel('Upload Logo').setStyle(ButtonStyle.Secondary).setEmoji('🏷️')
        );
        return { embeds: [embed], components: [row] };
    };

    // ---- VA PARTNERSHIP TICKET FLOW ------------------------------------------
    // The /va_apply modal, factored out so both the slash command and the
    // partnership ticket's "Start VA Application" button can present it.
    const buildVaApplyModal = () => {
        const modal = new ModalBuilder().setCustomId('va_apply_modal').setTitle('VA / VO Application');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_name').setLabel('VA / VO Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_callsign').setLabel('Radio Callsign (pilots fly as NAME ##VA)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setPlaceholder('e.g. Ocean (pilots fly as OCEAN ##VA)')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_type').setLabel('Type — VA or VO').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2).setPlaceholder('VA')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_tagline').setLabel('Short description / tagline').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(140)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_links').setLabel('Website + Discord (one per line)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300))
        );
        return modal;
    };

    // Version this so a future ToS revision can re-prompt previous accepters.
    const VA_PARTNERSHIP_TOS_VERSION = 'v1';

    // The official VA Advertisement Program Terms & Conditions, shipped as a PDF
    // in the repo and attached to the partnership ticket so VAs get the real
    // contract (not a paraphrase). Path resolves next to this file.
    const VA_TERMS_PDF_PATH = path.join(__dirname, 'VA-Advertisement-Terms.pdf');

    // The partnership Terms of Service shown inside the ticket. The full contract
    // is attached as a PDF; the embed summarises the key obligations and points
    // users at it + the Inflight VA Rep for questions.
    const buildPartnershipTosCard = () => {
        const embed = new EmbedBuilder()
            .setTitle('📄 Inflight VA Advertisement Program — Terms & Conditions')
            .setColor(THEME.WHITE)
            .setDescription(
                "Please read our **Terms & Conditions** (attached as a PDF above) before continuing. " +
                "By accepting, your VA agrees to the full contract. Key points:\n\n" +
                "• **Free program** — a directory advertising your VA across our platform, subject to staff approval.\n" +
                "• **Event tracking** — any event you announce or run **must be tracked using Inflight**, with a screenshot from our tracker.\n" +
                "• **Accurate content** — listing info, logos and banners must be accurate, owned by you, and not offensive or infringing.\n" +
                "• **Staff authority** — Inflight may review, edit, approve, decline, feature or remove any listing at our discretion.\n" +
                "• **iOS app** — VA listings are **not** shown in our iOS app for copyright-compliance reasons.\n" +
                "• **Changes/suspension** — required changes not made within **7 days** of contact may lead to suspension.\n\n" +
                "If you have **any questions**, please inquire our Inflight VA Rep <@&" + INFLIGHT_VA_REP_ROLE_ID + "> right here in this ticket.\n\n" +
                "When you've read the attached Terms and agree, tap **I Accept** below."
            )
            .setFooter({ text: `${BRAND_FOOTER} • Terms ${VA_PARTNERSHIP_TOS_VERSION}` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('partnership_accept_tos').setLabel('I Accept').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
        );

        const payload = { embeds: [embed], components: [row] };
        // Attach the real contract if the PDF is present (best-effort).
        try {
            if (fs.existsSync(VA_TERMS_PDF_PATH)) {
                payload.files = [new AttachmentBuilder(VA_TERMS_PDF_PATH, { name: 'Inflight-VA-Advertisement-Terms.pdf' })];
            }
        } catch (_) { /* ship the embed without the attachment */ }
        return payload;
    };

    // Pull the Inflight VA Rep(s) into a (private) ticket thread so the role
    // mention actually reaches people who can see the channel. Best-effort and
    // capped so we never iterate a huge member list.
    const addInflightRepsToThread = async (thread, guild) => {
        try {
            const role = guild.roles.cache.get(INFLIGHT_VA_REP_ROLE_ID)
                || await guild.roles.fetch(INFLIGHT_VA_REP_ROLE_ID).catch(() => null);
            if (!role) return;
            // role.members is populated from the guild member cache; fetch members
            // first so it isn't empty on a cold cache.
            await guild.members.fetch().catch(() => {});
            let added = 0;
            for (const member of role.members.values()) {
                if (added >= 25) break;
                await thread.members.add(member.id).catch(() => {});
                added++;
            }
        } catch (e) {
            console.error('❌ addInflightRepsToThread error:', e);
        }
    };

    // Create and seed a VA partnership ticket: private thread, rep pinged + added,
    // then the ToS card.
    const openPartnershipTicket = async (interaction) => {
        const thread = await interaction.channel.threads.create({
            name: `partnership-${interaction.user.username}`.slice(0, 90),
            type: ChannelType.PrivateThread,
            reason: 'VA Partnership ticket'
        });
        await thread.members.add(interaction.user.id).catch(() => {});
        await addInflightRepsToThread(thread, interaction.guild);

        await thread.send({
            content: `<@${interaction.user.id}> <@&${INFLIGHT_VA_REP_ROLE_ID}>`,
            embeds: [new EmbedBuilder()
                .setTitle('🤝 VA Partnership Request')
                .setColor(THEME.WHITE)
                .setDescription(
                    `Welcome <@${interaction.user.id}>! Our Inflight VA Rep has been pinged and will help you set up a partnership.\n\n` +
                    `Partnering with Inflight gets your VA a private channel, a directory listing, and access to our reps chat.`
                )
                .setFooter({ text: BRAND_FOOTER })]
        });
        await thread.send(buildPartnershipTosCard());
        return thread;
    };

    // Who may review VA applications (Approve & Create / Request Edits / Reject):
    // admins, anyone with the Administrator permission, or the Inflight VA Rep.
    const canReviewVa = (member) =>
        !!member?.roles?.cache?.has(ADMIN_ROLE_ID) ||
        !!member?.roles?.cache?.has(INFLIGHT_VA_REP_ROLE_ID) ||
        !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);

    // Only the VA's owner (or staff) may edit its listing.
    const canManageVa = (interaction, ad) =>
        (ad.ownerId && interaction.user.id === ad.ownerId) ||
        !!interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID) ||
        !!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

    // Download a Discord image attachment and push it to S3 as the VA's banner or
    // logo. Runs from a message collector started by the Upload buttons below.
    const handleVaImageUpload = async (channel, user, ad, kind) => {
        const prompt = await channel.send(`📥 <@${user.id}> — send your **${kind}** image as your next message in this channel (PNG/JPG, within 2 minutes).`);
        const collector = channel.createMessageCollector({
            filter: (m) => m.author.id === user.id && m.attachments.size > 0,
            max: 1,
            time: 120000
        });

        collector.on('collect', async (msg) => {
            const att = msg.attachments.first();
            const isImage = (att.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(att.name || '');
            if (!isImage) {
                await channel.send(`❌ That didn't look like an image. Tap **Upload ${kind === 'banner' ? 'Banner' : 'Logo'}** again to retry.`).catch(() => {});
                return;
            }
            try {
                const resp = await axios.get(att.url, { responseType: 'arraybuffer' });
                const ref = ad.callsign || ad.name;
                const url = await uploadVaImage(s3Client, { buffer: Buffer.from(resp.data) }, ref, kind);

                // Swap out the old image so we don't orphan it in the bucket.
                // Re-read the live doc so we delete the CURRENT image (not a stale
                // one captured when the button was clicked) and write only this
                // single field — a stale full-document save could otherwise
                // resurrect a just-replaced image URL and leak the new one.
                const field = kind === 'banner' ? 'bannerUrl' : 'logoUrl';
                const fresh = VirtualAirlineAd ? await VirtualAirlineAd.findById(ad._id).catch(() => null) : null;
                const oldUrl = fresh ? fresh[field] : (kind === 'banner' ? ad.bannerUrl : ad.logoUrl);
                if (oldUrl && oldUrl !== url) await deleteVaImage(s3Client, oldUrl).catch(() => {});

                const updated = VirtualAirlineAd
                    ? await VirtualAirlineAd.findByIdAndUpdate(ad._id, { [field]: url, updatedAt: new Date() }, { new: true }).catch(() => null)
                    : null;
                // Keep the in-memory ad in sync for the confirmation embed.
                if (updated) { ad.bannerUrl = updated.bannerUrl; ad.logoUrl = updated.logoUrl; }
                else { ad[field] = url; await ad.save().catch(() => {}); }

                await channel.send({ content: `✅ ${kind === 'banner' ? 'Banner' : 'Logo'} updated!`, embeds: [buildVaInfoEmbed(updated || ad)] }).catch(() => {});
            } catch (e) {
                console.error(`❌ VA ${kind} upload error:`, e);
                await channel.send(`❌ Couldn't process that image. Please try again.`).catch(() => {});
            }
        });

        collector.on('end', (collected) => {
            if (collected.size === 0) channel.send(`⌛ <@${user.id}> — ${kind} upload timed out. Tap the button again when you're ready.`).catch(() => {});
            prompt.delete().catch(() => {});
        });
    };

    // Find-or-create the shared "VA Rep" role and make sure it can see the reps
    // general chat. Called on every provision so the wiring self-heals.
    const ensureVaRepRole = async (guild) => {
        try {
            let role = guild.roles.cache.find(r => r.name === VA_REP_ROLE_NAME)
                || (await guild.roles.fetch().then(rs => rs.find(r => r.name === VA_REP_ROLE_NAME)).catch(() => null));
            if (!role) {
                role = await guild.roles.create({ name: VA_REP_ROLE_NAME, color: 0x3BA55D, mentionable: true, reason: 'Shared VA representative role' });
            }
            const repsChat = await guild.channels.fetch(VA_REPS_CHAT_ID).catch(() => null);
            if (repsChat && !repsChat.permissionOverwrites.cache.get(role.id)) {
                await repsChat.permissionOverwrites.edit(role.id, {
                    ViewChannel: true, SendMessages: true, ReadMessageHistory: true
                }).catch(() => {});
            }
            return role;
        } catch (e) {
            console.error('❌ ensureVaRepRole error:', e);
            return null;
        }
    };

    // Provision (idempotently) a VA's role + private channel, grant the owner the
    // VA role and the shared rep role, and persist the IDs back onto the ad.
    const provisionVaSpace = async (guild, ad) => {
        const result = { role: null, channel: null, repRole: null };

        // 1. VA-specific role (reuse if already linked).
        let vaRole = ad.discordRoleId
            ? (guild.roles.cache.get(ad.discordRoleId) || await guild.roles.fetch(ad.discordRoleId).catch(() => null))
            : null;
        if (!vaRole) {
            vaRole = await guild.roles.create({
                name: ad.name.slice(0, 90),
                color: Math.floor(Math.random() * 0xFFFFFF),
                mentionable: true,
                reason: `VA space for ${ad.name}`
            });
            ad.discordRoleId = vaRole.id;
        }
        result.role = vaRole;

        // 2. Shared rep role + reps chat access.
        result.repRole = await ensureVaRepRole(guild);

        // 3. Private VA channel under the category (reuse if already linked).
        let channel = ad.discordChannelId
            ? (guild.channels.cache.get(ad.discordChannelId) || await guild.channels.fetch(ad.discordChannelId).catch(() => null))
            : null;
        if (!channel) {
            channel = await guild.channels.create({
                name: vaChannelSlug(ad.name),
                type: ChannelType.GuildText,
                parent: VA_CATEGORY_ID,
                topic: `${ad.type || 'VA'} • ${formatVaCallsign(ad.callsign) || ad.name} — private VA channel`,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: vaRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                    // Inflight VA Rep gets eyes on every VA channel.
                    { id: INFLIGHT_VA_REP_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                    { id: ADMIN_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] }
                ],
                reason: `VA space for ${ad.name}`
            });
            ad.discordChannelId = channel.id;
            try {
                const info = await channel.send({ content: `Welcome to **${ad.name}**! 🛫`, embeds: [buildVaInfoEmbed(ad)] });
                await info.pin().catch(() => {});
                // Right after provisioning, ask the owner for everything the short
                // application form didn't capture (banner, logo, full details).
                await channel.send({
                    content: ad.ownerId ? `<@${ad.ownerId}>` : undefined,
                    ...buildVaSetupCard(ad)
                });
            } catch (_) { /* pin/send best-effort */ }
        }
        result.channel = channel;

        // 3b. Self-heal: make sure the Inflight VA Rep can see this channel even
        // if it was provisioned before this role existed.
        if (channel && !channel.permissionOverwrites.cache.get(INFLIGHT_VA_REP_ROLE_ID)) {
            await channel.permissionOverwrites.edit(INFLIGHT_VA_REP_ROLE_ID, {
                ViewChannel: true, SendMessages: true, ReadMessageHistory: true
            }).catch(() => {});
        }

        // 4. Give the owner the VA role + the shared rep role.
        if (ad.ownerId) {
            const owner = await guild.members.fetch(ad.ownerId).catch(() => null);
            if (owner) {
                await owner.roles.add(vaRole).catch(() => {});
                if (result.repRole) await owner.roles.add(result.repRole).catch(() => {});
            }
        }

        // 5. Persist the linkage.
        if (ad.save) { try { await ad.save(); } catch (e) { console.error('❌ Failed to save VA ad linkage:', e.message); } }

        return result;
    };

    const uploadImageToS3 = async (url, tailNumber) => {
        let tempOutputPath = null;
        let fileStream = null;
        
        try {
            const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
            // We only need an output path. Input is processed in-memory via streams.
            tempOutputPath = path.join(os.tmpdir(), `processed_${uniqueId}.webp`);

            // 1. Fetch the stream
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream'
            });

            // 2. Create the Sharp pipeline
            // We pipe the Axios stream directly into Sharp, then to the file system.
            // This prevents loading the full image into RAM and avoids writing a raw temp file.
            const transformer = sharp()
                .resize({ width: 1920, withoutEnlargement: true })
                .webp({ quality: 80 });

            await pipeline(
                response.data,
                transformer,
                fs.createWriteStream(tempOutputPath)
            );

            // 3. Prepare upload
            const stats = await fsPromises.stat(tempOutputPath);
            const cleanTail = (tailNumber || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
            const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`;
            
            // Create the stream for S3
            fileStream = fs.createReadStream(tempOutputPath);

            const uploadCommand = new PutObjectCommand({
                Bucket: bucketName,
                Key: fileName,
                Body: fileStream,
                ContentType: 'image/webp',
                ContentLength: stats.size 
            });

            await s3Client.send(uploadCommand);

            // MEMORY FIX: Explicitly trigger GC after heavy image processing if enabled.
            // This cleans up the large Buffer objects immediately rather than waiting for the 10m timer.
            if (global.gc) {
                global.gc();
            }

            return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;

        } catch (error) {
            console.error('S3 Upload Error:', error);
            throw new Error('Failed to upload image to storage.');
        } finally {
            // cleanup: Destroy stream explicitly to release file handle
            if (fileStream) fileStream.destroy();
            
            // Delete the processed file
            if (tempOutputPath) {
                await fsPromises.unlink(tempOutputPath).catch(() => {});
            }
        }
    };

    // Delete a single stored image from S3 (used when a slot is replaced).
    const deleteImageFromS3 = async (url) => {
        if (!url) return;
        try {
            const key = new URL(url).pathname.substring(1); // strip leading '/'
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
            console.log(`🗑️ Deleted replaced S3 image: ${key}`);
        } catch (err) {
            console.error('S3 delete error:', err.message);
        }
    };

    // Normalize a record's images into an ordered array (handles legacy single-image docs).
    const getEntryImages = (entry) => {
        if (!entry) return [];
        if (Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0) return entry.imageUrls.filter(Boolean);
        return entry.imageUrl ? [entry.imageUrl] : [];
    };

    // Per-image contributors aligned to getEntryImages(). Slots without their own
    // attribution (legacy records) fall back to the entry's top-level contributor.
    const getEntryContributors = (entry) => {
        const imgs = getEntryImages(entry);
        const stored = (entry && Array.isArray(entry.imageContributors)) ? entry.imageContributors : [];
        return imgs.map((_, i) => {
            const c = stored[i];
            if (c && (c.name || c.id)) return { name: c.name || 'System', id: c.id || null };
            return { name: (entry && entry.contributorName) || 'System', id: (entry && entry.contributorId) || null };
        });
    };

    const MAX_AIRCRAFT_IMAGES = 3;

    // Build the admin review UI for an aircraft submission: mutates `mainEmbed`
    // (title/colour/description) and returns the slot-choice buttons plus a
    // comparison embed per existing photo. The admin chooses which of the (up to
    // 3) slots the submission lands in — Replace overwrites, Add appends.
    const buildAircraftReview = (mainEmbed, existingEntry, userId) => {
        const existingImages = getEntryImages(existingEntry);
        const extraEmbeds = [];
        const approveButtons = [];

        if (existingImages.length === 0) {
            // No photo yet: this is an "add" so the approval handler appends
            // against the live DB state rather than assuming a fixed slot.
            approveButtons.push(
                new ButtonBuilder().setCustomId(`approve_add_1_${userId}`).setLabel('Approve & Verify').setStyle(ButtonStyle.Success).setEmoji('✅')
            );
            mainEmbed.setTitle('📋 New Submission — Awaiting Review').setColor(SUB_STATE.PENDING.color)
                .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nNo photo on record yet for this aircraft.`);
        } else {
            const slotsToShow = Math.min(existingImages.length + 1, MAX_AIRCRAFT_IMAGES);
            for (let slot = 1; slot <= slotsToShow; slot++) {
                const isReplace = slot <= existingImages.length;
                // Encode the intent (add/replace) in the customId so the approval
                // handler re-checks the live image state instead of trusting the
                // slot number captured when these buttons were first rendered.
                const action = isReplace ? 'replace' : 'add';
                approveButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`approve_${action}_${slot}_${userId}`)
                        .setLabel(`${isReplace ? 'Replace' : 'Add'} Photo ${slot}`)
                        .setStyle(isReplace ? ButtonStyle.Primary : ButtonStyle.Success)
                        .setEmoji(isReplace ? '♻️' : '➕')
                );
            }
            mainEmbed.setTitle('♻️ Replacement / Additional Photo — Awaiting Review').setColor(SUB_STATE.PENDING.color)
                .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nThis aircraft already has **${existingImages.length}/${MAX_AIRCRAFT_IMAGES}** photo(s).\nChoose a slot below — **Replace** overwrites that photo, **Add** appends a new one.`);

            const existingContributors = getEntryContributors(existingEntry);
            existingImages.forEach((imgUrl, idx) => {
                const slotContributor = existingContributors[idx]?.name || 'Unknown';
                const compEmbed = new EmbedBuilder()
                    .setTitle(`🖼️ Current Photo ${idx + 1}`)
                    .setColor(THEME.GRAY)
                    .setImage(imgUrl)
                    .setFooter({ text: `Replacing Photo ${idx + 1} deletes this image.` });
                // Show who contributed each existing photo so admins know a replace
                // only overwrites that one slot's contributor, not the others.
                const lines = [`**Photo ${idx + 1} Contributor:** ${slotContributor}`];
                if (idx === 0) lines.push(`**Tail:** ${existingEntry.tailNumber || 'Unknown'}`);
                compEmbed.setDescription(lines.join('\n'));
                extraEmbeds.push(compEmbed);
            });
        }

        const components = [
            new ActionRowBuilder().addComponents(...approveButtons),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`edit_admin_${userId}`).setLabel('Edit Details').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
                new ButtonBuilder().setCustomId(`reject_${userId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
            )
        ];

        return { components, extraEmbeds };
    };

    // After an aircraft photo is approved, OTHER still-pending review cards in the
    // admin channel for the SAME aircraft were rendered against the old image count
    // (e.g. two users submit the same plane → both cards say "no photo yet"). Once
    // one is approved the others are stale: they still show the empty-state "Approve
    // & Verify" button instead of the live "Replace Photo 1 / Add Photo 2" choices.
    // Re-render those siblings against the freshly-updated entry so the admin sees
    // the real slot count and picks Add/Replace deliberately.
    const refreshPendingReviewsFor = async (typeField, liveryField, updatedEntry, skipMessageId) => {
        try {
            const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
            if (!adminChannel) return;
            const recent = await adminChannel.messages.fetch({ limit: 50 }).catch(() => null);
            if (!recent) return;
            for (const [, msg] of recent) {
                if (msg.id === skipMessageId) continue;
                if (!client.user || msg.author.id !== client.user.id) continue;
                if (!msg.components || msg.components.length === 0) continue;
                const embed = msg.embeds[0];
                if (!embed || !Array.isArray(embed.fields)) continue;
                // Only refresh cards that still carry approve buttons (i.e. unresolved
                // pending reviews — verified/rejected cards have their buttons stripped).
                const stillPending = msg.components.some(row =>
                    row.components.some(c => (c.customId || '').startsWith('approve_') && !(c.customId || '').startsWith('approve_apt_')));
                if (!stillPending) continue;
                const t = embed.fields.find(f => f.name === 'Aircraft Type')?.value;
                const l = embed.fields.find(f => f.name === 'Livery')?.value;
                if (!t || !l) continue;
                if (t.toLowerCase() !== typeField.toLowerCase() || l.toLowerCase() !== liveryField.toLowerCase()) continue;

                const submitterId = (embed.footer?.text || '').match(/User: (\d+)/)?.[1];
                if (!submitterId) continue;
                const refreshed = EmbedBuilder.from(embed);
                const review = buildAircraftReview(refreshed, updatedEntry, submitterId);
                // buildAircraftReview rewrites title/description but not the footer; keep
                // the pending footer (User/Msg/Ch ids) so later handlers can recover them.
                if (embed.footer?.text) refreshed.setFooter({ text: embed.footer.text });
                await msg.edit({ embeds: [refreshed, ...review.extraEmbeds], components: review.components }).catch(() => {});
            }
        } catch (e) {
            console.error('refreshPendingReviewsFor failed:', e);
        }
    };

    const startSubmissionFlow = async (source, rawType, rawLivery, ignoredTail, photoUrl, user, originChannelId) => {
        
        let currentType = rawType;
        let currentLivery = rawLivery;
        let currentTail = 'UNKNOWN'; 

        // Helper for initial checking (used for User Preview only)
        const checkDuplicate = async (t, l) => {
            try {
                const existing = await CommunityAircraftModel.findOne({ 
                    aircraftType: { $regex: new RegExp(`^${escapeRegex(t)}$`, "i") },
                    liveryName: { $regex: new RegExp(`^${escapeRegex(l)}$`, "i") }
                });
                return !!existing;
            } catch (err) { return false; }
        };

        try {
            const normalized = await normalizeData(currentType, currentLivery);
            currentType = normalized.type;
            currentLivery = normalized.livery;
        } catch (e) { console.error("Normalization error:", e); }

        const autoReg = lookupRegistration(currentType, currentLivery);
        if (autoReg) currentTail = autoReg;
        else currentTail = 'UNKNOWN';

        // Initial check for the User's Preview Embed
        let isDuplicate = await checkDuplicate(currentType, currentLivery);

        const createPreviewEmbed = (t, tp, l, imgUrl, isDup) => {
            const embed = themedEmbed(THEME.WHITE)
                .addFields(
                    { name: 'Aircraft Type', value: tp, inline: true },
                    { name: 'Livery', value: l, inline: true },
                    { name: 'Tail Number', value: t.toUpperCase(), inline: true },
                )
                // Reference the attached preview.webp file so the image lives
                // *inside* the embed. Without this, edits via editReply (which
                // drops re-attached files) leave a fields-only embed with no
                // visible preview.
                .setImage('attachment://preview.webp')
                .setFooter({ text: `${BRAND_FOOTER} • Confirm to submit` });

            if (isDup) {
                embed.setTitle('♻️ Existing Entry Detected')
                    .setColor(THEME.GRAY)
                    .setDescription(`We already have a photo for **${tp}** in **${l}** livery.\nThis will generally be treated as a **replacement or additional photo**.`);
            } else {
                embed.setTitle('📝 Review Your Submission')
                    .setDescription('I auto-detected the registration and tidied the names.\nConfirm the details below — or edit them first.');
            }
            return embed;
        };

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('confirm_submission').setLabel('Confirm & Submit').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('edit_details').setLabel('Edit Type/Livery').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('discard_submission').setLabel('Discard').setStyle(ButtonStyle.Danger),
            );

        const payload = { 
            embeds: [createPreviewEmbed(currentTail, currentType, currentLivery, photoUrl, isDuplicate)], 
            components: [row],
            files: [{ attachment: photoUrl, name: 'preview.webp' }] 
        };

        let reply;
        try {
            if (source.deferred || source.replied) reply = await source.editReply(payload);
            else reply = await source.reply({ ...payload, fetchReply: true });
        } catch (err) { return; }

        const finalPhotoUrl = reply.attachments.first() ? reply.attachments.first().url : photoUrl;
        const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collector.on('collect', async i => {
            if (i.user.id !== user.id) return i.reply({ content: "This is not your submission.", ephemeral: true });

            if (i.customId === 'discard_submission') {
                await i.update({ content: '🗑️ Submission discarded.', embeds: [], components: [], files: [] }); 
                userSessions.delete(user.id); 
                setTimeout(() => { if (reply) reply.delete().catch(() => {}); }, 5000);
                collector.stop();
                return;
            }

            if (i.customId === 'edit_details') {
                const modal = new ModalBuilder().setCustomId('editModal').setTitle('Edit Aircraft Details');
                
                const typeInput = new TextInputBuilder()
                    .setCustomId('m_type')
                    .setLabel("Aircraft Type")
                    .setPlaceholder("e.g. 737-8 MAX, 777-300ER, A321") 
                    .setValue(currentType)
                    .setStyle(TextInputStyle.Short);
                    
                const liveryInput = new TextInputBuilder()
                    .setCustomId('m_livery')
                    .setLabel("Livery Name")
                    .setPlaceholder("e.g. Delta Air Lines, Generic, Private") 
                    .setValue(currentLivery)
                    .setStyle(TextInputStyle.Short);

                modal.addComponents(new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput));
                await i.showModal(modal);

                const modalFilter = (submission) => submission.customId === 'editModal' && submission.user.id === user.id;
                
                try {
                    const submission = await i.awaitModalSubmit({ filter: modalFilter, time: 60000 });
                    await submission.deferUpdate(); 
                    
                    const editedType = submission.fields.getTextInputValue('m_type');
                    const editedLivery = submission.fields.getTextInputValue('m_livery');
                    
                    const normalized = await normalizeData(editedType, editedLivery);
                    currentType = normalized.type;
                    currentLivery = normalized.livery;

                    const reCheckReg = lookupRegistration(currentType, currentLivery);
                    currentTail = reCheckReg ? reCheckReg : 'UNKNOWN';

                    isDuplicate = await checkDuplicate(currentType, currentLivery);

                    await submission.editReply({ 
                        embeds: [createPreviewEmbed(currentTail, currentType, currentLivery, finalPhotoUrl, isDuplicate)],
                        components: [row] 
                    });

                } catch (e) { }
            }

            if (i.customId === 'confirm_submission') {
                await i.deferUpdate();

                const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
                const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);

                const attachmentData = { attachment: finalPhotoUrl, name: 'aircraft.webp' };

                // 1. Send to Public Feed (Pending Status)
                const publicEmbed = themedEmbed(SUB_STATE.PENDING.color)
                    .setTitle('📸 New Aircraft Spotted')
                    .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nA new photo has been submitted and is awaiting admin review.`)
                    .addFields(
                        { name: 'Aircraft', value: currentType, inline: true },
                        { name: 'Livery', value: currentLivery, inline: true },
                        { name: 'Tail Number', value: currentTail.toUpperCase(), inline: true },
                        { name: 'Spotted By', value: `<@${user.id}>`, inline: false }
                    )
                    // Render the photo INSIDE the embed (not as a loose attachment)
                    // so the layout matches the verified state after approval.
                    .setImage('attachment://aircraft.webp')
                    .setTimestamp();

                const publicMsg = await feedChannel.send({ embeds: [publicEmbed], files: [attachmentData] });

                // 2. Prepare Admin Embeds
                const finalEmbed = new EmbedBuilder()
                    .addFields(
                        { name: 'Contributor', value: `<@${user.id}>`, inline: true },
                        { name: 'Tail Number', value: currentTail.toUpperCase(), inline: true },
                        { name: 'Aircraft Type', value: currentType, inline: true },
                        { name: 'Livery', value: currentLivery, inline: true },
                    )
                    .setTimestamp();

                // --- KEY FIX: Force Fresh Duplicate Check for Admins ---
                // We do NOT rely on the previous 'isDuplicate' boolean here.
                // We perform a real-time lookup right before sending to admin.
                let existingEntry = null;
                try {
                    existingEntry = await CommunityAircraftModel.findOne({
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(currentType)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(currentLivery)}$`, "i") }
                    });
                } catch(e) { console.error("Error fetching duplicate for comparison", e); }

                // Build the admin slot-choice UI (buttons + per-photo comparison embeds).
                const { components: adminComponents, extraEmbeds } = buildAircraftReview(finalEmbed, existingEntry, user.id);
                const embedsToSend = [finalEmbed, ...extraEmbeds];

                finalEmbed.setFooter({ text: `Pending | User: ${user.id} | Msg: ${publicMsg.id} | Ch: ${originChannelId}` });

                await adminChannel.send({ embeds: embedsToSend, components: adminComponents, files: [attachmentData] });
                
                userSessions.set(user.id, {
                    type: currentType, 
                    livery: currentLivery,
                    tail: currentTail,
                    expiresAt: Date.now() + 300000 
                });

                await i.editReply({ 
                    content: `✅ Submission sent for review!\n\n**Have another photo of this same aircraft?**\nUpload it now and I'll automatically apply the corrected details (${currentType}, ${currentTail}).`, 
                    embeds: [], components: [], files: [] 
                });

                const messageToDelete = reply;
                setTimeout(() => {
                    if (messageToDelete) messageToDelete.delete().catch(() => {});
                }, 15000);
                
                collector.stop();
            }
        });
        
        collector.on('end', () => {
             reply = null;
        });
    };

    const updateLeaderboard = async () => {
        if (!LEADERBOARD_CHANNEL_ID) return;
        try {
            const leaderboard = await CommunityAircraftModel.aggregate([
                { 
                    $group: { 
                        _id: { $ifNull: ["$contributorId", "$contributorName"] }, 
                        count: { $sum: 1 }, 
                        displayName: { $first: "$contributorName" },
                        isId: { $max: { $cond: [{ $ifNull: ["$contributorId", false] }, true, false] } }
                    } 
                },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            if (leaderboard.length === 0) return;

            const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
            if (!channel) return;

            const description = leaderboard.map((entry, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
                const nameDisplay = (entry.isId && entry._id.match && entry._id.match(/^\d+$/)) ? `<@${entry._id}>` : entry.displayName;
                return `${medal} ${nameDisplay} — **${entry.count}** contributions`;
            }).join('\n');

            const leaderboardEmbed = themedEmbed(THEME.WHITE)
                .setTitle('🏆 Top Contributors Leaderboard')
                .setDescription(`Here are the top pilots helping build our database!\n\n${description}`)
                .setFooter({ text: `${BRAND_FOOTER} • Updated daily — submit photos to climb!` })
                .setTimestamp();

            let lastMessage = (await channel.messages.fetch({ limit: 5 })).find(m => m.author.id === client.user.id);
            if (lastMessage) await lastMessage.edit({ embeds: [leaderboardEmbed] });
            else await channel.send({ embeds: [leaderboardEmbed] });

        } catch (error) { console.error('❌ Error updating leaderboard:', error); }
    };

    const generateBountyBoard = async (page = 0, sortBy = 'type') => {
        try {
            // Fetch all aircraft flagged as needing an update
            const flagged = await CommunityAircraftModel.find({ needsUpdate: true });
            
            // Enrich with manufacturer from your local registry for sorting
            const enriched = flagged.map(doc => {
                const ac = doc.toObject ? doc.toObject() : doc;
                let manufacturer = 'Unknown';
                if (aircraftRegistry && Array.isArray(aircraftRegistry)) {
                    const match = aircraftRegistry.find(r => 
                        (ac.aircraftType || '').toLowerCase().includes((r.model || '').toLowerCase()) ||
                        (r.model || '').toLowerCase().includes((ac.aircraftType || '').toLowerCase())
                    );
                    if (match && match.manufacturer) manufacturer = match.manufacturer;
                }
                return { ...ac, manufacturer };
            });

            // Apply Sorting
            if (sortBy === 'type') {
                enriched.sort((a, b) => (a.aircraftType || '').localeCompare(b.aircraftType || ''));
            } else if (sortBy === 'livery') {
                enriched.sort((a, b) => (a.liveryName || '').localeCompare(b.liveryName || ''));
            } else if (sortBy === 'manufacturer') {
                enriched.sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || (a.aircraftType || '').localeCompare(b.aircraftType || ''));
            } else if (sortBy === 'date') {
                enriched.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
            }
            
            // Pagination Logic
            const itemsPerPage = 5; // Reduced from 10 to 5 for a much cleaner look
            const totalPages = Math.ceil(enriched.length / itemsPerPage) || 1;
            const safePage = Math.max(0, Math.min(page, totalPages - 1));
            const start = safePage * itemsPerPage;
            const pageData = enriched.slice(start, start + itemsPerPage);
            
            const embed = themedEmbed(THEME.WHITE)
                .setTitle('🎯 Aircraft Photo Update Bounties')
                .setFooter({ text: `${BRAND_FOOTER} • Page ${safePage + 1} of ${totalPages}` })
                .setTimestamp();
                
            if (pageData.length === 0) {
                embed.setDescription('🎉 All good! No aircraft currently need photo updates.');
            } else {
                // Build a clean markdown description instead of using clunky fields
                let boardDescription = `These aircraft need new or better photos! Submit a photo to update the database.\n\n**Total Needed:** ${enriched.length}\n\n`;

                pageData.forEach((ac, index) => {
                    const listNumber = start + index + 1;
                    const mfg = ac.manufacturer !== 'Unknown' ? ac.manufacturer + ' ' : '';
                    
                    boardDescription += `**${listNumber}. ${mfg}${ac.aircraftType}**\n`;
                    boardDescription += `> 🎨 **Livery:** ${ac.liveryName}\n`;
                    boardDescription += `> 🆔 **Tail:** ${ac.tailNumber || 'Unknown'}\n`;
                    boardDescription += `> 🖼️ [**Click to View Current Picture**](${ac.imageUrl || '#'})\n\n`;
                });

                embed.setDescription(boardDescription);

                // Make the image easier to see by setting the first item's image as the embed thumbnail
                if (pageData[0] && pageData[0].imageUrl) {
                    embed.setThumbnail(pageData[0].imageUrl);
                }
            }
            
            // Interaction Buttons
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bnty_prev_${safePage}_${sortBy}`).setLabel('◀️ Prev').setStyle(ButtonStyle.Primary).setDisabled(safePage === 0),
                new ButtonBuilder().setCustomId(`bnty_ref_${safePage}_${sortBy}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`bnty_next_${safePage}_${sortBy}`).setLabel('Next ▶️').setStyle(ButtonStyle.Primary).setDisabled(safePage >= totalPages - 1)
            );
            
            // Sorting Dropdown
            const row2 = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`bnty_sort_${safePage}`)
                    .setPlaceholder(`Sorted by: ${sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}`)
                    .addOptions(
                        { label: 'Sort by Manufacturer', value: 'manufacturer', emoji: '🏭' },
                        { label: 'Sort by Aircraft Type', value: 'type', emoji: '✈️' },
                        { label: 'Sort by Livery', value: 'livery', emoji: '🎨' },
                        { label: 'Sort by Date Flagged', value: 'date', emoji: '📅' }
                    )
            );
            
            // Only show dropdown/pagination if items exist
            if (enriched.length > 0) {
                return { embeds: [embed], components: [row2, row1] };
            } else {
                return { embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bnty_ref_0_${sortBy}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Success))] };
            }
        } catch (error) {
            console.error('Bounty Board Error:', error);
            throw error;
        }
    };

    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);
        await fetchAircraftMetadata();

        // Restore giveaways that were still running before this restart and
        // re-arm their end timers (otherwise the in-memory state is lost and the
        // Enter button reports "already ended").
        if (Giveaway) {
            try {
                const pending = await Giveaway.find({ ended: false }).lean();
                for (const doc of pending) {
                    const endsAt = new Date(doc.endsAt).getTime();
                    activeGiveaways.set(doc.messageId, {
                        prize: doc.prize,
                        delivery: doc.delivery,
                        hostId: doc.hostId,
                        channelId: doc.channelId,
                        messageId: doc.messageId,
                        entrants: new Set(doc.entrants || []),
                        endsAt,
                        ended: false
                    });
                    scheduleGiveawayEnd(doc.messageId, endsAt);
                }
                if (pending.length) {
                    console.log(`🎉 Restored ${pending.length} active giveaway(s) from the database.`);
                }
            } catch (e) {
                console.error('❌ Failed to restore giveaways:', e);
            }
        }
        
        console.log('🧹 Starting Memory Janitor...');
        setInterval(() => {
            const now = Date.now();
            let cleanedLiveries = 0;
            let cleanedSessions = 0;

            Object.keys(cachedLiveries).forEach(key => {
                if (now - cachedLiveries[key].timestamp > 1200000) { 
                    delete cachedLiveries[key];
                    cleanedLiveries++;
                }
            });

            userSessions.forEach((value, key) => {
                if (now > value.expiresAt) {
                    userSessions.delete(key);
                    cleanedSessions++;
                }
            });

            if (global.gc) {
                global.gc();
            }

            if (cleanedLiveries > 0 || cleanedSessions > 0) {
                console.log(`🧹 Memory Cleaned: Pruned ${cleanedLiveries} livery caches and ${cleanedSessions} stale sessions.`);
            }
        }, 600000);

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        const commands = [
            // User Commands
            new SlashCommandBuilder().setName('lookup').setDescription('Find an aircraft by Tail, Livery, or Type (Public)').addStringOption(o => o.setName('query').setDescription('Tail/Livery/Type').setAutocomplete(true).setRequired(true)),
            new SlashCommandBuilder().setName('stats').setDescription('View stats'),
            new SlashCommandBuilder().setName('profile').setDescription('Check contribution stats').addUserOption(o => o.setName('user').setDescription('User to check')),
            new SlashCommandBuilder().setName('pull').setDescription('Fetch a specific aircraft image from the database')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true)),
            
            new SlashCommandBuilder().setName('pull_airport').setDescription('Fetch a specific airport image by ICAO code')
                .addStringOption(o => o.setName('icao').setDescription('4-letter ICAO code').setRequired(true).setMinLength(4).setMaxLength(4)),

            new SlashCommandBuilder().setName('submit').setDescription('Submit a new aircraft photo')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true))
                .addAttachmentOption(o => o.setName('photo').setDescription('Upload photo').setRequired(true)),
            new SlashCommandBuilder().setName('links').setDescription('Get helpful resource links (Tracker, Forum, Liveries)'),
            
            new SlashCommandBuilder()
                .setName('track')
                .setDescription('Track a live flight on the server')
                .addStringOption(o => 
                    o.setName('target')
                     .setDescription('Username or Callsign (e.g., "Delta 101")')
                     .setRequired(true)
                ),

            new SlashCommandBuilder()
                .setName('hangar')
                .setDescription('View detailed breakdown of a user\'s contributions')
                .addUserOption(o => 
                    o.setName('user')
                     .setDescription('User to inspect')
                ),
                
            // NEW: The Live Bounty Board
            new SlashCommandBuilder()
                .setName('bounty_board')
                .setDescription('View the live, sortable list of aircraft pictures needing updates'),

            // Top tracked pilots today (from the tracker view counter).
            new SlashCommandBuilder()
                .setName('most_watched')
                .setDescription('See the top 5 most-tracked pilots on Inflight today'),

            // Pull a random aircraft from the DB.
            new SlashCommandBuilder()
                .setName('random')
                .setDescription('Pull a random aircraft photo from the database'),

            // Show the latest submissions.
            new SlashCommandBuilder()
                .setName('recent')
                .setDescription('Show the 5 most recent aircraft submissions'),

            // Lists every public-facing command grouped by category.
            new SlashCommandBuilder()
                .setName('help')
                .setDescription('Show what this bot can do'),

            // System Admin Commands
            new SlashCommandBuilder().setName('migrate_legacy').setDescription('[SYSTEM] Auto-match legacy DB names to current Discord Users').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
            new SlashCommandBuilder().setName('setup_tickets').setDescription('[SYSTEM] Post the help ticket panel in the current channel').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

            new SlashCommandBuilder().setName('giveaway').setDescription('[MOD] Start a giveaway for an Inflight Pro subscription')
                .addIntegerOption(o => o.setName('duration').setDescription('How long the giveaway runs, in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
                .addStringOption(o => o.setName('prize').setDescription('Prize (defaults to Inflight Pro — 1 Month)').setRequired(false))
                .addStringOption(o => o.setName('delivery').setDescription('How to hand the prize to the winner (default: moderation channel)').setRequired(false)
                    .addChoices(
                        { name: 'Message the moderation channel', value: 'mod_message' },
                        { name: 'Open a help ticket for the winner', value: 'ticket' }
                    ))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageEvents),

            new SlashCommandBuilder().setName('va_apply').setDescription('Apply to register your Virtual Airline / Organization'),

            new SlashCommandBuilder().setName('va_addrep').setDescription('[STAFF] Add a representative to a VA (grants VA + rep access)')
                .addStringOption(o => o.setName('va').setDescription('VA name').setRequired(true).setAutocomplete(true))
                .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

            new SlashCommandBuilder().setName('va_removerep').setDescription('[STAFF] Remove a representative from a VA')
                .addStringOption(o => o.setName('va').setDescription('VA name').setRequired(true).setAutocomplete(true))
                .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

            new SlashCommandBuilder().setName('va_remove').setDescription("[STAFF] Delete a VA's role and channel")
                .addStringOption(o => o.setName('va').setDescription('VA name').setRequired(true).setAutocomplete(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

            // Moderator Commands
            new SlashCommandBuilder().setName('mod_kick').setDescription('[MOD] Kick a user')
                .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for kick').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers),
                
            new SlashCommandBuilder().setName('mod_ban').setDescription('[MOD] Ban a user')
                .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for ban').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),

            new SlashCommandBuilder().setName('mod_timeout').setDescription('[MOD] Timeout a user')
                .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
                .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for timeout').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),

            new SlashCommandBuilder().setName('mod_untimeout').setDescription('[MOD] Remove timeout')
                .addUserOption(o => o.setName('user').setDescription('User to restore').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),

            new SlashCommandBuilder().setName('mod_warn').setDescription('[MOD] Warn a user (Logs to Transcript)')
                .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for warning').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

            new SlashCommandBuilder().setName('mod_purge').setDescription('[MOD] Bulk delete messages')
                .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

            new SlashCommandBuilder().setName('mod_lock').setDescription('[MOD] Lock the current channel')
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

            new SlashCommandBuilder().setName('mod_unlock').setDescription('[MOD] Unlock the current channel')
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

            new SlashCommandBuilder().setName('mod_say').setDescription('[MOD] Make the bot say something')
                .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
                .addChannelOption(o => o.setName('channel').setDescription('Channel to send in (optional)'))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

        ].map(c => c.toJSON());

        try {
            await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
            console.log('✅ Commands registered.');
        } catch (e) { console.error('❌ Error registering commands:', e); }

        updateLeaderboard();
        setInterval(updateLeaderboard, 86400000);
    });

    client.on('guildMemberAdd', async (member) => {
        if (MEMBER_ROLE_ID) {
            try { 
                const role = await member.guild.roles.fetch(MEMBER_ROLE_ID); 
                if (role) await member.roles.add(role); 
            } catch (e) {}
        }
        if (!WELCOME_CHANNEL_ID) return;
        try {
            const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
            if (!channel) return;
            const welcomeEmbed = new EmbedBuilder()
                .setTitle(`Welcome to Inflight!`)
                .setDescription(`Hello ${member}, welcome to the server!`)
                .setColor(THEME.WHITE)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields({ name: '📸 Submit Photos', value: `Post your photos directly in <#${SUBMISSION_CHANNEL_ID}> to contribute!` })
                .setTimestamp();
            await channel.send({ content: `Welcome ${member}! 👋`, embeds: [welcomeEmbed] });
        } catch (e) {}
    });

    client.on('messageCreate', async (message) => {
      try {
        if (message.author.bot) return;

        // --- CHECK CHANNELS ---
        const isAircraftChannel = message.channelId === SUBMISSION_CHANNEL_ID || 
                                   (message.channel.isThread() && message.channel.parentId === SUBMISSION_CHANNEL_ID);
        
        const isAirportChannel = message.channelId === AIRPORT_SUBMISSION_CHANNEL_ID ||
                                 (message.channel.isThread() && message.channel.parentId === AIRPORT_SUBMISSION_CHANNEL_ID);

        // --- HANDLER: AIRCRAFT SUBMISSIONS ---
        if (isAircraftChannel) {
            if (message.attachments.size > 0) {
                const photo = message.attachments.first();
                const isImage = photo.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(photo.name);

                if (!isImage) return;

                const session = userSessions.get(message.author.id);
                if (session && Date.now() < session.expiresAt) {
                    // Don't silently reuse the last aircraft — ask the user to confirm
                    // the auto-fill. Stash this photo so the button handler can use it.
                    session.expiresAt = Date.now() + 300000;
                    session.pendingPhoto = photo.url;
                    userSessions.set(message.author.id, session);

                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`autofill_yes_${message.author.id}`).setLabel('Yes — same aircraft').setEmoji('✅').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`autofill_no_${message.author.id}`).setLabel('No — new aircraft').setEmoji('🆕').setStyle(ButtonStyle.Secondary),
                    );
                    const confirmEmbed = themedEmbed(THEME.WHITE)
                        .setTitle('🔁 Same aircraft as before?')
                        .setDescription(`I still have your last submission details saved:\n\n> **Aircraft:** ${session.type}\n> **Livery:** ${session.livery}\n> **Tail:** ${session.tail}\n\nTap **Yes** to auto-fill these, or **No** to enter new details.`);

                    await message.reply({ embeds: [confirmEmbed], components: [confirmRow] });
                    return;
                }

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`start_ident_${message.author.id}`)
                            .setLabel('Identify Aircraft')
                            .setEmoji('✈️')
                            .setStyle(ButtonStyle.Primary)
                    );

                const promptEmbed = themedEmbed(THEME.WHITE)
                    .setTitle('📸 New Aircraft Photo')
                    .setDescription('Thanks for the photo! Tap **Identify Aircraft** below to enter the **aircraft type** and **livery**.');

                await message.reply({ embeds: [promptEmbed], components: [row] });
            }
        }

        // --- HANDLER: AIRPORT SUBMISSIONS ---
        if (isAirportChannel) {
            if (message.attachments.size > 0) {
                const photo = message.attachments.first();
                const isImage = photo.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(photo.name);

                if (!isImage) return;

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`start_airport_ident_${message.author.id}`)
                            .setLabel('Identify Airport')
                            .setEmoji('🏢')
                            .setStyle(ButtonStyle.Primary)
                    );

                const promptEmbed = themedEmbed(THEME.WHITE)
                    .setTitle('🏢 New Airport Photo')
                    .setDescription('Thanks for the airport photo! Tap **Identify Airport** below to enter the **ICAO code**.');

                await message.reply({ embeds: [promptEmbed], components: [row] });
            }
        }
      } catch (err) {
        console.error('🛑 messageCreate handler error:', err && err.stack ? err.stack : err);
      }
    });

client.on('interactionCreate', async (interaction) => {
      try {
        // --- 1. AUTOCOMPLETE HANDLERS ---
        if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);

            if (interaction.commandName === 'lookup' && focused.name === 'query') {
                const list = await fetchAircraftMetadata();
                const filtered = list.filter(a => a.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
                await interaction.respond(filtered.map(a => ({ name: a.name, value: a.name })));
                return;
            }

            // VA name autocomplete for the /va_* staff commands.
            if (focused.name === 'va') {
                if (!VirtualAirlineAd) return interaction.respond([]);
                try {
                    const q = (focused.value || '').trim();
                    const ads = await VirtualAirlineAd.find(q ? { name: { $regex: q, $options: 'i' } } : {})
                        .select('name').sort({ name: 1 }).limit(25).lean();
                    return interaction.respond(ads.map(a => ({ name: a.name.slice(0, 100), value: a.name.slice(0, 100) })));
                } catch (_) {
                    return interaction.respond([]);
                }
            }

            if (focused.name === 'aircraft_type') {
                const list = await fetchAircraftMetadata();
                const filtered = list.filter(a => a.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
                await interaction.respond(filtered.map(a => ({ name: a.name, value: a.name })));
                return;
            }

            if (focused.name === 'livery') {
                const selectedType = interaction.options.getString('aircraft_type');
                if (!selectedType) return interaction.respond([{ name: "Select Aircraft Type first", value: "Unknown" }]);

                const list = await fetchAircraftMetadata();
                const matched = list.find(a => a.name === selectedType);

                if (matched) {
                    const liveries = await fetchLiveriesForAircraft(matched.id);
                    const filtered = liveries.filter(l => l.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 24);
                    const options = filtered.map(l => ({ name: l, value: l }));
                    if (focused.value && !liveries.includes(focused.value)) options.push({ name: `${focused.value} (Custom)`, value: focused.value });
                    await interaction.respond(options);
                } else {
                    await interaction.respond([{ name: "Aircraft not found", value: "Unknown" }]);
                }
                return;
            }
            return;
        }

        // --- 2. BUTTON HANDLERS ---
        if (interaction.isButton()) {
            const customId = interaction.customId;

            // --- BOUNTY BOARD PAGINATION BUTTONS ---
            if (customId.startsWith('bnty_')) {
                await interaction.deferUpdate();
                const parts = customId.split('_');
                const action = parts[1]; // prev, next, ref
                let page = parseInt(parts[2], 10);
                const sortBy = parts[3];
                
                if (action === 'prev') page--;
                if (action === 'next') page++;
                
                try {
                    const payload = await generateBountyBoard(page, sortBy);
                    await interaction.editReply(payload);
                } catch (e) {
                    await interaction.followUp({ content: 'Error updating board.', ephemeral: true });
                }
                return;
            }

            // --- AIRCRAFT BUTTONS ---
            // Autofill confirmation: user uploaded another photo within the session.
            if (customId.startsWith('autofill_yes_')) {
                const originalUserId = customId.split('_')[2];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "This isn't your submission.", ephemeral: true });
                const session = userSessions.get(originalUserId);
                if (!session || Date.now() >= session.expiresAt || !session.pendingPhoto) {
                    return interaction.update({ embeds: [themedEmbed(THEME.GRAY).setTitle('⏳ Session Expired').setDescription('Please re-upload your photo to start a new submission.')], components: [] });
                }
                const photoUrl = session.pendingPhoto;
                session.pendingPhoto = null;
                session.expiresAt = Date.now() + 300000;
                userSessions.set(originalUserId, session);
                // deferUpdate so startSubmissionFlow edits THIS prompt into the preview.
                await interaction.deferUpdate();
                await startSubmissionFlow(interaction, session.type, session.livery, null, photoUrl, interaction.user, interaction.channelId);
                return;
            }

            if (customId.startsWith('autofill_no_')) {
                const originalUserId = customId.split('_')[2];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "This isn't your submission.", ephemeral: true });
                // Reset the saved session so the user can enter brand-new details.
                userSessions.delete(originalUserId);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_ident_${originalUserId}`).setLabel('Identify Aircraft').setEmoji('✈️').setStyle(ButtonStyle.Primary)
                );
                await interaction.update({
                    embeds: [themedEmbed(THEME.WHITE).setTitle('📸 New Aircraft Photo').setDescription('No problem — tap **Identify Aircraft** below to enter new details.')],
                    components: [row]
                });
                return;
            }

            if (customId.startsWith('start_ident_')) {
                const originalUserId = customId.split('_')[2];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "This is not your photo.", ephemeral: true });

                const modal = new ModalBuilder().setCustomId('identify_modal').setTitle('Aircraft Details');
                const typeInput = new TextInputBuilder().setCustomId('i_type').setLabel("What aircraft is this?").setPlaceholder("e.g. 737-8 MAX").setStyle(TextInputStyle.Short).setRequired(true);
                const liveryInput = new TextInputBuilder().setCustomId('i_livery').setLabel("What livery is this?").setPlaceholder("e.g. Delta Air Lines").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput));
                await interaction.showModal(modal);
                return;
            }

            if (customId.startsWith('edit_admin_')) {
                const receivedEmbed = interaction.message.embeds[0];
                const currentTail = receivedEmbed.fields.find(f => f.name === 'Tail Number')?.value || 'UNKNOWN';
                const currentType = receivedEmbed.fields.find(f => f.name === 'Aircraft Type')?.value || '';
                const currentLivery = receivedEmbed.fields.find(f => f.name === 'Livery')?.value || '';

                const modal = new ModalBuilder().setCustomId('admin_edit_modal').setTitle('Edit Submission Details');
                const tailInput = new TextInputBuilder().setCustomId('ae_tail').setLabel("Tail Number").setValue(currentTail).setStyle(TextInputStyle.Short).setRequired(true);
                const typeInput = new TextInputBuilder().setCustomId('ae_type').setLabel("Aircraft Type").setValue(currentType).setStyle(TextInputStyle.Short).setRequired(true);
                const liveryInput = new TextInputBuilder().setCustomId('ae_livery').setLabel("Livery").setValue(currentLivery).setStyle(TextInputStyle.Short).setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(tailInput), new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput));
                await interaction.showModal(modal);
                return;
            }

            if (customId.startsWith('approve_') && !customId.startsWith('approve_apt_')) {
                await interaction.deferUpdate();
                // customId format: approve_<action>_<slot>_<userId> where action is
                // 'add' | 'replace'. Older formats are still accepted:
                //   approve_<slot>_<userId>  (slot only — intent inferred at approval)
                //   approve_<userId>         (legacy single-photo => slot 1)
                const approveParts = customId.split('_');
                let approveAction = null; // 'add' | 'replace' | null (infer)
                let chosenSlot, targetUserId;
                if (approveParts.length >= 4) {
                    approveAction = approveParts[1];
                    chosenSlot = parseInt(approveParts[2], 10) || 1;
                    targetUserId = approveParts[3];
                } else if (approveParts.length === 3) {
                    chosenSlot = parseInt(approveParts[1], 10) || 1;
                    targetUserId = approveParts[2];
                } else {
                    chosenSlot = 1;
                    targetUserId = approveParts[1];
                }
                const receivedEmbed = interaction.message.embeds[0];

                try {
                    const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number')?.value;
                    const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type')?.value;
                    const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery')?.value;

                    if (!tailField || !typeField || !liveryField) throw new Error("Missing required aircraft embed fields.");

                    let imageUrl = receivedEmbed.image?.url || interaction.message.attachments.first()?.url;
                    const publicMsgId = (receivedEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];
                    const originChannelId = (receivedEmbed.footer?.text || '').match(/Ch: (\d+)/)?.[1];

                    const permanentUrl = await uploadImageToS3(imageUrl, tailField);
                    const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                    const contributorName = member ? member.displayName : (await client.users.fetch(targetUserId)).username;

                    // Find the existing record (if any) so we can place the new photo into
                    // the admin-chosen slot without disturbing the other images.
                    const existingEntry = await CommunityAircraftModel.findOne({
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(typeField)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(liveryField)}$`, "i") }
                    });

                    let images = getEntryImages(existingEntry);
                    let contributors = getEntryContributors(existingEntry);

                    // RE-CHECK against the LIVE database before placing the photo.
                    // The slot baked into the button was decided when the buttons
                    // were rendered; by the time an admin clicks, other submissions
                    // for the same aircraft may already have been approved. Without
                    // this re-check, a second pending "add" (rendered as slot 1 when
                    // there were 0 photos) would overwrite the photo that was just
                    // approved into slot 1. We honour the admin's intent (add vs
                    // replace) against the current image count instead.
                    let slotIndex;
                    let isReplace;
                    if (approveAction === 'add') {
                        // Append as a NEW photo at the end of the current list. If
                        // the aircraft is already full, fall back to the last slot.
                        if (images.length < MAX_AIRCRAFT_IMAGES) {
                            slotIndex = images.length;
                            isReplace = false;
                        } else {
                            slotIndex = MAX_AIRCRAFT_IMAGES - 1;
                            isReplace = true;
                        }
                    } else if (approveAction === 'replace') {
                        // Replace the targeted slot if it still exists; if that photo
                        // is gone (images shrank since render), append instead.
                        slotIndex = chosenSlot - 1;
                        if (slotIndex >= 0 && slotIndex < images.length) {
                            isReplace = true;
                        } else {
                            slotIndex = Math.min(images.length, MAX_AIRCRAFT_IMAGES - 1);
                            isReplace = slotIndex < images.length;
                        }
                    } else {
                        // Legacy buttons (no encoded action): infer from live state.
                        slotIndex = Math.min(Math.max(chosenSlot - 1, 0), images.length);
                        if (slotIndex >= MAX_AIRCRAFT_IMAGES) slotIndex = MAX_AIRCRAFT_IMAGES - 1;
                        isReplace = slotIndex < images.length;
                    }

                    // The person who submitted this photo is the contributor of THIS
                    // slot only — adding/replacing photo 2 or 3 must not overwrite the
                    // contributor(s) of the other images.
                    const slotContributor = { name: contributorName, id: targetUserId };

                    let replacedUrl = null;
                    if (isReplace && slotIndex < images.length) {
                        replacedUrl = images[slotIndex];
                        images[slotIndex] = permanentUrl;
                        contributors[slotIndex] = slotContributor;
                    } else {
                        images.push(permanentUrl);
                        contributors.push(slotContributor);
                    }
                    images = images.slice(0, MAX_AIRCRAFT_IMAGES);
                    contributors = contributors.slice(0, MAX_AIRCRAFT_IMAGES);

                    // Legacy top-level contributor mirrors the primary (slot 0) image.
                    const primaryContributor = contributors[0] || slotContributor;

                    // Automatically remove the 'needsUpdate' flag upon approval
                    const updateData = {
                        contributorName: primaryContributor.name,
                        contributorId: primaryContributor.id,
                        aircraftType: typeField,
                        liveryName: liveryField,
                        imageUrls: images,
                        imageContributors: contributors,
                        imageUrl: images[0], // keep legacy primary field in sync
                        uploadedAt: new Date(),
                        needsUpdate: false
                    };

                    if (tailField !== 'UNKNOWN') updateData.tailNumber = tailField.toUpperCase();

                    await CommunityAircraftModel.findOneAndUpdate(
                        { aircraftType: { $regex: new RegExp(`^${escapeRegex(typeField)}$`, "i") }, liveryName: { $regex: new RegExp(`^${escapeRegex(liveryField)}$`, "i") } },
                        updateData, { upsert: true }
                    );

                    // Remove the overwritten image from storage (after the DB is updated)
                    if (replacedUrl && replacedUrl !== permanentUrl) await deleteImageFromS3(replacedUrl);

                    if (CONTRIBUTOR_ROLE_ID && member) await member.roles.add(CONTRIBUTOR_ROLE_ID).catch(() => {});

                    const approvedTitle = `✅ Approved — Photo ${slotIndex + 1} of ${images.length}`;
                    // Keep the verified photo rendered inside the admin embed (using the
                    // permanent S3 URL) and drop the temporary upload attachment.
                    await interaction.editReply({
                        embeds: [EmbedBuilder.from(receivedEmbed).setColor(SUB_STATE.VERIFIED.color).setTitle(approvedTitle).setImage(permanentUrl)],
                        components: [],
                        attachments: []
                    });

                    if (publicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                            // Embed the PERMANENT image (S3 URLs don't expire) instead of
                            // posting the raw link as message content. This keeps the photo
                            // visible on the message forever and removes the temp attachment.
                            await publicMsg.edit({
                                content: '',
                                embeds: [EmbedBuilder.from(publicMsg.embeds[0])
                                    .setTitle('✅ Verified Aircraft')
                                    .setColor(SUB_STATE.VERIFIED.color)
                                    .setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}\nThis photo has been verified and saved to the database.`)
                                    .setImage(permanentUrl)],
                                attachments: []
                            });
                        } catch (e) {}
                    }

                    // Let the submitter know their photo went live, with the image.
                    if (originChannelId) {
                        try {
                            const userChannel = await client.channels.fetch(originChannelId).catch(() => null);
                            if (userChannel) {
                                await userChannel.send({
                                    content: `<@${targetUserId}>`,
                                    embeds: [themedEmbed(SUB_STATE.VERIFIED.color)
                                        .setTitle('✅ Photo Approved')
                                        .setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}\nYour **${typeField}** (${liveryField}) photo is now live in the database. Thanks for contributing! 🎉`)
                                        .setImage(permanentUrl)]
                                });
                            }
                        } catch (e) {}
                    }

                    // Refresh any other still-pending review cards for the same aircraft so
                    // they reflect the photo we just saved (e.g. a duplicate submission's
                    // card flips from "no photo yet" to "1/3 — Add Photo 2 / Replace Photo 1").
                    await refreshPendingReviewsFor(typeField, liveryField, {
                        imageUrls: images,
                        imageContributors: contributors,
                        tailNumber: updateData.tailNumber
                    }, interaction.message.id);
                } catch (err) {
                    console.error("Aircraft Approval Error:", err);
                }
                return;
            }

            if (customId.startsWith('reject_') && !customId.startsWith('reject_apt_')) {
                const targetUserId = customId.split('_')[1];
                const modal = new ModalBuilder().setCustomId(`rejectModal_${targetUserId}`).setTitle('Rejection Reason');
                const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel("Why?").setStyle(TextInputStyle.Paragraph).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
                return;
            }

            // --- AIRPORT BUTTONS ---
            if (customId.startsWith('start_airport_ident_')) {
                const originalUserId = customId.split('_')[3];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "Not your photo.", ephemeral: true });
                const modal = new ModalBuilder().setCustomId('airport_modal').setTitle('Airport Details');
                const icaoInput = new TextInputBuilder().setCustomId('a_icao').setLabel("ICAO Code").setPlaceholder("e.g. KJFK").setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(4).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(icaoInput));
                await interaction.showModal(modal);
                return;
            }

            if (customId.startsWith('approve_apt_')) {
                await interaction.deferUpdate();
                const [_, __, targetUserId, icao] = customId.split('_');
                const imageUrl = interaction.message.embeds[0].image?.url;
                const aptPublicMsgId = (interaction.message.embeds[0].footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const aptOriginChannelId = (interaction.message.embeds[0].footer?.text || '').match(/Ch: (\d+)/)?.[1];
                try {
                    const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                    const contributorName = sanitizeMetadata(member ? member.displayName : "Unknown");
                    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                    if (typeof deleteAirportImages === 'function') await deleteAirportImages(s3Client, icao);
                    const finalUrl = await uploadAirportImage(s3Client, { buffer: Buffer.from(response.data) }, icao, contributorName);
                    await interaction.editReply({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setTitle(`✅ Airport Approved: ${icao}`).setColor(SUB_STATE.VERIFIED.color).setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}`).setImage(finalUrl)], components: [] });

                    // Update the public feed message too, swapping the temporary Discord
                    // image URL (which expires) for the permanent stored one.
                    if (aptPublicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(aptPublicMsgId);
                            await publicMsg.edit({ embeds: [EmbedBuilder.from(publicMsg.embeds[0]).setTitle(`✅ Verified Airport: ${icao}`).setColor(SUB_STATE.VERIFIED.color).setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}`).setImage(finalUrl)] });
                        } catch (e) {}
                    }

                    // Notify the submitter in their channel with the verified image.
                    if (aptOriginChannelId) {
                        try {
                            const userChannel = await client.channels.fetch(aptOriginChannelId).catch(() => null);
                            if (userChannel) await userChannel.send({ content: `<@${targetUserId}>`, embeds: [themedEmbed(SUB_STATE.VERIFIED.color).setTitle('✅ Airport Photo Approved').setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}\nYour **${icao}** photo is now live. Thanks! 🎉`).setImage(finalUrl)] });
                        } catch (e) {}
                    }
                } catch (err) { console.error("Airport Approval Error:", err); }
                return;
            }

            if (customId.startsWith('reject_apt_')) {
                const targetUserId = customId.split('_')[2];
                const modal = new ModalBuilder().setCustomId(`rejectAptModal_${targetUserId}`).setTitle('Airport Rejection Reason');
                const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel("Why?").setStyle(TextInputStyle.Paragraph).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
                return;
            }

            // --- GIVEAWAY ENTRY BUTTON ---
            if (customId === 'giveaway_enter') {
                const g = activeGiveaways.get(interaction.message.id);
                if (!g || g.ended) {
                    return interaction.reply({ content: '❌ This giveaway has already ended.', ephemeral: true });
                }
                if (g.entrants.has(interaction.user.id)) {
                    return interaction.reply({ content: 'ℹ️ You are already entered. Good luck! 🎉', ephemeral: true });
                }
                g.entrants.add(interaction.user.id);
                // Persist the new entrant so it survives a restart.
                persistGiveaway(interaction.message.id).catch(() => {});

                // Live-update the entry count shown on the embed.
                try {
                    const baseEmbed = interaction.message.embeds[0];
                    if (baseEmbed) {
                        const newEmbed = EmbedBuilder.from(baseEmbed);
                        const fields = newEmbed.data.fields || [];
                        const idx = fields.findIndex(f => f.name === 'Entries');
                        if (idx !== -1) fields[idx].value = `${g.entrants.size}`;
                        newEmbed.setFields(fields);
                        await interaction.message.edit({ embeds: [newEmbed] }).catch(() => {});
                    }
                } catch (e) { /* non-fatal — entry still counts */ }

                return interaction.reply({ content: '✅ You have entered the giveaway! Good luck! 🎉', ephemeral: true });
            }

            // --- VA APPLICATION REVIEW BUTTONS ---
            if (customId.startsWith('va_approve_') || customId.startsWith('va_reject_') || customId.startsWith('va_edit_')) {
                // Staff or the Inflight VA Rep may review applications.
                if (!canReviewVa(interaction.member)) {
                    return interaction.reply({ content: '❌ Staff or Inflight VA Rep only.', ephemeral: true });
                }
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable (database not connected).', ephemeral: true });
                }

                // Reject / Request Edits both collect text via a modal first. Encode
                // the review message id so the modal submit can update this message.
                if (customId.startsWith('va_reject_')) {
                    const id = customId.replace('va_reject_', '');
                    const modal = new ModalBuilder().setCustomId(`va_reject_modal_${id}_${interaction.message.id}`).setTitle('Reject VA Application');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('va_reason').setLabel('Reason (sent to the applicant)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
                    ));
                    return interaction.showModal(modal);
                }
                if (customId.startsWith('va_edit_')) {
                    const id = customId.replace('va_edit_', '');
                    const modal = new ModalBuilder().setCustomId(`va_editreq_modal_${id}_${interaction.message.id}`).setTitle('Request Edits');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('va_changes').setLabel('What needs changing?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
                    ));
                    return interaction.showModal(modal);
                }

                // Approve → provision the VA space.
                const id = customId.replace('va_approve_', '');
                await interaction.deferReply({ ephemeral: true });
                const ad = await VirtualAirlineAd.findById(id).catch(() => null);
                if (!ad) return interaction.editReply('❌ Application not found (it may have been deleted).');

                try {
                    ad.status = 'approved';
                    const { role, channel } = await provisionVaSpace(interaction.guild, ad);

                    const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0] || buildVaReviewEmbed(ad))
                        .setTitle('✅ VA Application — Approved')
                        .setColor(THEME.WHITE);
                    await interaction.message.edit({ embeds: [approvedEmbed], components: [] }).catch(() => {});

                    await interaction.message.reply(`✅ **${ad.name}** approved by <@${interaction.user.id}>.\n• Role: ${role ? `<@&${role.id}>` : '—'}\n• Channel: ${channel ? `<#${channel.id}>` : '—'}`).catch(() => {});

                    if (ad.ownerId) {
                        const owner = await client.users.fetch(ad.ownerId).catch(() => null);
                        if (owner) await owner.send(`🎉 Your VA **${ad.name}** has been approved! Your private channel is ${channel ? `<#${channel.id}>` : 'ready'}.`).catch(() => {});
                    }

                    return interaction.editReply(`✅ Provisioned **${ad.name}** — ${channel ? `<#${channel.id}>` : 'channel'} and role created.`);
                } catch (e) {
                    console.error('❌ VA approval/provision error:', e);
                    return interaction.editReply('❌ Failed to provision the VA space. Check that the bot has **Manage Roles** + **Manage Channels** and that the category ID is correct.');
                }
            }

            // --- VA SETUP CARD BUTTONS (owner fills in the rest, post-approval) ---
            if (customId.startsWith('va_setup_')) {
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable (database not connected).', ephemeral: true });
                }
                // customId: va_setup_<action>_<adId>
                const rest = customId.replace('va_setup_', '');
                const sep = rest.indexOf('_');
                const action = rest.slice(0, sep);
                const adId = rest.slice(sep + 1);

                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.reply({ content: '❌ This VA listing no longer exists.', ephemeral: true });
                if (!canManageVa(interaction, ad)) {
                    return interaction.reply({ content: '❌ Only this VA\'s owner (or staff) can edit its listing.', ephemeral: true });
                }

                // Banner / logo come in as image attachments — a modal can't take a
                // file, so we kick off a message collector in this channel.
                if (action === 'banner' || action === 'logo') {
                    await interaction.reply({ content: `🖼️ Ready for your **${action}** — see the prompt below.`, ephemeral: true });
                    handleVaImageUpload(interaction.channel, interaction.user, ad, action);
                    return;
                }

                // Text details → modal #1 (5 fields max per Discord modal).
                if (action === 'details') {
                    const modal = new ModalBuilder().setCustomId(`va_setup_details_modal_${adId}`).setTitle('VA Details');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_description').setLabel('Full description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(ad.description || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_region').setLabel('Region (e.g. Asia, Europe, Global)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40).setValue(ad.region && ad.region !== 'Global' ? ad.region : '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_hubs').setLabel('Hub ICAOs (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('VABB, VIDP, OMDB').setValue((ad.hubs || []).join(', '))),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_fleet').setLabel('Fleet (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setPlaceholder('A320, B738, B77W').setValue((ad.fleet || []).join(', '))),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_requirements').setLabel('Joining requirements').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setValue(ad.requirements || ''))
                    );
                    return interaction.showModal(modal);
                }

                // Links + recruiting → modal #2.
                if (action === 'links') {
                    const modal = new ModalBuilder().setCustomId(`va_setup_links_modal_${adId}`).setTitle('Links & Recruiting');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_applicationUrl').setLabel('Apply / join link').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(ad.applicationUrl || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_ifcThreadUrl').setLabel('IFC forum thread URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(ad.ifcThreadUrl || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_minGrade').setLabel('Minimum IF grade (1-5, blank = none)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(1).setPlaceholder('3').setValue(ad.minGrade ? String(ad.minGrade) : '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_pilotCount').setLabel('Current pilot count').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(6).setPlaceholder('25').setValue(ad.pilotCount ? String(ad.pilotCount) : '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_tags').setLabel('Tags / keywords (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setPlaceholder('long-haul, realism, events').setValue((ad.tags || []).join(', ')))
                    );
                    return interaction.showModal(modal);
                }

                return interaction.reply({ content: '❌ Unknown setup action.', ephemeral: true });
            }

            // --- TICKET BUTTONS ---
            if (customId === 'create_ticket_start') {
                const topicSelect = new StringSelectMenuBuilder().setCustomId('ticket_topic_select').setPlaceholder('Select a topic')
                    .addOptions(
                        { label: 'Database Correction', value: 'db_correction', emoji: '📝' },
                        { label: 'Submission Issue', value: 'submission_issue', emoji: '📸' },
                        { label: 'VA Partnership', value: 'va_partnership', emoji: '🤝', description: 'Partner your VA with Inflight' },
                        { label: 'Subscription Issue (Inflight Pro)', value: 'subscription', emoji: '💳', description: 'Problems with your Inflight Pro subscription' },
                        { label: 'Other Inquiry', value: 'other', emoji: '❓' }
                    );
                await interaction.reply({ content: 'Select a topic:', components: [new ActionRowBuilder().addComponents(topicSelect)], ephemeral: true });
                return;
            }

            if (customId === 'close_ticket_action') {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
                await interaction.deferReply({ ephemeral: true });
                const thread = interaction.channel;
                try {
                    const messages = await thread.messages.fetch({ limit: 100 });
                    const transcript = Array.from(messages.values()).reverse().map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content}`).join('\n');
                    const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
                    if (transcriptChannel) {
                        await transcriptChannel.send({ embeds: [new EmbedBuilder().setTitle('🔒 Ticket Closed').setDescription(`Ticket: ${thread.name}`).setColor(0xFF0000)], files: [new AttachmentBuilder(Buffer.from(transcript), { name: `${thread.name}-transcript.txt` })] });
                    }
                    await interaction.editReply("Closing in 5s...");
                    setTimeout(() => thread.delete().catch(() => {}), 5000);
                } catch (e) { console.error(e); }
                return;
            }

            // --- VA PARTNERSHIP: ACCEPT TERMS ---
            if (customId === 'partnership_accept_tos') {
                await interaction.deferUpdate();

                // Persist the acceptance (latest wins). Best-effort — never block
                // the user if the DB is briefly unavailable.
                if (VaTermsAcceptance) {
                    try {
                        await VaTermsAcceptance.findOneAndUpdate(
                            { userId: interaction.user.id },
                            {
                                userId: interaction.user.id,
                                username: interaction.user.username,
                                termsVersion: VA_PARTNERSHIP_TOS_VERSION,
                                channelId: interaction.channelId,
                                acceptedAt: new Date(),
                            },
                            { upsert: true, setDefaultsOnInsert: true }
                        );
                    } catch (e) {
                        console.error('❌ Save terms acceptance error:', e);
                    }
                }

                // Lock the ToS card so it can't be re-accepted.
                try {
                    const lockedRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('partnership_accepted_done').setLabel('Terms Accepted').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(true),
                        new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
                    );
                    await interaction.editReply({ components: [lockedRow] });
                } catch (_) { /* card may have been deleted */ }

                // Walk them straight into the VA application — no /va_apply needed.
                const setupRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('partnership_apply_va').setLabel('Start VA Application').setStyle(ButtonStyle.Primary).setEmoji('🛫')
                );
                await interaction.followUp({
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Terms accepted — let’s set up your VA')
                        .setColor(THEME.WHITE)
                        .setDescription(
                            `Thanks <@${interaction.user.id}>! We’ve recorded that you accepted our partnership terms.\n\n` +
                            "Tap **Start VA Application** below to register your VA — no need to run `/va_apply`. " +
                            `Once submitted, our Inflight VA Rep <@&${INFLIGHT_VA_REP_ROLE_ID}> will review and approve it.`
                        )
                        .setFooter({ text: BRAND_FOOTER })],
                    components: [setupRow]
                }).catch(() => {});
                return;
            }

            // --- VA PARTNERSHIP: START APPLICATION ---
            if (customId === 'partnership_apply_va') {
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable right now.', ephemeral: true });
                }
                await interaction.showModal(buildVaApplyModal());
                return;
            }
        }

        // --- 3. SELECT MENU HANDLERS ---
        if (interaction.isStringSelectMenu()) {
            
            // --- BOUNTY BOARD SORTING MENU ---
            if (interaction.customId.startsWith('bnty_sort_')) {
                await interaction.deferUpdate();
                const sortBy = interaction.values[0];
                try {
                    // Reset to page 0 whenever the sort method changes
                    const payload = await generateBountyBoard(0, sortBy);
                    await interaction.editReply(payload);
                } catch (e) {
                    await interaction.followUp({ content: 'Error changing sort order.', ephemeral: true });
                }
                return;
            }

            if (interaction.customId === 'ticket_topic_select') {
                // VA Partnership runs its own flow: a ticket that pings the
                // Inflight VA Rep and walks the user through the ToS + setup,
                // so it skips the generic "describe your issue" modal.
                if (interaction.values[0] === 'va_partnership') {
                    await interaction.deferReply({ ephemeral: true });
                    try {
                        const thread = await openPartnershipTicket(interaction);
                        await interaction.editReply(`✅ Partnership ticket opened: <#${thread.id}>`);
                    } catch (e) {
                        console.error('❌ Partnership ticket error:', e);
                        await interaction.editReply('❌ Could not open a partnership ticket. Please try again or contact staff.');
                    }
                    return;
                }
                const modal = new ModalBuilder().setCustomId(`ticket_modal_${interaction.values[0]}`).setTitle('Ticket Details');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_desc').setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(false)));
                await interaction.showModal(modal);
                return;
            }
        }

        // --- 4. MODAL SUBMIT HANDLERS ---
        if (interaction.isModalSubmit()) {
            const customId = interaction.customId;

            if (customId === 'identify_modal') {
                await interaction.deferReply({ ephemeral: true });
                const type = interaction.fields.getTextInputValue('i_type');
                const livery = interaction.fields.getTextInputValue('i_livery');
                const originalMsg = await interaction.channel.messages.fetch(interaction.message.reference.messageId).catch(() => null);
                if (!originalMsg?.attachments.first()) return interaction.editReply("❌ Image not found.");
                await startSubmissionFlow(interaction, type, livery, null, originalMsg.attachments.first().url, interaction.user, interaction.channelId);
                try { await interaction.message.delete(); } catch(e) {}
                return;
            }

            if (customId === 'admin_edit_modal') {
                await interaction.deferUpdate();
                let newTail = interaction.fields.getTextInputValue('ae_tail');
                const newType = interaction.fields.getTextInputValue('ae_type');
                const newLivery = interaction.fields.getTextInputValue('ae_livery');
                const oldEmbed = interaction.message.embeds[0];
                const oldTail = oldEmbed.fields.find(f => f.name === 'Tail Number')?.value || 'UNKNOWN';

                if (newTail === oldTail || newTail.toUpperCase() === 'UNKNOWN') {
                    newTail = lookupRegistration(newType, newLivery) || newTail;
                }

                const newEmbed = EmbedBuilder.from(oldEmbed);
                const fields = newEmbed.data.fields;
                fields.find(f => f.name === 'Tail Number').value = newTail.toUpperCase();
                fields.find(f => f.name === 'Aircraft Type').value = newType;
                fields.find(f => f.name === 'Livery').value = newLivery;
                newEmbed.setFields(fields);

                // Recover the submitter id from the pending footer so we can rebuild buttons.
                const submitterId = (oldEmbed.footer?.text || '').match(/User: (\d+)/)?.[1] || interaction.user.id;

                // Re-run the duplicate check so an admin edit that now matches an existing
                // record gets the replacement banner + per-photo comparison embeds and the
                // correct slot-choice buttons (and an edit away from a duplicate clears them).
                let embedsToSend = [newEmbed];
                let components;
                try {
                    const existingEntry = await CommunityAircraftModel.findOne({
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(newType)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(newLivery)}$`, "i") }
                    });

                    const review = buildAircraftReview(newEmbed, existingEntry, submitterId);
                    components = review.components;
                    embedsToSend = [newEmbed, ...review.extraEmbeds];
                    // Preserve the pending footer the buildAircraftReview helper doesn't touch.
                    if (oldEmbed.footer?.text) newEmbed.setFooter({ text: oldEmbed.footer.text });
                } catch (e) {
                    console.error('Admin edit duplicate re-check failed:', e);
                }

                const editPayload = { embeds: embedsToSend };
                if (components) editPayload.components = components;
                await interaction.editReply(editPayload);
                return;
            }

            if (customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate();
                const targetUserId = customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                const oldEmbed = interaction.message.embeds[0];
                const publicMsgId = (oldEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const originChannelId = (oldEmbed.footer?.text || '').match(/Ch: (\d+)/)?.[1];
                // Grab the image being rejected so we can show it to the user.
                const rejectedImageUrl = oldEmbed.image?.url || interaction.message.attachments.first()?.url;

                // Keep the photo visible on the admin message (don't null it) so the
                // record of what was rejected stays intact.
                await interaction.editReply({ embeds: [EmbedBuilder.from(oldEmbed).setTitle('❌ Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}`)], components: [] });

                if (publicMsgId) {
                    try {
                        const feed = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const msg = await feed.messages.fetch(publicMsgId);
                        await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle('❌ Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}\nThis submission was not approved.`).setImage(null)], attachments: [] });
                    } catch(e) {}
                }

                if (originChannelId) {
                    const channel = await client.channels.fetch(originChannelId).catch(() => null);
                    if (channel) {
                        const userEmbed = themedEmbed(SUB_STATE.REJECTED.color)
                            .setTitle('❌ Photo Rejected')
                            .setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}\n\nFeel free to submit a new photo — corrections are welcome!`);
                        const payload = { content: `<@${targetUserId}>`, embeds: [userEmbed] };
                        // Re-upload the rejected image onto the user's message so they can
                        // see exactly what was declined (and it stays persistent).
                        if (rejectedImageUrl) {
                            userEmbed.setImage('attachment://rejected.webp');
                            payload.files = [{ attachment: rejectedImageUrl, name: 'rejected.webp' }];
                        }
                        await channel.send(payload).catch(() => {});
                    }
                }
                return;
            }

            if (customId === 'airport_modal') {
                await interaction.deferReply({ ephemeral: true });
                const icao = interaction.fields.getTextInputValue('a_icao').toUpperCase().trim();

                // Defensive: the prompt message we replied to may have been
                // deleted (or never had a reference in the first place).
                // Without these guards a single missing attachment threw an
                // uncaught error and the user saw a frozen spinner.
                const referencedId = interaction.message?.reference?.messageId;
                if (!referencedId) {
                    return interaction.editReply("❌ I couldn't find the original photo message — please re-upload.");
                }
                const originalMsg = await interaction.channel.messages.fetch(referencedId).catch(() => null);
                const photo = originalMsg?.attachments?.first();
                if (!photo) {
                    return interaction.editReply("❌ The original photo is no longer available. Please re-upload.");
                }
                const photoUrl = photo.url;

                try {
                    const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                    const publicMsg = await feedChannel.send({ embeds: [themedEmbed(SUB_STATE.PENDING.color).setTitle('🏢 New Airport Submission').setDescription(`**Status:** ${SUB_STATE.PENDING.badge}`).setImage(photoUrl).addFields({ name: 'ICAO', value: icao })] });

                    const adminEmbed = themedEmbed(SUB_STATE.PENDING.color).setTitle('🏢 Airport Review — Awaiting Approval').setDescription(`**Status:** ${SUB_STATE.PENDING.badge}`).setImage(photoUrl).addFields({ name: 'ICAO', value: icao }).setFooter({ text: `User: ${interaction.user.id} | Msg: ${publicMsg.id} | Ch: ${interaction.channelId}` });
                    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`approve_apt_${interaction.user.id}_${icao}`).setLabel('Approve').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`reject_apt_${interaction.user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
                    const adminChannel = await client.channels.fetch(AIRPORT_ADMIN_CHANNEL_ID);
                    await adminChannel.send({ embeds: [adminEmbed], components: [row] });
                    await interaction.editReply("✅ Sent for review.");
                    try { await interaction.message.delete(); } catch(e) {}
                } catch (err) {
                    console.error('Airport submission send failed:', err);
                    await interaction.editReply("❌ Couldn't post for review. Please try again or contact an admin.");
                }
                return;
            }

            if (customId.startsWith('rejectAptModal_')) {
                await interaction.deferUpdate();
                const targetUserId = customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                const oldEmbed = interaction.message.embeds[0];
                const publicMsgId = (oldEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const originChannelId = (oldEmbed.footer?.text || '').match(/Ch: (\d+)/)?.[1];
                const rejectedImageUrl = oldEmbed.image?.url;

                await interaction.editReply({ embeds: [EmbedBuilder.from(oldEmbed).setTitle('❌ Airport Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}`)], components: [] });
                if (publicMsgId) {
                    try {
                        const feed = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const msg = await feed.messages.fetch(publicMsgId);
                        await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle('❌ Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}`).setImage(null)] });
                    } catch(e) {}
                }
                if (originChannelId) {
                    const ch = await client.channels.fetch(originChannelId).catch(() => null);
                    if (ch) {
                        const userEmbed = themedEmbed(SUB_STATE.REJECTED.color)
                            .setTitle('❌ Airport Photo Rejected')
                            .setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}\n\nFeel free to submit a new photo.`);
                        const payload = { content: `<@${targetUserId}>`, embeds: [userEmbed] };
                        if (rejectedImageUrl) {
                            userEmbed.setImage('attachment://rejected.webp');
                            payload.files = [{ attachment: rejectedImageUrl, name: 'rejected.webp' }];
                        }
                        await ch.send(payload).catch(() => {});
                    }
                }
                return;
            }

            if (customId.startsWith('ticket_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                const topic = customId.replace('ticket_modal_', '');
                const desc = interaction.fields.getTextInputValue('ticket_desc') || 'No description';
                const thread = await interaction.channel.threads.create({ name: `ticket-${interaction.user.username}-${topic}`, type: ChannelType.PrivateThread, reason: 'Support Ticket' });
                await thread.members.add(interaction.user.id);
                const embed = new EmbedBuilder().setTitle('🎫 Support Ticket').addFields({ name: 'Topic', value: topic }, { name: 'Description', value: desc }).setColor(THEME.WHITE);
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
                await thread.send({ content: `<@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [row] });
                await interaction.editReply(`Ticket created: <#${thread.id}>`);
                return;
            }

            // --- VA APPLICATION SUBMITTED ---
            if (customId === 'va_apply_modal') {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable (database not connected).');

                const name = interaction.fields.getTextInputValue('va_name').trim();
                // Store just the base radio callsign (e.g. "OCEAN"); the "##VA"
                // suffix is rendered at display time via formatVaCallsign().
                const callsignRaw = (interaction.fields.getTextInputValue('va_callsign') || '').trim().toUpperCase();
                const callsign = callsignRaw
                    ? (callsignRaw.replace(/\s*#+\s*VA$/i, '').replace(/\s+VA$/i, '').trim() || null)
                    : null;
                let type = (interaction.fields.getTextInputValue('va_type') || 'VA').trim().toUpperCase();
                if (type !== 'VA' && type !== 'VO') type = 'VA';
                const tagline = (interaction.fields.getTextInputValue('va_tagline') || '').trim().slice(0, 140);
                const linksRaw = (interaction.fields.getTextInputValue('va_links') || '').trim();

                // Parse the free-text links field: a discord invite vs a generic website.
                let websiteUrl = null, discordUrl = null;
                for (const line of linksRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)) {
                    if (/discord(\.gg|app\.com|\.com)/i.test(line)) discordUrl = line;
                    else if (!websiteUrl) websiteUrl = line;
                }

                try {
                    // Names are unique in the directory. Reuse an existing pending row the
                    // same owner already submitted (a re-apply after a "request edits"),
                    // otherwise refuse to clash with someone else's VA.
                    let ad = await VirtualAirlineAd.findOne({ name });
                    if (ad) {
                        if (ad.status === 'approved') {
                            return interaction.editReply(`⚠️ **${name}** is already registered and approved.`);
                        }
                        if (ad.ownerId && ad.ownerId !== interaction.user.id) {
                            return interaction.editReply(`❌ A VA named **${name}** has already been submitted by someone else. Please use a different name.`);
                        }
                        ad.callsign = callsign; ad.type = type; ad.tagline = tagline;
                        ad.websiteUrl = websiteUrl; ad.discordUrl = discordUrl;
                        ad.ownerId = interaction.user.id; ad.ownerName = interaction.user.username;
                        ad.status = 'pending';
                    } else {
                        ad = new VirtualAirlineAd({
                            name, callsign, type, tagline, websiteUrl, discordUrl,
                            ownerId: interaction.user.id, ownerName: interaction.user.username,
                            status: 'pending'
                        });
                    }
                    await ad.save();

                    const reviewChannel = await client.channels.fetch(VA_APPLICATION_CHANNEL_ID).catch(() => null);
                    if (reviewChannel) {
                        // Self-heal: make sure the Inflight VA Rep can see (and act on)
                        // the review channel, since they can now review applications.
                        if (reviewChannel.permissionOverwrites && !reviewChannel.permissionOverwrites.cache.get(INFLIGHT_VA_REP_ROLE_ID)) {
                            await reviewChannel.permissionOverwrites.edit(INFLIGHT_VA_REP_ROLE_ID, {
                                ViewChannel: true, SendMessages: true, ReadMessageHistory: true
                            }).catch(() => {});
                        }
                        await reviewChannel.send({
                            content: `<@&${ADMIN_ROLE_ID}> <@&${INFLIGHT_VA_REP_ROLE_ID}> new VA application`,
                            embeds: [buildVaReviewEmbed(ad)],
                            components: [buildVaReviewButtons(ad._id)]
                        });
                    }
                    return interaction.editReply(`✅ Your application for **${name}** has been submitted! Staff will review it shortly.`);
                } catch (e) {
                    console.error('❌ VA apply error:', e);
                    return interaction.editReply('❌ Could not submit your application. Please try again later.');
                }
            }

            // --- VA: REJECT (with reason) ---
            if (customId.startsWith('va_reject_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const [adId, msgId] = customId.replace('va_reject_modal_', '').split('_');
                const reason = interaction.fields.getTextInputValue('va_reason');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ Application not found.');

                ad.status = 'rejected';
                try { await ad.save(); } catch (_) {}

                if (ad.ownerId) {
                    const owner = await client.users.fetch(ad.ownerId).catch(() => null);
                    if (owner) await owner.send(`❌ Your VA application for **${ad.name}** was rejected.\n**Reason:** ${reason}`).catch(() => {});
                }
                // Update the original review message.
                const reviewChannel = await client.channels.fetch(VA_APPLICATION_CHANNEL_ID).catch(() => null);
                const reviewMsg = reviewChannel ? await reviewChannel.messages.fetch(msgId).catch(() => null) : null;
                if (reviewMsg) {
                    const rejEmbed = EmbedBuilder.from(reviewMsg.embeds[0] || buildVaReviewEmbed(ad))
                        .setTitle('❌ VA Application — Rejected')
                        .setColor(THEME.GRAY)
                        .addFields({ name: 'Rejection Reason', value: reason });
                    await reviewMsg.edit({ embeds: [rejEmbed], components: [] }).catch(() => {});
                }
                return interaction.editReply(`❌ Rejected **${ad.name}** and notified the applicant.`);
            }

            // --- VA: REQUEST EDITS ---
            if (customId.startsWith('va_editreq_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const [adId, msgId] = customId.replace('va_editreq_modal_', '').split('_');
                const changes = interaction.fields.getTextInputValue('va_changes');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ Application not found.');

                if (ad.ownerId) {
                    const owner = await client.users.fetch(ad.ownerId).catch(() => null);
                    if (owner) await owner.send(`✏️ Edits requested for your VA application **${ad.name}**:\n> ${changes}\n\nPlease run \`/va_apply\` again with the same name to resubmit.`).catch(() => {});
                }
                const reviewChannel = await client.channels.fetch(VA_APPLICATION_CHANNEL_ID).catch(() => null);
                const reviewMsg = reviewChannel ? await reviewChannel.messages.fetch(msgId).catch(() => null) : null;
                if (reviewMsg) {
                    await reviewMsg.reply(`✏️ <@${interaction.user.id}> requested edits from <@${ad.ownerId}>:\n> ${changes}`).catch(() => {});
                }
                return interaction.editReply('✏️ Edit request sent to the applicant. The application stays pending.');
            }

            // --- VA SETUP: DETAILS SUBMITTED (post-approval profile fill-in) ---
            if (customId.startsWith('va_setup_details_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const adId = customId.replace('va_setup_details_modal_', '');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ This VA listing no longer exists.');
                if (!canManageVa(interaction, ad)) return interaction.editReply('❌ Only this VA\'s owner (or staff) can edit its listing.');

                const splitList = (s) => (s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                const description = (interaction.fields.getTextInputValue('va_description') || '').trim();
                const region = (interaction.fields.getTextInputValue('va_region') || '').trim();
                const requirements = (interaction.fields.getTextInputValue('va_requirements') || '').trim();

                ad.description = description;
                if (region) ad.region = region;
                ad.hubs = splitList(interaction.fields.getTextInputValue('va_hubs')).map(h => h.toUpperCase());
                ad.fleet = splitList(interaction.fields.getTextInputValue('va_fleet')).map(f => f.toUpperCase());
                ad.requirements = requirements;

                try {
                    await ad.save();
                } catch (e) {
                    console.error('❌ VA setup details save error:', e);
                    return interaction.editReply('❌ Could not save those details. Please try again.');
                }
                return interaction.editReply({ content: '✅ Details saved! Here\'s how your listing looks now:', embeds: [buildVaInfoEmbed(ad)] });
            }

            // --- VA SETUP: LINKS & RECRUITING SUBMITTED ---
            if (customId.startsWith('va_setup_links_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const adId = customId.replace('va_setup_links_modal_', '');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ This VA listing no longer exists.');
                if (!canManageVa(interaction, ad)) return interaction.editReply('❌ Only this VA\'s owner (or staff) can edit its listing.');

                const splitList = (s) => (s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                const applicationUrl = (interaction.fields.getTextInputValue('va_applicationUrl') || '').trim();
                const ifcThreadUrl = (interaction.fields.getTextInputValue('va_ifcThreadUrl') || '').trim();
                const minGradeRaw = (interaction.fields.getTextInputValue('va_minGrade') || '').trim();
                const pilotCountRaw = (interaction.fields.getTextInputValue('va_pilotCount') || '').trim();

                ad.applicationUrl = applicationUrl || null;
                ad.ifcThreadUrl = ifcThreadUrl || null;

                const minGrade = parseInt(minGradeRaw, 10);
                ad.minGrade = (Number.isInteger(minGrade) && minGrade >= 1 && minGrade <= 5) ? minGrade : null;

                const pilotCount = parseInt(pilotCountRaw, 10);
                if (Number.isInteger(pilotCount) && pilotCount >= 0) ad.pilotCount = pilotCount;

                ad.tags = splitList(interaction.fields.getTextInputValue('va_tags')).map(t => t.toLowerCase());

                try {
                    await ad.save();
                } catch (e) {
                    console.error('❌ VA setup links save error:', e);
                    return interaction.editReply('❌ Could not save those links. Please try again.');
                }
                return interaction.editReply({ content: '✅ Links & recruiting info saved! Here\'s your updated listing:', embeds: [buildVaInfoEmbed(ad)] });
            }
        }

        // --- 5. SLASH COMMAND HANDLERS ---
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            // --- BOUNTY BOARD COMMAND ---
            if (commandName === 'bounty_board') {
                await interaction.deferReply();
                try {
                    const payload = await generateBountyBoard(0, 'type');
                    await interaction.editReply(payload);
                } catch (e) {
                    console.error(e);
                    await interaction.editReply('❌ Error generating the board. Ensure database connection is active.');
                }
                return;
            }

            if (commandName.startsWith('mod_')) {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
                }
                const targetUser = interaction.options.getUser('user');
                const targetMember = targetUser ? await interaction.guild.members.fetch(targetUser.id).catch(() => null) : null;
                const reason = interaction.options.getString('reason') || 'No reason provided';

                try {
                    if (commandName === 'mod_kick' && targetMember) {
                        await targetMember.kick(reason);
                        await interaction.reply({ content: `✅ Kicked ${targetUser.tag}.`, ephemeral: true });
                        await logModAction('KICK', interaction.user, targetUser, reason);
                    } else if (commandName === 'mod_ban') {
                        await interaction.guild.members.ban(targetUser, { reason });
                        await interaction.reply({ content: `✅ Banned ${targetUser.tag}.`, ephemeral: true });
                        await logModAction('BAN', interaction.user, targetUser, reason);
                    } else if (commandName === 'mod_timeout' && targetMember) {
                        const duration = interaction.options.getInteger('duration');
                        await targetMember.timeout(duration * 60 * 1000, reason);
                        await interaction.reply({ content: `✅ Timed out ${targetUser.tag}.`, ephemeral: true });
                        await logModAction('TIMEOUT', interaction.user, targetUser, reason, `Duration: ${duration}m`);
                    } else if (commandName === 'mod_purge') {
                        const amount = interaction.options.getInteger('amount');
                        const deleted = await interaction.channel.bulkDelete(amount, true);
                        await interaction.reply({ content: `✅ Deleted ${deleted.size} msgs.`, ephemeral: true });
                        await logModAction('PURGE', interaction.user, interaction.channel, 'Bulk Delete', `Count: ${deleted.size}`);
                    } else if (commandName === 'mod_lock') {
                        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
                        await interaction.reply({ content: '🔒 Locked.', ephemeral: true });
                        await logModAction('LOCK', interaction.user, interaction.channel, 'Lockdown');
                    } else if (commandName === 'mod_unlock') {
                        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null });
                        await interaction.reply({ content: '🔓 Unlocked.', ephemeral: true });
                        await logModAction('UNLOCK', interaction.user, interaction.channel, 'Unlock');
                    }
                } catch (e) { console.error(e); }
                return;
            }

            if (commandName === 'track') {
                await interaction.deferReply();
                const query = interaction.options.getString('target').toUpperCase().trim();
                const LIVE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run';
                try {
                    const sessionsRes = await axios.get(`${LIVE_API_URL}/if-sessions`);
                    const session = sessionsRes.data.sessions.find(s => s.name === 'Expert Server');
                    if (!session) return interaction.editReply("❌ Expert Server offline.");
                    const flightsRes = await axios.get(`${LIVE_API_URL}/flights/${session.id}`);
                    const match = flightsRes.data.flights.find(f => f.username?.toUpperCase().includes(query) || f.callsign?.toUpperCase().includes(query));
                    if (!match) return interaction.editReply(`❌ Pilot "${query}" not found.`);
                    
                    const phase = match.position.alt_ft < 1000 && match.position.gs_kt < 40 ? 'On Ground' : 'Flying';
                    const embed = new EmbedBuilder().setTitle(`📡 Tracking: ${match.callsign}`).setColor(THEME.WHITE).addFields({ name: 'Pilot', value: match.username || 'Unknown', inline: true }, { name: 'Aircraft', value: match.aircraft?.aircraftName || 'Unknown', inline: true }, { name: 'Altitude', value: `${Math.round(match.position.alt_ft).toLocaleString()} ft`, inline: true }, { name: 'Status', value: phase, inline: true });
                    await interaction.editReply({ embeds: [embed] });
                } catch (e) { await interaction.editReply("❌ API Connection Failed."); }
                return;
            }

            if (commandName === 'hangar') {
                await interaction.deferReply();
                const target = interaction.options.getUser('user') || interaction.user;
                try {
                    const stats = await CommunityAircraftModel.aggregate([{ $match: { $or: [{ contributorId: target.id }, { contributorName: target.username }] } }, { $group: { _id: null, total: { $sum: 1 }, types: { $addToSet: "$aircraftType" }, liveries: { $addToSet: "$liveryName" } } }]);
                    if (!stats.length) return interaction.editReply(`📂 ${target.username}'s hangar is empty.`);
                    const embed = new EmbedBuilder().setTitle(`✈️ ${target.username}'s Hangar`).setColor(THEME.WHITE).addFields({ name: 'Total Photos', value: `${stats[0].total}`, inline: true }, { name: 'Unique Types', value: `${stats[0].types.length}`, inline: true });
                    const latest = await CommunityAircraftModel.findOne({ $or: [{ contributorId: target.id }, { contributorName: target.username }] }).sort({ uploadedAt: -1 });
                    if (latest) embed.setImage(latest.imageUrl);
                    await interaction.editReply({ embeds: [embed] });
                } catch (e) { await interaction.editReply("❌ Database Error."); }
                return;
            }

            // --- GIVEAWAY COMMAND ---
            if (commandName === 'giveaway') {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
                }

                const durationMin = interaction.options.getInteger('duration');
                const prize = interaction.options.getString('prize') || DEFAULT_GIVEAWAY_PRIZE;
                const delivery = interaction.options.getString('delivery') || 'mod_message';
                const endsAt = Date.now() + durationMin * 60 * 1000;
                const endsUnix = Math.floor(endsAt / 1000);

                const embed = new EmbedBuilder()
                    .setTitle('🎉 GIVEAWAY 🎉')
                    .setColor(THEME.WHITE)
                    .setDescription('Click the button below to enter!')
                    .addFields(
                        { name: 'Prize', value: prize, inline: false },
                        { name: 'Ends', value: `<t:${endsUnix}:R> (<t:${endsUnix}:f>)`, inline: false },
                        { name: 'Entries', value: '0', inline: true },
                        { name: 'Hosted by', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setFooter({ text: BRAND_FOOTER })
                    .setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('giveaway_enter').setLabel('Enter Giveaway').setEmoji('🎉').setStyle(ButtonStyle.Success)
                );

                await interaction.reply({ content: '✅ Giveaway started!', ephemeral: true });
                const giveawayMessage = await interaction.channel.send({ embeds: [embed], components: [row] });

                activeGiveaways.set(giveawayMessage.id, {
                    prize,
                    delivery,
                    hostId: interaction.user.id,
                    channelId: interaction.channel.id,
                    messageId: giveawayMessage.id,
                    entrants: new Set(),
                    endsAt,
                    ended: false
                });

                // Persist so the giveaway survives a restart, then arm the timer.
                await persistGiveaway(giveawayMessage.id);
                scheduleGiveawayEnd(giveawayMessage.id, endsAt);
                return;
            }

            // --- VA: APPLY (opens the application modal) ---
            if (commandName === 'va_apply') {
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable right now.', ephemeral: true });
                }
                await interaction.showModal(buildVaApplyModal());
                return;
            }

            // --- VA: STAFF MANAGEMENT (add/remove rep, remove VA) ---
            if (commandName === 'va_addrep' || commandName === 'va_removerep' || commandName === 'va_remove') {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
                }
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable.', ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });

                const vaName = interaction.options.getString('va');
                const ad = await VirtualAirlineAd.findOne({ name: vaName }).catch(() => null);
                if (!ad) return interaction.editReply(`❌ No VA named **${vaName}** found.`);
                if (!ad.discordRoleId) return interaction.editReply(`❌ **${vaName}** hasn't been provisioned yet (approve its application first).`);

                const vaRole = interaction.guild.roles.cache.get(ad.discordRoleId) || await interaction.guild.roles.fetch(ad.discordRoleId).catch(() => null);
                if (!vaRole) return interaction.editReply(`❌ The role for **${vaName}** no longer exists.`);

                if (commandName === 'va_remove') {
                    try {
                        if (ad.discordChannelId) {
                            const ch = await interaction.guild.channels.fetch(ad.discordChannelId).catch(() => null);
                            if (ch) await ch.delete('VA removed by staff').catch(() => {});
                        }
                        await vaRole.delete('VA removed by staff').catch(() => {});
                        ad.discordRoleId = null; ad.discordChannelId = null;
                        await ad.save().catch(() => {});
                        return interaction.editReply(`🗑️ Removed the role and channel for **${vaName}**.`);
                    } catch (e) {
                        console.error('❌ va_remove error:', e);
                        return interaction.editReply('❌ Failed to remove the VA space.');
                    }
                }

                // add/remove rep
                const user = interaction.options.getUser('user');
                const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                if (!member) return interaction.editReply('❌ That user is not in this server.');

                try {
                    if (commandName === 'va_addrep') {
                        const repRole = await ensureVaRepRole(interaction.guild);
                        await member.roles.add(vaRole).catch(() => {});
                        if (repRole) await member.roles.add(repRole).catch(() => {});
                        return interaction.editReply(`✅ Added <@${user.id}> as a rep of **${vaName}** (VA channel + reps chat access granted).`);
                    } else {
                        // Remove only the VA-specific role; keep the shared rep role since
                        // the user may represent other VAs.
                        await member.roles.remove(vaRole).catch(() => {});
                        return interaction.editReply(`✅ Removed <@${user.id}> from **${vaName}**. (They keep the shared VA Rep role in case they rep other VAs — remove it manually if needed.)`);
                    }
                } catch (e) {
                    console.error('❌ va rep management error:', e);
                    return interaction.editReply('❌ Failed to update roles. Check the bot has **Manage Roles** and its role is above the VA roles.');
                }
            }
        }
        
        if (interaction.commandName === 'setup_tickets') {
            if (!interaction.member.permissions.has(GatewayIntentBits.Administrator) && interaction.channelId !== ADMIN_CHANNEL_ID) {
                return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
            }

            const ticketEmbed = new EmbedBuilder()
                .setTitle('🎫 Inflight Support')
                .setDescription('Click the button below to open a private support ticket.\n\nYou can ask about:\n• Database corrections\n• Submission issues\n• 🤝 VA partnerships\n• 💳 Inflight Pro subscription issues\n• Role/Account help')
                .setColor(THEME.WHITE)
                .setFooter({ text: 'Our team will assist you as soon as possible.' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('create_ticket_start')
                    .setLabel('Open Ticket')
                    .setEmoji('📩')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.channel.send({ embeds: [ticketEmbed], components: [row] });
            await interaction.reply({ content: '✅ Ticket panel posted!', ephemeral: true });
        }

        if (interaction.commandName === 'links') {
            const embed = new EmbedBuilder()
                .setTitle('🔗 Useful Resources')
                .setColor(THEME.WHITE)
                .setDescription('Here are the links to the flight tracker, forum thread, and livery database:')
                .addFields(
                    { name: '📡 Flight Tracker', value: '[Inflight.info](https://inflight.info)', inline: true },
                    { name: '📢 Official Thread', value: '[Community Forum](https://community.infiniteflight.com/t/inflight-official-open-beta-infinite-flight-tracker-update/1114286/80)', inline: true },
                    { name: '🎨 Livery Database', value: '[Livery Search](https://www.helpathand.nl/janpolet/infinite-flight-aircraft-liveries/)', inline: true }
                )
                .setFooter({ text: 'Use these to verify registrations!' });

            await interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'migrate_legacy') {
            if (!interaction.member.permissions.has(GatewayIntentBits.Administrator) && interaction.channelId !== ADMIN_CHANNEL_ID) {
                return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
            }

            await interaction.deferReply();

            try {
                // Only pull the fields we need to keep memory small on large guilds.
                const legacyRecords = await CommunityAircraftModel.find({
                    $or: [{ contributorId: { $exists: false } }, { contributorId: null }]
                }).select('contributorName').lean();

                if (legacyRecords.length === 0) {
                    return interaction.editReply("✅ Database is fully linked! No legacy records found.");
                }

                const uniqueNames = [...new Set(legacyRecords.map(r => r.contributorName))];

                // Resolve each legacy name via search() instead of fetching the
                // whole roster — Discord's `members.fetch()` pulls every member
                // into RAM, which blew up memory on larger servers.
                const resolveMember = async (name) => {
                    try {
                        const results = await interaction.guild.members.search({ query: name, limit: 5 });
                        return results.find(m =>
                            m.user.username.toLowerCase() === name.toLowerCase() ||
                            m.displayName.toLowerCase() === name.toLowerCase()
                        );
                    } catch (e) {
                        return null;
                    }
                };

                let linkedCount = 0;
                let failedCount = 0;
                let log = [];

                for (const name of uniqueNames) {
                    const match = await resolveMember(name);

                    if (match) {
                        const res = await CommunityAircraftModel.updateMany(
                            { contributorName: name },
                            { 
                                $set: { 
                                    contributorId: match.id,
                                    contributorName: match.user.username 
                                } 
                            }
                        );
                        linkedCount += res.modifiedCount;
                        log.push(`✅ Linked **${name}** → <@${match.id}> (${res.modifiedCount} docs)`);
                    } else {
                        failedCount++;
                        log.push(`❌ Could not find user for: **${name}**`);
                    }
                }

                const reportEmbed = new EmbedBuilder()
                    .setTitle('🔄 Migration Report')
                    .setDescription(`**Processed:** ${uniqueNames.length} unique names\n**Records Updated:** ${linkedCount}\n**Unmatched Users:** ${failedCount}\n\n${log.slice(0, 15).join('\n')}${log.length > 15 ? '\n...(and more)' : ''}`)
                    .setColor(linkedCount > 0 ? 0x00FF00 : 0xFF0000);

                await interaction.editReply({ embeds: [reportEmbed] });

            } catch (error) {
                console.error("Migration Error:", error);
                await interaction.editReply("❌ Error running migration. Check console.");
            }
        }

        if (interaction.commandName === 'submit') {
            const type = interaction.options.getString('aircraft_type');
            const livery = interaction.options.getString('livery');
            const tail = null;
            const photo = interaction.options.getAttachment('photo');

            if (!photo.contentType.startsWith('image/')) {
                return interaction.reply({ content: '❌ Invalid image.', ephemeral: true });
            }

            await startSubmissionFlow(interaction, type, livery, tail, photo.url, interaction.user, interaction.channelId);
        }

        if (interaction.commandName === 'lookup') {
            const query = interaction.options.getString('query');
            await interaction.deferReply();
            try {
                const result = await CommunityAircraftModel.findOne({
                    $or: [
                        { tailNumber: { $regex: new RegExp(`^${escapeRegex(query)}$`, "i") } }, 
                        { tailNumber: { $regex: escapeRegex(query), $options: 'i' } },
                        { liveryName: { $regex: escapeRegex(query), $options: 'i' } },
                        { aircraftType: { $regex: escapeRegex(query), $options: 'i' } } 
                    ]
                });
                if (!result) await interaction.editReply(`❌ No match for "**${query}**".`);
                else {
                    const embed = new EmbedBuilder().setTitle(`🔍 ${result.tailNumber}`).setColor(THEME.WHITE).addFields({ name: 'Aircraft', value: result.aircraftType, inline: true }, { name: 'Livery', value: result.liveryName, inline: true }, { name: 'Contributor', value: result.contributorName, inline: true }).setImage(result.imageUrl).setTimestamp(result.uploadedAt);
                    await interaction.editReply({ embeds: [embed] });
                }
            } catch (e) { await interaction.editReply('⚠️ Search Error.'); }
        }

        if (interaction.commandName === 'pull') {
            const typeInput = interaction.options.getString('aircraft_type');
            const liveryInput = interaction.options.getString('livery');
            
            await interaction.deferReply();
            
            try {
                const result = await CommunityAircraftModel.findOne({
                    aircraftType: { $regex: new RegExp(`^${escapeRegex(typeInput)}$`, "i") }, 
                    liveryName: { $regex: new RegExp(`^${escapeRegex(liveryInput)}$`, "i") }
                });

                if (!result) {
                    await interaction.editReply(`❌ No database record found for **${typeInput}** in **${liveryInput}** livery.`);
                    return;
                }

                // Show every stored photo (up to 3), not just the primary one.
                const pullImages = getEntryImages(result);
                const pullContributors = getEntryContributors(result);
                const primaryImage = pullImages[0] || result.imageUrl;

                const pullEmbed = new EmbedBuilder()
                    .setTitle('🗃️ Aircraft Database Record')
                    .setColor(THEME.WHITE)
                    .setDescription(`**Status:** ✅ Verified / Live${pullImages.length > 1 ? `\n📸 **${pullImages.length} photos** on record` : ''}`)
                    .addFields(
                        { name: 'Aircraft Type', value: result.aircraftType, inline: true },
                        { name: 'Livery', value: result.liveryName, inline: true },
                        { name: 'Tail Number', value: result.tailNumber.toUpperCase(), inline: true },
                        { name: 'Contributor', value: result.contributorName, inline: true },
                        { name: 'Uploaded', value: `<t:${Math.floor(new Date(result.uploadedAt).getTime() / 1000)}:R>`, inline: true }
                    )
                    .setImage(primaryImage)
                    .setFooter({ text: `Record ID: ${result._id}` });

                // Additional photos ride along as extra embeds so they all render
                // inside the same message.
                const galleryEmbeds = pullImages.slice(1).map((url, i) =>
                    new EmbedBuilder()
                        .setColor(THEME.WHITE)
                        .setTitle(`📷 Photo ${i + 2}`)
                        .setDescription(`Contributor: ${pullContributors[i + 1]?.name || result.contributorName}`)
                        .setImage(url)
                );

                await interaction.editReply({ embeds: [pullEmbed, ...galleryEmbeds] });

            } catch (e) { 
                console.error(e);
                await interaction.editReply('⚠️ Error retrieving record.'); 
            }
        }
        
        if (interaction.commandName === 'pull_airport') {
            const icaoInput = interaction.options.getString('icao').toUpperCase().trim();
            await interaction.deferReply();
            
            try {
                const airportData = await getAirportInfo(s3Client, icaoInput);
                
                const imageUrl = typeof airportData === 'string' ? airportData : (airportData?.url || airportData?.imageUrl);
                const contributor = airportData?.contributor || airportData?.contributorName || 'Unknown';

                if (!airportData || !imageUrl) {
                    const noPicEmbed = new EmbedBuilder()
                        .setTitle(`🏢 Airport: ${icaoInput}`)
                        .setColor(THEME.GRAY)
                        .setDescription(`❌ No picture submitted yet for **${icaoInput}**.`);
                    
                    return interaction.editReply({ embeds: [noPicEmbed] });
                }

                const pullEmbed = new EmbedBuilder()
                    .setTitle(`🏢 Airport Database Record`)
                    .setColor(THEME.WHITE) 
                    .setDescription(`**Status:** ✅ Verified / Live`) 
                    .addFields(
                        { name: 'ICAO Code', value: icaoInput, inline: true },
                        { name: 'Contributor', value: contributor, inline: true }
                    )
                    .setImage(imageUrl);

                await interaction.editReply({ embeds: [pullEmbed] });

            } catch (e) { 
                console.error("Airport Pull Error:", e);
                const noPicEmbed = new EmbedBuilder()
                    .setTitle(`🏢 Airport: ${icaoInput}`)
                    .setColor(THEME.GRAY)
                    .setDescription(`❌ No picture submitted yet for **${icaoInput}**.`);
                
                await interaction.editReply({ embeds: [noPicEmbed] });
            }
        }

        if (interaction.commandName === 'profile') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            await interaction.deferReply();
            try {
                const count = await CommunityAircraftModel.countDocuments({
                    $or: [
                        { contributorId: targetUser.id },
                        { contributorName: targetUser.username } 
                    ]
                });
                
                const recent = await CommunityAircraftModel.findOne({ 
                    $or: [{ contributorId: targetUser.id }, { contributorName: targetUser.username }]
                }).sort({ uploadedAt: -1 });

                const embed = new EmbedBuilder().setTitle(`✈️ Pilot Profile: ${targetUser.username}`).setThumbnail(targetUser.displayAvatarURL()).setColor(THEME.WHITE).addFields({ name: 'Total Contributions', value: `${count}`, inline: true });
                if (recent) { embed.addFields({ name: 'Last Spotted', value: `${recent.tailNumber}` }); embed.setImage(recent.imageUrl); }
                await interaction.editReply({ embeds: [embed] });
            } catch (e) { await interaction.editReply('Error.'); }
        }

        if (interaction.commandName === 'stats') {
            try {
                const count = await CommunityAircraftModel.countDocuments();
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('📊 Database Stats').setColor(THEME.WHITE).setDescription(`Tracked **${count}** aircraft.`)] });
            } catch (e) { await interaction.reply('Error.'); }
        }

        if (interaction.commandName === 'most_watched') {
            await interaction.deferReply();
            if (!DailyPilotStats) {
                return interaction.editReply('❌ Leaderboard is not available right now.');
            }
            try {
                const date = new Date().toISOString().split('T')[0];
                const top = await DailyPilotStats
                    .find({ date })
                    .sort({ viewCount: -1 })
                    .limit(5)
                    .select('pilotName viewCount -_id')
                    .lean();

                if (!top.length) {
                    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('📡 Most-Watched Pilots').setColor(THEME.WHITE).setDescription('Nobody has been tracked yet today. Open the tracker to start!')] });
                }

                const medals = ['🥇', '🥈', '🥉', '#4', '#5'];
                const description = top.map((p, i) => `${medals[i]} **${p.pilotName}** — ${p.viewCount} ${p.viewCount === 1 ? 'view' : 'views'}`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('📡 Most-Watched Pilots Today')
                    .setColor(THEME.WHITE)
                    .setDescription(description)
                    .setFooter({ text: 'Updates live as people tune in on Inflight.' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('most_watched error:', e);
                await interaction.editReply('⚠️ Failed to load the leaderboard.');
            }
        }

        if (interaction.commandName === 'random') {
            await interaction.deferReply();
            try {
                // $sample is the only way to get a true random doc without
                // pulling the whole collection into memory.
                const [pick] = await CommunityAircraftModel.aggregate([
                    { $match: { imageUrl: { $ne: null } } },
                    { $sample: { size: 1 } }
                ]);

                if (!pick) {
                    return interaction.editReply('📭 No aircraft in the database yet.');
                }

                const embed = new EmbedBuilder()
                    .setTitle(`🎲 ${pick.tailNumber || 'Unknown'}`)
                    .setColor(THEME.WHITE)
                    .addFields(
                        { name: 'Aircraft', value: pick.aircraftType || 'Unknown', inline: true },
                        { name: 'Livery', value: pick.liveryName || 'Unknown', inline: true },
                        { name: 'Contributor', value: pick.contributorName || 'Unknown', inline: true }
                    )
                    .setImage(pick.imageUrl)
                    .setTimestamp(pick.uploadedAt);
                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('random error:', e);
                await interaction.editReply('⚠️ Could not fetch a random aircraft.');
            }
        }

        if (interaction.commandName === 'recent') {
            await interaction.deferReply();
            try {
                const recents = await CommunityAircraftModel
                    .find({ imageUrl: { $ne: null } })
                    .sort({ uploadedAt: -1 })
                    .limit(5)
                    .lean();

                if (!recents.length) {
                    return interaction.editReply('📭 No submissions yet.');
                }

                const lines = recents.map(r => {
                    const ts = Math.floor(new Date(r.uploadedAt).getTime() / 1000);
                    return `**${r.tailNumber || '???'}** — ${r.aircraftType || 'Unknown'} / ${r.liveryName || 'Unknown'} (<t:${ts}:R>)`;
                });

                const embed = new EmbedBuilder()
                    .setTitle('🕒 Most Recent Submissions')
                    .setColor(THEME.WHITE)
                    .setDescription(lines.join('\n'))
                    .setImage(recents[0].imageUrl)
                    .setFooter({ text: `Newest photo: ${recents[0].tailNumber}` });
                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('recent error:', e);
                await interaction.editReply('⚠️ Could not load recent submissions.');
            }
        }

        if (interaction.commandName === 'help') {
            const embed = new EmbedBuilder()
                .setTitle('🤖 Inflight Bot — Command Guide')
                .setColor(THEME.WHITE)
                .setDescription('Everything this bot can do, grouped by purpose.')
                .addFields(
                    {
                        name: '📸 Submissions',
                        value: [
                            '`/submit` — submit a new aircraft photo',
                            'Or drop a photo directly in the submission channels and follow the prompts.'
                        ].join('\n')
                    },
                    {
                        name: '🔍 Database',
                        value: [
                            '`/lookup` — find an aircraft by tail, livery, or type',
                            '`/pull` — fetch a specific aircraft by type + livery',
                            '`/pull_airport` — fetch an airport photo by ICAO',
                            '`/random` — pull a random aircraft',
                            '`/recent` — last 5 submissions',
                            '`/stats` — database size'
                        ].join('\n')
                    },
                    {
                        name: '✈️ Live Flights',
                        value: [
                            '`/track` — track a live flight on Expert Server',
                            '`/most_watched` — top 5 tracked pilots today',
                            '`/links` — tracker, forum & livery DB links'
                        ].join('\n')
                    },
                    {
                        name: '👤 Contributors',
                        value: [
                            '`/profile` — quick contribution stats',
                            '`/hangar` — detailed breakdown of a user\'s hangar',
                            '`/bounty_board` — aircraft still needing better photos'
                        ].join('\n')
                    },
                    {
                        name: '🎉 Events',
                        value: [
                            '`/giveaway` — *(staff)* start a giveaway; members tap a button to enter and a winner is drawn automatically'
                        ].join('\n')
                    },
                    {
                        name: '🛫 Virtual Airlines',
                        value: [
                            '`/va_apply` — apply to register your VA/VO (staff approve in Discord)',
                            '`/va_addrep` / `/va_removerep` — *(staff)* manage a VA\'s reps',
                            '`/va_remove` — *(staff)* delete a VA\'s role + channel'
                        ].join('\n')
                    }
                )
                .setFooter({ text: 'Staff-only: mod_*, /giveaway, and /va_* management commands.' });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } catch (err) {
        // Top-level guard: any uncaught throw inside the interaction handler
        // used to bubble out as an unhandled rejection and (combined with the
        // bot living in the same process as Express) crash the API.
        console.error('🛑 interactionCreate handler error:', err && err.stack ? err.stack : err);
        try {
            if (interaction.isRepliable && interaction.isRepliable()) {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: '⚠️ Something went wrong handling that.', ephemeral: true }).catch(() => {});
                } else {
                    await interaction.reply({ content: '⚠️ Something went wrong handling that.', ephemeral: true }).catch(() => {});
                }
            }
        } catch (_) { /* swallow — we already logged */ }
      }
    });

    if (process.env.DISCORD_BOT_TOKEN) {
        client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
            console.error('🤖 Discord login failed (continuing without bot):', err && err.message ? err.message : err);
        });
    } else {
        console.log('⚠️ DISCORD_BOT_TOKEN missing.');
    }
};

module.exports = { startDiscordBot };
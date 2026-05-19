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
const { PutObjectCommand } = require('@aws-sdk/client-s3');
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

const METADATA_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api/metadata';
const BASE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api';

// --- CACHE SYSTEMS ---
let cachedAircraftData = []; 
let lastAircraftCacheUpdate = 0;
let cachedLiveries = {}; 

// --- SESSION MANAGEMENT ---
const userSessions = new Map(); 

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
    const { DailyPilotStats } = models;

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
            const embed = new EmbedBuilder()
                .addFields(
                    { name: 'Aircraft Type', value: tp, inline: true },
                    { name: 'Livery', value: l, inline: true },
                    { name: 'Tail Number', value: t.toUpperCase(), inline: true },
                )
                // Reference the attached preview.webp file so the image lives
                // *inside* the embed. Without this, edits via editReply (which
                // drops re-attached files) leave a fields-only embed with no
                // visible preview.
                .setImage('attachment://preview.webp');

            if (isDup) {
                embed.setTitle('⚠️ Existing Entry Detected');
                embed.setColor(0xFFA500);
                embed.setDescription(`**Note:** We already have a photo for **${tp}** in **${l}** livery.\nThis will generally be treated as a **replacement**.`);
            } else {
                embed.setTitle('📝 Review Your Submission');
                embed.setColor(0x0099FF);
                embed.setDescription('I have auto-detected the registration and corrected the names.\nPlease confirm the details below.');
                embed.setFooter({ text: 'Click Confirm to submit.' });
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
                const publicEmbed = new EmbedBuilder()
                    .setTitle('📸 New Aircraft Spotted! (Pending Review)')
                    .setColor(0xFFFF00) 
                    .setDescription(`A user has submitted a new photo! Status: **Under Review**`)
                    .addFields(
                        { name: 'Aircraft', value: currentType, inline: true },
                        { name: 'Livery', value: currentLivery, inline: true },
                        { name: 'Tail Number', value: currentTail.toUpperCase(), inline: true },
                        { name: 'Spotted By', value: `<@${user.id}>`, inline: false }
                    )
                    .setFooter({ text: 'Submissions are reviewed by admins before database entry.' })
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

                const adminRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId(`approve_${user.id}`).setLabel('Approve & Verify').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`edit_admin_${user.id}`).setLabel('Edit Details').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
                        new ButtonBuilder().setCustomId(`reject_${user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
                    );

                const embedsToSend = [finalEmbed];

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

                if (existingEntry) {
                    // It IS a duplicate/replacement
                    finalEmbed.setTitle('⚠️ REPLACEMENT REQUEST');
                    finalEmbed.setColor(0xFFA500);
                    finalEmbed.setDescription(`**Admin Notice:** Matches existing **${currentType} / ${currentLivery}**.\nApproving this will **REPLACE** the old image (shown below).`);

                    if (existingEntry.imageUrl) {
                        const comparisonEmbed = new EmbedBuilder()
                            .setTitle('📉 Current Database Image')
                            .setDescription(`**Current Contributor:** ${existingEntry.contributorName || 'Unknown'}\n**Tail:** ${existingEntry.tailNumber || 'Unknown'}`)
                            .setColor(0x2B2D31) 
                            .setImage(existingEntry.imageUrl)
                            .setFooter({ text: 'If you approve the new submission, this image will be deleted/overwritten.' });
                        
                        embedsToSend.push(comparisonEmbed);
                    }
                } else {
                    // It is NEW
                    finalEmbed.setTitle('📋 New Submission Request');
                    finalEmbed.setColor(0x00FF00);
                }
                
                finalEmbed.setFooter({ text: `Pending | User: ${user.id} | Msg: ${publicMsg.id} | Ch: ${originChannelId}` });

                await adminChannel.send({ embeds: embedsToSend, components: [adminRow], files: [attachmentData] });
                
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

            const leaderboardEmbed = new EmbedBuilder()
                .setTitle('🏆 Top Contributors Leaderboard')
                .setDescription(`Here are the top pilots helping build our database!\n\n${description}`)
                .setColor(0xFFD700)
                .setFooter({ text: 'Updated Daily • Submit photos to climb the ranks!' })
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
            
            const embed = new EmbedBuilder()
                .setTitle('🎯 Aircraft Photo Update Bounties')
                .setColor(0xFF8C00)
                .setFooter({ text: `Page ${safePage + 1} of ${totalPages} • Real-time live data` })
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
                .setColor(0x0099FF)
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
                    session.expiresAt = Date.now() + 300000;
                    userSessions.set(message.author.id, session);
                    await startSubmissionFlow(
                        message, 
                        session.type, 
                        session.livery, 
                        null, 
                        photo.url, 
                        message.author, 
                        message.channelId 
                    );
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

                const promptEmbed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setDescription(`**Thanks for the photo!**\nPlease click the button below to enter the **Aircraft** and **Livery** details.`);

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

                const promptEmbed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setDescription(`**Thanks for the airport photo!**\nPlease click the button below to enter the **ICAO Code** for this airport.`);

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
                const [_, targetUserId] = customId.split('_');
                const receivedEmbed = interaction.message.embeds[0];

                try {
                    const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number')?.value;
                    const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type')?.value;
                    const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery')?.value;
                    
                    if (!tailField || !typeField || !liveryField) throw new Error("Missing required aircraft embed fields.");

                    let imageUrl = receivedEmbed.image?.url || interaction.message.attachments.first()?.url;
                    const publicMsgId = (receivedEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];

                    const permanentUrl = await uploadImageToS3(imageUrl, tailField);
                    const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                    const contributorName = member ? member.displayName : (await client.users.fetch(targetUserId)).username;

                    // Automatically remove the 'needsUpdate' flag upon approval
                    const updateData = { 
                        contributorName, 
                        contributorId: targetUserId, 
                        aircraftType: typeField, 
                        liveryName: liveryField, 
                        imageUrl: permanentUrl, 
                        uploadedAt: new Date(),
                        needsUpdate: false 
                    };
                    
                    if (tailField !== 'UNKNOWN') updateData.tailNumber = tailField.toUpperCase();

                    await CommunityAircraftModel.findOneAndUpdate(
                        { aircraftType: { $regex: new RegExp(`^${escapeRegex(typeField)}$`, "i") }, liveryName: { $regex: new RegExp(`^${escapeRegex(liveryField)}$`, "i") } },
                        updateData, { upsert: true }
                    );

                    if (CONTRIBUTOR_ROLE_ID && member) await member.roles.add(CONTRIBUTOR_ROLE_ID).catch(() => {});

                    await interaction.editReply({ embeds: [EmbedBuilder.from(receivedEmbed).setColor(0x00FF00).setTitle('✅ Approved').setImage(null)], components: [] });

                    if (publicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                            await publicMsg.edit({ content: permanentUrl, embeds: [EmbedBuilder.from(publicMsg.embeds[0]).setTitle('✅ Verified').setColor(0x00FF00).setImage(null)], files: [] });
                        } catch (e) {}
                    }
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
                try {
                    const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                    const contributorName = sanitizeMetadata(member ? member.displayName : "Unknown");
                    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                    if (typeof deleteAirportImages === 'function') await deleteAirportImages(s3Client, icao);
                    const finalUrl = await uploadAirportImage(s3Client, { buffer: Buffer.from(response.data) }, icao, contributorName);
                    await interaction.editReply({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setTitle(`✅ Airport Approved: ${icao}`).setColor(0x00FF00).setImage(finalUrl)], components: [] });
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

            // --- TICKET BUTTONS ---
            if (customId === 'create_ticket_start') {
                const topicSelect = new StringSelectMenuBuilder().setCustomId('ticket_topic_select').setPlaceholder('Select a topic')
                    .addOptions(
                        { label: 'Database Correction', value: 'db_correction', emoji: '📝' },
                        { label: 'Submission Issue', value: 'submission_issue', emoji: '📸' },
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

                // Re-run the duplicate check so an admin edit that now matches
                // an existing record gets the replacement banner + comparison
                // embed, and an edit away from a duplicate clears them.
                const embedsToSend = [newEmbed];
                try {
                    const existingEntry = await CommunityAircraftModel.findOne({
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(newType)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(newLivery)}$`, "i") }
                    });

                    if (existingEntry) {
                        newEmbed.setTitle('⚠️ REPLACEMENT REQUEST');
                        newEmbed.setColor(0xFFA500);
                        newEmbed.setDescription(`**Admin Notice:** Matches existing **${newType} / ${newLivery}**.\nApproving this will **REPLACE** the old image (shown below).`);

                        if (existingEntry.imageUrl) {
                            embedsToSend.push(new EmbedBuilder()
                                .setTitle('📉 Current Database Image')
                                .setDescription(`**Current Contributor:** ${existingEntry.contributorName || 'Unknown'}\n**Tail:** ${existingEntry.tailNumber || 'Unknown'}`)
                                .setColor(0x2B2D31)
                                .setImage(existingEntry.imageUrl)
                                .setFooter({ text: 'If you approve the new submission, this image will be deleted/overwritten.' }));
                        }
                    } else {
                        newEmbed.setTitle('📋 New Submission Request');
                        newEmbed.setColor(0x00FF00);
                        // Strip any leftover replacement description from a prior state.
                        newEmbed.setDescription(null);
                    }
                } catch (e) {
                    console.error('Admin edit duplicate re-check failed:', e);
                }

                await interaction.editReply({ embeds: embedsToSend });
                return;
            }

            if (customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate();
                const targetUserId = customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                const oldEmbed = interaction.message.embeds[0];
                const publicMsgId = (oldEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const originChannelId = (oldEmbed.footer?.text || '').match(/Ch: (\d+)/)?.[1];

                await interaction.editReply({ embeds: [EmbedBuilder.from(oldEmbed).setTitle('❌ Rejected').setColor(0xFF0000).setDescription(`Reason: ${reason}`).setImage(null)], components: [] });
                
                if (publicMsgId) {
                    try {
                        const feed = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const msg = await feed.messages.fetch(publicMsgId);
                        await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle('❌ Rejected').setColor(0xFF0000).setImage(null)] });
                    } catch(e) {}
                }
                
                if (originChannelId) {
                    const channel = await client.channels.fetch(originChannelId).catch(() => null);
                    if (channel) await channel.send({ content: `<@${targetUserId}>`, embeds: [new EmbedBuilder().setTitle('❌ Photo Rejected').setDescription(`Reason: ${reason}`).setColor(0xFF0000)] });
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
                    const publicMsg = await feedChannel.send({ embeds: [new EmbedBuilder().setTitle('🏢 New Airport Submission').setColor(0xFFFF00).setImage(photoUrl).addFields({ name: 'ICAO', value: icao })] });

                    const adminEmbed = new EmbedBuilder().setTitle('🏢 Airport Review').setColor(0x0099FF).setImage(photoUrl).addFields({ name: 'ICAO', value: icao }).setFooter({ text: `User: ${interaction.user.id} | Msg: ${publicMsg.id} | Ch: ${interaction.channelId}` });
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

                await interaction.editReply({ embeds: [EmbedBuilder.from(oldEmbed).setTitle('❌ Airport Rejected').setColor(0xFF0000).setDescription(`Reason: ${reason}`).setImage(null)], components: [] });
                if (publicMsgId) {
                    try {
                        const feed = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const msg = await feed.messages.fetch(publicMsgId);
                        await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle('❌ Rejected').setColor(0xFF0000).setImage(null)] });
                    } catch(e) {}
                }
                if (originChannelId) {
                    const ch = await client.channels.fetch(originChannelId).catch(() => null);
                    if (ch) await ch.send({ content: `<@${targetUserId}>`, embeds: [new EmbedBuilder().setTitle('❌ Airport Photo Rejected').setDescription(`Reason: ${reason}`).setColor(0xFF0000)] });
                }
                return;
            }

            if (customId.startsWith('ticket_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                const topic = customId.replace('ticket_modal_', '');
                const desc = interaction.fields.getTextInputValue('ticket_desc') || 'No description';
                const thread = await interaction.channel.threads.create({ name: `ticket-${interaction.user.username}-${topic}`, type: ChannelType.PrivateThread, reason: 'Support Ticket' });
                await thread.members.add(interaction.user.id);
                const embed = new EmbedBuilder().setTitle('🎫 Support Ticket').addFields({ name: 'Topic', value: topic }, { name: 'Description', value: desc }).setColor(0x0099FF);
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
                await thread.send({ content: `<@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [row] });
                await interaction.editReply(`Ticket created: <#${thread.id}>`);
                return;
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
                    const embed = new EmbedBuilder().setTitle(`📡 Tracking: ${match.callsign}`).setColor(0x00FF99).addFields({ name: 'Pilot', value: match.username || 'Unknown', inline: true }, { name: 'Aircraft', value: match.aircraft?.aircraftName || 'Unknown', inline: true }, { name: 'Altitude', value: `${Math.round(match.position.alt_ft).toLocaleString()} ft`, inline: true }, { name: 'Status', value: phase, inline: true });
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
                    const embed = new EmbedBuilder().setTitle(`✈️ ${target.username}'s Hangar`).setColor(0xFFD700).addFields({ name: 'Total Photos', value: `${stats[0].total}`, inline: true }, { name: 'Unique Types', value: `${stats[0].types.length}`, inline: true });
                    const latest = await CommunityAircraftModel.findOne({ $or: [{ contributorId: target.id }, { contributorName: target.username }] }).sort({ uploadedAt: -1 });
                    if (latest) embed.setImage(latest.imageUrl);
                    await interaction.editReply({ embeds: [embed] });
                } catch (e) { await interaction.editReply("❌ Database Error."); }
                return;
            }
        }
        
        if (interaction.commandName === 'setup_tickets') {
            if (!interaction.member.permissions.has(GatewayIntentBits.Administrator) && interaction.channelId !== ADMIN_CHANNEL_ID) {
                return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
            }

            const ticketEmbed = new EmbedBuilder()
                .setTitle('🎫 Inflight Support')
                .setDescription('Click the button below to open a private support ticket.\n\nYou can ask about:\n• Database corrections\n• Submission issues\n• Role/Account help')
                .setColor(0x0099FF)
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
                .setColor(0x0099FF)
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
                    const embed = new EmbedBuilder().setTitle(`🔍 ${result.tailNumber}`).setColor(0x0099FF).addFields({ name: 'Aircraft', value: result.aircraftType, inline: true }, { name: 'Livery', value: result.liveryName, inline: true }, { name: 'Contributor', value: result.contributorName, inline: true }).setImage(result.imageUrl).setTimestamp(result.uploadedAt);
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

                const pullEmbed = new EmbedBuilder()
                    .setTitle('🗃️ Aircraft Database Record')
                    .setColor(0x00FF00) 
                    .setDescription(`**Status:** ✅ Verified / Live`) 
                    .addFields(
                        { name: 'Aircraft Type', value: result.aircraftType, inline: true },
                        { name: 'Livery', value: result.liveryName, inline: true },
                        { name: 'Tail Number', value: result.tailNumber.toUpperCase(), inline: true },
                        { name: 'Contributor', value: result.contributorName, inline: true },
                        { name: 'Uploaded', value: `<t:${Math.floor(new Date(result.uploadedAt).getTime() / 1000)}:R>`, inline: true }
                    )
                    .setImage(result.imageUrl)
                    .setFooter({ text: `Record ID: ${result._id}` });

                await interaction.editReply({ embeds: [pullEmbed] });

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
                        .setColor(0x808080)
                        .setDescription(`❌ No picture submitted yet for **${icaoInput}**.`);
                    
                    return interaction.editReply({ embeds: [noPicEmbed] });
                }

                const pullEmbed = new EmbedBuilder()
                    .setTitle(`🏢 Airport Database Record`)
                    .setColor(0x00FF00) 
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
                    .setColor(0x808080)
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

                const embed = new EmbedBuilder().setTitle(`✈️ Pilot Profile: ${targetUser.username}`).setThumbnail(targetUser.displayAvatarURL()).setColor(0xFFD700).addFields({ name: 'Total Contributions', value: `${count}`, inline: true });
                if (recent) { embed.addFields({ name: 'Last Spotted', value: `${recent.tailNumber}` }); embed.setImage(recent.imageUrl); }
                await interaction.editReply({ embeds: [embed] });
            } catch (e) { await interaction.editReply('Error.'); }
        }

        if (interaction.commandName === 'stats') {
            try {
                const count = await CommunityAircraftModel.countDocuments();
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('📊 Database Stats').setColor(0x00FF99).setDescription(`Tracked **${count}** aircraft.`)] });
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
                    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('📡 Most-Watched Pilots').setColor(0x5865F2).setDescription('Nobody has been tracked yet today. Open the tracker to start!')] });
                }

                const medals = ['🥇', '🥈', '🥉', '#4', '#5'];
                const description = top.map((p, i) => `${medals[i]} **${p.pilotName}** — ${p.viewCount} ${p.viewCount === 1 ? 'view' : 'views'}`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('📡 Most-Watched Pilots Today')
                    .setColor(0x5865F2)
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
                    .setColor(0x9B59B6)
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
                    .setColor(0x00FF99)
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
                .setColor(0x0099FF)
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
                    }
                )
                .setFooter({ text: 'Mod commands (mod_*) are restricted to staff.' });
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
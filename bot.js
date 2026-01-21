// bot.js

const { startAirportSubmissionFlow } = require('./airportHandler');

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
const AIRPORT_SUBMISSION_CHANNEL_ID = '1463634001020325959';

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

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region) => {

    const client = new Client({ 
        makeCache: Options.cacheEverything({
            MessageManager: 50, 
            UserManager: 100,  
            GuildMemberManager: 100,
            ThreadManager: 10,
        }),
        sweepers: {
            messages: {
                interval: 300, 
                lifetime: 900, 
            },
            users: {
                interval: 3600, 
                filter: () => user => user.id !== client.user.id, 
            },
        },
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers, 
            GatewayIntentBits.MessageContent 
        ] 
    });

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
                );

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
            new SlashCommandBuilder().setName('submit').setDescription('Submit a new aircraft photo')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true))
                .addAttachmentOption(o => o.setName('photo').setDescription('Upload photo').setRequired(true)),
            new SlashCommandBuilder().setName('links').setDescription('Get helpful resource links (Tracker, Forum, Liveries)'),
            
            // NEW: Live Flight Tracking
            new SlashCommandBuilder()
                .setName('track')
                .setDescription('Track a live flight on the server')
                .addStringOption(o => 
                    o.setName('target')
                     .setDescription('Username or Callsign (e.g., "Delta 101")')
                     .setRequired(true)
                ),

            // NEW: Personal Hangar Stats
            new SlashCommandBuilder()
                .setName('hangar')
                .setDescription('View detailed breakdown of a user\'s contributions')
                .addUserOption(o => 
                    o.setName('user')
                     .setDescription('User to inspect')
                ),

            // System Admin Commands
            new SlashCommandBuilder().setName('migrate_legacy').setDescription('[SYSTEM] Auto-match legacy DB names to current Discord Users').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
            new SlashCommandBuilder().setName('setup_tickets').setDescription('[SYSTEM] Post the help ticket panel in the current channel').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

            // --- NEW MODERATOR COMMANDS ---
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
    if (message.author.bot) return;

    // Airport Channel Logic
    if (message.channelId === AIRPORT_SUBMISSION_CHANNEL_ID) {
        if (message.attachments.size > 0) {
            const photo = message.attachments.first();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`start_airport_ident_${message.author.id}`)
                    .setLabel('Identify Airport (ICAO)')
                    .setEmoji('🏢')
                    .setStyle(ButtonStyle.Primary)
            );

            await message.reply({ 
                content: "Thanks for the airport photo! Please provide the ICAO code.", 
                components: [row] 
            });
        }
        return; // Prevent fallthrough to aircraft logic
    }

        const isSubmissionChannel = message.channelId === SUBMISSION_CHANNEL_ID || 
                                   (message.channel.isThread() && message.channel.parentId === SUBMISSION_CHANNEL_ID);

        if (isSubmissionChannel) {
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
    });

    client.on('interactionCreate', async interaction => {
        
        // --- 1. TICKET SYSTEM: INITIAL BUTTON CLICK ---
        if (interaction.isButton() && interaction.customId === 'create_ticket_start') {
            const topicSelect = new StringSelectMenuBuilder()
                .setCustomId('ticket_topic_select')
                .setPlaceholder('Select a topic for your ticket')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Database Correction').setValue('db_correction').setDescription('Report incorrect info in the database').setEmoji('📝'),
                    new StringSelectMenuOptionBuilder().setLabel('Submission Issue').setValue('submission_issue').setDescription('Problems uploading or submitting photos').setEmoji('📸'),
                    new StringSelectMenuOptionBuilder().setLabel('Role/Account Help').setValue('role_help').setDescription('Questions about roles or your profile').setEmoji('👤'),
                    new StringSelectMenuOptionBuilder().setLabel('Other Inquiry').setValue('other').setDescription('General questions or feedback').setEmoji('❓'),
                );
            
            await interaction.reply({ 
                content: 'Please select what you need help with:', 
                components: [new ActionRowBuilder().addComponents(topicSelect)], 
                ephemeral: true 
            });
            return;
        }

        // --- 2. TICKET SYSTEM: TOPIC SELECTION -> SHOW MODAL ---
        if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_topic_select') {
            const selectedTopic = interaction.values[0];
            
            // We encode the topic into the modal ID to pass it to the next step
            const modal = new ModalBuilder()
                .setCustomId(`ticket_modal_${selectedTopic}`)
                .setTitle('Ticket Details');

            const descInput = new TextInputBuilder()
                .setCustomId('ticket_desc')
                .setLabel("Description (Optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Please describe your issue here so we can help you faster.")
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(descInput));
            await interaction.showModal(modal);
            return;
        }

        // --- 3. TICKET SYSTEM: MODAL SUBMIT -> CREATE THREAD ---
        if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal_')) {
            await interaction.deferReply({ ephemeral: true });
            
            const topicKey = interaction.customId.replace('ticket_modal_', '');
            const description = interaction.fields.getTextInputValue('ticket_desc') || 'No description provided.';
            
            // Map keys to readable titles
            const topicTitles = {
                'db_correction': 'Database Correction',
                'submission_issue': 'Submission Issue',
                'role_help': 'Role/Account Help',
                'other': 'Other Inquiry'
            };
            const topicTitle = topicTitles[topicKey] || 'Support Ticket';

            try {
                // Ensure we are in the ticket channel (or fetch it)
                const ticketChannel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);
                if (!ticketChannel) throw new Error("Ticket channel not configured correctly.");

                // Create Private Thread
                const threadName = `ticket-${interaction.user.username}-${Date.now().toString().slice(-4)}`;
                
                const thread = await ticketChannel.threads.create({
                    name: threadName,
                    type: ChannelType.PrivateThread, 
                    autoArchiveDuration: 1440, // 24 hours
                    reason: `Support ticket for ${interaction.user.tag}`
                });

                // Add User
                await thread.members.add(interaction.user.id);
                
                // Construct the initial message inside the thread
                const ticketEmbed = new EmbedBuilder()
                    .setTitle(`🎫 ${topicTitle}`)
                    .setColor(0x00FF00)
                    .addFields(
                        { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Topic', value: topicTitle, inline: true },
                        { name: 'Description', value: description }
                    )
                    .setTimestamp();

                const closeButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('close_ticket_action')
                        .setLabel('Close Ticket (Admin Only)')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🔒')
                );

                // Ping admins and send embed
                await thread.send({ 
                    content: `Welcome <@${interaction.user.id}>. Support will be with you shortly.\n<@&${ADMIN_ROLE_ID}>`, 
                    embeds: [ticketEmbed], 
                    components: [closeButton] 
                });

                await interaction.editReply({ content: `✅ Ticket created! Head over to <#${thread.id}>.` });

            } catch (error) {
                console.error("Ticket Creation Error:", error);
                await interaction.editReply({ content: "❌ Failed to create ticket. Please contact an admin directly." });
            }
            return;
        }

        // --- 4. TICKET SYSTEM: CLOSE TICKET (ADMIN ONLY) ---
        if (interaction.isButton() && interaction.customId === 'close_ticket_action') {
            await interaction.deferReply({ ephemeral: true });

            // Check Admin Permissions
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.editReply({ content: "❌ Only Admins can close tickets." });
            }

            const thread = interaction.channel;
            if (!thread.isThread()) return interaction.editReply({ content: "This is not a thread." });

            try {
                // Generate Transcript
                const messages = await thread.messages.fetch({ limit: 100 });
                const reversed = Array.from(messages.values()).reverse();
                
                let transcriptText = `TRANSCRIPT FOR TICKET: ${thread.name}\nDATE: ${new Date().toISOString()}\n------------------------------------------------\n\n`;
                
                reversed.forEach(m => {
                    const time = new Date(m.createdTimestamp).toLocaleString();
                    const content = m.content || '[No Content]';
                    const attachments = m.attachments.size > 0 ? ` [Attachments: ${m.attachments.map(a => a.url).join(', ')}]` : '';
                    transcriptText += `[${time}] ${m.author.tag}: ${content}${attachments}\n`;
                });

                // Send to Transcript Channel
                const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
                if (transcriptChannel) {
                    const buffer = Buffer.from(transcriptText, 'utf-8');
                    const attachment = new AttachmentBuilder(buffer, { name: `${thread.name}-transcript.txt` });
                    
                    const logEmbed = new EmbedBuilder()
                        .setTitle('🔒 Ticket Closed')
                        .setColor(0xFF0000)
                        .addFields(
                            { name: 'Ticket', value: thread.name, inline: true },
                            { name: 'Closed By', value: interaction.user.tag, inline: true }
                        )
                        .setTimestamp();

                    await transcriptChannel.send({ embeds: [logEmbed], files: [attachment] });
                }

                await interaction.editReply("Ticket closed. Deleting thread in 5 seconds...");
                
                setTimeout(async () => {
                    try { await thread.delete(); } catch(e) {}
                }, 5000);

            } catch (error) {
                console.error("Ticket Close Error:", error);
                await interaction.editReply("❌ Error closing ticket.");
            }
            return;
        }

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
            }
        }

        if (interaction.isButton()) {

            if (interaction.customId.startsWith('start_airport_ident_')) {
         const modal = new ModalBuilder().setCustomId('airport_ident_modal').setTitle('Airport Details');
         const icaoInput = new TextInputBuilder()
            .setCustomId('a_icao').setLabel("What is the ICAO code?").setPlaceholder("e.g. KJFK, EGLL").setStyle(TextInputStyle.Short).setRequired(true);
         modal.addComponents(new ActionRowBuilder().addComponents(icaoInput));
         await interaction.showModal(modal);
    }

    if (interaction.customId.startsWith('approve_airport_')) {
        await interaction.deferUpdate();
        const targetUserId = interaction.customId.split('_')[2];
        const embed = interaction.message.embeds[0];
        const icao = embed.fields.find(f => f.name === 'ICAO').value;
        const imageUrl = interaction.message.attachments.first().url;

        try {
            // Post to your backend API
            await axios.post(`${BASE_API_URL}/airports`, {
                icao: icao,
                contributorName: targetUserId, // You can fetch display name if preferred
                // Note: Your backend expects a file upload, so you might need to adjust 
                // the backend /api/airports route to accept a URL or handle S3 here.
            });

            await interaction.editReply({ content: `✅ Airport ${icao} Approved!`, embeds: [], components: [] });
        } catch (err) {
            await interaction.followUp({ content: '❌ API Error.', ephemeral: true });
        }
    }
}

if (interaction.isModalSubmit() && interaction.customId === 'airport_ident_modal') {
    const icao = interaction.fields.getTextInputValue('a_icao');
    const photoUrl = (await interaction.channel.messages.fetch(interaction.message.reference.messageId)).attachments.first().url;
    await startAirportSubmissionFlow(interaction, icao, photoUrl, interaction.user);
}
            
            if (interaction.customId.startsWith('edit_admin_')) {
                const receivedEmbed = interaction.message.embeds[0];
                
                const currentTail = receivedEmbed.fields.find(f => f.name === 'Tail Number')?.value || 'UNKNOWN';
                const currentType = receivedEmbed.fields.find(f => f.name === 'Aircraft Type')?.value || '';
                const currentLivery = receivedEmbed.fields.find(f => f.name === 'Livery')?.value || '';

                const modal = new ModalBuilder()
                    .setCustomId('admin_edit_modal')
                    .setTitle('Edit Submission Details');

                const tailInput = new TextInputBuilder()
                    .setCustomId('ae_tail')
                    .setLabel("Tail Number")
                    .setPlaceholder("e.g. N12345") 
                    .setValue(currentTail)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const typeInput = new TextInputBuilder()
                    .setCustomId('ae_type')
                    .setLabel("Aircraft Type")
                    .setPlaceholder("e.g. 737-8 MAX") 
                    .setValue(currentType)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const liveryInput = new TextInputBuilder()
                    .setCustomId('ae_livery')
                    .setLabel("Livery")
                    .setPlaceholder("e.g. Delta Air Lines") 
                    .setValue(currentLivery)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(tailInput),
                    new ActionRowBuilder().addComponents(typeInput),
                    new ActionRowBuilder().addComponents(liveryInput)
                );

                await interaction.showModal(modal);
                return;
            }

            if (interaction.customId.startsWith('start_ident_')) {
                const originalUserId = interaction.customId.split('_')[2];
                if (interaction.user.id !== originalUserId) {
                    return interaction.reply({ content: "This is not your photo.", ephemeral: true });
                }

                const modal = new ModalBuilder().setCustomId('identify_modal').setTitle('Aircraft Details');
                
                const typeInput = new TextInputBuilder()
                    .setCustomId('i_type')
                    .setLabel("What aircraft is this?")
                    .setPlaceholder("e.g. 737-8 MAX, 777-300ER") 
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                    
                const liveryInput = new TextInputBuilder()
                    .setCustomId('i_livery')
                    .setLabel("What livery is this?")
                    .setPlaceholder("e.g. Delta Air Lines, Generic, Private") 
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                
                modal.addComponents(new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput));
                await interaction.showModal(modal);
                return;
            }

            if (interaction.customId.startsWith('approve_')) {
                await interaction.deferUpdate();
                
                const [_, targetUserId] = interaction.customId.split('_');
                let receivedEmbed = interaction.message.embeds[0];
                
                const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number').value;
                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                
                let imageUrl = receivedEmbed.image?.url;
                if (!imageUrl && interaction.message.attachments.size > 0) {
                    imageUrl = interaction.message.attachments.first().url;
                }

                const footerText = receivedEmbed.footer?.text || '';
                const publicMsgId = footerText.match(/Msg: (\d+)/)?.[1];

                try {
                    const existingEntry = await CommunityAircraftModel.findOne({ 
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(typeField)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(liveryField)}$`, "i") }
                    });
                    
                    const permanentUrl = await uploadImageToS3(imageUrl, tailField);
                    
                    let contributorName = "Unknown";
                    try { 
                        const member = await interaction.guild.members.fetch(targetUserId); 
                        contributorName = member.displayName;
                    } catch (e) {
                        try {
                            const cUser = await client.users.fetch(targetUserId);
                            contributorName = cUser.username;
                        } catch (err) {}
                    }

                    const updateData = {
                        contributorName: contributorName,
                        contributorId: targetUserId, 
                        aircraftType: typeField,
                        liveryName: liveryField,
                        imageUrl: permanentUrl,
                        uploadedAt: new Date()
                    };
                    if (tailField !== 'UNKNOWN') updateData.tailNumber = tailField.toUpperCase();

                    if (existingEntry) {
                        Object.assign(existingEntry, updateData);
                        await existingEntry.save();
                    } else {
                        await new CommunityAircraftModel(updateData).save();
                    }

                    try {
                        const member = await interaction.guild.members.fetch(targetUserId);
                        if (CONTRIBUTOR_ROLE_ID) await member.roles.add(CONTRIBUTOR_ROLE_ID);
                    } catch (e) {}

                    const approveEmbed = EmbedBuilder.from(receivedEmbed)
                        .setColor(0x00FF00)
                        .setTitle('✅ Submission Approved')
                        .setImage(null) 
                        .setFooter({ text: `Approved by ${interaction.user.tag}` });
                    
                    await interaction.editReply({ embeds: [approveEmbed], components: [] });

                    if (publicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                            const publicEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                                .setTitle('✅ Verified Aircraft Spotted!')
                                .setColor(0x00FF00)
                                .setDescription(`Verified and added to database.`)
                                .setImage(null)
                                .setFooter({ text: 'Verified by Staff' });
                            
                            await publicMsg.edit({ content: permanentUrl, embeds: [publicEmbed], files: [] });
                        } catch (e) {}
                    }
                    
                    try { 
                        const user = await client.users.fetch(targetUserId);
                        const userNotifyEmbed = new EmbedBuilder()
                            .setTitle('✅ Submission Approved')
                            .setColor(0x00FF00)
                            .setDescription(`Your photo of **${typeField}** has been approved!`)
                            .setImage(permanentUrl); 
                        await user.send({ embeds: [userNotifyEmbed] }); 
                    } catch (e) { }

                    receivedEmbed = null;

                } catch (error) {
                    console.error(error);
                    await interaction.followUp({ content: '❌ Error saving to database/S3.', ephemeral: true });
                }
            }

            if (interaction.customId.startsWith('reject_')) {
                const targetUserId = interaction.customId.split('_')[1];
                const modal = new ModalBuilder().setCustomId(`rejectModal_${targetUserId}`).setTitle('Rejection Reason');
                const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel("Why is this being rejected?").setStyle(TextInputStyle.Paragraph).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
            }
        }

        if (interaction.isModalSubmit()) {

            if (interaction.customId === 'admin_edit_modal') {
                await interaction.deferUpdate();
                
                // Let is used here so we can update the tail if auto-lookup finds a match
                let newTail = interaction.fields.getTextInputValue('ae_tail');
                const newType = interaction.fields.getTextInputValue('ae_type');
                const newLivery = interaction.fields.getTextInputValue('ae_livery');

                const oldEmbed = interaction.message.embeds[0];
                const oldTail = oldEmbed.fields.find(f => f.name === 'Tail Number')?.value || 'UNKNOWN';

                // --- AUTO REGISTRATION RE-LOOKUP LOGIC ---
                // If the tail field hasn't been manually changed by the moderator (it equals the old value),
                // OR if the current tail is simply 'UNKNOWN', we attempt to re-calculate the registration
                // based on the newly edited Aircraft Type and Livery.
                if (newTail === oldTail || newTail.toUpperCase() === 'UNKNOWN') {
                    const reCheckReg = lookupRegistration(newType, newLivery);
                    if (reCheckReg) {
                        newTail = reCheckReg;
                    }
                }
                // --- END LOGIC ---

                const newEmbed = EmbedBuilder.from(oldEmbed);

                const fields = newEmbed.data.fields;
                const tailIdx = fields.findIndex(f => f.name === 'Tail Number');
                if (tailIdx >= 0) fields[tailIdx].value = newTail.toUpperCase();
                
                const typeIdx = fields.findIndex(f => f.name === 'Aircraft Type');
                if (typeIdx >= 0) fields[typeIdx].value = newType;

                const liveryIdx = fields.findIndex(f => f.name === 'Livery');
                if (liveryIdx >= 0) fields[liveryIdx].value = newLivery;

                newEmbed.setFields(fields);
                
                await interaction.editReply({ embeds: [newEmbed] });
                return;
            }

            if (interaction.customId === 'identify_modal') {
                await interaction.deferReply({ ephemeral: true });

                const type = interaction.fields.getTextInputValue('i_type');
                const livery = interaction.fields.getTextInputValue('i_livery');
                let tail = null; 

                let photoUrl = null;
                try {
                    if (interaction.message.reference && interaction.message.reference.messageId) {
                        const originalMsg = await interaction.channel.messages.fetch(interaction.message.reference.messageId);
                        if (originalMsg && originalMsg.attachments.size > 0) {
                            photoUrl = originalMsg.attachments.first().url;
                        }
                    }
                } catch (err) { 
                    console.error("Could not fetch original image:", err); 
                }

                if (!photoUrl) {
                    return interaction.editReply("❌ Could not find the original image. Please upload again.");
                }

                await startSubmissionFlow(interaction, type, livery, tail, photoUrl, interaction.user, interaction.channelId);
                
                try { await interaction.message.delete(); } catch(e) {}
                return;
            }

            if (interaction.customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate(); 
                const targetUserId = interaction.customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                
                let originalEmbed = interaction.message.embeds[0];
                const aircraftName = originalEmbed.fields.find(f => f.name === 'Aircraft Type')?.value || 'Unknown Aircraft';
                
                let thumbUrl = originalEmbed.image?.url;
                if (!thumbUrl && interaction.message.attachments.size > 0) {
                     thumbUrl = interaction.message.attachments.first().url;
                }

                const footerText = originalEmbed.footer?.text || '';
                const publicMsgId = footerText.match(/Msg: (\d+)/)?.[1];
                const originChannelId = footerText.match(/Ch: (\d+)/)?.[1];

                const rejectedEmbed = EmbedBuilder.from(originalEmbed)
                    .setTitle('❌ Submission Rejected')
                    .setColor(0xFF0000)
                    .setDescription(`**Reason:** ${reason}`)
                    .setImage(null) 
                    .setFooter({ text: `Rejected by ${interaction.user.tag}` });
                
                await interaction.editReply({ embeds: [rejectedEmbed], components: [] }); 

                if (publicMsgId) {
                    try {
                        const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                        if (publicMsg) {
                            const publicRejectedEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                                .setTitle('❌ Submission Rejected')
                                .setColor(0xFF0000) 
                                .setDescription(`This submission was not accepted by the moderators.`)
                                .setImage(null) 
                                .setFooter({ text: `Reviewed by Staff` });
                            await publicMsg.edit({ embeds: [publicRejectedEmbed] });
                        }
                    } catch (e) {}
                }

                if (originChannelId) {
                    try {
                        const originChannel = await client.channels.fetch(originChannelId);
                        if (originChannel) {
                            const rejectionNotifyEmbed = new EmbedBuilder()
                                .setTitle('❌ Photo Rejected')
                                .setColor(0xFF0000)
                                .setDescription(`Hey <@${targetUserId}>, this specific photo was rejected.`)
                                .addFields({ name: 'Reason', value: reason })
                                .setThumbnail(thumbUrl) 
                                .setFooter({ text: 'You can upload a different photo below to try again!' });

                            await originChannel.send({ embeds: [rejectionNotifyEmbed] });
                        }
                    } catch (e) {
                        try { (await client.users.fetch(targetUserId)).send(`❌ Your submission for **${aircraftName}** was rejected: ${reason}`); } catch (e) {}
                    }
                }
                
                originalEmbed = null;
            }
        }

        if (!interaction.isChatInputCommand()) return;

        // --- HANDLER: MODERATION COMMANDS ---
        if (interaction.commandName.startsWith('mod_')) {
            // Permission Check specifically for the Admin Role ID for extra security
            const hasAdminRole = interaction.member.roles.cache.has(ADMIN_ROLE_ID);
            const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
            
            if (!hasAdminRole && !isAdmin) {
                return interaction.reply({ content: '❌ Access Denied: Missing Admin Privileges.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('user');
            const targetMember = targetUser ? await interaction.guild.members.fetch(targetUser.id).catch(() => null) : null;
            const reason = interaction.options.getString('reason') || 'No reason provided';

            try {
                if (interaction.commandName === 'mod_kick') {
                    if (!targetMember) return interaction.reply({ content: 'User not found in server.', ephemeral: true });
                    await targetMember.kick(reason);
                    await interaction.reply({ content: `✅ Kicked ${targetUser.tag}.`, ephemeral: true });
                    await logModAction('KICK', interaction.user, targetUser, reason);
                }

                if (interaction.commandName === 'mod_ban') {
                    await interaction.guild.members.ban(targetUser, { reason });
                    await interaction.reply({ content: `✅ Banned ${targetUser.tag}.`, ephemeral: true });
                    await logModAction('BAN', interaction.user, targetUser, reason);
                }

                if (interaction.commandName === 'mod_timeout') {
                    if (!targetMember) return interaction.reply({ content: 'User not found.', ephemeral: true });
                    const minutes = interaction.options.getInteger('duration');
                    await targetMember.timeout(minutes * 60 * 1000, reason);
                    await interaction.reply({ content: `✅ Timed out ${targetUser.tag} for ${minutes} minutes.`, ephemeral: true });
                    await logModAction('TIMEOUT', interaction.user, targetUser, reason, `Duration: ${minutes}m`);
                }

                if (interaction.commandName === 'mod_untimeout') {
                    if (!targetMember) return interaction.reply({ content: 'User not found.', ephemeral: true });
                    await targetMember.timeout(null, reason);
                    await interaction.reply({ content: `✅ Removed timeout for ${targetUser.tag}.`, ephemeral: true });
                    await logModAction('UNTIMEOUT', interaction.user, targetUser, reason);
                }

                if (interaction.commandName === 'mod_warn') {
                    // DM the user
                    let dmStatus = 'DM Sent';
                    try {
                        const warnEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Official Warning')
                            .setColor(0xFFD700)
                            .setDescription(`You have received a warning in **${interaction.guild.name}**.`)
                            .addFields({ name: 'Reason', value: reason })
                            .setFooter({ text: 'Please review our rules to avoid further action.' });
                        await targetUser.send({ embeds: [warnEmbed] });
                    } catch (e) { dmStatus = 'DM Failed (User has DMs off)'; }

                    await interaction.reply({ content: `✅ Warned ${targetUser.tag}. (${dmStatus})`, ephemeral: true });
                    await logModAction('WARN', interaction.user, targetUser, reason, `Status: ${dmStatus}`);
                }

                if (interaction.commandName === 'mod_purge') {
                    const amount = interaction.options.getInteger('amount');
                    const deleted = await interaction.channel.bulkDelete(amount, true);
                    await interaction.reply({ content: `✅ Deleted ${deleted.size} messages.`, ephemeral: true });
                    await logModAction('PURGE', interaction.user, interaction.channel, 'Bulk Delete', `Amount: ${deleted.size} messages`);
                }

                if (interaction.commandName === 'mod_lock') {
                    await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
                    await interaction.reply({ content: '🔒 Channel locked.', ephemeral: true });
                    await logModAction('LOCK', interaction.user, interaction.channel, 'Channel Lockdown');
                }

                if (interaction.commandName === 'mod_unlock') {
                    await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null });
                    await interaction.reply({ content: '🔓 Channel unlocked.', ephemeral: true });
                    await logModAction('UNLOCK', interaction.user, interaction.channel, 'Channel Unlock');
                }

                if (interaction.commandName === 'mod_say') {
                    const msg = interaction.options.getString('message');
                    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
                    await targetChannel.send(msg);
                    await interaction.reply({ content: '✅ Message sent.', ephemeral: true });
                    await logModAction('ANNOUNCE', interaction.user, targetChannel, 'Bot Announcement', `Content: ${msg}`);
                }

            } catch (error) {
                console.error('Mod Command Error:', error);
                await interaction.reply({ content: '❌ Failed to execute action. Check bot permissions.', ephemeral: true }).catch(() => {});
            }
            return;
        }
        
        // --- COMMAND: LIVE TRACKING (/track) ---
        if (interaction.commandName === 'track') {
            await interaction.deferReply();

            // 1. Configuration (Matched to flight.js)
            const query = interaction.options.getString('target').toUpperCase().trim();
            const LIVE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run'; 
            const targetServerName = 'Expert Server'; 

            try {
                // 2. Fetch Sessions
                const sessionsRes = await axios.get(`${LIVE_API_URL}/if-sessions`);
                if (!sessionsRes.data || !sessionsRes.data.sessions) {
                    throw new Error("Invalid response from Live API (Sessions)");
                }

                // 3. Smart Session Lookup (Logic ported from flight.js)
                // First try exact match, then fuzzy match (e.g. "Expert" in "Expert Server")
                let session = sessionsRes.data.sessions.find(s => s.name === targetServerName);
                if (!session) {
                    session = sessionsRes.data.sessions.find(s => s.name.includes(targetServerName.split(' ')[0]));
                }

                if (!session) {
                    return interaction.editReply(`❌ Could not locate **${targetServerName}**. The server might be offline.`);
                }

                // 4. Fetch Flights
                const flightsRes = await axios.get(`${LIVE_API_URL}/flights/${session.id}`);
                const flights = flightsRes.data.flights;

                if (!flights || !Array.isArray(flights)) {
                    return interaction.editReply("❌ Failed to retrieve flight data.");
                }

                // 5. Find Pilot (Username OR Callsign)
                const match = flights.find(f => 
                    (f.username && f.username.toUpperCase().includes(query)) || 
                    (f.callsign && f.callsign.toUpperCase().includes(query))
                );

                if (!match) {
                    return interaction.editReply(`❌ No pilot found matching "**${query}**" on ${session.name}.`);
                }

                // 6. Calculate Flight Phase (Ported from flight.js getLiteFlightPhase)
                const calculatePhase = (pos) => {
                    const vs = pos.vs_fpm || 0;
                    const alt = pos.alt_ft || 0;
                    const gs = pos.gs_kt || 0;
                    
                    if (alt < 1000 && gs < 40 && Math.abs(vs) < 150) return 'On Ground 🛑';
                    if (vs > 350) return 'Climbing ↗️';
                    if (vs < -500) return 'Descending ↘️';
                    if (alt > 18000 && Math.abs(vs) < 500) return 'Cruising ✈️';
                    return 'Enroute ➡️';
                };

                const phase = calculatePhase(match.position);

                // 7. Build Embed
                const trackEmbed = new EmbedBuilder()
                    .setTitle(`📡 Live Flight: ${match.callsign || 'No Callsign'}`)
                    .setColor(0x00FF99)
                    .setThumbnail(`${LIVE_API_URL}/images/radar_icon.png`) // Optional icon
                    .addFields(
                        { name: '👤 Pilot', value: match.username || 'Unknown', inline: true },
                        { name: '✈️ Aircraft', value: match.aircraft?.aircraftName || 'Unknown', inline: true },
                        { name: '🎨 Livery', value: match.aircraft?.liveryName || 'Unknown', inline: true },
                        
                        // Use != null checks to fix the "0 altitude" bug
                        { name: '📍 Altitude', value: match.position.alt_ft != null ? `${Math.round(match.position.alt_ft).toLocaleString()} ft` : 'N/A', inline: true },
                        { name: '🚀 Ground Speed', value: match.position.gs_kt != null ? `${Math.round(match.position.gs_kt)} kts` : 'N/A', inline: true },
                        { name: '↕️ Vertical Speed', value: match.position.vs_fpm != null ? `${Math.round(match.position.vs_fpm)} fpm` : 'N/A', inline: true },
                        
                        { name: '🧭 Heading', value: match.position.heading_deg != null ? `${Math.round(match.position.heading_deg)}°` : 'N/A', inline: true },
                        { name: '🆔 Virtual Org', value: match.virtualOrganization || 'None', inline: true },
                        { name: '📊 Status', value: phase, inline: true }
                    )
                    .setTimestamp(match.position.lastReportMs ? new Date(match.position.lastReportMs) : new Date())
                    .setFooter({ text: `Server: ${session.name} • ${match.pilotState === 0 ? 'Active' : 'Paused/Away'}` });

                if (match.flightId) {
                    trackEmbed.addFields({ name: '🌍 Live Map', value: `[View on Inflight.info](https://inflight.info/flight/${match.flightId})` });
                }

                await interaction.editReply({ embeds: [trackEmbed] });

            } catch (error) {
                console.error("Track Command Error:", error.message);
                await interaction.editReply(`❌ **Connection Failed:** Could not connect to backend.\nEnsure \`${LIVE_API_URL}\` is reachable.`);
            }
        }

        // --- COMMAND: PERSONAL HANGAR (/hangar) ---
        if (interaction.commandName === 'hangar') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            await interaction.deferReply();

            try {
                // 1. Perform MongoDB Aggregation
                // This calculates stats directly in the database for speed
                const stats = await CommunityAircraftModel.aggregate([
                    { 
                        $match: { 
                            $or: [
                                { contributorId: targetUser.id },
                                { contributorName: targetUser.username } 
                            ]
                        } 
                    },
                    {
                        $group: {
                            _id: null,
                            totalUploads: { $sum: 1 },
                            // Collect unique values to count diversity
                            uniqueTypes: { $addToSet: "$aircraftType" },
                            uniqueLiveries: { $addToSet: "$liveryName" },
                            // Push all types to an array to calculate the "favorite" later
                            allTypes: { $push: "$aircraftType" }
                        }
                    }
                ]);

                if (!stats || stats.length === 0) {
                    return interaction.editReply(`📂 **${targetUser.username}** has an empty hangar. No photos submitted yet!`);
                }

                const data = stats[0];

                // 2. Calculate "Favorite Aircraft" (Mode of aircraft types)
                const typeCounts = {};
                let favoriteAircraft = "None";
                let maxCount = 0;

                data.allTypes.forEach(t => {
                    typeCounts[t] = (typeCounts[t] || 0) + 1;
                    if (typeCounts[t] > maxCount) {
                        maxCount = typeCounts[t];
                        favoriteAircraft = t;
                    }
                });

                // 3. Fetch the MOST RECENT upload for the embed image
                const latestUpload = await CommunityAircraftModel.findOne({ 
                    $or: [{ contributorId: targetUser.id }, { contributorName: targetUser.username }] 
                }).sort({ uploadedAt: -1 });

                // 4. Determine Rank based on upload count
                let rank = 'Spotter';
                if (data.totalUploads >= 10) rank = 'Bronze Spotter 🥉';
                if (data.totalUploads >= 25) rank = 'Silver Spotter 🥈';
                if (data.totalUploads >= 50) rank = 'Gold Spotter 🥇';
                if (data.totalUploads >= 100) rank = 'Diamond Spotter 💎';

                // 5. Build Hangar Embed
                const hangarEmbed = new EmbedBuilder()
                    .setTitle(`✈️ ${targetUser.username}'s Hangar`)
                    .setColor(0xFFD700) // Gold
                    .setThumbnail(targetUser.displayAvatarURL())
                    .setDescription(`**Rank:** ${rank}`)
                    .addFields(
                        { name: '📸 Total Photos', value: `${data.totalUploads}`, inline: true },
                        { name: '🛩️ Unique Types', value: `${data.uniqueTypes.length}`, inline: true },
                        { name: '🎨 Unique Liveries', value: `${data.uniqueLiveries.length}`, inline: true },
                        { name: '❤️ Favorite Aircraft', value: `**${favoriteAircraft}** (${maxCount} spots)`, inline: false }
                    )
                    .setFooter({ text: `Hangar ID: ${targetUser.id}` });

                // If they have a latest upload, set it as the big image
                if (latestUpload) {
                    hangarEmbed.setImage(latestUpload.imageUrl);
                    hangarEmbed.setFooter({ text: `Latest Catch: ${latestUpload.tailNumber} (${latestUpload.aircraftType})` });
                }

                await interaction.editReply({ embeds: [hangarEmbed] });

            } catch (error) {
                console.error("Hangar Command Error:", error);
                await interaction.editReply("❌ An error occurred while fetching hangar statistics.");
            }
        }
        
        // --- NEW COMMAND: SETUP TICKETS ---
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
                const guildMembers = await interaction.guild.members.fetch();
                
                const legacyRecords = await CommunityAircraftModel.find({
                    $or: [{ contributorId: { $exists: false } }, { contributorId: null }]
                });

                if (legacyRecords.length === 0) {
                    return interaction.editReply("✅ Database is fully linked! No legacy records found.");
                }

                const uniqueNames = [...new Set(legacyRecords.map(r => r.contributorName))];
                
                let linkedCount = 0;
                let failedCount = 0;
                let log = [];

                for (const name of uniqueNames) {
                    const match = guildMembers.find(m => 
                        m.user.username.toLowerCase() === name.toLowerCase() ||
                        m.displayName.toLowerCase() === name.toLowerCase()
                    );

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
    });

    if (process.env.DISCORD_BOT_TOKEN) {
        client.login(process.env.DISCORD_BOT_TOKEN);
    } else {
        console.log('⚠️ DISCORD_BOT_TOKEN missing.');
    }
};

module.exports = { startDiscordBot };
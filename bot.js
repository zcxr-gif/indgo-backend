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
    ComponentType,
    ChannelType,
    Options // Import Options for cache control
} = require('discord.js');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
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
// MEMORY FIX: limit concurrency to prevent CPU/RAM saturation during bursts
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
    const cleanType = aircraftType.toLowerCase().trim();
    const cleanLivery = liveryName.toLowerCase().trim();

    const match = aircraftRegistry.find(entry => {
        const jsonLivery = entry.livery.toLowerCase();
        const liveryMatch = jsonLivery === cleanLivery || jsonLivery.includes(cleanLivery) || cleanLivery.includes(jsonLivery);
        if (!liveryMatch) return false;
        const jsonModel = entry.model.toLowerCase();
        const typeMatch = cleanType.includes(jsonModel);
        return typeMatch;
    });

    return match ? match.registration : null;
};

const normalizeData = async (rawType, rawLivery) => {
    let finalType = rawType.trim();
    let finalLivery = rawLivery.trim();
    let aircraftId = null;

    let matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase() === finalType.toLowerCase());
    
    if (!matchedAircraft) {
        matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase().includes(finalType.toLowerCase()));
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
        if (matchedLivery) {
            finalLivery = matchedLivery; 
        }
    }

    return { type: finalType, livery: finalLivery };
};

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region) => {

    // --- MEMORY FIX: CONFIGURE SWEEPERS ---
    // This tells Discord.js to aggressively delete old messages/users from RAM
    const client = new Client({ 
        makeCache: Options.cacheEverything({
            MessageManager: 50, // Only keep 50 messages per channel
            UserManager: 100,   // Only keep 100 users in cache
            GuildMemberManager: 100,
            ThreadManager: 10,
        }),
        sweepers: {
            messages: {
                interval: 300, // Every 5 minutes
                lifetime: 900, // Remove messages older than 15 minutes
            },
            users: {
                interval: 3600, // Every hour
                filter: () => user => user.id !== client.user.id, // Remove everyone but the bot itself
            },
        },
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers, 
            GatewayIntentBits.MessageContent 
        ] 
    });

    /**
     * MEMORY OPTIMIZED UPLOAD FUNCTION (STREAM VERSION)
     * Replaces .toBuffer() with streams to prevent RAM spikes
     */
    const uploadImageToS3 = async (url, tailNumber) => {
        let tempFilePath = null;
        try {
            const tempFileName = `upload_${Date.now()}_${Math.random().toString(36).substring(7)}.dat`;
            tempFilePath = path.join(os.tmpdir(), tempFileName);

            // 1. Download stream to disk
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream'
            });

            await pipeline(response.data, fs.createWriteStream(tempFilePath));

            // 2. Prepare Stream Upload
            const cleanTail = (tailNumber || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
            const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`; 

            // Create a readable stream from the file on disk
            const fileReadStream = fs.createReadStream(tempFilePath);

            // Pipe it through Sharp (Transformer)
            // We do NOT use .toBuffer(). We let the data flow.
            const transformStream = fileReadStream.pipe(
                sharp()
                .resize({ width: 1920, withoutEnlargement: true })
                .webp({ quality: 80 })
            );

            // 3. Upload Stream directly
            // The PutObjectCommand Body accepts a stream.
            const uploadCommand = new PutObjectCommand({
                Bucket: bucketName,
                Key: fileName,
                Body: transformStream,
                ContentType: 'image/webp',
            });

            await s3Client.send(uploadCommand);

            return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;

        } catch (error) {
            console.error('S3 Upload Error:', error);
            throw new Error('Failed to upload image to storage.');
        } finally {
            // 4. Cleanup
            if (tempFilePath) {
                fs.unlink(tempFilePath, (err) => {});
            }
        }
    };

    const startSubmissionFlow = async (source, rawType, rawLivery, ignoredTail, photoUrl, user, originChannelId) => {
        
        let currentType = rawType;
        let currentLivery = rawLivery;
        let currentTail = 'UNKNOWN'; 

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
                setTimeout(() => reply.delete().catch(() => {}), 5000);
                collector.stop();
                return;
            }

            if (i.customId === 'edit_details') {
                const modal = new ModalBuilder().setCustomId('editModal').setTitle('Edit Aircraft Details');
                
                const typeInput = new TextInputBuilder().setCustomId('m_type').setLabel("Aircraft Type").setValue(currentType).setStyle(TextInputStyle.Short);
                const liveryInput = new TextInputBuilder().setCustomId('m_livery').setLabel("Livery Name").setValue(currentLivery).setStyle(TextInputStyle.Short);

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

                const finalEmbed = new EmbedBuilder()
                    .addFields(
                        { name: 'Contributor', value: `<@${user.id}>`, inline: true },
                        { name: 'Tail Number', value: currentTail.toUpperCase(), inline: true },
                        { name: 'Aircraft Type', value: currentType, inline: true },
                        { name: 'Livery', value: currentLivery, inline: true },
                    )
                    .setTimestamp();

                if (isDuplicate) {
                    finalEmbed.setTitle('⚠️ REPLACEMENT REQUEST');
                    finalEmbed.setColor(0xFFA500);
                    finalEmbed.setDescription(`**Admin Notice:** Matches existing **${currentType} / ${currentLivery}**.\nApproving this will **REPLACE** the old image.`);
                } else {
                    finalEmbed.setTitle('📋 New Submission Request');
                    finalEmbed.setColor(0x00FF00);
                }
                
                finalEmbed.setFooter({ text: `Pending | User: ${user.id} | Msg: ${publicMsg.id} | Ch: ${originChannelId}` });

                const adminRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId(`approve_${user.id}`).setLabel('Approve & Verify').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`reject_${user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
                    );

                await adminChannel.send({ embeds: [finalEmbed], components: [adminRow], files: [attachmentData] });
                
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

                setTimeout(() => reply.delete().catch(() => {}), 15000);
                collector.stop();
            }
        });
        
        // Ensure cleanup of closure variables
        collector.on('end', () => {
             // Explicitly release references
             reply = null;
             // Other variables in scope will be GC'd when this scope dies, provided collector is dead
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

            // Fetch less messages to save RAM
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

            // --- EXPLICIT GARBAGE COLLECTION HINT ---
            if (global.gc) {
                global.gc();
            }

            if (cleanedLiveries > 0 || cleanedSessions > 0) {
                console.log(`🧹 Memory Cleaned: Pruned ${cleanedLiveries} livery caches and ${cleanedSessions} stale sessions.`);
            }
        }, 600000);

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        const commands = [
            new SlashCommandBuilder().setName('lookup').setDescription('Find an aircraft').addStringOption(o => o.setName('query').setDescription('Tail/Livery/Type').setAutocomplete(true).setRequired(true)),
            new SlashCommandBuilder().setName('stats').setDescription('View stats'),
            new SlashCommandBuilder().setName('profile').setDescription('Check contribution stats').addUserOption(o => o.setName('user').setDescription('User to check')),
            new SlashCommandBuilder().setName('submit').setDescription('Submit a new aircraft photo')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true))
                .addAttachmentOption(o => o.setName('photo').setDescription('Upload photo').setRequired(true)),
            new SlashCommandBuilder().setName('migrate_legacy').setDescription('[ADMIN] Auto-match legacy DB names to current Discord Users'),
            new SlashCommandBuilder().setName('links').setDescription('Get helpful resource links (Tracker, Forum, Liveries)'),
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
        
        if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);
            
            if (focused.name === 'aircraft_type' || focused.name === 'query') {
                const list = await fetchAircraftMetadata();
                const filtered = list.filter(a => a.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
                await interaction.respond(filtered.map(a => ({ name: a.name, value: a.name })));
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
            
            if (interaction.customId.startsWith('start_ident_')) {
                const originalUserId = interaction.customId.split('_')[2];
                if (interaction.user.id !== originalUserId) {
                    return interaction.reply({ content: "This is not your photo.", ephemeral: true });
                }

                const modal = new ModalBuilder().setCustomId('identify_modal').setTitle('Aircraft Details');
                const typeInput = new TextInputBuilder().setCustomId('i_type').setLabel("What aircraft is this?").setStyle(TextInputStyle.Short).setRequired(true);
                const liveryInput = new TextInputBuilder().setCustomId('i_livery').setLabel("What livery is this?").setStyle(TextInputStyle.Short).setRequired(true);
                
                modal.addComponents(new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput));
                await interaction.showModal(modal);
                return;
            }

            if (interaction.customId.startsWith('approve_')) {
                // Defer first to prevent timeout during S3 upload
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
                    
                    // Heavy operation - now streams instead of buffers
                    const permanentUrl = await uploadImageToS3(imageUrl, tailField);
                    
                    let contributorName = "Unknown";
                    try { 
                        const cUser = await client.users.fetch(targetUserId); 
                        contributorName = cUser.username;
                    } catch (e) {}

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

                    // MEMORY CLEANUP
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
                
                // cleanup
                originalEmbed = null;
            }
        }

        if (!interaction.isChatInputCommand()) return;

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
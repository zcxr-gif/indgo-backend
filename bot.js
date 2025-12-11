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
    ChannelType
} = require('discord.js');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const sharp = require('sharp'); 

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

/**
 * Helper to escape regex characters to prevent crashes
 */
const escapeRegex = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Fetches and caches the list of all aircraft types + IDs
 */
const fetchAircraftMetadata = async () => {
    if (Date.now() - lastAircraftCacheUpdate < 3600000 && cachedAircraftData.length > 0) {
        return cachedAircraftData;
    }
    try {
        const response = await axios.get(METADATA_API_URL);
        if (response.data && response.data.aircraft) {
            // Sort by length DESC so "737-800" is matched before "737" to avoid partial match errors
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

/**
 * Fetches liveries for a specific aircraft ID (with 5-minute caching)
 */
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

/**
 * --- NEW: DATA NORMALIZATION HELPER ---
 * Tries to find the "Official" backend name based on sloppy user input.
 */
const normalizeData = async (rawType, rawLivery) => {
    let finalType = rawType.trim();
    let finalLivery = rawLivery.trim();
    let aircraftId = null;

    // 1. Normalize Aircraft Type
    // Try exact match first (case-insensitive)
    let matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase() === finalType.toLowerCase());
    
    // If no exact match, try fuzzy (does official name CONTAIN user input?)
    // e.g. User: "737" -> Matches: "Boeing 737-800"
    if (!matchedAircraft) {
        matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase().includes(finalType.toLowerCase()));
    }

    if (matchedAircraft) {
        finalType = matchedAircraft.name; // Swap to official name
        aircraftId = matchedAircraft.id;  // Save ID for livery lookup
    }

    // 2. Normalize Livery (Only if we found a valid aircraft)
    if (aircraftId) {
        const validLiveries = await fetchLiveriesForAircraft(aircraftId);
        
        // Try exact match
        let matchedLivery = validLiveries.find(l => l.toLowerCase() === finalLivery.toLowerCase());
        
        // Try fuzzy match
        if (!matchedLivery) {
            matchedLivery = validLiveries.find(l => l.toLowerCase().includes(finalLivery.toLowerCase()));
        }

        if (matchedLivery) {
            finalLivery = matchedLivery; // Swap to official name
        }
    }

    return { type: finalType, livery: finalLivery };
};

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region) => {

    const client = new Client({ 
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers, 
            GatewayIntentBits.MessageContent 
        ] 
    });

    const uploadImageToS3 = async (url, tailNumber) => {
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const optimizedBuffer = await sharp(response.data)
                .resize({ width: 1920, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();

            const cleanTail = (tailNumber || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
            const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`; 

            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: fileName,
                Body: optimizedBuffer,
                ContentType: 'image/webp',
            }));

            return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;
        } catch (error) {
            console.error('S3 Upload Error:', error);
            throw new Error('Failed to upload image to storage.');
        }
    };

    /**
     * CORE SUBMISSION LOGIC
     */
    const startSubmissionFlow = async (source, rawType, rawLivery, tail, photoUrl, user, originChannelId) => {
        
        // --- STEP 1: NORMALIZE INPUTS ---
        // This fixes "a320" -> "Airbus A320" automatically
        const { type, livery } = await normalizeData(rawType, rawLivery);

        let isDuplicate = false;
        try {
            const existing = await CommunityAircraftModel.findOne({ 
                aircraftType: { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") },
                liveryName: { $regex: new RegExp(`^${escapeRegex(livery)}$`, "i") }
            });
            if (existing) isDuplicate = true;
        } catch (err) { console.error("DB Check failed", err); }

        // Preview Embed
        const createPreviewEmbed = (t, tp, l, imgUrl, isDup) => {
            const embed = new EmbedBuilder()
                .addFields(
                    { name: 'Aircraft Type', value: tp, inline: true },
                    { name: 'Livery', value: l, inline: true },
                    { name: 'Tail Number', value: t.toUpperCase(), inline: true },
                );
                // REMOVED .setImage() so the image floats OUTSIDE the card (above it)

            if (isDup) {
                embed.setTitle('⚠️ Existing Entry Detected');
                embed.setColor(0xFFA500); 
                embed.setDescription(`**Note:** We already have a photo for **${tp}** in **${l}** livery.\nThis will generally be treated as a **replacement**.`);
            } else {
                embed.setTitle('📝 Review Your Submission');
                embed.setColor(0x0099FF);
                embed.setDescription('I have auto-corrected the names to match our database.\nPlease confirm the details below.');
                embed.setFooter({ text: 'Click Confirm to submit.' });
            }
            return embed;
        };

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('confirm_submission').setLabel('Confirm & Submit').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('edit_details').setLabel('Edit Details').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('discard_submission').setLabel('Discard').setStyle(ButtonStyle.Danger),
            );

        const payload = { 
            embeds: [createPreviewEmbed(tail, type, livery, photoUrl, isDuplicate)], 
            components: [row],
            files: [{ attachment: photoUrl, name: 'preview.webp' }] 
        };

        let reply;
        if (source.commandName || source.customId === 'identify_modal') {
            payload.fetchReply = true;
            if (source.deferred || source.replied) reply = await source.editReply(payload);
            else reply = await source.reply(payload);
        } else {
            reply = await source.reply(payload);
        }

        const finalPhotoUrl = reply.attachments.first() ? reply.attachments.first().url : photoUrl;

        const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collector.on('collect', async i => {
            if (i.user.id !== user.id) {
                return i.reply({ content: "This is not your submission.", ephemeral: true });
            }

            if (i.customId === 'discard_submission') {
                await i.update({ content: '🗑️ Submission discarded.', embeds: [], components: [], files: [] }); 
                userSessions.delete(user.id); 
                setTimeout(() => reply.delete().catch(() => {}), 5000);
                collector.stop();
                return;
            }

            if (i.customId === 'edit_details') {
                const modal = new ModalBuilder().setCustomId('editModal').setTitle('Edit Aircraft Details');
                const tailInput = new TextInputBuilder().setCustomId('m_tail').setLabel("Tail Number").setValue(tail === 'UNKNOWN' ? '' : tail).setRequired(false).setStyle(TextInputStyle.Short);
                const typeInput = new TextInputBuilder().setCustomId('m_type').setLabel("Aircraft Type").setValue(type).setStyle(TextInputStyle.Short);
                const liveryInput = new TextInputBuilder().setCustomId('m_livery').setLabel("Livery Name").setValue(livery).setStyle(TextInputStyle.Short);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(tailInput),
                    new ActionRowBuilder().addComponents(typeInput),
                    new ActionRowBuilder().addComponents(liveryInput)
                );

                await i.showModal(modal);

                const modalFilter = (submission) => submission.customId === 'editModal' && submission.user.id === user.id;
                try {
                    const submission = await i.awaitModalSubmit({ filter: modalFilter, time: 60000 });
                    const newTail = submission.fields.getTextInputValue('m_tail');
                    tail = newTail.trim() === '' ? 'UNKNOWN' : newTail;
                    
                    // Note: We re-normalize even on edits to keep data clean!
                    const editedType = submission.fields.getTextInputValue('m_type');
                    const editedLivery = submission.fields.getTextInputValue('m_livery');
                    const normalized = await normalizeData(editedType, editedLivery);
                    
                    type = normalized.type;
                    livery = normalized.livery;

                    isDuplicate = false;
                    const reCheck = await CommunityAircraftModel.findOne({ 
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(livery)}$`, "i") }
                    });
                    if (reCheck) isDuplicate = true;

                    await submission.update({ 
                        embeds: [createPreviewEmbed(tail, type, livery, finalPhotoUrl, isDuplicate)],
                        components: [row] 
                    });
                } catch (e) { }
            }

            if (i.customId === 'confirm_submission') {
                const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
                const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);

                if (!adminChannel || !feedChannel) return i.update({ content: '❌ Channel configuration error.', components: [] });

                const attachmentData = { attachment: finalPhotoUrl, name: 'aircraft.webp' };

                // 1. Post to PUBLIC FEED
                const publicEmbed = new EmbedBuilder()
                    .setTitle('📸 New Aircraft Spotted! (Pending Review)')
                    .setColor(0xFFFF00) 
                    .setDescription(`A user has submitted a new photo! Status: **Under Review**`)
                    .addFields(
                        { name: 'Aircraft', value: type, inline: true },
                        { name: 'Livery', value: livery, inline: true },
                        { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                        { name: 'Spotted By', value: `<@${user.id}>`, inline: false }
                    )
                    // REMOVED .setImage() so image stays OUTSIDE
                    .setFooter({ text: 'Submissions are reviewed by admins before database entry.' })
                    .setTimestamp();

                const publicMsg = await feedChannel.send({ embeds: [publicEmbed], files: [attachmentData] });

                // 2. Post to ADMIN CHANNEL
                const finalEmbed = new EmbedBuilder()
                    .addFields(
                        { name: 'Contributor', value: `<@${user.id}>`, inline: true },
                        { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                        { name: 'Aircraft Type', value: type, inline: true },
                        { name: 'Livery', value: livery, inline: true },
                    )
                    // REMOVED .setImage() so image stays OUTSIDE
                    .setTimestamp();

                if (isDuplicate) {
                    finalEmbed.setTitle('⚠️ REPLACEMENT REQUEST');
                    finalEmbed.setColor(0xFFA500);
                    finalEmbed.setDescription(`**Admin Notice:** Matches existing **${type} / ${livery}**.\nApproving this will **REPLACE** the old image.`);
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
                
                // 3. SET SESSION AND PROMPT FOR MORE
                userSessions.set(user.id, {
                    type: type, // Stores the NORMALIZED type
                    livery: livery, // Stores the NORMALIZED livery
                    tail: tail,
                    expiresAt: Date.now() + 300000 
                });

                await i.update({ 
                    content: `✅ Submission sent for review!\n\n**Have another photo of this same aircraft?**\nUpload it now and I'll automatically apply the corrected details (${type}, ${tail}).`, 
                    embeds: [], 
                    components: [], 
                    files: [] 
                });

                setTimeout(() => reply.delete().catch(() => {}), 15000);
                collector.stop();
            }
        });
    };

    // --- LEADERBOARD LOGIC ---
    const updateLeaderboard = async () => {
        if (!LEADERBOARD_CHANNEL_ID) return;
        try {
            const leaderboard = await CommunityAircraftModel.aggregate([
                { $group: { _id: "$contributorName", count: { $sum: 1 }, lastId: { $first: "$contributorId" } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            if (leaderboard.length === 0) return;

            const topUserEntry = leaderboard[0];
            const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
            if (!channel) return;

            const description = leaderboard.map((entry, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
                return `${medal} **${entry._id}** — ${entry.count} contributions`;
            }).join('\n');

            const leaderboardEmbed = new EmbedBuilder()
                .setTitle('🏆 Top Contributors Leaderboard')
                .setDescription(`Here are the top pilots helping build our database!\n\n${description}`)
                .setColor(0xFFD700)
                .setFooter({ text: 'Updated Daily • Submit photos to climb the ranks!' })
                .setTimestamp();

            let lastMessage = (await channel.messages.fetch({ limit: 10 })).find(m => m.author.id === client.user.id);
            if (lastMessage) await lastMessage.edit({ embeds: [leaderboardEmbed] });
            else await channel.send({ embeds: [leaderboardEmbed] });

            if (topUserEntry && TOP_CONTRIBUTOR_ROLE_ID) {
                const guild = channel.guild;
                const role = await guild.roles.fetch(TOP_CONTRIBUTOR_ROLE_ID);
                if (role) {
                    const currentHolders = role.members;
                    for (const [memberId, member] of currentHolders) {
                        const isTopUser = (topUserEntry.lastId && memberId === topUserEntry.lastId) || (member.user.username === topUserEntry._id);
                        if (!isTopUser) await member.roles.remove(role);
                    }
                    let topMember;
                    if (topUserEntry.lastId) {
                        try { topMember = await guild.members.fetch(topUserEntry.lastId); } catch (e) {}
                    }
                    if (!topMember) {
                        const members = await guild.members.fetch();
                        topMember = members.find(m => m.user.username === topUserEntry._id);
                    }
                    if (topMember && !topMember.roles.cache.has(TOP_CONTRIBUTOR_ROLE_ID)) {
                        await topMember.roles.add(role);
                        await channel.send(`🎉 Congratulations to ${topMember} for becoming the new **#1 Top Contributor**!`);
                    }
                }
            }
        } catch (error) { console.error('❌ Error updating leaderboard:', error); }
    };

    // 2. Initialize Bot
    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);
        await fetchAircraftMetadata();
        
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        const commands = [
            new SlashCommandBuilder().setName('lookup').setDescription('Find an aircraft').addStringOption(o => o.setName('query').setDescription('Tail/Livery/Type').setAutocomplete(true).setRequired(true)),
            new SlashCommandBuilder().setName('stats').setDescription('View stats'),
            new SlashCommandBuilder().setName('profile').setDescription('Check contribution stats').addUserOption(o => o.setName('user').setDescription('User to check')),
            new SlashCommandBuilder().setName('submit').setDescription('Submit a new aircraft photo')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true))
                .addAttachmentOption(o => o.setName('photo').setDescription('Upload photo').setRequired(true))
                .addStringOption(o => o.setName('tail_number').setDescription('Registration').setRequired(false)) 
        ].map(c => c.toJSON());

        try {
            await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
            console.log('✅ Commands registered.');
        } catch (e) { console.error('❌ Error registering commands:', e); }

        updateLeaderboard();
        setInterval(updateLeaderboard, 86400000);
    });

    // --- WELCOME ---
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

    // --- HANDLE MESSAGE SUBMISSIONS (POSTING IN CHANNEL) ---
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

                    // Note: We used to rely on session.type. Since we now normalize BEFORE saving to session,
                    // session.type should already be the "Official" name.
                    await startSubmissionFlow(
                        message, 
                        session.type, 
                        session.livery, 
                        session.tail, 
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
                    .setDescription(`**Thanks for the photo!**\nPlease click the button below to enter the **Aircraft**, **Livery**, and **Registration** details.`);

                await message.reply({ 
                    embeds: [promptEmbed], 
                    components: [row] 
                });
            }
        }
    });

    // 3. Handle Interactions
    client.on('interactionCreate', async interaction => {
        
        // --- AUTOCOMPLETE ---
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

        // --- BUTTON HANDLING ---
        if (interaction.isButton()) {
            
            if (interaction.customId.startsWith('start_ident_')) {
                const originalUserId = interaction.customId.split('_')[2];
                if (interaction.user.id !== originalUserId) {
                    return interaction.reply({ content: "This is not your photo.", ephemeral: true });
                }

                const modal = new ModalBuilder().setCustomId('identify_modal').setTitle('Aircraft Details');
                const typeInput = new TextInputBuilder().setCustomId('i_type').setLabel("What aircraft is this?").setStyle(TextInputStyle.Short).setRequired(true);
                const liveryInput = new TextInputBuilder().setCustomId('i_livery').setLabel("What livery is this?").setStyle(TextInputStyle.Short).setRequired(true);
                const tailInput = new TextInputBuilder().setCustomId('i_tail').setLabel("Registration (Optional)").setStyle(TextInputStyle.Short).setRequired(false);

                modal.addComponents(new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput), new ActionRowBuilder().addComponents(tailInput));
                await interaction.showModal(modal);
                return;
            }

            if (interaction.customId.startsWith('approve_')) {
                await interaction.deferUpdate();
                const [_, targetUserId] = interaction.customId.split('_');
                const receivedEmbed = interaction.message.embeds[0];
                
                const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number').value;
                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                
                let imageUrl = receivedEmbed.image?.url;
                // If image was "outside" the embed (attachment), we need to grab it from message attachments
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
                    try { contributorName = (await client.users.fetch(targetUserId)).username; } catch (e) {}

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
                        .setImage(null) // Ensure admin image stays outside
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
                                .setImage(null) // Remove internal image
                                .setFooter({ text: 'Verified by Staff' });
                            
                            // Send URL as content so it renders above the embed
                            await publicMsg.edit({ content: permanentUrl, embeds: [publicEmbed], files: [] });
                        } catch (e) {}
                    }
                    
                    try { 
                        const user = await client.users.fetch(targetUserId);
                        const userNotifyEmbed = new EmbedBuilder()
                            .setTitle('✅ Submission Approved')
                            .setColor(0x00FF00)
                            .setDescription(`Your photo of **${typeField}** has been approved!`)
                            .setImage(permanentUrl); // For DM, we can keep it inside or out, inside is cleaner for DMs
                        
                        await user.send({ embeds: [userNotifyEmbed] }); 
                    } catch (e) { }

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
                let tail = interaction.fields.getTextInputValue('i_tail');
                if (!tail || tail.trim() === '') tail = 'UNKNOWN';

                let photoUrl = null;
                try {
                    if (interaction.message.reference && interaction.message.reference.messageId) {
                        const originalMsg = await interaction.channel.messages.fetch(interaction.message.reference.messageId);
                        if (originalMsg && originalMsg.attachments.size > 0) {
                            photoUrl = originalMsg.attachments.first().url;
                        }
                    }
                } catch (err) { console.error("Could not fetch original image:", err); }

                if (!photoUrl) return interaction.editReply("❌ Could not find the original image. Did you delete it?");

                await startSubmissionFlow(interaction, type, livery, tail, photoUrl, interaction.user, interaction.channelId);
                try { await interaction.message.delete(); } catch(e) {}
                return;
            }

            if (interaction.customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate(); 
                const targetUserId = interaction.customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                
                const originalEmbed = interaction.message.embeds[0];
                const aircraftName = originalEmbed.fields.find(f => f.name === 'Aircraft Type')?.value || 'Unknown Aircraft';
                
                // Check if image is inside (old style) or attached (new style)
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
                    .setImage(null) // Force image OUTSIDE
                    .setFooter({ text: `Rejected by ${interaction.user.tag}` });
                
                await interaction.editReply({ embeds: [rejectedEmbed], components: [] }); // Files persist automatically

                if (publicMsgId) {
                    try {
                        const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                        if (publicMsg) {
                            const publicRejectedEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                                .setTitle('❌ Submission Rejected')
                                .setColor(0xFF0000) 
                                .setDescription(`This submission was not accepted by the moderators.`)
                                .setImage(null) // Force image OUTSIDE
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
                        console.error('Could not send rejection to origin channel:', e);
                        try { (await client.users.fetch(targetUserId)).send(`❌ Your submission for **${aircraftName}** was rejected: ${reason}`); } catch (e) {}
                    }
                }
            }
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'submit') {
            const type = interaction.options.getString('aircraft_type');
            const livery = interaction.options.getString('livery');
            const tail = interaction.options.getString('tail_number') || 'UNKNOWN';
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
                const count = await CommunityAircraftModel.countDocuments({ contributorName: targetUser.username });
                const recent = await CommunityAircraftModel.findOne({ contributorName: targetUser.username }).sort({ uploadedAt: -1 });
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
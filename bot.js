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
    ComponentType
} = require('discord.js');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const sharp = require('sharp'); 

// CONFIGURATION - REPLACE THESE WITH YOUR REAL CHANNEL IDS
const ADMIN_CHANNEL_ID = '1448137363795742942'; 
const PUBLIC_FEED_CHANNEL_ID = '1448138153335586988'; 
const WELCOME_CHANNEL_ID = '1442462899451858975'; 
const SUBMISSION_CHANNEL_ID = '1448188638251978873'; // New Submission Channel

// --- NEW CONFIGURATION ---
const MEMBER_ROLE_ID = '1442472513849397248';          // Role given on join
const CONTRIBUTOR_ROLE_ID = '1442534816863223888';     // Role given on 1st accepted photo
const LEADERBOARD_CHANNEL_ID = '1448178846875521064';  // Channel for daily stats
const TOP_CONTRIBUTOR_ROLE_ID = '1448179466722611291'; // Role for the #1 contributor

const METADATA_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api/metadata';
const BASE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api';

// --- CACHE SYSTEMS ---
let cachedAircraftData = []; 
let lastAircraftCacheUpdate = 0;
let cachedLiveries = {}; 

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
            cachedAircraftData = response.data.aircraft.map(a => ({
                name: a.name,
                id: a.id
            })).sort((a, b) => a.name.localeCompare(b.name));
            
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

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region) => {

    const client = new Client({ 
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers, 
            GatewayIntentBits.MessageContent 
        ] 
    });

    // --- S3 UPLOAD HELPER ---
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
     * CORE SUBMISSION LOGIC (Reusable for Slash Command & Modal)
     * interaction: The interaction to update/reply to
     * messageToDelete: (Optional) The user's message object to delete after we secure the image
     */
    const startSubmissionFlow = async (interaction, type, livery, tail, photoUrl, user, messageToDelete = null) => {
        let isDuplicate = false;
        try {
            const existing = await CommunityAircraftModel.findOne({ 
                aircraftType: { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") },
                liveryName: { $regex: new RegExp(`^${escapeRegex(livery)}$`, "i") }
            });
            if (existing) isDuplicate = true;
        } catch (err) { console.error("DB Check failed", err); }

        // Helper to generate the embed
        // We use attachment://preview.webp if we are proxying, otherwise the direct URL
        const createPreviewEmbed = (t, tp, l, imgUrl, isDup, isProxying) => {
            const embed = new EmbedBuilder()
                .addFields(
                    { name: 'Aircraft Type', value: tp, inline: true },
                    { name: 'Livery', value: l, inline: true },
                    { name: 'Tail Number', value: t.toUpperCase(), inline: true },
                );

            if (isProxying) {
                embed.setImage('attachment://preview.webp');
            } else {
                embed.setImage(imgUrl);
            }

            if (isDup) {
                embed.setTitle('⚠️ Existing Entry Detected');
                embed.setColor(0xFFA500); 
                embed.setDescription(`**Note:** We already have a photo for **${tp}** in **${l}** livery.\n\nYour submission will be reviewed as a **replacement**.`);
            } else {
                embed.setTitle('📝 Review Your Submission');
                embed.setColor(0x0099FF);
                embed.setDescription('Please check the details below.');
                embed.setFooter({ text: 'Click Confirm to post to the feed.' });
            }
            return embed;
        };

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('confirm_submission').setLabel('Confirm & Post').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('edit_details').setLabel('Edit Details').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('discard_submission').setLabel('Discard').setStyle(ButtonStyle.Danger),
            );

        // --- IMAGE PROXY LOGIC ---
        // If we have a messageToDelete, it means the URL is volatile. We must re-upload to the preview.
        let finalPhotoUrl = photoUrl;
        let payload = {};
        const isProxying = !!messageToDelete;

        if (isProxying) {
            // We attach the file directly to the bot's reply so it persists after we delete the user's msg
            payload = { 
                embeds: [createPreviewEmbed(tail, type, livery, photoUrl, isDuplicate, true)], 
                components: [row],
                files: [{ attachment: photoUrl, name: 'preview.webp' }], // Discord re-uploads this
                fetchReply: true 
            };
        } else {
            payload = { 
                embeds: [createPreviewEmbed(tail, type, livery, photoUrl, isDuplicate, false)], 
                components: [row],
                fetchReply: true 
            };
        }

        // Send the preview
        let reply;
        if (interaction.isRepliable() && (interaction.deferred || interaction.replied)) {
            // Clear any "Upload photo" text and send preview
            payload.content = ' '; 
            reply = await interaction.editReply(payload);
        } else {
            payload.ephemeral = true;
            reply = await interaction.reply(payload);
        }

        // --- CRITICAL FIX ---
        // If we proxied the image, we must grab the NEW url from the bot's message
        // and safely delete the user's original message now that we have a copy.
        if (isProxying && reply) {
            const attachment = reply.attachments.first();
            if (attachment) {
                finalPhotoUrl = attachment.url; // Use this safe URL for DB and Admin channel
            }
            // Now it is safe to delete the user's message
            if (messageToDelete) {
                messageToDelete.delete().catch(() => {});
            }
        }

        const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collector.on('collect', async i => {
            if (i.customId === 'discard_submission') {
                await i.update({ content: '🗑️ Submission discarded.', embeds: [], components: [], files: [] }); // Clear files to save space
                collector.stop();
                return;
            }

            if (i.customId === 'edit_details') {
                const modal = new ModalBuilder().setCustomId('editModal').setTitle('Edit Aircraft Details');
                const tailInput = new TextInputBuilder().setCustomId('m_tail').setLabel("Tail Number (Optional)").setValue(tail === 'UNKNOWN' ? '' : tail).setRequired(false).setStyle(TextInputStyle.Short);
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
                    type = submission.fields.getTextInputValue('m_type');
                    livery = submission.fields.getTextInputValue('m_livery');

                    // Re-check duplicate on edit
                    isDuplicate = false;
                    const reCheck = await CommunityAircraftModel.findOne({ 
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(livery)}$`, "i") }
                    });
                    if (reCheck) isDuplicate = true;

                    // Update the preview embed. Note: We keep the image handling consistent.
                    await submission.update({ 
                        embeds: [createPreviewEmbed(tail, type, livery, finalPhotoUrl, isDuplicate, isProxying)],
                        components: [row] 
                    });
                } catch (e) { }
            }

            if (i.customId === 'confirm_submission') {
                const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
                const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);

                if (!adminChannel || !feedChannel) return i.update({ content: '❌ Channel configuration error.', components: [] });

                // Prepare the file attachment (Re-uploading ensures visibility)
                const attachmentData = { attachment: finalPhotoUrl, name: 'aircraft.webp' };

                // 1. Post to PUBLIC FEED
                const publicEmbed = new EmbedBuilder()
                    .setTitle('📸 New Aircraft Spotted! (Pending Review)')
                    .setColor(0xFFFF00) // Yellow for Pending
                    .setDescription(`A user has submitted a new photo! Status: **Under Review**`)
                    .addFields(
                        { name: 'Aircraft', value: type, inline: true },
                        { name: 'Livery', value: livery, inline: true },
                        { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                        { name: 'Spotted By', value: `<@${user.id}>`, inline: false }
                    )
                    .setImage('attachment://aircraft.webp') // Reference the attachment
                    .setFooter({ text: 'Submissions are reviewed by admins before database entry.' })
                    .setTimestamp();

                // Send with 'files' array to ensure the image actually renders
                const publicMsg = await feedChannel.send({ embeds: [publicEmbed], files: [attachmentData] });

                // 2. Post to ADMIN CHANNEL
                const finalEmbed = new EmbedBuilder()
                    .addFields(
                        { name: 'Contributor', value: `<@${user.id}>`, inline: true },
                        { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                        { name: 'Aircraft Type', value: type, inline: true },
                        { name: 'Livery', value: livery, inline: true },
                    )
                    .setImage('attachment://aircraft.webp') // Reference the attachment
                    .setTimestamp();

                if (isDuplicate) {
                    finalEmbed.setTitle('⚠️ REPLACEMENT REQUEST');
                    finalEmbed.setColor(0xFFA500);
                    finalEmbed.setDescription(`**Admin Notice:** Matches existing **${type} / ${livery}**.\nApproving this will **REPLACE** the old image.`);
                } else {
                    finalEmbed.setTitle('📋 New Submission Request');
                    finalEmbed.setColor(0x00FF00);
                }
                
                finalEmbed.setFooter({ text: `Pending | User: ${user.id} | Msg: ${publicMsg.id}` });

                const adminRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId(`approve_${user.id}`).setLabel('Approve & Verify').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`reject_${user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
                    );

                // Send to Admin with the file attached
                await adminChannel.send({ embeds: [finalEmbed], components: [adminRow], files: [attachmentData] });
                
                // Cleanup
                await i.update({ content: '✅ Submission posted to feed (pending) and sent to admins!', embeds: [], components: [], files: [] });
                collector.stop();
            }
        });
    };

    // --- LEADERBOARD & SETUP ---
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

            // Edit last or send new
            let lastMessage = (await channel.messages.fetch({ limit: 10 })).find(m => m.author.id === client.user.id);
            if (lastMessage) await lastMessage.edit({ embeds: [leaderboardEmbed] });
            else await channel.send({ embeds: [leaderboardEmbed] });

            // Manage Roles
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

    /**
     * Checks the Submission Channel and posts the UI if missing.
     */
    const setupSubmissionChannel = async () => {
        if (!SUBMISSION_CHANNEL_ID) return;
        try {
            const channel = await client.channels.fetch(SUBMISSION_CHANNEL_ID);
            if (!channel) return;

            // Check if our message exists
            const messages = await channel.messages.fetch({ limit: 5 });
            const existingMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.components.length > 0);

            if (!existingMsg) {
                const embed = new EmbedBuilder()
                    .setTitle('📸 Submit Your Aircraft Photos')
                    .setDescription('Help us build the ultimate aircraft database! \nClick the button below to submit a new photo.')
                    .setColor(0x0099FF)
                    .addFields(
                        { name: '📋 Guidelines', value: '• Photo must be clear and owned by you.\n• Include the Tail Number if visible.\n• Ensure the entire aircraft is in frame.' }
                    )
                    .setImage('https://media.discordapp.net/attachments/1448147572878344405/1448166201741279254/inflight.png?ex=693a4560&is=6938f3e0&hm=e0222d89cc7498a4aca039865ba0ae854741d9fbbffda2a03974769a46b12b63&=&format=webp&quality=lossless&width=930&height=396')
                    .setFooter({ text: 'Inflight Database • Community Driven' });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('start_submission_entry')
                        .setLabel('Submit Photo')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📷')
                );

                await channel.send({ embeds: [embed], components: [row] });
                console.log('✅ Submission Channel UI posted.');
            }
        } catch (error) {
            console.error('❌ Error setting up submission channel:', error);
        }
    };

    // 2. Initialize Bot
    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);
        await fetchAircraftMetadata();
        await setupSubmissionChannel(); // Setup persistent UI

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        // Define Commands
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
                .addFields({ name: '📸 Submit Photos', value: 'Use `/submit` or the submission channel.' })
                .setTimestamp();
            await channel.send({ content: `Welcome ${member}! 👋`, embeds: [welcomeEmbed] });
        } catch (e) {}
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
            // NEW: START SUBMISSION FROM CHANNEL
            if (interaction.customId === 'start_submission_entry') {
                const modal = new ModalBuilder().setCustomId('submission_modal_entry').setTitle('New Aircraft Submission');
                const typeInput = new TextInputBuilder().setCustomId('s_type').setLabel("Aircraft Type").setPlaceholder("e.g. Airbus A320").setStyle(TextInputStyle.Short).setRequired(true);
                const liveryInput = new TextInputBuilder().setCustomId('s_livery').setLabel("Livery Name").setPlaceholder("e.g. Delta Airlines").setStyle(TextInputStyle.Short).setRequired(true);
                const tailInput = new TextInputBuilder().setCustomId('s_tail').setLabel("Tail Number (Optional)").setPlaceholder("e.g. N12345").setStyle(TextInputStyle.Short).setRequired(false);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(typeInput),
                    new ActionRowBuilder().addComponents(liveryInput),
                    new ActionRowBuilder().addComponents(tailInput)
                );
                await interaction.showModal(modal);
            }

            // ADMIN APPROVE
            if (interaction.customId.startsWith('approve_')) {
                await interaction.deferUpdate();
                const [_, targetUserId] = interaction.customId.split('_');
                const receivedEmbed = interaction.message.embeds[0];
                
                const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number').value;
                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                
                // Get the actual URL from the attachment
                let imageUrl = receivedEmbed.image?.url;
                if (interaction.message.attachments.size > 0) {
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

                    // Update Admin Message
                    const approveEmbed = EmbedBuilder.from(receivedEmbed).setColor(0x00FF00).setTitle('✅ Submission Approved').setFooter({ text: `Approved by ${interaction.user.tag}` });
                    await interaction.editReply({ embeds: [approveEmbed], components: [] });

                    if (publicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                            
                            // For the public feed update, we switch to the Permanent S3 URL
                            const publicEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                                .setTitle('✅ Verified Aircraft Spotted!')
                                .setColor(0x00FF00)
                                .setDescription(`Verified and added to database.`)
                                .setImage(permanentUrl) 
                                .setFooter({ text: 'Verified by Staff' });
                                
                            await publicMsg.edit({ embeds: [publicEmbed] });
                        } catch (e) {}
                    }
                    try { (await client.users.fetch(targetUserId)).send(`✅ Your submission for **${typeField}** has been approved!`); } catch (e) { }

                } catch (error) {
                    console.error(error);
                    await interaction.followUp({ content: '❌ Error saving to database/S3.', ephemeral: true });
                }
            }

            // ADMIN REJECT (Triggers the Modal)
            if (interaction.customId.startsWith('reject_')) {
                const targetUserId = interaction.customId.split('_')[1];
                const modal = new ModalBuilder().setCustomId(`rejectModal_${targetUserId}`).setTitle('Rejection Reason');
                const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel("Why is this being rejected?").setStyle(TextInputStyle.Paragraph).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
            }
        }

        if (interaction.isModalSubmit()) {
            // NEW: MODAL SUBMISSION FROM CHANNEL
            if (interaction.customId === 'submission_modal_entry') {
                const type = interaction.fields.getTextInputValue('s_type');
                const livery = interaction.fields.getTextInputValue('s_livery');
                const tailRaw = interaction.fields.getTextInputValue('s_tail');
                const tail = tailRaw.trim() === '' ? 'UNKNOWN' : tailRaw;

                await interaction.reply({ 
                    content: `**Almost done!**\n\nPlease **upload the photo** for **${type}** in this channel now.\nI will detect it, delete your message to keep chat clean, and process the submission.`,
                    ephemeral: true 
                });

                const filter = m => m.author.id === interaction.user.id && m.attachments.size > 0;
                const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60000 });

                collector.on('collect', async m => {
                    const photo = m.attachments.first();
                    if (!photo.contentType.startsWith('image/')) {
                         await interaction.followUp({ content: '❌ File was not an image. Submission cancelled.', ephemeral: true });
                         m.delete().catch(() => {});
                         return;
                    }
                    await startSubmissionFlow(interaction, type, livery, tail, photo.url, interaction.user, m);
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        interaction.editReply({ content: '❌ Timed out waiting for photo. Please start over.', embeds: [] });
                    }
                });
                return; 
            }

            // --- REJECTION MODAL HANDLER (UPDATED FOR THREADS) ---
            if (interaction.customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate(); // Acknowledge modal submission
                const targetUserId = interaction.customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                
                const originalEmbed = interaction.message.embeds[0];
                const footerText = originalEmbed.footer?.text || '';
                const publicMsgId = footerText.match(/Msg: (\d+)/)?.[1];
                const aircraftName = originalEmbed.fields.find(f => f.name === 'Aircraft Type')?.value || 'Unknown Aircraft';

                // 1. Update Admin Message to Rejected
                const rejectedEmbed = EmbedBuilder.from(originalEmbed)
                    .setTitle('❌ Submission Rejected')
                    .setColor(0xFF0000)
                    .setDescription(`**Reason:** ${reason}`)
                    .setFooter({ text: `Rejected by ${interaction.user.tag}` });
                
                // Clear buttons
                await interaction.editReply({ embeds: [rejectedEmbed], components: [], files: [] });

                // 2. Update Public Feed & Create Discussion Thread
                if (publicMsgId) {
                    try {
                        const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                        
                        if (publicMsg) {
                            // Update the embed to show it was rejected
                            const publicRejectedEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                                .setTitle('❌ Submission Rejected')
                                .setColor(0xFF0000) // Red
                                .setDescription(`This submission was not accepted.\n**Reason:** ${reason}`)
                                .setFooter({ text: `Reviewed by Staff` });

                            await publicMsg.edit({ embeds: [publicRejectedEmbed] });

                            // Create the Thread for discussion
                            const thread = await publicMsg.startThread({
                                name: `Rejection Appeal - ${aircraftName}`,
                                autoArchiveDuration: 1440, // 24 hours
                                reason: 'Submission Rejection Discussion'
                            });

                            await thread.send(`Hi <@${targetUserId}>, your submission was rejected by <@${interaction.user.id}>.\n**Reason:** ${reason}\n\nIf you have questions or want to appeal, you can discuss it here with the staff.`);
                        }
                    } catch (e) {
                        console.error('Could not handle public rejection thread:', e.message);
                    }
                }

                // 3. DM The User (Notification Only)
                try {
                    const user = await client.users.fetch(targetUserId);
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('❌ Submission Rejected')
                        .setColor(0xFF0000)
                        .setDescription(`Your submission for **${aircraftName}** was not accepted.`)
                        .addFields(
                            { name: 'Reason', value: reason },
                            { name: 'Discussion', value: 'A thread has been created on your submission in the feed channel if you wish to discuss this.' }
                        )
                        .setTimestamp();
                    
                    await user.send({ embeds: [dmEmbed] });
                } catch (e) {
                    // User DMs likely closed
                }
            }
        }

        // --- CHAT COMMANDS ---
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'submit') {
            const type = interaction.options.getString('aircraft_type');
            const livery = interaction.options.getString('livery');
            const tail = interaction.options.getString('tail_number') || 'UNKNOWN';
            const photo = interaction.options.getAttachment('photo');

            if (!photo.contentType.startsWith('image/')) {
                return interaction.reply({ content: '❌ Invalid image.', ephemeral: true });
            }

            // Use shared logic
            await startSubmissionFlow(interaction, type, livery, tail, photo.url, interaction.user);
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
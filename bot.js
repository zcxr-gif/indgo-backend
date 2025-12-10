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
const METADATA_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api/metadata';

// CACHE FOR AUTOCOMPLETE
let cachedAircraftNames = [];
let lastCacheUpdate = 0;

const fetchAircraftMetadata = async () => {
    if (Date.now() - lastCacheUpdate < 3600000 && cachedAircraftNames.length > 0) {
        return cachedAircraftNames;
    }
    try {
        const response = await axios.get(METADATA_API_URL);
        if (response.data && response.data.aircraft) {
            cachedAircraftNames = response.data.aircraft.map(a => a.name).sort();
            lastCacheUpdate = Date.now();
        }
        return cachedAircraftNames;
    } catch (error) {
        console.error('❌ Failed to fetch aircraft metadata:', error.message);
        return [];
    }
};

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region) => {

    const client = new Client({ 
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
        ] 
    });

    // 1. Define Slash Commands
    const commands = [
        new SlashCommandBuilder()
            .setName('lookup')
            .setDescription('Find an aircraft by Tail Number, Livery, or Type')
            .addStringOption(option => 
                option.setName('query')
                    .setDescription('Tail Number, Livery Name, or Aircraft Type')
                    .setAutocomplete(true) 
                    .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName('stats')
            .setDescription('View database statistics'),

        new SlashCommandBuilder()
            .setName('profile')
            .setDescription('Check your contribution stats')
            .addUserOption(option => 
                option.setName('user')
                    .setDescription('Check another user\'s stats (optional)')),

        new SlashCommandBuilder()
            .setName('submit')
            .setDescription('Submit a new aircraft photo to the database')
            .addStringOption(option => 
                option.setName('aircraft_type')
                    .setDescription('Type of aircraft (Start typing to search)')
                    .setAutocomplete(true) 
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('livery')
                    .setDescription('The livery/airline name')
                    .setRequired(true))
            .addAttachmentOption(option => 
                option.setName('photo')
                    .setDescription('Upload the photo')
                    .setRequired(true))
            // UPDATED: Tail Number is now Optional
            .addStringOption(option => 
                option.setName('tail_number')
                    .setDescription('Registration (Optional - helps verification!)')
                    .setRequired(false)) 
    ].map(command => command.toJSON());

    // 2. Initialize Bot
    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);
        await fetchAircraftMetadata();

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        try {
            await rest.put(
                Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
                { body: commands },
            );
            console.log('✅ Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error('❌ Error registering commands:', error);
        }
    });

    /**
     * S3 Upload Helper
     */
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

    // 3. Handle Interactions
    client.on('interactionCreate', async interaction => {
        
        // --- AUTOCOMPLETE ---
        if (interaction.isAutocomplete()) {
            const focusedOption = interaction.options.getFocused(true);
            const aircraftList = await fetchAircraftMetadata();
            
            if (focusedOption.name === 'aircraft_type' || focusedOption.name === 'query') {
                const filtered = aircraftList.filter(choice => 
                    choice.toLowerCase().includes(focusedOption.value.toLowerCase())
                );
                await interaction.respond(
                    filtered.slice(0, 25).map(choice => ({ name: choice, value: choice }))
                );
            }
        }

        // --- ADMIN BUTTONS ---
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('reject_')) {
                const [action, targetUserId] = interaction.customId.split('_');
                const receivedEmbed = interaction.message.embeds[0];
                
                // Parse fields
                const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number').value;
                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                const imageUrl = receivedEmbed.image.url;

                if (action === 'reject') {
                    const rejectEmbed = EmbedBuilder.from(receivedEmbed)
                        .setColor(0xFF0000)
                        .setTitle('❌ Submission Rejected')
                        .setFooter({ text: `Rejected by ${interaction.user.tag}` });
                    
                    await interaction.update({ embeds: [rejectEmbed], components: [] });
                    try {
                        const user = await client.users.fetch(targetUserId);
                        await user.send(`Your submission for **${typeField} (${liveryField})** was rejected.`);
                    } catch (e) { }
                    return;
                }

                if (action === 'approve') {
                    await interaction.deferUpdate();
                    try {
                        // 1. DUPLICATE LOGIC: Check by TYPE + LIVERY (Case insensitive)
                        // This finds the existing plane even if the old one had a wrong tail number
                        const existingEntry = await CommunityAircraftModel.findOne({ 
                            aircraftType: { $regex: new RegExp(`^${typeField}$`, "i") },
                            liveryName: { $regex: new RegExp(`^${liveryField}$`, "i") }
                        });
                        
                        const permanentUrl = await uploadImageToS3(imageUrl, tailField);
                        let contributorName = "Unknown";
                        try {
                            const user = await client.users.fetch(targetUserId);
                            contributorName = user.username;
                        } catch (e) {}

                        if (existingEntry) {
                             console.log(`♻️ Replacing existing entry: ${typeField} - ${liveryField}`);
                             
                             // Update existing record
                             existingEntry.imageUrl = permanentUrl;
                             existingEntry.uploadedAt = new Date(); 
                             existingEntry.contributorName = contributorName;
                             
                             // Also update tail number if the new one is "better" (not "UNKNOWN")
                             if (tailField !== 'UNKNOWN') {
                                 existingEntry.tailNumber = tailField.toUpperCase();
                             }
                             
                             await existingEntry.save();
                        } else {
                            // Create New
                            const newEntry = new CommunityAircraftModel({
                                contributorName: contributorName,
                                aircraftType: typeField,
                                liveryName: liveryField,
                                tailNumber: tailField.toUpperCase(),
                                imageUrl: permanentUrl,
                                uploadedAt: new Date()
                            });
                            await newEntry.save();
                        }

                        const approveEmbed = EmbedBuilder.from(receivedEmbed)
                            .setColor(0x00FF00)
                            .setTitle('✅ Submission Approved')
                            .setFooter({ text: `Approved by ${interaction.user.tag}` });
                        
                        await interaction.editReply({ embeds: [approveEmbed], components: [] });

                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            if (feedChannel) {
                                const publicEmbed = new EmbedBuilder()
                                    .setTitle('📸 New Aircraft Spotted!')
                                    .setColor(0x0099FF)
                                    .setDescription(`A new contribution has been added to the global database!`)
                                    .addFields(
                                        { name: 'Aircraft', value: typeField, inline: true },
                                        { name: 'Livery', value: liveryField, inline: true },
                                        { name: 'Tail Number', value: tailField, inline: true },
                                        { name: 'Spotted By', value: `<@${targetUserId}>`, inline: false }
                                    )
                                    .setImage(permanentUrl) 
                                    .setFooter({ text: 'Submit your own photos using /submit' })
                                    .setTimestamp();
                                await feedChannel.send({ embeds: [publicEmbed] });
                            }
                        } catch (feedError) { console.error("Could not post to public feed:", feedError); }

                        try {
                            const user = await client.users.fetch(targetUserId);
                            await user.send(`✅ Your submission for **${typeField}** has been approved!`);
                        } catch (e) { }

                    } catch (error) {
                        console.error(error);
                        await interaction.followUp({ content: '❌ Error saving to database/S3.', ephemeral: true });
                    }
                }
            }
        }

        // --- COMMANDS ---
        if (!interaction.isChatInputCommand()) return;

        // COMMAND: /submit
        if (interaction.commandName === 'submit') {
            // 1. Capture Input (Tail is optional now)
            let type = interaction.options.getString('aircraft_type');
            let livery = interaction.options.getString('livery');
            let tail = interaction.options.getString('tail_number') || 'UNKNOWN'; // Default if empty
            const photo = interaction.options.getAttachment('photo');

            if (!photo.contentType.startsWith('image/')) {
                return interaction.reply({ content: '❌ Please upload a valid image file (JPG, PNG).', ephemeral: true });
            }

            // 2. CHECK FOR DUPLICATES BY TYPE + LIVERY
            // We ignore tail number for detection, because users might typo the tail
            let isDuplicate = false;
            try {
                const existing = await CommunityAircraftModel.findOne({ 
                    aircraftType: { $regex: new RegExp(`^${type}$`, "i") },
                    liveryName: { $regex: new RegExp(`^${livery}$`, "i") }
                });
                if (existing) isDuplicate = true;
            } catch (err) { console.error("DB Check failed", err); }

            // 3. Build Preview
            const createPreviewEmbed = (t, tp, l, imgUrl, isDup) => {
                const embed = new EmbedBuilder()
                    .addFields(
                        { name: 'Aircraft Type', value: tp, inline: true },
                        { name: 'Livery', value: l, inline: true },
                        { name: 'Tail Number', value: t.toUpperCase(), inline: true },
                    )
                    .setImage(imgUrl);

                if (isDup) {
                    embed.setTitle('⚠️ Existing Entry Detected');
                    embed.setColor(0xFFA500); // Orange
                    embed.setDescription(`**Note:** We already have a photo for **${tp}** in **${l}** livery.\n\nYour submission will be reviewed as a **replacement** for the existing image.`);
                } else {
                    embed.setTitle('📝 Review Your Submission');
                    embed.setColor(0x0099FF); // Blue
                    embed.setDescription('Please check the details below.');
                    embed.setFooter({ text: 'Click Confirm to send to Admins.' });
                }
                
                return embed;
            };

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('confirm_submission').setLabel('Confirm & Send').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('edit_details').setLabel('Edit Details').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('discard_submission').setLabel('Discard').setStyle(ButtonStyle.Danger),
                );

            const reply = await interaction.reply({ 
                embeds: [createPreviewEmbed(tail, type, livery, photo.url, isDuplicate)], 
                components: [row],
                ephemeral: true,
                fetchReply: true 
            });

            // 4. Collector
            const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

            collector.on('collect', async i => {
                if (i.customId === 'discard_submission') {
                    await i.update({ content: '🗑️ Submission discarded.', embeds: [], components: [] });
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

                    const modalFilter = (submission) => submission.customId === 'editModal' && submission.user.id === interaction.user.id;
                    try {
                        const submission = await i.awaitModalSubmit({ filter: modalFilter, time: 60000 });
                        
                        // Update values (Handle empty tail)
                        const newTail = submission.fields.getTextInputValue('m_tail');
                        tail = newTail.trim() === '' ? 'UNKNOWN' : newTail;
                        type = submission.fields.getTextInputValue('m_type');
                        livery = submission.fields.getTextInputValue('m_livery');

                        // Re-check duplicate with updated Type/Livery
                        isDuplicate = false;
                        const reCheck = await CommunityAircraftModel.findOne({ 
                            aircraftType: { $regex: new RegExp(`^${type}$`, "i") },
                            liveryName: { $regex: new RegExp(`^${livery}$`, "i") }
                        });
                        if (reCheck) isDuplicate = true;

                        await submission.update({ 
                            embeds: [createPreviewEmbed(tail, type, livery, photo.url, isDuplicate)],
                            components: [row] 
                        });
                    } catch (e) { }
                }

                if (i.customId === 'confirm_submission') {
                    const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
                    if (!adminChannel) return i.update({ content: '❌ Admin channel error.', components: [] });

                    const finalEmbed = new EmbedBuilder()
                        .addFields(
                            { name: 'Contributor', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                            { name: 'Aircraft Type', value: type, inline: true },
                            { name: 'Livery', value: livery, inline: true },
                        )
                        .setImage(photo.url)
                        .setTimestamp();

                    if (isDuplicate) {
                        finalEmbed.setTitle('⚠️ REPLACEMENT REQUEST');
                        finalEmbed.setColor(0xFFA500);
                        finalEmbed.setDescription(`**Admin Notice:** Matches existing **${type} / ${livery}**.\nApproving this will **REPLACE** the old image.`);
                    } else {
                        finalEmbed.setTitle('📋 New Submission Request');
                        finalEmbed.setColor(0x00FF00);
                        finalEmbed.setFooter({ text: `Pending Approval | UserID: ${interaction.user.id}` });
                    }

                    const adminRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`approve_${interaction.user.id}`).setLabel(isDuplicate ? 'Replace & Publish' : 'Approve & Publish').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`reject_${interaction.user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
                        );

                    await adminChannel.send({ embeds: [finalEmbed], components: [adminRow] });
                    await i.update({ content: '✅ Submission sent to admins successfully!', embeds: [], components: [] });
                    collector.stop();
                }
            });
        }

        // COMMAND: /lookup
        if (interaction.commandName === 'lookup') {
            const query = interaction.options.getString('query');
            await interaction.deferReply(); 

            try {
                const result = await CommunityAircraftModel.findOne({
                    $or: [
                        { tailNumber: { $regex: query, $options: 'i' } },
                        { liveryName: { $regex: query, $options: 'i' } },
                        { aircraftType: { $regex: query, $options: 'i' } } 
                    ]
                });

                if (!result) {
                    await interaction.editReply(`❌ No aircraft found matching "**${query}**".`);
                } else {
                    const embed = new EmbedBuilder()
                        .setTitle(`🔍 Lookup Result: ${result.tailNumber}`)
                        .setColor(0x0099FF)
                        .addFields(
                            { name: 'Aircraft', value: result.aircraftType, inline: true },
                            { name: 'Livery', value: result.liveryName, inline: true },
                            { name: 'Contributor', value: result.contributorName, inline: true },
                        )
                        .setImage(result.imageUrl)
                        .setTimestamp(result.uploadedAt);
                    await interaction.editReply({ embeds: [embed] });
                }
            } catch (error) {
                console.error(error);
                await interaction.editReply('⚠️ An error occurred while searching the database.');
            }
        }

        // COMMAND: /profile
        if (interaction.commandName === 'profile') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            await interaction.deferReply();
            try {
                const count = await CommunityAircraftModel.countDocuments({ contributorName: targetUser.username });
                const recent = await CommunityAircraftModel.findOne({ contributorName: targetUser.username }).sort({ uploadedAt: -1 });

                const embed = new EmbedBuilder()
                    .setTitle(`✈️ Pilot Profile: ${targetUser.username}`)
                    .setThumbnail(targetUser.displayAvatarURL())
                    .setColor(0xFFD700) 
                    .addFields(
                        { name: 'Total Contributions', value: `${count} Aircraft`, inline: true },
                        { name: 'Rank', value: count > 10 ? 'Captain' : count > 5 ? 'First Officer' : 'Cadet', inline: true }
                    );

                if (recent) {
                    embed.addFields({ name: 'Last Spotted', value: `${recent.tailNumber} (${recent.aircraftType})` });
                    embed.setImage(recent.imageUrl);
                }
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error(error);
                await interaction.editReply('Error fetching profile.');
            }
        }

        // COMMAND: /stats
        if (interaction.commandName === 'stats') {
            try {
                const count = await CommunityAircraftModel.countDocuments();
                await interaction.reply({ 
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('📊 Database Statistics')
                            .setColor(0x00FF99)
                            .setDescription(`The community has tracked **${count}** unique aircraft so far!`)
                            .setTimestamp()
                    ] 
                });
            } catch (error) {
                await interaction.reply('Error fetching stats.');
            }
        }
    });

    if (process.env.DISCORD_BOT_TOKEN) {
        client.login(process.env.DISCORD_BOT_TOKEN);
    } else {
        console.log('⚠️ DISCORD_BOT_TOKEN missing. Bot will not start.');
    }
};

module.exports = { startDiscordBot };
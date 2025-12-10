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
    SlashCommandBuilder 
} = require('discord.js');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const sharp = require('sharp'); // Added for Image Efficiency

// CONFIGURATION - REPLACE THESE WITH YOUR REAL CHANNEL IDS
const ADMIN_CHANNEL_ID = '1448137363795742942'; // Where approvals go
const PUBLIC_FEED_CHANNEL_ID = '1448138153335586988'; // Where approved pics go

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
                option.setName('tail_number')
                    .setDescription('The registration/tail number (e.g., N12345)')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('aircraft_type')
                    .setDescription('Type of aircraft (e.g., Boeing 737)')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('livery')
                    .setDescription('The livery/airline name')
                    .setRequired(true))
            .addAttachmentOption(option => 
                option.setName('photo')
                    .setDescription('Upload the photo')
                    .setRequired(true))
    ].map(command => command.toJSON());

    // 2. Initialize Bot
    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);
        
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        try {
            console.log('Started refreshing application (/) commands.');
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
     * Helper: Upload Image to S3 from URL with Optimization
     * EFFICIENCY UPGRADE: Converts to WebP and Resizes before S3 upload.
     * This saves Storage Space and Bandwidth.
     */
    const uploadImageToS3 = async (url, tailNumber) => {
        try {
            // 1. Download image from Discord CDN
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            
            // 2. Process with Sharp (Resize & Compress)
            // Limits width to 1920px (HD), converts to WebP (smaller file size)
            const optimizedBuffer = await sharp(response.data)
                .resize({ width: 1920, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();

            // 3. Prepare S3 Key
            const cleanTail = tailNumber.replace(/[^a-zA-Z0-9]/g, '');
            // Using .webp extension now
            const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`; 

            // 4. Upload
            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: fileName,
                Body: optimizedBuffer,
                ContentType: 'image/webp',
            }));

            // 5. Return Public URL
            return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;
        } catch (error) {
            console.error('S3 Upload Error:', error);
            throw new Error('Failed to upload image to storage.');
        }
    };

    // 3. Handle Interactions
    client.on('interactionCreate', async interaction => {
        
        // --- BUTTON HANDLERS (ADMIN APPROVAL) ---
        if (interaction.isButton()) {
            const [action, ...data] = interaction.customId.split('_');
            
            if (action === 'approve' || action === 'reject') {
                const targetUserId = data[0];
                const receivedEmbed = interaction.message.embeds[0];
                
                // Extract Data from Embed Fields
                const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number').value;
                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                const imageUrl = receivedEmbed.image.url;

                if (action === 'reject') {
                    const rejectEmbed = EmbedBuilder.from(receivedEmbed)
                        .setColor(0xFF0000) // Red
                        .setTitle('❌ Submission Rejected')
                        .setFooter({ text: `Rejected by ${interaction.user.tag}` });
                    
                    await interaction.update({ embeds: [rejectEmbed], components: [] });
                    
                    // DM the user
                    try {
                        const user = await client.users.fetch(targetUserId);
                        await user.send(`Your submission for **${tailField}** was rejected by the admin team.`);
                    } catch (e) { /* User has DMs closed */ }
                    return;
                }

                if (action === 'approve') {
                    // Defer update to prevent interaction timeout while uploading
                    await interaction.deferUpdate();

                    try {
                        // 1. Upload to S3 (Optimized)
                        const permanentUrl = await uploadImageToS3(imageUrl, tailField);

                        // 2. Get Contributor Details
                        let contributorName = "Unknown";
                        try {
                            const user = await client.users.fetch(targetUserId);
                            contributorName = user.username;
                        } catch (e) { }

                        // 3. Save to MongoDB
                        const newEntry = new CommunityAircraftModel({
                            contributorName: contributorName,
                            aircraftType: typeField,
                            liveryName: liveryField,
                            tailNumber: tailField.toUpperCase(),
                            imageUrl: permanentUrl,
                            uploadedAt: new Date()
                        });

                        await newEntry.save();

                        // 4. Update Admin Message
                        const approveEmbed = EmbedBuilder.from(receivedEmbed)
                            .setColor(0x00FF00) // Green
                            .setTitle('✅ Submission Approved')
                            .setFooter({ text: `Approved by ${interaction.user.tag}` });
                        
                        await interaction.editReply({ embeds: [approveEmbed], components: [] });

                        // 5. Post to Public Feed (PUBLIC DISPLAY LOGIC)
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
                        } catch (feedError) {
                            console.error("Could not post to public feed:", feedError);
                        }

                        // 6. DM User success
                        try {
                            const user = await client.users.fetch(targetUserId);
                            await user.send(`✅ Your submission for **${tailField}** has been approved and posted to the public feed!`);
                        } catch (e) { }

                    } catch (error) {
                        console.error(error);
                        // If we already deferred, we must use followUp
                        await interaction.followUp({ content: '❌ Error saving to database/S3. Check console.', ephemeral: true });
                    }
                }
            }
            return;
        }

        // --- COMMAND HANDLERS ---
        if (!interaction.isChatInputCommand()) return;

        // COMMAND: /submit
        if (interaction.commandName === 'submit') {
            const tail = interaction.options.getString('tail_number');
            const type = interaction.options.getString('aircraft_type');
            const livery = interaction.options.getString('livery');
            const photo = interaction.options.getAttachment('photo');

            // Validation: Ensure it's an image
            if (!photo.contentType.startsWith('image/')) {
                return interaction.reply({ content: '❌ Please upload a valid image file (JPG, PNG).', ephemeral: true });
            }

            const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
            if (!adminChannel) {
                return interaction.reply({ content: '❌ Admin channel not configured.', ephemeral: true });
            }

            // Create Pending Embed
            const pendingEmbed = new EmbedBuilder()
                .setTitle('📋 New Submission Request')
                .setColor(0xFFA500) // Orange
                .addFields(
                    { name: 'Contributor', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                    { name: 'Aircraft Type', value: type, inline: true },
                    { name: 'Livery', value: livery, inline: true },
                )
                .setImage(photo.url) // Uses Discord CDN temporarily
                .setFooter({ text: `Pending Approval | UserID: ${interaction.user.id}` })
                .setTimestamp();

            // Create Buttons
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_${interaction.user.id}`)
                        .setLabel('Approve & Publish')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`reject_${interaction.user.id}`)
                        .setLabel('Reject')
                        .setStyle(ButtonStyle.Danger),
                );

            await adminChannel.send({ embeds: [pendingEmbed], components: [row] });

            await interaction.reply({ content: '✅ Your submission has been sent to the admins for review! You will be notified if it is accepted.', ephemeral: true });
        }

        // COMMAND: /lookup
        if (interaction.commandName === 'lookup') {
            const query = interaction.options.getString('query');
            await interaction.deferReply(); 

            try {
                // Expanded Regex Search
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
                    .setColor(0xFFD700) // Gold
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

    // 4. Login
    if (process.env.DISCORD_BOT_TOKEN) {
        client.login(process.env.DISCORD_BOT_TOKEN);
    } else {
        console.log('⚠️ DISCORD_BOT_TOKEN missing. Bot will not start.');
    }
};

module.exports = { startDiscordBot };
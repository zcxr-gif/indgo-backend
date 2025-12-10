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
const WELCOME_CHANNEL_ID = '1442459109608656917'; // <--- NEW: Add your welcome channel ID here
const METADATA_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api/metadata';
const BASE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api';

// --- CACHE SYSTEMS ---
// 1. Aircraft Cache: Stores [{ name: "Airbus A320", id: "123" }]
let cachedAircraftData = []; 
let lastAircraftCacheUpdate = 0;

// 2. Livery Cache: Stores { "aircraftID": { timestamp: 123456, data: ["Livery A", "Livery B"] } }
let cachedLiveries = {}; 

/**
 * Fetches and caches the list of all aircraft types + IDs
 */
const fetchAircraftMetadata = async () => {
    // Refresh only if older than 1 hour or empty
    if (Date.now() - lastAircraftCacheUpdate < 3600000 && cachedAircraftData.length > 0) {
        return cachedAircraftData;
    }
    try {
        const response = await axios.get(METADATA_API_URL);
        if (response.data && response.data.aircraft) {
            // Map to store Name AND ID
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
    // Check cache first (valid for 5 mins)
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

        // Update Cache
        cachedLiveries[aircraftId] = {
            timestamp: now,
            data: liveryList
        };
        
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
            GatewayIntentBits.GuildMembers, // <--- ADDED: Required to detect new members
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
                    .setAutocomplete(true) // ENABLED AUTOCOMPLETE FOR LIVERIES
                    .setRequired(true))
            .addAttachmentOption(option => 
                option.setName('photo')
                    .setDescription('Upload the photo')
                    .setRequired(true))
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

    // --- NEW: WELCOME MESSAGE EVENT ---
    client.on('guildMemberAdd', async (member) => {
        // Prevent crashing if the channel isn't set
        if (!WELCOME_CHANNEL_ID || WELCOME_CHANNEL_ID === 'REPLACE_THIS_WITH_YOUR_WELCOME_CHANNEL_ID') {
            console.warn('⚠️ Welcome channel ID not configured.');
            return;
        }

        try {
            const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
            if (!channel) return;

            const welcomeEmbed = new EmbedBuilder()
                .setTitle(`Welcome to Inflight!`)
                .setDescription(`Hello ${member}, welcome to the server! We are thrilled to have you here.\n\nInflight is the place for aviation enthusiasts to track flights and share their spots.`)
                .setColor(0x0099FF)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 })) // User's avatar
                .setImage('https://media.discordapp.net/attachments/1448147572878344405/1448166201741279254/inflight.png?ex=693a4560&is=6938f3e0&hm=e0222d89cc7498a4aca039865ba0ae854741d9fbbffda2a03974769a46b12b63&=&format=webp&quality=lossless&width=930&height=396') // Your Logo
                .addFields(
                    { 
                        name: '📸 Submit Photos', 
                        value: 'Help us grow the database! Use the `/submit` command to upload your aircraft photos.', 
                        inline: false 
                    },
                    { 
                        name: '🌍 Live Tracker', 
                        value: 'Check out our live flight tracker at [inflight.info](https://inflight.info/)', 
                        inline: false 
                    }
                )
                .setFooter({ text: 'Happy Spotting!' })
                .setTimestamp();

            await channel.send({ 
                content: `Welcome to the crew, ${member}! 👋`, 
                embeds: [welcomeEmbed] 
            });

        } catch (error) {
            console.error('❌ Error sending welcome message:', error);
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
        
        // --- AUTOCOMPLETE LOGIC ---
        if (interaction.isAutocomplete()) {
            const focusedOption = interaction.options.getFocused(true);
            
            // AIRCRAFT TYPE AUTOCOMPLETE
            if (focusedOption.name === 'aircraft_type' || focusedOption.name === 'query') {
                const aircraftList = await fetchAircraftMetadata();
                const filtered = aircraftList
                    .filter(a => a.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                    .slice(0, 25);
                
                await interaction.respond(
                    filtered.map(a => ({ name: a.name, value: a.name }))
                );
            }

            // LIVERY AUTOCOMPLETE (DEPENDS ON AIRCRAFT TYPE)
            if (focusedOption.name === 'livery') {
                // 1. Get the currently selected aircraft type string
                const selectedType = interaction.options.getString('aircraft_type');
                
                if (!selectedType) {
                    // User hasn't selected an aircraft yet
                    await interaction.respond([{ name: "Please select Aircraft Type first", value: "Unknown" }]);
                    return;
                }

                // 2. Find the ID for that aircraft name
                const aircraftList = await fetchAircraftMetadata();
                const matchedAircraft = aircraftList.find(a => a.name === selectedType);

                if (matchedAircraft) {
                    // 3. Fetch specific liveries for this ID
                    const liveries = await fetchLiveriesForAircraft(matchedAircraft.id);
                    
                    // 4. Filter based on what user is typing in livery field
                    const filteredLiveries = liveries
                        .filter(l => l.toLowerCase().includes(focusedOption.value.toLowerCase()))
                        .slice(0, 24); // Limit to 24 to leave room for "Other"

                    // 5. Always add the user's current input as an option if it's not in the list (Custom Livery support)
                    // This is important because the API might not have EVERY livery in existence.
                    const finalOptions = filteredLiveries.map(l => ({ name: l, value: l }));
                    
                    if (focusedOption.value && !liveries.includes(focusedOption.value)) {
                         finalOptions.push({ name: `${focusedOption.value} (Custom)`, value: focusedOption.value });
                    }
                    
                    await interaction.respond(finalOptions);
                } else {
                    await interaction.respond([{ name: "Aircraft not found in database", value: "Unknown" }]);
                }
            }
        }

        // --- BUTTON HANDLING (Approve / Reject Logic) ---
        if (interaction.isButton()) {
            
            // ADMIN APPROVE
            if (interaction.customId.startsWith('approve_')) {
                await interaction.deferUpdate();
                const [action, targetUserId] = interaction.customId.split('_');
                const receivedEmbed = interaction.message.embeds[0];
                
                // Parse fields
                const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number').value;
                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                const imageUrl = receivedEmbed.image.url;

                // Parse Public Message ID from Footer
                const footerText = receivedEmbed.footer?.text || '';
                const publicMsgIdMatch = footerText.match(/Msg: (\d+)/);
                const publicMsgId = publicMsgIdMatch ? publicMsgIdMatch[1] : null;

                try {
                    // 1. Database & S3 Operations
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
                        existingEntry.imageUrl = permanentUrl;
                        existingEntry.uploadedAt = new Date(); 
                        existingEntry.contributorName = contributorName;
                        if (tailField !== 'UNKNOWN') {
                            existingEntry.tailNumber = tailField.toUpperCase();
                        }
                        await existingEntry.save();
                    } else {
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

                    // 2. Update Admin Embed
                    const approveEmbed = EmbedBuilder.from(receivedEmbed)
                        .setColor(0x00FF00)
                        .setTitle('✅ Submission Approved')
                        .setFooter({ text: `Approved by ${interaction.user.tag}` });
                    
                    await interaction.editReply({ embeds: [approveEmbed], components: [] });

                    // 3. Update PUBLIC Feed Message
                    if (publicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                            
                            const publicEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                                .setTitle('✅ Verified Aircraft Spotted!')
                                .setColor(0x00FF00)
                                .setDescription(`This submission has been **verified** and added to the database.`)
                                .setImage(permanentUrl)
                                .setFooter({ text: 'Verified by Staff' })
                                .setTimestamp();

                            await publicMsg.edit({ embeds: [publicEmbed] });
                        } catch (feedError) {
                            console.error("Failed to update public feed message:", feedError);
                        }
                    }

                    try {
                        const user = await client.users.fetch(targetUserId);
                        await user.send(`✅ Your submission for **${typeField}** has been approved!`);
                    } catch (e) { }

                } catch (error) {
                    console.error(error);
                    await interaction.followUp({ content: '❌ Error saving to database/S3.', ephemeral: true });
                }
            }

            // ADMIN REJECT BUTTON
            if (interaction.customId.startsWith('reject_')) {
                const targetUserId = interaction.customId.split('_')[1];
                
                const modal = new ModalBuilder()
                    .setCustomId(`rejectModal_${targetUserId}`)
                    .setTitle('Rejection Reason');

                const reasonInput = new TextInputBuilder()
                    .setCustomId('reasonInput')
                    .setLabel("Why is this being rejected?")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder("e.g., Image too dark, wrong aircraft type...")
                    .setRequired(true);

                const firstActionRow = new ActionRowBuilder().addComponents(reasonInput);
                modal.addComponents(firstActionRow);

                await interaction.showModal(modal);
            }
        }

        // --- MODAL SUBMIT ---
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate();
                
                const targetUserId = interaction.customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                
                const adminMessage = interaction.message; 
                const receivedEmbed = adminMessage.embeds[0];

                const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type').value;
                const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery').value;
                const footerText = receivedEmbed.footer?.text || '';
                const publicMsgIdMatch = footerText.match(/Msg: (\d+)/);
                const publicMsgId = publicMsgIdMatch ? publicMsgIdMatch[1] : null;

                const rejectEmbed = EmbedBuilder.from(receivedEmbed)
                    .setColor(0xFF0000)
                    .setTitle('❌ Submission Rejected')
                    .addFields({ name: 'Reason', value: reason })
                    .setFooter({ text: `Rejected by ${interaction.user.tag}` });
                
                await interaction.editReply({ embeds: [rejectEmbed], components: [] });

                if (publicMsgId) {
                    try {
                        const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                        
                        const publicEmbed = EmbedBuilder.from(publicMsg.embeds[0])
                            .setTitle('❌ Submission Denied')
                            .setColor(0xFF0000)
                            .setDescription(`This submission was not accepted into the database.`)
                            .addFields({ name: 'Reason', value: reason })
                            .setFooter({ text: 'Check the thread below for details/questions.' });

                        await publicMsg.edit({ embeds: [publicEmbed] });

                        // --- CREATE THREAD FOR QUESTIONS ---
                        // Create a thread on the public rejection message
                        const thread = await publicMsg.startThread({
                            name: `Rejection Appeal - ${typeField}`,
                            autoArchiveDuration: 1440, // 24 Hours
                            reason: 'User inquiry regarding rejected aircraft submission',
                        });

                        // Send an initial message tagging the user so they see the thread
                        await thread.send({
                            content: `Hello <@${targetUserId}>,\n\nYour submission for **${typeField}** was rejected by the moderation team.\n\n**Reason:** ${reason}\n\nIf you have any questions or would like to clarify details about this photo, please ask here.`
                        });

                    } catch (feedError) {
                        console.error("Failed to update public feed message or create thread:", feedError);
                    }
                }

                try {
                    const user = await client.users.fetch(targetUserId);
                    // Updated DM to mention the thread
                    await user.send(`❌ Your submission for **${typeField} (${liveryField})** was rejected.\n**Reason:** ${reason}\n\nA thread has been created on the public post if you wish to appeal or ask questions.`);
                } catch (e) { }
            }
        }

        // --- CHAT COMMANDS ---
        if (!interaction.isChatInputCommand()) return;

        // COMMAND: /submit
        if (interaction.commandName === 'submit') {
            let type = interaction.options.getString('aircraft_type');
            let livery = interaction.options.getString('livery');
            let tail = interaction.options.getString('tail_number') || 'UNKNOWN';
            const photo = interaction.options.getAttachment('photo');

            if (!photo.contentType.startsWith('image/')) {
                return interaction.reply({ content: '❌ Please upload a valid image file (JPG, PNG).', ephemeral: true });
            }

            let isDuplicate = false;
            try {
                const existing = await CommunityAircraftModel.findOne({ 
                    aircraftType: { $regex: new RegExp(`^${type}$`, "i") },
                    liveryName: { $regex: new RegExp(`^${livery}$`, "i") }
                });
                if (existing) isDuplicate = true;
            } catch (err) { console.error("DB Check failed", err); }

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

            const reply = await interaction.reply({ 
                embeds: [createPreviewEmbed(tail, type, livery, photo.url, isDuplicate)], 
                components: [row],
                ephemeral: true,
                fetchReply: true 
            });

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
                        const newTail = submission.fields.getTextInputValue('m_tail');
                        tail = newTail.trim() === '' ? 'UNKNOWN' : newTail;
                        type = submission.fields.getTextInputValue('m_type');
                        livery = submission.fields.getTextInputValue('m_livery');

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
                    const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);

                    if (!adminChannel || !feedChannel) return i.update({ content: '❌ Channel configuration error.', components: [] });

                    // 1. Post to PUBLIC FEED
                    const publicEmbed = new EmbedBuilder()
                        .setTitle('📸 New Aircraft Spotted! (Pending Review)')
                        .setColor(0xFFFF00) // Yellow for Pending
                        .setDescription(`A user has submitted a new photo! Status: **Under Review**`)
                        .addFields(
                            { name: 'Aircraft', value: type, inline: true },
                            { name: 'Livery', value: livery, inline: true },
                            { name: 'Tail Number', value: tail.toUpperCase(), inline: true },
                            { name: 'Spotted By', value: `<@${interaction.user.id}>`, inline: false }
                        )
                        .setImage(photo.url)
                        .setFooter({ text: 'Submissions are reviewed by admins before database entry.' })
                        .setTimestamp();

                    const publicMsg = await feedChannel.send({ embeds: [publicEmbed] });

                    // 2. Post to ADMIN CHANNEL
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
                    }
                    
                    finalEmbed.setFooter({ text: `Pending | User: ${interaction.user.id} | Msg: ${publicMsg.id}` });

                    const adminRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`approve_${interaction.user.id}`).setLabel('Approve & Verify').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`reject_${interaction.user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
                        );

                    await adminChannel.send({ embeds: [finalEmbed], components: [adminRow] });
                    await i.update({ content: '✅ Submission posted to feed (pending) and sent to admins!', embeds: [], components: [] });
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
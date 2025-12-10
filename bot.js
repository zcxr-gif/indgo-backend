// bot.js
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');

// We export a function that takes the Mongoose Model as an argument.
// This allows the bot to search the DB defined in server.js.
const startDiscordBot = (CommunityAircraftModel) => {

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    // 1. Define Slash Commands
    const commands = [
        {
            name: 'lookup',
            description: 'Find an aircraft by Tail Number or Livery',
            options: [
                {
                    name: 'query',
                    type: 3, // STRING type
                    description: 'Tail Number or Livery Name',
                    required: true,
                },
            ],
        },
        {
            name: 'stats',
            description: 'View database statistics',
        }
    ];

    // 2. Initialize Bot
    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);

        // Register Slash Commands
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

    // 3. Handle Interactions
    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;

        // COMMAND: /lookup
        if (interaction.commandName === 'lookup') {
            const query = interaction.options.getString('query');
            await interaction.deferReply(); 

            try {
                // Search MongoDB using the injected Model
                const result = await CommunityAircraftModel.findOne({
                    $or: [
                        { tailNumber: { $regex: query, $options: 'i' } },
                        { liveryName: { $regex: query, $options: 'i' } }
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

        // COMMAND: /stats
        if (interaction.commandName === 'stats') {
            try {
                const count = await CommunityAircraftModel.countDocuments();
                await interaction.reply(`📊 **System Stats**\nTotal Aircraft Tracked: **${count}**`);
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
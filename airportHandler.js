// airportHandler.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType } = require('discord.js');
const axios = require('axios');

const AIRPORT_ADMIN_CHANNEL_ID = '1463636133685628989';
const BASE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api';

const startAirportSubmissionFlow = async (source, rawIcao, photoUrl, user) => {
    let currentIcao = rawIcao.toUpperCase().trim();
    
    const createPreviewEmbed = (icao) => {
        return new EmbedBuilder()
            .setTitle('📝 Review Airport Submission')
            .setColor(0x00FF99)
            .setDescription(`Confirming details for **${icao}**.`)
            .addFields({ name: 'Airport ICAO', value: icao, inline: true })
            .setFooter({ text: 'Ensure the photo clearly shows the airport/terminal.' });
    };

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_airport').setLabel('Confirm & Submit').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('edit_airport').setLabel('Edit ICAO').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('discard_airport').setLabel('Discard').setStyle(ButtonStyle.Danger)
    );

    const payload = { 
        embeds: [createPreviewEmbed(currentIcao)], 
        components: [row],
        files: [{ attachment: photoUrl, name: 'airport_preview.webp' }] 
    };

    let reply;
    if (source.deferred || source.replied) reply = await source.editReply(payload);
    else reply = await source.reply({ ...payload, fetchReply: true });

    const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

    collector.on('collect', async i => {
        if (i.user.id !== user.id) return i.reply({ content: "Not your submission.", ephemeral: true });

        if (i.customId === 'confirm_airport') {
            await i.deferUpdate();
            const adminChannel = await i.client.channels.fetch(AIRPORT_ADMIN_CHANNEL_ID);

            const adminEmbed = new EmbedBuilder()
                .setTitle('🏢 New Airport Submission')
                .setColor(0x0099FF)
                .addFields(
                    { name: 'ICAO', value: currentIcao, inline: true },
                    { name: 'Contributor', value: `<@${user.id}>`, inline: true }
                )
                .setFooter({ text: `User ID: ${user.id} | ICAO: ${currentIcao}` })
                .setTimestamp();

            const adminRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`approve_airport_${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`reject_airport_${user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
            );

            await adminChannel.send({ 
                embeds: [adminEmbed], 
                components: [adminRow], 
                files: [{ attachment: photoUrl, name: 'airport.webp' }] 
            });

            await i.editReply({ content: '✅ Airport sent for review!', embeds: [], components: [], files: [] });
            collector.stop();
        }

        if (i.customId === 'edit_airport') {
            const modal = new ModalBuilder().setCustomId('edit_icao_modal').setTitle('Edit ICAO');
            const input = new TextInputBuilder()
                .setCustomId('new_icao')
                .setLabel("Airport ICAO")
                .setValue(currentIcao)
                .setStyle(TextInputStyle.Short);
            
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await i.showModal(modal);

            try {
                const sub = await i.awaitModalSubmit({ time: 60000 });
                currentIcao = sub.fields.getTextInputValue('new_icao').toUpperCase();
                await sub.update({ embeds: [createPreviewEmbed(currentIcao)] });
            } catch (e) {}
        }

        if (i.customId === 'discard_airport') {
            await i.update({ content: '🗑️ Discarded.', embeds: [], components: [], files: [] });
            collector.stop();
        }
    });
};

module.exports = { startAirportSubmissionFlow };
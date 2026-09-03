import { EmbedBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
	name: "ping",
	description: "Verifica a latência do bot.",
	category: CommandCategory.UTILITY,
	showOnHelp: true,

	async executeAsSlash(interaction, _client) {
		await interaction.deferReply();
		const sent = await interaction.editReply({ content: "Calculando..." });
		const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
		await interaction.editReply({
			content: "",
			embeds: [buildEmbed(roundtrip, interaction.client.ws.ping)],
		});
	},

	async executeAsPrefix(message) {
		const sent = await message.reply({ content: "Calculando..." });
		const roundtrip = sent.createdTimestamp - message.createdTimestamp;
		await sent.edit({
			content: "",
			embeds: [buildEmbed(roundtrip, message.client.ws.ping)],
		});
	},
});

function buildEmbed(roundtrip: number, ws: number): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("🏓 Pong!")
		.addFields(
			{ name: "Ida e volta", value: `${roundtrip}ms`, inline: true },
			{ name: "WebSocket", value: `${ws}ms`, inline: true },
		);
}

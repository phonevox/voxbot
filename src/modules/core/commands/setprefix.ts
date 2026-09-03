import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import {
	invalidatePrefixCache,
	updateGuildPrefix,
} from "../../../database/guildRepository";

export default defineCommand({
	name: "setprefix",
	description: "Define meu prefixo neste servidor!",
	category: CommandCategory.UTILITY,
	showOnHelp: true,
	adminOnly: true,

	options: new SlashCommandBuilder()
		.addStringOption((opt) =>
			opt
				.setName("prefix")
				.setDescription("Novo prefixo")
				.setRequired(true)
				.setMaxLength(5),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	async executeAsSlash(interaction, _client) {
		if (!interaction.guild) {
			await interaction.reply({
				content: "Só funciona em servidores!",
				ephemeral: true,
			});
			return;
		}

		const newPrefix = interaction.options.getString("prefix", true).trim();
		if (!/^[^\s]{1,5}$/.test(newPrefix)) {
			await interaction.reply({
				content: "❌ Prefixo inválido (1-5 caracteres, sem espaços).",
				ephemeral: true,
			});
			return;
		}

		await updateGuildPrefix(interaction.guild.id, newPrefix);
		invalidatePrefixCache(interaction.guild.id);
		await interaction.reply({
			content: `✅ Prefixo atualizado para \`${newPrefix}\``,
		});
	},

	async executeAsPrefix(message, args, _client) {
		if (!message.guild) {
			await message.reply("Só funciona em servidores!");
			return;
		}

		const newPrefix = args.getString("prefix")?.trim();
		if (!newPrefix || !/^[^\s]{1,5}$/.test(newPrefix)) {
			await message.reply("❌ Prefixo inválido (1-5 caracteres, sem espaços).");
			return;
		}

		await updateGuildPrefix(message.guild.id, newPrefix);
		invalidatePrefixCache(message.guild.id);
		await message.reply(`✅ Prefixo atualizado para \`${newPrefix}\``);
	},
});

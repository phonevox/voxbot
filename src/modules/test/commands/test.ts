import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import type { TestContext } from "../tests/context";
import { TESTS } from "../tests/index";

const KEYWORDS = Object.keys(TESTS);

export default defineCommand({
	name: "test",
	description: "Dispara um teste de design/visual registrado por keyword.",
	category: CommandCategory.ADMIN,
	botOwnerOnly: true,
	showOnHelp: false,

	options: new SlashCommandBuilder().addStringOption((o) =>
		o
			.setName("keyword")
			.setDescription("Qual teste disparar")
			.setRequired(true)
			.addChoices(...KEYWORDS.map((k) => ({ name: k, value: k }))),
	),

	async executeAsSlash(interaction) {
		const keyword = interaction.options.getString("keyword", true);
		const test = TESTS[keyword];
		if (!test) {
			await interaction.reply({
				...EmbedFormatter.error(`Teste desconhecido: \`${keyword}\`.`),
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });
		let first = true;
		const ctx: TestContext = {
			invokerId: interaction.user.id,
			async send(reply) {
				if (first) {
					first = false;
					return interaction.editReply(reply);
				}
				return interaction.followUp({ ...reply, ephemeral: true });
			},
		};
		await test(ctx);
	},

	async executeAsPrefix(message, args) {
		const keyword = args.getString("keyword");
		if (!keyword) {
			await message.reply(
				EmbedFormatter.warn(
					`Uso: \`!test <keyword>\`. Disponíveis: ${KEYWORDS.join(", ")}.`,
				),
			);
			return;
		}

		const test = TESTS[keyword];
		if (!test) {
			await message.reply(
				EmbedFormatter.error(
					`Teste desconhecido: \`${keyword}\`. Disponíveis: ${KEYWORDS.join(", ")}.`,
				),
			);
			return;
		}

		const ctx: TestContext = {
			invokerId: message.author.id,
			async send(reply) {
				return message.reply(reply);
			},
		};
		await test(ctx);
	},
});

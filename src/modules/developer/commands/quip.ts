import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { DEFAULT_FUNNY_LEVEL, getRandomQuip, QuipTypes } from "@/utils/quips";

const TYPE_CHOICES = Object.values(QuipTypes);

function isQuipType(value: string): value is QuipTypes {
	return (TYPE_CHOICES as string[]).includes(value);
}

export default defineCommand({
	name: "quip",
	description: "Sorteia uma quip aleatória.",
	category: CommandCategory.FUN,
	showOnHelp: true,

	options: new SlashCommandBuilder()
		.addStringOption((o) =>
			o
				.setName("tipo")
				.setDescription("Tipo de quip")
				.addChoices(...TYPE_CHOICES.map((t) => ({ name: t, value: t }))),
		)
		.addIntegerOption((o) =>
			o
				.setName("funnylevel")
				.setDescription(`Nível máximo de piada (padrão: ${DEFAULT_FUNNY_LEVEL})`)
				.setMinValue(0)
				.setMaxValue(3),
		),

	async executeAsSlash(interaction) {
		const tipo = interaction.options.getString("tipo") as QuipTypes | null;
		const funnyLevel = interaction.options.getInteger("funnylevel") ?? undefined;
		await interaction.reply({ embeds: [buildEmbed(tipo, funnyLevel)] });
	},

	async executeAsPrefix(message, args) {
		const rawTipo = args.getString("tipo");
		const tipo = rawTipo && isQuipType(rawTipo) ? rawTipo : null;
		const funnyLevel = args.getNumber("funnylevel") ?? undefined;
		await message.reply({ embeds: [buildEmbed(tipo, funnyLevel)] });
	},
});

function randomType(): QuipTypes {
	return TYPE_CHOICES[Math.floor(Math.random() * TYPE_CHOICES.length)];
}

function buildEmbed(tipo: QuipTypes | null, funnyLevel: number | undefined) {
	const resolvedType = tipo ?? randomType();
	return EmbedFormatter.info(getRandomQuip(resolvedType, funnyLevel ?? DEFAULT_FUNNY_LEVEL)).setFooter({
		text: `tipo: ${resolvedType}`,
	});
}

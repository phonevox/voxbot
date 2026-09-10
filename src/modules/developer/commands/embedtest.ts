import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply } from "@/utils/format";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";

const TYPES = ["error", "warn", "success", "info"] as const;
type SampleType = (typeof TYPES)[number];

function isSampleType(value: string): value is SampleType {
	return (TYPES as readonly string[]).includes(value);
}

const DEFAULT_MSG: Record<SampleType, string> = {
	error: "Isso é um erro de exemplo.",
	warn: "Isso é um aviso de exemplo.",
	success: "Isso é um sucesso de exemplo.",
	info: "Isso é uma informação de exemplo.",
};

function buildSample(tipo: SampleType, msg: string | null): FormattedReply {
	return EmbedFormatter[tipo](msg?.trim() || DEFAULT_MSG[tipo]);
}

function allSamples(): FormattedReply[] {
	return TYPES.map((t) => buildSample(t, null));
}

// Testa @/utils/pagination junto (usado por !help e !zabbix detalhes) - páginas fake, só texto.
const PAGINATION_PAGES = 5;

function renderPaginationSample(page: number, interactive: boolean) {
	const { flags, components } = EmbedFormatter.plain(
		`Conteúdo de exemplo da página **${page + 1}**.\n-# Página ${page + 1} de ${PAGINATION_PAGES}`,
	);
	return {
		flags,
		components: interactive
			? [...components, buildPaginationRow(page, PAGINATION_PAGES)]
			: components,
	};
}

export default defineCommand({
	name: "embedtest",
	description:
		"Manda um exemplo de uma (ou todas) variante(s) do EmbedFormatter, pra conferir o visual.",
	category: CommandCategory.ADMIN,
	botOwnerOnly: true,
	showOnHelp: false,

	options: new SlashCommandBuilder()
		.addStringOption((o) =>
			o
				.setName("tipo")
				.setDescription("Qual variante mostrar (deixe vazio pra ver todas)")
				.addChoices(...TYPES.map((t) => ({ name: t, value: t })), {
					name: "pagination",
					value: "pagination",
				}),
		)
		.addStringOption((o) =>
			o
				.setName("msg")
				.setDescription(
					"Mensagem de exemplo (padrão: texto genérico, ignorado em pagination)",
				),
		),

	async executeAsSlash(interaction) {
		const tipoRaw = interaction.options.getString("tipo");
		const msg = interaction.options.getString("msg");

		if (!tipoRaw) {
			const samples = allSamples();
			await interaction.reply({ ...samples[0], ephemeral: true });
			for (const sample of samples.slice(1)) {
				await interaction.followUp({ ...sample, ephemeral: true });
			}
			return;
		}

		if (tipoRaw === "pagination") {
			await interaction.deferReply({ ephemeral: true });
			const sent = await interaction.editReply(renderPaginationSample(0, true));
			attachPagination(sent, {
				invokerId: interaction.user.id,
				pages: PAGINATION_PAGES,
				render: renderPaginationSample,
			});
			return;
		}

		// Garantido válido pelas .addChoices() do builder - não precisa revalidar aqui.
		await interaction.reply({
			...buildSample(tipoRaw as SampleType, msg),
			ephemeral: true,
		});
	},

	async executeAsPrefix(message, args) {
		const tipoRaw = args.getString("tipo");
		const msg = args.getString("msg");

		if (!tipoRaw) {
			for (const sample of allSamples()) await message.reply(sample);
			return;
		}

		if (tipoRaw === "pagination") {
			const sent = await message.reply(renderPaginationSample(0, true));
			attachPagination(sent, {
				invokerId: message.author.id,
				pages: PAGINATION_PAGES,
				render: renderPaginationSample,
			});
			return;
		}

		if (!isSampleType(tipoRaw)) {
			await message.reply(
				EmbedFormatter.warn(
					`Tipo inválido. Use um de: ${TYPES.join(", ")}, pagination.`,
				),
			);
			return;
		}

		await message.reply(buildSample(tipoRaw, msg));
	},
});

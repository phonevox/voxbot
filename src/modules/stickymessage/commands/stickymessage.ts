import {
	type GuildBasedChannel,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { getGuildPrefix } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { channelMention, EmbedFormatter } from "@/utils/format";
import { resolveMessageSource } from "@/utils/messageSource";
import { parseHexColor, parseStickyContent } from "../present";
import * as repo from "../repository";

// TextDisplay do Components V2 (limite real: 4000 chars, ver docs/adr/0002) - a margem cobre a
// formatação (`\n`/`---`) que ainda vai processar o texto em cima disso.
const MAX_CONTENT_LENGTH = 3990;

interface ParsedStickyInput {
	channelId: string | null;
	color: number | null;
	content: string;
}

/**
 * Lê as linhas iniciais em busca de diretivas, em qualquer ordem, cada uma no máximo uma vez:
 * uma menção de canal sozinha (`<#id>`) vira o canal, uma cor hex sozinha (`#RRGGBB`, com o `#`
 * obrigatório - sem ele um texto comum de 6 caracteres viraria cor sem querer) vira a cor. Para
 * na primeira linha que não bater com nenhuma das duas - o resto é o conteúdo.
 */
function extractDirectives(raw: string): ParsedStickyInput {
	const lines = raw.split("\n");
	let channelId: string | null = null;
	let color: number | null = null;
	let i = 0;

	while (i < lines.length) {
		const trimmed = lines[i].trim();

		const channelMatch = trimmed.match(/^<#(\d+)>$/);
		if (channelMatch && channelId === null) {
			channelId = channelMatch[1];
			i++;
			continue;
		}

		if (trimmed.startsWith("#") && color === null) {
			const parsed = parseHexColor(trimmed);
			if (parsed !== null) {
				color = parsed;
				i++;
				continue;
			}
		}

		break;
	}

	return { channelId, color, content: lines.slice(i).join("\n").trim() };
}

async function resolveChannel(
	guild: NonNullable<import("discord.js").Message["guild"]>,
	channelId: string | null,
	fallback: GuildBasedChannel,
): Promise<GuildBasedChannel | null> {
	if (!channelId) return fallback;
	return (
		guild.channels.cache.get(channelId) ??
		(await guild.channels.fetch(channelId).catch(() => null))
	);
}

const USAGE = {
	add: "Uso: `!stickymessage add [#canal] [#RRGGBB]` seguido do texto. `\\n` vira quebra de linha, uma linha só com `---` vira separador.",
	edit: "Uso: `!stickymessage edit [#canal] [#RRGGBB]` - mesmo formato do `add`.",
} as const;

export default defineCommand({
	name: "stickymessage",
	description: "Mensagem que gruda no fim de um canal.",
	category: CommandCategory.UTILITY,
	showOnHelp: true,
	permissions: [PermissionFlagsBits.ManageMessages],

	options: new SlashCommandBuilder()
		.addSubcommand((s) =>
			s
				.setName("add")
				.setDescription(
					"Cria a sticky message do canal (erro se já existir uma).",
				)
				.addStringOption((o) =>
					o
						.setName("mensagem")
						.setDescription("Texto - \\n quebra linha, uma linha '---' separa")
						.setRequired(true),
				)
				.addChannelOption((o) =>
					o.setName("canal").setDescription("Canal (padrão: o atual)"),
				)
				.addStringOption((o) =>
					o.setName("cor").setDescription("Cor de destaque, ex: #5865F2"),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("edit")
				.setDescription("Atualiza a sticky message já existente do canal.")
				.addStringOption((o) =>
					o.setName("mensagem").setDescription("Novo texto").setRequired(true),
				)
				.addChannelOption((o) =>
					o.setName("canal").setDescription("Canal (padrão: o atual)"),
				)
				.addStringOption((o) =>
					o
						.setName("cor")
						.setDescription(
							"Nova cor de destaque, ex: #5865F2 (sem informar, mantém a atual)",
						),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("remove")
				.setDescription("Remove a sticky message de um canal.")
				.addChannelOption((o) =>
					o.setName("canal").setDescription("Canal (padrão: o atual)"),
				),
		)
		.addSubcommand((s) =>
			s.setName("list").setDescription("Lista as sticky messages do servidor."),
		)
		.addSubcommand((s) =>
			s
				.setName("cooldown")
				.setDescription(
					"Define o intervalo mínimo (minutos) entre reenvios, pra todo o servidor.",
				)
				.addIntegerOption((o) =>
					o
						.setName("minutos")
						.setDescription("Minutos entre reenvios")
						.setMinValue(1)
						.setRequired(true),
				),
		),

	async executeAsSlash(interaction) {
		if (!interaction.guild) {
			await interaction.reply({
				...EmbedFormatter.error("Só funciona em servidores!"),
				ephemeral: true,
			});
			return;
		}
		const guild = interaction.guild;
		const sub = interaction.options.getSubcommand(true);
		const fallback = interaction.channel as GuildBasedChannel;

		if (sub === "add" || sub === "edit") {
			const content = interaction.options
				.getString("mensagem", true)
				.slice(0, MAX_CONTENT_LENGTH);
			if (parseStickyContent(content).length === 0) {
				await interaction.reply({
					...EmbedFormatter.warn(USAGE[sub]),
					ephemeral: true,
				});
				return;
			}
			const corOpt = interaction.options.getString("cor");
			const color = corOpt ? parseHexColor(corOpt) : null;
			if (corOpt && color === null) {
				await interaction.reply({
					...EmbedFormatter.error(
						"Cor inválida - use o formato `#RRGGBB` (ex: `#5865F2`).",
					),
					ephemeral: true,
				});
				return;
			}
			const canalOpt = interaction.options.getChannel("canal");
			const channel = (
				canalOpt ? guild.channels.cache.get(canalOpt.id) : fallback
			) as GuildBasedChannel | undefined;
			if (!channel) {
				await interaction.reply({
					...EmbedFormatter.error("Canal inválido."),
					ephemeral: true,
				});
				return;
			}
			await interaction.reply({
				...(await runAddOrEdit(
					sub,
					guild.id,
					channel,
					content,
					color,
					interaction.user.id,
				)),
				ephemeral: true,
			});
			return;
		}

		if (sub === "remove") {
			const canalOpt = interaction.options.getChannel("canal");
			const channel = (
				canalOpt ? guild.channels.cache.get(canalOpt.id) : fallback
			) as GuildBasedChannel | undefined;
			if (!channel) {
				await interaction.reply({
					...EmbedFormatter.error("Canal inválido."),
					ephemeral: true,
				});
				return;
			}
			await interaction.reply({
				...(await runRemove(channel)),
				ephemeral: true,
			});
			return;
		}

		if (sub === "list") {
			await interaction.reply({
				...(await runList(guild.id)),
				ephemeral: true,
			});
			return;
		}

		if (sub === "cooldown") {
			const minutos = interaction.options.getInteger("minutos", true);
			await repo.setCooldownMinutes(guild.id, minutos);
			await interaction.reply({
				...EmbedFormatter.success(
					`Cooldown de reenvio definido pra ${minutos}min.`,
				),
				ephemeral: true,
			});
		}
	},

	async executeAsPrefix(message, args) {
		if (!message.guild) {
			await message.reply(EmbedFormatter.error("Só funciona em servidores!"));
			return;
		}
		const guild = message.guild;
		const sub = args.getSubcommand();
		const fallback = message.channel as GuildBasedChannel;

		if (sub === "add" || sub === "edit") {
			// PrefixArgs (e até `getRawArgs`) tokeniza por QUALQUER whitespace, incluindo quebra de
			// linha - perderia a quebra real do conteúdo. `resolveMessageSource` lê `message.content`
			// cru (e de brinde já resolve anexo/mensagem respondida) - ver docs/adr/0003.
			const prefix = await getGuildPrefix(guild.id);
			const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(
				`^${escapedPrefix}stickymessage\\s+${sub}\\s*`,
				"i",
			);
			const source = await resolveMessageSource(message, pattern);
			if (!source) {
				await message.reply(EmbedFormatter.warn(USAGE[sub]));
				return;
			}

			const { channelId, color, content } = extractDirectives(source);
			if (parseStickyContent(content).length === 0) {
				await message.reply(EmbedFormatter.warn(USAGE[sub]));
				return;
			}
			const channel = await resolveChannel(guild, channelId, fallback);
			if (!channel) {
				await message.reply(EmbedFormatter.error("Canal inválido."));
				return;
			}
			await message.reply(
				await runAddOrEdit(
					sub,
					guild.id,
					channel,
					content.slice(0, MAX_CONTENT_LENGTH),
					color,
					message.author.id,
				),
			);
			return;
		}

		if (sub === "remove") {
			const channelId = args.getRawArgs()[0]?.match(/^<#(\d+)>$/)?.[1] ?? null;
			const channel = await resolveChannel(guild, channelId, fallback);
			if (!channel) {
				await message.reply(EmbedFormatter.error("Canal inválido."));
				return;
			}
			await message.reply(await runRemove(channel));
			return;
		}

		if (sub === "list") {
			await message.reply(await runList(guild.id));
			return;
		}

		if (sub === "cooldown") {
			const minutos = args.getNumber("minutos");
			if (!minutos || minutos < 1) {
				await message.reply(
					EmbedFormatter.warn("Uso: `!stickymessage cooldown <minutos>`."),
				);
				return;
			}
			await repo.setCooldownMinutes(guild.id, minutos);
			await message.reply(
				EmbedFormatter.success(
					`Cooldown de reenvio definido pra ${minutos}min.`,
				),
			);
			return;
		}

		await message.reply(
			EmbedFormatter.warn(
				"Uso: `!stickymessage <add|edit|remove|list|cooldown> ...` - `!help stickymessage` pra detalhes.",
			),
		);
	},
});

async function runAddOrEdit(
	sub: "add" | "edit",
	guildId: string,
	channel: GuildBasedChannel,
	content: string,
	color: number | null,
	authorId: string,
) {
	if (sub === "add") {
		const row = await repo.add(guildId, channel.id, content, color, authorId);
		if (!row) {
			return EmbedFormatter.error(
				`${channelMention(channel.id)} já tem uma sticky - usa \`!stickymessage edit\` pra mudar o texto.`,
			);
		}
		return EmbedFormatter.success(
			`Sticky message criada em ${channelMention(channel.id)}.`,
		);
	}

	const row = await repo.edit(channel.id, content, color);
	if (!row) {
		return EmbedFormatter.error(
			`${channelMention(channel.id)} não tem sticky ainda - usa \`!stickymessage add\` pra criar.`,
		);
	}
	return EmbedFormatter.success(
		`Sticky message atualizada em ${channelMention(channel.id)}.`,
	);
}

async function runRemove(channel: GuildBasedChannel) {
	const removed = await repo.remove(channel.id);
	return removed
		? EmbedFormatter.success(
				`Sticky message removida de ${channelMention(channel.id)}.`,
			)
		: EmbedFormatter.warn(
				`${channelMention(channel.id)} não tem sticky message.`,
			);
}

async function runList(guildId: string) {
	const rows = await repo.listByGuild(guildId);
	if (rows.length === 0)
		return EmbedFormatter.info("Nenhuma sticky message configurada.");
	const lines = rows.map((r) => {
		const preview =
			r.content.length > 60 ? `${r.content.slice(0, 60)}…` : r.content;
		return `${channelMention(r.channel_id)}: ${preview}`;
	});
	return EmbedFormatter.plain(lines.join("\n"));
}

// ── Self-check (sem framework de teste no projeto - roda com `ts-node src/modules/stickymessage/commands/stickymessage.ts`) ──
if (require.main === module) {
	const assert = require("node:assert");
	assert.deepStrictEqual(
		extractDirectives("Bem vindo ao canal!"),
		{ channelId: null, color: null, content: "Bem vindo ao canal!" },
		"sem diretiva na 1ª linha -> tudo vira conteúdo",
	);
	assert.deepStrictEqual(
		extractDirectives("<#123456789012345678>\nRegras aqui"),
		{ channelId: "123456789012345678", color: null, content: "Regras aqui" },
		"1ª linha só com menção de canal -> vira o canal, resto processado normalmente",
	);
	assert.deepStrictEqual(
		extractDirectives("#5865F2\nRegras aqui"),
		{ channelId: null, color: 0x5865f2, content: "Regras aqui" },
		"1ª linha só com #RRGGBB -> vira a cor",
	);
	assert.deepStrictEqual(
		extractDirectives("<#123>\n#5865F2\nRegras aqui"),
		{ channelId: "123", color: 0x5865f2, content: "Regras aqui" },
		"canal + cor, em qualquer ordem, ambos são reconhecidos",
	);
	assert.deepStrictEqual(
		extractDirectives("#tag-nao-e-cor\nRegras aqui"),
		{ channelId: null, color: null, content: "#tag-nao-e-cor\nRegras aqui" },
		"linha com # mas que não é hex válido -> vira conteúdo normal, não quebra nada",
	);
	console.log("stickymessage: extractDirectives ok");
}

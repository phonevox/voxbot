import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	type Message,
	SlashCommandBuilder,
} from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { defineCommand } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { Logger } from "@/utils/logging";
import { config } from "../../../config";
import { getGuildPrefix } from "../../../database/guildRepository";

const logger = new Logger("core.commands.help");

const PER_PAGE = 5;

// ─── Shared builders ──────────────────────────────────────────────────────────

function buildEmbed(
	page: number,
	all: CommandDefinition[],
	pages: number,
	prefix: string,
): EmbedBuilder {
	const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("📋 Comandos")
		.setDescription(
			`Use \`/help <comando>\` ou \`${prefix}help <comando>\` para detalhes.\n​`,
		)
		.setFooter({
			text: `Página ${page + 1} de ${pages} · ${all.length} comando(s)`,
		})
		.addFields(
			slice.map((cmd) => ({
				name: `/${cmd.name}`,
				value: cmd.description,
				inline: false,
			})),
		);
}

function buildRow(
	page: number,
	pages: number,
): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId("prev")
			.setEmoji("◀️")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === 0),
		new ButtonBuilder()
			.setCustomId("next")
			.setEmoji("▶️")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === pages - 1),
	);
}

const ARG_TYPES = [3, 4, 5, 6, 7, 8, 10];
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

interface RawOption {
	name: string;
	description: string;
	type: number;
	required?: boolean;
	options?: RawOption[];
}

function formatArgList(options: RawOption[] | undefined): string {
	const args = (options ?? []).filter((o) => ARG_TYPES.includes(o.type));
	if (!args.length) return "";
	return (
		" " +
		args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")
	);
}

function formatSubcommandLine(
	cmdName: string,
	path: string[],
	sub: RawOption,
): string {
	return `\`/${cmdName} ${[...path, sub.name].join(" ")}${formatArgList(sub.options)}\` - ${sub.description}`;
}

/** Divide uma lista de linhas já unidas por newline em pedaços de campo de embed com até 1024 caracteres. */
function chunkLines(lines: string[], limit = 1024): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let length = 0;

	for (const line of lines) {
		if (current.length && length + 1 + line.length > limit) {
			chunks.push(current.join("\n"));
			current = [];
			length = 0;
		}
		current.push(line);
		length += (current.length > 1 ? 1 : 0) + line.length;
	}
	if (current.length) chunks.push(current.join("\n"));
	return chunks;
}

function addFieldChunks(
	embed: EmbedBuilder,
	name: string,
	lines: string[],
): void {
	chunkLines(lines).forEach((value, i) => {
		embed.addFields({ name: i === 0 ? name : "​", value });
	});
}

function addRestrictions(embed: EmbedBuilder, cmd: CommandDefinition): void {
	const flags: string[] = [];
	if (cmd.botOwnerOnly) flags.push("Somente desenvolvedores");
	if (cmd.adminOnly) flags.push("Somente administradores");
	if (cmd.allowedUsers?.length) flags.push("Usuários específicos");
	if (flags.length)
		embed.addFields({ name: "Restrições", value: flags.join(" · ") });
}

/**
 * View de topo pra um comando (`/help <command>`).
 * Pra um comando montado a partir de subcomandos/grupos, isso é um *resumo* - grupos
 * são listados só pelo nome (aprofunde com `/help <command> <group>`), subcomandos
 * soltos são listados por completo já que não tem mais nada pra aprofundar.
 */
function buildSummaryEmbed(
	cmd: CommandDefinition,
	topLevel: RawOption[],
): EmbedBuilder {
	const groups = topLevel.filter((o) => o.type === SUB_COMMAND_GROUP);
	const subcommands = topLevel.filter((o) => o.type === SUB_COMMAND);
	const plainArgs = topLevel.filter((o) => ARG_TYPES.includes(o.type));

	const description = groups.length
		? `${cmd.description}\n\nUse \`/help ${cmd.name} <grupo>\` para ver os subcomandos de um grupo.`
		: cmd.description;

	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`/${cmd.name}`)
		.setDescription(description);

	if (groups.length || subcommands.length) {
		const lines = [
			...groups.map(
				(g) => `\`/${cmd.name} ${g.name}\` (grupo) - ${g.description}`,
			),
			...subcommands.map((s) => formatSubcommandLine(cmd.name, [], s)),
		];
		addFieldChunks(embed, "Subcomandos", lines);
	} else if (plainArgs.length) {
		addFieldChunks(
			embed,
			"Argumentos",
			plainArgs.map(
				(a) => `\`${a.name}\`${a.required ? " \\*" : ""} - ${a.description}`,
			),
		);
	}

	addRestrictions(embed, cmd);
	return embed;
}

/** View de grupo (`/help <command> <group>`) - lista os subcomandos daquele grupo. */
function buildGroupEmbed(
	cmd: CommandDefinition,
	group: RawOption,
): EmbedBuilder {
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`/${cmd.name} ${group.name}`)
		.setDescription(group.description);

	const lines = (group.options ?? [])
		.filter((s) => s.type === SUB_COMMAND)
		.map((s) => formatSubcommandLine(cmd.name, [group.name], s));
	addFieldChunks(embed, "Subcomandos", lines);

	addRestrictions(embed, cmd);
	return embed;
}

/** View de folha (`/help <command> [group] <subcommand>`) - os argumentos de um único subcomando. */
function buildLeafEmbed(
	cmd: CommandDefinition,
	path: string[],
	leaf: RawOption,
): EmbedBuilder {
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`/${[cmd.name, ...path, leaf.name].join(" ")}`)
		.setDescription(leaf.description);

	const args = (leaf.options ?? []).filter((o) => ARG_TYPES.includes(o.type));
	if (args.length) {
		addFieldChunks(
			embed,
			"Argumentos",
			args.map(
				(a) =>
					`- \`${a.name}\`${a.required ? " (obrigatório)" : ""}\n> ${a.description}\n`,
			),
		);
	}

	addRestrictions(embed, cmd);
	return embed;
}

/**
 * Resolve `/help <command> [...path]` no embed certo.
 * `path` vem vazio pro resumo de topo, `[group]` ou `[subcommand]` um nível
 * abaixo, e `[group, subcommand]` pra uma folha dentro de um grupo.
 * Retorna `null` se `path` não resolver em nada.
 */
function buildHelpEmbed(
	cmd: CommandDefinition,
	path: string[],
): EmbedBuilder | null {
	const json = cmd.options?.toJSON() as { options?: RawOption[] } | undefined;
	const topLevel = json?.options ?? [];

	if (path.length === 0) return buildSummaryEmbed(cmd, topLevel);

	const [first, second] = path;
	const group = topLevel.find(
		(o) => o.type === SUB_COMMAND_GROUP && o.name === first,
	);
	if (group) {
		if (path.length === 1) return buildGroupEmbed(cmd, group);
		if (path.length !== 2) return null;
		const leaf = (group.options ?? []).find(
			(s) => s.type === SUB_COMMAND && s.name === second,
		);
		return leaf ? buildLeafEmbed(cmd, [first], leaf) : null;
	}

	const topSub = topLevel.find(
		(o) => o.type === SUB_COMMAND && o.name === first,
	);
	if (topSub && path.length === 1) return buildLeafEmbed(cmd, [], topSub);

	return null;
}

function getVisibleCommands(client: BotClient): CommandDefinition[] {
	return client.commands
		.getAll()
		.filter((c) => c.showOnHelp !== false)
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default defineCommand({
	name: "help",
	description: "Lista todos os comandos disponíveis.",
	category: CommandCategory.UTILITY,
	showOnHelp: false,

	options: new SlashCommandBuilder().addStringOption((opt) =>
		opt
			.setName("command")
			.setDescription("Nome do comando para ver detalhes")
			.setRequired(false),
	),

	// ── Slash ─────────────────────────────────────────────────────────────────
	async executeAsSlash(interaction, client) {
		const cmdName = interaction.options.getString("command");
		const prefix = interaction.guild
			? await getGuildPrefix(interaction.guild.id)
			: config.bot.defaultPrefix;

		// View de detalhe
		if (cmdName) {
			const [base, ...path] = cmdName.trim().toLowerCase().split(/\s+/);
			const cmd = client.commands.get(base);
			if (!cmd || !cmd.showOnHelp) {
				if (!cmd?.showOnHelp)
					logger.warn(
						`Usuário ${interaction.user.id} tentou ver comando oculto: ${cmdName}`,
					);
				await interaction.reply({
					content: `❌ Comando \`${cmdName}\` não encontrado.`,
					ephemeral: true,
				});
				return;
			}
			const embed = buildHelpEmbed(cmd, path);
			if (!embed) {
				await interaction.reply({
					content: `❌ Subcomando \`${cmdName}\` não encontrado.`,
					ephemeral: true,
				});
				return;
			}
			await interaction.reply({ embeds: [embed] });
			return;
		}

		// View de lista
		const all = getVisibleCommands(client);
		const pages = Math.ceil(all.length / PER_PAGE);

		await interaction.deferReply();
		const msg = await interaction.editReply({
			embeds: [buildEmbed(0, all, pages, prefix)],
			components: pages > 1 ? [buildRow(0, pages)] : [],
		});

		if (pages <= 1) return;

		let page = 0;
		const collector = msg.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: 60_000,
		});

		collector.on("collect", async (i) => {
			if (i.user.id !== interaction.user.id) return;
			if (i.customId === "prev" && page > 0) page--;
			if (i.customId === "next" && page < pages - 1) page++;
			await i.update({
				embeds: [buildEmbed(page, all, pages, prefix)],
				components: [buildRow(page, pages)],
			});
		});

		collector.on("end", async () => {
			await interaction.editReply({ components: [] }).catch(() => {});
		});
	},

	// ── Prefix ────────────────────────────────────────────────────────────────
	async executeAsPrefix(message, args, client) {
		const cmdName = args.getString("command");
		const prefix = message.guild
			? await getGuildPrefix(message.guild.id)
			: config.bot.defaultPrefix;

		// View de detalhe
		if (cmdName) {
			const [base, ...path] = cmdName.trim().toLowerCase().split(/\s+/);
			const cmd = client.commands.get(base);
			if (!cmd || !cmd.showOnHelp) {
				if (!cmd?.showOnHelp)
					logger.warn(
						`Usuário ${message.author.id} tentou ver comando oculto: ${cmdName}`,
					);
				await message.reply(`❌ Comando \`${cmdName}\` não encontrado.`);
				return;
			}
			const embed = buildHelpEmbed(cmd, path);
			if (!embed) {
				await message.reply(`❌ Subcomando \`${cmdName}\` não encontrado.`);
				return;
			}
			await message.reply({ embeds: [embed] });
			return;
		}

		// View de lista
		const all = getVisibleCommands(client);
		const pages = Math.ceil(all.length / PER_PAGE);

		let page = 0;
		const sent = await message.reply({
			embeds: [buildEmbed(0, all, pages, prefix)],
			components: pages > 1 ? [buildRow(0, pages)] : [],
		});

		if (pages <= 1) return;

		const collector = sent.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: 60_000,
		});

		collector.on("collect", async (i) => {
			// Só quem chamou o comando originalmente pode paginar
			if (i.user.id !== message.author.id) {
				await i.reply({
					content: "Esses botões não são seus!",
					ephemeral: true,
				});
				return;
			}
			if (i.customId === "prev" && page > 0) page--;
			if (i.customId === "next" && page < pages - 1) page++;
			await i.update({
				embeds: [buildEmbed(page, all, pages, prefix)],
				components: [buildRow(page, pages)],
			});
		});

		collector.on("end", async () => {
			await sent.edit({ components: [] }).catch(() => {});
		});
	},
});

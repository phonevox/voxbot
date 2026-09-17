import {
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
	SlashCommandBuilder,
} from "discord.js";
import { config } from "@/config";
import type { BotClient } from "@/core/BotClient";
import { getGuildPrefix } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";

const logger = new Logger("core.commands.help");

const PER_PAGE = 5;
const ACCENT = 0x5865f2;

const CATEGORY_LABEL: Record<CommandCategory, string> = {
	[CommandCategory.GENERAL]: "Geral",
	[CommandCategory.ADMIN]: "Administração",
	[CommandCategory.MODERATION]: "Moderação",
	[CommandCategory.FUN]: "Diversão",
	[CommandCategory.UTILITY]: "Utilidade",
	[CommandCategory.MUSIC]: "Música",
	[CommandCategory.ECONOMY]: "Economia",
};

function addDivider(container: ContainerBuilder): void {
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
}

/**
 * `invokeName` é `"/"` (slash) ou o prefixo do servidor (ex: `"!"`) - unifica os dois formatos:
 * `commandLabel("/", ["ixc", "buscar"])` -> "/ixc buscar", `commandLabel("!", [...])` -> "!ixc buscar".
 * É o que faz o `!help` de um comando mostrar a sintaxe de PREFIXO de verdade em vez de sempre
 * mostrar a barra, que era o principal defeito do help antigo.
 */
function commandLabel(invokeName: string, parts: string[]): string {
	return `${invokeName}${parts.join(" ")}`;
}

// ─── Lista (`/help`, `!help`) ───────────────────────────────────────────────────

function getVisibleCommands(client: BotClient): CommandDefinition[] {
	return client.commands
		.getAll()
		.filter((c) => c.showOnHelp !== false)
		.sort(
			(a, b) =>
				(a.category ?? "").localeCompare(b.category ?? "") ||
				a.name.localeCompare(b.name),
		);
}

function buildListContainer(
	page: number,
	all: CommandDefinition[],
	pages: number,
	invokeName: string,
): ContainerBuilder {
	const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
	const container = new ContainerBuilder().setAccentColor(ACCENT);

	container.addTextDisplayComponents((td) =>
		td.setContent(
			`**📋 Comandos**\n-# Use \`${invokeName}help <comando>\` para ver detalhes de um comando.`,
		),
	);

	slice.forEach((cmd) => {
		addDivider(container);
		const label = CATEGORY_LABEL[cmd.category ?? CommandCategory.GENERAL];
		container.addTextDisplayComponents((td) =>
			td.setContent(
				`-# ${label}\n**${commandLabel(invokeName, [cmd.name])}**\n${cmd.description}`,
			),
		);
	});

	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			`-# Página ${page + 1} de ${pages} · ${all.length} comando(s)`,
		),
	);

	return container;
}

function renderList(
	page: number,
	interactive: boolean,
	all: CommandDefinition[],
	pages: number,
	invokeName: string,
) {
	return {
		flags: MessageFlags.IsComponentsV2 as const,
		components: [
			buildListContainer(page, all, pages, invokeName),
			...(interactive ? [buildPaginationRow(page, pages)] : []),
		],
	};
}

// ─── Detalhe (`/help <comando> [...path]`) ──────────────────────────────────────

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

/** Opcional em modo prefixo com flags ligado vira `--nome` (a única forma que funciona sem
 * atropelar o argumento posicional guloso - ver DEV_ALLOW_ARGS_AS_FLAGS/PrefixArgs); senão cai
 * pro `[nome]` de sempre (posicional, na ordem). */
function formatArgToken(a: RawOption, useFlagHint: boolean): string {
	if (a.required) return `<${a.name}>`;
	return useFlagHint ? `[--${a.name}]` : `[${a.name}]`;
}

function formatArgList(
	options: RawOption[] | undefined,
	useFlagHint: boolean,
): string {
	const args = (options ?? []).filter((o) => ARG_TYPES.includes(o.type));
	if (!args.length) return "";
	return ` ${args.map((a) => formatArgToken(a, useFlagHint)).join(" ")}`;
}

function formatSubcommandLine(
	invokeName: string,
	cmdName: string,
	path: string[],
	sub: RawOption,
	useFlagHint: boolean,
): string {
	const label = commandLabel(invokeName, [cmdName, ...path, sub.name]);
	return `\`${label}${formatArgList(sub.options, useFlagHint)}\` - ${sub.description}`;
}

function addRestrictions(
	container: ContainerBuilder,
	cmd: CommandDefinition,
): void {
	const flags: string[] = [];
	if (cmd.botOwnerOnly) flags.push("Somente desenvolvedores");
	if (cmd.adminOnly) flags.push("Somente administradores");
	if (cmd.allowedUsers?.length) flags.push("Usuários específicos");
	if (!flags.length) return;
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(`-# 🔒 Restrições: ${flags.join(" · ")}`),
	);
}

/**
 * View de topo pra um comando (`/help <command>`).
 * Pra um comando montado a partir de subcomandos/grupos, isso é um *resumo* - grupos
 * são listados só pelo nome (aprofunde com `/help <command> <group>`), subcomandos
 * soltos são listados por completo já que não tem mais nada pra aprofundar.
 */
function buildSummaryContainer(
	cmd: CommandDefinition,
	topLevel: RawOption[],
	invokeName: string,
): ContainerBuilder {
	const groups = topLevel.filter((o) => o.type === SUB_COMMAND_GROUP);
	const subcommands = topLevel.filter((o) => o.type === SUB_COMMAND);
	const plainArgs = topLevel.filter((o) => ARG_TYPES.includes(o.type));
	const useFlagHint = invokeName !== "/" && config.bot.allowArgsAsFlags;

	const container = new ContainerBuilder().setAccentColor(ACCENT);
	const label = commandLabel(invokeName, [cmd.name]);
	const description = groups.length
		? `${cmd.description}\n-# Use \`${invokeName}help ${cmd.name} <grupo>\` para ver os subcomandos de um grupo.`
		: cmd.description;
	container.addTextDisplayComponents((td) =>
		td.setContent(`**${label}**\n${description}`),
	);

	if (groups.length || subcommands.length) {
		addDivider(container);
		const lines = [
			...groups.map(
				(g) =>
					`\`${commandLabel(invokeName, [cmd.name, g.name])}\` (grupo) - ${g.description}`,
			),
			...subcommands.map((s) =>
				formatSubcommandLine(invokeName, cmd.name, [], s, useFlagHint),
			),
		];
		container.addTextDisplayComponents((td) =>
			td.setContent(["**Subcomandos**", ...lines].join("\n")),
		);
	} else if (plainArgs.length) {
		addDivider(container);
		const lines = plainArgs.map((a) => {
			const tag = a.required ? " \\*" : useFlagHint ? ` (--${a.name})` : "";
			return `- \`${a.name}\`${tag} - ${a.description}`;
		});
		container.addTextDisplayComponents((td) =>
			td.setContent(["**Argumentos**", ...lines].join("\n")),
		);
	}

	addRestrictions(container, cmd);
	return container;
}

/** View de grupo (`/help <command> <group>`) - lista os subcomandos daquele grupo. */
function buildGroupContainer(
	cmd: CommandDefinition,
	group: RawOption,
	invokeName: string,
): ContainerBuilder {
	const useFlagHint = invokeName !== "/" && config.bot.allowArgsAsFlags;
	const container = new ContainerBuilder().setAccentColor(ACCENT);
	const label = commandLabel(invokeName, [cmd.name, group.name]);
	container.addTextDisplayComponents((td) =>
		td.setContent(`**${label}**\n${group.description}`),
	);

	const lines = (group.options ?? [])
		.filter((s) => s.type === SUB_COMMAND)
		.map((s) =>
			formatSubcommandLine(invokeName, cmd.name, [group.name], s, useFlagHint),
		);
	if (lines.length) {
		addDivider(container);
		container.addTextDisplayComponents((td) =>
			td.setContent(["**Subcomandos**", ...lines].join("\n")),
		);
	}

	addRestrictions(container, cmd);
	return container;
}

/** View de folha (`/help [group] <subcommand>`) - os argumentos de um único subcomando. */
function buildLeafContainer(
	cmd: CommandDefinition,
	path: string[],
	leaf: RawOption,
	invokeName: string,
): ContainerBuilder {
	const useFlagHint = invokeName !== "/" && config.bot.allowArgsAsFlags;
	const container = new ContainerBuilder().setAccentColor(ACCENT);
	const label = commandLabel(invokeName, [cmd.name, ...path, leaf.name]);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			`**${label}${formatArgList(leaf.options, useFlagHint)}**\n${leaf.description}`,
		),
	);

	const args = (leaf.options ?? []).filter((o) => ARG_TYPES.includes(o.type));
	if (args.length) {
		addDivider(container);
		const lines = args.map((a) => {
			const tag = a.required
				? "obrigatório"
				: useFlagHint
					? `opcional, \`--${a.name}\``
					: "opcional";
			return `- \`${a.name}\` (${tag})\n${a.description}`;
		});
		container.addTextDisplayComponents((td) =>
			td.setContent(["**Argumentos**", ...lines].join("\n")),
		);
	}

	addRestrictions(container, cmd);
	return container;
}

/**
 * Resolve `/help <command> [...path]` no container certo.
 * `path` vem vazio pro resumo de topo, `[group]` ou `[subcommand]` um nível
 * abaixo, e `[group, subcommand]` pra uma folha dentro de um grupo.
 * `invokeName` é `"/"` (slash) ou o prefixo do servidor - todo texto de uso gerado
 * aqui reflete como o comando é chamado de verdade no contexto de quem pediu o help.
 * Retorna `null` se `path` não resolver em nada.
 */
function buildHelpContainer(
	cmd: CommandDefinition,
	path: string[],
	invokeName: string,
): ContainerBuilder | null {
	const json = cmd.options?.toJSON() as { options?: RawOption[] } | undefined;
	const topLevel = json?.options ?? [];

	if (path.length === 0)
		return buildSummaryContainer(cmd, topLevel, invokeName);

	const [first, second] = path;
	const group = topLevel.find(
		(o) => o.type === SUB_COMMAND_GROUP && o.name === first,
	);
	if (group) {
		if (path.length === 1) return buildGroupContainer(cmd, group, invokeName);
		if (path.length !== 2) return null;
		const leaf = (group.options ?? []).find(
			(s) => s.type === SUB_COMMAND && s.name === second,
		);
		return leaf ? buildLeafContainer(cmd, [first], leaf, invokeName) : null;
	}

	const topSub = topLevel.find(
		(o) => o.type === SUB_COMMAND && o.name === first,
	);
	if (topSub && path.length === 1)
		return buildLeafContainer(cmd, [], topSub, invokeName);

	return null;
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
					...EmbedFormatter.error(`Comando \`${cmdName}\` não encontrado.`),
					ephemeral: true,
				});
				return;
			}
			const container = buildHelpContainer(cmd, path, "/");
			if (!container) {
				await interaction.reply({
					...EmbedFormatter.error(`Subcomando \`${cmdName}\` não encontrado.`),
					ephemeral: true,
				});
				return;
			}
			await interaction.reply({
				flags: MessageFlags.IsComponentsV2,
				components: [container],
			});
			return;
		}

		// View de lista
		const all = getVisibleCommands(client);
		const pages = Math.ceil(all.length / PER_PAGE);

		await interaction.deferReply();
		const msg = await interaction.editReply(
			renderList(0, pages > 1, all, pages, "/"),
		);

		if (pages <= 1) return;

		attachPagination(msg, {
			invokerId: interaction.user.id,
			pages,
			render: (page, interactive) =>
				renderList(page, interactive, all, pages, "/"),
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
				await message.reply(
					EmbedFormatter.error(`Comando \`${cmdName}\` não encontrado.`),
				);
				return;
			}
			const container = buildHelpContainer(cmd, path, prefix);
			if (!container) {
				await message.reply(
					EmbedFormatter.error(`Subcomando \`${cmdName}\` não encontrado.`),
				);
				return;
			}
			await message.reply({
				flags: MessageFlags.IsComponentsV2,
				components: [container],
			});
			return;
		}

		// View de lista
		const all = getVisibleCommands(client);
		const pages = Math.ceil(all.length / PER_PAGE);

		const sent = await message.reply(
			renderList(0, pages > 1, all, pages, prefix),
		);

		if (pages <= 1) return;

		attachPagination(sent, {
			invokerId: message.author.id,
			pages,
			render: (page, interactive) =>
				renderList(page, interactive, all, pages, prefix),
		});
	},
});

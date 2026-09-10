import type { Message } from "discord.js";
import { SlashCommandBuilder } from "discord.js";
import { join } from "path";
import { config } from "@/config";
import type { BotClient } from "@/core/BotClient";
import {
	getCogOrigin,
	getDclRuntimeDir,
	installCogFromSource,
	loadCog,
	reloadCog,
	unloadCog,
} from "@/core/CogLoader";
import { getGuildPrefix } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, extractCodeBlock } from "@/utils/format";
import { resolveMessageSource } from "@/utils/messageSource";

const COGS_PATH = join(__dirname, "../../");

/** `load`/`reload` de um nome que já foi carregado nesta sessão via `!dcl run` precisam achar
 * essa versão no sandbox do DCL de novo, não em `COGS_PATH` (onde talvez nem exista arquivo
 * nenhum com esse nome) - `getCogOrigin` lembra de onde cada cog realmente veio. */
function resolveBasePath(name: string): string {
	return getCogOrigin(name) ?? COGS_PATH;
}

const USAGE =
	"`!dcl status <name>`\n`!dcl load <name>`\n`!dcl unload <name>`\n`!dcl reload <name>` - liga se tava off, religa se tava on\n`!dcl list` - lista ativos/desativados\n`!dcl run` - instala/atualiza um cog a partir de um arquivo .ts anexado ou colado (só via prefixo)";

export default defineCommand({
	name: "dcl",
	description: "Dynamic Cog Loader - Manipulação de cogs em runtime",
	category: CommandCategory.ADMIN,
	botOwnerOnly: true,
	showOnHelp: false,

	options: new SlashCommandBuilder()
		.addSubcommand((s) =>
			s
				.setName("status")
				.setDescription("Mostra se um cog está carregado.")
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("load")
				.setDescription("Carrega um cog já existente em disco.")
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("unload")
				.setDescription("Descarrega um cog.")
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("reload")
				.setDescription(
					"Liga/religa um cog (se estiver off, carrega; se estiver on, descarrega e recarrega).",
				)
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s.setName("list").setDescription("Lista os cogs ativos e desativados."),
		)
		.addSubcommand((s) =>
			s
				.setName("run")
				.setDescription(
					"Instala/atualiza um cog a partir de código enviado na hora (só via prefixo).",
				),
		),

	// ── Slash ─────────────────────────────────────────────────────────────────
	async executeAsSlash(interaction, client) {
		const sub = interaction.options.getSubcommand(true);

		if (sub === "run") {
			await interaction.reply({
				...EmbedFormatter.info(
					"Esse subcomando só funciona via prefixo (`!dcl run <código>`)",
				),
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });
		try {
			const result = await runSubcommand(
				sub,
				interaction.options.getString("name"),
				client,
			);
			await interaction.editReply(EmbedFormatter.success(result));
		} catch (err) {
			await interaction.editReply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
		}
	},

	// ── Prefix ────────────────────────────────────────────────────────────────
	async executeAsPrefix(message, args, client) {
		const sub = args.getSubcommand();
		if (!sub) {
			await message.reply(EmbedFormatter.warn(USAGE));
			return;
		}

		if (sub === "run") {
			await handleRun(message, client);
			return;
		}

		try {
			const result = await runSubcommand(sub, args.getString("name"), client);
			await message.reply(EmbedFormatter.success(result));
		} catch (err) {
			await message.reply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
		}
	},
});

// ─── status/load/unload/reload/list ────────────────────────────────────────────

async function runSubcommand(
	sub: string,
	name: string | null,
	client: BotClient,
): Promise<string> {
	switch (sub) {
		case "status": {
			if (!name) throw new Error("Nome do cog é obrigatório.");
			const cog = client.cogs.get(name);
			if (!cog) {
				const disabled = config.bot.disabledCogs.includes(name);
				return `Cog \`${name}\` não está carregado${disabled ? " (:warning: `DISABLED_COGS`)" : ""}.`;
			}
			const isRuntime = getCogOrigin(name) === getDclRuntimeDir(COGS_PATH);
			const runtimeNote = isRuntime
				? "\n-# Instalado via `!dcl run` - roda só nesta sessão, some num restart do processo."
				: "";
			return `Cog \`${cog.name}\` ativo - ${cog.commands?.length ?? 0} comando(s), ${Object.keys(cog.events ?? {}).length} evento(s).${runtimeNote}`;
		}

		case "load":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await loadCog(client, resolveBasePath(name), name);
			return `Cog \`${name}\` carregado.`;

		case "unload":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await unloadCog(client, name);
			return `Cog \`${name}\` descarregado.`;

		case "reload": {
			if (!name) throw new Error("Nome do cog é obrigatório.");
			const wasLoaded = client.cogs.has(name);
			if (wasLoaded) await reloadCog(client, COGS_PATH, name);
			else await loadCog(client, resolveBasePath(name), name);
			return `Cog \`${name}\` ${wasLoaded ? "recarregado (estava ativo)" : "carregado (estava inativo)"}.`;
		}

		case "list": {
			const active = [...client.cogs.values()].map(
				(c) =>
					`- \`${c.name}\` - ${c.commands?.length ?? 0} comando(s), ${Object.keys(c.events ?? {}).length} evento(s)`,
			);
			const disabled = config.bot.disabledCogs.filter(
				(n) => !client.cogs.has(n),
			);
			const lines = [`**Ativos (${client.cogs.size}):**`, ...active];
			if (disabled.length) {
				lines.push(
					"",
					`**Desativados (\`DISABLED_COGS\`):** ${disabled.map((n) => `\`${n}\``).join(", ")}`,
				);
			}
			return lines.join("\n");
		}

		default:
			throw new Error(`Subcomando desconhecido: ${sub}`);
	}
}

// ─── run (instala a partir de código enviado) ──────────────────────────────────

async function handleRun(message: Message, client: BotClient): Promise<void> {
	const prefix = message.guild
		? await getGuildPrefix(message.guild.id)
		: config.bot.defaultPrefix;
	const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const runPrefixPattern = new RegExp(`^${escapedPrefix}dcl\\s+run\\s*`, "i");

	let source: string;
	try {
		source = await resolveMessageSource(message, runPrefixPattern);
	} catch (err) {
		await message.reply(
			EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
		);
		return;
	}

	if (!source) {
		await message.reply(
			EmbedFormatter.warn(
				"Anexe um arquivo .ts/.js com `export default defineCog({...})`, cole o código (bloco de código ou cru), ou responda a uma mensagem com um dos dois.",
			),
		);
		return;
	}

	try {
		const result = await installCogFromSource(
			client,
			COGS_PATH,
			extractCodeBlock(source),
		);
		const overwriteNote = result.overwritten
			? " - substituiu a versão que estava carregada em memória, mas o `index.ts` real em `src/modules` (se existir um com esse nome) não foi tocado."
			: "";
		await message.reply(
			EmbedFormatter.success(
				`Cog \`${result.name}\` ${result.overwritten ? "atualizado" : "instalado"} - ${result.commands} comando(s).${overwriteNote}\n-# Roda só nesta sessão do bot - reiniciar o processo esquece isso e volta ao normal.`,
			),
		);
	} catch (err) {
		await message.reply(
			EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
		);
	}
}

import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { join } from "path";
import { loadCog, reloadCog, unloadCog } from "@/core/CogLoader";
import { registerSlashCommands } from "@/core/CommandHandler";
import { getPoolStats } from "@/database/connection";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import {
	getLogLevels,
	LOG_LEVELS,
	Logger,
	type LogLevel,
	setLogLevel,
} from "@/utils/logging";
import { getEventLoopLag, getLastTickStats } from "@/utils/metrics";

const logger = new Logger("core.commands.internals");
const COGS_PATH = join(__dirname, "../../");

export default defineCommand({
	name: "bot",
	description: "Administração do bot.",
	category: CommandCategory.ADMIN,

	botOwnerOnly: true,
	showOnHelp: false,

	options: new SlashCommandBuilder()
		.addSubcommandGroup((g) =>
			g
				.setName("mod")
				.setDescription("Gerenciamento de cogs.")
				.addSubcommand((s) =>
					s
						.setName("load")
						.setDescription("Carrega um cog.")
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
						.setDescription("Reinicia um cog.")
						.addStringOption((o) =>
							o.setName("name").setDescription("Nome do cog").setRequired(true),
						),
				),
		)
		.addSubcommandGroup((g) =>
			g
				.setName("log")
				.setDescription("Controle do nível de log em tempo real.")
				.addSubcommand((s) =>
					s
						.setName("set")
						.setDescription(
							"Muda o nível mínimo do console ou do arquivo de log - sem precisar reiniciar.",
						)
						.addStringOption((o) =>
							o
								.setName("level")
								.setDescription("Nível mínimo a exibir/capturar")
								.setRequired(true)
								.addChoices(...LOG_LEVELS.map((l) => ({ name: l, value: l }))),
						)
						.addStringOption((o) =>
							o
								.setName("target")
								.setDescription("Onde aplicar (padrão: console)")
								.addChoices(
									{ name: "Console", value: "console" },
									{ name: "Arquivo (logs/combined-*.log)", value: "file" },
								),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("show")
						.setDescription(
							"Mostra os níveis de log atuais do console/arquivo.",
						),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("sync")
				.setDescription("Sincroniza os slash commands com o Discord."),
		)
		.addSubcommand((sub) =>
			sub.setName("status").setDescription("Mostra o status do bot."),
		)
		.addSubcommand((sub) =>
			sub.setName("shutdown").setDescription("Desliga o bot graciosamente."),
		),

	// ── Slash ─────────────────────────────────────────────────────────────────
	async executeAsSlash(interaction, client) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(true);
		const routeKey = group ? `${group}-${sub}` : sub;
		await interaction.deferReply({ ephemeral: true });

		try {
			const result = await runSubcommand(
				routeKey,
				{
					name: interaction.options.getString("name"),
					level: interaction.options.getString("level"),
					target: interaction.options.getString("target"),
				},
				client,
			);
			await interaction.editReply({ embeds: [successEmbed(result)] });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(err instanceof Error ? err : new Error(msg));
			await interaction.editReply({ embeds: [errorEmbed(msg)] });
		}
	},

	// ── Prefix ────────────────────────────────────────────────────────────────
	async executeAsPrefix(message, args, client) {
		const group = args.getSubcommandGroup();
		const sub = args.getSubcommand();
		if (!sub) {
			await message.reply({ embeds: [usageEmbed()] });
			return;
		}
		const routeKey = group ? `${group}-${sub}` : sub;

		try {
			const result = await runSubcommand(
				routeKey,
				{
					name: args.getString("name"),
					level: args.getString("level"),
					target: args.getString("target"),
				},
				client,
			);
			await message.reply({ embeds: [successEmbed(result)] });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(err instanceof Error ? err : new Error(msg));
			await message.reply({ embeds: [errorEmbed(msg)] });
		}
	},
});

// ─── Shared logic ─────────────────────────────────────────────────────────────

interface SubcommandArgs {
	name: string | null;
	level: string | null;
	target: string | null;
}

async function runSubcommand(
	sub: string,
	{ name, level, target }: SubcommandArgs,
	client: import("@/core/BotClient").BotClient,
): Promise<string> {
	switch (sub) {
		case "mod-load":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await loadCog(client, COGS_PATH, name);
			return `Cog \`${name}\` carregado.`;

		case "mod-unload":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await unloadCog(client, name);
			return `Cog \`${name}\` descarregado.`;

		case "mod-reload":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await reloadCog(client, COGS_PATH, name);
			return `Cog \`${name}\` reiniciado.`;

		case "log-set": {
			if (!level || !(LOG_LEVELS as readonly string[]).includes(level)) {
				throw new Error(
					`O nível deve ser um dos seguintes: ${LOG_LEVELS.join(", ")}`,
				);
			}
			const resolvedTarget = target === "file" ? "file" : "console";
			setLogLevel(resolvedTarget, level as LogLevel);
			return `Nível de log de **${resolvedTarget}** definido para \`${level}\` (voltará ao normal na próxima inicialização).`;
		}

		case "log-show": {
			const levels = getLogLevels();
			return `**Console:** \`${levels.console}\`\n**Arquivo (logs/combined-*.log):** \`${levels.file}\``;
		}

		case "sync": {
			const guildId =
				process.env.NODE_ENV === "development"
					? process.env.DEV_GUILD_ID
					: undefined;
			await registerSlashCommands(client, guildId);
			return `Árvore de slash commands sincronizada (${client.commands.size} comando(s)).`;
		}

		case "status": {
			const mem = process.memoryUsage();
			const pool = getPoolStats();
			const eventLoop = getEventLoopLag();
			const lastTick = getLastTickStats();

			const lines = [
				`**Tempo ativo:** ${formatUptime(process.uptime())}`,
				`**Cogs:** ${client.cogs.size}`,
				`**Comandos:** ${client.commands.size}`,
				`**Servidores:** ${client.guilds.cache.size}`,
				`**Ping:** ${client.ws.ping}ms`,
				`**Memória:** ${formatMb(mem.rss)} RSS, ${formatMb(mem.heapUsed)}/${formatMb(mem.heapTotal)} heap`,
				"",
				`- Pool do BD: ${pool.total} total, ${pool.idle} ociosas, ${pool.waiting} aguardando${pool.waiting > 0 ? " ⚠️" : ""}`,
				`- Lag do event loop: ${eventLoop.meanMs}ms média, ${eventLoop.maxMs}ms máx${eventLoop.maxMs > 100 ? " ⚠️" : ""}`,
				lastTick
					? `- Última varredura de atividade: ${lastTick.durationMs}ms para ${lastTick.userCount} usuário(s), <t:${Math.floor(lastTick.ranAt.getTime() / 1000)}:R>`
					: "- Última varredura de atividade: nenhuma ainda",
			];
			return lines.join("\n");
		}

		case "shutdown":
			setTimeout(() => process.emit("SIGTERM"), 500);
			return "Desligando... 👋";

		default:
			throw new Error(`Subcomando desconhecido: ${sub}`);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usageEmbed(): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("🤖 Administração do Bot")
		.addFields([
			{
				name: "Gerenciamento de cogs",
				value:
					"`!bot mod load <name>`\n`!bot mod unload <name>`\n`!bot mod reload <name>`",
			},
			{
				name: "Bot",
				value:
					"`!bot sync` - sincroniza slash commands\n`!bot status` - informações do bot\n`!bot shutdown` - desligamento gracioso",
			},
			{
				name: "Logs",
				value:
					"`!bot log set <level> [target]` - muda o nível de log do console/arquivo (só em tempo real)\n`!bot log show` - mostra os níveis atuais",
			},
		]);
}

function formatMb(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function successEmbed(msg: string): EmbedBuilder {
	return new EmbedBuilder().setColor(0x57f287).setDescription(`✅ ${msg}`);
}

function errorEmbed(msg: string): EmbedBuilder {
	return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
}

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`]
		.filter(Boolean)
		.join(" ");
}

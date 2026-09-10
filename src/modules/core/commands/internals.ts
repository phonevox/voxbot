import {
	ContainerBuilder,
	EmbedBuilder,
	MessageFlags,
	OAuth2Scopes,
	PermissionFlagsBits,
	SeparatorSpacingSize,
	SlashCommandBuilder,
} from "discord.js";
import { join } from "path";
import { config } from "@/config";
import type { BotClient } from "@/core/BotClient";
import { hotReloadBot, loadCog, reloadCog, unloadCog } from "@/core/CogLoader";
import { registerSlashCommands } from "@/core/CommandHandler";
import { getPoolStats, query } from "@/database/connection";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import {
	getLogLevels,
	LOG_LEVELS,
	Logger,
	type LogLevel,
	setLogLevel,
} from "@/utils/logging";
import {
	getEventLoopLag,
	getEventLoopLagDetail,
	getLastTickStats,
} from "@/utils/metrics";

const logger = new Logger("core.commands.internals");
const COGS_PATH = join(__dirname, "../../");

export default defineCommand({
	name: "bot",
	description: "Administração do bot.",
	category: CommandCategory.ADMIN,

	botOwnerOnly: true,
	showOnHelp: false,

	options: new SlashCommandBuilder()
		.addSubcommand((s) =>
			s
				.setName("cog-status")
				.setDescription("Mostra se um cog está carregado.")
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("cog-load")
				.setDescription("Carrega um cog.")
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("cog-unload")
				.setDescription("Descarrega um cog.")
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("cog-reload")
				.setDescription(
					"Liga/religa um cog (se estiver off, carrega; se estiver on, descarrega e recarrega).",
				)
				.addStringOption((o) =>
					o.setName("name").setDescription("Nome do cog").setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s.setName("cogs").setDescription("Lista os cogs ativos e desativados."),
		)
		.addSubcommand((s) =>
			s
				.setName("reload")
				.setDescription(
					"Hot reload do bot inteiro - pega código alterado em qualquer arquivo sem reiniciar o processo.",
				),
		)
		.addSubcommand((s) =>
			s
				.setName("slash-sync")
				.setDescription("Sincroniza os slash commands com o Discord."),
		)
		.addSubcommand((s) =>
			s.setName("status").setDescription("Mostra o status do bot."),
		)
		.addSubcommand((s) =>
			s
				.setName("uptime")
				.setDescription("Mostra há quanto tempo o processo está ativo."),
		)
		.addSubcommand((s) =>
			s.setName("shutdown").setDescription("Desliga o bot graciosamente."),
		)
		.addSubcommand((s) =>
			s
				.setName("invite")
				.setDescription(
					"Gera o link de convite do bot (com permissão de Administrador).",
				),
		)
		.addSubcommand((s) =>
			s
				.setName("commands")
				.setDescription("Lista os comandos registrados, agrupados por cog."),
		)
		.addSubcommand((s) =>
			s
				.setName("servers")
				.setDescription("Lista os servidores em que o bot está."),
		)
		.addSubcommand((s) =>
			s
				.setName("ping")
				.setDescription("Latência do WebSocket e do banco de dados."),
		)
		.addSubcommand((s) =>
			s
				.setName("memory")
				.setDescription("Detalhe de memória e CPU do processo."),
		)
		.addSubcommand((s) =>
			s.setName("db").setDescription("Detalhe do pool de conexões do banco."),
		)
		.addSubcommand((s) =>
			s
				.setName("event-loop")
				.setDescription("Detalhe do lag do event loop (percentis)."),
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
		),

	// ── Slash ─────────────────────────────────────────────────────────────────
	async executeAsSlash(interaction, client) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(true);
		const routeKey = group ? `${group}-${sub}` : sub;

		// Components V2 não convive com embed/content na mesma mensagem - resposta própria, fora
		// do pipeline genérico de string -> successEmbed usado pelo resto dos subcomandos.
		if (routeKey === "status") {
			await interaction.reply({
				flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
				components: [buildStatusContainer(client)],
			});
			return;
		}

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

		if (routeKey === "status") {
			await message.reply({
				flags: MessageFlags.IsComponentsV2,
				components: [buildStatusContainer(client)],
			});
			return;
		}

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
	client: BotClient,
): Promise<string> {
	switch (sub) {
		case "cog-status": {
			if (!name) throw new Error("Nome do cog é obrigatório.");
			const cog = client.cogs.get(name);
			if (!cog) {
				const disabled = config.bot.disabledCogs.includes(name);
				return `Cog \`${name}\` não está carregado${disabled ? " (:warning: `DISABLED_COGS`)" : ""}.`;
			}
			return `Cog \`${cog.name}\` ativo - ${cog.commands?.length ?? 0} comando(s), ${Object.keys(cog.events ?? {}).length} evento(s).`;
		}

		case "cog-load":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await loadCog(client, COGS_PATH, name);
			return `Cog \`${name}\` carregado.`;

		case "cog-unload":
			if (!name) throw new Error("Nome do cog é obrigatório.");
			await unloadCog(client, name);
			return `Cog \`${name}\` descarregado.`;

		case "cog-reload": {
			if (!name) throw new Error("Nome do cog é obrigatório.");
			const wasLoaded = client.cogs.has(name);
			if (wasLoaded) await reloadCog(client, COGS_PATH, name);
			else await loadCog(client, COGS_PATH, name);
			return `Cog \`${name}\` ${wasLoaded ? "recarregado (estava ativo)" : "carregado (estava inativo)"}.`;
		}

		case "cogs": {
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

		case "reload": {
			const failures = await hotReloadBot(client, COGS_PATH);
			const summary = `Bot recarregado: ${client.cogs.size} cog(s), ${client.commands.size} comando(s).`;
			// hotReloadBot não derruba o reload inteiro se UM cog falhar (mesma resiliência do boot) -
			// mas aqui, diferente do boot, tem alguém esperando resposta: reportar sucesso quando um
			// cog ficou pra trás seria mentir. Vira erro (❌) mesmo os outros tendo recarregado bem.
			if (failures.length) {
				throw new Error(
					`${summary}\n⚠️ Falha ao carregar: ${failures.map((f) => `\`${f.cog}\` (${f.error})`).join(", ")}`,
				);
			}
			return summary;
		}

		case "log-set": {
			if (!level || !(LOG_LEVELS as readonly string[]).includes(level)) {
				throw new Error(
					`O nível deve ser um dos seguintes: ${LOG_LEVELS.join(", ")}`,
				);
			}
			const resolvedTarget = target === "file" ? "file" : "console";
			setLogLevel(resolvedTarget, level as LogLevel);
			return `Nível de log de **${resolvedTarget}** definido para \`${level}\`\n-# Essa alteração **não** é persistente!`;
		}

		case "log-show": {
			const levels = getLogLevels();
			return `**Console:** \`${levels.console}\`\n**Arquivo:** \`${levels.file}\``;
		}

		case "slash-sync": {
			const guildId =
				process.env.NODE_ENV === "development"
					? process.env.DEV_GUILD_ID
					: undefined;
			await registerSlashCommands(client, guildId);
			return `Árvore de slash commands sincronizada (\`${client.commands.size}\` comando(s)).`;
		}

		case "uptime":
			return `Tempo ativo: ${formatUptime(process.uptime())}`;

		case "shutdown":
			setTimeout(() => process.emit("SIGTERM"), 500);
			return "Desligando... 👋";

		// Administrator porque o bot já roda com esse nível de confiança nesse servidor (guards.ts
		// já trata Administrator como a barreira "admin" daqui) - evita ter que manter uma lista de
		// permissão fina sincronizada toda vez que um cog novo pedir um escopo diferente.
		case "invite":
			return client.generateInvite({
				scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
				permissions: PermissionFlagsBits.Administrator,
			});

		case "commands": {
			const lines = [...client.cogs.values()].map(
				(c) =>
					`**${c.name}** (${c.commands?.length ?? 0}): ${
						c.commands?.map((cmd) => `\`${cmd.name}\``).join(", ") || "-"
					}`,
			);
			return [
				`**Total:** ${client.commands.size} comando(s)`,
				"",
				...lines,
			].join("\n");
		}

		case "servers": {
			const guilds = [...client.guilds.cache.values()];
			const shown = guilds
				.slice(0, 20)
				.map(
					(g) => `- **${g.name}** (\`${g.id}\`) - ${g.memberCount} membro(s)`,
				);
			const extra =
				guilds.length > 20 ? `\n... e mais ${guilds.length - 20}` : "";
			return `${[`**Total:** ${guilds.length} servidor(es)`, "", ...shown].join("\n")}${extra}`;
		}

		case "ping": {
			const dbStart = Date.now();
			await query("SELECT 1");
			const dbMs = Date.now() - dbStart;
			return `**WebSocket:** ${client.ws.ping}ms\n**Banco de dados:** ${dbMs}ms (\`SELECT 1\`)`;
		}

		case "memory": {
			const mem = process.memoryUsage();
			const cpu = process.resourceUsage();
			return [
				`**RSS:** ${formatMb(mem.rss)}`,
				`**Heap:** ${formatMb(mem.heapUsed)} / ${formatMb(mem.heapTotal)}`,
				`**External:** ${formatMb(mem.external)}`,
				`**Array buffers:** ${formatMb(mem.arrayBuffers)}`,
				`**CPU (usuário/sistema):** ${Math.round(cpu.userCPUTime / 1000)}ms / ${Math.round(cpu.systemCPUTime / 1000)}ms`,
			].join("\n");
		}

		case "db": {
			const pool = getPoolStats();
			return [
				`**Conexões:** ${pool.total} total, ${pool.idle} ociosas, ${pool.waiting} aguardando`,
				`**Config:** máx ${config.database.poolMax}, idle timeout ${config.database.poolIdleTimeout}ms`,
				`**Destino:** \`${config.database.user}@${config.database.host}:${config.database.port}/${config.database.database}\`${config.database.ssl ? " (SSL)" : ""}`,
			].join("\n");
		}

		case "event-loop": {
			const d = getEventLoopLagDetail();
			return [
				`**Média:** ${d.meanMs}ms`,
				`**Mín / Máx:** ${d.minMs}ms / ${d.maxMs}ms`,
				`**p50 / p95 / p99:** ${d.p50Ms}ms / ${d.p95Ms}ms / ${d.p99Ms}ms`,
				`**Desvio padrão:** ${d.stddevMs}ms`,
			].join("\n");
		}

		default:
			throw new Error(`Subcomando desconhecido: ${sub}`);
	}
}

// ─── Status (Components V2) ────────────────────────────────────────────────────

function addSection(container: ContainerBuilder, content: string): void {
	container.addTextDisplayComponents((td) => td.setContent(content));
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
}

function buildStatusContainer(client: BotClient): ContainerBuilder {
	const mem = process.memoryUsage();
	const pool = getPoolStats();
	const eventLoop = getEventLoopLag();
	const lastTick = getLastTickStats();

	const container = new ContainerBuilder().setAccentColor(0x5865f2);

	container.addTextDisplayComponents((td) =>
		td.setContent("## 🤖 Status do Bot"),
	);
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	addSection(
		container,
		[
			`**Tempo ativo:** ${formatUptime(process.uptime())}`,
			`**Cogs:** ${client.cogs.size}`,
			`**Comandos:** ${client.commands.size}`,
			`**Servidores:** ${client.guilds.cache.size}`,
		].join("\n"),
	);

	addSection(
		container,
		[
			`**Ping:** ${client.ws.ping}ms`,
			`**Memória:** ${formatMb(mem.rss)} RSS, ${formatMb(mem.heapUsed)}/${formatMb(mem.heapTotal)} heap`,
		].join("\n"),
	);

	container.addTextDisplayComponents((td) =>
		td.setContent(
			[
				`-# Pool do BD: ${pool.total} total, ${pool.idle} ociosas, ${pool.waiting} aguardando${pool.waiting > 0 ? " ⚠️" : ""}`,
				`-# Lag do event loop: ${eventLoop.meanMs}ms média, ${eventLoop.maxMs}ms máx${eventLoop.maxMs > 100 ? " ⚠️" : ""}`,
				lastTick
					? `-# Última varredura de atividade: ${lastTick.durationMs}ms para ${lastTick.userCount} usuário(s), <t:${Math.floor(lastTick.ranAt.getTime() / 1000)}:R>`
					: "-# Última varredura de atividade: nenhuma ainda",
			].join("\n"),
		),
	);

	return container;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usageEmbed(): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("🤖 Administração do Bot")
		.addFields([
			{
				name: "Cogs",
				value:
					"`!bot cogs` - lista ativos/desativados\n`!bot cog-status <name>`\n`!bot cog-load <name>`\n`!bot cog-unload <name>`\n`!bot cog-reload <name>` - liga se tava off, religa se tava on",
			},
			{
				name: "Bot",
				value:
					"`!bot reload` - hot reload do bot inteiro (código alterado em qualquer arquivo, sem reiniciar)\n`!bot slash-sync` - sincroniza slash commands\n`!bot status` - visão geral\n`!bot uptime` - só o tempo ativo\n`!bot invite` - link de convite\n`!bot shutdown` - desligamento gracioso",
			},
			{
				name: "Debug (detalhe de cada linha do status)",
				value:
					"`!bot commands` - comandos por cog\n`!bot servers` - lista de servidores\n`!bot ping` - WebSocket + banco\n`!bot memory` - memória/CPU detalhado\n`!bot db` - pool de conexões\n`!bot event-loop` - percentis de lag",
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

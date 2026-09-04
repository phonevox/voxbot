import { ChannelType, SlashCommandBuilder } from "discord.js";
import { config } from "@/config";
import { getOrCreateGuild, updateGuildSettings } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, roleMention } from "@/utils/format";
import { reconcile, reconcileOne } from "../jobs/reconciliation";
import { getForumChannelId } from "../repository";
import { SEVERITY_NAMES, severityName } from "../discord/severity";

/** Cargo operador e canal Forum (guilds.settings) são configuráveis em runtime - o resto
 *  (intervalos, segredos, credenciais da API) é deploy/infra e mora no .env, ver src/config/index.ts. */
export default defineCommand({
	name: "zabbix",
	description: "Administração da integração com o Zabbix.",
	category: CommandCategory.ADMIN,
	adminOnly: true,
	showOnHelp: true,

	options: new SlashCommandBuilder()
		.addSubcommandGroup((g) =>
			g
				.setName("config")
				.setDescription("Configuração da integração.")
				.addSubcommand((s) =>
					s
						.setName("cargo-operador")
						.setDescription("Define o cargo que pode rodar comandos do Zabbix nas threads.")
						.addRoleOption((o) =>
							o.setName("cargo").setDescription("Cargo dos operadores").setRequired(true),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("canal-forum")
						.setDescription("Define o canal Forum onde as threads de evento são criadas.")
						.addChannelOption((o) =>
							o
								.setName("canal")
								.setDescription("Canal Forum")
								.addChannelTypes(ChannelType.GuildForum)
								.setRequired(true),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("ping-severidade")
						.setDescription("Define (ou remove) o cargo pingado quando abre um problema dessa severidade.")
						.addStringOption((o) =>
							o
								.setName("nivel")
								.setDescription("Nível de severidade")
								.setRequired(true)
								.addChoices(...SEVERITY_NAMES.slice(0, 6).map((name, i) => ({ name, value: String(i) }))),
						)
						.addRoleOption((o) =>
							o.setName("cargo").setDescription("Cargo a pingar (deixe vazio pra remover o ping dessa severidade)"),
						),
				)
				.addSubcommand((s) => s.setName("ver").setDescription("Mostra a configuração atual.")),
		)
		.addSubcommand((sub) =>
			sub
				.setName("reconciliar")
				.setDescription("Força uma varredura de reconciliação agora.")
				.addStringOption((o) =>
					o
						.setName("evento")
						.setDescription("event_id específico pra forçar (ignora MOD_ZABBIX_RECONCILE_SINCE)"),
				),
		),

	async executeAsSlash(interaction, _client) {
		if (!interaction.guild) {
			await interaction.reply({ embeds: [EmbedFormatter.error("Só funciona em servidores!")], ephemeral: true });
			return;
		}

		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(true);

		if (group === "config" && sub === "cargo-operador") {
			const role = interaction.options.getRole("cargo", true);
			await updateGuildSettings(interaction.guild.id, { zabbix_operator_role_id: role.id });
			await interaction.reply({
				embeds: [EmbedFormatter.success(`Cargo operador definido como ${roleMention(role.id)}.`)],
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "canal-forum") {
			const canal = interaction.options.getChannel("canal", true);
			await updateGuildSettings(interaction.guild.id, { zabbix_forum_channel_id: canal.id });
			await interaction.reply({
				embeds: [EmbedFormatter.success(`Canal Forum definido como <#${canal.id}>.`)],
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "ping-severidade") {
			const nivel = Number(interaction.options.getString("nivel", true));
			const cargo = interaction.options.getRole("cargo");
			await setSeverityPing(interaction.guild.id, nivel, cargo?.id ?? null);
			await interaction.reply({
				embeds: [EmbedFormatter.success(severityPingMessage(nivel, cargo?.id ?? null))],
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "ver") {
			await interaction.reply({ embeds: [await buildConfigEmbed(interaction.guild.id)], ephemeral: true });
			return;
		}

		if (sub === "reconciliar") {
			const eventId = interaction.options.getString("evento");
			await interaction.deferReply({ ephemeral: true });

			if (eventId) {
				const message = await reconcileOne(interaction.client, eventId);
				await interaction.editReply({ embeds: [EmbedFormatter.info(message)] });
				return;
			}

			const count = await reconcile(interaction.client);
			await interaction.editReply({ embeds: [reconcileResultEmbed(count)] });
		}
	},

	async executeAsPrefix(message, args, client) {
		if (!message.guild) {
			await message.reply({ embeds: [EmbedFormatter.error("Só funciona em servidores!")] });
			return;
		}

		const group = args.getSubcommandGroup();
		const sub = args.getSubcommand();

		if (group === "config" && sub === "cargo-operador") {
			const role = await args.getRole("cargo");
			if (!role) {
				await message.reply({ embeds: [EmbedFormatter.warn("Uso: `!zabbix config cargo-operador @cargo`.")] });
				return;
			}
			await updateGuildSettings(message.guild.id, { zabbix_operator_role_id: role.id });
			await message.reply({
				embeds: [EmbedFormatter.success(`Cargo operador definido como ${roleMention(role.id)}.`)],
			});
			return;
		}

		if (group === "config" && sub === "canal-forum") {
			const canal = await args.getChannel("canal");
			if (!canal || canal.type !== ChannelType.GuildForum) {
				await message.reply({ embeds: [EmbedFormatter.warn("Uso: `!zabbix config canal-forum #canal` (precisa ser um canal Forum).")] });
				return;
			}
			await updateGuildSettings(message.guild.id, { zabbix_forum_channel_id: canal.id });
			await message.reply({ embeds: [EmbedFormatter.success(`Canal Forum definido como <#${canal.id}>.`)] });
			return;
		}

		if (group === "config" && sub === "ping-severidade") {
			const nivelRaw = args.getNumber("nivel");
			if (nivelRaw === null || nivelRaw < 0 || nivelRaw > 5) {
				await message.reply({
					embeds: [
						EmbedFormatter.warn(
							"Uso: `!zabbix config ping-severidade <0-5> [@cargo]` (sem cargo remove o ping dessa severidade).",
						),
					],
				});
				return;
			}
			const cargo = await args.getRole("cargo");
			await setSeverityPing(message.guild.id, nivelRaw, cargo?.id ?? null);
			await message.reply({ embeds: [EmbedFormatter.success(severityPingMessage(nivelRaw, cargo?.id ?? null))] });
			return;
		}

		if (group === "config" && sub === "ver") {
			await message.reply({ embeds: [await buildConfigEmbed(message.guild.id)] });
			return;
		}

		if (sub === "reconciliar") {
			const eventId = args.getString("evento");

			if (eventId) {
				const result = await reconcileOne(client, eventId);
				await message.reply({ embeds: [EmbedFormatter.info(result)] });
				return;
			}

			const count = await reconcile(client);
			await message.reply({ embeds: [reconcileResultEmbed(count)] });
		}
	},
});

/** Lê+mescla `zabbix_severity_role_ids` na mão - `updateGuildSettings` só mescla um nível, e essa chave é um objeto aninhado. */
async function setSeverityPing(guildId: string, severity: number, roleId: string | null): Promise<void> {
	const guildConfig = await getOrCreateGuild(guildId);
	const current = { ...((guildConfig.settings.zabbix_severity_role_ids as Record<string, string>) ?? {}) };
	if (roleId) current[String(severity)] = roleId;
	else delete current[String(severity)];
	await updateGuildSettings(guildId, { zabbix_severity_role_ids: current });
}

function severityPingMessage(severity: number, roleId: string | null): string {
	return roleId
		? `Ping de severidade ${severityName(severity)} definido como ${roleMention(roleId)}.`
		: `Ping de severidade ${severityName(severity)} removido.`;
}

function severityPingSummary(guildConfig: Awaited<ReturnType<typeof getOrCreateGuild>>): string {
	const map = (guildConfig.settings.zabbix_severity_role_ids as Record<string, string>) ?? {};
	const entries = Object.entries(map);
	if (entries.length === 0) return "nenhum";
	return entries.map(([sev, roleId]) => `${severityName(Number(sev))}: ${roleMention(roleId)}`).join(", ");
}

async function buildConfigEmbed(guildId: string) {
	const [guildConfig, forumChannelId] = await Promise.all([getOrCreateGuild(guildId), getForumChannelId()]);
	const operatorRoleId = guildConfig.settings.zabbix_operator_role_id as string | undefined;

	const lines = [
		`**Cargo operador:** ${operatorRoleId ? roleMention(operatorRoleId) : "não definido"}`,
		`**Canal Forum:** ${forumChannelId ? `<#${forumChannelId}>` : "não definido"}`,
		`**Ping por severidade:** ${severityPingSummary(guildConfig)}`,
		`**Reconciliação:** ${reconciliationSummary()}`,
		`**Janela de arquivamento:** ${Math.round(config.zabbix.archiveDelayMs / 3_600_000)}h`,
	];
	return EmbedFormatter.info(lines.join("\n"));
}

function reconciliationSummary(): string {
	if (config.zabbix.reconcileSince === "never") return "desativada (`MOD_ZABBIX_RECONCILE_SINCE=never`)";

	const interval = `a cada ${Math.round(config.zabbix.reconciliationIntervalMs / 60_000)}min`;
	const since =
		config.zabbix.reconcileSince === "ever"
			? "sem corte, histórico inteiro"
			: `a partir de <t:${config.zabbix.reconcileSince}:f>`;
	return `${interval}, ${since}`;
}

function reconcileResultEmbed(count: number) {
	return EmbedFormatter.success(count > 0 ? `${count} thread(s) recriada(s).` : "Nenhuma thread faltando.");
}

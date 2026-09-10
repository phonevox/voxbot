import {
	ChannelType,
	type GuildMember,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { config } from "@/config";
import {
	getOrCreateGuild,
	updateGuildSettings,
} from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, roleMention } from "@/utils/format";
import { SEVERITY_NAMES, severityName } from "../discord/severity";
import { reconcile, reconcileOne } from "../jobs/reconciliation";
import { getForumChannelId } from "../repository";

/**
 * Sem `adminOnly` no nível do comando de propósito: "!zabbix acoes"/"!zabbix detalhes" são
 * atalhos informais (ver discord/operatorCommands.ts), não subcomandos de verdade - se o comando
 * inteiro exigisse admin, o CommandHandler bloquearia esses atalhos pra qualquer operador não-admin
 * ANTES mesmo do listener informal rodar (bug real, já aconteceu). Em vez disso, cada subcomando
 * real (config/reconciliar) checa admin na mão via `requireAdmin`; um "subcomando" desconhecido
 * como "acoes" simplesmente não bate em nenhum `if` e não responde nada, deixando o listener
 * informal cuidar sozinho.
 */
function isAdmin(member: GuildMember | null): boolean {
	return member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
}

const ADMIN_ONLY_MSG = "Este comando requer permissão de administrador!";

export default defineCommand({
	name: "zabbix",
	description: "Administração da integração com o Zabbix.",
	category: CommandCategory.ADMIN,
	showOnHelp: true,

	options: new SlashCommandBuilder()
		.addSubcommandGroup((g) =>
			g
				.setName("config")
				.setDescription("Configuração da integração.")
				.addSubcommand((s) =>
					s
						.setName("cargo-operador")
						.setDescription(
							"Define o cargo que pode rodar comandos do Zabbix nas threads.",
						)
						.addRoleOption((o) =>
							o
								.setName("cargo")
								.setDescription("Cargo dos operadores")
								.setRequired(true),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("canal-forum")
						.setDescription(
							"Define o canal Forum onde as threads de evento são criadas.",
						)
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
						.setDescription(
							"Define (ou remove) o cargo pingado quando abre um problema dessa severidade.",
						)
						.addStringOption((o) =>
							o
								.setName("nivel")
								.setDescription("Nível de severidade")
								.setRequired(true)
								.addChoices(
									...SEVERITY_NAMES.slice(0, 6).map((name, i) => ({
										name,
										value: String(i),
									})),
								),
						)
						.addRoleOption((o) =>
							o
								.setName("cargo")
								.setDescription(
									"Cargo a pingar (deixe vazio pra remover o ping dessa severidade)",
								),
						),
				)
				.addSubcommand((s) =>
					s.setName("ver").setDescription("Mostra a configuração atual."),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("reconciliar")
				.setDescription("Força uma varredura de reconciliação agora.")
				.addStringOption((o) =>
					o
						.setName("evento")
						.setDescription(
							"event_id específico pra forçar (ignora MOD_ZABBIX_RECONCILE_SINCE)",
						),
				),
		),

	async executeAsSlash(interaction, _client) {
		if (!interaction.guild) {
			await interaction.reply({
				...EmbedFormatter.error("Só funciona em servidores!"),
				ephemeral: true,
			});
			return;
		}

		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(true);

		if (
			(group === "config" || sub === "reconciliar") &&
			!isAdmin(interaction.member as GuildMember | null)
		) {
			await interaction.reply({
				...EmbedFormatter.error(ADMIN_ONLY_MSG),
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "cargo-operador") {
			const role = interaction.options.getRole("cargo", true);
			await updateGuildSettings(interaction.guild.id, {
				zabbix_operator_role_id: role.id,
			});
			await interaction.reply({
				...EmbedFormatter.success(
					`Cargo operador definido como ${roleMention(role.id)}.`,
				),
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "canal-forum") {
			const canal = interaction.options.getChannel("canal", true);
			await updateGuildSettings(interaction.guild.id, {
				zabbix_forum_channel_id: canal.id,
			});
			await interaction.reply({
				...EmbedFormatter.success(`Canal Forum definido como <#${canal.id}>.`),
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "ping-severidade") {
			const nivel = Number(interaction.options.getString("nivel", true));
			const cargo = interaction.options.getRole("cargo");
			await setSeverityPing(interaction.guild.id, nivel, cargo?.id ?? null);
			await interaction.reply({
				...EmbedFormatter.success(
					severityPingMessage(nivel, cargo?.id ?? null),
				),
				ephemeral: true,
			});
			return;
		}

		if (group === "config" && sub === "ver") {
			await interaction.reply({
				...(await buildConfigEmbed(interaction.guild.id)),
				ephemeral: true,
			});
			return;
		}

		if (sub === "reconciliar") {
			const eventId = interaction.options.getString("evento");
			await interaction.deferReply({ ephemeral: true });

			if (eventId) {
				const message = await reconcileOne(interaction.client, eventId);
				await interaction.editReply(EmbedFormatter.info(message));
				return;
			}

			const count = await reconcile(interaction.client);
			await interaction.editReply(reconcileResultEmbed(count));
		}
	},

	async executeAsPrefix(message, args, client) {
		if (!message.guild) {
			await message.reply(EmbedFormatter.error("Só funciona em servidores!"));
			return;
		}

		const group = args.getSubcommandGroup();
		const sub = args.getSubcommand();

		if (
			(group === "config" || sub === "reconciliar") &&
			!isAdmin(message.member)
		) {
			await message.reply(EmbedFormatter.error(ADMIN_ONLY_MSG));
			return;
		}

		if (group === "config" && sub === "cargo-operador") {
			const role = await args.getRole("cargo");
			if (!role) {
				await message.reply(
					EmbedFormatter.warn("Uso: `!zabbix config cargo-operador @cargo`."),
				);
				return;
			}
			await updateGuildSettings(message.guild.id, {
				zabbix_operator_role_id: role.id,
			});
			await message.reply(
				EmbedFormatter.success(
					`Cargo operador definido como ${roleMention(role.id)}.`,
				),
			);
			return;
		}

		if (group === "config" && sub === "canal-forum") {
			const canal = await args.getChannel("canal");
			if (!canal || canal.type !== ChannelType.GuildForum) {
				await message.reply(
					EmbedFormatter.warn(
						"Uso: `!zabbix config canal-forum #canal` (precisa ser um canal Forum).",
					),
				);
				return;
			}
			await updateGuildSettings(message.guild.id, {
				zabbix_forum_channel_id: canal.id,
			});
			await message.reply(
				EmbedFormatter.success(`Canal Forum definido como <#${canal.id}>.`),
			);
			return;
		}

		if (group === "config" && sub === "ping-severidade") {
			const nivelRaw = args.getNumber("nivel");
			if (nivelRaw === null || nivelRaw < 0 || nivelRaw > 5) {
				await message.reply(
					EmbedFormatter.warn(
						"Uso: `!zabbix config ping-severidade <0-5> [@cargo]` (sem cargo remove o ping dessa severidade).",
					),
				);
				return;
			}
			const cargo = await args.getRole("cargo");
			await setSeverityPing(message.guild.id, nivelRaw, cargo?.id ?? null);
			await message.reply(
				EmbedFormatter.success(
					severityPingMessage(nivelRaw, cargo?.id ?? null),
				),
			);
			return;
		}

		if (group === "config" && sub === "ver") {
			await message.reply(await buildConfigEmbed(message.guild.id));
			return;
		}

		if (sub === "reconciliar") {
			const eventId = args.getString("evento");

			if (eventId) {
				const result = await reconcileOne(client, eventId);
				await message.reply(EmbedFormatter.info(result));
				return;
			}

			const count = await reconcile(client);
			await message.reply(reconcileResultEmbed(count));
		}
	},
});

/** Lê+mescla `zabbix_severity_role_ids` na mão - `updateGuildSettings` só mescla um nível, e essa chave é um objeto aninhado. */
async function setSeverityPing(
	guildId: string,
	severity: number,
	roleId: string | null,
): Promise<void> {
	const guildConfig = await getOrCreateGuild(guildId);
	const current = {
		...((guildConfig.settings.zabbix_severity_role_ids as Record<
			string,
			string
		>) ?? {}),
	};
	if (roleId) current[String(severity)] = roleId;
	else delete current[String(severity)];
	await updateGuildSettings(guildId, { zabbix_severity_role_ids: current });
}

function severityPingMessage(severity: number, roleId: string | null): string {
	return roleId
		? `Ping de severidade ${severityName(severity)} definido como ${roleMention(roleId)}.`
		: `Ping de severidade ${severityName(severity)} removido.`;
}

function severityPingSummary(
	guildConfig: Awaited<ReturnType<typeof getOrCreateGuild>>,
): string {
	const map =
		(guildConfig.settings.zabbix_severity_role_ids as Record<string, string>) ??
		{};
	const entries = Object.entries(map);
	if (entries.length === 0) return "nenhum";
	return entries
		.map(
			([sev, roleId]) => `${severityName(Number(sev))}: ${roleMention(roleId)}`,
		)
		.join(", ");
}

async function buildConfigEmbed(guildId: string) {
	const [guildConfig, forumChannelId] = await Promise.all([
		getOrCreateGuild(guildId),
		getForumChannelId(),
	]);
	const operatorRoleId = guildConfig.settings.zabbix_operator_role_id as
		| string
		| undefined;

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
	if (config.zabbix.reconcileSince === "never")
		return "desativada (`MOD_ZABBIX_RECONCILE_SINCE=never`)";

	const interval = `a cada ${Math.round(config.zabbix.reconciliationIntervalMs / 60_000)}min`;
	const since =
		config.zabbix.reconcileSince === "ever"
			? "sem corte, histórico inteiro"
			: `a partir de <t:${config.zabbix.reconcileSince}:f>`;
	return `${interval}, ${since}`;
}

function reconcileResultEmbed(count: number) {
	return EmbedFormatter.success(
		count > 0 ? `${count} thread(s) recriada(s).` : "Nenhuma thread faltando.",
	);
}

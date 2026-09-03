import { SlashCommandBuilder } from "discord.js";
import { config } from "@/config";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, userMention } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { addAuthorized, isAuthorized, removeAuthorized } from "../repository";

const logger = new Logger("autobloqueador.command");

/** Porta de `session.get(url, headers={Authorization, Content-Type})` do módulo Python original. */
async function rechecar(): Promise<string> {
	if (!config.autobloqueador.url || !config.autobloqueador.token) {
		return "Auto-Bloqueador não configurado (faltam MOD_AUTOBLOQUEADOR_URL/MOD_AUTOBLOQUEADOR_TOKEN).";
	}

	try {
		const res = await fetch(config.autobloqueador.url, {
			headers: {
				Authorization: `Bearer ${config.autobloqueador.token}`,
				"Content-Type": "application/json",
			},
		});
		const text = await res.text();

		if (res.status === 200) return "Auto-Bloqueador atualizado com sucesso.";

		logger.warn(`Erro ao atualizar: ${res.status} - ${text}`);
		return `Erro ao atualizar o Auto-Bloqueador. (${res.status})`;
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		return `Erro inesperado: ${err instanceof Error ? err.message : String(err)}`;
	}
}

export default defineCommand({
	name: "autobloqueador",
	description: "Controle do Auto-Bloqueador.",
	category: CommandCategory.ADMIN,
	showOnHelp: true,

	// Permissão é uma lista própria (banco), não cargo/permissão do Discord - checado na mão em
	// executeAsSlash/executeAsPrefix, mesmo padrão do cargo operador do zabbix.
	options: new SlashCommandBuilder()
		.addSubcommand((s) => s.setName("rechecar").setDescription("Força uma atualização do Auto-Bloqueador."))
		.addSubcommand((s) =>
			s
				.setName("autorizar")
				.setDescription("Autoriza alguém a usar este comando.")
				.addUserOption((o) => o.setName("usuario").setDescription("Quem autorizar").setRequired(true)),
		)
		.addSubcommand((s) =>
			s
				.setName("desautorizar")
				.setDescription("Remove a autorização de alguém.")
				.addUserOption((o) => o.setName("usuario").setDescription("Quem desautorizar").setRequired(true)),
		),

	async executeAsSlash(interaction, _client) {
		if (!(await isAuthorized(interaction.user.id))) {
			await interaction.reply({
				embeds: [EmbedFormatter.error("Você não tem autorização pra usar esse comando.")],
				ephemeral: true,
			});
			return;
		}

		const sub = interaction.options.getSubcommand(true);

		if (sub === "rechecar") {
			await interaction.deferReply();
			const msg = await rechecar();
			await interaction.editReply({ embeds: [EmbedFormatter.info(msg)] });
			return;
		}

		const alvo = interaction.options.getUser("usuario", true);

		if (sub === "autorizar") {
			const added = await addAuthorized(alvo.id, interaction.user.id);
			await interaction.reply({
				embeds: [
					added
						? EmbedFormatter.success(`${userMention(alvo.id)} autorizado.`)
						: EmbedFormatter.warn(`${userMention(alvo.id)} já estava autorizado.`),
				],
				ephemeral: true,
			});
			return;
		}

		if (sub === "desautorizar") {
			const removed = await removeAuthorized(alvo.id);
			await interaction.reply({
				embeds: [
					removed
						? EmbedFormatter.success(`${userMention(alvo.id)} desautorizado.`)
						: EmbedFormatter.warn(`${userMention(alvo.id)} não estava autorizado.`),
				],
				ephemeral: true,
			});
		}
	},

	async executeAsPrefix(message, args, _client) {
		if (!(await isAuthorized(message.author.id))) {
			await message.reply({ embeds: [EmbedFormatter.error("Você não tem autorização pra usar esse comando.")] });
			return;
		}

		const sub = args.getSubcommand();

		if (sub === "rechecar") {
			const msg = await rechecar();
			await message.reply({ embeds: [EmbedFormatter.info(msg)] });
			return;
		}

		if (sub === "autorizar" || sub === "desautorizar") {
			const alvo = await args.getUser("usuario");
			if (!alvo) {
				await message.reply({ embeds: [EmbedFormatter.warn(`Uso: \`!autobloqueador ${sub} @usuário\`.`)] });
				return;
			}

			if (sub === "autorizar") {
				const added = await addAuthorized(alvo.id, message.author.id);
				await message.reply({
					embeds: [
						added
							? EmbedFormatter.success(`${userMention(alvo.id)} autorizado.`)
							: EmbedFormatter.warn(`${userMention(alvo.id)} já estava autorizado.`),
					],
				});
			} else {
				const removed = await removeAuthorized(alvo.id);
				await message.reply({
					embeds: [
						removed
							? EmbedFormatter.success(`${userMention(alvo.id)} desautorizado.`)
							: EmbedFormatter.warn(`${userMention(alvo.id)} não estava autorizado.`),
					],
				});
			}
			return;
		}

		await message.reply({ embeds: [EmbedFormatter.warn("Use `rechecar`, `autorizar` ou `desautorizar`.")] });
	},
});

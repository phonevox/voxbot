import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { channelMention, EmbedFormatter, userMention } from "@/utils/format";
import {
	addGenerator,
	clearApelido,
	isGenerator,
	listApelidos,
	listGenerators,
	removeGenerator,
	setApelido,
} from "../repository";

// Limite do próprio Discord pra nome de canal - o apelido vira um, então não pode passar disso.
const MAX_APELIDO_LENGTH = 100;

// ponytail: cap simples pra nunca estourar o limite de 4096 caracteres da description do embed -
// paginação de verdade (como o /help) se algum servidor realmente precisar listar mais que isso.
const MAX_LIST_ITEMS = 40;

export default defineCommand({
	name: "tempvc",
	description: "Canais de voz temporários.",
	category: CommandCategory.UTILITY,
	showOnHelp: true,

	options: new SlashCommandBuilder()
		.addSubcommand((sub) =>
			sub
				.setName("apelido")
				.setDescription(
					"Define o nome que seus próximos canais temporários vão usar. Rode sem nome para resetar.",
				)
				.addUserOption((opt) =>
					opt
						.setName("user")
						.setDescription("De quem alterar o apelido (padrão: você mesmo). Requer Gerenciar Canais para outra pessoa."),
				)
				.addStringOption((opt) =>
					opt
						.setName("nome")
						.setDescription(
							"Nome para os próximos canais temporários (deixe em branco para resetar)",
						)
						.setMaxLength(MAX_APELIDO_LENGTH),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("gerador")
				.setDescription(
					"Marca/desmarca um canal como gerador de canais temporários.",
				)
				.addChannelOption((opt) =>
					opt
						.setName("canal")
						.setDescription("O canal de voz a marcar/desmarcar")
						.addChannelTypes(ChannelType.GuildVoice)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("geradores")
				.setDescription("Lista os canais geradores deste servidor."),
		)
		.addSubcommand((sub) =>
			sub
				.setName("apelidos")
				.setDescription("Lista os apelidos configurados neste servidor."),
		),

	async executeAsSlash(interaction, _client) {
		if (!interaction.guild) {
			await interaction.reply({
				embeds: [EmbedFormatter.error("Só funciona em servidores!")],
				ephemeral: true,
			});
			return;
		}

		const guild = interaction.guild;
		const sub = interaction.options.getSubcommand(true);
		const hasManageChannels = () =>
			interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;

		if (sub === "apelido") {
			const targetUser = interaction.options.getUser("user");
			const isSelf = !targetUser || targetUser.id === interaction.user.id;

			if (!isSelf && !hasManageChannels()) {
				await interaction.reply({
					embeds: [EmbedFormatter.error("Você precisa da permissão **Gerenciar Canais** para alterar o apelido de outra pessoa.")],
					ephemeral: true,
				});
				return;
			}

			const name = interaction.options.getString("nome")?.trim();
			const targetId = targetUser?.id ?? interaction.user.id;
			const embed = await applyApelido(guild.id, targetId, name, isSelf ? undefined : targetUser.toString());
			await interaction.reply({ embeds: [embed], ephemeral: true });
			return;
		}

		// "gerador", "geradores" e "apelidos" - não dá pra usar o
		// default_member_permissions do próprio SlashCommandBuilder (isso vale
		// pro comando inteiro, não por subcomando), então checa aqui.
		if (!hasManageChannels()) {
			await interaction.reply({
				embeds: [EmbedFormatter.error("Você precisa da permissão **Gerenciar Canais** para isso.")],
				ephemeral: true,
			});
			return;
		}

		if (sub === "geradores") {
			const embed = await buildGeneratorsEmbed(guild.id);
			await interaction.reply({ embeds: [embed], ephemeral: true });
			return;
		}

		if (sub === "apelidos") {
			const embed = await buildApelidosEmbed(guild.id);
			await interaction.reply({ embeds: [embed], ephemeral: true });
			return;
		}

		const channel = interaction.options.getChannel("canal", true);
		const embed = await toggleGenerator(guild.id, channel.id, channel.name ?? channel.id);
		await interaction.reply({ embeds: [embed], ephemeral: true });
	},

	async executeAsPrefix(message, args, _client) {
		if (!message.guild) {
			await message.reply({ embeds: [EmbedFormatter.error("Só funciona em servidores!")] });
			return;
		}

		const guild = message.guild;
		const sub = args.getSubcommand();
		const hasManageChannels = () =>
			message.member?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false;

		if (sub === "apelido") {
			const targetUser = await args.getUser("user");
			const isSelf = !targetUser || targetUser.id === message.author.id;

			if (!isSelf && !hasManageChannels()) {
				await message.reply({
					embeds: [EmbedFormatter.error("Você precisa da permissão **Gerenciar Canais** para alterar o apelido de outra pessoa.")],
				});
				return;
			}

			const name = args.getString("nome")?.trim();
			const targetId = targetUser?.id ?? message.author.id;
			const embed = await applyApelido(guild.id, targetId, name, isSelf ? undefined : targetUser.toString());
			await message.reply({ embeds: [embed] });
			return;
		}

		if (sub === "geradores" || sub === "apelidos") {
			if (!hasManageChannels()) {
				await message.reply({
					embeds: [EmbedFormatter.error("Você precisa da permissão **Gerenciar Canais** para isso.")],
				});
				return;
			}

			const embed =
				sub === "geradores" ? await buildGeneratorsEmbed(guild.id) : await buildApelidosEmbed(guild.id);
			await message.reply({ embeds: [embed] });
			return;
		}

		if (sub === "gerador") {
			if (!hasManageChannels()) {
				await message.reply({
					embeds: [EmbedFormatter.error("Você precisa da permissão **Gerenciar Canais** para isso.")],
				});
				return;
			}

			const channel = await args.getChannel("canal");
			if (!channel || channel.type !== ChannelType.GuildVoice) {
				await message.reply({ embeds: [EmbedFormatter.warn("Aponte para um canal de voz.")] });
				return;
			}

			const embed = await toggleGenerator(guild.id, channel.id, channel.name);
			await message.reply({ embeds: [embed] });
			return;
		}

		await message.reply({
			embeds: [EmbedFormatter.warn("Use `apelido`, `gerador`, `geradores` ou `apelidos`.")],
		});
	},
});

async function applyApelido(
	guildId: string,
	userId: string,
	name: string | undefined,
	targetLabel: string | undefined,
) {
	// Sempre no meio da frase (nunca no início) pra não precisar de lógica de capitalização.
	const subject = targetLabel
		? `os próximos canais temporários de ${targetLabel}`
		: "seus próximos canais temporários";

	if (!name) {
		await clearApelido(guildId, userId);
		return EmbedFormatter.success(`Resetado - ${subject} vão usar o nome padrão.`);
	}

	if (name.length > MAX_APELIDO_LENGTH) {
		return EmbedFormatter.warn(
			`Nome muito longo (${name.length}/${MAX_APELIDO_LENGTH} caracteres) - encurte e tente de novo.`,
		);
	}

	await setApelido(guildId, userId, name);
	return EmbedFormatter.success(`A partir de agora, ${subject} vão se chamar **${name}**.`);
}

async function toggleGenerator(guildId: string, channelId: string, channelName: string) {
	if (await isGenerator(channelId)) {
		await removeGenerator(channelId);
		return EmbedFormatter.success(`**${channelName}** não é mais um canal gerador.`);
	}

	await addGenerator(guildId, channelId);
	return EmbedFormatter.success(
		`**${channelName}** agora é um canal gerador - entrar nele cria um novo canal temporário.`,
	);
}

async function buildGeneratorsEmbed(guildId: string) {
	const channelIds = await listGenerators(guildId);
	if (!channelIds.length) {
		return EmbedFormatter.info("Nenhum canal gerador configurado neste servidor.");
	}

	const shown = channelIds.slice(0, MAX_LIST_ITEMS);
	const lines = shown.map((id) => `- ${channelMention(id)}`);
	if (channelIds.length > shown.length) {
		lines.push(`... e mais ${channelIds.length - shown.length}.`);
	}

	return EmbedFormatter.info(`**Canais geradores (${channelIds.length}):**\n${lines.join("\n")}`);
}

async function buildApelidosEmbed(guildId: string) {
	const rows = await listApelidos(guildId);
	if (!rows.length) {
		return EmbedFormatter.info("Nenhum apelido configurado neste servidor.");
	}

	const shown = rows.slice(0, MAX_LIST_ITEMS);
	const lines = shown.map((r) => `- ${userMention(r.user_id)} → **${r.name}**`);
	if (rows.length > shown.length) {
		lines.push(`... e mais ${rows.length - shown.length}.`);
	}

	return EmbedFormatter.info(`**Apelidos (${rows.length}):**\n${lines.join("\n")}`);
}

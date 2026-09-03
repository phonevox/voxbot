import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import type {
	ButtonComponent,
	ButtonInteraction,
	Client,
	GuildMember,
	Interaction,
	MessageActionRowComponent,
	MessageComponentInteraction,
} from "discord.js";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import * as repo from "../repository";
import {
	assumirParams,
	desreconhecerParams,
	finalizarParams,
	mensagemParams,
	reconhecerParams,
	sevParams,
} from "../zabbix/acknowledge";
import { acknowledge } from "../zabbix/client";
import { hasOperatorRole } from "./permissions";

const logger = new Logger("zabbix.buttons");

// Custom IDs codificam o event_id direto (não um lookup num Map em memória) - precisam
// sobreviver a um restart do bot, diferente do padrão de voto do biomehunt.
const ASSUMIR_PREFIX = "zbx-assumir:";
const FINALIZAR_PREFIX = "zbx-finalizar:";
const MENSAGEM_PREFIX = "zbx-mensagem:";
const SEV_PREFIX = "zbx-sev:";
const RECONHECER_PREFIX = "zbx-reconhecer:";
const DESRECONHECER_PREFIX = "zbx-desreconhecer:";
const MENSAGEM_INPUT_ID = "mensagem";

function eventIdFrom(customId: string, prefix: string): string {
	return customId.slice(prefix.length);
}

/** true = autorizado. false = já respondeu com o erro, o caller só precisa dar `return`. */
async function requireOperator(interaction: MessageComponentInteraction): Promise<boolean> {
	const member = interaction.member as GuildMember | null;
	if (await hasOperatorRole(member, interaction.guildId ?? "")) return true;

	await interaction.reply({
		embeds: [EmbedFormatter.error("Você não tem o cargo necessário pra comandos do Zabbix.")],
		ephemeral: true,
	});
	return false;
}

/**
 * Só troca a ActionRow que contém o botão clicado (o card de PROBLEM agora tem duas linhas -
 * botões e o select de severidade - então "a última linha" não é mais garantia de ser a certa).
 * Nunca reconstrói o Container inteiro.
 */
async function disableClickedButton(interaction: ButtonInteraction, label: string): Promise<void> {
	const rows = interaction.message.components;
	const rowIndex = rows.findIndex(
		(row): row is Extract<typeof row, { type: ComponentType.ActionRow }> =>
			row.type === ComponentType.ActionRow &&
			row.components.some((c) => c.type === ComponentType.Button && c.customId === interaction.customId),
	);
	if (rowIndex === -1) return;

	const targetRow = rows[rowIndex] as { components: MessageActionRowComponent[] };
	const keptButtons = targetRow.components
		.filter(
			(c): c is ButtonComponent =>
				c.type === ComponentType.Button && c.customId !== interaction.customId,
		)
		.map((c) => ButtonBuilder.from(c));

	const disabledButton = new ButtonBuilder()
		.setCustomId(`${interaction.customId}:done`)
		.setLabel(label)
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(true);

	const newRow = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton, ...keptButtons);
	const newComponents = rows.map((row, i) => (i === rowIndex ? newRow : row));
	await interaction.update({ components: newComponents });
}

async function handleAssumir(interaction: ButtonInteraction): Promise<void> {
	const eventId = eventIdFrom(interaction.customId, ASSUMIR_PREFIX);
	const event = await repo.getEvent(eventId);
	if (!event) {
		await interaction.reply({
			embeds: [EmbedFormatter.error("Esse incidente não existe mais nos meus registros.")],
			ephemeral: true,
		});
		return;
	}

	if (event.owner_discord_id) {
		await interaction.reply({
			embeds: [EmbedFormatter.warn(`Já foi assumido por <@${event.owner_discord_id}>.`)],
			ephemeral: true,
		});
		return;
	}

	const actorMention = `@${interaction.user.username}`;

	// Assumir = ack no Zabbix, mesma ação vista de dois lados.
	try {
		await acknowledge(assumirParams(eventId, actorMention));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await interaction.reply({
			embeds: [EmbedFormatter.error("Não consegui reconhecer isso no Zabbix. Tente de novo.")],
			ephemeral: true,
		});
		return;
	}

	await repo.setOwner(eventId, interaction.user.id);
	await disableClickedButton(interaction, `Assumido por ${interaction.user.username}`);
}

async function handleFinalizar(interaction: ButtonInteraction): Promise<void> {
	if (!(await requireOperator(interaction))) return;

	const eventId = eventIdFrom(interaction.customId, FINALIZAR_PREFIX);
	const actorMention = `@${interaction.user.username}`;

	try {
		await acknowledge(finalizarParams(eventId, actorMention));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await interaction.reply({
			embeds: [EmbedFormatter.error("Não consegui finalizar isso no Zabbix. Tente de novo.")],
			ephemeral: true,
		});
		return;
	}

	await disableClickedButton(interaction, `Finalizado por ${interaction.user.username}`);
}

/**
 * Reconhecer/Desreconhecer - toggle repetível, ao contrário de Assumir/Finalizar não desabilita o
 * botão clicado (o card em si é redesenhado quando o UPDATE volta como webhook).
 */
async function handleReconhecer(interaction: ButtonInteraction): Promise<void> {
	if (!(await requireOperator(interaction))) return;

	const eventId = eventIdFrom(interaction.customId, RECONHECER_PREFIX);
	const actorMention = `@${interaction.user.username}`;

	try {
		await acknowledge(reconhecerParams(eventId, actorMention));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await interaction.reply({
			embeds: [EmbedFormatter.error("Não consegui reconhecer isso no Zabbix. Tente de novo.")],
			ephemeral: true,
		});
		return;
	}

	await interaction.reply({ embeds: [EmbedFormatter.success("Evento reconhecido no Zabbix.")], ephemeral: true });
}

async function handleDesreconhecer(interaction: ButtonInteraction): Promise<void> {
	if (!(await requireOperator(interaction))) return;

	const eventId = eventIdFrom(interaction.customId, DESRECONHECER_PREFIX);
	const actorMention = `@${interaction.user.username}`;

	try {
		await acknowledge(desreconhecerParams(eventId, actorMention));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await interaction.reply({
			embeds: [EmbedFormatter.error("Não consegui remover o reconhecimento no Zabbix. Tente de novo.")],
			ephemeral: true,
		});
		return;
	}

	await interaction.reply({
		embeds: [EmbedFormatter.success("Reconhecimento removido no Zabbix.")],
		ephemeral: true,
	});
}

async function handleMensagemOpen(interaction: ButtonInteraction): Promise<void> {
	if (!(await requireOperator(interaction))) return;

	const eventId = eventIdFrom(interaction.customId, MENSAGEM_PREFIX);
	const modal = new ModalBuilder().setCustomId(`${MENSAGEM_PREFIX}${eventId}`).setTitle("Mensagem pro Zabbix");

	const input = new TextInputBuilder()
		.setCustomId(MENSAGEM_INPUT_ID)
		.setLabel("Mensagem")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(1000);

	modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
	await interaction.showModal(modal);
}

async function handleMensagemSubmit(interaction: Interaction): Promise<void> {
	if (!interaction.isModalSubmit() || !interaction.customId.startsWith(MENSAGEM_PREFIX)) return;

	const eventId = eventIdFrom(interaction.customId, MENSAGEM_PREFIX);
	const mensagem = interaction.fields.getTextInputValue(MENSAGEM_INPUT_ID);
	const actorMention = `@${interaction.user.username}`;

	try {
		await acknowledge(mensagemParams(eventId, actorMention, mensagem));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await interaction.reply({
			embeds: [EmbedFormatter.error("Não consegui mandar essa mensagem pro Zabbix. Tente de novo.")],
			ephemeral: true,
		});
		return;
	}

	await interaction.reply({ embeds: [EmbedFormatter.success("Mensagem registrada no Zabbix.")], ephemeral: true });
}

async function handleSeveridade(interaction: Interaction): Promise<void> {
	if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith(SEV_PREFIX)) return;

	if (!(await requireOperator(interaction))) return;

	const eventId = eventIdFrom(interaction.customId, SEV_PREFIX);
	const severidade = Number(interaction.values[0]);
	const actorMention = `@${interaction.user.username}`;

	try {
		await acknowledge(sevParams(eventId, actorMention, severidade, undefined));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await interaction.reply({
			embeds: [EmbedFormatter.error("Não consegui mudar a severidade no Zabbix. Tente de novo.")],
			ephemeral: true,
		});
		return;
	}

	// Não desabilita nem re-renderiza o select (severidade pode mudar de novo depois) - o card em
	// si é redesenhado quando o UPDATE volta como webhook.
	await interaction.reply({ embeds: [EmbedFormatter.success("Severidade atualizada no Zabbix.")], ephemeral: true });
}

export async function handleZabbixButtons(_client: Client, interaction: Interaction): Promise<void> {
	if (interaction.isButton()) {
		if (interaction.customId.startsWith(ASSUMIR_PREFIX)) return handleAssumir(interaction);
		if (interaction.customId.startsWith(FINALIZAR_PREFIX)) return handleFinalizar(interaction);
		if (interaction.customId.startsWith(MENSAGEM_PREFIX)) return handleMensagemOpen(interaction);
		if (interaction.customId.startsWith(RECONHECER_PREFIX)) return handleReconhecer(interaction);
		if (interaction.customId.startsWith(DESRECONHECER_PREFIX)) return handleDesreconhecer(interaction);
		return;
	}

	if (interaction.isStringSelectMenu()) {
		await handleSeveridade(interaction);
		return;
	}

	await handleMensagemSubmit(interaction);
}

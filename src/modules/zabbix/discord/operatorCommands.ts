import { EmbedBuilder } from "discord.js";
import type { Client, Message } from "discord.js";
import { config } from "@/config";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import * as repo from "../repository";
import type { ZbxEventRow } from "../types";
import { describeAckAction, finalizarParams, mensagemParams } from "../zabbix/acknowledge";
import { acknowledge, getEventDetails, getTriggerDescriptions } from "../zabbix/client";
import { isResolved } from "./textHelpers";
import { hasOperatorRole } from "./permissions";
import { clampSeverity, severityColor, severityName } from "./severity";
import { buildActionRows } from "./template";

const logger = new Logger("zabbix.operatorCommands");

/**
 * NÃO são comandos de verdade (sem slash, fora do CommandRegistry) - texto fixo, independente do
 * prefixo configurável da guild, só reconhecidos dentro de uma thread de evento.
 * Assumir/Finalizar/severidade viraram botões/select na primeira mensagem da thread (ver
 * discord/buttons.ts) - `!mensagem` voltou como atalho de texto além do botão "Mensagem" (modal),
 * a pedido do usuário, e `!finalizar [mensagem]` na mesma pegada pro botão "Finalizar" (mensagem
 * opcional - o botão não tem como digitar uma). `!zabbix acoes` reposta os botões de ação num post
 * novo, pra não precisar rolar até a primeira mensagem da thread toda vez. `!zabbix detalhes`
 * (ou só `!detalhes`, atalho sem o prefixo `zabbix`) traz o estado atual + histórico de
 * comentários direto da API.
 */
const MENSAGEM_PATTERN = /^!mensagem\b\s*(.*)$/is;
const FINALIZAR_PATTERN = /^!finalizar\b\s*(.*)$/is;
const ACOES_PATTERN = /^!zabbix\s+acoes\b/is;
const DETALHES_PATTERN = /^!zabbix\s+detalhes\b|^!detalhes\b/is;

const MAX_HISTORY_ENTRIES = 10;

async function handleMensagem(message: Message, event: ZbxEventRow, mensagem: string): Promise<void> {
	if (!message.guild) return;

	if (!(await hasOperatorRole(message.member, message.guild.id))) {
		await message.reply({
			embeds: [EmbedFormatter.error("Você não tem o cargo necessário pra comandos do Zabbix.")],
		});
		return;
	}

	if (!mensagem) {
		await message.reply({ embeds: [EmbedFormatter.warn("Uso: `!mensagem <texto>`.")] });
		return;
	}

	const actorMention = `@${message.author.username}`;

	try {
		await acknowledge(mensagemParams(event.zabbix_event_id, actorMention, mensagem));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await message.reply({ embeds: [EmbedFormatter.error("Não consegui falar com o Zabbix. Tente de novo.")] });
		return;
	}

	await message.react("✅").catch(() => {});
}

/** Atalho de texto do botão "Finalizar" - mensagem opcional, o botão não tem como digitar uma. */
async function handleFinalizarCmd(message: Message, event: ZbxEventRow, mensagem: string): Promise<void> {
	if (!message.guild) return;

	if (!(await hasOperatorRole(message.member, message.guild.id))) {
		await message.reply({
			embeds: [EmbedFormatter.error("Você não tem o cargo necessário pra comandos do Zabbix.")],
		});
		return;
	}

	const actorMention = `@${message.author.username}`;

	try {
		await acknowledge(finalizarParams(event.zabbix_event_id, actorMention, mensagem || undefined));
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await message.reply({ embeds: [EmbedFormatter.error("Não consegui finalizar isso no Zabbix. Tente de novo.")] });
		return;
	}

	await message.react("✅").catch(() => {});
}

/** Sem checagem de cargo - só reposta os botões, não executa nenhuma ação por si (cada botão checa na hora do clique). */
async function handleAcoes(message: Message, event: ZbxEventRow): Promise<void> {
	if (!message.channel.isSendable()) return;

	let ownerLabel: string | undefined;
	if (event.owner_discord_id) {
		const owner = await message.client.users.fetch(event.owner_discord_id).catch(() => null);
		ownerLabel = owner?.username ?? event.owner_discord_id;
	}

	await message.channel.send({
		content: "**Ações rápidas:**",
		components: buildActionRows(
			event.zabbix_event_id,
			event.zabbix_trigger_id,
			config.zabbix.webUrl ?? "",
			ownerLabel,
		),
	});
}

/** Sem checagem de cargo - é só leitura, não muda nada no Zabbix. */
async function handleDetalhes(message: Message, event: ZbxEventRow): Promise<void> {
	const [details, triggerDescriptions] = await Promise.all([
		getEventDetails(event.zabbix_event_id).catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			return null;
		}),
		getTriggerDescriptions([event.zabbix_trigger_id]),
	]);

	if (!details) {
		await message.reply({
			embeds: [EmbedFormatter.error("Não consegui buscar os detalhes desse evento no Zabbix.")],
		});
		return;
	}

	const severity = clampSeverity(details.severity);
	const host = details.hosts[0]?.name ?? "desconhecido";
	const description = triggerDescriptions.get(event.zabbix_trigger_id);
	const resolved = details.value === "0";

	const infoLines = [
		`**Host:** ${host}`,
		`**Severidade:** ${severityName(severity)}`,
		`**Status:** ${resolved ? "Resolvido" : details.acknowledged === "1" ? "Reconhecido" : "Aberto"}`,
		event.owner_discord_id ? `**Responsável (Discord):** <@${event.owner_discord_id}>` : "",
		isResolved(details.opdata) ? `**Dados operacionais:** ${details.opdata}` : "",
		isResolved(description) ? `**Descrição:** ${description}` : "",
		`**Aberto:** <t:${details.clock}:f>`,
		resolved && details.r_clock !== "0" ? `**Resolvido:** <t:${details.r_clock}:f>` : "",
	].filter(Boolean);

	const embed = new EmbedBuilder()
		.setColor(severityColor(severity))
		.setTitle(details.name)
		.setDescription(infoLines.join("\n"));

	const acknowledges = details.acknowledges ?? [];
	if (acknowledges.length === 0) {
		embed.addFields({ name: "Histórico", value: "Nenhum comentário/ack registrado ainda." });
	} else {
		const sorted = [...acknowledges].sort((a, b) => Number(a.clock) - Number(b.clock));
		const shown = sorted.slice(-MAX_HISTORY_ENTRIES);
		const lines = shown.map(
			(ack) => `- <t:${ack.clock}:R> (${describeAckAction(Number(ack.action))}): ${ack.message || "_sem texto_"}`,
		);
		if (sorted.length > shown.length) {
			lines.unshift(`_...${sorted.length - shown.length} entrada(s) mais antiga(s) omitida(s)_`);
		}
		embed.addFields({ name: `Histórico (${sorted.length})`, value: lines.join("\n").slice(0, 1024) });
	}

	await message.reply({ embeds: [embed] });
}

export async function handleOperatorMessage(_client: Client, message: Message): Promise<void> {
	if (message.author.bot || !message.guild) return;

	const content = message.content.trim();

	if (ACOES_PATTERN.test(content) || DETALHES_PATTERN.test(content)) {
		const event = await repo.getEventByThreadId(message.channelId);
		if (!event) {
			await message.reply({
				embeds: [EmbedFormatter.warn("Isso só funciona dentro de uma thread de incidente do Zabbix.")],
			});
			return;
		}
		if (DETALHES_PATTERN.test(content)) await handleDetalhes(message, event);
		else await handleAcoes(message, event);
		return;
	}

	const mensagemMatch = MENSAGEM_PATTERN.exec(content);
	const finalizarMatch = FINALIZAR_PATTERN.exec(content);
	if (!mensagemMatch && !finalizarMatch) return;

	// Fora de uma thread de evento, ignora em silêncio - "!mensagem"/"!finalizar" digitado numa
	// conversa qualquer não é um comando errado, é só texto normal.
	const event = await repo.getEventByThreadId(message.channelId);
	if (!event) return;

	if (mensagemMatch) await handleMensagem(message, event, mensagemMatch[1].trim());
	else if (finalizarMatch) await handleFinalizarCmd(message, event, finalizarMatch[1].trim());
}

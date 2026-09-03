import { ChannelType } from "discord.js";
import type { Client, ForumChannel } from "discord.js";
import { config } from "@/config";
import { Logger } from "@/utils/logging";
import * as repo from "../repository";
import type { EventClassification, WebhookPayload } from "../types";
import { clampSeverity, ensureSeverityTags, severityName, severityTagId } from "./severity";
import { type EventCard, buildProblemCard, buildResolvedCard, buildUpdateCard } from "./template";
import { stringTruncate } from "./textHelpers";

const logger = new Logger("zabbix.threadManager");

/** Deriva PROBLEM/UPDATE/RESOLVED do payload cru - único lugar que faz essa conta. */
export function classifyEvent(payload: WebhookPayload): EventClassification {
	const isTrigger = payload.event_source === "0";
	const isUpdate = isTrigger && payload.event_update_status === "1";
	const isRecovery = isTrigger && payload.event_value === "0" && !isUpdate;
	const isProblem = isTrigger && payload.event_value === "1" && !isUpdate;
	return { isTrigger, isUpdate, isRecovery, isProblem };
}

async function getForumChannel(client: Client): Promise<ForumChannel | null> {
	if (!config.zabbix.forumChannelId) return null;
	const channel = await client.channels.fetch(config.zabbix.forumChannelId).catch(() => null);
	if (!channel || channel.type !== ChannelType.GuildForum) return null;
	return channel;
}

function buildThreadName(payload: WebhookPayload, severity: number): string {
	return stringTruncate(`[${severityName(severity)}] ${payload.host_name} - ${payload.event_name}`, 100);
}

async function createThread(
	forumChannel: ForumChannel,
	payload: WebhookPayload,
	card: EventCard,
	severity: number,
): Promise<{ threadId: string; headMsgId: string }> {
	await ensureSeverityTags(forumChannel);
	const tagId = severityTagId(forumChannel, severity);

	const thread = await forumChannel.threads.create({
		name: buildThreadName(payload, severity),
		message: { components: card.components, flags: card.flags },
		appliedTags: tagId ? [tagId] : [],
	});

	// A mensagem inicial de uma thread de Forum tem o mesmo ID da própria thread.
	return { threadId: thread.id, headMsgId: thread.id };
}

/** true = postou. false = a thread não existe mais no Discord (deletada manualmente, por exemplo). */
async function postInExistingThread(client: Client, threadId: string, card: EventCard): Promise<boolean> {
	const thread = await client.channels.fetch(threadId).catch(() => null);
	if (!thread || !thread.isThread()) return false;

	if (thread.archived) await thread.setArchived(false).catch(() => {});
	await thread.send({ components: card.components, flags: card.flags });
	return true;
}

/**
 * Cria a thread pra um evento que o bot já conhece (ou está reivindicando agora) mas que ainda
 * não tem thread válida - path de criação tardia (UPDATE/RESOLVED sem PROBLEM prévio) e também de
 * autocorreção (thread existia mas foi deletada manualmente no Discord).
 */
async function createLate(
	client: Client,
	payload: WebhookPayload,
	classification: EventClassification,
	severity: number,
): Promise<void> {
	const claimed =
		(await repo.getEvent(payload.event_id)) ??
		(await repo.tryClaimEvent(payload.event_id, payload.trigger_id, payload.host_name, payload.host_ip, severity));
	if (!claimed) {
		logger.warn(`Corrida na criação tardia da thread do evento ${payload.event_id} - outra entrega venceu.`);
		return;
	}

	const forumChannel = await getForumChannel(client);
	if (!forumChannel) {
		logger.error(`Canal Forum do Zabbix não configurado/encontrado - evento ${payload.event_id} sem thread.`);
		return;
	}

	const card = classification.isProblem
		? buildProblemCard(payload)
		: classification.isRecovery
			? buildResolvedCard(payload)
			: buildUpdateCard(payload);

	const { threadId, headMsgId } = await createThread(forumChannel, payload, card, severity);
	await repo.setThreadCreated(payload.event_id, threadId, headMsgId);

	if (classification.isRecovery) await repo.markResolved(payload.event_id, severity);
	else await repo.updateSeverity(payload.event_id, severity);
}

/**
 * Roteia um webhook (ou uma entrada de reconciliação) de trigger pro estado certo: cria a thread
 * num PROBLEM novo, posta update/resolução numa thread existente, ou cria a thread tardiamente
 * (nunca descarta) se um UPDATE/RESOLVED chegar sem o PROBLEM original ter passado por aqui - ou
 * se a thread que existia foi deletada manualmente no Discord nesse meio tempo.
 */
export async function findOrCreateThread(
	client: Client,
	payload: WebhookPayload,
	classification: EventClassification,
): Promise<void> {
	const severity = clampSeverity(payload.event_nseverity);
	const existing = await repo.getEvent(payload.event_id);

	if (classification.isProblem && !existing) {
		await createLate(client, payload, classification, severity);
		return;
	}

	if (existing?.discord_thread_id) {
		const card = classification.isRecovery ? buildResolvedCard(payload) : buildUpdateCard(payload);
		const posted = await postInExistingThread(client, existing.discord_thread_id, card);

		if (!posted) {
			logger.warn(`Thread do evento ${payload.event_id} não existe mais no Discord - recriando.`);
			await repo.clearThread(payload.event_id);
			await createLate(client, payload, classification, severity);
			return;
		}

		if (classification.isRecovery) await repo.markResolved(payload.event_id, severity);
		else await repo.updateSeverity(payload.event_id, severity);
		return;
	}

	// UPDATE ou RESOLVED sem o PROBLEM original ter criado a thread - nunca descarta o evento,
	// cria a thread agora mesmo com o que tem disponível e loga como anomalia.
	logger.warn(
		`Evento ${payload.event_id} chegou como ${classification.isRecovery ? "RESOLVED" : "UPDATE"} sem thread existente - criando tardiamente.`,
	);
	await createLate(client, payload, classification, severity);
}

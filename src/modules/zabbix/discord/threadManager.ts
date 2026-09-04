import { ChannelType, TextDisplayBuilder } from "discord.js";
import type { Client, ForumChannel } from "discord.js";
import { Logger } from "@/utils/logging";
import * as repo from "../repository";
import type { EventClassification, WebhookPayload } from "../types";
import { RESOLVED_INDEX, clampSeverity, ensureSeverityTags, severityTagId } from "./severity";
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
	const channelId = await repo.getForumChannelId();
	if (!channelId) return null;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!channel || channel.type !== ChannelType.GuildForum) return null;
	return channel;
}

// Sem prefixo de severidade - a tag do Forum já mostra isso (ver severity.ts), duplicava no título.
function buildThreadName(payload: WebhookPayload): string {
	return stringTruncate(`${payload.host_name} - ${payload.event_name}`, 100);
}

async function createThread(
	forumChannel: ForumChannel,
	payload: WebhookPayload,
	card: EventCard,
	severity: number,
	pingRoleId: string | null,
): Promise<{ threadId: string; headMsgId: string }> {
	await ensureSeverityTags(forumChannel);
	const tagId = severityTagId(forumChannel, severity);

	// Mensagem IsComponentsV2 não aceita `content` - o ping vira um TextDisplay próprio, antes do
	// Container. `allowedMentions` explícito porque o padrão do discord.js é permissivo, mas aqui
	// só deve pingar o cargo configurado, nunca @everyone/@here que porventura apareça em algum texto.
	const components = pingRoleId
		? [new TextDisplayBuilder().setContent(`<@&${pingRoleId}>`), ...card.components]
		: card.components;

	const thread = await forumChannel.threads.create({
		name: buildThreadName(payload),
		message: {
			components,
			flags: card.flags,
			allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] },
		},
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

/** Troca a(s) tag(s) da thread pela tag RESOLVIDO, sozinha - problema fechado não é mais "ALTO"/"BAIXO" etc. */
async function tagAsResolved(client: Client, threadId: string): Promise<void> {
	const [thread, forumChannel] = await Promise.all([
		client.channels.fetch(threadId).catch(() => null),
		getForumChannel(client),
	]);
	if (!thread || !thread.isThread() || !forumChannel) return;

	await ensureSeverityTags(forumChannel);
	const tagId = severityTagId(forumChannel, RESOLVED_INDEX);
	if (!tagId) return;

	await thread.setAppliedTags([tagId]).catch((err) => {
		logger.error(err instanceof Error ? err : new Error(String(err)));
	});
}

/**
 * Cria a thread pra um evento que o bot já conhece (ou está reivindicando agora) mas que ainda
 * não tem thread válida - path de criação tardia (UPDATE sem PROBLEM prévio) e também de
 * autocorreção (thread existia mas foi deletada manualmente no Discord). RESOLVED nunca passa
 * daqui, ver guarda logo abaixo.
 */
async function createLate(
	client: Client,
	payload: WebhookPayload,
	classification: EventClassification,
	severity: number,
): Promise<void> {
	// RESOLVED nunca cria thread do zero - só faz sentido postar uma resolução numa thread que já
	// acompanhou o problema. Sem essa guarda, um RESOLVED "solto" (thread nunca criada, ou apagada
	// manualmente no Discord) geraria uma thread nova só pra já nascer fechada, o que não faz sentido.
	if (classification.isRecovery) {
		logger.warn(`Evento ${payload.event_id} chegou como RESOLVED sem thread existente - ignorado, não cria thread.`);
		return;
	}

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

	// RESOLVED nunca chega aqui (guarda acima) - só sobra PROBLEM ou UPDATE.
	const card = classification.isProblem ? buildProblemCard(payload) : buildUpdateCard(payload);

	// Só PROBLEM novo pinga - UPDATE/recriação de thread já são silenciosos (ver flags do card),
	// pingar de novo aí seria ruído.
	const pingRoleId = classification.isProblem ? await repo.getSeverityRoleId(severity) : null;

	const { threadId, headMsgId } = await createThread(forumChannel, payload, card, severity, pingRoleId);
	await repo.setThreadCreated(payload.event_id, threadId, headMsgId);
	await repo.updateSeverity(payload.event_id, severity);
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
			logger.warn(`Thread do evento ${payload.event_id} não existe mais no Discord - tentando recriar.`);
			await repo.clearThread(payload.event_id);
			await createLate(client, payload, classification, severity);
			return;
		}

		if (classification.isRecovery) {
			await repo.markResolved(payload.event_id, severity);
			await tagAsResolved(client, existing.discord_thread_id);
		} else {
			await repo.updateSeverity(payload.event_id, severity);
		}
		return;
	}

	// UPDATE ou RESOLVED sem o PROBLEM original ter criado a thread. UPDATE nunca descarta o
	// evento, cria a thread agora mesmo com o que tem disponível - RESOLVED tem sua própria guarda
	// dentro de createLate() e é ignorado (ver comentário lá).
	logger.warn(
		`Evento ${payload.event_id} chegou como ${classification.isRecovery ? "RESOLVED" : "UPDATE"} sem thread existente.`,
	);
	await createLate(client, payload, classification, severity);
}

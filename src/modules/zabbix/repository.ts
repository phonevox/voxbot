import { config } from "@/config";
import { query } from "@/database/connection";
import type { ZbxEventRow } from "./types";

// ─── Canal Forum ──────────────────────────────────────────────────────────────

/**
 * Canal Forum configurado via `/zabbix config canal-forum` (guilds.settings, prioridade) ou
 * MOD_ZABBIX_FORUM_CHANNEL_ID (env, fallback pra quem ainda não migrou pro comando). Só uma guild
 * deveria ter isso setado - a integração é 1 Zabbix : 1 servidor, então busca sem filtrar guild.
 */
export async function getForumChannelId(): Promise<string | null> {
	const res = await query<{ channel_id: string }>(
		`SELECT settings->>'zabbix_forum_channel_id' AS channel_id FROM guilds
         WHERE settings->>'zabbix_forum_channel_id' IS NOT NULL LIMIT 1`,
	);
	return res.rows[0]?.channel_id ?? config.zabbix.forumChannelId ?? null;
}

// ─── Dedup de webhook ─────────────────────────────────────────────────────────

/** true = primeira vez que essa entrega chega (deve processar). false = já processada (ignora). */
export async function tryClaimWebhook(dedupKey: string): Promise<boolean> {
	const res = await query(
		`INSERT INTO zbx_processed_webhooks (dedup_key) VALUES ($1) ON CONFLICT (dedup_key) DO NOTHING`,
		[dedupKey],
	);
	return (res.rowCount ?? 0) > 0;
}

// ─── Eventos ──────────────────────────────────────────────────────────────────

/**
 * Tenta reivindicar um event_id novo (status inicial 'open', sem thread ainda). Retorna a linha
 * se ganhou a corrida; retorna null se alguém já reivindicou esse event_id antes (chame
 * `getEvent` pra pegar a linha existente nesse caso).
 */
export async function tryClaimEvent(
	eventId: string,
	triggerId: string,
	hostName: string,
	hostIp: string | undefined,
	severity: number,
): Promise<ZbxEventRow | null> {
	const res = await query<ZbxEventRow>(
		`INSERT INTO zbx_events (zabbix_event_id, zabbix_trigger_id, host_name, host_ip, current_severity, status)
         VALUES ($1, $2, $3, $4, $5, 'open')
         ON CONFLICT (zabbix_event_id) DO NOTHING
         RETURNING *`,
		[eventId, triggerId, hostName, hostIp ?? null, severity],
	);
	return res.rows[0] ?? null;
}

export async function getEvent(eventId: string): Promise<ZbxEventRow | null> {
	const res = await query<ZbxEventRow>(
		`SELECT * FROM zbx_events WHERE zabbix_event_id = $1`,
		[eventId],
	);
	return res.rows[0] ?? null;
}

/** Usado pelo `!mensagem` (discord/operatorCommands.ts) pra confirmar que o canal é uma thread de evento. */
export async function getEventByThreadId(threadId: string): Promise<ZbxEventRow | null> {
	const res = await query<ZbxEventRow>(
		`SELECT * FROM zbx_events WHERE discord_thread_id = $1`,
		[threadId],
	);
	return res.rows[0] ?? null;
}

export async function setThreadCreated(
	eventId: string,
	threadId: string,
	headMsgId: string,
): Promise<void> {
	await query(
		`UPDATE zbx_events SET discord_thread_id = $2, discord_head_msg_id = $3, updated_at = NOW()
         WHERE zabbix_event_id = $1`,
		[eventId, threadId, headMsgId],
	);
}

export async function updateSeverity(eventId: string, severity: number): Promise<void> {
	await query(
		`UPDATE zbx_events SET current_severity = $2, updated_at = NOW() WHERE zabbix_event_id = $1`,
		[eventId, severity],
	);
}

export async function markResolved(eventId: string, severity: number): Promise<void> {
	await query(
		`UPDATE zbx_events
         SET status = 'resolved', current_severity = $2, resolved_at = NOW(), updated_at = NOW()
         WHERE zabbix_event_id = $1`,
		[eventId, severity],
	);
}

export async function setOwner(eventId: string, ownerDiscordId: string): Promise<void> {
	await query(
		`UPDATE zbx_events SET owner_discord_id = $2, status = 'acknowledged', updated_at = NOW()
         WHERE zabbix_event_id = $1`,
		[eventId, ownerDiscordId],
	);
}

/** Pra reconciliação: todo evento que o bot já conhece e ainda considera não resolvido. */
export async function listOpenEvents(): Promise<ZbxEventRow[]> {
	const res = await query<ZbxEventRow>(`SELECT * FROM zbx_events WHERE status != 'resolved'`);
	return res.rows;
}

/**
 * Desvincula a thread de um evento (sem apagar o evento em si) - usado quando a thread foi
 * deletada manualmente no Discord, pra deixar o evento pronto pra ser recriado pelo próximo
 * webhook/reconciliação que passar por ele (mesmo caminho da criação tardia).
 */
export async function clearThread(eventId: string): Promise<void> {
	await query(
		`UPDATE zbx_events SET discord_thread_id = NULL, discord_head_msg_id = NULL, updated_at = NOW()
         WHERE zabbix_event_id = $1`,
		[eventId],
	);
}

/** Resolvidos há mais de `delayMs` e ainda não arquivados - candidatos do job de arquivamento. */
export async function listArchivable(delayMs: number): Promise<ZbxEventRow[]> {
	const res = await query<ZbxEventRow>(
		`SELECT * FROM zbx_events
         WHERE status = 'resolved' AND archived_at IS NULL
           AND resolved_at IS NOT NULL AND resolved_at < NOW() - ($1 || ' milliseconds')::interval`,
		[delayMs],
	);
	return res.rows;
}

export async function markArchived(eventId: string): Promise<void> {
	await query(`UPDATE zbx_events SET archived_at = NOW() WHERE zabbix_event_id = $1`, [eventId]);
}

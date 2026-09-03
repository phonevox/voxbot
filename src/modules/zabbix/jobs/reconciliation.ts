import type { Client } from "discord.js";
import { config } from "@/config";
import { Logger } from "@/utils/logging";
import { classifyEvent, findOrCreateThread } from "../discord/threadManager";
import * as repo from "../repository";
import type { WebhookPayload, ZbxEventRow } from "../types";
import {
	type ZabbixProblem,
	getHostIps,
	getOpenProblems,
	getProblemById,
	getTriggerDescriptions,
} from "../zabbix/client";

const logger = new Logger("zabbix.reconciliation");

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Mesmo formato que a macro {EVENT.TAGS} do Zabbix produz: "tag: valor, tag: valor". */
function formatTags(tags: ZabbixProblem["tags"]): string | undefined {
	if (!tags?.length) return undefined;
	return tags.map((t) => (t.value ? `${t.tag}: ${t.value}` : t.tag)).join(", ");
}

function problemToPayload(
	problem: ZabbixProblem,
	triggerDescriptions: Map<string, string>,
	hostIps: Map<string, string>,
): WebhookPayload {
	const clock = new Date(Number(problem.clock) * 1000);
	const host = problem.hosts?.[0];

	return {
		event_id: problem.eventid,
		trigger_id: problem.objectid,
		event_source: "0",
		event_value: "1",
		event_update_status: "0",
		event_nseverity: problem.severity,
		event_name: problem.name,
		event_opdata: problem.opdata,
		event_date: `${clock.getFullYear()}.${pad(clock.getMonth() + 1)}.${pad(clock.getDate())}`,
		event_time: `${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`,
		event_tags: formatTags(problem.tags),
		trigger_description: triggerDescriptions.get(problem.objectid),
		host_name: host?.name ?? "desconhecido",
		host_ip: host ? hostIps.get(host.hostid) : undefined,
		host_uid: host?.hostid,
		zabbix_url: config.zabbix.webUrl ?? "",
	};
}

async function threadIsAlive(client: Client, row: ZbxEventRow): Promise<boolean> {
	if (!row.discord_thread_id) return false;
	const thread = await client.channels.fetch(row.discord_thread_id).catch(() => null);
	return !!thread;
}

/**
 * Compara problemas abertos no Zabbix contra o que o bot já conhece, e cria (ou recria) a thread
 * pro que faltou - rede de segurança pra quando o bot esteve fora do ar no momento de um PROBLEM
 * (ADR 0004), e também pra quando uma thread existente foi deletada manualmente no Discord (nesse
 * caso o evento continua "conhecido" no banco, então só comparar contra o que já existe não
 * bastava - precisa checar se a thread ainda está lá de verdade). Reaproveita o mesmo caminho de
 * criação do webhook normal, sem duplicar lógica. Retorna quantas threads foram criadas/recriadas.
 */
export async function reconcile(client: Client): Promise<number> {
	if (config.zabbix.reconcileSince === "never") {
		logger.debug("Reconciliação desativada (MOD_ZABBIX_RECONCILE_SINCE=never).");
		return 0;
	}

	if (!config.zabbix.apiUrl) {
		logger.warn("Reconciliação pulada - MOD_ZABBIX_API_URL não configurado.");
		return 0;
	}

	const sinceSec = config.zabbix.reconcileSince === "ever" ? undefined : config.zabbix.reconcileSince;

	const [problems, openRows] = await Promise.all([getOpenProblems(sinceSec), repo.listOpenEvents()]);
	const openRowByEventId = new Map(openRows.map((r) => [r.zabbix_event_id, r]));

	const needsBackfill: typeof problems = [];
	for (const problem of problems) {
		const row = openRowByEventId.get(problem.eventid);
		if (!row) {
			needsBackfill.push(problem);
			continue;
		}
		if (!(await threadIsAlive(client, row))) {
			logger.warn(`Thread do evento ${problem.eventid} não existe mais no Discord - recriando.`);
			await repo.clearThread(problem.eventid);
			needsBackfill.push(problem);
		}
	}

	if (needsBackfill.length === 0) return 0;

	// Em lote, não um trigger.get/host.get por evento - evita N+1 quando falta muita coisa de uma vez.
	const triggerIds = [...new Set(needsBackfill.map((p) => p.objectid))];
	const hostIds = [...new Set(needsBackfill.flatMap((p) => p.hosts?.map((h) => h.hostid) ?? []))];
	const [triggerDescriptions, hostIps] = await Promise.all([
		getTriggerDescriptions(triggerIds),
		getHostIps(hostIds),
	]);

	for (const problem of needsBackfill) {
		const payload = problemToPayload(problem, triggerDescriptions, hostIps);
		logger.warn(`Reconciliação encontrou o evento ${payload.event_id} sem thread - criando.`);
		await findOrCreateThread(client, payload, classifyEvent(payload)).catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
		});
	}

	return needsBackfill.length;
}

/**
 * Força a reconciliação de um único event_id, ignorando `MOD_ZABBIX_RECONCILE_SINCE` por completo
 * (funciona mesmo com "never" ou um corte de data que excluiria esse evento) - pra testar um
 * evento específico sem esperar o job periódico. Sempre desvincula e recria, mesmo que o evento
 * já tenha uma thread válida - é uma ação manual e explícita, não uma varredura automática.
 */
export async function reconcileOne(client: Client, eventId: string): Promise<string> {
	const problem = await getProblemById(eventId);
	if (!problem) {
		return `Evento \`${eventId}\` não encontrado no Zabbix (ID errado, ou não é um evento de trigger).`;
	}

	await repo.clearThread(eventId);

	const [triggerDescriptions, hostIps] = await Promise.all([
		getTriggerDescriptions([problem.objectid]),
		getHostIps(problem.hosts?.map((h) => h.hostid) ?? []),
	]);

	const payload = problemToPayload(problem, triggerDescriptions, hostIps);
	await findOrCreateThread(client, payload, classifyEvent(payload));

	return `Evento \`${eventId}\` reconciliado à força. Se ele já tinha uma thread, a antiga ficou órfã (não foi apagada).`;
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startReconciliationJob(client: Client): void {
	if (config.zabbix.reconcileSince === "never" || intervalHandle) return;
	intervalHandle = setInterval(() => {
		reconcile(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
	}, config.zabbix.reconciliationIntervalMs);
}

export function stopReconciliationJob(): void {
	if (intervalHandle) clearInterval(intervalHandle);
	intervalHandle = null;
}

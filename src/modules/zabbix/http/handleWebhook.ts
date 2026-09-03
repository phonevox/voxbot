import { createHash } from "node:crypto";
import type { Client } from "discord.js";
import { Logger } from "@/utils/logging";
import * as repo from "../repository";
import { classifyEvent, findOrCreateThread } from "../discord/threadManager";
import type { WebhookPayload } from "../types";

const logger = new Logger("zabbix.webhook");

const REQUIRED_FIELDS: (keyof WebhookPayload)[] = [
	"event_id",
	"trigger_id",
	"event_source",
	"event_value",
	"event_update_status",
	"event_nseverity",
	"event_name",
	"event_date",
	"event_time",
	"host_name",
	"zabbix_url",
];

/** Mesma validação de campos que o script Duktape já fazia, adaptada. */
function validatePayload(payload: Record<string, unknown>): boolean {
	for (const field of REQUIRED_FIELDS) {
		if (!payload[field] || typeof payload[field] !== "string") return false;
	}

	const source = payload.event_source as string;
	if (!["0", "1", "2", "3"].includes(source)) return false;

	// Só evento de trigger (source "0") precisa desses dois campos válidos - outros tipos ficam
	// fora do escopo assim que a classificação roda, então não vale a pena validar a fundo aqui.
	if (source === "0") {
		if (!["0", "1"].includes(payload.event_value as string)) return false;
		if (!["0", "1"].includes(payload.event_update_status as string)) return false;
	}

	return true;
}

/** O "clock" da entrega - a marca de tempo mais específica disponível pro tipo de evento. */
function dedupClock(payload: WebhookPayload): string {
	if (payload.event_update_date && payload.event_update_time) {
		return `${payload.event_update_date}${payload.event_update_time}`;
	}
	if (payload.event_recovery_date && payload.event_recovery_time) {
		return `${payload.event_recovery_date}${payload.event_recovery_time}`;
	}
	return `${payload.event_date}${payload.event_time}`;
}

/** hash(event_id, tipo, clock, action, message) - sem precisar de um ID novo no Media Type do Zabbix. */
function dedupKey(payload: WebhookPayload): string {
	const raw = [
		payload.event_id,
		payload.event_source,
		dedupClock(payload),
		payload.event_update_action ?? "",
		payload.event_update_message ?? "",
	].join("|");
	return createHash("sha256").update(raw).digest("hex");
}

export interface WebhookResult {
	status: number;
	message: string;
}

export async function handleWebhook(client: Client, body: unknown): Promise<WebhookResult> {
	if (typeof body !== "object" || body === null) {
		return { status: 400, message: "corpo inválido" };
	}

	const raw = body as Record<string, unknown>;
	if (!validatePayload(raw)) {
		logger.warn(`Payload de webhook inválido: ${JSON.stringify(raw)}`);
		return { status: 400, message: "payload inválido" };
	}
	const payload = raw as unknown as WebhookPayload;

	// Diagnóstico de timezone: já rolou um bug real de timestamp calculado errado (ver
	// discord/textHelpers.ts zbxToDate) - isso mostra os valores brutos que o Zabbix mandou, pra
	// comparar contra o horário real e confirmar se o offset configurado (config.zabbix.
	// zabbixTzOffsetMinutes) bate com o timezone de verdade do processo de alerta do Zabbix.
	logger.debug(
		`Timestamps brutos do evento ${payload.event_id}: date=${payload.event_date} time=${payload.event_time} ` +
			`update_date=${payload.event_update_date ?? "-"} update_time=${payload.event_update_time ?? "-"} ` +
			`recovery_date=${payload.event_recovery_date ?? "-"} recovery_time=${payload.event_recovery_time ?? "-"}`,
	);

	const isNew = await repo.tryClaimWebhook(dedupKey(payload));
	if (!isNew) {
		logger.debug(`Webhook duplicado ignorado (event_id ${payload.event_id}).`);
		return { status: 200, message: "duplicado, ignorado" };
	}

	const classification = classifyEvent(payload);
	if (!classification.isTrigger) {
		// Autoreg/descoberta ficam fora do modelo "1 evento = 1 thread" desta versão.
		logger.debug(`Evento não-trigger ignorado (event_source=${payload.event_source}).`);
		return { status: 200, message: "fora de escopo" };
	}

	try {
		await findOrCreateThread(client, payload, classification);
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		return { status: 500, message: "erro interno ao processar" };
	}

	return { status: 200, message: "ok" };
}

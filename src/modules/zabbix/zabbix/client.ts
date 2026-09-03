import { config } from "@/config";
import { Logger } from "@/utils/logging";
import type { AckParams } from "../types";
import { toApiParams } from "./acknowledge";

const logger = new Logger("zabbix.client");

/**
 * Conta de serviço única, sessão em variável de módulo (mesmo padrão do pool em
 * database/connection.ts) - todo comando do Discord vira uma ação autenticada como o bot, nunca
 * como o usuário individual (ADR 0003).
 */
let sessionToken: string | null = null;
let rpcId = 0;

export class ZabbixApiError extends Error {
	constructor(
		message: string,
		public readonly detail?: string,
	) {
		super(detail ? `${message}: ${detail}` : message);
		this.name = "ZabbixApiError";
	}
}

interface RpcErrorBody {
	code: number;
	message: string;
	data?: string;
}

async function rpcCall(method: string, params: unknown, auth: string | null): Promise<unknown> {
	if (!config.zabbix.apiUrl) throw new Error("MOD_ZABBIX_API_URL não configurado.");

	rpcId += 1;
	const body: Record<string, unknown> = { jsonrpc: "2.0", method, params, id: rpcId };
	if (auth) body.auth = auth;

	const res = await fetch(config.zabbix.apiUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json-rpc" },
		body: JSON.stringify(body),
	});

	const data = (await res.json()) as { result?: unknown; error?: RpcErrorBody };
	if (data.error) throw new ZabbixApiError(data.error.message, data.error.data);
	return data.result;
}

/** Mensagem padrão do Zabbix quando a sessão expirou/foi invalidada: "Session terminated, re-login, please." */
function isSessionError(err: unknown): boolean {
	if (!(err instanceof ZabbixApiError)) return false;
	const text = err.message.toLowerCase();
	return text.includes("re-login") || text.includes("not authorized") || text.includes("session terminated");
}

async function login(): Promise<string> {
	if (!config.zabbix.apiUser || !config.zabbix.apiPassword) {
		throw new Error("MOD_ZABBIX_API_USER/MOD_ZABBIX_API_PASSWORD não configurados.");
	}

	// Zabbix 5.0 não tem API token (chegou na 5.4) - autenticação via user.login com sessão.
	const token = await rpcCall(
		"user.login",
		{ user: config.zabbix.apiUser, password: config.zabbix.apiPassword },
		null,
	);
	sessionToken = token as string;
	logger.info("Login na API do Zabbix renovado.");
	return sessionToken;
}

/** Chama um método autenticado, relogando 1x automaticamente se a sessão tiver expirado/for inválida. */
async function call(method: string, params: unknown): Promise<unknown> {
	if (!sessionToken) await login();

	try {
		return await rpcCall(method, params, sessionToken);
	} catch (err) {
		if (!isSessionError(err)) throw err;
		logger.warn("Sessão da API do Zabbix inválida, relogando...");
		await login();
		return rpcCall(method, params, sessionToken);
	}
}

export async function acknowledge(params: AckParams): Promise<void> {
	await call("event.acknowledge", toApiParams(params));
}

export interface ZabbixProblem {
	eventid: string;
	objectid: string;
	name: string;
	severity: string;
	clock: string;
	opdata?: string;
	tags?: { tag: string; value: string }[];
	hosts?: { hostid: string; name: string }[];
}

/**
 * `problem.get` NÃO suporta `selectHosts` (o parâmetro é ignorado em silêncio, sem erro nenhum -
 * armadilha real, já caiu nela uma vez). Quem tem o host de um evento é `event.get`. Uma chamada
 * complementar em lote, não uma por evento.
 */
async function attachHosts(problems: ZabbixProblem[]): Promise<ZabbixProblem[]> {
	if (problems.length === 0) return problems;

	const eventIds = problems.map((p) => p.eventid);
	const events = (await call("event.get", {
		output: ["eventid"],
		selectHosts: ["hostid", "name"],
		eventids: eventIds,
	})) as { eventid: string; hosts: { hostid: string; name: string }[] }[];

	const hostsByEventId = new Map(events.map((e) => [e.eventid, e.hosts]));
	return problems.map((p) => ({ ...p, hosts: hostsByEventId.get(p.eventid) ?? [] }));
}

/**
 * Problemas de trigger (source 0) abertos no Zabbix agora - usado pela reconciliação pra achar o
 * que o bot perdeu. Ainda não é o payload completo de um webhook (falta descrição do trigger e IP
 * do host - ver `getTriggerDescriptions`/`getHostIps`), mas já traz opdata/tags direto, sem
 * chamada extra.
 *
 * `sinceSec` filtra por `time_from` direto na API (não busca tudo e filtra depois) - sem isso, a
 * primeira reconciliação de uma instalação nova tenta recriar thread pra todo problema aberto no
 * histórico do Zabbix de uma vez, estourando o rate limit de criação de thread do Discord.
 */
export async function getOpenProblems(sinceSec?: number): Promise<ZabbixProblem[]> {
	const result = await call("problem.get", {
		output: ["eventid", "objectid", "name", "severity", "clock", "opdata"],
		selectTags: "extend",
		source: 0,
		recent: false,
		...(sinceSec ? { time_from: sinceSec } : {}),
	});
	return attachHosts(result as ZabbixProblem[]);
}

/**
 * Busca um evento específico por ID, ignorando `time_from`/status - pra testes manuais
 * (`/zabbix reconciliar <event_id>`). `recent: true` inclui problemas recém-resolvidos também,
 * não só os ainda abertos.
 */
export async function getProblemById(eventId: string): Promise<ZabbixProblem | null> {
	const result = (await call("problem.get", {
		output: ["eventid", "objectid", "name", "severity", "clock", "opdata"],
		selectTags: "extend",
		eventids: [eventId],
		source: 0,
		recent: true,
	})) as ZabbixProblem[];
	const [withHosts] = await attachHosts(result);
	return withHosts ?? null;
}

/**
 * {TRIGGER.DESCRIPTION} mapeia pro campo `comments` do trigger na API, não `description` (esse é
 * o nome/template do trigger, tipo {TRIGGER.NAME} - nomenclatura confusa, mas é assim mesmo).
 * Uma chamada só, em lote, pra não fazer N+1 quando a reconciliação tem vários eventos.
 */
export async function getTriggerDescriptions(triggerIds: string[]): Promise<Map<string, string>> {
	if (triggerIds.length === 0) return new Map();

	const result = (await call("trigger.get", {
		triggerids: triggerIds,
		output: ["triggerid", "comments"],
	})) as { triggerid: string; comments: string }[];

	return new Map(result.map((t) => [t.triggerid, t.comments]));
}

export interface ZabbixAck {
	clock: string;
	message: string;
	action: string;
}

export interface ZabbixEventDetails {
	eventid: string;
	name: string;
	severity: string;
	clock: string;
	r_clock: string;
	opdata?: string;
	acknowledged: string;
	value: string;
	hosts: { hostid: string; name: string }[];
	acknowledges: ZabbixAck[];
}

/** Detalhes completos de um evento + histórico de acks/comentários - `!zabbix detalhes`. */
export async function getEventDetails(eventId: string): Promise<ZabbixEventDetails | null> {
	const result = (await call("event.get", {
		output: ["eventid", "name", "severity", "clock", "r_clock", "opdata", "acknowledged", "value"],
		selectHosts: ["hostid", "name"],
		// Zabbix 5.0: esse select específico é snake_case (select_acknowledges), diferente de
		// selectHosts/selectTags (camelCase) - inconsistência real da API dessa versão, confirmada
		// ao vivo (a versão camelCase simplesmente omite o campo do resultado, em silêncio).
		select_acknowledges: "extend",
		eventids: [eventId],
	})) as ZabbixEventDetails[];
	return result[0] ?? null;
}

/** IP fica na interface do host, não no host em si. Também em lote. */
export async function getHostIps(hostIds: string[]): Promise<Map<string, string>> {
	if (hostIds.length === 0) return new Map();

	const result = (await call("host.get", {
		hostids: hostIds,
		output: ["hostid"],
		selectInterfaces: ["ip"],
	})) as { hostid: string; interfaces?: { ip: string }[] }[];

	return new Map(result.map((h) => [h.hostid, h.interfaces?.[0]?.ip ?? ""]));
}

import { config } from "@/config";
import { Logger } from "@/utils/logging";

const logger = new Logger("hostinger.api");

/* developers.hostinger.com é o host real da API (confirmado ao vivo: api.hostinger.com não
   resolve, dá erro 530 do Cloudflare). A doc pública às vezes aparece com esse host errado. */
const BASE_URL = "https://developers.hostinger.com";

export interface HostingerRecord {
	content: string;
}

export interface HostingerZoneEntry {
	name: string;
	type: string;
	ttl: number;
	records: HostingerRecord[];
}

async function hostingerRequest<T>(
	method: "GET" | "PUT" | "DELETE",
	path: string,
	body?: Record<string, unknown>,
): Promise<T> {
	if (!config.hostinger.apiToken) {
		throw new Error(
			"Integração com a Hostinger não configurada (falta MOD_HOSTINGER_API_TOKEN).",
		);
	}

	const url = `${BASE_URL}${path}`;
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${config.hostinger.apiToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	const raw = await res.text();

	if (!res.ok) {
		logger.error(
			`Hostinger ${res.status} ${res.statusText} em ${method} ${url}${
				body ? ` (body: ${JSON.stringify(body)})` : ""
			} - resposta: ${raw.slice(0, 1000)}`,
		);
		throw new Error(
			`Hostinger respondeu ${res.status} ${res.statusText}: ${raw.slice(0, 300)}`,
		);
	}

	return raw ? JSON.parse(raw) : (undefined as T);
}

/** Registros DNS atuais da zona do domínio. */
export async function getZoneRecords(
	domain: string,
): Promise<HostingerZoneEntry[]> {
	return hostingerRequest<HostingerZoneEntry[]>(
		"GET",
		`/api/dns/v1/zones/${encodeURIComponent(domain)}`,
	);
}

/**
 * Upsert de um registro (overwrite: false) - a própria API já resolve create vs update: se já
 * existe um registro com esse name+type ela atualiza, senão cria. Não precisa (nem dá, sem uma
 * GET antes) distinguir "add" de "edit" no nosso lado.
 */
export async function upsertZoneRecord(
	domain: string,
	entry: HostingerZoneEntry,
): Promise<void> {
	await hostingerRequest(
		"PUT",
		`/api/dns/v1/zones/${encodeURIComponent(domain)}`,
		{
			overwrite: false,
			zone: [entry],
		},
	);
}

export async function deleteZoneRecord(
	domain: string,
	name: string,
	type: string,
): Promise<void> {
	await hostingerRequest(
		"DELETE",
		`/api/dns/v1/zones/${encodeURIComponent(domain)}`,
		{
			filters: [{ name, type }],
		},
	);
}

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
 * Cria um registro (`overwrite: false`) ou sobrescreve um já existente com esse name+type
 * (`overwrite: true`). Confirmado ao vivo: `overwrite: false` NÃO faz upsert sozinho - se já
 * existir um registro conflitante, a Hostinger rejeita com 422 (`DNS:4008`) em vez de atualizar.
 * O chamador precisa checar antes (`getZoneRecords`) se o registro já existe pra saber qual usar.
 */
export async function upsertZoneRecord(
	domain: string,
	entry: HostingerZoneEntry,
	overwrite = false,
): Promise<void> {
	await hostingerRequest(
		"PUT",
		`/api/dns/v1/zones/${encodeURIComponent(domain)}`,
		{
			overwrite,
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

export interface HostingerDomain {
	domain: string;
	status: string;
}

// Domínio da conta muda raríssimo (comprar/transferir), mas o autocomplete bate aqui a cada tecla
// digitada - sem cache isso vira uma chamada à API da Hostinger por tecla. 10min é bem folgado
// pro caso de uso (ninguém precisa ver um domínio novo aparecer no autocomplete em tempo real).
const DOMAINS_CACHE_TTL_MS = 10 * 60_000;
let domainsCache: { data: HostingerDomain[]; expiresAt: number } | null = null;

/** Todos os domínios da conta - usado pro autocomplete de `dominio` em !hostinger advanceddns/dns
 * list e pra `resolveDomain` descobrir onde termina o domínio e começa o subdomínio.
 * Confirmado ao vivo: a Hostinger devolve `domain: null` pra alguns itens do portfolio (ex: em
 * transferência) - filtra esses fora aqui, na origem, em vez de cada consumidor ter que se
 * proteger contra isso na mão. */
export async function listDomains(): Promise<HostingerDomain[]> {
	if (domainsCache && domainsCache.expiresAt > Date.now()) {
		return domainsCache.data;
	}

	const domains = await hostingerRequest<HostingerDomain[]>(
		"GET",
		"/api/domains/v1/portfolio",
	);
	const valid = domains.filter(
		(d): d is HostingerDomain =>
			typeof d.domain === "string" && d.domain !== "",
	);
	if (valid.length !== domains.length) {
		logger.debug(
			`listDomains: ${domains.length - valid.length} item(ns) do portfolio sem "domain" válido, ignorado(s) - cru: ${JSON.stringify(domains.filter((d) => !valid.includes(d)))}`,
		);
	}

	// Confirmado ao vivo: o portfolio da Hostinger repete o mesmo domínio mais de uma vez (ex: mais
	// de um recurso/assinatura apontando pro mesmo nome) - sem isso o autocomplete mostrava
	// "falevox.cloud" duas vezes. Mantém só a primeira ocorrência de cada nome (case-insensitive).
	const seen = new Set<string>();
	const unique = valid.filter((d) => {
		const key = d.domain.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (unique.length !== valid.length) {
		logger.debug(
			`listDomains: ${valid.length - unique.length} domínio(s) duplicado(s) no portfolio, ignorado(s) - cru: ${JSON.stringify(valid)}`,
		);
	}

	domainsCache = { data: unique, expiresAt: Date.now() + DOMAINS_CACHE_TTL_MS };
	return unique;
}

export interface ResolvedDomain {
	domain: string;
	subdomain: string;
}

/**
 * Acha, entre os domínios da conta, o que é sufixo de `fullDomain` (o mais específico, se mais de
 * um bater) e devolve o subdomínio resultante (`"@"` se `fullDomain` for o próprio domínio raiz).
 * `null` se nenhum domínio da conta bater. Usado por `!hostinger dns set/remove`, que só recebem
 * o domínio completo (ex: "voip.sofon.cloud") e precisam descobrir onde a Hostinger corta
 * domínio de subdomínio.
 */
export async function resolveDomain(
	fullDomain: string,
): Promise<ResolvedDomain | null> {
	const normalized = fullDomain.trim().toLowerCase();
	const domains = await listDomains();

	let best: string | null = null;
	for (const { domain } of domains) {
		const d = domain.toLowerCase();
		if (normalized === d || normalized.endsWith(`.${d}`)) {
			if (!best || d.length > best.length) best = d;
		}
	}
	if (!best) return null;

	const subdomain =
		normalized === best ? "@" : normalized.slice(0, -(best.length + 1));
	return { domain: best, subdomain };
}

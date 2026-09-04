import { timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { config } from "@/config";
import { Logger } from "@/utils/logging";
import { handleWebhook } from "./handleWebhook";

const logger = new Logger("zabbix.http");
const MAX_BODY_BYTES = 256 * 1024;

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * Atrás do proxy reverso do Dokploy (Traefik) - toda requisição chega no `node:http` vinda da rede
 * interna do Docker, o IP de origem real vai em `X-Forwarded-For`. Só dá pra confiar nesse header
 * porque a porta NÃO é publicada pro host (ver docker-compose.yml e `startIngestServer`): ninguém
 * alcança essa porta direto pra forjar o header, só o Traefik.
 */
function extractClientIp(req: IncomingMessage): string | undefined {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded.trim()) {
		return forwarded.split(",")[0]?.trim();
	}
	return req.socket.remoteAddress;
}

/**
 * Resolve o host permitido a cada requisição em vez de cachear - volume é de poucos webhooks por
 * dia, então o custo é irrelevante, e evita o bug de IP desatualizado se o DNS mudar (o allowlist
 * fixo tem prazo de validade, ver `.dev/zabbix-module/CONTEXT.md`).
 */
async function isAllowedIp(remoteAddr: string | undefined): Promise<boolean> {
	if (!remoteAddr) return false;

	try {
		const { address } = await dns.lookup(config.zabbix.allowedHost);
		// Socket dual-stack pode entregar um IPv4 mapeado como "::ffff:1.2.3.4".
		const normalized = remoteAddr.replace(/^::ffff:/, "");
		return normalized === address;
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		return false;
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Corpo da requisição grande demais."));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function handleRequest(client: Client, req: IncomingMessage, res: ServerResponse): Promise<void> {
	// ponytail: log temporário pra diagnosticar 404 vindo do proxy do Dokploy - remover depois de
	// confirmar o path/método reais que chegam no container. Ver conversa sobre vb.ingest.dev.
	logger.debug(
		`Requisição recebida: ${req.method} ${req.url} (esperado: POST ${config.zabbix.webhookPath})`,
	);

	if (req.method !== "POST" || req.url !== config.zabbix.webhookPath) {
		res.writeHead(404).end();
		return;
	}

	// Sem secret configurado, o endpoint fica fechado por padrão (nunca aberto sem querer).
	const secret = req.headers["x-zabbix-secret"];
	if (typeof secret !== "string" || !config.zabbix.webhookSecret || !safeEqual(secret, config.zabbix.webhookSecret)) {
		res.writeHead(401).end();
		return;
	}

	const clientIp = extractClientIp(req);
	if (!(await isAllowedIp(clientIp))) {
		logger.warn(`Requisição rejeitada de IP não permitido: ${clientIp}`);
		res.writeHead(403).end();
		return;
	}

	let body: unknown;
	try {
		body = JSON.parse(await readBody(req));
	} catch {
		res.writeHead(400).end();
		return;
	}

	const result = await handleWebhook(client, body);
	res.writeHead(result.status, { "Content-Type": "text/plain; charset=utf-8" }).end(result.message);
}

export function startIngestServer(client: Client): Server {
	const server = createServer((req, res) => {
		handleRequest(client, req, res).catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			if (!res.headersSent) res.writeHead(500).end();
		});
	});

	// Todas as interfaces - precisa ser alcançável por outro container (Traefik do Dokploy) pela
	// rede interna do Docker, loopback não adianta aqui. A porta em si NÃO é publicada pro host
	// (ver docker-compose.yml) - só quem está na mesma rede docker alcança, e isAllowedIp() +
	// X-Forwarded-For seguem confiáveis por causa disso.
	server.listen(config.zabbix.ingestPort, "0.0.0.0", () => {
		logger.info(`Servidor de ingest do Zabbix ouvindo em 0.0.0.0:${config.zabbix.ingestPort}.`);
	});

	return server;
}

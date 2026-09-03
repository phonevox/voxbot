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
 * Porta exposta direto (container publicado ou rede local) - sem proxy confiável na frente pra
 * normalizar isso, então `X-Forwarded-For` NÃO é usado: um cliente qualquer pode setar esse header
 * com qualquer valor e passar pelo allowlist de IP. O IP real é sempre o do socket TCP.
 */
function extractClientIp(req: IncomingMessage): string | undefined {
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

	// Todas as interfaces - a porta é publicada direto (container ou rede local), sem proxy na
	// frente. Segurança fica por conta do secret (X-Zabbix-Secret) + allowlist de IP acima, não do bind.
	server.listen(config.zabbix.ingestPort, "0.0.0.0", () => {
		logger.info(`Servidor de ingest do Zabbix ouvindo em 0.0.0.0:${config.zabbix.ingestPort}.`);
	});

	return server;
}

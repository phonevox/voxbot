import { EmbedBuilder } from "discord.js";
import { config } from "@/config";
import { getGuildPrefix } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";

const logger = new Logger("request.command");

const TIMEOUT_MS = 15_000;
// Não deixa a resposta explodir memória/mensagem - qualquer coisa maior é cortada, não é feito
// pra baixar arquivo grande, é debug de API.
const MAX_BODY_BYTES = 500 * 1024;
const MAX_DISPLAY_CHARS = 1500;

interface RequestSpec {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
	query?: Record<string, string>;
}

function extractJson(text: string): string {
	const fenced = /```(?:\w+\n)?([\s\S]*?)```/.exec(text);
	return (fenced ? fenced[1] : text).trim();
}

/** Faz o parse de um JSON solto (não exige campo nenhum) - reusado pelos dois modos. */
function parseJsonObject(text: string): Record<string, unknown> {
	const json = extractJson(text);
	if (!json) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new Error(`JSON inválido: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("O JSON precisa ser um objeto.");
	}
	return parsed as Record<string, unknown>;
}

function extractOptionalFields(obj: Record<string, unknown>): Pick<RequestSpec, "headers" | "body" | "query"> {
	return {
		headers:
			typeof obj.headers === "object" && obj.headers !== null
				? (obj.headers as Record<string, string>)
				: undefined,
		body: obj.body,
		query:
			typeof obj.query === "object" && obj.query !== null ? (obj.query as Record<string, string>) : undefined,
	};
}

/**
 * Dois formatos aceitos:
 * - Simples: `<method> <url> [{headers,body,query}]` - o JSON no final é opcional e não precisa
 *   de "method"/"url" dentro dele, já vêm dos argumentos posicionais.
 * - Completo: um JSON só, `{"method","url","headers","body","query"}` (todos exceto "url"
 *   opcionais) - em bloco de código ou cru, igual antes.
 * Decide pelo primeiro caractere não-espaço: `{` ou crase abre bloco de código = modo completo;
 * qualquer outra coisa = tenta o modo simples.
 */
function parseSpec(raw: string): RequestSpec {
	const trimmed = raw.trim();

	if (!/^[{`]/.test(trimmed)) {
		const simpleMatch = /^(\S+)\s+(https?:\/\/\S+)\s*([\s\S]*)$/i.exec(trimmed);
		if (!simpleMatch) {
			throw new Error(
				'Não entendi. Use `<method> <url> [{headers,body,query}]` ou um JSON completo `{"method","url",...}`.',
			);
		}
		const [, method, url, tail] = simpleMatch;
		return { method, url, ...(tail.trim() ? extractOptionalFields(parseJsonObject(tail)) : {}) };
	}

	const obj = parseJsonObject(raw);
	if (typeof obj.url !== "string" || !obj.url) throw new Error('Campo "url" obrigatório.');
	return {
		method: typeof obj.method === "string" ? obj.method : undefined,
		url: obj.url,
		...extractOptionalFields(obj),
	};
}

interface RequestResult {
	status: number;
	statusText: string;
	contentType: string | null;
	body: string;
	ms: number;
}

/**
 * A ferramenta é pra testar API JSON - resposta HTML geralmente significa que a URL/rota tá
 * errada (página de erro, redirect de login, bloqueio de WAF, etc), não o que a pessoa queria
 * testar. Checa o Content-Type primeiro; cai pro corpo em si porque nem toda resposta HTML manda
 * esse header direito.
 */
function looksLikeHtml(contentType: string | null, body: string): boolean {
	if (contentType?.toLowerCase().includes("html")) return true;
	return /^\s*<(!doctype html|html)/i.test(body);
}

async function runRequest(spec: RequestSpec): Promise<RequestResult> {
	let url: URL;
	try {
		url = new URL(spec.url);
	} catch {
		throw new Error(`URL inválida: "${spec.url}".`);
	}
	if (spec.query) {
		for (const [key, value] of Object.entries(spec.query)) url.searchParams.set(key, String(value));
	}

	const method = (spec.method ?? "GET").toUpperCase();
	const headers: Record<string, string> = { ...spec.headers };
	let body: string | undefined;

	if (spec.body !== undefined && method !== "GET" && method !== "HEAD") {
		body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
		if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
			headers["Content-Type"] = "application/json";
		}
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const start = Date.now();

	try {
		const res = await fetch(url, { method, headers, body, signal: controller.signal });
		const ms = Date.now() - start;
		const buf = await res.arrayBuffer();
		const truncated = buf.byteLength > MAX_BODY_BYTES;
		const text = Buffer.from(buf.slice(0, MAX_BODY_BYTES)).toString("utf8");
		return {
			status: res.status,
			statusText: res.statusText,
			contentType: res.headers.get("content-type"),
			body: truncated ? `${text}\n...(truncado)` : text,
			ms,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function formatBody(body: string): string {
	let display = body;
	try {
		display = JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		// não é JSON - mostra cru mesmo
	}
	return display.length > MAX_DISPLAY_CHARS ? `${display.slice(0, MAX_DISPLAY_CHARS)}\n...(cortado)` : display;
}

export default defineCommand({
	name: "request",
	description: "Faz uma requisição HTTP arbitrária, pra debug (só via !request, não slash).",
	category: CommandCategory.ADMIN,
	// SSRF/abuso reais aqui (o bot vira um proxy pra requisição arbitrária, headers inclusos) -
	// o dono do bot já tem controle total do processo de qualquer forma (!bot shutdown, load de
	// cog arbitrário), então essa permissão é a fronteira de segurança real, não validação de URL.
	botOwnerOnly: true,
	showOnHelp: false,

	async executeAsSlash(interaction, _client) {
		await interaction.reply({
			embeds: [
				EmbedFormatter.info(
					"Esse comando só funciona via prefixo (`!request`) - precisa colar um JSON em bloco de código ou responder a uma mensagem, o que não dá pra fazer num slash command.",
				),
			],
			ephemeral: true,
		});
	},

	async executeAsPrefix(message, _args, _client) {
		const prefix = message.guild ? await getGuildPrefix(message.guild.id) : config.bot.defaultPrefix;
		const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const requestPrefixPattern = new RegExp(`^${escapedPrefix}request\\s*`, "i");

		// A mensagem respondida pode ser ela mesma um "!request <bloco>" (não só JSON cru) - corta
		// o prefixo do comando dos dois lados antes de extrair, senão o "!request " sobra colado
		// no JSON e quebra o parse quando não tem bloco de código.
		let source = message.content.replace(requestPrefixPattern, "").trim();

		if (!source && message.reference?.messageId) {
			const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
			if (replied) source = replied.content.replace(requestPrefixPattern, "").trim();
		}

		if (!source) {
			await message.reply({
				embeds: [
					EmbedFormatter.warn(
						"Cole um JSON depois do comando (bloco de código ou não), ou responda a uma mensagem que tenha o JSON.\n" +
							"Simples: `!request get https://exemplo.com {\"headers\":{...},\"body\":{...},\"query\":{...}}`\n" +
							'Completo: `{ "method": "POST", "url": "...", "headers": {...}, "body": {...}, "query": {...} }`',
					),
				],
			});
			return;
		}

		let spec: RequestSpec;
		try {
			spec = parseSpec(source);
		} catch (err) {
			await message.reply({ embeds: [EmbedFormatter.error(err instanceof Error ? err.message : String(err))] });
			return;
		}

		try {
			const result = await runRequest(spec);
			const ok = result.status >= 200 && result.status < 300;
			const html = looksLikeHtml(result.contentType, result.body);
			const embed = new EmbedBuilder()
				.setColor(html ? 0xffff00 : ok ? 0x57f287 : 0xff0000)
				.setTitle(`${spec.method?.toUpperCase() ?? "GET"} ${spec.url}`.slice(0, 256))
				.addFields(
					{ name: "Status", value: `${result.status} ${result.statusText}`, inline: true },
					{ name: "Tempo", value: `${result.ms}ms`, inline: true },
				)
				.setDescription(`\`\`\`\n${formatBody(result.body) || "(vazio)"}\n\`\`\``);
			if (html) {
				embed.addFields({
					name: "⚠️ Atenção",
					value: "A resposta parece ser HTML, não JSON - confere se a URL/rota tá certa.",
				});
			}
			await message.reply({ embeds: [embed] });
		} catch (err) {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			const timedOut = err instanceof Error && err.name === "AbortError";
			const msg = timedOut
				? `Requisição estourou o tempo limite (${TIMEOUT_MS / 1000}s).`
				: err instanceof Error
					? err.message
					: String(err);
			await message.reply({ embeds: [EmbedFormatter.error(msg)] });
		}
	},
});

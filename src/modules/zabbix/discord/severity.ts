import type { ForumChannel } from "discord.js";

/**
 * Índice = nseverity do Zabbix (0-5). Índice 6 é uso interno só pra "recuperado/resolvido" (cor
 * verde, thumb de check) - o Zabbix nunca manda 6 num payload real.
 */
export const SEVERITY_COLORS = [
	0x97aab3, 0x7499ff, 0xffc859, 0xffa059, 0xe97659, 0xe45959, 0x009900,
] as const;

export const SEVERITY_NAMES = [
	"NÃO CLASSIFICADO",
	"INFORMATIVO",
	"BAIXO",
	"MÉDIO",
	"ALTO",
	"DESASTRE",
	"RESOLVIDO",
] as const;

const WARN_GIF = "https://em-content.zobj.net/source/joypixels-animations/366/warning_26a0-fe0f.gif";
const SMALL_DIAMOND = "https://em-content.zobj.net/source/twitter/376/small-orange-diamond_1f538.png";

// Nenhum índice pode ficar com string vazia: um Section do Components V2 exige um accessory
// (thumbnail ou botão) sempre - o script Duktape original deixava 0/1 em branco, e isso nunca
// dava erro lá porque ele montava o JSON cru direto pra API, sem validação local nenhuma.
export const SEVERITY_THUMBS = [
	SMALL_DIAMOND,
	SMALL_DIAMOND,
	SMALL_DIAMOND,
	SMALL_DIAMOND,
	WARN_GIF,
	WARN_GIF,
	"https://em-content.zobj.net/source/joypixels-animations/366/check-mark-button_2705.gif",
] as const;

// Update: branco, sem cor de severidade - é uma anotação sobre o problema, não um alarme novo.
export const UPDATE_COLOR = 0xffffff;
export const UPDATE_THUMB = "https://em-content.zobj.net/source/twitter/376/memo_1f4dd.png";

export const RESOLVED_INDEX = 6;

export function severityName(index: number): string {
	return SEVERITY_NAMES[index] ?? SEVERITY_NAMES[0];
}

export function severityColor(index: number): number {
	return SEVERITY_COLORS[index] ?? SEVERITY_COLORS[0];
}

export function severityThumb(index: number): string {
	return SEVERITY_THUMBS[index] ?? "";
}

/** O Zabbix manda nseverity como string; qualquer coisa fora de 0-5 vira "não classificado". */
export function clampSeverity(raw: string): number {
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) || n < 0 || n > 5 ? 0 : n;
}

/**
 * Cria as tags de severidade do Forum se ainda não existirem (chamado uma vez no onReady). Sem
 * tabela nova pra isso - o Discord já persiste as tags no próprio canal.
 *
 * ponytail: não há ping por severidade (role mention) nesta versão - o script antigo tinha IDs
 * de cargo hardcoded de outro servidor, que não fazem sentido copiar aqui sem saber os cargos
 * reais desta guilda. Adicionar quando/se isso for pedido.
 */
export async function ensureSeverityTags(forumChannel: ForumChannel): Promise<void> {
	const existing = new Set(forumChannel.availableTags.map((t) => t.name));
	// Inclui o índice 6 (RESOLVIDO) também - mesma lista, mesmo mecanismo de tag.
	const missing = SEVERITY_NAMES.filter((name) => !existing.has(name));
	if (missing.length === 0) return;

	await forumChannel.setAvailableTags([
		...forumChannel.availableTags,
		...missing.map((name) => ({ name })),
	]);
}

export function severityTagId(forumChannel: ForumChannel, severityIndex: number): string | null {
	const name = severityName(severityIndex);
	return forumChannel.availableTags.find((t) => t.name === name)?.id ?? null;
}

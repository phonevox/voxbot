/**
 * Porta de `.dev/zabbix-module/zabbix_mediatype_script.js` (script Duktape/ES5.1 que rodava no
 * Media Type do Zabbix) - a lógica de texto/data/tradução migrou pra cá (ver ADR "cog no mesmo
 * processo"); o script do lado do Zabbix agora só valida e repassa os parâmetros brutos.
 */
import { config } from "@/config";

const EN_SEVERITIES: Record<string, string> = {
	"Not classified": "Não classificado",
	Information: "Informativo",
	Warning: "Baixo",
	Average: "Médio",
	High: "Alto",
	Disaster: "Desastre",
};

function translateSeverityWord(word: string): string {
	return EN_SEVERITIES[word] ?? word;
}

function translateOneAction(action: string): string {
	const a = action.trim();

	if (/^acknowledged$/i.test(a)) return "reconheceu";
	if (/^unacknowledged$/i.test(a)) return "removeu o reconhecimento";
	if (/^commented$/i.test(a)) return "comentou";
	if (/^closed$/i.test(a)) return "fechou o problema";
	if (/^unsuppressed$/i.test(a)) return "removeu a supressão";
	if (/^started escalation$/i.test(a)) return "iniciou a escalação";
	if (/^stopped escalation$/i.test(a)) return "parou a escalação";

	const sevMatch = /^changed severity from (.+) to (.+)$/i.exec(a);
	if (sevMatch) {
		return `alterou a severidade de ${translateSeverityWord(sevMatch[1])} para ${translateSeverityWord(sevMatch[2])}`;
	}

	const suppressMatch = /^suppressed until (.+)$/i.exec(a);
	if (suppressMatch) return `suprimiu até ${suppressMatch[1]}`;

	return a;
}

/**
 * `{EVENT.UPDATE.ACTION}` volta sempre em inglês, numa lista separada por vírgula - exceto que o
 * Zabbix não separa a lista só por vírgula: os dois últimos itens vêm unidos por " and ", sem
 * vírgula antes dele. Sem normalizar isso, uma lista de 2 itens ("acknowledged and commented")
 * nunca tinha vírgula nenhuma e caía inteira, sem tradução, no fallback.
 */
export function translateUpdateAction(raw: string | undefined): string {
	if (!raw) return "atualizou o evento";

	const normalized = raw.replace(/\s+and\s+(?=[^,]*$)/, ", ");
	const parts = normalized
		.split(",")
		.map((p) => translateOneAction(p))
		.filter(Boolean);

	if (parts.length === 0) return "atualizou o evento";
	if (parts.length === 1) return parts[0];

	return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

// ─── Texto ────────────────────────────────────────────────────────────────────

export function stringTruncate(str: string | undefined, len: number): string {
	if (!str) return "";
	return str.length > len ? `${str.slice(0, len - 3)}...` : str;
}

/** Macro não expandido volta como a string literal, ex: "{EVENT.OPDATA}". */
export function isResolved(str: string | undefined): str is string {
	return !!str && !/^\{[A-Z0-9.]+\}$/.test(str);
}

/** Só os caracteres realmente especiais do Discord - escapar '-', '|' ou '>' no meio da linha faz a barra invertida aparecer literal na mensagem. */
export function mdEscape(str: string | undefined): string {
	if (!str) return "";
	return String(str)
		.replace(/[\r\n]+/g, " ")
		.replace(/([\\`*_~])/g, "\\$1")
		.replace(/\|\|/g, "\\|\\|");
}

/** Título clicável - colchete e parêntese no texto quebram a sintaxe do link. */
export function mdLink(text: string, url: string): string {
	return `[${text.replace(/[[\]]/g, "")}](${url})`;
}

export function blockquote(str: string | undefined): string {
	if (!str) return "";
	return `> ${String(str).replace(/\r?\n/g, "\n> ")}`;
}

/** Valor entre crases - crase no conteúdo encerraria o bloco no lugar errado. */
export function code(val: string | number): string {
	return `\`${String(val).replace(/`/g, "'")}\``;
}

/** Linha de subtexto com bullet. asCode=false deixa o valor em texto puro, reservando o bloco de código pro que é literalmente um dado medido. */
export function bulletLine(label: string, value: string | number, asCode: boolean): string {
	return `-# - ${label}: ${asCode ? code(value) : value}`;
}

export function joinLines(lines: (string | false | undefined)[]): string {
	return lines.filter(Boolean).join("\n");
}

export function joinInline(parts: (string | false | undefined)[], sep: string): string {
	return parts.filter(Boolean).join(sep);
}

// ─── Datas ────────────────────────────────────────────────────────────────────
// {EVENT.DATE} = yyyy.mm.dd | {EVENT.TIME} = hh:mm:ss

/**
 * `{EVENT.DATE}`/`{EVENT.TIME}` vêm sem indicação de fuso - são hora local do Zabbix
 * (`config.zabbix.zabbixTzOffsetMinutes`), não do processo do bot. `new Date(y,m,d,h,mi,s)`
 * interpretaria esses números como hora local DO BOT, o que já causou um bug real (timestamp
 * "no futuro" quando bot e Zabbix rodam em fusos diferentes) - por isso o cálculo é explícito via
 * `Date.UTC` + offset, nunca implícito.
 */
export function zbxToDate(dateStr: string | undefined, timeStr: string | undefined): Date | null {
	if (!isResolved(dateStr) || !isResolved(timeStr)) return null;

	const d = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(dateStr);
	const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timeStr);
	if (!d || !t) return null;

	const asIfUtc = Date.UTC(
		Number(d[1]),
		Number(d[2]) - 1,
		Number(d[3]),
		Number(t[1]),
		Number(t[2]),
		Number(t[3]),
	);
	return new Date(asIfUtc - config.zabbix.zabbixTzOffsetMinutes * 60_000);
}

export function relativeStamp(dateObj: Date | null): string {
	if (!dateObj) return "";
	return `<t:${Math.floor(dateObj.getTime() / 1000)}:R>`;
}

export function humanDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 0) return "";
	if (s < 60) return `${s}s`;

	const m = Math.floor(s / 60);
	if (m < 60) return `${m}min`;

	let h = Math.floor(m / 60);
	const remM = m % 60;
	if (h < 24) return remM > 0 ? `${h}h ${remM}min` : `${h}h`;

	const dd = Math.floor(h / 24);
	h %= 24;
	return h > 0 ? `${dd}d ${h}h` : `${dd}d`;
}

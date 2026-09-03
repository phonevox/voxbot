import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * Ranking de níveis customizado - `verbose` fica ABAIXO de `debug` (número maior = menos severo =
 * mais detalhe), o oposto dos níveis npm nativos do winston (onde verbose=4 < debug=5). Isso é
 * deliberado: deixa `debug` significar "detalhe diagnóstico normal" e `verbose` significar "o
 * ruído extra" (traces de parsing de macro/biome) - o console em `debug` mostra o primeiro sem o
 * segundo; suba para `verbose` para ver tudo.
 */
const customLevels = {
	levels: { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 },
	colors: {
		error: "red",
		warn: "yellow",
		info: "green",
		debug: "blue",
		verbose: "gray",
	},
};
winston.addColors(customLevels.colors);

const LEVEL_WIDTH = 7; // maior nível usado: "verbose"

const logFormat = printf(({ level, message, timestamp, namespace, stack }) => {
	// o level já vem colorizado - remove os códigos ANSI pra medir o tamanho real
	const displayLen = level.replace(/\x1B\[[0-9;]*m/g, "").length;
	const padding = " ".repeat(Math.max(0, LEVEL_WIDTH - displayLen));
	const ns = namespace ? ` [${namespace}]` : "";
	const trace = stack ? `\n${stack}` : "";
	return `${timestamp} ${level}${padding}${ns}: ${message}${trace}`;
});

// Base compartilhada, sem colorização - segura pra reusar entre transports já que nunca adiciona códigos ANSI.
const commonFormat = combine(
	errors({ stack: true }),
	timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
);
const plainFormat = combine(commonFormat, logFormat);

/** Níveis válidos que este app realmente usa - restringe o que `setLogLevel` aceita, pra um typo não passar em silêncio. Ordenados do menos ao mais verboso. */
export const LOG_LEVELS = [
	"error",
	"warn",
	"info",
	"debug",
	"verbose",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Cada transport tem sua própria cadeia de formato completa (incluindo se coloriza ou não) - NÃO
// defina um `format` no logger em si também. O winston aplica o formato de nível do logger antes
// de repassar aos transports, então um `colorize()` compartilhado ali embute códigos ANSI em
// `info.level` pra todo transport, incluindo os de arquivo que nunca pediram cor (isso já nos mordeu uma vez).
const consoleTransport = new winston.transports.Console({
	level: process.env.CONSOLE_LOG_LEVEL ?? "info",
	format: combine(commonFormat, colorize({ all: true }), logFormat),
});

// Parâmetros de rotação, compartilhados pelos dois arquivos rotacionados abaixo.
const LOG_RETENTION_DAYS = process.env.LOG_RETENTION_DAYS ?? "14";
// Gatilho extra opcional de rotação por tamanho (ex: "20m") - sem valor significa rotação só por data.
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE;

// Detalhe completo (o que `shared.level` permitir), arquivos datados - o lugar pra procurar traces
// de verbose/debug depois do fato.
const combinedFileTransport = new DailyRotateFile({
	filename: "logs/combined-%DATE%.log",
	datePattern: "YYYY-MM-DD",
	maxFiles: `${LOG_RETENTION_DAYS}d`,
	maxSize: LOG_MAX_SIZE,
	format: plainFormat,
});

const shared = winston.createLogger({
	levels: customLevels.levels,
	// Governa o que chega em `combinedFileTransport` (debug por padrão - detalhe completo, mas NÃO
	// o nível ainda mais ruidoso `verbose`; suba pra "verbose" pra também capturar traces de parsing de macro/biome).
	// O console tem seu próprio nível, mais silencioso, acima.
	level: process.env.LOG_LEVEL ?? "debug",
	transports: [
		// O console fica quieto por padrão - ruído de nível debug (traces de parsing de macro/biome)
		// nunca aparece aqui, só no arquivo rotacionado abaixo.
		consoleTransport,
		combinedFileTransport,
		// Só erros, mesma rotação - uma checagem rápida de "aconteceu algo crítico" sem vasculhar
		// ruído de debug. Deliberadamente não exposto ao `setLogLevel` - o propósito deste arquivo
		// é "só erros", sempre.
		new DailyRotateFile({
			filename: "logs/error-%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxFiles: `${LOG_RETENTION_DAYS}d`,
			maxSize: LOG_MAX_SIZE,
			level: "error",
			format: plainFormat,
		}),
	],
});

/** Muda o nível mínimo de log do console ou do arquivo combinado em tempo real - sem precisar reiniciar. */
export function setLogLevel(target: "console" | "file", level: LogLevel): void {
	if (target === "console") consoleTransport.level = level;
	else shared.level = level;
}

export function getLogLevels(): { console: string; file: string } {
	return { console: consoleTransport.level ?? "info", file: shared.level };
}

/** `fetch` só lança "TypeError: fetch failed" genérico - o motivo real fica em `err.cause`. */
function formatErrorChain(err: Error): string {
	const lines = [err.stack ?? err.message];
	let cause = (err as { cause?: unknown }).cause;
	let depth = 0;

	while (cause !== undefined && depth < 5) {
		if (cause instanceof Error) {
			lines.push(`Causado por: ${cause.stack ?? cause.message}`);
			cause = (cause as { cause?: unknown }).cause;
		} else {
			lines.push(`Causado por: ${Logger.stringify(cause)}`);
			break;
		}
		depth++;
	}

	return lines.join("\n");
}

export class Logger {
	private readonly child: winston.Logger;

	constructor(namespace: string) {
		this.child = shared.child({ namespace });
	}

	info(message: string, meta?: object): void {
		this.child.info(message, meta);
	}

	warn(message: string, meta?: object): void {
		this.child.warn(message, meta);
	}

	error(message: string | Error, meta?: object): void {
		if (message instanceof Error) {
			this.child.error(message.message, { stack: formatErrorChain(message), ...meta });
		} else {
			this.child.error(message, meta);
		}
	}

	debug(message: string, meta?: object): void {
		this.child.debug(message, meta);
	}

	/** Abaixo de `debug` - para o ruído (traces de parsing de macro/biome) que você só quer ao investigar ativamente. */
	verbose(message: string, meta?: object): void {
		this.child.log("verbose", message, meta);
	}

	static stringify(value: unknown): string {
		return JSON.stringify(
			value,
			(_, v) => (typeof v === "bigint" ? v.toString() : v),
			2,
		);
	}
}

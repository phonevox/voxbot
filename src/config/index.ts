import "dotenv/config";

function require_env(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
	return val;
}

export type ReconcileSince = number | "ever" | "never";

/**
 * MOD_ZABBIX_RECONCILE_SINCE aceita:
 * - "start" (ou vazio/não setado - padrão seguro): só problemas que já estavam abertos a partir
 *   deste boot do processo pra frente. Recalculado a cada restart.
 * - "ever": sem corte nenhum - reconcilia o histórico inteiro do Zabbix. Só faz sentido pedir
 *   isso de propósito, sabendo que pode criar dezenas de threads de uma vez.
 * - "never": reconciliação desligada por completo (nem roda o job, nem o gatilho manual).
 * - um Unix timestamp em segundos: corte fixo, não muda entre restarts.
 */
function resolveReconcileSince(): ReconcileSince {
	const raw = process.env.MOD_ZABBIX_RECONCILE_SINCE?.trim().toLowerCase();

	if (!raw || raw === "start") return Math.floor(Date.now() / 1000);
	if (raw === "ever") return "ever";
	if (raw === "never") return "never";

	return parseInt(raw, 10);
}

export const config = {
	discord: {
		token: require_env("DISCORD_TOKEN"),
		clientId: require_env("DISCORD_CLIENT_ID"),
	},
	database: {
		url: require_env("DATABASE_URL"),
		// Pool sizing: regra prática = (núcleos * 2) + 1
		poolMax: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
		poolIdleTimeout: 30_000,
		// Independente de NODE_ENV - managed Postgres (Heroku, RDS, Supabase...) geralmente exige SSL,
		// mas um Postgres local/self-hosted (incluindo o serviço do docker-compose) geralmente não tem.
		ssl: process.env.DATABASE_SSL === "true",
	},
	bot: {
		defaultPrefix: process.env.DEFAULT_PREFIX ?? "!",
		defaultCommandCategory: "Geral",

		deferredPrefixCommandMessage:
			process.env.DEFERRED_PREFIX_COMMAND_MESSAGE ?? "Processando...",

		env: process.env.NODE_ENV ?? "development",

		ownerIds:
			process.env.OWNER_IDS?.split(",")
				.map((id) => id.trim())
				.filter(Boolean) ?? [],
	},
	// Tudo opcional (undefined se não setado) - o cog zabbix é um módulo específico de uma
	// integração, não algo que toda instalação do bot precisa ter configurado pra subir.
	zabbix: {
		ingestPort: parseInt(process.env.MOD_ZABBIX_INGEST_PORT ?? "3001", 10),
		webhookPath: process.env.MOD_ZABBIX_WEBHOOK_PATH ?? "/webhook",
		webhookSecret: process.env.MOD_ZABBIX_WEBHOOK_SECRET,
		allowedHost: process.env.MOD_ZABBIX_ALLOWED_HOST ?? "zabbix.falevox.com.br",

		apiUrl: process.env.MOD_ZABBIX_API_URL,
		// URL do frontend (pra montar links de evento/host) - diferente da apiUrl, que aponta pro
		// api_jsonrpc.php.
		webUrl: process.env.MOD_ZABBIX_WEB_URL,
		apiUser: process.env.MOD_ZABBIX_API_USER,
		apiPassword: process.env.MOD_ZABBIX_API_PASSWORD,

		forumChannelId: process.env.MOD_ZABBIX_FORUM_CHANNEL_ID,

		reconciliationIntervalMs: parseInt(
			process.env.MOD_ZABBIX_RECONCILE_INTERVAL_MS ?? String(5 * 60_000),
			10,
		),
		reconcileSince: resolveReconcileSince(),
		// {EVENT.DATE}/{EVENT.TIME} etc vêm como texto puro, sem indicação de fuso - offset do
		// timezone que o PROCESSO do Zabbix Server usa pra montar essas macros (minutos, negativo
		// pra oeste de UTC). Confirmado ao vivo (log de diagnóstico em handleWebhook.ts, comparado
		// contra o horário real de chegada do webhook): esse servidor manda tudo em UTC (0), não em
		// horário de Brasília como a suposição original assumia - servidor, não frontend, o que
		// importa aqui. NÃO depende do timezone de onde o bot roda - por isso é explícito, não
		// `new Date()` cru.
		zabbixTzOffsetMinutes: parseInt(process.env.MOD_ZABBIX_TZ_OFFSET_MINUTES ?? "0", 10),
		archiveDelayMs: parseInt(
			process.env.MOD_ZABBIX_ARCHIVE_DELAY_MS ?? String(24 * 60 * 60_000),
			10,
		),
	},
	// Mesmos nomes de env var do módulo Python original (MOD_AUTOBLOQUEADOR_*) - não precisa
	// atualizar o .env de produção na migração.
	autobloqueador: {
		url: process.env.MOD_AUTOBLOQUEADOR_URL,
		token: process.env.MOD_AUTOBLOQUEADOR_TOKEN,
	},
} as const;

export type Config = typeof config;

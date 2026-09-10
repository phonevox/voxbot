import { Events } from "discord.js";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { config } from "@/config";
import { runModuleMigrations } from "@/database/migrate";
import type { Cog } from "@/types";
import { Logger } from "@/utils/logging";
import type { BotClient } from "./BotClient";

const logger = new Logger("core.cogloader");

// Rastreia os listeners de evento de cada cog pra poderem ser removidos no unload
const cogListeners = new Map<
	string,
	Array<{ event: string; handler: Function }>
>();

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CogLoadFailure {
	cog: string;
	error: string;
}

export interface LoadCogsResult {
	/** Chama `stop()` em cada cog carregado - pra desligamento gracioso. */
	stop: () => Promise<void>;
	/**
	 * Cogs que falharam ao carregar (já logados como warn/error aqui dentro) - um cog quebrado NÃO
	 * derruba o boot dos outros, mas quem chama isso interativamente (`!bot reload`) precisa saber
	 * que "recarreguei" não significa "recarreguei tudo com sucesso".
	 */
	failures: CogLoadFailure[];
}

/**
 * Carrega todos os cogs encontrados em `cogsPath` (um diretório = um cog).
 */
export async function loadCogs(
	client: BotClient,
	cogsPath: string,
): Promise<LoadCogsResult> {
	const entries = readdirSync(cogsPath);
	const failures: CogLoadFailure[] = [];

	for (const entry of entries) {
		const fullPath = join(cogsPath, entry);
		if (!statSync(fullPath).isDirectory()) continue;

		if (config.bot.disabledCogs.includes(entry)) {
			logger.info(`Cog "${entry}" pulado (DISABLED_COGS).`);
			continue;
		}

		await loadCog(client, cogsPath, entry).catch((err) => {
			const msg =
				err instanceof Error ? err.message.split("\n")[0] : String(err);
			logger.warn(`Falha ao carregar o cog "${entry}": ${msg}`);
			logger.error(err);
			failures.push({ cog: entry, error: msg });
		});
	}

	return {
		failures,
		stop: async () => {
			for (const [name, cog] of client.cogs) {
				await cog.stop?.(client)?.catch(() => {});
				logger.info(`Cog parado: ${name}`);
			}
		},
	};
}

/**
 * Carrega um único cog pelo nome, a partir de `cogsPath/<cogName>/index`.
 */
export async function loadCog(
	client: BotClient,
	cogsPath: string,
	cogName: string,
): Promise<Cog> {
	const fullPath = join(cogsPath, cogName, "index");

	clearRequireCache(fullPath);

	const imported = require(fullPath);
	const cog: Cog = imported.default ?? imported;

	await registerCog(client, cog);
	logger.info(`Cog carregado: ${cog.name}`);
	return cog;
}

/**
 * Descarrega um cog: para ele, remove seus comandos e listeners de evento.
 */
export async function unloadCog(
	client: BotClient,
	cogName: string,
): Promise<void> {
	const cog = client.cogs.get(cogName);
	if (!cog) throw new Error(`Cog "${cogName}" não está carregado.`);

	await cog.stop?.(client)?.catch(() => {});

	for (const cmd of cog.commands ?? []) {
		client.commands.delete(cmd.name);
	}

	const listeners = cogListeners.get(cogName) ?? [];
	for (const { event, handler } of listeners) {
		client.removeListener(event, handler as never);
	}
	cogListeners.delete(cogName);

	client.cogs.delete(cogName);
	logger.info(`Cog descarregado: ${cogName}`);
}

/**
 * Recarrega um cog (unload + load do disco).
 */
export async function reloadCog(
	client: BotClient,
	cogsPath: string,
	cogName: string,
): Promise<void> {
	if (!client.cogs.has(cogName))
		throw new Error(`Cog "${cogName}" não está carregado.`);

	await unloadCog(client, cogName);
	await loadCog(client, cogsPath, cogName);
	logger.info(`Cog recarregado: ${cogName}`);
}

// Arquivos com estado vivo que NÃO pode ser reinstanciado por baixo de quem já segura a
// referência: pool de conexão aberto (database/connection), transports de log com file handle
// aberto e o histograma de event loop rodando (utils/logging, utils/metrics), o config lido uma
// vez no boot (recalcular MOD_ZABBIX_RECONCILE_SINCE="start" de novo mudaria o corte pra "agora"),
// e a classe do client em si (nunca reinstanciada, só existe por consistência de `instanceof`).
// Ficam de fora da limpeza de cache do hotReloadBot - todo o resto de `src/` é resetado.
const HOT_RELOAD_KEEP_ALIVE = [
	"@/config",
	"@/database/connection",
	"@/utils/logging",
	"@/utils/metrics",
	"@/core/BotClient",
].map((p) => require.resolve(p));

/**
 * Hot reload do bot inteiro: descarrega todos os cogs (para eles com o código atual, ainda em
 * memória), limpa o require cache de TODO `src/` - exceto o `HOT_RELOAD_KEEP_ALIVE` acima - e
 * então re-registra tanto os listeners centrais (`registerCommandHandlers`, roteamento de
 * comando/guard/prefixo) quanto os cogs, tudo re-lido do disco. Diferente de `reloadCog`, que só
 * limpa o `index.ts` de UM cog: isso aqui pega mudança em qualquer arquivo do bot (um
 * `commands/*.ts`, o próprio CogLoader, guards, PrefixArgs) e também detecta cog novo (pasta criada
 * depois do boot) - sem reiniciar o processo.
 *
 * Depois de limpar o cache, `registerCommandHandlers`/`loadCogs` são pegos via `require()` dinâmico
 * (não os imports estáticos deste arquivo) de propósito: os imports estáticos ainda apontam pra
 * versão ANTIGA (capturada quando este módulo foi carregado); só um `require()` novo, depois do
 * cache limpo, força o Node a reexecutar o arquivo e devolver a versão atual do disco - inclusive
 * deste próprio CogLoader.ts, cujo `cogListeners` module-scoped precisa ser a MESMA instância que
 * fará o próximo load (e o próximo unload, no reload seguinte) pra não vazar listener.
 */
export async function hotReloadBot(
	client: BotClient,
	cogsPath: string,
): Promise<CogLoadFailure[]> {
	for (const name of [...client.cogs.keys()]) {
		await unloadCog(client, name).catch((err) => {
			logger.warn(
				`Falha ao descarregar o cog "${name}" antes do reload total: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	const srcRoot = join(__dirname, "..");
	const keepAlive = new Set(HOT_RELOAD_KEEP_ALIVE);
	for (const key of Object.keys(require.cache)) {
		if (key.startsWith(srcRoot) && !keepAlive.has(key))
			delete require.cache[key];
	}

	client.removeAllListeners(Events.MessageCreate);
	client.removeAllListeners(Events.InteractionCreate);

	const commandHandler =
		require("@/core/CommandHandler") as typeof import("./CommandHandler");
	commandHandler.registerCommandHandlers(client);

	const cogLoader = require("@/core/CogLoader") as typeof import("./CogLoader");
	const { failures } = await cogLoader.loadCogs(client, cogsPath);
	return failures;
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function registerCog(client: BotClient, cog: Cog): Promise<void> {
	if (cog.migrations?.length) {
		await runModuleMigrations(cog.name, cog.migrations);
	}

	for (const cmd of cog.commands ?? []) {
		client.commands.set(cmd.name, cmd);
	}

	const listeners: Array<{ event: string; handler: Function }> = [];

	for (const [event, handler] of Object.entries(cog.events ?? {})) {
		if (!handler) continue;
		const wrapped = (...args: unknown[]) =>
			(handler as Function)(client, ...args);
		client.on(event, wrapped as never);
		listeners.push({ event, handler: wrapped });
	}

	cogListeners.set(cog.name, listeners);
	client.cogs.set(cog.name, cog);

	if (cog.onReady) {
		const onReady = cog.onReady;
		if (client.isReady()) {
			await onReady(client)?.catch(() => {});
		} else {
			client.once(Events.ClientReady, () => onReady(client));
		}
	}

	await cog.start?.(client);
}

function clearRequireCache(fullPath: string): void {
	const resolved = require.resolve(fullPath);
	delete require.cache[resolved];
}

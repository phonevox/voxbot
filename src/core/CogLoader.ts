import { Events } from "discord.js";
import {
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
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

// De qual diretório-base cada cog carregado veio (`cogsPath` de verdade OU o sandbox do DCL) -
// `reloadCog`/`installCogFromSource` consultam isso pra saber de onde reler, mesmo quando o
// caller (ex: `!dcl reload <nome>`) só conhece o `cogsPath` real e não faz ideia de que aquele
// cog específico é runtime-only.
const cogOrigin = new Map<string, string>();

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

	cogOrigin.set(cog.name, cogsPath);
	await registerCog(client, cog);
	logger.info(`Cog carregado: ${cog.name}`);
	return cog;
}

/** De qual diretório-base um cog foi carregado - `undefined` se nunca foi carregado nesta sessão. */
export function getCogOrigin(cogName: string): string | undefined {
	return cogOrigin.get(cogName);
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
 * Recarrega um cog (unload + load do disco). Usa `getCogOrigin(cogName)` em vez de confiar cegamente
 * no `cogsPath` recebido - um cog instalado via `!dcl run` mora no sandbox do DCL, não em
 * `cogsPath`, e quem chama `reloadCog` (ex: `!dcl reload <nome>`) não tem como saber disso.
 */
export async function reloadCog(
	client: BotClient,
	cogsPath: string,
	cogName: string,
): Promise<void> {
	if (!client.cogs.has(cogName))
		throw new Error(`Cog "${cogName}" não está carregado.`);

	const basePath = cogOrigin.get(cogName) ?? cogsPath;
	await unloadCog(client, cogName);
	await loadCog(client, basePath, cogName);
	logger.info(`Cog recarregado: ${cogName}`);
}

export interface InstallCogResult {
	name: string;
	commands: number;
	/** true = já havia um cog com esse nome carregado em memória e ele foi substituído (não apagado). */
	overwritten: boolean;
}

const DCL_RUNTIME_DIRNAME = ".dcl-runtime";

/**
 * Diretório sandbox dos cogs instalados via `!dcl run` - IRMÃO de `cogsPath` (`src/modules`), não
 * filho dele, de propósito: `readdirSync(cogsPath)` (usado por `loadCogs`/`hotReloadBot` pra
 * reescanear tudo) nunca lista o que está aqui dentro. Isso é o que garante que um cog instalado
 * via DCL nunca "gruda" - some completamente num full reload ou restart do processo, sem exigir
 * nenhuma lista de exclusão.
 */
export function getDclRuntimeDir(cogsPath: string): string {
	return join(cogsPath, "..", DCL_RUNTIME_DIRNAME);
}

/**
 * Instala/atualiza um cog em RUNTIME a partir do código-fonte de um `index.ts` só (`!dcl run`) -
 * SEMPRE dentro do sandbox de `getDclRuntimeDir`, NUNCA em `cogsPath` (`src/modules`) de verdade.
 *
 * Escreve num diretório de staging (dentro do próprio sandbox) e EXIGE (não confia em
 * regex/texto) que `require()` + `defineCog()` realmente produzam um Cog válido antes de tocar em
 * qualquer estado do bot - se o require falhar (erro de sintaxe, sem `export default`, o que
 * for), nada do que já estava rodando é afetado, o staging é apagado e o erro sobe pro caller.
 *
 * "Overwrite" (`cog.name` já carregado, mesmo que seja um cog de verdade do repositório - zabbix,
 * core, etc) SÓ troca o que está em MEMÓRIA (`unloadCog` - remove comandos/listeners, não mexe em
 * arquivo nenhum). O `index.ts` real em `src/modules/<nome>`, se existir, NUNCA é lido, movido ou
 * apagado por esta função - ele continua exatamente como estava. Um full reload (`!bot reload`)
 * ou reiniciar o processo volta a carregar esse cog real do disco normalmente; a versão instalada
 * via DCL é esquecida (o sandbox inteiro é limpo no boot, ver `src/index.ts`).
 */
export async function installCogFromSource(
	client: BotClient,
	cogsPath: string,
	source: string,
): Promise<InstallCogResult> {
	const runtimeDir = getDclRuntimeDir(cogsPath);
	const stagingDir = join(runtimeDir, ".staging");
	const stagingIndex = join(stagingDir, "index");

	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	writeFileSync(`${stagingIndex}.ts`, source, "utf8");

	let cog: Cog;
	try {
		clearRequireCache(stagingIndex);
		const imported = require(stagingIndex);
		cog = imported.default ?? imported;
	} catch (err) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw err;
	}

	if (!cog || typeof cog.name !== "string" || !cog.name) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw new Error(
			'O arquivo não exportou um Cog válido - precisa de `export default defineCog({ name: "...", ... })`.',
		);
	}

	// Só em memória - o cog real em `cogsPath` (se o nome colidir com um) não é tocado.
	const overwritten = client.cogs.has(cog.name);
	if (overwritten) await unloadCog(client, cog.name);

	// Só dentro do sandbox - nunca em `cogsPath`.
	const finalDir = join(runtimeDir, cog.name);
	rmSync(finalDir, { recursive: true, force: true });
	renameSync(stagingDir, finalDir);

	const loaded = await loadCog(client, runtimeDir, cog.name);
	logger.info(
		`Cog instalado via DCL (runtime, ${runtimeDir}): ${loaded.name}${overwritten ? " (sobrescreveu a versão em memória)" : ""}`,
	);
	return {
		name: loaded.name,
		commands: loaded.commands?.length ?? 0,
		overwritten,
	};
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

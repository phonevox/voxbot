import { Events } from "discord.js";
import { readdirSync, statSync } from "fs";
import { join } from "path";
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

/**
 * Carrega todos os cogs encontrados em `cogsPath` (um diretório = um cog).
 * Retorna uma função de shutdown que chama `stop()` em cada cog carregado.
 */
export async function loadCogs(
	client: BotClient,
	cogsPath: string,
): Promise<() => Promise<void>> {
	const entries = readdirSync(cogsPath);

	for (const entry of entries) {
		const fullPath = join(cogsPath, entry);
		if (!statSync(fullPath).isDirectory()) continue;

		await loadCog(client, cogsPath, entry).catch((err) => {
			const msg =
				err instanceof Error ? err.message.split("\n")[0] : String(err);
			logger.warn(`Falha ao carregar o cog "${entry}": ${msg}`);
			logger.error(err);
		});
	}

	return async () => {
		for (const [name, cog] of client.cogs) {
			await cog.stop?.(client)?.catch(() => {});
			logger.info(`Cog parado: ${name}`);
		}
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

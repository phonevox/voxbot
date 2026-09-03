import { config as appConfig } from "../config";
import type { GuildConfig } from "../types";
import { TTLCache } from "../utils/cache";
import { query } from "./connection";

// ─── Guild Repository ─────────────────────────────────────────────────────────
// Camada de acesso a dados para configurações de guild.
// Padrão Repository: isola SQL dos handlers de comando.

/**
 * Busca configuração de uma guild. Cria com defaults se não existir.
 * UPSERT garante thread-safety sem race conditions.
 */
export async function getOrCreateGuild(guildId: string): Promise<GuildConfig> {
	const result = await query<GuildConfig>(
		`INSERT INTO guilds (id, prefix, settings)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
		[guildId, appConfig.bot.defaultPrefix, JSON.stringify({})],
	);
	return result.rows[0];
}

/**
 * Atualiza o prefix de uma guild.
 */
export async function updateGuildPrefix(
	guildId: string,
	prefix: string,
): Promise<void> {
	await query(
		`UPDATE guilds SET prefix = $1, updated_at = NOW() WHERE id = $2`,
		[prefix, guildId],
	);
}

/**
 * Faz merge das settings JSONB (merge parcial, não substitui tudo).
 * Ex: updateGuildSettings('123', { welcome_channel: '456' })
 */
export async function updateGuildSettings(
	guildId: string,
	settings: Record<string, unknown>,
): Promise<void> {
	await query(
		`UPDATE guilds
     SET settings = settings || $1::jsonb, updated_at = NOW()
     WHERE id = $2`,
		[JSON.stringify(settings), guildId],
	);
}

const prefixCache = new TTLCache<string, string>(5 * 60 * 1000);

export async function getGuildPrefix(guildId: string): Promise<string> {
	const cached = prefixCache.get(guildId);
	if (cached !== null) return cached;

	const guild = await getOrCreateGuild(guildId);
	prefixCache.set(guildId, guild.prefix);
	return guild.prefix;
}

export function invalidatePrefixCache(guildId: string): void {
	prefixCache.delete(guildId);
}

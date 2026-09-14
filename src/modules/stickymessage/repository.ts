import { query } from "@/database/connection";
import {
	getOrCreateGuild,
	updateGuildSettings,
} from "@/database/guildRepository";

export interface StickyMessageRow {
	channel_id: string;
	guild_id: string;
	content: string;
	color: number | null;
	created_by: string;
	updated_at: Date;
}

export const DEFAULT_COOLDOWN_MINUTES = 5;

export async function getByChannel(
	channelId: string,
): Promise<StickyMessageRow | null> {
	const res = await query<StickyMessageRow>(
		`SELECT * FROM sticky_messages WHERE channel_id = $1`,
		[channelId],
	);
	return res.rows[0] ?? null;
}

export async function listByGuild(
	guildId: string,
): Promise<StickyMessageRow[]> {
	const res = await query<StickyMessageRow>(
		`SELECT * FROM sticky_messages WHERE guild_id = $1 ORDER BY updated_at`,
		[guildId],
	);
	return res.rows;
}

/** null = canal já tinha uma sticky (não faz upsert - ver `edit`). */
export async function add(
	guildId: string,
	channelId: string,
	content: string,
	color: number | null,
	createdBy: string,
): Promise<StickyMessageRow | null> {
	const res = await query<StickyMessageRow>(
		`INSERT INTO sticky_messages (channel_id, guild_id, content, color, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id) DO NOTHING
         RETURNING *`,
		[channelId, guildId, content, color, createdBy],
	);
	return res.rows[0] ?? null;
}

/**
 * null = canal não tinha sticky ainda (não cria - ver `add`). `color: null` MANTÉM a cor já
 * configurada (não tem, ainda, como o comando pedir explicitamente "tira a cor") - só troca quando
 * vem um valor de verdade.
 */
export async function edit(
	channelId: string,
	content: string,
	color: number | null,
): Promise<StickyMessageRow | null> {
	const res = await query<StickyMessageRow>(
		`UPDATE sticky_messages SET content = $2, color = COALESCE($3, color), updated_at = NOW()
         WHERE channel_id = $1
         RETURNING *`,
		[channelId, content, color],
	);
	return res.rows[0] ?? null;
}

/** true = existia e foi removida. */
export async function remove(channelId: string): Promise<boolean> {
	const res = await query(`DELETE FROM sticky_messages WHERE channel_id = $1`, [
		channelId,
	]);
	return (res.rowCount ?? 0) > 0;
}

export async function removeByGuild(guildId: string): Promise<void> {
	await query(`DELETE FROM sticky_messages WHERE guild_id = $1`, [guildId]);
}

// ─── Cooldown (por guilda, não por canal/sticky - ver docs/adr/0002) ───────────

export async function getCooldownMinutes(guildId: string): Promise<number> {
	const res = await query<{ minutes: string | null }>(
		`SELECT settings->>'sticky_cooldown_minutes' AS minutes FROM guilds WHERE id = $1`,
		[guildId],
	);
	const raw = res.rows[0]?.minutes;
	return raw ? Number(raw) : DEFAULT_COOLDOWN_MINUTES;
}

export async function setCooldownMinutes(
	guildId: string,
	minutes: number,
): Promise<void> {
	await getOrCreateGuild(guildId); // garante que a linha existe antes do UPDATE em updateGuildSettings
	await updateGuildSettings(guildId, { sticky_cooldown_minutes: minutes });
}

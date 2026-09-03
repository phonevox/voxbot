import { query } from "@/database/connection";

// ─── Geradores ───────────────────────────────────────────────────────────────

export async function isGenerator(channelId: string): Promise<boolean> {
	const res = await query(`SELECT 1 FROM tc_generators WHERE channel_id = $1`, [
		channelId,
	]);
	return (res.rowCount ?? 0) > 0;
}

export async function addGenerator(
	guildId: string,
	channelId: string,
): Promise<void> {
	await query(
		`INSERT INTO tc_generators (guild_id, channel_id) VALUES ($1, $2) ON CONFLICT (channel_id) DO NOTHING`,
		[guildId, channelId],
	);
}

export async function removeGenerator(channelId: string): Promise<void> {
	await query(`DELETE FROM tc_generators WHERE channel_id = $1`, [channelId]);
}

export async function listGenerators(guildId: string): Promise<string[]> {
	const res = await query<{ channel_id: string }>(
		`SELECT channel_id FROM tc_generators WHERE guild_id = $1 ORDER BY created_at`,
		[guildId],
	);
	return res.rows.map((r) => r.channel_id);
}

// ─── Apelidos ─────────────────────────────────────────────────────────────────

export async function getApelido(
	guildId: string,
	userId: string,
): Promise<string | null> {
	const res = await query<{ name: string }>(
		`SELECT name FROM tc_apelidos WHERE guild_id = $1 AND user_id = $2`,
		[guildId, userId],
	);
	return res.rows[0]?.name ?? null;
}

export async function setApelido(
	guildId: string,
	userId: string,
	name: string,
): Promise<void> {
	await query(
		`INSERT INTO tc_apelidos (guild_id, user_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET name = $3, updated_at = NOW()`,
		[guildId, userId, name],
	);
}

export async function clearApelido(
	guildId: string,
	userId: string,
): Promise<void> {
	await query(`DELETE FROM tc_apelidos WHERE guild_id = $1 AND user_id = $2`, [
		guildId,
		userId,
	]);
}

export interface ApelidoRow {
	user_id: string;
	name: string;
}

export async function listApelidos(guildId: string): Promise<ApelidoRow[]> {
	const res = await query<ApelidoRow>(
		`SELECT user_id, name FROM tc_apelidos WHERE guild_id = $1 ORDER BY updated_at DESC`,
		[guildId],
	);
	return res.rows;
}

// ─── Canais temporários ────────────────────────────────────────────────────────────

export interface TempChannelRow {
	guild_id: string;
	channel_id: string;
	owner_id: string;
}

export async function isTempChannel(channelId: string): Promise<boolean> {
	const res = await query(`SELECT 1 FROM tc_channels WHERE channel_id = $1`, [
		channelId,
	]);
	return (res.rowCount ?? 0) > 0;
}

export async function addChannel(
	guildId: string,
	channelId: string,
	ownerId: string,
): Promise<void> {
	await query(
		`INSERT INTO tc_channels (guild_id, channel_id, owner_id) VALUES ($1, $2, $3)`,
		[guildId, channelId, ownerId],
	);
}

export async function removeChannel(channelId: string): Promise<void> {
	await query(`DELETE FROM tc_channels WHERE channel_id = $1`, [channelId]);
}

export async function listChannels(): Promise<TempChannelRow[]> {
	const res = await query<TempChannelRow>(
		`SELECT guild_id, channel_id, owner_id FROM tc_channels`,
	);
	return res.rows;
}

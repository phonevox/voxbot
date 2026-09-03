import { query } from "@/database/connection";

export async function isAuthorized(userId: string): Promise<boolean> {
	const res = await query(`SELECT 1 FROM ab_authorized_users WHERE user_id = $1`, [userId]);
	return (res.rowCount ?? 0) > 0;
}

/** true = autorizado agora. false = já estava autorizado (nada mudou). */
export async function addAuthorized(userId: string, addedBy: string): Promise<boolean> {
	const res = await query(
		`INSERT INTO ab_authorized_users (user_id, added_by) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
		[userId, addedBy],
	);
	return (res.rowCount ?? 0) > 0;
}

/** true = removido agora. false = já não estava autorizado. */
export async function removeAuthorized(userId: string): Promise<boolean> {
	const res = await query(`DELETE FROM ab_authorized_users WHERE user_id = $1`, [userId]);
	return (res.rowCount ?? 0) > 0;
}

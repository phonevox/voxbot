import { config } from "@/config";
import { query } from "@/database/connection";

/* Lista fechada de propósito - impede um typo em "dsn" virar um scope fantasma que nunca bate em
   nenhum check. Adicione aqui quando o módulo hostinger ganhar outra área (hosting, email...). */
export const SCOPES = ["dns", "all"] as const;
export type HostingerScope = (typeof SCOPES)[number];

export function isKnownScope(value: string): value is HostingerScope {
	return (SCOPES as readonly string[]).includes(value);
}

export function isBotOwner(userId: string): boolean {
	return config.bot.ownerIds.includes(userId);
}

export async function grant(
	userId: string,
	scope: HostingerScope,
	grantedBy: string,
): Promise<void> {
	await query(
		`INSERT INTO hostinger_permissions (user_id, scope, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, scope) DO UPDATE SET granted_by = $3, granted_at = NOW()`,
		[userId, scope, grantedBy],
	);
}

/** true = existia e foi removida. */
export async function revoke(
	userId: string,
	scope: HostingerScope,
): Promise<boolean> {
	const res = await query(
		`DELETE FROM hostinger_permissions WHERE user_id = $1 AND scope = $2`,
		[userId, scope],
	);
	return (res.rowCount ?? 0) > 0;
}

/** Bot owner sempre passa, sem precisar de grant explícito. scope 'all' cobre qualquer scope pedido. */
export async function hasScope(
	userId: string,
	scope: HostingerScope,
): Promise<boolean> {
	if (isBotOwner(userId)) return true;
	const res = await query(
		`SELECT 1 FROM hostinger_permissions WHERE user_id = $1 AND scope IN ($2, 'all') LIMIT 1`,
		[userId, scope],
	);
	return (res.rowCount ?? 0) > 0;
}

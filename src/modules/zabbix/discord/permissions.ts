import type { GuildMember } from "discord.js";
import { getOrCreateGuild } from "@/database/guildRepository";

/** Cargo configurado via `/zabbix config cargo-operador` - exigido pra Finalizar/Mensagem/severidade. */
export async function hasOperatorRole(member: GuildMember | null, guildId: string): Promise<boolean> {
	if (!member) return false;
	const guildConfig = await getOrCreateGuild(guildId);
	const roleId = guildConfig.settings.zabbix_operator_role_id as string | undefined;
	return !!roleId && member.roles.cache.has(roleId);
}

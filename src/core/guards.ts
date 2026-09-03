import type { GuildMember, User } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { config } from "../config";
import type { CommandDefinition } from "../types";

interface GuardContext {
	user: User;
	member: GuildMember | null;
}

export async function checkGuards(
	ctx: GuardContext,
	cmd: CommandDefinition,
): Promise<string | null> {
	if (cmd.botOwnerOnly && !config.bot.ownerIds.includes(ctx.user.id)) {
		return "Este comando é restrito aos meus desenvolvedores!";
	}

	if (cmd.allowedUsers?.length && !cmd.allowedUsers.includes(ctx.user.id)) {
		return "Você não tem permissão para usar este comando!";
	}

	if (
		cmd.adminOnly &&
		!ctx.member?.permissions.has(PermissionFlagsBits.Administrator)
	) {
		return "Este comando requer permissão de administrador!";
	}

	if (cmd.permissions?.length) {
		for (const perm of cmd.permissions) {
			if (!ctx.member?.permissions.has(perm)) {
				return "Você não tem as permissões necessárias para usar este comando.";
			}
		}
	}

	const requiredPerms = cmd.options?.toJSON().default_member_permissions;
	if (requiredPerms && !ctx.member?.permissions.has(BigInt(requiredPerms))) {
		return "Você não tem permissão para usar este comando.";
	}

	return null;
}

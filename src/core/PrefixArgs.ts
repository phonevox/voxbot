import type {
	Guild,
	GuildBasedChannel,
	GuildMember,
	Role,
	SlashCommandBuilder,
	SlashCommandOptionsOnlyBuilder,
	SlashCommandSubcommandsOnlyBuilder,
	User,
} from "discord.js";
import type { BotClient } from "./BotClient";

// ─── Derivação de schema ────────────────────────────────────────────────────────

type ArgType = "string" | "number" | "boolean" | "user" | "channel" | "role";

interface ArgSchema {
	name: string;
	type: ArgType;
	required: boolean;
}

interface SubcommandSchema {
	name: string;
	group: string | null;
	options: ArgSchema[];
}

const OPTION_TYPE_MAP: Record<number, ArgType | undefined> = {
	3: "string",
	4: "number",
	5: "boolean",
	6: "user",
	7: "channel",
	8: "role",
	10: "number",
};

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

type AnyBuilder =
	| SlashCommandBuilder
	| SlashCommandOptionsOnlyBuilder
	| SlashCommandSubcommandsOnlyBuilder;

type RawOption = {
	name: string;
	type: number;
	required?: boolean;
	options?: RawOption[];
};

/**
 * Deriva um schema de argumentos simples a partir de um builder (sem subcomandos).
 * Usado pelo CommandHandler para comandos normais.
 */
export function deriveSchema(builder: AnyBuilder): ArgSchema[] {
	const json = builder.toJSON() as { options?: RawOption[] };
	if (!json.options?.length) return [];
	return json.options.flatMap((opt): ArgSchema[] => {
		const type = OPTION_TYPE_MAP[opt.type];
		if (!type) return [];
		return [{ name: opt.name, type, required: opt.required ?? false }];
	});
}

function subcommandKey(group: string | null, name: string): string {
	return group ? `${group}:${name}` : name;
}

function optionsOf(opt: RawOption): ArgSchema[] {
	return (opt.options ?? []).flatMap((child): ArgSchema[] => {
		const type = OPTION_TYPE_MAP[child.type];
		if (!type) return [];
		return [{ name: child.name, type, required: child.required ?? false }];
	});
}

/**
 * Deriva um mapa de schemas de subcomando a partir de um builder.
 * Retorna um mapa indexado pelo nome do subcomando (ou `"<grupo>:<nome>"` para
 * subcomandos aninhados em um grupo) → seus schemas de argumentos.
 * Usado pelo PrefixArgs quando o builder tem subcomandos.
 */
export function deriveSubcommandSchema(
	builder: AnyBuilder,
): Map<string, SubcommandSchema> {
	const json = builder.toJSON() as { options?: RawOption[] };
	const map = new Map<string, SubcommandSchema>();
	if (!json.options?.length) return map;

	for (const opt of json.options) {
		if (opt.type === SUB_COMMAND) {
			map.set(subcommandKey(null, opt.name), {
				name: opt.name,
				group: null,
				options: optionsOf(opt),
			});
		} else if (opt.type === SUB_COMMAND_GROUP) {
			for (const sub of opt.options ?? []) {
				if (sub.type !== SUB_COMMAND) continue;
				map.set(subcommandKey(opt.name, sub.name), {
					name: sub.name,
					group: opt.name,
					options: optionsOf(sub),
				});
			}
		}
	}

	return map;
}

// ─── Resolução de ID ─────────────────────────────────────────────────────────────

function extractId(input: string, pattern: RegExp): string | null {
	const m = input.match(pattern);
	if (m) return m[1];
	if (/^\d{17,19}$/.test(input)) return input;
	return null;
}

// ─── PrefixArgs ───────────────────────────────────────────────────────────────

/**
 * Helper leve para argumentos de comandos de prefixo.
 *
 * Suporta dois modos:
 *
 * 1. Argumentos simples - o builder só tem options normais.
 *    `args.getString("message")` mapeia posicionalmente a partir do schema.
 *
 * 2. Modo subcomando - o builder tem .addSubcommand() e/ou .addSubcommandGroup().
 *    O primeiro token bruto é o nome do subcomando (ou grupo); os demais são seus argumentos.
 *    Para um subcomando agrupado, os dois primeiros tokens brutos são `<grupo> <subcomando>`.
 *    Use `args.getSubcommand()` / `args.getSubcommandGroup()` para pegar os nomes ativos.
 *    Os getters de argumento (`getString`, etc.) resolvem contra o schema do subcomando.
 *
 * O último argumento definido em um schema é sempre guloso (junta os tokens restantes).
 */
export class PrefixArgs {
	private readonly activeSchema: ArgSchema[];
	private readonly activeRaw: string[];
	private readonly _subcommand: string | null;
	private readonly _subcommandGroup: string | null;

	constructor(
		raw: string[],
		schema: ArgSchema[],
		private readonly guild: Guild | null,
		private readonly client: BotClient,
		subcommandMap?: Map<string, SubcommandSchema>,
	) {
		if (subcommandMap && subcommandMap.size > 0) {
			// Modo subcomando. Tenta um match agrupado primeiro (2 tokens: grupo + sub),
			// depois cai para um match simples (1 token).
			const first = raw[0]?.toLowerCase() ?? null;
			const second = raw[1]?.toLowerCase() ?? null;
			const grouped =
				first && second ? subcommandMap.get(`${first}:${second}`) : undefined;

			const sub = grouped ?? (first ? subcommandMap.get(first) : undefined);
			const consumed = grouped ? 2 : 1;

			this._subcommand = sub?.name ?? null;
			this._subcommandGroup = sub?.group ?? null;
			this.activeSchema = sub?.options ?? [];
			this.activeRaw = sub ? raw.slice(consumed) : raw.slice(1);
		} else {
			// Modo simples
			this._subcommand = null;
			this._subcommandGroup = null;
			this.activeSchema = schema;
			this.activeRaw = raw;
		}
	}

	/**
	 * Retorna o nome do subcomando ativo, ou null se não estiver em modo subcomando.
	 */
	getSubcommand(): string | null {
		return this._subcommand;
	}

	/**
	 * Retorna o nome do grupo do subcomando ativo, ou null se o subcomando
	 * encontrado não estiver aninhado em um grupo (espelha o
	 * `interaction.options.getSubcommandGroup(false)` do discord.js).
	 */
	getSubcommandGroup(): string | null {
		return this._subcommandGroup;
	}

	private getRaw(name: string): string | null {
		const idx = this.activeSchema.findIndex((a) => a.name === name);
		if (idx === -1) return null;
		// O último argumento é guloso - junta todos os tokens restantes
		if (idx === this.activeSchema.length - 1 && this.activeRaw.length > idx) {
			return this.activeRaw.slice(idx).join(" ") || null;
		}
		return this.activeRaw[idx] ?? null;
	}

	getString(name: string): string | null {
		return this.getRaw(name);
	}

	getNumber(name: string): number | null {
		const raw = this.getRaw(name);
		if (raw === null) return null;
		const n = Number(raw);
		return isNaN(n) ? null : n;
	}

	getBoolean(name: string): boolean | null {
		const raw = this.getRaw(name)?.toLowerCase();
		if (!raw) return null;
		if (["true", "1", "yes", "sim"].includes(raw)) return true;
		if (["false", "0", "no", "não", "nao"].includes(raw)) return false;
		return null;
	}

	async getUser(name: string): Promise<User | null> {
		const raw = this.getRaw(name);
		if (!raw) return null;
		const id = extractId(raw, /^<@!?(\d+)>$/);
		if (!id) return null;
		return (
			this.client.users.cache.get(id) ??
			(await this.client.users.fetch(id).catch(() => null))
		);
	}

	async getMember(name: string): Promise<GuildMember | null> {
		const raw = this.getRaw(name);
		if (!raw || !this.guild) return null;
		const id = extractId(raw, /^<@!?(\d+)>$/);
		if (!id) return null;
		return (
			this.guild.members.cache.get(id) ??
			(await this.guild.members.fetch(id).catch(() => null))
		);
	}

	async getChannel(name: string): Promise<GuildBasedChannel | null> {
		const raw = this.getRaw(name);
		if (!raw || !this.guild) return null;
		const id = extractId(raw, /^<#(\d+)>$/);
		if (!id) return null;
		return (
			this.guild.channels.cache.get(id) ??
			(await this.guild.channels.fetch(id).catch(() => null))
		);
	}

	async getRole(name: string): Promise<Role | null> {
		const raw = this.getRaw(name);
		if (!raw || !this.guild) return null;
		const id = extractId(raw, /^<@&(\d+)>$/);
		if (!id) return null;
		return (
			this.guild.roles.cache.get(id) ??
			(await this.guild.roles.fetch(id).catch(() => null))
		);
	}
}

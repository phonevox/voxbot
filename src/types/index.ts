import type {
	ChatInputCommandInteraction,
	ClientEvents,
	Message,
	PermissionResolvable,
	SlashCommandBuilder,
	SlashCommandOptionsOnlyBuilder,
	SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { BotClient } from "../core/BotClient";
import type { PrefixArgs } from "../core/PrefixArgs";

export { PrefixArgs } from "../core/PrefixArgs";

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum CommandCategory {
	GENERAL = "GENERAL",
	ADMIN = "ADMIN",
	MODERATION = "MODERATION",
	FUN = "FUN",
	UTILITY = "UTILITY",
	MUSIC = "MUSIC",
	ECONOMY = "ECONOMY",
}

// ─── Definição de comando ───────────────────────────────────────────────────────

export interface CommandDefinition {
	name: string;
	description: string;
	category?: CommandCategory;

	/**
	 * SlashCommandBuilder completo - usado no registro do slash command.
	 * Para comandos de prefixo, os nomes dos argumentos são derivados das options desse builder.
	 */
	options?:
		| SlashCommandBuilder
		| SlashCommandOptionsOnlyBuilder
		| SlashCommandSubcommandsOnlyBuilder;

	/** Se este comando aparece no !help */
	showOnHelp?: boolean;

	// ── Restrições ──────────────────────────────────────────────────────────
	botOwnerOnly?: boolean;
	adminOnly?: boolean;
	permissions?: PermissionResolvable[];
	allowedUsers?: string[];

	// ── Handlers ──────────────────────────────────────────────────────────────

	/**
	 * Handler do slash command.
	 * Recebe a interaction crua do discord.js - tipagem completa, sem wrapper.
	 */
	executeAsSlash?: (
		interaction: ChatInputCommandInteraction,
		client: BotClient,
	) => Promise<void>;

	/**
	 * Handler do comando de prefixo.
	 * Recebe a Message crua mais um helper PrefixArgs derivado do schema do builder.
	 */
	executeAsPrefix?: (
		message: Message,
		args: PrefixArgs,
		client: BotClient,
	) => Promise<void>;

	/**
	 * Atalho de conveniência - roda apenas como slash.
	 * Use isso para comandos simples que não precisam de tratamento específico de prefixo.
	 * Idêntico a executeAsSlash.
	 */
	execute?: (
		interaction: ChatInputCommandInteraction,
		client: BotClient,
	) => Promise<void>;
}

// ─── Cog (substitui ModuleDefinition) ─────────────────────────────────────────

export interface CogAuthor {
	name: string;
	id: bigint;
}

/**
 * Um Cog é uma unidade autocontida de funcionalidade do bot.
 * Cada pasta de módulo exporta um Cog padrão via `defineCog(...)`.
 */
export interface Cog {
	name: string;
	description: string;
	authors: CogAuthor[];
	commands?: CommandDefinition[];
	events?: {
		[K in keyof ClientEvents]?: (
			client: BotClient,
			...args: ClientEvents[K]
		) => void | Promise<void>;
	};
	/** Strings de migração SQL a rodar no carregamento */
	migrations?: string[];
	start?: (client: BotClient) => void | Promise<void>;
	stop?: (client: BotClient) => void | Promise<void>;
	onReady?: (client: BotClient) => void | Promise<void>;
}

// ─── Interface do registry ───────────────────────────────────────────────────────

export interface CommandRegistry {
	get(name: string): CommandDefinition | undefined;
	set(name: string, command: CommandDefinition): void;
	getAll(): CommandDefinition[];
}

export interface GuildConfig {
	id: string;
	prefix: string;
	settings: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

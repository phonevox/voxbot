import type { Cog, CommandDefinition } from "./types";

export type { PrefixArgs } from "./core/PrefixArgs";
export type {
	Cog,
	CogAuthor,
	CommandDefinition,
} from "./types";

const DEFAULT_COMMAND_FLAGS: Partial<CommandDefinition> = {
	showOnHelp: false,
};

export function defineCommand(def: CommandDefinition): CommandDefinition {
	// Sincroniza name/description com o SlashCommandBuilder
	if (def.options) {
		def.options.setName(def.name).setDescription(def.description);
	}

	// Liga execute → executeAsSlash
	if (def.execute && !def.executeAsSlash) {
		def.executeAsSlash = def.execute;
	}

	return { ...DEFAULT_COMMAND_FLAGS, ...def };
}

// o nome do cog deve ser o mesmo de module/<cog_name>
export function defineCog(cog: Cog): Cog {
	return cog;
}

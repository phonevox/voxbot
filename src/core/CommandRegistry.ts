import { config } from "@/config";
import type {
	CommandDefinition,
	CommandRegistry as ICommandRegistry,
} from "../types";

export class CommandRegistry implements ICommandRegistry {
	private readonly commands = new Map<string, CommandDefinition>();

	set(name: string, command: CommandDefinition): void {
		if (this.commands.has(name)) {
			throw new Error(`[CommandRegistry] Nome de comando duplicado: "${name}"`);
		}
		this.commands.set(name.toLowerCase(), command);
	}

	get(name: string): CommandDefinition | undefined {
		return this.commands.get(name.toLowerCase());
	}

	delete(name: string): boolean {
		return this.commands.delete(name.toLowerCase());
	}

	getAll(): CommandDefinition[] {
		return Array.from(this.commands.values());
	}

	getByCategory(): Map<string, CommandDefinition[]> {
		const categories = new Map<string, CommandDefinition[]>();
		for (const cmd of this.commands.values()) {
			const cat = cmd.category ?? config.bot.defaultCommandCategory;
			const list = categories.get(cat) ?? [];
			list.push(cmd);
			categories.set(cat, list);
		}
		return categories;
	}

	get size(): number {
		return this.commands.size;
	}
}

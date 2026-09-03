import dotenv from "dotenv";

dotenv.config({
	path: process.env.NODE_ENV === "production" ? ".env" : ".env.local",
});

import { Events } from "discord.js";
import { join } from "path";
import { config } from "./config";
import { BotClient } from "./core/BotClient";
import { loadCogs } from "./core/CogLoader";
import {
	registerCommandHandlers,
	registerSlashCommands,
} from "./core/CommandHandler";
import { closePool } from "./database/connection";
import { migrate } from "./database/migrate";
import { Logger } from "./utils/logging";

const logger = new Logger("core.bootstrap");
let stopCogs: () => Promise<void> = async () => {};

async function bootstrap(): Promise<void> {
	logger.info("Iniciando...");

	await migrate();

	const client = new BotClient();

	const cogsPath = join(__dirname, "modules");
	stopCogs = await loadCogs(client, cogsPath);

	registerCommandHandlers(client);

	await client.login(config.discord.token);

	client.once(Events.ClientReady, async () => {
		const guildId =
			config.bot.env === "development" ? process.env.DEV_GUILD_ID : undefined;

		await registerSlashCommands(client, guildId).catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
		});

		logger.info(`Bot pronto. ${client.commands.size} comando(s) carregado(s).`);
	});
}

async function shutdown(signal: string): Promise<void> {
	logger.info(`Sinal ${signal} recebido. Parando...`);
	await stopCogs();
	await closePool();
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
	logger.error(err instanceof Error ? err : new Error(String(err)));
});

bootstrap().catch((err) => {
	logger.error(err instanceof Error ? err : new Error(String(err)));
	process.exit(1);
});

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Cog } from "@/types";
import { Logger } from "@/utils/logging";
import { CommandRegistry } from "./CommandRegistry";

export class BotClient extends Client {
	public readonly commands: CommandRegistry;
	public readonly cogs = new Map<string, Cog>();

	private readonly logger = new Logger("core.botclient");

	constructor() {
		super({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.GuildVoiceStates,
			],
			partials: [Partials.Message, Partials.Channel],
		});

		this.commands = new CommandRegistry();
		this._setupBaseListeners();
	}

	private _setupBaseListeners(): void {
		this.once(Events.ClientReady, (c) => {
			this.logger.info(`Conectado como ${c.user.tag}`);
			this.logger.info(`Em ${c.guilds.cache.size} servidor(es)`);
		});
		this.on(Events.ShardReady, (id) => this.logger.info(`Shard ${id} pronto`));
		this.on(Events.ShardDisconnect, (e, id) =>
			this.logger.warn(`Shard ${id} desconectado (código ${e.code})`),
		);
		this.on(Events.ShardReconnecting, (id) =>
			this.logger.warn(`Shard ${id} reconectando...`),
		);
		this.on(Events.ShardResume, (id, n) =>
			this.logger.info(`Shard ${id} retomado (${n} eventos reproduzidos)`),
		);
		this.on(Events.ShardError, (err, id) =>
			this.logger.error(`Erro no shard ${id}: ${err.message}`),
		);
		this.on(Events.Invalidated, () =>
			this.logger.error("Sessão invalidada - o token pode ter sido revogado"),
		);
		this.rest.on("rateLimited", (info) =>
			this.logger.warn(
				`Rate limit em ${info.method} ${info.url} - nova tentativa em ${info.timeToReset}ms`,
			),
		);
		this.on(Events.Error, (err) => this.logger.error(err));
		this.on(Events.Warn, (warn) => this.logger.warn(warn));
		this.on(Events.Debug, (msg) => this.logger.debug(msg));
	}
}

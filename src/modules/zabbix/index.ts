import type { Server } from "node:http";
import { ChannelType } from "discord.js";
import { config } from "@/config";
import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import _zabbix from "./commands/zabbix";
import { handleZabbixButtons } from "./discord/buttons";
import { handleOperatorMessage } from "./discord/operatorCommands";
import { ensureSeverityTags } from "./discord/severity";
import { startArchiveJob, stopArchiveJob } from "./jobs/archiver";
import { reconcile, startReconciliationJob, stopReconciliationJob } from "./jobs/reconciliation";
import { startIngestServer } from "./http/server";
import { ZABBIX_SCHEMA } from "./migrations";

const logger = new Logger("zabbix");

let server: Server | null = null;

/** Variáveis de deploy obrigatórias pra integração funcionar de verdade (ver src/config/index.ts). */
function isConfigured(): boolean {
	return !!(
		config.zabbix.webhookSecret &&
		config.zabbix.apiUrl &&
		config.zabbix.apiUser &&
		config.zabbix.apiPassword &&
		config.zabbix.forumChannelId
	);
}

export default defineCog({
	name: "zabbix",
	description: "Ponte operacional entre o Zabbix e o Discord - 1 evento de trigger = 1 thread.",
	authors: [{ name: "masutty", id: 188851299255713792n }],

	commands: [_zabbix],
	migrations: [ZABBIX_SCHEMA],

	events: {
		// !ack/!finalizar/!sev viraram botões + select na primeira mensagem da thread (ver
		// discord/buttons.ts) - só !mensagem continua também por texto, além do botão "Mensagem".
		async interactionCreate(client, interaction) {
			await handleZabbixButtons(client, interaction).catch((err) => {
				logger.error(err instanceof Error ? err : new Error(String(err)));
			});
		},
		async messageCreate(client, message) {
			await handleOperatorMessage(client, message).catch((err) => {
				logger.error(err instanceof Error ? err : new Error(String(err)));
			});
		},
	},

	async start(client) {
		if (!isConfigured()) {
			logger.warn(
				"Integração com o Zabbix não está totalmente configurada (variáveis MOD_ZABBIX_* faltando) - " +
					"servidor de ingest e jobs não vão subir. Ver .dev/zabbix-module/CONTEXT.md.",
			);
			return;
		}

		server = startIngestServer(client);
		startReconciliationJob(client);
		startArchiveJob(client);

		// Cobre o caso do bot ter ficado fora do ar desde o último tick - reconcilia uma vez já no
		// arranque, não só espera o primeiro intervalo.
		reconcile(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
	},

	async stop() {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = null;
		}
		stopReconciliationJob();
		stopArchiveJob();
	},

	async onReady(client) {
		if (!config.zabbix.forumChannelId) return;

		const channel = await client.channels.fetch(config.zabbix.forumChannelId).catch(() => null);
		if (channel?.type === ChannelType.GuildForum) {
			await ensureSeverityTags(channel).catch((err) => {
				logger.error(err instanceof Error ? err : new Error(String(err)));
			});
		}
	},
});

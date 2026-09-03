import type { Client } from "discord.js";
import { config } from "@/config";
import { Logger } from "@/utils/logging";
import * as repo from "../repository";

const logger = new Logger("zabbix.archiver");

// Checa a cada 15min - a janela de espera em si (quanto tempo depois de resolvido) é que é
// configurável (config.zabbix.archiveDelayMs), essa aqui é só a frequência da varredura.
const CHECK_INTERVAL_MS = 15 * 60_000;

async function tick(client: Client): Promise<void> {
	const candidates = await repo.listArchivable(config.zabbix.archiveDelayMs);

	for (const event of candidates) {
		try {
			if (event.discord_thread_id) {
				const thread = await client.channels.fetch(event.discord_thread_id).catch(() => null);
				// Nunca tranca (setLocked) - uma recorrência do trigger sempre gera thread nova,
				// então não há "reabertura" pra perder.
				if (thread?.isThread() && !thread.archived) {
					await thread.setArchived(true);
				}
			}
			await repo.markArchived(event.zabbix_event_id);
		} catch (err) {
			logger.error(err instanceof Error ? err : new Error(String(err)));
		}
	}
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startArchiveJob(client: Client): void {
	if (intervalHandle) return;
	intervalHandle = setInterval(() => {
		tick(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
	}, CHECK_INTERVAL_MS);
}

export function stopArchiveJob(): void {
	if (intervalHandle) clearInterval(intervalHandle);
	intervalHandle = null;
}

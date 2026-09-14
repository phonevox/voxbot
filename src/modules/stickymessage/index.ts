import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import _stickymessage from "./commands/stickymessage";
import { STICKY_MESSAGE_SCHEMA } from "./migrations";
import { buildStickyMessage } from "./present";
import * as repo from "./repository";

const logger = new Logger("stickymessage");

const MAX_CONSECUTIVE_FAILURES = 3;

/* Estado só em memória, de propósito (ver docs/adr/0002): reseta num restart, o que na pior
   hipótese reposta uma vez a mais logo em seguida - inofensivo. O que precisa sobreviver a
   restart (o conteúdo da sticky em si) já está no Postgres. */
const lastRepostAt = new Map<string, number>();
const consecutiveFailures = new Map<string, number>();

function clearChannelState(channelId: string): void {
	lastRepostAt.delete(channelId);
	consecutiveFailures.delete(channelId);
}

export default defineCog({
	name: "stickymessage",
	description:
		"Mensagem que gruda no fim de um canal, reenviada por atividade.",
	authors: [{ name: "voxbot", id: 0n }],

	commands: [_stickymessage],
	migrations: [STICKY_MESSAGE_SCHEMA],

	events: {
		async messageCreate(_client, message) {
			if (message.author.bot || !message.guild) return;

			const sticky = await repo.getByChannel(message.channel.id);
			if (!sticky) return;

			const cooldownMs =
				(await repo.getCooldownMinutes(message.guild.id)) * 60_000;
			const last = lastRepostAt.get(message.channel.id) ?? 0;
			if (Date.now() - last < cooldownMs) return;

			// Marca antes de enviar - evita duas mensagens quase simultâneas disparando dois reenvios.
			lastRepostAt.set(message.channel.id, Date.now());

			if (!message.channel.isSendable()) return;
			try {
				await message.channel.send(
					buildStickyMessage(sticky.content, sticky.color),
				);
				consecutiveFailures.delete(message.channel.id);
			} catch (err) {
				logger.error(err instanceof Error ? err : new Error(String(err)), {
					channelId: message.channel.id,
				});
				const fails = (consecutiveFailures.get(message.channel.id) ?? 0) + 1;
				if (fails >= MAX_CONSECUTIVE_FAILURES) {
					await repo.remove(message.channel.id);
					clearChannelState(message.channel.id);
					logger.warn(
						`Sticky desativada no canal ${message.channel.id} após ${MAX_CONSECUTIVE_FAILURES} falhas de envio seguidas.`,
					);
				} else {
					consecutiveFailures.set(message.channel.id, fails);
				}
			}
		},

		async channelDelete(_client, channel) {
			clearChannelState(channel.id);
			await repo.remove(channel.id).catch((err) => {
				logger.error(err instanceof Error ? err : new Error(String(err)));
			});
		},

		async guildDelete(_client, guild) {
			await repo.removeByGuild(guild.id).catch((err) => {
				logger.error(err instanceof Error ? err : new Error(String(err)));
			});
		},
	},
});

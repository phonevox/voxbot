import type { GuildMember, VoiceBasedChannel, VoiceState } from "discord.js";
import { ChannelType } from "discord.js";
import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import _tempvc from "./commands/tempvc";
import { TEMP_CHANNELS_SCHEMA } from "./migrations";
import {
	addChannel,
	getApelido,
	isGenerator,
	isTempChannel,
	listChannels,
	removeChannel,
} from "./repository";

const logger = new Logger("tempvc");

export default defineCog({
	name: "tempvc",
	description:
		"Cria um canal de voz temporário quando alguém entra em um canal gerador.",
	authors: [{ name: "masutty", id: 188851299255713792n }],

	commands: [_tempvc],
	migrations: [TEMP_CHANNELS_SCHEMA],

	events: {
		async voiceStateUpdate(_client, oldState, newState) {
			await onVoiceStateUpdate(oldState, newState).catch((err) => {
				logger.error(err instanceof Error ? err : new Error(String(err)));
			});
		},
	},

	async onReady(client) {
		const rows = await listChannels();
		let dropped = 0;

		for (const row of rows) {
			const guild = client.guilds.cache.get(row.guild_id);
			const channel =
				guild?.channels.cache.get(row.channel_id) ??
				(await guild?.channels.fetch(row.channel_id).catch(() => null));

			// O canal sumiu, ou ainda existe mas ficou vazio durante o restart - de
			// qualquer forma não devia continuar rastreado (nem vivo).
			if (!channel || !channel.isVoiceBased()) {
				await removeChannel(row.channel_id);
				dropped++;
				continue;
			}

			if (channel.members.size === 0) {
				await removeChannel(row.channel_id);
				await channel.delete().catch(() => {});
				dropped++;
			}
		}

		logger.info(
			`Reconciliados ${rows.length} canal(is) temporário(s), ${dropped} descartado(s) por estarem obsoletos.`,
		);
	},
});

async function onVoiceStateUpdate(
	oldState: VoiceState,
	newState: VoiceState,
): Promise<void> {
	// Entrou em um canal gerador - cria um novo canal temporário pra ele.
	if (
		newState.channelId &&
		newState.channelId !== oldState.channelId &&
		(await isGenerator(newState.channelId))
	) {
		const generatorChannel =
			newState.channel ??
			(await newState.guild.channels
				.fetch(newState.channelId)
				.catch(() => null));
		const member =
			newState.member ??
			(await newState.guild.members.fetch(newState.id).catch(() => null));

		if (generatorChannel?.isVoiceBased() && member) {
			await createTempChannel(member, generatorChannel);
		}
	}

	// Saiu de um canal que agora está vazio - apaga, se for um canal nosso.
	if (oldState.channelId && oldState.channelId !== newState.channelId) {
		const leftChannel = oldState.channel;
		if (
			leftChannel &&
			leftChannel.members.size === 0 &&
			(await isTempChannel(leftChannel.id))
		) {
			await removeChannel(leftChannel.id);
			await leftChannel.delete().catch(() => {});
		}
	}
}

async function createTempChannel(
	member: GuildMember,
	generatorChannel: VoiceBasedChannel,
): Promise<void> {
	const apelido = await getApelido(member.guild.id, member.id);
	const name = apelido ?? `Canal de ${member.displayName}`;

	const channel = await member.guild.channels.create({
		name,
		type: ChannelType.GuildVoice,
		parent: generatorChannel.parentId,
	});

	await addChannel(member.guild.id, channel.id, member.id);
	await member.voice.setChannel(channel).catch(() => {
		logger.warn(
			`Não foi possível mover ${member.id} pro novo canal temporário ${channel.id}`,
		);
	});
}

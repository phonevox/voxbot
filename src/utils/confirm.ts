import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	ContainerBuilder,
	type Message,
	MessageFlags,
} from "discord.js";
import { EmbedFormatter, type FormattedReply } from "./format";
import { Logger } from "./logging";

const logger = new Logger("utils.confirm");

const CONFIRM_ID = "confirm-yes";
const CANCEL_ID = "confirm-no";

export interface ConfirmField {
	label: string;
	value: string;
}

export interface ConfirmPayload {
	flags: MessageFlags.IsComponentsV2;
	components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[];
}

/** Linha [Confirmar] [Cancelar] - customId fixo, sem conflito entre confirmações concorrentes
 * porque cada uma só escuta cliques na SUA própria mensagem (ver confirmAction). */
export function buildConfirmRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(CONFIRM_ID)
			.setLabel("Confirmar")
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId(CANCEL_ID)
			.setLabel("Cancelar")
			.setStyle(ButtonStyle.Danger),
	);
}

/** Container ComponentsV2 com o resumo da ação, um campo por linha - pronto pra ir junto de
 * `buildConfirmRow()` num mesmo `components: [...]`. */
export function buildConfirmContainer(
	title: string,
	fields: ConfirmField[],
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(0x5865f2);
	const lines = fields.map((f) => `- ${f.label}: \`${f.value}\``).join("\n");
	container.addTextDisplayComponents((td) =>
		td.setContent(`**${title}**\n${lines}`),
	);
	return container;
}

export interface ConfirmActionOptions {
	/** Só cliques desse usuário contam - qualquer outro recebe um "não é sua confirmação" efêmero
	 * e não conta pro timeout ocioso. */
	invokerId: string;
	/** Pergunta em negrito no topo do resumo (ex: "Remover esse registro?"). */
	title: string;
	/** Resumo da ação, um campo por linha (ex: tipo/subdomínio/domínio/destino). */
	fields: ConfirmField[];
	/**
	 * Manda o payload inicial (resumo + botões) e devolve a `Message` - `(p) => interaction.editReply(p)`
	 * numa interaction já deferida, ou `(p) => message.reply(p)` num comando de prefixo. Mesma
	 * convenção do `send`/`render` do `attachPagination` (ver pagination.ts).
	 */
	send: (payload: ConfirmPayload) => Promise<Message>;
	/** Só roda se o invocador clicar Confirmar. O retorno vira o novo conteúdo da mensagem. */
	onConfirm: () => Promise<FormattedReply>;
	/** Timeout OCIOSO (ms, padrão 20s) - resetado a cada clique do invocador, não por clique de terceiro. */
	timeoutMs?: number;
}

/**
 * Manda um resumo de ação com botões Confirmar/Cancelar (ComponentsV2) e só roda `onConfirm` se o
 * PRÓPRIO invocador confirmar - cancelar ou deixar expirar não roda nada. Generaliza o padrão
 * "invocador único + timeout ocioso" do `attachPagination` pra qualquer ação que precise de
 * confirmação antes de executar (DNS da Hostinger, e qualquer outro comando destrutivo no futuro).
 */
export async function confirmAction(opts: ConfirmActionOptions): Promise<void> {
	const {
		invokerId,
		title,
		fields,
		send,
		onConfirm,
		timeoutMs = 20_000,
	} = opts;

	const sent = await send({
		flags: MessageFlags.IsComponentsV2,
		components: [buildConfirmContainer(title, fields), buildConfirmRow()],
	});

	let handled = false;
	const collector = sent.createMessageComponentCollector({
		componentType: ComponentType.Button,
		idle: timeoutMs,
	});

	collector.on("collect", async (i) => {
		if (i.user.id !== invokerId) {
			await i
				.reply({ content: "Essa confirmação não é sua!", ephemeral: true })
				.catch(() => {});
			return;
		}

		handled = true;
		collector.stop();

		if (i.customId === CANCEL_ID) {
			await i.update(EmbedFormatter.warn("Ação cancelada.")).catch(() => {});
			return;
		}

		// `onConfirm` costuma bater numa API externa - pode passar dos ~3s que o Discord dá pra
		// reconhecer o clique, e aí `i.update()` direto falhava com "app não respondeu a tempo" (e
		// silencioso, porque o catch(() => {}) engolia o erro). `deferUpdate` reconhece na hora,
		// mantendo a mensagem como está, e libera pra editar com `editReply` só quando `onConfirm`
		// terminar - sem prazo.
		await i.deferUpdate().catch(() => {});
		try {
			await i.editReply(await onConfirm());
		} catch (err) {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			await i
				.editReply(EmbedFormatter.error("Erro ao executar a ação!"))
				.catch(() => {});
		}
	});

	collector.on("end", async () => {
		if (!handled) {
			await sent
				.edit(EmbedFormatter.warn("Confirmação expirou."))
				.catch(() => {});
		}
	});
}

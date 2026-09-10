import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	LabelBuilder,
	type Message,
	type MessageEditOptions,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";

const FIRST_ID = "pg-first";
const PREV_ID = "pg-prev";
const JUMP_ID = "pg-jump";
const NEXT_ID = "pg-next";
const LAST_ID = "pg-last";
const JUMP_INPUT_ID = "pagina";

/**
 * Linha [«] [‹] [pagina atual] [›] [»] - 5 botões, o máximo por ActionRow (se precisar de mais
 * alguma coisa aqui, essa linha já não tem espaço - precisaria de uma segunda linha). O do meio
 * mostra a página (em vez de um footer) e, clicado, abre um modal pra digitar o número direto (o
 * mais perto de um "campo numérico" que dá pra ter numa linha de botões - Discord não tem input
 * persistente fora de modal). «‹›» não são emoji, são pontuação Unicode comum (guillemets/ângulos),
 * não ASCII de verdade (isso é 0-127) mas o pedido original.
 * «/» pulam direto pra primeira/última página e DESABILITAM na borda correspondente; ‹/› (um passo)
 * continuam com wraparound (primeira página + ‹ vai pra última, e vice-versa).
 */
export function buildPaginationRow(
	page: number,
	pages: number,
): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(FIRST_ID)
			.setLabel("<<")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === 0),
		new ButtonBuilder()
			.setCustomId(PREV_ID)
			.setLabel("<")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(JUMP_ID)
			.setLabel(`${page + 1} / ${pages}`)
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(NEXT_ID)
			.setLabel(">")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(LAST_ID)
			.setLabel(">>")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === pages - 1),
	);
}

function buildJumpModal(pages: number): ModalBuilder {
	const input = new TextInputBuilder()
		.setCustomId(JUMP_INPUT_ID)
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setPlaceholder(`1-${pages}`)
		.setMaxLength(String(pages).length);
	return new ModalBuilder()
		.setCustomId(`${JUMP_ID}:${Date.now()}`)
		.setTitle("Ir para a página")
		.addComponents(
			new LabelBuilder()
				.setLabel(`Página (1-${pages})`)
				.setTextInputComponent(input),
		);
}

export interface AttachPaginationOptions {
	/** Só cliques desse usuário são aceitos - todo o resto recebe "não são seus" efêmero. */
	invokerId: string;
	pages: number;
	/** Padrão 60s, igual ao resto dos menus interativos do bot. */
	timeoutMs?: number;
	/**
	 * Recalcula o payload inteiro (`embeds`+`components` clássico OU `flags`+`components` V2) pra
	 * uma página - já deve incluir `buildPaginationRow(page, pages)` entre os components. Chamado
	 * com `interactive: false` quando o collector expira, pra reconstruir a mensagem SEM a linha de
	 * navegação (não dá pra só zerar `components` numa mensagem V2 - lá é onde mora o conteúdo
	 * inteiro, não só os botões).
	 */
	render: (page: number, interactive: boolean) => MessageEditOptions;
}

/** Prev/next com wraparound (primeira página + "<" vai pra última, e vice-versa) + pulo direto via modal. */
export function attachPagination(
	msg: Message,
	opts: AttachPaginationOptions,
): void {
	const { pages, invokerId, render, timeoutMs = 60_000 } = opts;
	let page = 0;

	const collector = msg.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: timeoutMs,
	});

	collector.on("collect", async (i) => {
		if (i.user.id !== invokerId) {
			await i
				.reply({ content: "Esses botões não são seus!", ephemeral: true })
				.catch(() => {});
			return;
		}

		if (i.customId === FIRST_ID) {
			page = 0;
			await i.update(render(page, true));
			return;
		}

		if (i.customId === PREV_ID) {
			page = page > 0 ? page - 1 : pages - 1;
			await i.update(render(page, true));
			return;
		}

		if (i.customId === NEXT_ID) {
			page = page < pages - 1 ? page + 1 : 0;
			await i.update(render(page, true));
			return;
		}

		if (i.customId === LAST_ID) {
			page = pages - 1;
			await i.update(render(page, true));
			return;
		}

		if (i.customId !== JUMP_ID) return;

		const modal = buildJumpModal(pages);
		await i.showModal(modal);
		const submitted = await i
			.awaitModalSubmit({
				time: timeoutMs,
				filter: (m) => m.customId === modal.data.custom_id,
			})
			.catch(() => null);
		if (!submitted?.isFromMessage()) return;

		const target = Number(submitted.fields.getTextInputValue(JUMP_INPUT_ID));
		if (!Number.isInteger(target) || target < 1 || target > pages) {
			await submitted
				.reply({
					content: `Digite um número entre 1 e ${pages}.`,
					ephemeral: true,
				})
				.catch(() => {});
			return;
		}
		page = target - 1;
		await submitted.update(render(page, true));
	});

	collector.on("end", async () => {
		await msg.edit(render(page, false)).catch(() => {});
	});
}

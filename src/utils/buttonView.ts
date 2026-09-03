import type { EmbedBuilder, Message } from "discord.js";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
} from "discord.js";
import { Logger } from "./logging";

const logger = new Logger("utils.buttonView");

/** `render()` deve ser puro/em memória (qualquer trabalho de DB pertence a antes, antes de chamar runButtonView) - nunca deve ser lento por conta própria. */
const SLOW_RENDER_MS = 250;
/** `respond()`/`i.update()` são round-trips da API do Discord - lentidão aqui é rede/lado do Discord, não nossa. */
const SLOW_ROUNDTRIP_MS = 1500;

/**
 * Um botão em um render de `runButtonView`. `next` calcula o estado pro qual transicionar quando
 * esse botão é clicado - cobre tanto paginação (`next: () => page + 1`) quanto abas nomeadas
 * (`next: () => "biomes"`) com a mesma primitiva.
 */
export interface ButtonViewButton<S> {
	customId: string;
	label?: string;
	emoji?: string;
	style?: ButtonStyle;
	disabled?: boolean;
	next: (state: S) => S;
}

export interface ButtonViewRender<S> {
	embeds: EmbedBuilder[];
	/** Cada array interno é uma linha (ActionRow, máx 5 botões); até 5 linhas - limite do próprio Discord. Omita ou deixe vazio para uma mensagem estática sem interação. */
	buttons?: ButtonViewButton<S>[][];
}

export interface RunButtonViewOptions<S> {
	/** Estado inicial (ex: número da página inicial, ou chave da aba inicial). */
	state: S;
	/** Só os cliques deste usuário são aceitos - todo o resto recebe uma resposta efêmera "not yours". */
	invokerId: string;
	respond: (payload: {
		embeds: EmbedBuilder[];
		components: ActionRowBuilder<ButtonBuilder>[];
	}) => Promise<Message>;
	/** Função pura: estado -> o que mostrar. Chamada no render inicial e após cada clique. */
	render: (state: S) => ButtonViewRender<S>;
	/** Padrão de 60s, igual ao resto dos menus interativos do bot. */
	timeoutMs?: number;
}

function buildRow<S>(
	buttons: ButtonViewButton<S>[],
): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		buttons.map((b) => {
			const btn = new ButtonBuilder()
				.setCustomId(b.customId)
				.setStyle(b.style ?? ButtonStyle.Secondary);
			if (b.label) btn.setLabel(b.label);
			if (b.emoji) btn.setEmoji(b.emoji);
			if (b.disabled) btn.setDisabled(true);
			return btn;
		}),
	);
}

function buttonRows<S>(render: ButtonViewRender<S>): ButtonViewButton<S>[][] {
	return (render.buttons ?? []).filter((row) => row.length > 0);
}

function componentsFor<S>(
	render: ButtonViewRender<S>,
): ActionRowBuilder<ButtonBuilder>[] {
	return buttonRows(render).map(buildRow);
}

/**
 * View genérica orientada a estado, guiada por botões: renderiza um embed + botões a partir de um
 * valor de estado, e a cada clique re-deriva estado/render a partir do botão clicado - sem
 * precisar configurar collector manualmente no call site. Cobre tanto paginação clássica (estado =
 * índice da página) quanto abas nomeadas (estado = chave da aba); veja `buildHistoryRow`/
 * `buildUserListRow` pra paginação bespoke pré-existente que eventualmente poderia migrar pra cá,
 * e `runProfileView` como exemplo de abas.
 */
export async function runButtonView<S>(
	opts: RunButtonViewOptions<S>,
): Promise<void> {
	let state = opts.state;

	const renderStart = Date.now();
	let current = opts.render(state);
	const renderMs = Date.now() - renderStart;

	const respondStart = Date.now();
	const msg = await opts.respond({
		embeds: current.embeds,
		components: componentsFor(current),
	});
	const respondMs = Date.now() - respondStart;
	logSlowness("initial", renderMs, respondMs);

	if (buttonRows(current).length === 0) return;

	const collector = msg.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: opts.timeoutMs ?? 60_000,
	});

	collector.on("collect", async (i) => {
		if (i.user.id !== opts.invokerId) {
			await i.reply({ content: "Esses botões não são seus!", ephemeral: true });
			return;
		}

		const clicked = buttonRows(current)
			.flat()
			.find((b) => b.customId === i.customId);
		if (!clicked) {
			await i.deferUpdate();
			return;
		}

		state = clicked.next(state);

		const clickRenderStart = Date.now();
		current = opts.render(state);
		const clickRenderMs = Date.now() - clickRenderStart;

		const updateStart = Date.now();
		await i.update({
			embeds: current.embeds,
			components: componentsFor(current),
		});
		const updateMs = Date.now() - updateStart;
		logSlowness(`click:${i.customId}`, clickRenderMs, updateMs);
	});

	collector.on("end", async () => {
		await msg.edit({ components: [] }).catch(() => {});
	});
}

/**
 * `renderMs` lento significa que nosso próprio código está fazendo trabalho inesperado em
 * `render()` (não devia acontecer - é pra ser puro/em memória). `roundtripMs` lento significa
 * API/rede do Discord, não nós - útil pra distinguir "isso é carga de DB" de "isso é só o Discord
 * sendo lento" rapidamente.
 */
function logSlowness(
	label: string,
	renderMs: number,
	roundtripMs: number,
): void {
	if (renderMs <= SLOW_RENDER_MS && roundtripMs <= SLOW_ROUNDTRIP_MS) return;
	logger.warn(
		`Button view lenta (${label}): render=${renderMs}ms discord_roundtrip=${roundtripMs}ms`,
	);
}

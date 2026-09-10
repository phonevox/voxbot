import type {
	ActionRowBuilder,
	ButtonBuilder,
	Client,
	Message,
} from "discord.js";
import {
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
} from "discord.js";
import { config } from "@/config";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import * as repo from "../repository";
import type { ZbxEventRow } from "../types";
import {
	describeAckAction,
	finalizarParams,
	mensagemParams,
	sevParams,
} from "../zabbix/acknowledge";
import {
	acknowledge,
	getEventDetails,
	getTriggerDescriptions,
	type ZabbixEventDetails,
} from "../zabbix/client";
import { hasOperatorRole } from "./permissions";
import { clampSeverity, severityColor, severityName } from "./severity";
import { buildActionRows } from "./template";
import { isResolved } from "./textHelpers";

const logger = new Logger("zabbix.operatorCommands");

/**
 * NÃO são comandos de verdade (sem slash, fora do CommandRegistry) - texto fixo, independente do
 * prefixo configurável da guild, só reconhecidos dentro de uma thread de evento.
 * Assumir/Finalizar/severidade viraram botões/select na primeira mensagem da thread (ver
 * discord/buttons.ts) - `!mensagem` voltou como atalho de texto além do botão "Interagir" (modal),
 * a pedido do usuário, e `!finalizar [mensagem]` na mesma pegada pro botão "Finalizar" (mensagem
 * opcional - o botão não tem como digitar uma), e `!sev <0-5> [mensagem]` de volta na mesma
 * pegada pro select de severidade. `!zabbix acoes` reposta os botões de ação num post novo, pra
 * não precisar rolar até a primeira mensagem da thread toda vez. `!zabbix detalhes` (ou só
 * `!detalhes`, atalho sem o prefixo `zabbix`) traz o estado atual + histórico de comentários
 * direto da API.
 */
const MENSAGEM_PATTERN = /^!mensagem\b\s*(.*)$/is;
const FINALIZAR_PATTERN = /^!finalizar\b\s*(.*)$/is;
const SEV_PATTERN = /^!sev\b\s*([0-5])\s*(.*)$/is;
const ACOES_PATTERN = /^!zabbix\s+acoes\b/is;
const DETALHES_PATTERN = /^!zabbix\s+detalhes\b|^!detalhes\b/is;

const HISTORY_PER_PAGE = 5;

async function handleMensagem(
	message: Message,
	event: ZbxEventRow,
	mensagem: string,
): Promise<void> {
	if (!message.guild) return;

	if (!(await hasOperatorRole(message.member, message.guild.id))) {
		await message.reply(
			EmbedFormatter.error(
				"Você não tem o cargo necessário pra comandos do Zabbix.",
			),
		);
		return;
	}

	if (!mensagem) {
		await message.reply(EmbedFormatter.warn("Uso: `!mensagem <texto>`."));
		return;
	}

	const actorMention = `@${message.author.username}`;

	try {
		await acknowledge(
			mensagemParams(event.zabbix_event_id, actorMention, mensagem),
		);
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await message.reply(
			EmbedFormatter.error("Não consegui falar com o Zabbix. Tente de novo."),
		);
		return;
	}

	await message.react("✅").catch(() => {});
}

/** Atalho de texto do botão "Finalizar" - mensagem opcional, o botão não tem como digitar uma. */
async function handleFinalizarCmd(
	message: Message,
	event: ZbxEventRow,
	mensagem: string,
): Promise<void> {
	if (!message.guild) return;

	if (!(await hasOperatorRole(message.member, message.guild.id))) {
		await message.reply(
			EmbedFormatter.error(
				"Você não tem o cargo necessário pra comandos do Zabbix.",
			),
		);
		return;
	}

	const actorMention = `@${message.author.username}`;

	try {
		await acknowledge(
			finalizarParams(
				event.zabbix_event_id,
				actorMention,
				mensagem || undefined,
			),
		);
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await message.reply(
			EmbedFormatter.error(
				"Não consegui finalizar isso no Zabbix. Tente de novo.",
			),
		);
		return;
	}

	await message.react("✅").catch(() => {});
}

/** Atalho de texto do select de severidade - mesma regra de "!ack" na mensagem do sevParams. */
async function handleSevCmd(
	message: Message,
	event: ZbxEventRow,
	severidade: number,
	mensagem: string,
): Promise<void> {
	if (!message.guild) return;

	if (!(await hasOperatorRole(message.member, message.guild.id))) {
		await message.reply(
			EmbedFormatter.error(
				"Você não tem o cargo necessário pra comandos do Zabbix.",
			),
		);
		return;
	}

	const actorMention = `@${message.author.username}`;

	try {
		await acknowledge(
			sevParams(
				event.zabbix_event_id,
				actorMention,
				severidade,
				mensagem || undefined,
			),
		);
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)));
		await message.reply(
			EmbedFormatter.error(
				"Não consegui mudar a severidade no Zabbix. Tente de novo.",
			),
		);
		return;
	}

	await message.react("✅").catch(() => {});
}

/** Sem checagem de cargo - só reposta os botões, não executa nenhuma ação por si (cada botão checa na hora do clique). */
async function handleAcoes(
	message: Message,
	event: ZbxEventRow,
): Promise<void> {
	if (!message.channel.isSendable()) return;

	let ownerLabel: string | undefined;
	if (event.owner_discord_id) {
		const owner = await message.client.users
			.fetch(event.owner_discord_id)
			.catch(() => null);
		ownerLabel = owner?.username ?? event.owner_discord_id;
	}

	await message.channel.send({
		content: "**Ações rápidas:**",
		components: buildActionRows(
			event.zabbix_event_id,
			event.zabbix_trigger_id,
			config.zabbix.webUrl ?? "",
			ownerLabel,
		),
	});
}

type DetalhesReply = {
	flags: MessageFlags.IsComponentsV2;
	components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[];
};

/**
 * Componente único: estado do evento (host/severidade/status/etc) + separador + uma página do
 * histórico de acks/comentários - paginado (`HISTORY_PER_PAGE` por página) em vez do corte fixo
 * "últimos N" de antes, que simplesmente escondia entradas mais antigas sem jeito de ver o resto.
 */
function buildDetalhesReply(
	details: ZabbixEventDetails,
	event: ZbxEventRow,
	description: string | undefined,
	page: number,
	interactive: boolean,
): DetalhesReply {
	const severity = clampSeverity(details.severity);
	const host = details.hosts[0]?.name ?? "desconhecido";
	const resolved = details.value === "0";

	const infoLines = [
		`**Host:** ${host}`,
		`**Severidade:** ${severityName(severity)}`,
		`**Status:** ${resolved ? "Resolvido" : details.acknowledged === "1" ? "Reconhecido" : "Aberto"}`,
		event.owner_discord_id
			? `**Responsável (Discord):** <@${event.owner_discord_id}>`
			: "",
		isResolved(details.opdata)
			? `**Dados operacionais:** ${details.opdata}`
			: "",
		isResolved(description) ? `**Descrição:** ${description}` : "",
		`**Aberto:** <t:${details.clock}:f>`,
		resolved && details.r_clock !== "0"
			? `**Resolvido:** <t:${details.r_clock}:f>`
			: "",
	].filter(Boolean);

	const sorted = [...(details.acknowledges ?? [])].sort(
		(a, b) => Number(a.clock) - Number(b.clock),
	);
	const pages = Math.max(1, Math.ceil(sorted.length / HISTORY_PER_PAGE));
	const clampedPage = Math.min(page, pages - 1);
	const slice = sorted.slice(
		clampedPage * HISTORY_PER_PAGE,
		(clampedPage + 1) * HISTORY_PER_PAGE,
	);
	const historyLines =
		sorted.length === 0
			? ["Nenhum comentário/ack registrado ainda."]
			: slice.map(
					(ack) =>
						`- <t:${ack.clock}:R> (${describeAckAction(Number(ack.action))}): ${ack.message || "_sem texto_"}`,
				);

	const container = new ContainerBuilder().setAccentColor(
		severityColor(severity),
	);
	container.addTextDisplayComponents((td) =>
		td.setContent(`## ${details.name}`),
	);
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
	container.addTextDisplayComponents((td) =>
		td.setContent(infoLines.join("\n")),
	);
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			`**Histórico (${sorted.length}):**\n${historyLines.join("\n")}`,
		),
	);
	if (pages > 1) {
		// V2 não tem footer de embed - isso faz as vezes dele.
		container.addTextDisplayComponents((td) =>
			td.setContent(`-# Página ${clampedPage + 1} de ${pages}`),
		);
	}

	const components: DetalhesReply["components"] = [container];
	if (interactive && sorted.length > HISTORY_PER_PAGE) {
		components.push(buildPaginationRow(clampedPage, pages));
	}

	return { flags: MessageFlags.IsComponentsV2, components };
}

/** Sem checagem de cargo - é só leitura, não muda nada no Zabbix. */
async function handleDetalhes(
	message: Message,
	event: ZbxEventRow,
): Promise<void> {
	const [details, triggerDescriptions] = await Promise.all([
		getEventDetails(event.zabbix_event_id).catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			return null;
		}),
		getTriggerDescriptions([event.zabbix_trigger_id]),
	]);

	if (!details) {
		await message.reply(
			EmbedFormatter.error(
				"Não consegui buscar os detalhes desse evento no Zabbix.",
			),
		);
		return;
	}

	const description = triggerDescriptions.get(event.zabbix_trigger_id);
	const pages = Math.max(
		1,
		Math.ceil((details.acknowledges ?? []).length / HISTORY_PER_PAGE),
	);
	const render = (page: number, interactive: boolean) =>
		buildDetalhesReply(details, event, description, page, interactive);

	const sent = await message.reply(render(0, pages > 1));
	if (pages <= 1) return;

	attachPagination(sent, { invokerId: message.author.id, pages, render });
}

export async function handleOperatorMessage(
	_client: Client,
	message: Message,
): Promise<void> {
	if (message.author.bot || !message.guild) return;

	const content = message.content.trim();

	if (ACOES_PATTERN.test(content) || DETALHES_PATTERN.test(content)) {
		const event = await repo.getEventByThreadId(message.channelId);
		if (!event) {
			await message.reply(
				EmbedFormatter.warn(
					"Isso só funciona dentro de uma thread de incidente do Zabbix.",
				),
			);
			return;
		}
		if (DETALHES_PATTERN.test(content)) await handleDetalhes(message, event);
		else await handleAcoes(message, event);
		return;
	}

	const mensagemMatch = MENSAGEM_PATTERN.exec(content);
	const finalizarMatch = FINALIZAR_PATTERN.exec(content);
	const sevMatch = SEV_PATTERN.exec(content);
	if (!mensagemMatch && !finalizarMatch && !sevMatch) return;

	// Fora de uma thread de evento, ignora em silêncio - "!mensagem"/"!finalizar"/"!sev" digitado
	// numa conversa qualquer não é um comando errado, é só texto normal.
	const event = await repo.getEventByThreadId(message.channelId);
	if (!event) return;

	if (mensagemMatch)
		await handleMensagem(message, event, mensagemMatch[1].trim());
	else if (finalizarMatch)
		await handleFinalizarCmd(message, event, finalizarMatch[1].trim());
	else if (sevMatch)
		await handleSevCmd(message, event, Number(sevMatch[1]), sevMatch[2].trim());
}

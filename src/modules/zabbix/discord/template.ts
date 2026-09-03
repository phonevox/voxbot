import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
} from "discord.js";
import type { EventClassification, WebhookPayload } from "../types";
import {
	RESOLVED_INDEX,
	SEVERITY_NAMES,
	UPDATE_COLOR,
	UPDATE_THUMB,
	clampSeverity,
	severityColor,
	severityName,
	severityThumb,
} from "./severity";
import {
	blockquote,
	bulletLine,
	humanDuration,
	isResolved,
	joinInline,
	joinLines,
	mdEscape,
	mdLink,
	relativeStamp,
	stringTruncate,
	translateUpdateAction,
	zbxToDate,
} from "./textHelpers";

/**
 * Porta do layout Components V2 de `.dev/zabbix-module/zabbix_mediatype_script.js` (só a parte de
 * evento de trigger - autoreg/discovery ficam de fora do escopo desta versão, ver
 * `handleWebhook.ts`). Um card só, três nomes exportados pra deixar explícito no call site qual
 * situação está sendo renderizada.
 */
export interface EventCard {
	flags: number;
	components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[];
}

export function buildProblemCard(payload: WebhookPayload): EventCard {
	return buildTriggerCard(payload, { isTrigger: true, isUpdate: false, isRecovery: false, isProblem: true });
}

export function buildUpdateCard(payload: WebhookPayload): EventCard {
	return buildTriggerCard(payload, { isTrigger: true, isUpdate: true, isRecovery: false, isProblem: false });
}

export function buildResolvedCard(payload: WebhookPayload): EventCard {
	return buildTriggerCard(payload, { isTrigger: true, isUpdate: false, isRecovery: true, isProblem: false });
}

function addLargeSeparator(container: ContainerBuilder): void {
	container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
}

function addText(container: ContainerBuilder, content: string): void {
	container.addTextDisplayComponents((td) => td.setContent(content));
}

export function assumirButton(eventId: string): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`zbx-assumir:${eventId}`).setLabel("Assumir").setStyle(ButtonStyle.Primary);
}

export function finalizarButton(eventId: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`zbx-finalizar:${eventId}`)
		.setLabel("Finalizar")
		.setStyle(ButtonStyle.Danger);
}

export function mensagemButton(eventId: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`zbx-mensagem:${eventId}`)
		.setLabel("Mensagem")
		.setStyle(ButtonStyle.Secondary);
}

/** Ack sem reivindicar posse - diferente de Assumir, não fica "de ninguém". Só no card inicial. */
export function reconhecerButton(eventId: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`zbx-reconhecer:${eventId}`)
		.setLabel("Reconhecer")
		.setStyle(ButtonStyle.Success);
}

/** Remove o reconhecimento - par do botão acima, repetível (nenhum dos dois se desabilita). */
export function desreconhecerButton(eventId: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`zbx-desreconhecer:${eventId}`)
		.setLabel("Desreconhecer")
		.setStyle(ButtonStyle.Danger);
}

/** Toolbar completa (os três botões de ação) - usada em `!zabbix acoes`. Os cards em si usam só
 * um subconjunto (ver `buildTriggerCard`), pra não ficar poluído toda vez que um evento atualiza. */
export function actionButtons(eventId: string): ButtonBuilder[] {
	return [assumirButton(eventId), finalizarButton(eventId), mensagemButton(eventId)];
}

export function severitySelectRow(eventId: string): ActionRowBuilder<StringSelectMenuBuilder> {
	const select = new StringSelectMenuBuilder()
		.setCustomId(`zbx-sev:${eventId}`)
		.setPlaceholder("Mudar severidade...")
		.addOptions(SEVERITY_NAMES.slice(0, 6).map((name, i) => ({ label: name, value: String(i) })));
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** Mesmo custom_id/estilo que `buttons.ts` usa quando alguém clica em Assumir - consistente nos dois lugares. */
function assumidoButton(label: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId("zbx-assumido")
		.setLabel(label)
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(true);
}

/**
 * Os dois lados da "toolbar" de ações, prontos pra postar sozinhos (`!zabbix acoes`). `ownerLabel`
 * (nome de quem já assumiu, se alguém já assumiu) desabilita o botão Assumir em vez de deixar
 * clicável de novo - senão dava pra "assumir" um incidente que já tem dono.
 */
export function buildActionRows(
	eventId: string,
	triggerId: string,
	zabbixUrl: string,
	ownerLabel?: string,
): [ActionRowBuilder<ButtonBuilder>, ActionRowBuilder<StringSelectMenuBuilder>] {
	const eventLink = `${zabbixUrl}/tr_events.php?triggerid=${triggerId}&eventid=${eventId}`;
	const assumir = ownerLabel ? assumidoButton(`Assumido por ${ownerLabel}`) : assumirButton(eventId);
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			linkButton("Ver no Zabbix", eventLink),
			assumir,
			finalizarButton(eventId),
			mensagemButton(eventId),
		),
		severitySelectRow(eventId),
	];
}

function linkButton(label: string, url: string): ButtonBuilder {
	return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
}

function buildTriggerCard(payload: WebhookPayload, classification: EventClassification): EventCard {
	const { isUpdate, isRecovery, isProblem } = classification;
	const nseverity = clampSeverity(payload.event_nseverity);

	const eventLink = `${payload.zabbix_url}/tr_events.php?triggerid=${payload.trigger_id}&eventid=${payload.event_id}`;
	const hostLine = mdEscape(payload.host_name);
	const opdata = isResolved(payload.event_opdata) ? stringTruncate(payload.event_opdata, 200) : "";

	let accent: number;
	let thumb: string;
	let sevLabel: string;

	if (isRecovery) {
		accent = severityColor(RESOLVED_INDEX);
		thumb = severityThumb(RESOLVED_INDEX);
		sevLabel = severityName(RESOLVED_INDEX);
	} else if (isUpdate) {
		// Branco e sem o ícone de severidade: uma atualização é uma anotação sobre o problema, não
		// um alarme novo. A severidade real continua reportada no bullet mais abaixo (quando houver).
		accent = UPDATE_COLOR;
		thumb = UPDATE_THUMB;
		sevLabel = severityName(nseverity);
	} else {
		accent = severityColor(nseverity);
		thumb = severityThumb(nseverity);
		sevLabel = severityName(nseverity);
	}

	const container = new ContainerBuilder().setAccentColor(accent);

	container.addSectionComponents((section) => {
		section.addTextDisplayComponents((td) =>
			td.setContent(`## ${mdLink(stringTruncate(mdEscape(payload.event_name), 200), eventLink)}`),
		);
		section.addTextDisplayComponents((td) =>
			td.setContent(`### ${stringTruncate(hostLine, 120)}\n-# [${payload.host_ip ?? ""}]`),
		);
		if (thumb) section.setThumbnailAccessory((t) => t.setURL(thumb));
		return section;
	});
	addLargeSeparator(container);

	// Bloco da atualização, antes dos dados do problema - o comentário do atendente fica sozinho
	// entre dois separadores, sem disputar atenção com severidade/dados abaixo (fora no update).
	if (isUpdate) {
		const actor = isResolved(payload.event_update_user) ? payload.event_update_user : "Alguém";
		let updateText = `- **${mdEscape(actor)}** ${stringTruncate(translateUpdateAction(payload.event_update_action), 300)}`;
		if (isResolved(payload.event_update_message)) {
			updateText += `\n${blockquote(stringTruncate(payload.event_update_message, 800))}`;
		}
		addText(container, updateText);
		addLargeSeparator(container);
	}

	// Descrição do trigger só no problema novo - em update e recuperação ela repetiria algo já dito.
	if (isProblem && isResolved(payload.trigger_description)) {
		addText(container, stringTruncate(payload.trigger_description, 800));
		addLargeSeparator(container);
	}

	// No update, severidade e dados operacionais são o instantâneo do disparo original - a
	// atualização é sobre o que a pessoa fez, não sobre esses números de novo.
	const dataLines: string[] = [];
	if (!isUpdate) {
		dataLines.push(bulletLine("Severidade", sevLabel, false));
		if (opdata) dataLines.push(bulletLine("Dados operacionais", opdata, true));
	}
	if (isRecovery) {
		const start = zbxToDate(payload.event_date, payload.event_time);
		const end = zbxToDate(payload.event_recovery_date, payload.event_recovery_time);
		if (start && end) {
			const dur = humanDuration(end.getTime() - start.getTime());
			if (dur) dataLines.push(bulletLine("Duração", dur, true));
		}
	}
	if (dataLines.length > 0) {
		addText(container, joinLines(dataLines));
		addLargeSeparator(container);
	}

	let stampDate: Date | null;
	if (isUpdate) stampDate = zbxToDate(payload.event_update_date, payload.event_update_time);
	else if (isRecovery) stampDate = zbxToDate(payload.event_recovery_date, payload.event_recovery_time);
	else stampDate = zbxToDate(payload.event_date, payload.event_time);

	addText(
		container,
		`-# ${joinInline(
			[
				`ID: ${payload.event_id}`,
				payload.host_uid ? `HUID: ${payload.host_uid}` : "",
				isResolved(payload.event_tags) ? stringTruncate(payload.event_tags, 200) : "",
				relativeStamp(stampDate),
			],
			" // ",
		)}`,
	);

	// Padronizado: problema novo = Ver no Zabbix, Mensagem, Assumir, Reconhecer, Desreconhecer (5,
	// no limite da ActionRow). Update/resolução = só Ver no Zabbix, Mensagem - Finalizar e mudar
	// severidade ficam pro `!zabbix acoes` (toolbar completa), pra não poluir toda vez que o evento atualiza.
	const buttons: ButtonBuilder[] = [linkButton("Ver no Zabbix", eventLink), mensagemButton(payload.event_id)];
	if (isProblem) {
		buttons.push(
			assumirButton(payload.event_id),
			reconhecerButton(payload.event_id),
			desreconhecerButton(payload.event_id),
		);
	}

	const components: EventCard["components"] = [container];
	if (buttons.length > 0) {
		components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
	}

	// Select de severidade, linha própria (Discord não deixa misturar select com botão na mesma
	// ActionRow) - só na primeira mensagem, igual os botões de ação.
	if (isProblem) components.push(severitySelectRow(payload.event_id));

	// Só o problema novo notifica - a flag cala a notificação do canal pra quem o segue.
	const flags = isProblem
		? MessageFlags.IsComponentsV2
		: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications;

	return { flags, components };
}

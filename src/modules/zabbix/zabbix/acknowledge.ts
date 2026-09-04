import type { AckParams } from "../types";

/**
 * Bitmask de `action` do `event.acknowledge` (Zabbix 5.0). Único lugar do módulo que conhece
 * esses bits - `operatorCommands.ts` e `assumirButton.ts` só chamam as funções abaixo.
 */
export const ACK_BITS = {
	CLOSE: 1,
	ACKNOWLEDGE: 2,
	ADD_MESSAGE: 4,
	CHANGE_SEVERITY: 8,
	UNACKNOWLEDGE: 16,
	SUPPRESS: 32,
	UNSUPPRESS: 64,
} as const;

/**
 * Mensagens digitadas por operador ganham esse prefixo - é o único lugar onde a autoria real fica
 * registrada (a chamada à API em si usa a conta de serviço única do bot, não o usuário).
 */
function userComment(actorMention: string, text: string): string {
	return `[${actorMention}] ${text}`;
}

/** Botão "Reconhecer" (verde) - ack sem reivindicar posse, diferente de Assumir. */
export function reconhecerParams(eventId: string, actorMention: string): AckParams {
	return {
		eventId,
		bits: ACK_BITS.ACKNOWLEDGE | ACK_BITS.ADD_MESSAGE,
		message: `Reconhecido por ${actorMention}`,
	};
}

/** Botão "Desreconhecer" (vermelho) - remove o reconhecimento. */
export function desreconhecerParams(eventId: string, actorMention: string): AckParams {
	return {
		eventId,
		bits: ACK_BITS.UNACKNOWLEDGE | ACK_BITS.ADD_MESSAGE,
		message: `Reconhecimento removido por ${actorMention}`,
	};
}

export function mensagemParams(
	eventId: string,
	actorMention: string,
	mensagem: string,
): AckParams {
	return { eventId, bits: ACK_BITS.ADD_MESSAGE, message: userComment(actorMention, mensagem) };
}

export interface FormOptions {
	mensagem?: string;
	/** undefined = não alterar. */
	severidade?: number;
	/** undefined = não alterar. */
	reconhecer?: "sim" | "nao";
	encerrar?: boolean;
}

/**
 * Combina os campos do modal "Ações" (mensagem + severidade + reconhecer + encerrar) num só
 * `event.acknowledge` - cada campo em branco/"não alterar" simplesmente não liga o bit
 * correspondente. Mensagem digitada tem prioridade sobre o texto autogerado; sem mensagem mas com
 * alguma ação marcada, gera um resumo curto (precisa do bit ADD_MESSAGE pra a ação ficar
 * registrada no histórico, mesma pegadinha das outras funções acima).
 */
export function formParams(eventId: string, actorMention: string, opts: FormOptions): AckParams {
	let bits = 0;
	const autoParts: string[] = [];

	if (opts.severidade !== undefined) bits |= ACK_BITS.CHANGE_SEVERITY;

	if (opts.reconhecer === "sim") {
		bits |= ACK_BITS.ACKNOWLEDGE;
		autoParts.push("reconheceu");
	} else if (opts.reconhecer === "nao") {
		bits |= ACK_BITS.UNACKNOWLEDGE;
		autoParts.push("removeu o reconhecimento");
	}

	if (opts.encerrar) {
		bits |= ACK_BITS.CLOSE;
		autoParts.push("encerrou");
	}

	let message: string | undefined;
	if (opts.mensagem) {
		bits |= ACK_BITS.ADD_MESSAGE;
		message = userComment(actorMention, opts.mensagem);
	} else if (autoParts.length > 0) {
		bits |= ACK_BITS.ADD_MESSAGE;
		message = `${actorMention} ${autoParts.join(", ")}.`;
	}

	return { eventId, bits, severity: opts.severidade, message };
}

/** Mensagem opcional (só o `!finalizar` de texto passa uma - o botão continua sem argumento). */
export function finalizarParams(eventId: string, actorMention: string, mensagem?: string): AckParams {
	const base = `Finalizado por ${actorMention}`;
	return {
		eventId,
		bits: ACK_BITS.CLOSE | ACK_BITS.ADD_MESSAGE,
		message: mensagem ? `${base}: ${mensagem}` : base,
	};
}

/**
 * Muda severidade sempre; só ackeia também (bit 2) se a mensagem digitada contiver literalmente
 * "!ack" - proposital (combo `!sev 0 revisado, !ack` num comando só), confirmado com o usuário.
 */
export function sevParams(
	eventId: string,
	actorMention: string,
	severidade: number,
	mensagem: string | undefined,
): AckParams {
	let bits: number = ACK_BITS.CHANGE_SEVERITY;
	let message: string | undefined;

	if (mensagem) {
		bits |= ACK_BITS.ADD_MESSAGE;
		message = userComment(actorMention, mensagem);
		if (mensagem.includes("!ack")) bits |= ACK_BITS.ACKNOWLEDGE;
	}

	return { eventId, bits, severity: severidade, message };
}

/**
 * Mesmo bit do `!ack` - assumir e ackar são a mesma ação, vista de dois lados. Precisa do bit
 * ADD_MESSAGE também, senão o Zabbix aceita o ack e descarta o texto em silêncio (mesma pegadinha
 * de bitmask que `!mensagem`/`!sev` já tratam certo - essa aqui tinha ficado faltando).
 */
export function assumirParams(eventId: string, actorMention: string): AckParams {
	return {
		eventId,
		bits: ACK_BITS.ACKNOWLEDGE | ACK_BITS.ADD_MESSAGE,
		message: `Assumido por ${actorMention}`,
	};
}

/** Inverso do bitmask - descreve o que um ack do histórico fez, pra `!zabbix detalhes`. */
export function describeAckAction(bits: number): string {
	const parts: string[] = [];
	if (bits & ACK_BITS.CLOSE) parts.push("fechou");
	if (bits & ACK_BITS.ACKNOWLEDGE) parts.push("reconheceu");
	if (bits & ACK_BITS.ADD_MESSAGE) parts.push("comentou");
	if (bits & ACK_BITS.CHANGE_SEVERITY) parts.push("mudou severidade");
	if (bits & ACK_BITS.UNACKNOWLEDGE) parts.push("removeu reconhecimento");
	if (bits & ACK_BITS.SUPPRESS) parts.push("suprimiu");
	if (bits & ACK_BITS.UNSUPPRESS) parts.push("removeu supressão");
	return parts.length > 0 ? parts.join(", ") : "atualizou";
}

/** Converte para o formato que `event.acknowledge` espera na API do Zabbix. */
export function toApiParams(params: AckParams): Record<string, unknown> {
	const out: Record<string, unknown> = { eventids: [params.eventId], action: params.bits };
	if (params.message !== undefined) out.message = params.message;
	if (params.severity !== undefined) out.severity = params.severity;
	return out;
}

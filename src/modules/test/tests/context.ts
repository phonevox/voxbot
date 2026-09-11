import type {
	ActionRowBuilder,
	ButtonBuilder,
	ContainerBuilder,
	Message,
	MessageFlags,
} from "discord.js";

/** Igual a `FormattedReply`, mas aceita também a linha de botões da pagination entre os
 * components (`FormattedReply` sozinho só permite `ContainerBuilder[]`). */
export interface SendableReply {
	flags: MessageFlags.IsComponentsV2;
	components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[];
}

/** Só o que um teste precisa pra mandar mensagens - não sabe se veio de slash ou prefix. */
export interface TestContext {
	/** Quem chamou o teste - pra pagination/botões filtrarem cliques de outra pessoa. */
	invokerId: string;
	send(reply: SendableReply): Promise<Message>;
}

export type TestFn = (ctx: TestContext) => Promise<void> | void;

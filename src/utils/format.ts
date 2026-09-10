import { ContainerBuilder, MessageFlags } from "discord.js";

export function formatTime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);

	return (
		[d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`]
			.filter(Boolean)
			.join(" ") || "?s"
	);
}

export function formatCodeblock(
	code: string,
	language: string = "txt",
): string {
	return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Desfaz um bloco de código markdown, se o texto INTEIRO estiver envolto num - devolve cru senão.
 * Só olha a borda externa (início/fim do texto), não o primeiro/próximo ``` que aparecer - assim
 * não se confunde quando o próprio conteúdo tem um bloco de código embutido (ex: um JSON cujo
 * valor de campo é `"```txt\n...\n```"`, que um regex "não-guloso" cortaria no lugar errado).
 */
export function extractCodeBlock(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;

	const withoutOpenFence = trimmed.replace(/^```\w*\n?/, "");
	const closeIdx = withoutOpenFence.lastIndexOf("```");
	return (
		closeIdx === -1 ? withoutOpenFence : withoutOpenFence.slice(0, closeIdx)
	).trim();
}

/** Segundos Unix para uma Date, para usar em timestamp tags do Discord (`<t:...:F>` etc). */
export function unix(date: Date): number {
	return Math.floor(date.getTime() / 1000);
}

/** Já é o payload inteiro de reply/send - `await message.reply(EmbedFormatter.error(msg))`, sem embrulhar em `{ embeds: [...] }`. */
export interface FormattedReply {
	components: ContainerBuilder[];
	flags: MessageFlags.IsComponentsV2;
}

export interface FormattedReplyOptions {
	/** Emoji do tipo numa linha própria, acima da mensagem. Padrão: `true`. */
	emoji?: boolean;
}

function statusReply(
	accent: number,
	emoji: string,
	msg: string,
	{ emoji: showEmoji = true }: FormattedReplyOptions = {},
): FormattedReply {
	const container = new ContainerBuilder().setAccentColor(accent);
	if (showEmoji)
		container.addTextDisplayComponents((td) => td.setContent(emoji));
	container.addTextDisplayComponents((td) => td.setContent(msg));
	return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export const EmbedFormatter = {
	error: (msg: string, options?: FormattedReplyOptions) =>
		statusReply(0xff0000, "❌", msg, options),
	success: (msg: string, options?: FormattedReplyOptions) =>
		statusReply(0x57f287, "✅", msg, options),
	info: (msg: string, options?: FormattedReplyOptions) =>
		statusReply(0x5865f2, "ℹ️", msg, options),
	warn: (msg: string, options?: FormattedReplyOptions) =>
		statusReply(0xffff00, "⚠️", msg, options),
};

export function roleMention(id: string): string {
	return `<@&${id}>`;
}

export function channelMention(id: string): string {
	return `<#${id}>`;
}

export function userMention(id: string): string {
	return `<@${id}>`;
}

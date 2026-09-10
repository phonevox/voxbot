import type { Message } from "discord.js";

/** Baixa o primeiro anexo de uma mensagem como texto - `null` se não tiver anexo. */
export async function fetchAttachmentText(
	msg: Message,
): Promise<string | null> {
	const attachment = msg.attachments.first();
	if (!attachment) return null;

	const res = await fetch(attachment.url);
	if (!res.ok) throw new Error(`Falha ao baixar o anexo (HTTP ${res.status}).`);
	return res.text();
}

/**
 * Resolve de onde vem o payload de texto de um comando de prefixo "cole aqui ou anexe um arquivo"
 * (`!embed`, `!bot cog-dcl`): anexo na própria mensagem primeiro, depois o texto dela (com
 * `prefixPattern` já cortado fora), depois - se nenhum dos dois - a mensagem respondida (anexo
 * dela ou texto dela), na mesma ordem.
 */
export async function resolveMessageSource(
	message: Message,
	prefixPattern: RegExp,
): Promise<string> {
	const ownAttachment = await fetchAttachmentText(message);
	if (ownAttachment !== null) return ownAttachment;

	const ownText = message.content.replace(prefixPattern, "").trim();
	if (ownText) return ownText;

	if (!message.reference?.messageId) return "";
	const replied = await message.channel.messages
		.fetch(message.reference.messageId)
		.catch(() => null);
	if (!replied) return "";

	const repliedAttachment = await fetchAttachmentText(replied);
	if (repliedAttachment !== null) return repliedAttachment;

	return replied.content.replace(prefixPattern, "").trim();
}

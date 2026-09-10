import type {
	APIEmbed,
	APIMessageTopLevelComponent,
	Message,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { config } from "@/config";
import { getGuildPrefix } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, extractCodeBlock } from "@/utils/format";

interface EmbedPayload {
	content?: string;
	embeds?: APIEmbed[];
	components?: APIMessageTopLevelComponent[];
}

// Types de component exclusivos do Components V2 (Section, Text Display, Thumbnail, Media
// Gallery, File, Separator, Container) - ver https://discord.com/developers/docs/components/reference.
// Se algum aparecer em qualquer nível, a mensagem precisa da flag IsComponentsV2.
const V2_ONLY_TYPES = new Set([9, 10, 11, 12, 13, 14, 17]);

function usesComponentsV2(components: unknown[]): boolean {
	return components.some((c) => {
		if (typeof c !== "object" || c === null) return false;
		const { type, components: nested } = c as {
			type?: number;
			components?: unknown[];
		};
		return (
			(type !== undefined && V2_ONLY_TYPES.has(type)) ||
			(Array.isArray(nested) && usesComponentsV2(nested))
		);
	});
}

/** Baixa o primeiro anexo da mensagem, se tiver um - pra JSON grande demais pra caber inline. */
async function fetchAttachmentJson(msg: Message): Promise<string | null> {
	const attachment = msg.attachments.first();
	if (!attachment) return null;

	const res = await fetch(attachment.url);
	if (!res.ok) throw new Error(`Falha ao baixar o anexo (HTTP ${res.status}).`);
	return res.text();
}

/**
 * Resolve de onde vem o JSON: anexo na própria mensagem primeiro, depois o texto da mensagem (cru
 * ou em bloco de código), depois - se nenhum dos dois - a mensagem respondida (anexo dela ou
 * texto dela), na mesma ordem.
 */
async function resolveSource(
	message: Message,
	prefixPattern: RegExp,
): Promise<string> {
	const ownAttachment = await fetchAttachmentJson(message);
	if (ownAttachment !== null) return ownAttachment;

	const ownText = message.content.replace(prefixPattern, "").trim();
	if (ownText) return ownText;

	if (!message.reference?.messageId) return "";
	const replied = await message.channel.messages
		.fetch(message.reference.messageId)
		.catch(() => null);
	if (!replied) return "";

	const repliedAttachment = await fetchAttachmentJson(replied);
	if (repliedAttachment !== null) return repliedAttachment;

	return replied.content.replace(prefixPattern, "").trim();
}

function parsePayload(raw: string): EmbedPayload {
	const json = extractCodeBlock(raw);
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new Error(
			`JSON inválido: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("O JSON precisa ser um objeto.");
	}
	// Formato cru da API do Discord (content/embeds/components) - sem validar campo por campo, quem
	// valida de verdade é a própria API do Discord no send(); a fronteira de segurança real é o
	// botOwnerOnly, igual ao !request.
	return parsed as EmbedPayload;
}

export default defineCommand({
	name: "embed",
	description:
		"Envia embeds/components crus a partir de um JSON (só via !embed, não slash).",
	category: CommandCategory.ADMIN,
	botOwnerOnly: true,
	showOnHelp: false,

	async executeAsSlash(interaction) {
		await interaction.reply({
			...EmbedFormatter.info(
				"Esse comando só funciona via prefixo (`!embed`) - precisa colar um JSON em bloco de código ou responder a uma mensagem, o que não dá pra fazer num slash command.",
			),
			ephemeral: true,
		});
	},

	async executeAsPrefix(message, _args, _client) {
		const prefix = message.guild
			? await getGuildPrefix(message.guild.id)
			: config.bot.defaultPrefix;
		const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const embedPrefixPattern = new RegExp(`^${escapedPrefix}embed\\s*`, "i");

		let source: string;
		try {
			source = await resolveSource(message, embedPrefixPattern);
		} catch (err) {
			await message.reply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
			return;
		}

		if (!source) {
			await message.reply(
				EmbedFormatter.warn(
					"Cole um JSON depois do comando (bloco de código ou não), anexe um arquivo com o JSON, ou responda a uma mensagem com um dos dois.\n" +
						'Formato cru da API do Discord: `{ "content": "...", "embeds": [...], "components": [...] }`, qualquer combinação.\n' +
						"Components V2 (Container/Section/TextDisplay/etc) são detectados automaticamente pelo `type` de cada component.",
				),
			);
			return;
		}

		let payload: EmbedPayload;
		try {
			payload = parsePayload(source);
		} catch (err) {
			await message.reply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
			return;
		}

		if (!message.channel.isSendable()) return;

		try {
			await message.channel.send({
				content: payload.content,
				embeds: payload.embeds,
				components: payload.components,
				flags:
					payload.components?.length && usesComponentsV2(payload.components)
						? MessageFlags.IsComponentsV2
						: undefined,
			});
		} catch (err) {
			await message.reply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
		}
	},
});

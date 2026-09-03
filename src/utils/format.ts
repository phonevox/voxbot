import { EmbedBuilder } from "discord.js";

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

/** Segundos Unix para uma Date, para usar em timestamp tags do Discord (`<t:...:F>` etc). */
export function unix(date: Date): number {
	return Math.floor(date.getTime() / 1000);
}

export class EmbedFormatter {
	public static error(msg: string): EmbedBuilder {
		return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
	}

	public static success(msg: string): EmbedBuilder {
		return new EmbedBuilder().setColor(0x57f287).setDescription(`✅ ${msg}`);
	}

	public static info(msg: string): EmbedBuilder {
		return new EmbedBuilder().setColor(0x5865f2).setDescription(`ℹ️ ${msg}`);
	}

	public static warn(msg: string): EmbedBuilder {
		return new EmbedBuilder().setColor(0xffff00).setDescription(`⚠️ ${msg}`);
	}

	public static usage(
		title: string,
		description: string,
		fields: { name: string; value: string }[],
	): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle(title)
			.setDescription(description)
			.addFields(fields);
	}
}

export function roleMention(id: string): string {
	return `<@&${id}>`;
}

export function channelMention(id: string): string {
	return `<#${id}>`;
}

export function userMention(id: string): string {
	return `<@${id}>`;
}

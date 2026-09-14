import {
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
} from "discord.js";
import { unix } from "@/utils/format";

export interface StickyPayload {
	components: ContainerBuilder[];
	flags: MessageFlags.IsComponentsV2;
}

function addDivider(container: ContainerBuilder): void {
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
}

/**
 * Aplica a formatação leve aceita numa sticky message e devolve os blocos já separados:
 * - `\n` (barra + n) literal vira quebra de linha de verdade - útil pra quem digita a mensagem
 *   num campo que não deixa colar uma quebra real (ex: input de slash command).
 * - uma linha com EXATAMENTE `---` (3 traços, nada mais na linha) vira um separador visual,
 *   dividindo o conteúdo em blocos.
 * - `\---` (escapado com barra na frente) NUNCA vira separador - vira o texto literal `---`.
 *
 * ponytail: só o padrão EXATO de 3 traços separa - `----`/`------------` (4+) fica de propósito
 * de fora (ao contrário do "3 ou mais" do markdown padrão), pra não vir texto normal com uma
 * linha de traços (assinatura, divisória decorativa) e virar separador sem querer. Não "conserta"
 * pra aceitar 3+ - isso quebraria mensagem de gente que já depende do comportamento atual.
 */
export function parseStickyContent(raw: string): string[] {
	const withBreaks = raw.replace(/\\n/g, "\n");
	const lines = withBreaks.split("\n");

	const segments: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "---") {
			segments.push(current.join("\n").trim());
			current = [];
			continue;
		}
		current.push(trimmed === "\\---" ? line.replace("\\---", "---") : line);
	}
	segments.push(current.join("\n").trim());

	// Bloco vazio vira uma TextDisplay vazia, que o Discord rejeita ("Invalid string length",
	// mesmo bug do !hostinger dns list) - descarta em vez de deixar estourar.
	return segments.filter((s) => s.length > 0);
}

/** `#RRGGBB` (com ou sem `#`) -> int 0x000000-0xFFFFFF. null se não bater o formato. */
export function parseHexColor(input: string): number | null {
	const match = input.trim().match(/^#?([0-9a-fA-F]{6})$/);
	return match ? Number.parseInt(match[1], 16) : null;
}

/**
 * Visual fixo de uma sticky message: os blocos de conteúdo (separados por `---`, se tiver) cada
 * um na sua própria seção com separador de verdade entre eles, e um rodapé padronizado com
 * timestamp de quando ESSA cópia foi (re)postada. `color` (opcional) vira a cor de destaque na
 * borda esquerda do container - `null`/`undefined` deixa sem cor (padrão do Discord).
 */
export function buildStickyMessage(
	content: string,
	color?: number | null,
): StickyPayload {
	const container = new ContainerBuilder();
	if (color !== null && color !== undefined) container.setAccentColor(color);
	const segments = parseStickyContent(content);

	segments.forEach((segment, i) => {
		if (i > 0) addDivider(container);
		container.addTextDisplayComponents((td) => td.setContent(segment));
	});

	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(`-# 📌 Sticky Message · <t:${unix(new Date())}:R>`),
	);

	return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ── Self-check (sem framework de teste no projeto - roda com `ts-node src/modules/stickymessage/present.ts`) ──
if (require.main === module) {
	const assert = require("node:assert");
	assert.deepStrictEqual(
		parseStickyContent("Linha 1\\nLinha 2"),
		["Linha 1\nLinha 2"],
		"\\n literal vira quebra de linha de verdade, sem separador",
	);
	assert.deepStrictEqual(
		parseStickyContent("Bloco 1\n---\nBloco 2"),
		["Bloco 1", "Bloco 2"],
		"linha só com --- separa em 2 blocos",
	);
	assert.deepStrictEqual(
		parseStickyContent("Antes\n------------\nDepois"),
		["Antes\n------------\nDepois"],
		"mais de 3 traços NUNCA separa - fica um bloco só, texto intacto",
	);
	assert.deepStrictEqual(
		parseStickyContent("Antes\n\\---\nDepois"),
		["Antes\n---\nDepois"],
		"\\--- escapado vira o texto literal --- e não separa",
	);
	assert.deepStrictEqual(
		parseStickyContent("Bloco 1\n---\n   \n---\nBloco 2"),
		["Bloco 1", "Bloco 2"],
		"bloco vazio entre dois separadores é descartado (evita TextDisplay vazia)",
	);
	console.log("stickymessage/present: parseStickyContent ok");

	assert.strictEqual(parseHexColor("#5865F2"), 0x5865f2, "com # -> int certo");
	assert.strictEqual(parseHexColor("5865F2"), 0x5865f2, "sem # -> int certo");
	assert.strictEqual(parseHexColor("#000000"), 0, "preto -> 0, não null");
	assert.strictEqual(parseHexColor("#GGGGGG"), null, "hex inválido -> null");
	assert.strictEqual(
		parseHexColor("#FFF"),
		null,
		"atalho de 3 dígitos não é aceito",
	);
	console.log("stickymessage/present: parseHexColor ok");
}

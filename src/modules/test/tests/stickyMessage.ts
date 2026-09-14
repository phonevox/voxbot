import { buildStickyMessage } from "@/modules/stickymessage/present";
import type { TestFn } from "./context";

/** Preview do visual da sticky message (blocos separados por `---`, quebra via `\n` literal, o
 * escape `\---`/traços demais NÃO virando separador, e a cor de destaque) sem precisar configurar
 * uma de verdade. */
const stickyMessageTest: TestFn = async (ctx) => {
	await ctx.send(
		buildStickyMessage(
			"## Regras do Canal\n" +
				"1. Seja gentil.\\n2. Sem spam.\n" +
				"---\n" +
				"Isso é um bloco separado, numa seção própria.\n" +
				"---\n" +
				"Uma linha de traços de verdade não separa: ------------\n" +
				"E escapado também não: \\---",
			0x5865f2,
		),
	);
	await ctx.send(
		buildStickyMessage("Sem cor definida - fica no padrão do Discord."),
	);
};

export default stickyMessageTest;

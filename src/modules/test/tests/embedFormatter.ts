import { EmbedFormatter } from "@/utils/format";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import type { TestFn } from "./context";

const PAGINATION_PAGES = 5;

function renderPaginationSample(page: number, interactive: boolean) {
	const { flags, components } = EmbedFormatter.plain(
		`Conteúdo de exemplo da página **${page + 1}**.\n-# Página ${page + 1} de ${PAGINATION_PAGES}`,
	);
	return {
		flags,
		components: interactive
			? [...components, buildPaginationRow(page, PAGINATION_PAGES)]
			: components,
	};
}

/** Ex-`!embedtest` - todas as variantes do EmbedFormatter + o utilitário de pagination, num tiro só. */
const embedFormatterTest: TestFn = async (ctx) => {
	await ctx.send(EmbedFormatter.error("Isso é um erro de exemplo."));
	await ctx.send(EmbedFormatter.warn("Isso é um aviso de exemplo."));
	await ctx.send(EmbedFormatter.success("Isso é um sucesso de exemplo."));
	await ctx.send(EmbedFormatter.info("Isso é uma informação de exemplo."));
	await ctx.send(EmbedFormatter.plain("Isso é um texto plain de exemplo."));

	const sent = await ctx.send(renderPaginationSample(0, true));
	attachPagination(sent, {
		invokerId: ctx.invokerId,
		pages: PAGINATION_PAGES,
		render: renderPaginationSample,
	});
};

export default embedFormatterTest;

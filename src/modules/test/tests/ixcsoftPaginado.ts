import {
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
} from "discord.js";
import {
	formatAtivo,
	formatStatusCode,
	STATUS_ACESSO,
	STATUS_CONTRATO,
} from "@/modules/ixc/status";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import type { SendableReply, TestFn } from "./context";
import { MOCK_CONTRATO, MOCK_PRODUTOS } from "./ixcsoftMock";

// Página 0 = overview do contrato + lista enxuta dos produtos (descrição/ativo) - como as
// páginas de produto vêm em ordem logo depois, não precisa dizer "página X" pra cada um. Páginas
// 1..N = um produto por página. Status contrato/acesso são do CONTRATO (ver ../../ixc/status.ts) -
// produto não tem status próprio, só um "ativo" simples.
const TOTAL_PAGES = 1 + MOCK_PRODUTOS.length;

function addDivider(container: ContainerBuilder): void {
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
}

// "-# Contrato: ID, Cliente: ..." fica em toda página (overview e cada produto) - contexto que
// nunca muda dentro do mesmo contrato, não faz sentido só aparecer na primeira.
function contratoHeader(container: ContainerBuilder): void {
	container.addTextDisplayComponents((td) =>
		td.setContent(
			`-# Contrato: ${MOCK_CONTRATO.id}, Cliente: ${MOCK_CONTRATO.cliente}`,
		),
	);
}

function renderOverview(): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(0x5865f2);
	contratoHeader(container);
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			[
				"**Informações do contrato**",
				`- **ID:** ${MOCK_CONTRATO.id}`,
				`- **Status:** ${formatStatusCode(STATUS_CONTRATO, MOCK_CONTRATO.status)}`,
				`- **Status Acesso:** ${formatStatusCode(STATUS_ACESSO, MOCK_CONTRATO.statusAcesso)}`,
				`- **Ativação:** ${MOCK_CONTRATO.ativacao}`,
			].join("\n"),
		),
	);
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			[
				`**Produtos (${MOCK_PRODUTOS.length})**`,
				"-# Para detalhes, passe de página.",
				...MOCK_PRODUTOS.map(
					(p) => `- **${p.descricao}** - ${formatAtivo(p.ativo)}`,
				),
			].join("\n"),
		),
	);
	return container;
}

function renderProduto(index: number): ContainerBuilder {
	const p = MOCK_PRODUTOS[index];
	const container = new ContainerBuilder().setAccentColor(0x5865f2);
	contratoHeader(container);
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			[
				`**${p.descricao}**`,
				`- **Tipo:** ${p.tipo}`,
				`- **Valor:** ${p.valor}`,
				`- **Quantidade:** ${p.quantidade}`,
				`- **Ativo:** ${formatAtivo(p.ativo)}`,
			].join("\n"),
		),
	);
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(["**Observação**", p.observacao].join("\n")),
	);
	return container;
}

function render(page: number, interactive: boolean): SendableReply {
	const container = page === 0 ? renderOverview() : renderProduto(page - 1);
	const components: SendableReply["components"] = [container];
	if (interactive) components.push(buildPaginationRow(page, TOTAL_PAGES));
	return { flags: MessageFlags.IsComponentsV2, components };
}

const ixcsoftPaginadoTest: TestFn = async (ctx) => {
	const sent = await ctx.send(render(0, true));
	attachPagination(sent, {
		invokerId: ctx.invokerId,
		pages: TOTAL_PAGES,
		render,
	});
};

export default ixcsoftPaginadoTest;

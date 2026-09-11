import type { Message, SlashCommandStringOption } from "discord.js";
import {
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
	SlashCommandBuilder,
} from "discord.js";
import { defineCommand } from "@/define";
import { isAuthorized } from "@/modules/autobloqueador/repository";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import {
	type IxcListResult,
	type IxcRegistro,
	searchByForeignKeyIn,
	searchByIdOrText,
} from "../client";
import {
	formatAtivo,
	formatStatusCode,
	parseAtivo,
	STATUS_ACESSO,
	STATUS_CONTRATO,
} from "../status";

const logger = new Logger("ixc.command");

// Nomes de tabela/coluna do IXC - ajuste aqui se vier diferente.
const CLIENTE_TABLE = "cliente";
const CLIENTE_ID_COLUMN = "id";
const CLIENTE_TEXT_COLUMN = "razao";
const CLIENTE_DOC_COLUMN = "cnpj_cpf";

const CONTRATO_TABLE = "cliente_contrato";
const CONTRATO_ID_COLUMN = "id";
const CONTRATO_FK_CLIENTE_COLUMN = "id_cliente";

const CONTRATO_PRODUTOS_TABLE = "vd_contratos_produtos";
const CONTRATO_PRODUTOS_FK_CONTRATO_COLUMN = "id_contrato";

const PRODUTO_TABLE = "produtos";
const PRODUTO_ID_COLUMN = "id";
const PRODUTO_TEXT_COLUMN = "descricao";

const PER_PAGE = 5;

interface FieldSpec {
	label: string;
	/** Em ordem de preferência - usa o primeiro que existir no registro (nomes de coluna variam). */
	keys?: string[];
	format?: (raw: string) => string;
	/** Pra campo montado a partir de várias colunas (endereço) - ignora `keys`/`format` se vier. */
	compose?: (registro: IxcRegistro) => string | null;
	/** Início de uma nova seção (com separador de verdade antes) - pra campo grande/secundário tipo
	 * Observação, que não faz sentido emendado direto na lista de bullets principal. */
	separatorBefore?: boolean;
	/** Renderiza como `**Label**` + valor cru embaixo, em vez de `- **Label:** valor` - pra texto
	 * longo (Observação) que não fica bem espremido numa linha de bullet só. */
	headingStyle?: boolean;
}

function rawValue(registro: IxcRegistro, keys: string[]): string | null {
	for (const key of keys) {
		const value = registro[key];
		if (value !== undefined && value !== null && value !== "")
			return String(value);
	}
	return null;
}

function composeEndereco(registro: IxcRegistro): string | null {
	const rua = rawValue(registro, ["endereco", "logradouro"]);
	const numero = rawValue(registro, ["numero"]);
	const bairro = rawValue(registro, ["bairro"]);
	const linha1 = [rua, numero].filter(Boolean).join(", ");
	const linha = [linha1, bairro].filter(Boolean).join(" - ");
	return linha || null;
}

/** Igual composeEndereco, + CEP - o registro do cliente costuma ter isso preenchido (diferente do
 * contrato, onde vimos ao vivo que geralmente vem vazio). NÃO inclui cidade/uf - confirmado ao vivo
 * que vêm como código cru de outra tabela ("4376"/"2"), não nome/sigla, então só confundiria. */
function composeEnderecoCompleto(registro: IxcRegistro): string | null {
	const base = composeEndereco(registro);
	const cep = rawValue(registro, ["cep"]);
	return [base, cep].filter(Boolean).join(" - ") || null;
}

/** Múltiplos e-mails no IXC vêm separados por vírgula (não concatenados sem separador) - só
 * normaliza o espaçamento. */
function splitGluedEmails(raw: string): string {
	return raw
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean)
		.join(", ");
}

/** IXC devolve valor cru tipo "20.000000000" (decimal fixo, sem símbolo) - formata como
 * "R$ 20,00". Se não for número (formato mudou), devolve cru em vez de quebrar. */
function formatCurrency(raw: string): string {
	const n = Number(raw);
	if (Number.isNaN(n)) return raw;
	return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

interface EntityView {
	/** Identificadores, numa linha só, em destaque reduzido (`-#`). */
	subtext: FieldSpec[];
	/** Campo em destaque (`**valor**`), tipo a descrição do produto no contrato - opcional. */
	heading?: FieldSpec;
	/** O que importa de verdade, em lista (`-`). */
	bullets: FieldSpec[];
	/** Separador de verdade entre o subtexto e o heading/bullets - padrão false (tudo num bloco só,
	 * ex: !ixc buscar, onde a lista já é compacta). !ixc cliente (detalhe rico) usa true. */
	separateHeader?: boolean;
}

function composeAtivo(registro: IxcRegistro): string | null {
	const raw = rawValue(registro, ["ativo"]);
	return raw === null ? null : formatAtivo(raw);
}

const CLIENTE_NOME: FieldSpec = {
	label: "Nome",
	keys: ["razao", "nome", "fantasia"],
};

const CLIENTE_VIEW: EntityView = {
	subtext: [
		{ label: "ID", keys: ["id"] },
		{ label: "CPF/CNPJ", keys: ["cnpj_cpf", "cpf_cnpj", "cnpj", "cpf"] },
	],
	heading: CLIENTE_NOME,
	bullets: [
		{ label: "Ativo", compose: composeAtivo },
		{ label: "Telefone", keys: ["telefone_celular", "telefone", "fone"] },
		{ label: "E-mail", keys: ["email"], format: splitGluedEmails },
	],
};

// Usado por "!ixc cliente <id>" - bem mais campo que o resumo do CLIENTE_VIEW (que aparece dentro
// da lista de resultados do !ixc buscar). Confirmado ao vivo (log de diagnóstico): tipo_pessoa
// (F/J), ativo (S/N), endereço/bairro/cep preenchidos - cidade/uf vêm como código cru de outra
// tabela, por isso ficam de fora (ver composeEnderecoCompleto).
const CLIENTE_DETALHE_VIEW: EntityView = {
	subtext: [
		{ label: "ID", keys: ["id"] },
		{ label: "CPF/CNPJ", keys: ["cnpj_cpf", "cpf_cnpj", "cnpj", "cpf"] },
	],
	heading: CLIENTE_NOME,
	separateHeader: true,
	bullets: [
		{ label: "Ativo", compose: composeAtivo },
		{
			label: "Tipo Pessoa",
			compose: (r) => {
				const raw = rawValue(r, ["tipo_pessoa", "pessoa"]);
				if (raw === null) return null;
				if (raw === "F") return "Física";
				if (raw === "J") return "Jurídica";
				return raw;
			},
		},
		{
			label: "Telefone",
			keys: ["telefone_celular", "telefone_comercial", "telefone", "fone"],
		},
		{ label: "E-mail", keys: ["email"], format: splitGluedEmails },
		{ label: "Endereço", compose: composeEnderecoCompleto },
		{ label: "Cadastro", keys: ["data_cadastro"] },
		{
			label: "Observação",
			keys: ["obs", "observacao", "observacoes"],
			separatorBefore: true,
			headingStyle: true,
		},
	],
};

// Preenchido em decorateContratosComCliente - fallback pro id cru se a busca do nome falhar.
const CONTRATO_CLIENTE_NOME_KEY = "__cliente_nome";

// Campos de "Informações do contrato" na página overview do !ixc contrato (ver renderContratoPage) -
// status/status acesso são exclusivos do contrato, produto não tem os dois, só um "ativo" simples.
const CONTRATO_INFO: FieldSpec[] = [
	{ label: "ID", keys: ["id"] },
	{
		label: "Status",
		compose: (r) => {
			const raw = rawValue(r, ["status"]);
			return raw === null ? null : formatStatusCode(STATUS_CONTRATO, raw);
		},
	},
	{
		label: "Status Acesso",
		// coluna real no IXC costuma se chamar status_internet - o label nunca usa essa palavra.
		compose: (r) => {
			const raw = rawValue(r, ["status_internet", "status_acesso"]);
			return raw === null ? null : formatStatusCode(STATUS_ACESSO, raw);
		},
	},
	{ label: "Plano", keys: ["contrato", "descricao_aux_plano_venda"] },
	{ label: "Pago até", keys: ["pago_ate_data"] },
	// Código visto ao vivo: "R" - resto do enum ainda não confirmado, por isso cru (sem emoji).
	{
		label: "Situação Financeira",
		keys: ["situacao_financeira_contrato"],
	},
	{
		label: "Bloqueio Automático",
		compose: (r) => {
			const raw = rawValue(r, ["bloqueio_automatico"]);
			return raw === null ? null : parseAtivo(raw) ? "Sim" : "Não";
		},
	},
	{
		label: "Suspenso",
		// Semântica invertida da de Ativo/Status: "sim" aqui é problema, não normalidade.
		compose: (r) => {
			const raw = rawValue(r, ["contrato_suspenso"]);
			if (raw === null) return null;
			return parseAtivo(raw) ? "`🔴 Sim`" : "`🟢 Não`";
		},
	},
	{
		label: "Ativação",
		keys: ["data_ativacao", "data_assinatura", "data_cadastro"],
	},
	{ label: "Endereço", compose: composeEndereco },
];

// Confirmado ao vivo (log de diagnóstico) contra um vd_contratos_produtos real - "valor_unit" é o
// nome de verdade, os outros ficam de fallback pra outras instâncias/tabelas. Esse join não tem
// coluna de ativo/inativo nenhuma (produto removido do contrato simplesmente não aparece mais na
// busca) - por isso não tem "Ativo" aqui, diferente de cliente/contrato que têm status de verdade.
const CONTRATO_PRODUTO_VALOR: FieldSpec = {
	label: "Valor",
	keys: [
		"valor_unit",
		"valor_venda",
		"valor",
		"valor_unitario",
		"valor_total",
		"preco_venda",
		"preco",
	],
	format: formatCurrency,
};

// Campos de cada produto na sua própria página (ver renderContratoProduto).
const CONTRATO_PRODUTO_INFO: FieldSpec[] = [
	{ label: "Tipo", keys: ["tipo_produto", "tipo"] },
	CONTRATO_PRODUTO_VALOR,
	{ label: "Quantidade", keys: ["quantidade", "qtde", "qtd"] },
];

const PRODUTO_VIEW: EntityView = {
	subtext: [{ label: "ID", keys: ["id"] }],
	bullets: [
		{ label: "Descrição", keys: ["descricao", "nome"] },
		{ label: "Tipo", keys: ["tipo_produto", "tipo"] },
		{
			label: "Valor",
			// tabela "produtos" (catálogo) - coluna ainda não confirmada ao vivo, candidatos por
			// ordem de probabilidade. Pra produto DENTRO de um contrato, ver CONTRATO_PRODUTO_VALOR.
			keys: [
				"valor_venda",
				"valor",
				"valor_unit",
				"valor_unitario",
				"valor_total",
				"preco_venda",
				"preco",
			],
			format: formatCurrency,
		},
		{ label: "Observação", keys: ["obs", "observacao", "observacoes"] },
	],
};

function pickField(registro: IxcRegistro, field: FieldSpec): string | null {
	if (field.compose) return field.compose(registro);
	const raw = rawValue(registro, field.keys ?? []);
	if (raw === null) return null;
	return field.format ? field.format(raw) : raw;
}

/**
 * Um registro vira 1+ blocos (cada um sua própria TextDisplay, com separador de verdade entre
 * eles - ver renderPage): 1) subtexto (ID/CPF-CNPJ) sozinho; 2) heading em destaque (se tiver) +
 * bullets, quebrando numa NOVA seção toda vez que um bullet marcado `separatorBefore` aparece
 * (ex: Observação). `extra` (contratos vinculados) NÃO entra aqui - o renderPage emenda ele no
 * último bloco, sem separador (é parte do mesmo bloco, não uma seção à parte).
 */
function formatRegistroBlocks(
	registro: IxcRegistro,
	view: EntityView,
): string[] {
	const subtextParts = view.subtext
		.map((f) => {
			const value = pickField(registro, f);
			return value !== null ? `${f.label}: ${value}` : null;
		})
		.filter((s): s is string => s !== null);
	const subtext =
		subtextParts.length > 0 ? `-# ${subtextParts.join(" · ")}` : null;

	const heading = view.heading ? pickField(registro, view.heading) : null;
	const segments: string[][] = [[]];
	for (const f of view.bullets) {
		const value = pickField(registro, f);
		if (value === null) continue;
		if (f.separatorBefore) segments.push([]);
		const line = f.headingStyle
			? `**${f.label}**\n${value}`
			: `- **${f.label}:** ${value}`;
		segments[segments.length - 1].push(line);
	}

	// Primeiro segmento carrega o heading (se tiver). O subtexto entra junto nesse mesmo bloco
	// (sem separador) A MENOS que a view peça o contrário (view.separateHeader) - ex: !ixc buscar
	// é compacto (tudo junto), !ixc cliente separa de propósito.
	const firstLines =
		heading !== null ? [`**${heading}**`, ...segments[0]] : segments[0];
	const firstBlockParts =
		subtext && !view.separateHeader ? [subtext, ...firstLines] : firstLines;

	const blocks: string[] = [];
	if (subtext && view.separateHeader) blocks.push(subtext);
	if (firstBlockParts.length > 0) blocks.push(firstBlockParts.join("\n"));
	for (const seg of segments.slice(1)) {
		if (seg.length > 0) blocks.push(seg.join("\n"));
	}

	return blocks;
}

function addDivider(container: ContainerBuilder): void {
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
}

interface IxcReply {
	flags: MessageFlags.IsComponentsV2;
	components: (ContainerBuilder | ReturnType<typeof buildPaginationRow>)[];
}

function renderPage(
	result: IxcListResult,
	view: EntityView,
	extraFor: (registro: IxcRegistro) => string | null,
	page: number,
	interactive: boolean,
): IxcReply {
	const pages = Math.max(1, Math.ceil(result.registros.length / PER_PAGE));
	const clamped = Math.min(page, pages - 1);
	const slice = result.registros.slice(
		clamped * PER_PAGE,
		(clamped + 1) * PER_PAGE,
	);

	const container = new ContainerBuilder();
	if (slice.length === 0) {
		container.addTextDisplayComponents((td) =>
			td.setContent("Nenhum registro encontrado."),
		);
	} else {
		// Separador entre CADA registro - fica óbvio onde um termina e o próximo começa. Dentro do
		// MESMO registro, cada bloco de formatRegistroBlocks (subtexto / heading+bullets / seções
		// separatorBefore tipo Observação) também ganha separador de verdade entre si. Só o `extra`
		// (contratos vinculados) não leva separador - é emendado no último bloco.
		slice.forEach((registro, i) => {
			if (i > 0) addDivider(container);
			const blocks = formatRegistroBlocks(registro, view);
			const extra = extraFor(registro);
			if (extra) {
				if (blocks.length === 0) blocks.push(extra);
				else blocks[blocks.length - 1] += `\n${extra}`;
			}
			blocks.forEach((block, j) => {
				if (j > 0) addDivider(container);
				container.addTextDisplayComponents((td) => td.setContent(block));
			});
		});
	}

	if (result.total > result.registros.length) {
		addDivider(container);
		container.addTextDisplayComponents((td) =>
			td.setContent(
				`⚠️ **${result.registros.length}/${result.total} resultados** - refine a busca pra ver o resto.`,
			),
		);
	}

	const components: (
		| ContainerBuilder
		| ReturnType<typeof buildPaginationRow>
	)[] = [container];
	if (interactive && pages > 1)
		components.push(buildPaginationRow(clamped, pages));

	return { flags: MessageFlags.IsComponentsV2, components };
}

async function buscarCliente(busca: string): Promise<IxcListResult> {
	return searchByIdOrText(
		CLIENTE_TABLE,
		CLIENTE_ID_COLUMN,
		CLIENTE_TEXT_COLUMN,
		busca,
	);
}

/** Tira tudo que não é dígito - aceita CPF/CNPJ formatado ("123.456.789-00") ou cru. */
function onlyDigits(value: string): string {
	return value.replace(/\D/g, "");
}

async function buscarPorDocumento(busca: string): Promise<IxcListResult> {
	const digits = onlyDigits(busca);
	if (!digits)
		throw new Error("Informe um CPF ou CNPJ (com ou sem formatação).");
	// digits é sempre numérico, então isso cai direto no operador "=" contra CLIENTE_DOC_COLUMN.
	return searchByIdOrText(
		CLIENTE_TABLE,
		CLIENTE_DOC_COLUMN,
		CLIENTE_DOC_COLUMN,
		digits,
	);
}

// Só por id - pra buscar por nome/CPF-CNPJ tem !ixc buscar/buscar-doc. Esse aqui é o detalhe rico
// (CLIENTE_DETALHE_VIEW), não o resumo que aparece na lista.
async function buscarClientePorId(busca: string): Promise<IxcListResult> {
	const trimmed = busca.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(
			"`!ixc cliente` só aceita id numérico - pra buscar por nome/CPF-CNPJ, use `!ixc buscar`/`!ixc buscar-doc`.",
		);
	}
	return searchByIdOrText(
		CLIENTE_TABLE,
		CLIENTE_ID_COLUMN,
		CLIENTE_TEXT_COLUMN,
		trimmed,
	);
}

// Só por id agora - buscar cliente por nome já mostra os contratos vinculados via !ixc buscar.
async function buscarContrato(busca: string): Promise<IxcListResult> {
	const trimmed = busca.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(
			"`!ixc contrato` só aceita id numérico - pra buscar por nome do cliente, use `!ixc buscar`.",
		);
	}
	return searchByIdOrText(
		CONTRATO_TABLE,
		CONTRATO_ID_COLUMN,
		CONTRATO_FK_CLIENTE_COLUMN,
		trimmed,
	);
}

async function buscarProduto(busca: string): Promise<IxcListResult> {
	return searchByIdOrText(
		PRODUTO_TABLE,
		PRODUTO_ID_COLUMN,
		PRODUTO_TEXT_COLUMN,
		busca,
	);
}

const NO_EXTRA = (): null => null;

/**
 * Segunda chamada em lote, batida em cima dos ids dos registros-pai já achados (`IN`) - agrupa
 * por FK e devolve uma função de lookup por registro-pai. Base de `contratosPorCliente` e
 * `produtosPorContrato`.
 */
async function extraByForeignKey(
	table: string,
	fkColumn: string,
	parents: IxcRegistro[],
	formatGroup: (rows: IxcRegistro[]) => string,
): Promise<(parent: IxcRegistro) => string | null> {
	const ids = parents
		.map((p) => p.id)
		.filter(
			(id): id is string | number =>
				typeof id === "string" || typeof id === "number",
		);
	const { registros } = await searchByForeignKeyIn(table, fkColumn, ids);

	const grouped = new Map<string, IxcRegistro[]>();
	for (const row of registros) {
		const key = String(row[fkColumn] ?? "");
		if (!key) continue;
		grouped.set(key, [...(grouped.get(key) ?? []), row]);
	}

	return (parent) => formatGroup(grouped.get(String(parent.id ?? "")) ?? []);
}

async function contratosPorCliente(
	clientes: IxcRegistro[],
): Promise<(registro: IxcRegistro) => string | null> {
	return extraByForeignKey(
		CONTRATO_TABLE,
		CONTRATO_FK_CLIENTE_COLUMN,
		clientes,
		(rows) => {
			if (rows.length === 0) return "-# Contratos: nenhum";
			// Só ativo interessa aqui - inativo não some do IXC, mas não vale a pena listar na busca
			// de cliente (quem quiser ver o histórico completo usa !ixc contrato <id> direto).
			const status = (c: IxcRegistro) => rawValue(c, ["status"]);
			const ativos = rows.filter(
				(c) => status(c) === null || status(c) === "A",
			);
			if (ativos.length === 0) return "-# Contratos: nenhum ativo";
			// Já filtrado por ativo - a bolinha verde de Status ficaria redundante em todo item.
			// Status Acesso é o que varia de fato (bloqueio/financeiro), então mostra esse.
			const resumo = ativos
				.map((c) => {
					const acesso = rawValue(c, ["status_internet", "status_acesso"]);
					const badge = acesso
						? ` ${formatStatusCode(STATUS_ACESSO, acesso)}`
						: "";
					return `#${c.id ?? "?"}${badge}`;
				})
				.join(" · ");
			return `-# Contratos: ${resumo}`;
		},
	);
}

/** Todos os produtos vinculados a UM contrato (id numérico já validado por buscarContrato) - cru,
 * sem formatar, porque cada um vira sua própria página em renderContratoPage. */
async function produtosDoContrato(
	contratoId: string | number,
): Promise<IxcRegistro[]> {
	const { registros } = await searchByForeignKeyIn(
		CONTRATO_PRODUTOS_TABLE,
		CONTRATO_PRODUTOS_FK_CONTRATO_COLUMN,
		[contratoId],
	);
	return registros;
}

/** Batida em lote pelos `id_cliente` dos contratos já achados - enriquece cada um com o nome do
 * cliente (`CONTRATO_CLIENTE_NOME_KEY`), pra não mostrar só o id cru. */
async function decorateContratosComCliente(
	contratos: IxcRegistro[],
): Promise<IxcRegistro[]> {
	const ids = contratos
		.map((c) => c[CONTRATO_FK_CLIENTE_COLUMN])
		.filter(
			(id): id is string | number =>
				typeof id === "string" || typeof id === "number",
		);
	if (ids.length === 0) return contratos;

	const { registros: clientes } = await searchByForeignKeyIn(
		CLIENTE_TABLE,
		CLIENTE_ID_COLUMN,
		ids,
	);
	const nomeById = new Map<string, string>();
	for (const cliente of clientes) {
		const nome = rawValue(cliente, ["razao", "nome", "fantasia"]);
		if (nome) nomeById.set(String(cliente.id ?? ""), nome);
	}

	return contratos.map((contrato) => {
		const nome = nomeById.get(
			String(contrato[CONTRATO_FK_CLIENTE_COLUMN] ?? ""),
		);
		return nome ? { ...contrato, [CONTRATO_CLIENTE_NOME_KEY]: nome } : contrato;
	});
}

interface SearchOutcome {
	result: IxcListResult;
	view: EntityView;
	extraFor: (registro: IxcRegistro) => string | null;
}

/** "contrato" tem fluxo próprio (handleContrato/renderContratoPage) - sempre um único registro,
 * paginado por produto em vez de por página de resultados. */
async function runSearch(sub: string, busca: string): Promise<SearchOutcome> {
	switch (sub) {
		case "buscar": {
			const result = await buscarCliente(busca);
			return {
				result,
				view: CLIENTE_VIEW,
				extraFor: await contratosPorCliente(result.registros),
			};
		}
		case "buscar-doc": {
			const result = await buscarPorDocumento(busca);
			return {
				result,
				view: CLIENTE_VIEW,
				extraFor: await contratosPorCliente(result.registros),
			};
		}
		case "cliente": {
			const result = await buscarClientePorId(busca);
			logger.debug(
				`cliente ${busca} - registro cru: ${JSON.stringify(result.registros[0] ?? null)}`,
			);
			return {
				result,
				view: CLIENTE_DETALHE_VIEW,
				extraFor: await contratosPorCliente(result.registros),
			};
		}
		case "produto":
			return {
				result: await buscarProduto(busca),
				view: PRODUTO_VIEW,
				extraFor: NO_EXTRA,
			};
		default:
			throw new Error(`Subcomando desconhecido: ${sub}`);
	}
}

// ── !ixc contrato - overview + uma página por produto vinculado ─────────────

/** `-# Contrato: <id>, Cliente: <nome>` fica em toda página (overview e cada produto) - contexto
 * que nunca muda dentro do mesmo contrato. */
function contratoHeaderLine(contrato: IxcRegistro): string {
	const id = rawValue(contrato, ["id"]) ?? "?";
	const cliente =
		rawValue(contrato, [CONTRATO_CLIENTE_NOME_KEY, "id_cliente"]) ?? "?";
	return `-# Contrato: ${id}, Cliente: ${cliente}`;
}

function bulletLines(registro: IxcRegistro, fields: FieldSpec[]): string[] {
	return fields
		.map((f) => {
			const value = pickField(registro, f);
			return value !== null ? `- **${f.label}:** ${value}` : null;
		})
		.filter((s): s is string => s !== null);
}

function renderContratoOverview(
	contrato: IxcRegistro,
	produtos: IxcRegistro[],
): ContainerBuilder {
	const container = new ContainerBuilder();
	container.addTextDisplayComponents((td) =>
		td.setContent(contratoHeaderLine(contrato)),
	);
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			[
				"**Informações do contrato**",
				...bulletLines(contrato, CONTRATO_INFO),
			].join("\n"),
		),
	);
	addDivider(container);
	const produtoLines =
		produtos.length > 0
			? [
					`**Produtos (${produtos.length})**`,
					"-# Para detalhes, passe de página.",
					...produtos.map((p) => {
						const descricao =
							rawValue(p, ["descricao", "nome"]) ?? "(sem descrição)";
						const valor = pickField(p, CONTRATO_PRODUTO_VALOR);
						return valor !== null
							? `- **${descricao}** (${valor})`
							: `- **${descricao}**`;
					}),
				]
			: ["**Produtos:** nenhum"];
	container.addTextDisplayComponents((td) =>
		td.setContent(produtoLines.join("\n")),
	);
	return container;
}

function renderContratoProduto(
	contrato: IxcRegistro,
	produto: IxcRegistro,
): ContainerBuilder {
	const container = new ContainerBuilder();
	container.addTextDisplayComponents((td) =>
		td.setContent(contratoHeaderLine(contrato)),
	);
	addDivider(container);
	const descricao =
		rawValue(produto, ["descricao", "nome"]) ?? "(sem descrição)";
	container.addTextDisplayComponents((td) =>
		td.setContent(
			[`**${descricao}**`, ...bulletLines(produto, CONTRATO_PRODUTO_INFO)].join(
				"\n",
			),
		),
	);
	const observacao = rawValue(produto, ["obs", "observacao", "observacoes"]);
	if (observacao !== null) {
		addDivider(container);
		container.addTextDisplayComponents((td) =>
			td.setContent(["**Observação**", observacao].join("\n")),
		);
	}
	return container;
}

/** Nome da página pra mostrar no rodapé (Próximo/Anterior) - página 0 é a overview, o resto é o
 * produto daquele índice. */
function pageLabel(index: number, produtos: IxcRegistro[]): string {
	if (index === 0) return "Visão Geral";
	const produto = produtos[index - 1];
	return rawValue(produto, ["descricao", "nome"]) ?? "(sem descrição)";
}

/** Rodapé com wraparound - mesma lógica de ‹/› do buildPaginationRow (primeira página + "anterior"
 * volta pra última, e vice-versa), só que como texto em vez de botão. */
function appendPageNav(
	container: ContainerBuilder,
	page: number,
	produtos: IxcRegistro[],
): void {
	const pages = 1 + produtos.length;
	if (pages <= 1) return;
	const next = (page + 1) % pages;
	const prev = (page - 1 + pages) % pages;
	addDivider(container);
	container.addTextDisplayComponents((td) =>
		td.setContent(
			`-# Anterior: ${pageLabel(prev, produtos)} · Próximo: ${pageLabel(next, produtos)}`,
		),
	);
}

function renderContratoPage(
	contrato: IxcRegistro,
	produtos: IxcRegistro[],
	page: number,
	interactive: boolean,
): IxcReply {
	const pages = 1 + produtos.length;
	const clamped = Math.min(Math.max(page, 0), pages - 1);
	const container =
		clamped === 0
			? renderContratoOverview(contrato, produtos)
			: renderContratoProduto(contrato, produtos[clamped - 1]);
	appendPageNav(container, clamped, produtos);
	const components: IxcReply["components"] = [container];
	if (interactive && pages > 1)
		components.push(buildPaginationRow(clamped, pages));
	return { flags: MessageFlags.IsComponentsV2, components };
}

interface ContratoOutcome {
	contrato: IxcRegistro;
	produtos: IxcRegistro[];
}

/** Produto já desativado no IXC (`ativo` explicitamente "não") - não interessa mais mostrar.
 * `ativo` ausente/desconhecido NÃO conta como inativo (não dá pra saber, então mantém visível).
 * Confirmado ao vivo: vd_contratos_produtos NÃO tem essa coluna (produto removido some da busca
 * em vez de ficar marcado) - isso vira no-op nesse caso, mas fica pronto se outra instância tiver. */
function isInativo(registro: IxcRegistro): boolean {
	const raw = rawValue(registro, ["ativo"]);
	return raw !== null && !parseAtivo(raw);
}

async function handleContrato(busca: string): Promise<ContratoOutcome | null> {
	const buscado = await buscarContrato(busca);
	if (buscado.registros.length === 0) return null;
	const [contrato] = await decorateContratosComCliente(buscado.registros);
	const contratoId =
		typeof contrato.id === "string" || typeof contrato.id === "number"
			? contrato.id
			: busca.trim();
	const produtos = (await produtosDoContrato(contratoId)).filter(
		(p) => !isInativo(p),
	);

	// Muito campo tá caindo em "?"/sumindo - nome de coluna real ainda incerto pra vários. Loga
	// cru aqui (só aparece com CONSOLE_LOG_LEVEL=debug) pra comparar contra os FieldSpec acima e
	// corrigir os `keys` de uma vez, sem precisar pedir print pro usuário de novo.
	logger.debug(
		`contrato ${contratoId} - registro cru: ${JSON.stringify(contrato)}`,
	);
	if (produtos.length > 0) {
		logger.debug(
			`contrato ${contratoId} - produtos crus: ${JSON.stringify(produtos)}`,
		);
	}

	return { contrato, produtos };
}

function buscaOption(description: string) {
	return (o: SlashCommandStringOption) =>
		o.setName("busca").setDescription(description).setRequired(true);
}

export default defineCommand({
	name: "ixc",
	description: "Consulta cliente, contrato e produto no IXC.",
	category: CommandCategory.UTILITY,
	showOnHelp: true,

	options: new SlashCommandBuilder()
		.addSubcommand((s) =>
			s
				.setName("buscar")
				.setDescription(
					"Busca cliente por id ou nome - já mostra os contratos vinculados.",
				)
				.addStringOption(buscaOption("id ou nome do cliente (razão social)")),
		)
		.addSubcommand((s) =>
			s
				.setName("buscar-doc")
				.setDescription("Busca cliente por CPF/CNPJ, formatado ou não.")
				.addStringOption(buscaOption("CPF ou CNPJ, com ou sem pontuação")),
		)
		.addSubcommand((s) =>
			s
				.setName("cliente")
				.setDescription(
					"Busca cliente por id - bem mais detalhe que o resumo do !ixc buscar.",
				)
				.addStringOption(buscaOption("id do cliente")),
		)
		.addSubcommand((s) =>
			s
				.setName("contrato")
				.setDescription(
					"Busca contrato por id - detalhes de cada produto ficam em páginas separadas.",
				)
				.addStringOption(buscaOption("id do contrato")),
		)
		.addSubcommand((s) =>
			s
				.setName("produto")
				.setDescription("Busca produto por id ou nome/descrição.")
				.addStringOption(buscaOption("id ou nome/descrição")),
		),

	// ── Slash ─────────────────────────────────────────────────────────────────
	async executeAsSlash(interaction) {
		if (!(await isAuthorized(interaction.user.id))) {
			await interaction.reply({
				...EmbedFormatter.error(
					"Você não tem autorização pra usar esse comando.",
				),
				ephemeral: true,
			});
			return;
		}

		const sub = interaction.options.getSubcommand(true);
		const busca = interaction.options.getString("busca", true);

		await interaction.deferReply({ ephemeral: true });
		try {
			if (sub === "contrato") {
				const found = await handleContrato(busca);
				if (!found) {
					await interaction.editReply(
						EmbedFormatter.warn("Nenhum contrato encontrado com esse id."),
					);
					return;
				}
				const { contrato, produtos } = found;
				const pages = 1 + produtos.length;
				const render = (page: number, interactive: boolean) =>
					renderContratoPage(contrato, produtos, page, interactive);

				const sent = await interaction.editReply(render(0, pages > 1));
				if (pages > 1) {
					attachPagination(sent, {
						invokerId: interaction.user.id,
						pages,
						render,
					});
				}
				return;
			}

			const { result, view, extraFor } = await runSearch(sub, busca);
			const pages = Math.max(1, Math.ceil(result.registros.length / PER_PAGE));
			const render = (page: number, interactive: boolean) =>
				renderPage(result, view, extraFor, page, interactive);

			const sent = await interaction.editReply(render(0, pages > 1));
			if (pages > 1) {
				attachPagination(sent, {
					invokerId: interaction.user.id,
					pages,
					render,
				});
			}
		} catch (err) {
			await interaction.editReply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
		}
	},

	// ── Prefix ────────────────────────────────────────────────────────────────
	async executeAsPrefix(message: Message, args) {
		if (!(await isAuthorized(message.author.id))) {
			await message.reply(
				EmbedFormatter.error("Você não tem autorização pra usar esse comando."),
			);
			return;
		}

		const sub = args.getSubcommand();
		const busca = args.getString("busca");
		if (!sub || !busca) {
			await message.reply(
				EmbedFormatter.warn(
					"Uso: `!ixc buscar|buscar-doc|cliente|contrato|produto <id ou nome>`.",
				),
			);
			return;
		}

		try {
			if (sub === "contrato") {
				const found = await handleContrato(busca);
				if (!found) {
					await message.reply(
						EmbedFormatter.warn("Nenhum contrato encontrado com esse id."),
					);
					return;
				}
				const { contrato, produtos } = found;
				const pages = 1 + produtos.length;
				const render = (page: number, interactive: boolean) =>
					renderContratoPage(contrato, produtos, page, interactive);

				const sent = await message.reply(render(0, pages > 1));
				if (pages > 1) {
					attachPagination(sent, {
						invokerId: message.author.id,
						pages,
						render,
					});
				}
				return;
			}

			const { result, view, extraFor } = await runSearch(sub, busca);
			const pages = Math.max(1, Math.ceil(result.registros.length / PER_PAGE));
			const render = (page: number, interactive: boolean) =>
				renderPage(result, view, extraFor, page, interactive);

			const sent = await message.reply(render(0, pages > 1));
			if (pages > 1) {
				attachPagination(sent, { invokerId: message.author.id, pages, render });
			}
		} catch (err) {
			await message.reply(
				EmbedFormatter.error(err instanceof Error ? err.message : String(err)),
			);
		}
	},
});

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
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import {
	type IxcListResult,
	type IxcRegistro,
	searchByForeignKeyIn,
	searchByIdOrText,
} from "../client";

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

/** IXC às vezes concatena vários e-mails sem separador nenhum ("a@b.bradministrativo@c.com") -
 * insere uma vírgula depois de um final de domínio comum quando detecta mais de um "@". */
const TLD_BOUNDARY =
	/\.(com\.br|net\.br|org\.br|gov\.br|com|net|org|io|co|br)(?=[a-zA-Z])/gi;
function splitGluedEmails(raw: string): string {
	if ((raw.match(/@/g)?.length ?? 0) <= 1) return raw;
	return raw.replace(TLD_BOUNDARY, "$1, ");
}

interface EntityView {
	/** Identificadores, numa linha só, em destaque reduzido (`-#`). */
	subtext: FieldSpec[];
	/** O que importa de verdade, em lista (`-`). */
	bullets: FieldSpec[];
}

const CLIENTE_VIEW: EntityView = {
	subtext: [
		{ label: "ID", keys: ["id"] },
		{ label: "CPF/CNPJ", keys: ["cnpj_cpf", "cpf_cnpj", "cnpj", "cpf"] },
	],
	bullets: [
		{ label: "Nome", keys: ["razao", "nome", "fantasia"] },
		{ label: "Ativo", keys: ["ativo"] },
		{ label: "Telefone", keys: ["telefone_celular", "telefone", "fone"] },
		{ label: "E-mail", keys: ["email"], format: splitGluedEmails },
	],
};

// Preenchido em decorateContratosComCliente - fallback pro id cru se a busca do nome falhar.
const CONTRATO_CLIENTE_NOME_KEY = "__cliente_nome";

const CONTRATO_VIEW: EntityView = {
	subtext: [
		{ label: "ID", keys: ["id"] },
		{ label: "Cliente", keys: [CONTRATO_CLIENTE_NOME_KEY, "id_cliente"] },
	],
	bullets: [
		{ label: "Status", keys: ["status"] },
		{
			label: "Ativação",
			keys: ["data_ativacao", "data_assinatura", "data_cadastro"],
		},
		{ label: "Valor", keys: ["valor", "valor_final", "valor_contrato"] },
		{ label: "Endereço", compose: composeEndereco },
	],
};

const PRODUTO_VIEW: EntityView = {
	subtext: [{ label: "ID", keys: ["id"] }],
	bullets: [
		{ label: "Descrição", keys: ["descricao", "nome"] },
		{ label: "Tipo", keys: ["tipo_produto", "tipo"] },
		{
			label: "Valor",
			// vd_contratos_produtos usa nome de coluna diferente da tabela produtos - ajuste aqui
			// se ainda vier vazio (o total pago no item costuma ser "valor_venda" nesse join).
			keys: [
				"valor_venda",
				"valor",
				"valor_unitario",
				"valor_total",
				"preco_venda",
				"preco",
			],
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

/** Bloco principal (subtexto + bullets) de um registro - sem o `extra` (contratos/produtos
 * vinculados), que vira um bloco à parte com separador (ver renderPage). */
function formatRegistroBase(registro: IxcRegistro, view: EntityView): string {
	const subtextParts = view.subtext
		.map((f) => {
			const value = pickField(registro, f);
			return value !== null ? `${f.label}: ${value}` : null;
		})
		.filter((s): s is string => s !== null);
	const subtext =
		subtextParts.length > 0 ? `-# ${subtextParts.join(" · ")}` : null;

	const bullets = view.bullets
		.map((f) => {
			const value = pickField(registro, f);
			return value !== null ? `- **${f.label}:** ${value}` : null;
		})
		.filter((s): s is string => s !== null)
		.join("\n");

	return [subtext, bullets].filter((s): s is string => !!s).join("\n");
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
		// Separador entre CADA registro - fica óbvio onde um termina e o próximo começa, em vez
		// de um bloco só de texto corrido. Dentro de um mesmo registro, o `extra` (contratos ou
		// produtos vinculados) também ganha separador próprio em vez de emendar direto.
		slice.forEach((registro, i) => {
			if (i > 0) addDivider(container);
			container.addTextDisplayComponents((td) =>
				td.setContent(formatRegistroBase(registro, view)),
			);
			const extra = extraFor(registro);
			if (extra) {
				addDivider(container);
				container.addTextDisplayComponents((td) => td.setContent(extra));
			}
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
			const resumo = rows
				.map((c) => `#${c.id ?? "?"}${c.status ? ` (${c.status})` : ""}`)
				.join(", ");
			return `-# Contratos: ${resumo}`;
		},
	);
}

// Descrição/Valor em destaque (o que importa pra ver de cara), Tipo/Observação em subtexto
// (contexto secundário) - reusa os mesmos campos de PRODUTO_VIEW.bullets.
const CONTRATO_PRODUTO_DESTAQUE = new Set(["Descrição", "Valor"]);

function formatContratoProduto(produto: IxcRegistro): string {
	const destaque = PRODUTO_VIEW.bullets
		.filter((f) => CONTRATO_PRODUTO_DESTAQUE.has(f.label))
		.map((f) => {
			const value = pickField(produto, f);
			return value !== null ? `  - **${f.label}:** ${value}` : null;
		})
		.filter((s): s is string => s !== null)
		.join("\n");

	const secundario = PRODUTO_VIEW.bullets
		.filter((f) => !CONTRATO_PRODUTO_DESTAQUE.has(f.label))
		.map((f) => {
			const value = pickField(produto, f);
			return value !== null ? `${f.label}: ${value}` : null;
		})
		.filter((s): s is string => s !== null)
		.join(" · ");

	// -# só vira subtexto no Discord se estiver no início absoluto da linha - sem indentação aqui.
	return [destaque, secundario ? `-# ${secundario}` : null]
		.filter((s): s is string => !!s)
		.join("\n");
}

async function produtosPorContrato(
	contratos: IxcRegistro[],
): Promise<(registro: IxcRegistro) => string | null> {
	return extraByForeignKey(
		CONTRATO_PRODUTOS_TABLE,
		CONTRATO_PRODUTOS_FK_CONTRATO_COLUMN,
		contratos,
		(rows) => {
			if (rows.length === 0) return "**Produtos:** nenhum";
			const blocos = rows.map(formatContratoProduto).join("\n\n");
			return `**Produtos (${rows.length}):**\n${blocos}`;
		},
	);
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
		case "contrato": {
			const buscado = await buscarContrato(busca);
			const registros = await decorateContratosComCliente(buscado.registros);
			const result = { ...buscado, registros };
			return {
				result,
				view: CONTRATO_VIEW,
				extraFor: await produtosPorContrato(registros),
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
				.setName("contrato")
				.setDescription("Busca contrato por id.")
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
					"Uso: `!ixc buscar|buscar-doc|contrato|produto <id ou nome>`.",
				),
			);
			return;
		}

		try {
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

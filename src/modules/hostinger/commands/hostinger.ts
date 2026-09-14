import type { Message } from "discord.js";
import {
	ContainerBuilder,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, formatCodeblock, userMention } from "@/utils/format";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import {
	deleteZoneRecord,
	getZoneRecords,
	type HostingerZoneEntry,
	upsertZoneRecord,
} from "../api";
import {
	grant,
	hasScope,
	isBotOwner,
	isKnownScope,
	revoke,
	SCOPES,
} from "../permissions";

const DEFAULT_TTL = 3600;
const NO_PERM_MSG =
	"Você não tem permissão pra mexer no DNS da Hostinger. Peça pra alguém com acesso rodar `!hostinger add-perm`.";

/*
 * Permissão própria (tabela hostinger_permissions), não guard do framework - isso é acesso a
 * infra da empresa, não config de servidor Discord, então não é cargo/permissão do Discord que
 * decide (ver src/modules/hostinger/permissions.ts). Mesma ideia do `isAdmin` manual do
 * !zabbix (src/modules/zabbix/commands/zabbix.ts): cada subcomando sensível checa na mão.
 */

/** Se o último token for só dígitos, é o ttl; senão usa DEFAULT_TTL e o token volta pro conteúdo. */
function splitContentAndTtl(tokens: string[]): {
	content: string;
	ttl: number;
} {
	const last = tokens.at(-1);
	if (tokens.length > 1 && last && /^\d+$/.test(last)) {
		return { content: tokens.slice(0, -1).join(" "), ttl: Number(last) };
	}
	return { content: tokens.join(" "), ttl: DEFAULT_TTL };
}

interface RecordRow {
	type: string;
	name: string;
	content: string;
}

/** Sem ttl de propósito (só tipo/endereço/ip, como pedido) - fica em `HostingerZoneEntry.ttl` se algum dia precisar de volta. */
function toRows(entries: HostingerZoneEntry[]): RecordRow[] {
	return entries.flatMap((e) =>
		e.records.map((r) => ({ type: e.type, name: e.name, content: r.content })),
	);
}

const HEADER: RecordRow = { type: "TIPO", name: "ENDEREÇO", content: "IP" };

/** Larguras fixas calculadas em cima de TODAS as linhas (não só a página atual) - senão a coluna
 * "pula" de largura ao navegar entre páginas. */
function columnWidths(rows: RecordRow[]): { typeW: number; nameW: number } {
	return {
		typeW: Math.max(HEADER.type.length, ...rows.map((r) => r.type.length)),
		nameW: Math.max(HEADER.name.length, ...rows.map((r) => r.name.length)),
	};
}

function formatRow(
	row: RecordRow,
	w: { typeW: number; nameW: number },
): string {
	return `${row.type.padEnd(w.typeW)}  ${row.name.padEnd(w.nameW)}  ${row.content}`;
}

// Um domínio de verdade acumula registro (SPF, DKIM, subdomínios...) até passar dos 4000 chars
// que o Discord aceita por TextDisplay - já bateu nisso em produção (Invalid string length).
// Pagina em vez de truncar e esconder registro - mesmo helper reutilizável do !ixc.
const PER_PAGE = 20;

interface RecordsReply {
	flags: MessageFlags.IsComponentsV2;
	components: (ContainerBuilder | ReturnType<typeof buildPaginationRow>)[];
}

function renderRecordsPage(
	rows: RecordRow[],
	emptyMsg: string,
	page: number,
	interactive: boolean,
): RecordsReply {
	const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
	const clamped = Math.min(page, pages - 1);
	const slice = rows.slice(clamped * PER_PAGE, (clamped + 1) * PER_PAGE);

	const container = new ContainerBuilder();
	if (slice.length === 0) {
		container.addTextDisplayComponents((td) => td.setContent(emptyMsg));
	} else {
		const w = columnWidths(rows);
		const table = [
			formatRow(HEADER, w),
			...slice.map((r) => formatRow(r, w)),
		].join("\n");
		container.addTextDisplayComponents((td) =>
			td.setContent(formatCodeblock(table)),
		);
	}

	const components: RecordsReply["components"] = [container];
	if (interactive && pages > 1)
		components.push(buildPaginationRow(clamped, pages));
	return { flags: MessageFlags.IsComponentsV2, components };
}

export default defineCommand({
	name: "hostinger",
	description: "Administração da conta Hostinger (por enquanto, só DNS).",
	category: CommandCategory.ADMIN,
	showOnHelp: true,

	options: new SlashCommandBuilder()
		.addSubcommandGroup((g) =>
			g
				.setName("dns")
				.setDescription("Gerência de registros DNS.")
				.addSubcommand((s) =>
					s
						.setName("list")
						.setDescription("Lista os registros DNS do domínio.")
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Ex: falevox.com")
								.setRequired(true),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("add")
						.setDescription("Cria ou atualiza um registro DNS.")
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Ex: falevox.com")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("nome")
								.setDescription("Ex: www, @, _dmarc")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("tipo")
								.setDescription("Ex: A, CNAME, TXT, MX")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("conteudo")
								.setDescription("Valor do registro")
								.setRequired(true),
						)
						.addIntegerOption((o) =>
							o.setName("ttl").setDescription(`Padrão: ${DEFAULT_TTL}`),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("edit")
						.setDescription(
							"Alias de `add` - a Hostinger já faz upsert por nome+tipo.",
						)
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Ex: falevox.com")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("nome")
								.setDescription("Ex: www, @, _dmarc")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("tipo")
								.setDescription("Ex: A, CNAME, TXT, MX")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("conteudo")
								.setDescription("Valor do registro")
								.setRequired(true),
						)
						.addIntegerOption((o) =>
							o.setName("ttl").setDescription(`Padrão: ${DEFAULT_TTL}`),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("remove")
						.setDescription("Remove um registro DNS.")
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Ex: falevox.com")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("nome")
								.setDescription("Ex: www, @, _dmarc")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("tipo")
								.setDescription("Ex: A, CNAME, TXT, MX")
								.setRequired(true),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("search")
						.setDescription(
							"Procura registros do domínio por nome ou por conteúdo (ex: IP).",
						)
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Ex: falevox.com")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("termo")
								.setDescription("Trecho do nome ou do conteúdo (ex: um IP)")
								.setRequired(true),
						),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("add-perm")
				.setDescription("Dá acesso a uma área do módulo hostinger pra alguém.")
				.addUserOption((o) =>
					o
						.setName("usuario")
						.setDescription("Quem recebe o acesso")
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("escopo")
						.setDescription("Área liberada")
						.setRequired(true)
						.addChoices(...SCOPES.map((s) => ({ name: s, value: s }))),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("remove-perm")
				.setDescription(
					"Remove o acesso de alguém a uma área do módulo hostinger.",
				)
				.addUserOption((o) =>
					o
						.setName("usuario")
						.setDescription("De quem tirar o acesso")
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("escopo")
						.setDescription("Área revogada")
						.setRequired(true)
						.addChoices(...SCOPES.map((s) => ({ name: s, value: s }))),
				),
		),

	async executeAsSlash(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(true);

		if (sub === "add-perm" || sub === "remove-perm") {
			if (!isBotOwner(interaction.user.id)) {
				await interaction.reply({
					...EmbedFormatter.error(
						"Só os devs do bot podem gerenciar permissões da Hostinger.",
					),
					ephemeral: true,
				});
				return;
			}
			const user = interaction.options.getUser("usuario", true);
			const escopo = interaction.options.getString("escopo", true);
			if (!isKnownScope(escopo)) {
				await interaction.reply({
					...EmbedFormatter.error("Escopo inválido."),
					ephemeral: true,
				});
				return;
			}
			await interaction.reply({
				...(await runPermCommand(sub, user.id, escopo, interaction.user.id)),
				ephemeral: true,
			});
			return;
		}

		if (group !== "dns") return;

		if (!(await hasScope(interaction.user.id, "dns"))) {
			await interaction.reply({
				...EmbedFormatter.error(NO_PERM_MSG),
				ephemeral: true,
			});
			return;
		}

		const dominio = interaction.options.getString("dominio", true);

		if (sub === "list") {
			await interaction.deferReply({ ephemeral: true });
			const rows = await runList(dominio);
			await presentRecordsPage(
				rows,
				`Nenhum registro DNS em ${dominio}.`,
				interaction.user.id,
				(payload) => interaction.editReply(payload),
			);
			return;
		}

		if (sub === "add" || sub === "edit") {
			const nome = interaction.options.getString("nome", true);
			const tipo = interaction.options.getString("tipo", true);
			const conteudo = interaction.options.getString("conteudo", true);
			const ttl = interaction.options.getInteger("ttl") ?? DEFAULT_TTL;
			await interaction.deferReply({ ephemeral: true });
			await interaction.editReply(
				await runUpsert(dominio, nome, tipo, conteudo, ttl),
			);
			return;
		}

		if (sub === "remove") {
			const nome = interaction.options.getString("nome", true);
			const tipo = interaction.options.getString("tipo", true);
			await interaction.deferReply({ ephemeral: true });
			await interaction.editReply(await runRemove(dominio, nome, tipo));
			return;
		}

		if (sub === "search") {
			const termo = interaction.options.getString("termo", true);
			await interaction.deferReply({ ephemeral: true });
			const rows = await runSearch(dominio, termo);
			await presentRecordsPage(
				rows,
				`Nada em ${dominio} bate com "${termo}".`,
				interaction.user.id,
				(payload) => interaction.editReply(payload),
			);
		}
	},

	async executeAsPrefix(message, args) {
		const group = args.getSubcommandGroup();
		const sub = args.getSubcommand();

		if (sub === "add-perm" || sub === "remove-perm") {
			if (!isBotOwner(message.author.id)) {
				await message.reply(
					EmbedFormatter.error(
						"Só os devs do bot podem gerenciar permissões da Hostinger.",
					),
				);
				return;
			}
			const user = await args.getUser("usuario");
			const escopo = args.getString("escopo");
			if (!user || !escopo || !isKnownScope(escopo)) {
				await message.reply(
					EmbedFormatter.warn(
						`Uso: \`!hostinger ${sub} @usuario <${SCOPES.join("|")}>\`.`,
					),
				);
				return;
			}
			await message.reply(
				await runPermCommand(sub, user.id, escopo, message.author.id),
			);
			return;
		}

		if (group !== "dns") {
			await message.reply(
				EmbedFormatter.warn(
					"Uso: `!hostinger dns <list|add|edit|remove|search> ...` ou `!hostinger <add-perm|remove-perm> ...`.",
				),
			);
			return;
		}

		if (!(await hasScope(message.author.id, "dns"))) {
			await message.reply(EmbedFormatter.error(NO_PERM_MSG));
			return;
		}

		const tokens = args.getRawArgs();
		const dominio = tokens[0];
		if (!dominio) {
			await message.reply(
				EmbedFormatter.warn(`Uso: \`!hostinger dns ${sub} <dominio> ...\`.`),
			);
			return;
		}

		if (sub === "list") {
			const rows = await runList(dominio);
			await presentRecordsPage(
				rows,
				`Nenhum registro DNS em ${dominio}.`,
				message.author.id,
				(payload) => message.reply(payload),
			);
			return;
		}

		if (sub === "add" || sub === "edit") {
			const [nome, tipo, ...resto] = tokens.slice(1);
			if (!nome || !tipo || resto.length === 0) {
				await message.reply(
					EmbedFormatter.warn(
						`Uso: \`!hostinger dns ${sub} <dominio> <nome> <tipo> <conteudo> [ttl]\`.`,
					),
				);
				return;
			}
			const { content, ttl } = splitContentAndTtl(resto);
			await message.reply(await runUpsert(dominio, nome, tipo, content, ttl));
			return;
		}

		if (sub === "remove") {
			const [nome, tipo] = tokens.slice(1);
			if (!nome || !tipo) {
				await message.reply(
					EmbedFormatter.warn(
						"Uso: `!hostinger dns remove <dominio> <nome> <tipo>`.",
					),
				);
				return;
			}
			await message.reply(await runRemove(dominio, nome, tipo));
			return;
		}

		if (sub === "search") {
			const termo = tokens.slice(1).join(" ");
			if (!termo) {
				await message.reply(
					EmbedFormatter.warn(
						"Uso: `!hostinger dns search <dominio> <termo>`.",
					),
				);
				return;
			}
			const rows = await runSearch(dominio, termo);
			await presentRecordsPage(
				rows,
				`Nada em ${dominio} bate com "${termo}".`,
				message.author.id,
				(payload) => message.reply(payload),
			);
		}
	},
});

/**
 * Renderiza uma página de `rows` (com botões se houver mais de uma), manda via `send` e, se
 * precisar de navegação, prende `attachPagination` na mensagem devolvida - mesmo padrão do !ixc
 * (src/modules/ixc/commands/ixc.ts), reaproveitado em vez de reinventar chunking manual.
 */
async function presentRecordsPage(
	rows: RecordRow[],
	emptyMsg: string,
	invokerId: string,
	send: (payload: RecordsReply) => Promise<Message>,
): Promise<void> {
	const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
	const render = (page: number, interactive: boolean) =>
		renderRecordsPage(rows, emptyMsg, page, interactive);
	const sent = await send(render(0, pages > 1));
	if (pages > 1) attachPagination(sent, { invokerId, pages, render });
}

async function runList(dominio: string): Promise<RecordRow[]> {
	const entries = await getZoneRecords(dominio);
	return toRows(entries);
}

async function runUpsert(
	dominio: string,
	nome: string,
	tipo: string,
	conteudo: string,
	ttl: number,
) {
	await upsertZoneRecord(dominio, {
		name: nome,
		type: tipo.toUpperCase(),
		ttl,
		records: [{ content: conteudo }],
	});
	return EmbedFormatter.success(
		`Registro \`${tipo.toUpperCase()}\` **${nome}** de ${dominio} → ${conteudo} (ttl ${ttl}).`,
	);
}

async function runRemove(dominio: string, nome: string, tipo: string) {
	await deleteZoneRecord(dominio, nome, tipo.toUpperCase());
	return EmbedFormatter.success(
		`Registro \`${tipo.toUpperCase()}\` **${nome}** de ${dominio} removido.`,
	);
}

async function runSearch(dominio: string, termo: string): Promise<RecordRow[]> {
	const entries = await getZoneRecords(dominio);
	const alvo = termo.toLowerCase();
	const found = entries.filter(
		(e) =>
			e.name.toLowerCase().includes(alvo) ||
			e.type.toLowerCase() === alvo ||
			e.records.some((r) => r.content.toLowerCase().includes(alvo)),
	);
	return toRows(found);
}

async function runPermCommand(
	sub: "add-perm" | "remove-perm",
	userId: string,
	escopo: (typeof SCOPES)[number],
	grantedBy: string,
) {
	if (sub === "add-perm") {
		await grant(userId, escopo, grantedBy);
		return EmbedFormatter.success(
			`${userMention(userId)} agora tem acesso a \`${escopo}\` na Hostinger.`,
		);
	}
	const removed = await revoke(userId, escopo);
	return removed
		? EmbedFormatter.success(
				`Acesso de ${userMention(userId)} a \`${escopo}\` na Hostinger removido.`,
			)
		: EmbedFormatter.warn(
				`${userMention(userId)} não tinha acesso a \`${escopo}\`.`,
			);
}

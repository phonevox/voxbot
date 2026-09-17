import type { Message } from "discord.js";
import {
	ContainerBuilder,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { type ConfirmField, confirmAction } from "@/utils/confirm";
import { EmbedFormatter, formatCodeblock, userMention } from "@/utils/format";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import {
	deleteZoneRecord,
	getZoneRecords,
	type HostingerZoneEntry,
	listDomains,
	resolveDomain,
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

// Lista fechada pro <select> de tipo do slash (`.addChoices`) e pra validar o `tipo` digitado
// via prefixo (case-insensitive - ver normalizeRecordType).
const RECORD_TYPES = [
	"A",
	"AAAA",
	"CNAME",
	"MX",
	"TXT",
	"NS",
	"SRV",
	"CAA",
] as const;
type RecordType = (typeof RECORD_TYPES)[number];

function normalizeRecordType(value: string): RecordType | null {
	const upper = value.toUpperCase();
	return (RECORD_TYPES as readonly string[]).includes(upper)
		? (upper as RecordType)
		: null;
}

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
				.setDescription("Gerência simples de registros DNS (sempre tipo A).")
				.addSubcommand((s) =>
					s
						.setName("list")
						.setDescription("Lista os registros DNS do domínio.")
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Domínio da conta")
								.setRequired(true)
								.setAutocomplete(true),
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
				)
				.addSubcommand((s) =>
					s
						.setName("set")
						.setDescription(
							"Cria ou atualiza um registro A - domínio completo, com ou sem subdomínio.",
						)
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription(
									"Domínio completo - ex: voip.sofon.cloud, *.batata.falevox.com.br",
								)
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("ip")
								.setDescription("Endereço IP do registro A")
								.setRequired(true),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("remove")
						.setDescription("Remove o registro A de um domínio completo.")
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Domínio completo - ex: voip.sofon.cloud")
								.setRequired(true),
						),
				),
		)
		.addSubcommandGroup((g) =>
			g
				.setName("advanceddns")
				.setDescription(
					"Gerência de DNS com controle total - qualquer tipo de registro.",
				)
				.addSubcommand((s) =>
					s
						.setName("add")
						.setDescription(
							"Cria ou atualiza um registro DNS de qualquer tipo.",
						)
						.addStringOption((o) =>
							o
								.setName("tipo")
								.setDescription("Tipo do registro")
								.setRequired(true)
								.addChoices(
									...RECORD_TYPES.map((t) => ({ name: t, value: t })),
								),
						)
						.addStringOption((o) =>
							o
								.setName("subdominio")
								.setDescription("Ex: www, @, _dmarc, *.api")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Domínio da conta")
								.setRequired(true)
								.setAutocomplete(true),
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
						.setDescription("Remove um registro DNS de qualquer tipo.")
						.addStringOption((o) =>
							o
								.setName("subdominio")
								.setDescription("Ex: www, @, _dmarc, *.api")
								.setRequired(true),
						)
						.addStringOption((o) =>
							o
								.setName("dominio")
								.setDescription("Domínio da conta")
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addStringOption((o) =>
							o
								.setName("tipo")
								.setDescription("Tipo do registro")
								.setRequired(true)
								.addChoices(
									...RECORD_TYPES.map((t) => ({ name: t, value: t })),
								),
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

	// ── Autocomplete ──────────────────────────────────────────────────────────
	async executeAutocomplete(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(false);
		const isDomainAutocomplete =
			group === "advanceddns" || (group === "dns" && sub === "list");
		if (
			!isDomainAutocomplete ||
			!(await hasScope(interaction.user.id, "dns"))
		) {
			await interaction.respond([]);
			return;
		}

		const focused = interaction.options.getFocused().toLowerCase();
		const domains = await listDomains().catch(() => []);
		const choices = domains
			.map((d) => d.domain)
			.filter((d) => d.toLowerCase().includes(focused))
			.slice(0, 25);
		await interaction.respond(choices.map((d) => ({ name: d, value: d })));
	},

	// ── Slash ─────────────────────────────────────────────────────────────────
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

		if (group !== "dns" && group !== "advanceddns") return;

		if (!(await hasScope(interaction.user.id, "dns"))) {
			await interaction.reply({
				...EmbedFormatter.error(NO_PERM_MSG),
				ephemeral: true,
			});
			return;
		}

		if (group === "dns") {
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
				return;
			}

			if (sub === "set") {
				const ip = interaction.options.getString("ip", true);
				await interaction.deferReply({ ephemeral: true });
				const resolved = await resolveDomain(dominio);
				if (!resolved) {
					await interaction.editReply(domainNotFound(dominio));
					return;
				}
				await confirmAction({
					invokerId: interaction.user.id,
					title: "Criar/atualizar esse registro?",
					fields: recordFields("A", resolved.subdomain, resolved.domain, ip),
					send: (payload) => interaction.editReply(payload),
					onConfirm: () =>
						runUpsert(
							resolved.domain,
							resolved.subdomain,
							"A",
							ip,
							DEFAULT_TTL,
						),
				});
				return;
			}

			if (sub === "remove") {
				await interaction.deferReply({ ephemeral: true });
				const resolved = await resolveDomain(dominio);
				if (!resolved) {
					await interaction.editReply(domainNotFound(dominio));
					return;
				}
				await confirmAction({
					invokerId: interaction.user.id,
					title: "Remover esse registro?",
					fields: recordFields("A", resolved.subdomain, resolved.domain),
					send: (payload) => interaction.editReply(payload),
					onConfirm: () => runRemove(resolved.domain, resolved.subdomain, "A"),
				});
			}
			return;
		}

		// group === "advanceddns"
		const dominio = interaction.options.getString("dominio", true);
		const nome = interaction.options.getString("subdominio", true);
		const tipo = interaction.options.getString("tipo", true);

		if (sub === "add") {
			const conteudo = interaction.options.getString("conteudo", true);
			const ttl = interaction.options.getInteger("ttl") ?? DEFAULT_TTL;
			await interaction.deferReply({ ephemeral: true });
			await confirmAction({
				invokerId: interaction.user.id,
				title: "Criar/atualizar esse registro?",
				fields: recordFields(tipo, nome, dominio, conteudo),
				send: (payload) => interaction.editReply(payload),
				onConfirm: () => runUpsert(dominio, nome, tipo, conteudo, ttl),
			});
			return;
		}

		if (sub === "remove") {
			await interaction.deferReply({ ephemeral: true });
			await confirmAction({
				invokerId: interaction.user.id,
				title: "Remover esse registro?",
				fields: recordFields(tipo, nome, dominio),
				send: (payload) => interaction.editReply(payload),
				onConfirm: () => runRemove(dominio, nome, tipo),
			});
		}
	},

	// ── Prefix ────────────────────────────────────────────────────────────────
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

		if (group !== "dns" && group !== "advanceddns") {
			await message.reply(
				EmbedFormatter.warn(
					"Uso: `!hostinger dns <list|search|set|remove> ...`, `!hostinger advanceddns <add|remove> ...` ou `!hostinger <add-perm|remove-perm> ...`.",
				),
			);
			return;
		}

		if (!(await hasScope(message.author.id, "dns"))) {
			await message.reply(EmbedFormatter.error(NO_PERM_MSG));
			return;
		}

		const tokens = args.getRawArgs();

		if (group === "dns") {
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
				return;
			}

			if (sub === "set") {
				const ip = tokens[1];
				if (!ip) {
					await message.reply(
						EmbedFormatter.warn("Uso: `!hostinger dns set <dominio> <ip>`."),
					);
					return;
				}
				const resolved = await resolveDomain(dominio);
				if (!resolved) {
					await message.reply(domainNotFound(dominio));
					return;
				}
				await confirmAction({
					invokerId: message.author.id,
					title: "Criar/atualizar esse registro?",
					fields: recordFields("A", resolved.subdomain, resolved.domain, ip),
					send: (payload) => message.reply(payload),
					onConfirm: () =>
						runUpsert(
							resolved.domain,
							resolved.subdomain,
							"A",
							ip,
							DEFAULT_TTL,
						),
				});
				return;
			}

			if (sub === "remove") {
				const resolved = await resolveDomain(dominio);
				if (!resolved) {
					await message.reply(domainNotFound(dominio));
					return;
				}
				await confirmAction({
					invokerId: message.author.id,
					title: "Remover esse registro?",
					fields: recordFields("A", resolved.subdomain, resolved.domain),
					send: (payload) => message.reply(payload),
					onConfirm: () => runRemove(resolved.domain, resolved.subdomain, "A"),
				});
			}
			return;
		}

		// group === "advanceddns"
		if (sub === "add") {
			const [tipo, nome, dominio, ...resto] = tokens;
			if (!tipo || !nome || !dominio || resto.length === 0) {
				await message.reply(
					EmbedFormatter.warn(
						`Uso: \`!hostinger advanceddns add <${RECORD_TYPES.join("|")}> <subdominio> <dominio> <conteudo> [ttl]\`.`,
					),
				);
				return;
			}
			const recordType = normalizeRecordType(tipo);
			if (!recordType) {
				await message.reply(
					EmbedFormatter.warn(
						`Tipo inválido - use um de: ${RECORD_TYPES.join(", ")}.`,
					),
				);
				return;
			}
			const { content, ttl } = splitContentAndTtl(resto);
			await confirmAction({
				invokerId: message.author.id,
				title: "Criar/atualizar esse registro?",
				fields: recordFields(recordType, nome, dominio, content),
				send: (payload) => message.reply(payload),
				onConfirm: () => runUpsert(dominio, nome, recordType, content, ttl),
			});
			return;
		}

		if (sub === "remove") {
			const [nome, dominio, tipo] = tokens;
			if (!nome || !dominio || !tipo) {
				await message.reply(
					EmbedFormatter.warn(
						"Uso: `!hostinger advanceddns remove <subdominio> <dominio> <tipo>`.",
					),
				);
				return;
			}
			const recordType = normalizeRecordType(tipo);
			if (!recordType) {
				await message.reply(
					EmbedFormatter.warn(
						`Tipo inválido - use um de: ${RECORD_TYPES.join(", ")}.`,
					),
				);
				return;
			}
			await confirmAction({
				invokerId: message.author.id,
				title: "Remover esse registro?",
				fields: recordFields(recordType, nome, dominio),
				send: (payload) => message.reply(payload),
				onConfirm: () => runRemove(dominio, nome, recordType),
			});
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

function domainNotFound(fullDomain: string) {
	return EmbedFormatter.error(
		`"${fullDomain}" não bate com nenhum domínio da conta Hostinger.`,
	);
}

/** Resumo pro diálogo de confirmação (`confirmAction`) - `destino` de fora só faz sentido pra
 * criar/atualizar (`dns set`, `advanceddns add`); remover não tem o que mostrar aí. */
function recordFields(
	tipo: string,
	subdominio: string,
	dominio: string,
	destino?: string,
): ConfirmField[] {
	const fields: ConfirmField[] = [
		{ label: "Tipo", value: tipo.toUpperCase() },
		{ label: "Subdomínio", value: subdominio },
		{ label: "Domínio", value: dominio },
	];
	if (destino !== undefined) fields.push({ label: "Destino", value: destino });
	return fields;
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

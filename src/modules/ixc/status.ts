// Enums de status do IXC - compartilhado entre o comando real (ixc.ts) e o teste de design
// (src/modules/test/tests/ixcsoftPaginado.ts). Bolinha colorida simples, sem emoji chamativo.

export interface StatusEntry {
	emoji: string;
	label: string;
}

// Status do CONTRATO (cliente_contrato.status) - código real do IXC (P/A/I/N/D).
export const STATUS_CONTRATO: Record<string, StatusEntry> = {
	P: { emoji: "⚪", label: "Pré-contrato" },
	A: { emoji: "🟢", label: "Ativo" },
	I: { emoji: "⚫", label: "Inativo" },
	N: { emoji: "🔴", label: "Negativado" },
	D: { emoji: "🟤", label: "Desistiu" },
};

// "Status Acesso" (o que controla bloqueio/desbloqueio) - a coluna real do IXC costuma se chamar
// status_internet, mas o LABEL visível nunca usa essa palavra.
export const STATUS_ACESSO: Record<string, StatusEntry> = {
	A: { emoji: "🟢", label: "Ativo" },
	D: { emoji: "⚫", label: "Desativado" },
	CM: { emoji: "🔴", label: "Bloqueio Manual" },
	CA: { emoji: "🟠", label: "Bloqueio Automático" },
	FA: { emoji: "🟡", label: "Financeiro em atraso" },
	AA: { emoji: "⚪", label: "Aguardando Assinatura" },
};

/** Entre crase (inclusive o emoji) pra destacar mais que um KV comum. Código desconhecido cai
 * pro fallback cru, também com crase, em vez de sumir. */
export function formatStatusCode(
	map: Record<string, StatusEntry>,
	code: string,
): string {
	const entry = map[code];
	return entry ? `\`${entry.emoji} ${entry.label}\`` : `\`${code}\``;
}

const ATIVO_TRUE = new Set(["1", "s", "sim", "y", "yes", "true"]);

export function parseAtivo(raw: string): boolean {
	return ATIVO_TRUE.has(raw.trim().toLowerCase());
}

export function formatAtivo(raw: string): string {
	return parseAtivo(raw) ? "`🟢 Ativo`" : "`⚫ Inativo`";
}

import { config } from "@/config";
import { Logger } from "@/utils/logging";

const logger = new Logger("ixc.client");

export type IxcRegistro = Record<string, unknown>;

export interface IxcListResult {
	total: number;
	registros: IxcRegistro[];
}

/** POST em `<baseUrl>/webservice/v1/<tabela>`. MOD_IXCSOFT_TOKEN é "id:senha" cru, vira Basic aqui. */
async function ixcRequest(
	table: string,
	operation: "listar" | "obter",
	body: Record<string, unknown>,
): Promise<IxcListResult> {
	if (!config.ixc.baseUrl || !config.ixc.token) {
		throw new Error(
			"Integração com o IXC não configurada (faltam MOD_IXCSOFT_BASE_URL/MOD_IXCSOFT_TOKEN).",
		);
	}

	const authorization = `Basic ${Buffer.from(config.ixc.token).toString("base64")}`;

	const url = `${config.ixc.baseUrl}/webservice/v1/${table}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: authorization,
			ixcsoft: operation,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const raw = await res.text();

	if (!res.ok) {
		logger.error(
			`IXC ${res.status} ${res.statusText} em POST ${url} (ixcsoft: ${operation}, body: ${JSON.stringify(body)}) - resposta: ${raw.slice(0, 1000)}`,
		);
		throw new Error(`IXC respondeu ${res.status} ${res.statusText}`);
	}

	let data: { total?: string | number; registros?: IxcRegistro[] };
	try {
		data = raw ? JSON.parse(raw) : {};
	} catch (err) {
		logger.error(
			`IXC devolveu um corpo que não é JSON válido em POST ${url}: ${raw.slice(0, 1000)}`,
		);
		throw new Error(
			`Resposta do IXC não é JSON válido: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		total: Number(data.total ?? 0),
		registros: Array.isArray(data.registros) ? data.registros : [],
	};
}

/** Máximo de registros por busca - o comando pagina em cima disso, então dá pra trazer mais. */
export const MAX_RESULTS = 20;

function isNumeric(value: string): boolean {
	return /^\d+$/.test(value.trim());
}

/** Id numérico -> operador "=". Texto -> "L" (LIKE), com `%` nas duas pontas. */
export async function searchByIdOrText(
	table: string,
	idColumn: string,
	textColumn: string,
	input: string,
): Promise<IxcListResult> {
	const trimmed = input.trim();
	const numeric = isNumeric(trimmed);
	return ixcRequest(table, "listar", {
		qtype: numeric ? `${table}.${idColumn}` : `${table}.${textColumn}`,
		query: numeric ? trimmed : `%${trimmed}%`,
		oper: numeric ? "=" : "L",
		page: "1",
		rp: String(MAX_RESULTS),
	});
}

/** Lista registros cuja FK bate com qualquer um dos ids passados (operador "IN" do IXC). */
export async function searchByForeignKeyIn(
	table: string,
	fkColumn: string,
	ids: (string | number)[],
): Promise<IxcListResult> {
	if (ids.length === 0) return { total: 0, registros: [] };
	return ixcRequest(table, "listar", {
		qtype: `${table}.${fkColumn}`,
		query: ids.join(","),
		oper: "IN",
		page: "1",
		rp: String(MAX_RESULTS),
	});
}

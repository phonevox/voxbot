import type { TestFn } from "./context";
import embedFormatter from "./embedFormatter";
import ixcsoftPaginado from "./ixcsoftPaginado";

/** Keyword -> teste. Namespace livre (ex: "design/x") - só precisa bater com o que `!test` recebe. */
export const TESTS: Record<string, TestFn> = {
	"design/embed-formatter": embedFormatter,
	"design/ixcsoft-paginado": ixcsoftPaginado,
};

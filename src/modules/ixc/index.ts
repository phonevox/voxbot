import { defineCog } from "@/define";
import _ixc from "./commands/ixc";

export default defineCog({
	name: "ixc",
	description: "Consulta cliente/contrato/produto no IXC Provedor.",
	authors: [{ name: "adrian", id: 188851299255713792n }],
	commands: [_ixc],
});

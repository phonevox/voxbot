import { defineCog } from "@/define";
import _autobloqueador from "./commands/autobloqueador";
import { AUTOBLOQUEADOR_SCHEMA } from "./migrations";

export default defineCog({
	name: "autobloqueador",
	description:
		"Controle do Auto-Bloqueador Magnus - força atualização e gerencia quem pode usar o comando.",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_autobloqueador],
	migrations: [AUTOBLOQUEADOR_SCHEMA],
});

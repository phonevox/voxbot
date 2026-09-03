import { defineCog } from "@/define";
import _request from "./commands/request";

export default defineCog({
	name: "request",
	description: "Utilitário pra disparar requisições HTTP arbitrárias, pra debug/testes.",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_request],
});

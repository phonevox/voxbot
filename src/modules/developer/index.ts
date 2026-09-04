import { defineCog } from "@/define";
import _quip from "./commands/quip";
import _request from "./commands/request";

export default defineCog({
	name: "developer",
	description: "Ferramentas de debug/dev - só pro dono do bot.",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_request, _quip],
});

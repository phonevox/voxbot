import { defineCog } from "@/define";
import _embed from "./commands/embed";
import _quip from "./commands/quip";
import _request from "./commands/request";

export default defineCog({
	name: "developer",
	description: "Ferramentas de debug/dev.",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_request, _quip, _embed],
});

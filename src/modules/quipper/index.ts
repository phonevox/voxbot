import { defineCog } from "@/define";
import _quip from "./commands/quip";

export default defineCog({
	name: "quipper",
	description: "Quips aleatórias do bot",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_quip],
});

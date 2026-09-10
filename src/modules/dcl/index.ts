import { defineCog } from "@/define";
import _dcl from "./commands/dcl";

export default defineCog({
	name: "dcl",
	description: "Dynamic Cog Loader",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_dcl],
});

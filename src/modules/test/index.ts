import { defineCog } from "@/define";
import _test from "./commands/test";

export default defineCog({
	name: "test",
	description: "Gatilhos de teste visual/design (owner only).",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	commands: [_test],
});

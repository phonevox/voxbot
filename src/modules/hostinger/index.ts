import { defineCog } from "@/define";
import _hostinger from "./commands/hostinger";
import { HOSTINGER_SCHEMA } from "./migrations";

export default defineCog({
	name: "hostinger",
	description:
		"Administração da conta Hostinger da empresa (por enquanto, só DNS).",
	authors: [{ name: "voxbot", id: 0n }],

	commands: [_hostinger],
	migrations: [HOSTINGER_SCHEMA],
});

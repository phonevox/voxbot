import { defineCog } from "@/define";
import _help from "./commands/help";
// import echoCommand from "./commands/echo";
import _internals from "./commands/internals";
import _ping from "./commands/ping";
import _setprefix from "./commands/setprefix";

export default defineCog({
	name: "core",
	description: "Comandos nativos do bot",
	authors: [{ name: "masutty", id: 188851299255713792n }],
	// commands: [pingCommand, helpCommand, echoCommand, setprefixCommand],
	commands: [_help, _setprefix, _ping, _internals],
});

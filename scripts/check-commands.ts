/**
 * Loads every cog module and replays the exact same builder construction that
 * `registerSlashCommands` (src/core/CommandHandler.ts) does at real boot time - including the
 * fallback `SlashCommandBuilder` for commands with no `.options` (defineCommand alone only
 * validates commands that already have `.options`; a description-only command never touches
 * discord.js's validator until slash registration, at actual boot - this closes that gap).
 * Throws synchronously at construction time, no DB/Discord connection needed, so this is a
 * sub-second sanity check to run before deploying instead of finding out at bot boot.
 */
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { SlashCommandBuilder } from "discord.js";
import type { Cog } from "@/types";

const modulesPath = join(__dirname, "../src/modules");
let ok = true;

for (const entry of readdirSync(modulesPath)) {
    const fullPath = join(modulesPath, entry);
    if (!statSync(fullPath).isDirectory()) continue;

    try {
        const imported = require(join(fullPath, "index"));
        const cog: Cog = imported.default ?? imported;

        for (const cmd of cog.commands ?? []) {
            if (cmd.options) cmd.options.toJSON();
            else new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.description).toJSON();
        }
    } catch (err) {
        ok = false;
        console.error(`❌ ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

if (ok) console.log(`✅ All command trees valid.`);
process.exit(ok ? 0 : 1);

import logging
import os
import time
import sys
from typing import Optional

import discord
from aiohttp import ClientSession
from discord.ext import commands

logger = logging.getLogger("bot.core")


class DiscordBot(commands.Bot):  # Mudamos para herdar de commands.Bot
    def __init__(
        self,
        *args,
        command_prefix: str = "s!",
        when_mentioned: bool = False,
        web_client: ClientSession,
        intents: Optional[discord.Intents] = None,
        testing_guild_id: Optional[int] = None,
    ):
        """Initialization of the client."""
        if intents is None:
            intents = discord.Intents.default()
        intents.message_content = True
        intents.members = True
        intents.voice_states = True
        intents.guilds = True

        super().__init__(
            command_prefix=command_prefix if when_mentioned else None, intents=intents
        )  # Usamos commands.Bot
        self.web_client = web_client
        self.testing_guild_id = testing_guild_id

    async def on_tree_error(
        self,
        interaction: discord.Interaction,
        error: discord.app_commands.AppCommandError,
    ):
        """
        Capture global command errors.
        Needs binding: self.tree.on_error = self.on_tree_error
        Binding is being done at self.on_ready()
        """

        if not interaction.response.is_done():
            await interaction.response.defer(ephemeral=True)

        if isinstance(error, discord.app_commands.MissingPermissions):
            missing_perms = ", ".join(error.missing_permissions)
            await interaction.followup.send(
                f"❌ You need the following permissions to use this command: "
                f"`{missing_perms}`",
                ephemeral=True,
            )
        elif isinstance(error, discord.app_commands.CommandOnCooldown):
            await interaction.followup.send(
                f"⌛ Command is on cooldown! "
                f"Try again in **{error.retry_after:.2f}** seconds.",
                ephemeral=True,
            )
        elif isinstance(error, discord.app_commands.CheckFailure):
            await interaction.followup.send(
                "⛔ You don't have permission to use this command.", ephemeral=True
            )
        else:
            await interaction.followup.send(
                "❌ An unexpected error occurred.", ephemeral=True
            )
            logger.error(f"Unhandled command error: {error}", exc_info=True)

    async def on_ready(self):
        await self.wait_until_ready()
        self.tree.on_error = self.on_tree_error
        logger.info(f"Logged in as {self.user}")

    async def on_guild_join(self, guild: discord.Guild):
        logger.info(f"Joined {guild.name}")

    async def on_guild_remove(self, guild: discord.Guild):
        logger.info(f"Left {guild.name}")

    async def setup_hook(self) -> None:
        """Setup hook for loading commands and events."""
        logger.debug("setup_hook: Initializing...")

        try:
            # Register cogs
            await self.load_cogs()

            # Sync tree after loading cogs
            start_time = time.time()
            await self.tree.sync()  # `self.tree` já existe
            elapsed_time = time.time() - start_time
            logger.info(f"Tree took {elapsed_time:.2f} seconds to sync.")

        except Exception as e:
            logger.exception(f"setup_hook: error loading\n{e}")

    async def load_cogs(self) -> None:
        cog_dirs = [
            "src/bot/commands",
            "src/bot/events",
            "src/bot/modules",
        ]  # from root dir represents ./bot/commands ./bot/events ./bot/modules
        sucessful_cogs = []
        failed_cogs = []
        cogloader_start_time = time.time()

        logger.debug("- Loading cogs...")
        for directory in cog_dirs:
            for filename in os.listdir(directory):
                if filename.endswith(".py") and not filename.startswith("__"):
                    module_name = f"{directory.replace('/', '.')}.{filename[:-3]}"
                    try:
                        await self.load_extension(
                            module_name
                        )  # Usamos load_extension diretamente
                        logger.debug(f"Success: {module_name}")
                        sucessful_cogs.append(module_name)
                    except Exception as e:
                        logger.exception(f"Failed: {module_name} -> {e}")
                        failed_cogs.append(module_name)
                        if (
                            os.getenv("BREAK_ON_COG_LOAD_FAILURE", "false").lower()
                            == "true"  # noqa
                        ):
                            logger.critical("BREAK_ON_COG_LOAD_FAILURE is enabled. Exiting...")
                            sys.exit(1)

        cogloader_elapsed_time = time.time() - cogloader_start_time
        if failed_cogs:
            logger.warning(
                f"Cogs took {cogloader_elapsed_time:.2f} seconds to load. ({len(sucessful_cogs)} loaded, {len(failed_cogs)} failed)"
            )
            logger.error(f"Failed cogs: {', '.join(failed_cogs)}")
        else:
            logger.info(
                f"Cogs took {cogloader_elapsed_time:.2f} seconds to load. ({len(sucessful_cogs)} loaded)"
            )

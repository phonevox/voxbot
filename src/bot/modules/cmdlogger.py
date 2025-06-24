import logging

import discord
from discord import InteractionType
from discord.ext import commands


class CommandLogger(commands.Cog):
    def __init__(self, bot):
        self.module_name = "CommandLogger"
        self.bot = bot

    def __getLogger(self, name):
        return logging.getLogger(f"bot.module.{self.module_name}.{name}")

    @commands.Cog.listener()
    async def on_command(self, ctx: commands.Context):
        """Logs text-based (prefix) commands."""
        logger = self.__getLogger(
            f"on_command.G{ctx.guild.id}:C{ctx.channel.id}:U{ctx.author.id}"
        )
        try:
            command_name = ctx.command.qualified_name if ctx.command else "Unknown"
            args = ", ".join(f"{k}={v}" for k, v in ctx.kwargs.items())
            logger.command(
                f"'{ctx.author}' executed '{command_name}' with args: {args} in server '{ctx.guild}'"
            )
        except Exception as e:
            logger.error(f"Error logging command: {e}")

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        """Logs both slash commands and context menus."""
        logger = self.__getLogger(
            f"on_interaction.G{interaction.guild.id}:C{interaction.channel.id}:U{interaction.user.id}"
        )
        try:
            if interaction.type == InteractionType.autocomplete:
                # I do not recommend uncommenting this.
                # The idea behind this is to be an "Executed commands" only. Thats why we do not care for autocomplete interactions.
                # You can remove this if-else altogether, and get the exact interaction thats happening, if thats what you want.
                # l.debug(f"Ignoring autocomplete interaction...")
                return

            if interaction.command:
                command_name = interaction.command.qualified_name
                args = (
                    {k: v for k, v in vars(interaction.namespace).items()}
                    if hasattr(interaction, "namespace")
                    else {}
                )

                args_str = " ".join(f"{k}:{v}" for k, v in args.items()) if args else ""
                full_command_str = f"/{command_name} {args_str}".strip()

                logger.command(
                    f"'{interaction.user}' executed '{full_command_str}' in server '{interaction.guild}'"
                )

        except Exception as e:
            logger.error(f"Error logging interaction: {e}")


async def setup(bot):
    await bot.add_cog(CommandLogger(bot))

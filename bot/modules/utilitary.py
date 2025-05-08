import discord
import logging
import json
import time
import re
from datetime import datetime, timedelta
from discord import app_commands
from discord.ext import commands
from typing import Dict, List, Optional, Literal

MAX_DISCORD_MESSAGE_LENGTH = 2000

class Utilitary(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.module_name = "utilitary"
        self.logger = logging.getLogger("bot.module.utilitary")
        
    def __getLogger(self, name):
        return logging.getLogger(f"bot.module.{self.module_name}.{name}")

    @app_commands.command(name="messagedata", description="Display information about a message by its ID.")
    @app_commands.describe(messageid="Message ID to fetch")
    async def messagedata(self, interaction: discord.Interaction, messageid: str):
        l = self.__getLogger("messagedata")
        await interaction.response.defer(ephemeral=True)

        try:
            message_id = int(messageid)
        except ValueError:
            await interaction.followup.send("Invalid message ID. Make sure it's numeric.", ephemeral=True)
            return

        channel = interaction.channel
        try:
            message = await channel.fetch_message(message_id)
        except discord.NotFound:
            await interaction.followup.send("Message not found in this channel.", ephemeral=True)
            return
        except discord.Forbidden:
            await interaction.followup.send("Missing permissions to access the message.", ephemeral=True)
            return
        except discord.HTTPException as e:
            self.logger.error(f"Error fetching message: {e}")
            await interaction.followup.send("Failed to fetch the message due to an error.", ephemeral=True)
            return

        summary_dict = {
            "id": str(message.id),
            "channel_id": str(message.channel.id),
            "author": {
                "id": str(message.author.id),
                "name": message.author.name,
                "discriminator": message.author.discriminator,
                "display_name": message.author.display_name,
            },
            "content": message.content,
            "created_at": message.created_at.isoformat(),
            "attachments": [a.url for a in message.attachments],
            "embeds": [e.to_dict() for e in message.embeds],
            "mentions": [user.id for user in message.mentions],
            "pinned": message.pinned,
            "type": str(message.type),
        }

        json_text = json.dumps(summary_dict, indent=2)
        if len(json_text) > MAX_DISCORD_MESSAGE_LENGTH:
            json_text = json_text[:MAX_DISCORD_MESSAGE_LENGTH - 15] + "\n...[truncated]"

        await interaction.followup.send(f"```json\n{json_text}\n```", ephemeral=True)

    @app_commands.command(name="now", description="Returns the current timestamp with optional time operation.")
    @app_commands.describe(
        operation="Apply time operation (e.g., +1d50m)",
        return_as="Display format: all, relative, long, or long, date of week"
    )
    async def now(
        self,
        interaction: discord.Interaction,
        operation: Optional[str] = None,
        return_as: Optional[Literal["all", "relative", "long", "long, date of week"]] = "relative"
    ):
        """
        Returns the current UTC timestamp, optionally applying a time operation like +1d or -1h.
        """
        def parse_operation(operation: str) -> timedelta:
            """
            Parses the time operation (e.g., +1d, -1h) and returns a timedelta.
            Supports combining multiple operations (e.g., +1d50m).
            """
            pattern = r"([+-])(\d+)([a-zA-Z])"
            total_delta = timedelta()
            matches = re.findall(pattern, operation)

            for sign, value, unit in matches:
                value = int(value)
                if sign == '-':
                    value = -value

                if unit == 'd':
                    total_delta += timedelta(days=value)
                elif unit == 'h':
                    total_delta += timedelta(hours=value)
                elif unit == 'm':
                    total_delta += timedelta(minutes=value)
                elif unit == 's':
                    total_delta += timedelta(seconds=value)
                else:
                    raise ValueError(f"Invalid time unit: {unit}")

            return total_delta

        try:
            current_time = datetime.utcnow()

            if operation:
                delta = parse_operation(operation)
                current_time += delta

            timestamp = int(current_time.timestamp())

            if return_as == "relative":
                content = f"<t:{timestamp}:R>"
            elif return_as == "long, date of week":
                content = f"<t:{timestamp}:F>"
            elif return_as == "long":
                content = f"<t:{timestamp}:f>"
            else:  # "all"
                content = (
                    f"\n`<t:{timestamp}:R>`\n<t:{timestamp}:R>"
                    f"\n\n`<t:{timestamp}:F>`\n<t:{timestamp}:F>"
                    f"\n\n`<t:{timestamp}:f>`\n<t:{timestamp}:f>"
                )

            await interaction.response.send_message(content, ephemeral=True)

        except ValueError as e:
            await interaction.response.send_message(f"❌ Error: {str(e)}", ephemeral=True)

async def setup(bot: commands.Bot):
    await bot.add_cog(Utilitary(bot))

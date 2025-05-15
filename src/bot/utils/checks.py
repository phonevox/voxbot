import discord
import os
import logging
from dotenv import load_dotenv
from discord import app_commands
from discord.ext import commands

logger = logging.getLogger("bot.checks")

#PS: Predicates can only be used on app commands. It does not work for events

def is_me():
    def predicate(interaction: discord.Interaction) -> bool:
        bot_owner = int(os.getenv("BOT_OWNER", "0"))  # Converte para int com fallback para 0
        return interaction.user.id == bot_owner
    return app_commands.check(predicate)
    
def is_test_guild():
    def predicate(interaction: discord.Interaction) -> bool:
        return interaction.guild.id == os.getenv("TESTING_GUILD_ID" or interaction.guild.id in os.getenv("TESTING_GUILD_ID"))
    return app_commands.check(predicate)

def limit_to_guilds(guild_ids: list[int]):
    def predicate(interaction: discord.Interaction) -> bool:
        return interaction.guild and interaction.guild.id in guild_ids
    return app_commands.check(predicate)
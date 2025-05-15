import logging
import discord
from discord.ext import commands
from utils.guild_data_manager import GuildDataManager

class BaseModule(commands.Cog):
    module_name = "base"  # Substitua isso nas subclasses

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.logger = logging.getLogger(f"bot.module.{self.module_name}")
        self.data = GuildDataManager(self.module_name)

    # Exemplo comentado de comando (para referência em subclasses)
    # @discord.app_commands.command(name="exemplo")
    # async def exemplo_comando(self, interaction: discord.Interaction):
    #     await interaction.response.send_message("Comando de exemplo funcionando!")

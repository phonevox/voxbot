# src/bot/modules/jointocreate.py
import logging

import discord
from discord import Interaction, VoiceChannel, app_commands
from discord.ext import commands

from src.bot.core.GuildDataManager import GuildDataManager
from src.bot.utils.database import DatabaseClient


class ModuleJoinToCreate(commands.Cog):
    module_name = "jointocreate"

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.logger = logging.getLogger(f"bot.module.{self.module_name}")
        self.temporary_channels = set()

        # MongoDB client e collection
        db_client = DatabaseClient()
        collection = db_client.get_collection(f"module-{self.module_name}")

        # Instância do GuildDataManager (baseado na collection e nome do módulo)
        self.gdm = GuildDataManager(collection, module_name=self.module_name)

        # Agrupamento de comandos
        self.jointocreate_group = self.JoinToCreateGroup(self)
        self.bot.tree.add_command(self.jointocreate_group)

    def __getLogger(self, name):
        return logging.getLogger(f"bot.module.{self.module_name}.{name}")

    @commands.Cog.listener()
    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        logger = self.__getLogger("on_voice_state_update")
        guild_id = member.guild.id
        data = self.gdm.for_guild(guild_id)
        monitored_channels = data.get("channels") or []

        # Verifica se o bot tem permissão para criar/deletar canais
        bot_member = member.guild.me
        if not bot_member.guild_permissions.manage_channels:
            logger.error("Permissão insuficiente para criar ou deletar canais")
            return

        # Quando o membro entra em um canal monitorado
        if after.channel and after.channel.id in monitored_channels:
            category = after.channel.category  # mantém a categoria do canal original
            member_display_name = member.display_name

            # Easter egg para nome do canal temporário
            if "rafael" in member_display_name.lower():
                channel_name = f"☂ Sala de {member_display_name}"
            elif "adrian" in member_display_name.lower():
                channel_name = f"💫 Sala de {member_display_name}"
            elif "andr" in member_display_name.lower():
                channel_name = f"🎀 𝓈𝒶𝓁𝒶 𝒹𝓊 𝒶𝓃𝒹𝓇𝑒𝑒𝒽 🎀"  # noqa
            elif "leonardo" in member_display_name.lower():
                channel_name = f"🎸 Sala de {member_display_name}"
            elif "abner" in member_display_name.lower():
                channel_name = f"👑 Sala de {member_display_name}"
            else:
                channel_name = f"Sala de {member_display_name}"

            # Cria canal temporário
            new_channel = await member.guild.create_voice_channel(
                name=channel_name, category=category
            )
            self.temporary_channels.add(new_channel.id)
            logger.info(
                f"Criado novo canal: {new_channel.name} para {member_display_name}"
            )

            # Move o membro pro canal temporário
            await member.move_to(new_channel)

        # Quando o membro sai de um canal (antes da mudança)
        if before.channel:
            # Se o canal ficou vazio e for temporário, exclui
            if (
                len(before.channel.members) == 0
                and before.channel.id in self.temporary_channels  # noqa
            ):
                await before.channel.delete()
                self.temporary_channels.remove(before.channel.id)
                logger.info(f"Canal temporário deletado: {before.channel.name}")

    class JoinToCreateGroup(app_commands.Group):
        def __init__(self, cog: "ModuleJoinToCreate"):
            super().__init__(
                name="jointocreate", description="Gerencia canais Join-To-Create"
            )
            self.cog = cog

        async def interaction_check(self, interaction: Interaction) -> bool:
            if not interaction.user.guild_permissions.administrator:
                await interaction.response.send_message(
                    "Você precisa ser administrador para usar este comando.",
                    ephemeral=True,
                )
                return False
            return True

        @app_commands.command(
            name="create", description="Adiciona um canal Join-To-Create"
        )
        @app_commands.describe(channel="Canal de voz que será usado")
        async def create(self, interaction: Interaction, channel: VoiceChannel):
            data = self.cog.gdm.for_guild(
                interaction.guild_id
            )  # pega o dicionário cacheado
            channels = data.get("channels") or []

            if channel.id in channels:
                await interaction.response.send_message(
                    "❌ Este canal já está cadastrado.", ephemeral=True
                )
                return

            channels.append(channel.id)

            self.cog.gdm.set(interaction.guild_id, "channels", channels)
            data["channels"] = channels

            await interaction.response.send_message(
                f"✅ Canal {channel.mention} cadastrado como Join-To-Create!",
                ephemeral=True,
            )

        @app_commands.command(
            name="delete", description="Remove um canal Join-To-Create"
        )
        @app_commands.describe(channel="Canal de voz a ser removido")
        async def delete(self, interaction: Interaction, channel: VoiceChannel):
            data = self.cog.gdm.for_guild(interaction.guild_id)
            channels = data.get("channels") or []

            if channel.id not in channels:
                await interaction.response.send_message(
                    "❌ Este canal não está cadastrado.", ephemeral=True
                )
                return

            channels.remove(channel.id)

            self.cog.gdm.set(interaction.guild_id, "channels", channels)
            data["channels"] = channels

            await interaction.response.send_message(
                f"✅ Canal {channel.mention} removido com sucesso!", ephemeral=True
            )

        @app_commands.command(
            name="list", description="Lista os canais Join-To-Create configurados"
        )
        async def list(self, interaction: Interaction):
            data = self.cog.gdm.for_guild(interaction.guild_id)
            channel_ids = data.get("channels") or []

            if not channel_ids:
                await interaction.response.send_message(
                    "😬 Nenhum canal Join-To-Create configurado.", ephemeral=True
                )
                return

            lines = []
            for cid in channel_ids:
                ch = interaction.guild.get_channel(cid)
                if ch:
                    lines.append(f"- {ch.mention} (`{cid}`)")
                else:
                    lines.append(f"- Canal não encontrado (`{cid}`)")

            await interaction.response.send_message(
                "✅ Canais Join-To-Create configurados:\n" + "\n".join(lines),
                ephemeral=True,
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModuleJoinToCreate(bot))

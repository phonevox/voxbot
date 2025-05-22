# src/bot/modules/jointocreate.py
import logging

import discord
from discord import Interaction, Member, VoiceChannel, app_commands
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
        monitored_channels = data.get("ID_JTC_CHANNELS") or []

        # Verifica se o bot tem permissão para criar/deletar canais
        bot_member = member.guild.me
        if not bot_member.guild_permissions.manage_channels:
            logger.error("Permissão insuficiente para criar ou deletar canais")
            return

        # Quando o membro entra em um canal monitorado
        if after.channel and after.channel.id in monitored_channels:
            category = after.channel.category  # mantém a categoria do canal original
            member_id = str(member.id)
            member_display_name = member.display_name

            # Busca alias personalizado
            data = self.gdm.for_guild(member.guild.id)
            aliases = data.get("TEMP_CHANNEL_ALIASES") or {}
            alias = aliases.get(f"{member_id}")  # key is a string

            # Define o nome do canal
            channel_name = alias or f"Sala de {member_display_name}"

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
            channels = data.get("ID_JTC_CHANNELS") or []

            if channel.id in channels:
                await interaction.response.send_message(
                    "❌ Este canal já está cadastrado.", ephemeral=True
                )
                return

            channels.append(channel.id)

            self.cog.gdm.set(interaction.guild_id, "ID_JTC_CHANNELS", channels)
            data["ID_JTC_CHANNELS"] = channels

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
            channels = data.get("ID_JTC_CHANNELS") or []

            if channel.id not in channels:
                await interaction.response.send_message(
                    "❌ Este canal não está cadastrado.", ephemeral=True
                )
                return

            channels.remove(channel.id)

            self.cog.gdm.set(interaction.guild_id, "ID_JTC_CHANNELS", channels)
            data["ID_JTC_CHANNELS"] = channels

            await interaction.response.send_message(
                f"✅ Canal {channel.mention} removido com sucesso!", ephemeral=True
            )

        @app_commands.command(
            name="list", description="Lista os canais Join-To-Create configurados"
        )
        async def list(self, interaction: Interaction):
            data = self.cog.gdm.for_guild(interaction.guild_id)
            channel_ids = data.get("ID_JTC_CHANNELS") or []

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

        @app_commands.command(
            name="set-alias",
            description="Define um alias para o canal temporário para o usuário especificado",
        )
        async def set_alias(self, interaction: Interaction, user: Member, alias: str):
            pass
            data = self.cog.gdm.for_guild(interaction.guild_id)
            aliases = data.get("TEMP_CHANNEL_ALIASES") or {}

            # first, check if alias has more than 100 characters
            if len(alias) > 100:
                await interaction.response.send_message(
                    "❌ O alias não pode ter mais de 100 caracteres.", ephemeral=True
                )
                return

            # set new alias in guild configuration
            aliases[f"{user.id}"] = alias
            self.cog.gdm.set(interaction.guild_id, "TEMP_CHANNEL_ALIASES", aliases)

            await interaction.response.send_message(
                "✅ Alias definido com sucesso!", ephemeral=True
            )

        @app_commands.command(
            name="remove-alias",
            description="Remove o alias de canal temporário para o usuário especificado",
        )
        async def remove_alias(self, interaction: Interaction, user: Member):
            data = self.cog.gdm.for_guild(interaction.guild_id)
            aliases = data.get("TEMP_CHANNEL_ALIASES") or {}

            if f"{user.id}" not in aliases:
                await interaction.response.send_message(
                    "❌ Este usuário não possui um alias definido.", ephemeral=True
                )
                return

            # remove alias from guild configuration
            del aliases[f"{user.id}"]
            self.cog.gdm.set(interaction.guild_id, "TEMP_CHANNEL_ALIASES", aliases)

            await interaction.response.send_message(
                "✅ Alias removido com sucesso!", ephemeral=True
            )

        @app_commands.command(
            name="list-aliases",
            description="Lista os aliases de canal temporário configurados",
        )
        async def list_aliases(self, interaction: Interaction):
            data = self.cog.gdm.for_guild(interaction.guild_id)
            aliases = data.get("TEMP_CHANNEL_ALIASES") or {}

            if not aliases:
                await interaction.response.send_message(
                    "😬 Nenhum alias de canal temporário configurado.", ephemeral=True
                )
                return

            lines = []
            for user_id, alias in aliases.items():
                user = interaction.guild.get_member(int(user_id))
                if user:
                    lines.append(f"- {user.mention} (`{alias}`)")
                else:
                    lines.append(
                        f"- Usuário desconhecido (`ID: {user_id}`) → `{alias}`"
                    )

            await interaction.response.send_message(
                "📋 Aliases de canal temporário configurados:\n" + "\n".join(lines),
                ephemeral=True,
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModuleJoinToCreate(bot))

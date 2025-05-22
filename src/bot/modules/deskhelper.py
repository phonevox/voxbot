# src/bot/modules/jointocreate.py
import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta

import aiohttp
import discord
from discord import Interaction, Member, app_commands
from discord.ext import commands

from src.bot.core.GuildDataManager import GuildDataManager
from src.bot.utils.database import DatabaseClient


class ModuleDeskHelper(commands.Cog):
    module_name = "deskhelper"

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.logger = logging.getLogger(f"bot.module.{self.module_name}")

        # chatbot stuff
        self.sessions = {}
        self.SESSION_TIMEOUT = timedelta(minutes=15)
        self.QUERY_CHATBOT_URL = os.getenv("MOD_DESKHELPER_QUERYCHATBOT_URL")
        self.QUERY_CHATBOT_TOKEN = os.getenv("MOD_DESKHELPER_QUERYCHATBOT_TOKEN")

        if not self.QUERY_CHATBOT_URL or not self.QUERY_CHATBOT_TOKEN:

            self.logger.error(
                "Variáveis de ambiente não configuradas!\nPor favor, configure as variáveis QUERY_CHATBOT_URL e QUERY_CHATBOT_TOKEN."
            )
            raise ValueError("Variáveis de ambiente não configuradas!")

        # MongoDB client e collection
        db_client = DatabaseClient()
        collection = db_client.get_collection(f"module-{self.module_name}")

        # Instância do GuildDataManager (baseado na collection e nome do módulo)
        self.gdm = GuildDataManager(collection, module_name=self.module_name)

        # Adiciona o grupo de comandos
        self.deskhelper_group = self.DeskHelperGroup(self)
        self.bot.tree.add_command(self.deskhelper_group)

    def __getLogger(self, name):
        return logging.getLogger(f"bot.module.{self.module_name}.{name}")

    # Listeners

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or not message.guild:
            return

        # Garante que o bot foi mencionado diretamente (não @everyone ou cargos)
        if (
            self.bot.user.mentioned_in(message)
            and not message.mention_everyone
            and not message.role_mentions
        ):
            # Confere se o ping está no início da mensagem
            raw_content = message.content.strip()

            # IDs de menção ao bot podem variar com ou sem "!"
            bot_mentions = [f"<@{self.bot.user.id}>", f"<@!{self.bot.user.id}>"]

            if any(raw_content.startswith(mention) for mention in bot_mentions):
                # Remove a menção do conteúdo
                for mention in bot_mentions:
                    if raw_content.startswith(mention):
                        user_input = raw_content[len(mention) :].strip()
                        break

                # Ignora se só tiver o ping, sem conteúdo após
                if not user_input:
                    return

                user_id = message.author.id
                session_id = self.get_or_create_session(user_id)

                # Enviar input e session_id para seu handler externo
                response = await self.query_chatbot(session_id, user_input)

                await message.channel.send(f"{response}", reference=message)

    # Functions

    def get_or_create_session(self, user_id):
        now = datetime.utcnow()

        session = self.sessions.get(user_id)

        # Se já existe e ainda é válida, atualiza `last_active`
        if session and now - session["last_active"] < self.SESSION_TIMEOUT:
            session["last_active"] = now
            return session["session_id"]

        # Caso contrário, cria nova sessão
        new_session_id = str(uuid.uuid4())
        self.sessions[user_id] = {
            "session_id": new_session_id,
            "last_active": now,
        }
        return new_session_id

    async def query_chatbot(self, session_id: str, user_input: str) -> str:
        logger = self.__getLogger("query_chatbot")
        url = self.QUERY_CHATBOT_URL
        payload = {
            "SessionId": session_id,
            "chatInput": user_input,
        }

        headers = {"Authorization": f"Bearer {self.QUERY_CHATBOT_TOKEN}"}

        max_retries = 3
        backoff_base = 1  # segundos

        for attempt in range(1, max_retries + 1):
            try:
                logger.debug(f"Tentativa {attempt} - Enviando payload: {payload}")

                async with aiohttp.ClientSession() as session:
                    async with session.post(url, json=payload, headers=headers) as resp:
                        logger.debug(f"Resposta HTTP: {resp.status}")

                        if resp.status != 200:
                            logger.warning(
                                f"Status inesperado ({resp.status}) na tentativa {attempt}"
                            )
                            raise aiohttp.ClientError(f"Status code {resp.status}")

                        data = await resp.json()
                        logger.debug(f"Resposta JSON recebida: {data}")

                        if (
                            isinstance(data, dict)
                            and "output" in data
                            and "message" in data["output"]
                        ):
                            return data["output"]["message"]
                        else:
                            logger.error("Formato inválido de resposta do chatbot.")
                            raise ValueError("Formato inválido de resposta do chatbot.")

            except Exception as e:
                logger.error(f"Erro na tentativa {attempt}: {e}")

                if attempt < max_retries:
                    wait_time = backoff_base * 2 ** (attempt - 1)
                    logger.info(
                        f"Aguardando {wait_time}s antes da próxima tentativa..."
                    )
                    await asyncio.sleep(wait_time)
                else:
                    logger.critical(
                        "Todas as tentativas de contato com o chatbot falharam."
                    )
                    return "Erro no chatbot!"

    class DeskHelperGroup(app_commands.Group):
        def __init__(self, cog: "ModuleDeskHelper"):
            super().__init__(
                name="deskhelper", description="Gerencia sessões do DeskHelper"
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
            name="clear-sessions", description="Limpa todas as sessões"
        )
        async def clear_sessions(self, interaction: Interaction):
            self.cog.sessions.clear()
            await interaction.response.send_message(
                "✅ Todas as sessões foram limpas.", ephemeral=True
            )

        @app_commands.command(
            name="session-clear", description="Limpa a sessão de um usuário"
        )
        @app_commands.describe(user="Usuário cuja sessão será removida")
        async def session_clear(self, interaction: Interaction, user: Member):
            if user.id in self.cog.sessions:
                del self.cog.sessions[user.id]
                await interaction.response.send_message(
                    f"✅ Sessão de {user.mention} foi removida.", ephemeral=True
                )
            else:
                await interaction.response.send_message(
                    f"ℹ️ {user.mention} não possui uma sessão ativa.", ephemeral=True
                )

        @app_commands.command(
            name="session-set", description="Define o ID da sessão para um usuário"
        )
        @app_commands.describe(user="Usuário", session_id="Novo ID da sessão")
        async def session_set(
            self, interaction: Interaction, user: Member, session_id: str
        ):
            now = datetime.utcnow()
            self.cog.sessions[user.id] = {
                "session_id": session_id,
                "last_active": now,
            }
            await interaction.response.send_message(
                f"✅ Sessão de {user.mention} definida como `{session_id}`.",
                ephemeral=True,
            )

        @app_commands.command(
            name="session-get", description="Consulta o ID da sessão de um usuário"
        )
        @app_commands.describe(user="Usuário")
        async def session_get(self, interaction: Interaction, user: Member):
            session = self.cog.sessions.get(user.id)
            if session:
                sid = session["session_id"]
                last = session["last_active"].isoformat()
                await interaction.response.send_message(
                    f"ℹ️ Sessão de {user.mention}: `{sid}` (último uso: {last})",
                    ephemeral=True,
                )
            else:
                await interaction.response.send_message(
                    f"ℹ️ {user.mention} não possui uma sessão ativa.", ephemeral=True
                )

        @app_commands.command(
            name="session-list", description="Lista todas as sessões ativas"
        )
        async def session_list(self, interaction: Interaction):
            if not self.cog.sessions:
                await interaction.response.send_message(
                    "ℹ️ Nenhuma sessão ativa.", ephemeral=True
                )
                return

            lines = []
            for uid, sess in self.cog.sessions.items():
                member = interaction.guild.get_member(uid)
                mention = member.mention if member else f"`{uid}`"
                lines.append(f"- {mention}: `{sess['session_id']}`")

            await interaction.response.send_message(
                "📋 Sessões ativas:\n" + "\n".join(lines), ephemeral=True
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModuleDeskHelper(bot))

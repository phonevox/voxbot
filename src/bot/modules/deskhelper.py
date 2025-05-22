# src/bot/modules/jointocreate.py
import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta

import aiohttp
import discord
from discord import Interaction, app_commands
from discord.ext import commands

from src.bot.core.GuildDataManager import GuildDataManager
from src.bot.utils.database import DatabaseClient


class ModuleDeskHelper(commands.Cog):
    module_name = "deskhelper"

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.logger = logging.getLogger(f"bot.module.{self.module_name}")

        # chatbot stuff
        self.user_cooldowns = {}
        self.COOLDOWN_SECONDS = 3

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

    # <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
    # TODO: Salvar as sessões criadas no db
    # TODO: Carregar as sessões do db
    # TODO: Cadastrar um tempo limite pra cada thread (15min inativo por exemplo, então o cache deve um campo de last_active ou algo assim)
    # >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

    @commands.Cog.listener()
    async def on_ready(self):
        logger = self.__getLogger("load_sessions")
        logger.info("Carregando sessões...")
        logger.trace(f"BOT GUILDS: {self.bot.guilds}")
        for guild in self.bot.guilds:
            logger.trace(
                f"Carregando sessões para o servidor {guild.name} ({guild.id})..."
            )
            data = self.gdm.for_guild(guild.id)
            saved_sessions = data.get("THREAD_SESSIONS") or {}
            logger.trace(f"Sessões salvas: {saved_sessions}")
            updated_sessions = {}

            for thread_id_str, session_data in saved_sessions.items():
                try:
                    thread_id = int(thread_id_str)
                    session_id = session_data["session_id"]
                    last_active = datetime.fromisoformat(session_data["last_active"])

                    if datetime.utcnow() - last_active >= self.SESSION_TIMEOUT:
                        # Sessão expirada → tenta deletar o thread
                        try:
                            thread = await self.bot.fetch_channel(thread_id)
                            if isinstance(thread, discord.Thread):
                                await thread.delete(reason="Sessão de chatbot expirada")
                                logger.info(
                                    f"Thread expirada deletada: {thread.name} ({thread_id})"
                                )
                        except discord.NotFound:
                            logger.warning(
                                f"Thread não encontrada ao tentar deletar: {thread_id}"
                            )
                        except Exception as e:
                            logger.error(f"Erro ao deletar thread {thread_id}: {e}")
                        continue  # não mantém a sessão

                    # Sessão ainda válida → mantém no cache
                    self.sessions[thread_id] = {
                        "session_id": session_id,
                        "last_active": last_active,
                    }
                    updated_sessions[thread_id_str] = {
                        "session_id": session_id,
                        "last_active": last_active.isoformat(),
                    }

                except Exception as e:
                    logger.warning(
                        f"Erro ao carregar sessão de thread {thread_id_str}: {e}"
                    )

            # Salva apenas sessões ainda válidas
            self.gdm.set(guild.id, "THREAD_SESSIONS", updated_sessions)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or not message.guild:
            return

        now = datetime.utcnow()
        user_id = message.author.id

        # Debounce global por usuário
        last_used = self.user_cooldowns.get(user_id)
        if last_used and (now - last_used).total_seconds() < self.COOLDOWN_SECONDS:
            return  # Está em cooldown

        self.user_cooldowns[user_id] = now  # Atualiza o timestamp

        if isinstance(message.channel, discord.Thread):
            thread_id = message.channel.id
            session_id = self.get_or_create_session(thread_id)

            user_input = message.content.strip()
            if not user_input:
                return
            response = await self.query_chatbot(
                session_id,
                user_input,
                with_execution_link=self.is_debug_mode(message.guild.id),
            )
            await message.channel.send(response, reference=message)
            return

        if (
            self.bot.user.mentioned_in(message)
            and not message.mention_everyone
            and not message.role_mentions
        ):
            raw_content = message.content.strip()
            bot_mentions = [f"<@{self.bot.user.id}>", f"<@!{self.bot.user.id}>"]

            if any(raw_content.startswith(m) for m in bot_mentions):
                for mention in bot_mentions:
                    if raw_content.startswith(mention):
                        user_input = raw_content[len(mention) :].strip()
                        break

                if not user_input:
                    return

                thread = await message.create_thread(
                    name=f"Atendimento - {message.author.display_name}",
                    auto_archive_duration=60,
                )

                session_id = self.get_or_create_session(thread.id)

                response = await self.query_chatbot(
                    session_id,
                    user_input,
                    with_execution_link=self.is_debug_mode(message.guild.id),
                )
                await thread.send(response)

    # Functions

    def is_debug_mode(self, guild_id: int) -> bool:
        data = self.gdm.for_guild(guild_id)
        return data.get("DEBUG_MODE", False)

    def get_or_create_session(self, thread_id: int) -> str:
        now = datetime.utcnow()
        session = self.sessions.get(thread_id)

        if session and now - session["last_active"] < self.SESSION_TIMEOUT:
            session["last_active"] = now
        else:
            session = {
                "session_id": str(uuid.uuid4()),
                "last_active": now,
            }
            self.sessions[thread_id] = session

        # Salva no GDM
        guild_id = self.get_guild_id_from_thread_id(thread_id)

        if guild_id:
            data = self.gdm.for_guild(guild_id)
            data_sessions = data.get("THREAD_SESSIONS") or {}
            data_sessions[str(thread_id)] = {
                "session_id": session["session_id"],
                "last_active": session["last_active"].isoformat(),
            }
            self.gdm.set(guild_id, "THREAD_SESSIONS", data_sessions)

        return session["session_id"]

    def get_guild_id_from_thread_id(self, thread_id: int) -> int | None:
        channel = self.bot.get_channel(thread_id)  # tenta do cache local
        if channel and isinstance(channel, discord.Thread):
            return channel.guild.id
        return None

    async def query_chatbot(
        self, session_id: str, user_input: str, with_execution_link: bool = False
    ) -> str:
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
                            message = data["output"]["message"]
                            execution_link = data["output"]["executionLink"]

                            if with_execution_link:
                                message = f"{message}\n\n-# [[Ver execução]({execution_link})]"

                            return message
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
            guild_id = interaction.guild_id
            if guild_id:
                self.cog.gdm.set(guild_id, "THREAD_SESSIONS", {})
            await interaction.response.send_message(
                "✅ Todas as sessões foram limpas.", ephemeral=True
            )

        @app_commands.command(
            name="session-clear", description="Limpa a sessão de um tópico"
        )
        @app_commands.describe(thread="Tópico (thread) cuja sessão será removida")
        async def session_clear(self, interaction: Interaction, thread: discord.Thread):
            removed = False

            if thread.id in self.cog.sessions:
                del self.cog.sessions[thread.id]
                removed = True

            guild_id = interaction.guild_id
            if guild_id:
                data = self.cog.gdm.for_guild(guild_id)
                sessions = data.get("THREAD_SESSIONS") or {}
                if str(thread.id) in sessions:
                    del sessions[str(thread.id)]
                    self.cog.gdm.set(guild_id, "THREAD_SESSIONS", sessions)
                    removed = True

            if removed:
                await interaction.response.send_message(
                    f"✅ Sessão do tópico `{thread.name}` removida.", ephemeral=True
                )
            else:
                await interaction.response.send_message(
                    f"ℹ️ O tópico `{thread.name}` não possui sessão ativa.",
                    ephemeral=True,
                )

        @app_commands.command(
            name="session-set", description="Define o ID da sessão para um tópico"
        )
        @app_commands.describe(thread="Tópico", session_id="Novo ID da sessão")
        async def session_set(
            self, interaction: Interaction, thread: discord.Thread, session_id: str
        ):
            now = datetime.utcnow()
            self.cog.sessions[thread.id] = {
                "session_id": session_id,
                "last_active": now,
            }
            await interaction.response.send_message(
                f"✅ Sessão do tópico `{thread.name}` definida como `{session_id}`.",
                ephemeral=True,
            )

        @app_commands.command(
            name="session-get", description="Consulta o ID da sessão de um tópico"
        )
        @app_commands.describe(thread="Tópico")
        async def session_get(self, interaction: Interaction, thread: discord.Thread):
            session = self.cog.sessions.get(thread.id)
            if session:
                sid = session["session_id"]
                last = session["last_active"].isoformat()
                await interaction.response.send_message(
                    f"ℹ️ Sessão de `{thread.name}`: `{sid}` (último uso: {last})",
                    ephemeral=True,
                )
            else:
                await interaction.response.send_message(
                    f"ℹ️ O tópico `{thread.name}` não possui uma sessão ativa.",
                    ephemeral=True,
                )

        @app_commands.command(
            name="session-copy",
            description="Cria um novo tópico e copia a sessão de outro tópico",
        )
        @app_commands.describe(thread="Tópico cuja sessão será copiada")
        async def session_copy(self, interaction: Interaction, thread: discord.Thread):
            source_session = self.cog.sessions.get(thread.id)
            if not source_session:
                await interaction.response.send_message(
                    f"❌ O tópico `{thread.name}` não possui uma sessão ativa.",
                    ephemeral=True,
                )
                return

            # Cria novo thread a partir da mensagem mais recente do canal (idealmente)
            parent_channel = interaction.channel
            if not isinstance(
                parent_channel, (discord.TextChannel, discord.ForumChannel)
            ):
                await interaction.response.send_message(
                    "❌ Este comando só pode ser usado em canais de texto ou fórum.",
                    ephemeral=True,
                )
                return

            # Nome para o novo tópico
            new_thread_name = f"{thread.name}-cópia"

            # Cria o novo thread
            new_thread = await parent_channel.create_thread(
                name=new_thread_name,
                type=discord.ChannelType.public_thread,
                auto_archive_duration=60,  # 1h
                reason="Cópia de sessão com /deskhelper session-copy",
            )

            # Copia a sessão
            self.cog.sessions[new_thread.id] = {
                "session_id": source_session["session_id"],
                "last_active": datetime.utcnow(),
            }

            await interaction.response.send_message(
                f"✅ Sessão copiada de `{thread.name}` para o novo tópico: {new_thread.mention}",
                ephemeral=True,
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
            for thread_id, sess in self.cog.sessions.items():
                thread = interaction.guild.get_thread(thread_id)
                timestamp = int(sess["last_active"].timestamp())
                timestamp -= 3 * 60 * 60  # utc-3
                if thread:
                    thread_mention = thread.mention
                    # name = thread.name
                else:
                    thread_mention = f"[Thread {thread_id} não encontrada]"
                    # name = "desconhecido"

                lines.append(
                    f"- {thread_mention} - `{sess['session_id']}` (<t:{timestamp}:R>)"
                )

            await interaction.response.send_message(
                "📋 Sessões ativas:\n" + "\n".join(lines), ephemeral=True
            )

        @app_commands.command(
            name="debug", description="Ativa o modo de depuração baseado em GDM"
        )
        async def debug(self, interaction: Interaction):
            guild_id = interaction.guild.id
            current = self.cog.gdm.get(guild_id, "DEBUG_MODE") or False
            new_state = not current

            # Salva apenas a chave "DEBUG_MODE"
            self.cog.gdm.set(guild_id, "DEBUG_MODE", new_state)

            await interaction.response.send_message(
                f"🛠️ Modo de depuração {'ativado' if new_state else 'desativado'}.",
                ephemeral=True,
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModuleDeskHelper(bot))

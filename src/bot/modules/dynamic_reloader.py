import logging
import os
from typing import Optional

from discord import Interaction, app_commands
from discord.ext import commands

logger = logging.getLogger("bot.module.dynamic_module_reloader")

AUTHORIZED_USERS_ID = [
    188851299255713792,
    968851062679302164,
    1087873539635433522,
]  # Only your user ID can use the commands
BASE_MODULE_PATH = "src.bot.modules."


class ModuleDynamicModuleReloader(commands.Cog):
    module_name = "dynamic_module_reloader"

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.dynamic_module_group = self.DynamicModuleGroup(self)
        self.bot.tree.add_command(self.dynamic_module_group)

    class DynamicModuleGroup(app_commands.Group):
        def __init__(self, cog: "ModuleDynamicModuleReloader"):
            super().__init__(
                name="module", description="Manage modules (cogs) dynamically"
            )
            self.cog = cog

        async def interaction_check(self, interaction: Interaction) -> bool:
            if interaction.user.id in AUTHORIZED_USERS_ID:
                await interaction.response.send_message(
                    "❌ Você não tem permissão para usar esse comando.", ephemeral=True
                )
                return False
            return True

        @app_commands.command(
            name="load", description="Carregar uma cog pelo seu nome (último segmento)"
        )
        @app_commands.describe(module_name="Nome do módulo (ex., jointocreate)")
        async def load(self, interaction: Interaction, module_name: str):
            full_module_name = BASE_MODULE_PATH + module_name
            try:
                logger.debug(f"Loading extension {full_module_name}")
                await self.cog.bot.load_extension(full_module_name)
                await interaction.response.send_message(
                    f"✅ Módulo `{full_module_name}` carregado com sucesso!",
                    ephemeral=True,
                )
                logger.info(f"Loaded module: {full_module_name}")
            except commands.ExtensionAlreadyLoaded:
                await interaction.response.send_message(
                    f"⚠️ Módulo `{full_module_name}` já está carregado!", ephemeral=True
                )
                logger.debug(
                    f"Tentativa de carregar um módulo já carregado: {full_module_name}"
                )
            except Exception as e:
                await interaction.response.send_message(
                    f"❌ Falha ao carregar módulo`{full_module_name}`:\n```{e}```",
                    ephemeral=True,
                )
                logger.exception(f"Falha ao carregar módulo {full_module_name}")

        @app_commands.command(
            name="unload",
            description="Descarregar uma cog pelo seu nome (último segmento)",
        )
        @app_commands.describe(module_name="Nome do módulo (ex., jointocreate)")
        async def unload(self, interaction: Interaction, module_name: str):
            full_module_name = BASE_MODULE_PATH + module_name
            try:
                # Remove any cog that was registered by this module
                unloaded_cogs = []
                for cog_name, cog in list(self.cog.bot.cogs.items()):
                    if cog.__module__ == full_module_name:
                        await self.cog.bot.remove_cog(cog_name)
                        unloaded_cogs.append(cog_name)
                        logger.debug(
                            f"Removido a cog '{cog_name}' do módulo '{full_module_name}'"
                        )

                logger.debug(f"Descarregando extensão: {full_module_name}")
                await self.cog.bot.unload_extension(full_module_name)
                await interaction.response.send_message(
                    f"✅ Módulo `{full_module_name}` descarregado com sucesso!\n"
                    + (
                        f"Cogs removidas: {', '.join(unloaded_cogs)}"
                        if unloaded_cogs
                        else "Nenhuma cog registrada."
                    ),
                    ephemeral=True,
                )
                logger.info(f"Módulo descarregado: {full_module_name}")
            except commands.ExtensionNotLoaded:
                await interaction.response.send_message(
                    f"⚠️ Módulo `{full_module_name}` não está carregado.",
                    ephemeral=True,
                )
                logger.debug(
                    f"Tentativa de descarregar módulo já descarregado: {full_module_name}"
                )
            except Exception as e:
                await interaction.response.send_message(
                    f"❌ Falha ao descarregar módulo `{full_module_name}`:\n```{e}```",
                    ephemeral=True,
                )
                logger.exception(f"Falha ao descarregar módulo {full_module_name}")

        @app_commands.command(
            name="reload", description="Recarregar uma cog pelo nome (último segmento)"
        )
        @app_commands.describe(
            module_name="Nome do módulo (ex., jointocreate)",
            sync="Se deve sincronizar a command tree depois do reload (default: False)",
        )
        async def reload(
            self,
            interaction: Interaction,
            module_name: str,
            sync: Optional[bool] = False,
        ):
            await interaction.response.defer(
                ephemeral=True
            )  # Defer para evitar timeout e feedback imediato

            full_module_name = BASE_MODULE_PATH + module_name
            try:
                logger.debug(f"Recarregando extensão: {full_module_name}")
                await self.cog.bot.reload_extension(full_module_name)

                if sync:
                    logger.debug("Sincronizando árvore de comandos... (command tree)")
                    await self.cog.bot.tree.sync()
                    logger.debug("Sincronizado.")

                await interaction.followup.send(
                    f"✅ Módulo `{full_module_name}` recarregado com sucesso!{' (Sincronizado)' if sync else ''}",
                    ephemeral=True,
                )
                logger.info(f"Recarregando módulo: {full_module_name}")
            except commands.ExtensionNotLoaded:
                logger.debug(
                    f"Módulo {full_module_name} não estava carregado, será carregado agora."
                )
                try:
                    logger.debug(f"Carregando extensão {full_module_name}...")
                    await self.cog.bot.load_extension(full_module_name)

                    if sync:
                        logger.debug(
                            "Sincronizando árvore de comandos... (command tree)"
                        )
                        await self.cog.bot.tree.sync()
                        logger.debug("Sincronizado.")

                    await interaction.followup.send(
                        f"✅ Módulo `{full_module_name}` carregado com sucesso!{' (Sincronizado)' if sync else ''}",
                        ephemeral=True,
                    )
                    logger.info(
                        f"Módulo carregado (não estava carregado): {full_module_name}"
                    )
                except Exception as e:
                    await interaction.followup.send(
                        f"❌ Falha ao carregar módulo `{full_module_name}`:\n```{e}```",
                        ephemeral=True,
                    )
                    logger.exception(f"Falha ao carregar módulo {full_module_name}")
            except Exception as e:
                await interaction.followup.send(
                    f"❌ Falha ao recarregar módulo `{full_module_name}`:\n```{e}```",
                    ephemeral=True,
                )
                logger.exception(f"Falha ao recarregar módulo {full_module_name}")

        @app_commands.command(name="reload-all", description="Recarrega todos módulos")
        async def reload_all(self, interaction: Interaction):
            cog_dir = BASE_MODULE_PATH.replace(".", "/")  # ex: src/bot/modules
            successful = []
            failed = []

            # List all .py files that are not __init__.py
            for filename in os.listdir(cog_dir):
                if filename.endswith(".py") and not filename.startswith("__"):
                    module_name = filename[:-3]
                    full_module_name = BASE_MODULE_PATH + module_name
                    try:
                        await self.cog.bot.reload_extension(full_module_name)
                        successful.append(module_name)
                        logger.info(f"Módulos recarregados: {full_module_name}")
                    except commands.ExtensionNotLoaded:
                        try:
                            await self.cog.bot.load_extension(full_module_name)
                            successful.append(module_name)
                            logger.info(
                                f"Módulo carregado (não estava carregado): {full_module_name}"
                            )
                        except Exception as e:
                            failed.append(module_name)
                            logger.exception(
                                f"Falha ao carregar módulo {full_module_name}"
                            )
                            logger.exception(e)
                    except Exception as e:
                        failed.append(module_name)
                        logger.exception(
                            f"Falha ao recarregar módulo {full_module_name}"
                        )
                        logger.exception(e)

            logger.info("Sincronizando árvore de comandos... (command tree)")
            await self.cog.bot.tree.sync()
            logger.info("Sincronizado.")

            # Format the response message
            msg_lines = []
            for m in successful:
                msg_lines.append(f"- :white_check_mark: {m}")
            for m in failed:
                msg_lines.append(f"- :x: {m}")

            if not msg_lines:
                msg_lines.append("Nnehum módulo encontrado para recarregar.")

            await interaction.response.send_message(
                "\n".join(msg_lines), ephemeral=True
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModuleDynamicModuleReloader(bot))

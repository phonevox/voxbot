import logging
import os

import aiohttp
from discord import Interaction, app_commands
from discord.ext import commands

logger = logging.getLogger("bot.module.autobloqueador")

AUTHORIZED_USERS_ID = [
    188851299255713792,
    968851062679302164,
    1087873539635433522,
]
AUTHORIZED_ROLES_ID = [
    1087873539635433522,
]


class AbmagnusModule(commands.Cog):
    module_name = "autobloqueador"

    def __init__(self, bot: commands.Bot):
        self.bot = bot

        self.api_url = os.getenv("MOD_AUTOBLOQUEADOR_URL")
        self.api_token = os.getenv("MOD_AUTOBLOQUEADOR_TOKEN")

        if self.api_url and self.api_token:
            self.abmagnus_group = self.AbmagnusModuleGroup(self)
            self.bot.tree.add_command(self.abmagnus_group)
            logger.info("Comando /autobloqueador carregado.")
        else:
            logger.warning(
                "AutoBloqueador não carregado: variáveis de ambiente não definidas."
            )
            if self.bot.tree.get_command("autobloqueador"):
                self.bot.tree.remove_command("autobloqueador")
                logger.info("Comando /autobloqueador removido da árvore de comandos.")

    class AbmagnusModuleGroup(app_commands.Group):
        def __init__(self, cog: "AbmagnusModule"):
            super().__init__(
                name="autobloqueador", description="Controle do Auto-Bloqueador Magnus"
            )
            self.cog = cog

        async def interaction_check(self, interaction: Interaction) -> bool:
            return interaction.user.id in AUTHORIZED_USERS_ID

        @app_commands.command(
            name="atualizar", description="Forçar atualização do Auto-Bloqueador."
        )
        async def atualizar(self, interaction: Interaction):
            await interaction.response.defer(thinking=True)

            logger.debug(f"URL: {self.cog.api_url}")
            logger.debug(f"Token: {self.cog.api_token}")

            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        self.cog.api_url,
                        headers={
                            "Authorization": f"Bearer {self.cog.api_token}",
                            "Content-Type": "application/json",
                        },
                    ) as response:
                        text = await response.text()
                        if response.status == 200:
                            await interaction.followup.send(
                                "✅ Auto-Bloqueador atualizado com sucesso."
                            )
                        else:
                            logger.warning(
                                f"Erro ao atualizar: {response.status} - {text}"
                            )
                            await interaction.followup.send(
                                f"❌ Erro ao atualizar o Auto-Bloqueador. ({response.status})"
                            )
            except Exception as e:
                logger.exception("Exceção ao tentar atualizar o Auto-Bloqueador:")
                await interaction.followup.send(f"❌ Erro inesperado: `{e}`")


async def setup(bot: commands.Bot):
    await bot.add_cog(AbmagnusModule(bot))

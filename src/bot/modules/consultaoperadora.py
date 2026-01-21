import asyncio
import logging
import re
import time
from typing import Optional

import discord
import requests
from bs4 import BeautifulSoup
from discord import app_commands
from discord.ext import commands

MAX_DISCORD_MESSAGE_LENGTH = 2000


def normalizar_numero(input_str: str) -> Optional[str]:
    """
    Normaliza o número de telefone, removendo caracteres não numéricos,
    tratando números 0800 e validando o tamanho (10 ou 11 dígitos).
    """
    if not input_str:
        return None

    numero = re.sub(r"\D", "", str(input_str))

    # Remove o '0' inicial em números 0800
    if numero.startswith("0800"):
        numero = numero[1:]

    # Valida tamanhos comuns no BR: fixo (10 dígitos) ou móvel (11 dígitos)
    if len(numero) not in [10, 11]:
        return None

    return numero


class ConsultaOperadora(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.module_name = "consulta_operadora"
        self.logger = logging.getLogger(f"bot.module.{self.module_name}")
        self._lock = asyncio.Lock()  # Lock para rate limit global
        self._last_consulta = (
            0  # Timestamp da última consulta (fallback, mas lock previne race)
        )

    @app_commands.command(
        name="consultaoperadora",
        description="Consulta a operadora de um número de telefone brasileiro.",
    )
    @app_commands.describe(numero="Número de telefone para consultar (ex: 11999999999)")
    async def consultaoperadora(self, interaction: discord.Interaction, numero: str):
        await interaction.response.defer(ephemeral=True)

        # Rate limit global: 1 requisição a cada 30 segundos
        async with self._lock:
            current_time = time.time()
            if current_time - self._last_consulta < 30:
                wait_time = 30 - (current_time - self._last_consulta)
                await interaction.followup.send(
                    f"⏳ Aguarde {wait_time:.0f} segundos antes de usar novamente.",
                    ephemeral=True,
                )
                return
            self._last_consulta = current_time

        # Normaliza o número
        numero_norm = normalizar_numero(numero)
        if not numero_norm:
            await interaction.channel.send(
                embed=discord.Embed(
                    title="📞 Consulta de Operadora",
                    description="❌ Número inválido. Certifique-se de que é um número brasileiro válido (10 ou 11 dígitos).",
                    color=0xFF0000,  # Vermelho para erro
                )
            )
            return

        # Realiza a consulta
        url = "http://consultaoperadora.com.br/site2015/resposta.php"
        data = {"tipo": "consulta", "numero": numero_norm}
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0",
        }

        try:
            response = requests.post(url, data=data, headers=headers, timeout=5)
            response.raise_for_status()  # Levanta exceção para códigos de erro HTTP
        except requests.exceptions.Timeout:
            await interaction.channel.send(
                embed=discord.Embed(
                    title="📞 Consulta de Operadora",
                    description=f"❌ A consulta para o número **{numero_norm}** excedeu o tempo limite. Tente novamente mais tarde.",
                    color=0xFF0000,  # Vermelho para erro
                )
            )
            return
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Erro na requisição: {e}")
            await interaction.channel.send(
                embed=discord.Embed(
                    title="📞 Consulta de Operadora",
                    description=f"❌ Ocorreu um erro ao consultar o número **{numero_norm}**. Tente novamente mais tarde.",
                    color=0xFF0000,  # Vermelho para erro
                )
            )
            return

        # Decodifica a resposta como latin1 e parseia o HTML
        try:
            html = response.content.decode("latin1")
            soup = BeautifulSoup(html, "html.parser")
            elemento = soup.find("div", id="resultado_num")
            if not elemento:
                raise ValueError("Elemento de resultado não encontrado")

            texto = re.sub(r"\s+", " ", elemento.get_text()).strip()
            if not texto:
                raise ValueError("Resposta vazia do serviço")

        except Exception as e:
            self.logger.error(f"Erro ao parsear resposta: {e}")
            await interaction.channel.send(
                embed=discord.Embed(
                    title="📞 Consulta de Operadora",
                    description=f"❌ Não foi possível processar a resposta para o número **{numero_norm}**.",
                    color=0xFF0000,  # Vermelho para erro
                )
            )
            return

        # Extrai as informações usando regex
        operadora_match = re.search(
            r"Operadora:\s*(.+?)\s*Portado:", texto, re.IGNORECASE
        )
        portado_match = re.search(r"Portado:\s*(SIM|NÃO)", texto, re.IGNORECASE)

        operadora = operadora_match.group(1).strip() if operadora_match else None
        portado = portado_match.group(1).upper() == "SIM" if portado_match else None

        if not operadora:
            await interaction.channel.send(
                embed=discord.Embed(
                    title="📞 Consulta de Operadora",
                    description=f"❌ Não foi possível encontrar informações para o número **{numero_norm}**. Pode ser um número inválido ou sem dados disponíveis.",
                    color=0xFF0000,  # Vermelho para erro
                )
            )
            return

        # Monta a resposta
        portado_str = (
            "Sim"
            if portado is True
            else "Não" if portado is False else "Não disponível"
        )
        embed = discord.Embed(title="📞 Consulta de Operadora", color=0x00FF00)
        embed.add_field(name="Número", value=f"`{numero_norm}`", inline=True)
        embed.add_field(name="Portado", value=f"`{portado_str}`", inline=True)
        embed.add_field(name="Operadora", value=f"`{operadora}`", inline=False)
        embed.set_footer(text="Dados consultados via API externa")

        await interaction.channel.send(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(ConsultaOperadora(bot))

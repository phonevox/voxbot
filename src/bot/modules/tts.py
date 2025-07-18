import discord
from discord.ext import commands
from discord import app_commands
import logging
import requests
from io import BytesIO
import shutil
from pydub import AudioSegment
import re
import unicodedata
import os


def normalize_audio_name(text: str, word_limit: int = 4) -> str:
    # Remove acentos
    text = unicodedata.normalize("NFD", text)
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")

    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    words = text.split()

    if word_limit:
        words = words[:word_limit]

    normalized = "-".join(words)

    return normalized


class TTSCog(commands.Cog):
    module_name = "tts"

    def __init__(self, bot: commands.Bot, ffmpeg_available: bool):
        self.bot = bot
        self.FFMPEG_AVAILABLE = ffmpeg_available
        self.logger = logging.getLogger(f"bot.module.{self.module_name}")

        self.api_url = os.getenv("MOD_TTS_URL")
        self.api_key = os.getenv("MOD_TTS_TOKEN")

        if not self.FFMPEG_AVAILABLE:
            self.logger.warning("FFmpeg não está disponível, conversão do TTS não funcionará.")

    def __getLogger(self, name):
        return logging.getLogger(f"bot.module.{self.module_name}.{name}")

    @app_commands.command(name="tts", description="Gerar áudio texto-para-voz")
    @app_commands.describe(
        texto="Mensagem a ser falada",
        output="Nome do arquivo de saída (sem extensão)",
        converter="Se deve converter o áudio para WAV 8000Hz mono",
        ephemeral="Se deve responder de forma efêmera (apenas para você)",
    )
    async def tts(
        self,
        interaction: discord.Interaction,
        text: str,
        output: str = None,
        ephemeral: bool = False,
        converter: bool = False,
    ):
        logger = self.__getLogger("tts")
        await interaction.response.defer(thinking=True, ephemeral=ephemeral)

        output_filename = output  # renomeando var

        def error_embed(message: str) -> discord.Embed:
            return discord.Embed(description=message, color=0xFF4C4C)

        try:

            # requisitando o áudio
            url = self.api_url
            headers = {
                "Authorization": f"Bearer {self.api_key}",
            }
            payload = {"text": text}

            response = requests.post(url, headers=headers, json=payload)

            if response.status_code != 200 or not response.content:
                return await interaction.followup.send(embed=error_embed("Erro ao gerar o áudio."), ephemeral=ephemeral)

            content_type = response.headers.get("Content-Type", "")
            if "application/json" in content_type:
                data = response.json()
                logger.warning(f"Resposta inesperada da API: {data}")
                return await interaction.followup.send(embed=error_embed("Resposta inválida da API de TTS."), ephemeral=ephemeral)

            audio_bytes = BytesIO(response.content)

            # convertendo se necessario
            if converter:
                if not self.FFMPEG_AVAILABLE:
                    return await interaction.followup.send(
                        embed=error_embed("⚠️ O sistema não consegue converter áudios atualmente.\nPara mais informações, consulte o log."),
                        ephemeral=ephemeral
                    )

                audio = AudioSegment.from_file(audio_bytes, format="mp3")
                converted_audio = audio.set_frame_rate(8000).set_channels(1)

                output = BytesIO()
                converted_audio.export(output, format="wav")
                output.seek(0)

                final_file = output
                file_extension = "wav"
            else:
                final_file = audio_bytes
                file_extension = "mp3"

            # nome do arquivo
            if output_filename:
                filename = f"{output_filename}.{file_extension}"
            else:
                normalized_filename = normalize_audio_name(text)
                if not normalized_filename:  # burro demais slk
                    normalized_filename = "unnamed-tts"
                filename = f"{normalized_filename}.{file_extension}"

            # Verificação final de tamanho
            if final_file.getbuffer().nbytes > 10 * 1024 * 1024:
                return await interaction.followup.send(embed=error_embed("O áudio gerado é muito grande para enviar aqui. (10MB+)"), ephemeral=ephemeral)

            file = discord.File(final_file, filename=filename)
            await interaction.followup.send(file=file)

        except Exception as e:
            logger.error("Erro ao gerar TTS", exc_info=e)
            await interaction.followup.send(embed=error_embed("Algo deu errado 🥲"))


async def setup(bot: commands.Bot):
    ffmpeg_available = shutil.which("ffmpeg") is not None
    await bot.add_cog(TTSCog(bot, ffmpeg_available))

import logging
import os
import tempfile
import uuid

import discord
from discord import app_commands
from discord.ext import commands


def parse_csv_line(line: str) -> list[str]:
    fields = []
    field = ""
    in_quotes = False
    i = 0
    while i < len(line):
        c = line[i]
        if c == '"':
            if in_quotes:
                # aspas duplas internas = escape
                if i + 1 < len(line) and line[i + 1] == '"':
                    field += '"'
                    i += 1  # pula a segunda aspas
                else:
                    in_quotes = False  # fecha aspas
            else:
                in_quotes = True  # abre aspas
        elif c == "," and not in_quotes:
            fields.append(field)
            field = ""
        else:
            field += c
        i += 1
    fields.append(field)
    return fields


class IssabelReportParser(commands.Cog):
    def __init__(self, bot):
        self.module_name = "issabel_report_parser"
        self.bot = bot

    def cog_load(self):
        self.bot.tree.add_command(self.IssabelGroup(self))

    def __getLogger(self, name):
        return logging.getLogger(f"bot.module.{self.module_name}.{name}")

    class IssabelGroup(app_commands.Group):
        def __init__(self, cog):
            super().__init__(
                name="issabel", description="Commands for issabel report parser"
            )
            self.cog = cog

        def __getLogger(self, name):
            return logging.getLogger(f"bot.module.{self.cog.module_name}.{name}")

        @app_commands.command(
            name="cdr-extract",
            description="Extrai um relatório de um arquivo csv do CDR.",
        )
        async def cdr_extract(
            self, interaction: discord.Interaction, file: discord.Attachment
        ):
            logger = self.__getLogger("cdr_extract")
            if not file.filename.lower().endswith(".csv"):
                await interaction.response.send_message(
                    "Por favor envie um arquivo .csv válido.", ephemeral=True
                )
                return

            await interaction.response.defer(thinking=True)

            # Baixa o conteúdo do CSV
            csv_bytes = await file.read()
            csv_text = csv_bytes.decode("utf-8")  # ou "latin1" se for ISO-8859-1
            lines = csv_text.splitlines()
            header = parse_csv_line(lines[0])
            data = []
            for line in lines[1:]:
                cols = parse_csv_line(line)
                if len(cols) == len(header):
                    row_dict = {header[i]: cols[i] for i in range(len(header))}
                    data.append(row_dict)
                else:
                    logger.warning(f"Linha malformada ignorada: {line}")

            test_dict = {}
            for row in data:
                uid = row["UniqueID"]
                if uid not in test_dict:
                    test_dict[uid] = []
                test_dict[uid].append(row)

            ret_data = []
            ret_data.append(
                '"Date","Source","Ring Group","Destination","Src. Channel","Account Code","Dst. Channel","Status","Duration","UniqueID","User Field","DID","CEL"'
            )
            for uid, linhas in test_dict.items():
                call_end = linhas[0]
                call_start = linhas[-1]  # noqa
                # print("----------------------------")
                # print(f"UID: {uid} -> {len(linhas)} registros")
                # print(f"First line: --> {call_end}")
                # print(f"Last line: --> {call_start}")
                # print("=============")

                return_line = f"\"{call_end['Date']}\",\"{call_end['Source']}\",\"{call_end['Ring Group']}\",\"{call_end['Destination']}\",\"{call_end['Dst. Channel']}\",\"{call_end['Account Code']}\",\"{call_end['Dst. Channel']}\",\"{'ATENDIDA' if call_end['Status'].lower() == 'answered' else 'PERDIDA'}\",\"{call_end['Duration']}\",\"{call_end['UniqueID']}\",\"{call_end['User Field']}\",\"{call_end['DID']}\",\"{call_end['CEL']}\""
                ret_data.append(return_line)
                # print("----------------------------\n")

            with tempfile.NamedTemporaryFile(
                mode="w+",
                delete=False,
                prefix="relatorio_",
                suffix=".csv",
                encoding="utf-8",
            ) as f:
                f.write("\n".join(ret_data))
                f_path = f.name  # exemplo: /tmp/relatorio_abcd1234.txt

            # Enviar e apagar depois
            try:
                file_to_send = discord.File(
                    f_path, filename=f"report_{uuid.uuid4().hex}.csv"
                )
                await interaction.followup.send(file=file_to_send)
            finally:
                try:
                    os.remove(f_path)
                except OSError as e:
                    print(f"Erro ao tentar deletar o arquivo temporário: {e}")

            await interaction.followup.send(
                '⚠️ Em caso de ligações perdidas, é importante ressaltar que o campo "Dst. Channel" não vai representar exatamente o membro que recusou a chamada. Caso a chamada tenha sido enviada para uma fila, é gerado DIVERSOS canais com o mesmo UID, nós apenas pegamos o último.\nResumidamente: não confie no valor que está em "Dst. Channel" para chamadas perdidas.',
                ephemeral=False,
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(IssabelReportParser(bot))

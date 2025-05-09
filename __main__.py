import asyncio
import logging
import logging.handlers
import os
import colorlog
import src.utils.logging as logutils
from aiohttp import ClientSession
from dotenv import load_dotenv
from typing import List, Optional

from src.lib.DiscordBot import DiscordBot

async def main():
    """main func"""
    
    # preparing logger
    discord_logger = logging.getLogger("discord")
    fc_logger = logging.getLogger("bot")
    
    # setting level
    discord_logger.setLevel(logging.INFO)
    fc_logger.setLevel(logging.TEST)
    
    # creating the handlers
    log_volume = os.getenv("LOG_VOLUME")
    console_handler = logging.StreamHandler()
    
    if log_volume:
        file_handler = logging.handlers.RotatingFileHandler(
            filename=f"{log_volume}/bot.log",
            encoding="utf-8",
            maxBytes=32 * 1024 * 1024,  # 32 MiB
            backupCount=5,  # Rotate through 5 files
        )

    # setting format for each handler
    date_format = "%Y-%m-%d %H:%M:%S"
    
    if log_volume:
        file_formatter = logging.Formatter("[{asctime}] [{levelname:<8}] {name}: {message}", date_format, style="{")
        file_handler.setFormatter(file_formatter)
    
    console_handler.setFormatter(logutils.color_formatter)
    
    # registering handlers
    if log_volume:
        discord_logger.addHandler(file_handler)
        fc_logger.addHandler(file_handler)

    discord_logger.addHandler(console_handler)
    fc_logger.addHandler(console_handler)
    
    # start async session
    async with ClientSession() as web_client:
        async with DiscordBot(
            command_prefix=os.getenv("BOT_PREFIX", "f!"),
            when_mentioned=True,
            web_client=web_client,
            testing_guild_id=os.getenv("BOT_TESTING_GUILD_ID", None)
        ) as client:
            await client.start(os.getenv("BOT_TOKEN", ""))
            
if __name__ == "__main__":
    load_dotenv()
    asyncio.run(main())

import logging
import logging.handlers
import os
import sys
from functools import partial, partialmethod  # for custom log levels

import colorlog

# add custom log level "test"
logging.TEST = 4
logging.addLevelName(logging.TEST, "TEST")
logging.Logger.test = partialmethod(logging.Logger.log, logging.TEST)
logging.test = partial(logging.log, logging.TEST)

# add custom log level "trace"
logging.TRACE = 5
logging.addLevelName(logging.TRACE, "TRACE")
logging.Logger.trace = partialmethod(logging.Logger.log, logging.TRACE)
logging.trace = partial(logging.log, logging.TRACE)

# add custom log level "command" # for bot commands
logging.COMMAND = 11
logging.addLevelName(logging.COMMAND, "COMMAND")
logging.Logger.command = partialmethod(logging.Logger.log, logging.COMMAND)
logging.command = partial(logging.log, logging.COMMAND)

# add custom log level "command" # for bot commands
logging.EVENT = 12
logging.addLevelName(logging.EVENT, "EVENT")
logging.Logger.event = partialmethod(logging.Logger.log, logging.EVENT)
logging.event = partial(logging.log, logging.EVENT)

if getattr(sys, "frozen", False):
    log_file_path = os.path.join(os.path.dirname(sys.executable), "debug.log")
else:
    log_file_path = os.path.join(
        os.path.dirname(os.path.abspath(__name__)), "logs/debug.log"
    )

logging.LOG_FILE_PATH = log_file_path

file_handler = logging.handlers.RotatingFileHandler(
    filename=log_file_path,
    encoding="utf-8",
    maxBytes=32 * 1024 * 1024,  # 32 MiB
    backupCount=5,  # Rotate through 5 files
)
console_handler = logging.StreamHandler()

# setting format for each handler
date_format = "%Y-%m-%d %H:%M:%S"
file_formatter = logging.Formatter(
    "[{asctime}] [{levelname:<8}] {name}: {message}", date_format, style="{"
)
file_handler.setFormatter(file_formatter)

color_formatter = colorlog.ColoredFormatter(
    fmt="[%(asctime)s] [%(log_color)s%(levelname)-8s%(reset)s] %(log_color)s%(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    log_colors={
        "TEST": "purple",
        "TRACE": "cyan",
        "DEBUG": "blue",
        "COMMAND": "light_purple",
        "EVENT": "bold_purple",
        "INFO": "green",
        "WARNING": "yellow",
        "ERROR": "red",
        "CRITICAL": "bold_red",
    },
    reset=True,
)
console_handler.setFormatter(color_formatter)

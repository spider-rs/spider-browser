"""Structured logger for spider-browser."""

import logging
import sys

logger = logging.getLogger("spider-browser")
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s spider-browser: %(message)s"))
logger.addHandler(_handler)
logger.setLevel(logging.INFO)


def set_level(level: str) -> None:
    """Set log level: debug, info, warn, error, silent."""
    mapping = {
        "debug": logging.DEBUG,
        "info": logging.INFO,
        "warn": logging.WARNING,
        "error": logging.ERROR,
        "silent": logging.CRITICAL + 1,
    }
    logger.setLevel(mapping.get(level, logging.INFO))

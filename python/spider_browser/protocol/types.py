"""Protocol message types and key mappings."""

from __future__ import annotations
from dataclasses import dataclass

KEY_MAP: dict[str, tuple[str, str, int]] = {
    "Enter": ("Enter", "Enter", 13),
    "Tab": ("Tab", "Tab", 9),
    "Escape": ("Escape", "Escape", 27),
    "Backspace": ("Backspace", "Backspace", 8),
    "Delete": ("Delete", "Delete", 46),
    "Space": (" ", "Space", 32),
    " ": (" ", "Space", 32),
    "ArrowLeft": ("ArrowLeft", "ArrowLeft", 37),
    "ArrowUp": ("ArrowUp", "ArrowUp", 38),
    "ArrowRight": ("ArrowRight", "ArrowRight", 39),
    "ArrowDown": ("ArrowDown", "ArrowDown", 40),
    "Home": ("Home", "Home", 36),
    "End": ("End", "End", 35),
    "PageUp": ("PageUp", "PageUp", 33),
    "PageDown": ("PageDown", "PageDown", 34),
}


def get_key_params(key_name: str) -> tuple[str, str, int]:
    """Map a key name to (key, code, keyCode) for CDP key events."""
    return KEY_MAP.get(key_name, (key_name, key_name, 0))

"""Typed event emitter for SpiderBrowser events."""

from __future__ import annotations
from collections import defaultdict
from typing import Any, Callable


class SpiderEventEmitter:
    """Simple synchronous event emitter."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[Callable[..., Any]]] = defaultdict(list)

    def on(self, event: str, handler: Callable[..., Any]) -> None:
        self._handlers[event].append(handler)

    def off(self, event: str, handler: Callable[..., Any]) -> None:
        try:
            self._handlers[event].remove(handler)
        except ValueError:
            pass

    def once(self, event: str, handler: Callable[..., Any]) -> None:
        def wrapper(*args: Any, **kwargs: Any) -> None:
            self.off(event, wrapper)
            handler(*args, **kwargs)
        self._handlers[event].append(wrapper)

    def emit(self, event: str, data: dict[str, Any] | None = None) -> None:
        for handler in list(self._handlers.get(event, [])):
            try:
                handler(data or {})
            except Exception:
                pass

    def remove_all_listeners(self, event: str | None = None) -> None:
        if event:
            self._handlers.pop(event, None)
        else:
            self._handlers.clear()

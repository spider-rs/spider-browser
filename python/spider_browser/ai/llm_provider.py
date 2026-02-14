"""Pluggable LLM provider interface."""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Union

from ..utils.errors import LLMError


@dataclass
class LLMConfig:
    """LLM configuration for AI methods."""

    provider: Literal["openai", "anthropic", "openrouter"]
    model: str
    api_key: str
    base_url: Optional[str] = None
    max_tokens: int = 4096
    temperature: float = 0.1


# Message types matching OpenAI's format
LLMContentPart = Union[
    Dict[str, Any],  # {"type": "text", "text": "..."} or {"type": "image_url", "image_url": {"url": "..."}}
]

LLMMessage = Dict[str, Any]  # {"role": "system"|"user"|"assistant", "content": str | list[LLMContentPart]}


class LLMProvider(ABC):
    """Abstract LLM provider."""

    @abstractmethod
    async def chat(self, messages: List[LLMMessage], *, json_mode: bool = False) -> str:
        """Call the LLM with messages and get a text response."""
        ...

    async def chat_json(self, messages: List[LLMMessage]) -> Any:
        """Call the LLM and parse the response as JSON."""
        text = await self.chat(messages, json_mode=True)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try extracting from markdown code blocks
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                return json.loads(match.group(1))
            raise LLMError(f"LLM response is not valid JSON: {text[:200]}")


def create_provider(config: LLMConfig) -> LLMProvider:
    """Create an LLM provider from config."""
    if config.provider in ("openai", "openrouter"):
        from .providers.openai_provider import OpenAICompatibleProvider
        return OpenAICompatibleProvider(config)
    elif config.provider == "anthropic":
        from .providers.anthropic_provider import AnthropicProvider
        return AnthropicProvider(config)
    else:
        raise ValueError(f"Unknown LLM provider: {config.provider}")

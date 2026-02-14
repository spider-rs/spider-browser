"""Anthropic native API provider."""

from __future__ import annotations

import re
from typing import Any, Dict, List

import httpx

from ..llm_provider import LLMConfig, LLMMessage, LLMProvider
from ...utils.errors import LLMError


class AnthropicProvider(LLMProvider):
    """Anthropic /v1/messages provider with format conversion."""

    def __init__(self, config: LLMConfig) -> None:
        self._url = config.base_url or "https://api.anthropic.com/v1/messages"
        self._api_key = config.api_key
        self._model = config.model
        self._max_tokens = config.max_tokens
        self._temperature = config.temperature

    async def chat(self, messages: List[LLMMessage], *, json_mode: bool = False) -> str:
        # Extract system message
        system_msg = next((m for m in messages if m.get("role") == "system"), None)
        user_messages = [m for m in messages if m.get("role") != "system"]

        # Convert to Anthropic format
        anthropic_messages = []
        for m in user_messages:
            content = m.get("content", "")
            if isinstance(content, str):
                anthropic_messages.append({"role": m["role"], "content": content})
            elif isinstance(content, list):
                parts = []
                for part in content:
                    if part.get("type") == "text":
                        parts.append({"type": "text", "text": part["text"]})
                    elif part.get("type") == "image_url":
                        data_url = part["image_url"]["url"]
                        match = re.match(r"^data:(image/\w+);base64,(.+)$", data_url, re.DOTALL)
                        if match:
                            parts.append({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": match.group(1),
                                    "data": match.group(2),
                                },
                            })
                        else:
                            parts.append({
                                "type": "image",
                                "source": {"type": "url", "url": data_url},
                            })
                anthropic_messages.append({"role": m["role"], "content": parts})

        body: Dict[str, Any] = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "temperature": self._temperature,
            "messages": anthropic_messages,
        }

        if system_msg:
            content = system_msg.get("content", "")
            if isinstance(content, str):
                body["system"] = content
            elif isinstance(content, list):
                body["system"] = "\n".join(p.get("text", "") for p in content)

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                self._url,
                json=body,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                },
            )

        if resp.status_code != 200:
            raise LLMError(f"Anthropic API error {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        content_block = (data.get("content") or [{}])[0]
        text = content_block.get("text")
        if not isinstance(text, str):
            raise LLMError("Anthropic response missing content[0].text")
        return text

"""OpenAI-compatible LLM provider (works with OpenAI, OpenRouter, vLLM)."""

from __future__ import annotations

from typing import Any, Dict, List

import httpx

from ..llm_provider import LLMConfig, LLMMessage, LLMProvider
from ...utils.errors import LLMError

_DEFAULT_URLS: Dict[str, str] = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
}


class OpenAICompatibleProvider(LLMProvider):
    """OpenAI-compatible /v1/chat/completions provider."""

    def __init__(self, config: LLMConfig) -> None:
        self._url = config.base_url or _DEFAULT_URLS.get(config.provider, _DEFAULT_URLS["openai"])
        self._api_key = config.api_key
        self._model = config.model
        self._max_tokens = config.max_tokens
        self._temperature = config.temperature

    async def chat(self, messages: List[LLMMessage], *, json_mode: bool = False) -> str:
        body: Dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "max_tokens": self._max_tokens,
            "temperature": self._temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                self._url,
                json=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
            )

        if resp.status_code != 200:
            raise LLMError(f"OpenAI API error {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content")
        if not isinstance(content, str):
            raise LLMError("OpenAI response missing choices[0].message.content")
        return content

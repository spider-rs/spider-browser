"""extract() — structured data extraction from pages."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional, Type

from ..protocol.protocol_adapter import ProtocolAdapter
from ..utils.html import truncate_html
from .llm_provider import LLMProvider


async def extract(
    adapter: ProtocolAdapter,
    llm: LLMProvider,
    instruction: str,
    schema: Optional[Any] = None,
) -> Any:
    """
    Extract structured data from the page.

    Takes a screenshot + HTML, sends to LLM with the instruction
    and optional Pydantic model, returns parsed data.
    """
    screenshot, html, url, title = await asyncio.gather(
        adapter.capture_screenshot(),
        adapter.get_html(),
        adapter.evaluate("window.location.href"),
        adapter.evaluate("document.title"),
    )

    truncated_html = truncate_html(str(html), 12000)

    schema_desc = ""
    if schema is not None:
        try:
            # Pydantic v2 model
            if hasattr(schema, "model_json_schema"):
                schema_desc = f"\n\nReturn data matching this JSON schema:\n{json.dumps(schema.model_json_schema(), indent=2)}"
            else:
                schema_desc = "\n\nReturn a JSON object matching the expected structure."
        except Exception:
            schema_desc = "\n\nReturn a JSON object matching the expected structure."

    system_prompt = (
        f"You are a data extraction agent. Given a webpage screenshot and HTML, "
        f"extract the requested information as JSON.{schema_desc}\n\n"
        f"Return ONLY a valid JSON object. No prose, no markdown."
    )

    user_text = f"URL: {url}\nTitle: {title}\nInstruction: {instruction}\n\nHTML (truncated):\n{truncated_html}"

    result = await llm.chat_json([
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot}"}},
            ],
        },
    ])

    # Validate with Pydantic if schema provided
    if schema is not None and hasattr(schema, "model_validate"):
        return schema.model_validate(result)

    return result

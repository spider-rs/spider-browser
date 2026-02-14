"""act() — single action from natural language."""

from __future__ import annotations

import asyncio

from ..protocol.protocol_adapter import ProtocolAdapter
from .llm_provider import LLMProvider
from .prompts import SYSTEM_PROMPT, build_user_message
from .agent import execute_action


async def act(
    adapter: ProtocolAdapter,
    llm: LLMProvider,
    instruction: str,
) -> None:
    """
    Execute a single action from natural language.

    Takes a screenshot + HTML, sends to LLM with the instruction,
    then executes the returned action steps.
    """
    screenshot, html, url, title = await asyncio.gather(
        adapter.capture_screenshot(),
        adapter.get_html(),
        adapter.evaluate("window.location.href"),
        adapter.evaluate("document.title"),
    )

    context = f"Task: {instruction}\nPAGE TITLE: {title}"

    plan = await llm.chat_json([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_message(str(url), str(html), str(screenshot), context)},
    ])

    steps = plan.get("steps", []) if isinstance(plan, dict) else []
    for step in steps:
        await execute_action(adapter, step)
        await asyncio.sleep(0.2)

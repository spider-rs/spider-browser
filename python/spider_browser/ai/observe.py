"""observe() — element discovery (works WITHOUT LLM)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from ..protocol.protocol_adapter import ProtocolAdapter
from ..utils.dom import GET_INTERACTIVE_ELEMENTS
from ..utils.html import truncate_html
from .llm_provider import LLMProvider


@dataclass
class ObserveResult:
    """An observed interactive element on the page."""

    selector: str
    tag: str
    type: str
    text: str
    aria_label: str
    placeholder: str
    href: str
    value: str
    rect: Dict[str, float]
    score: Optional[float] = None


async def observe(
    adapter: ProtocolAdapter,
    instruction: Optional[str] = None,
    llm: Optional[LLMProvider] = None,
) -> List[ObserveResult]:
    """
    Discover interactive elements on the page.

    Works WITHOUT an LLM — injects a DOM traversal script to collect
    interactive elements with selectors, text, and bounding rects.

    When instruction + LLM are provided, adds ranking/filtering.
    """
    raw = await adapter.evaluate(GET_INTERACTIVE_ELEMENTS)

    if not isinstance(raw, list) or len(raw) == 0:
        return []

    elements = [
        ObserveResult(
            selector=el.get("selector", ""),
            tag=el.get("tag", ""),
            type=el.get("type", ""),
            text=el.get("text", ""),
            aria_label=el.get("ariaLabel", ""),
            placeholder=el.get("placeholder", ""),
            href=el.get("href", ""),
            value=el.get("value", ""),
            rect=el.get("rect", {}),
        )
        for el in raw
        if isinstance(el, dict)
    ]

    if not instruction or not llm:
        return elements

    # Use LLM to rank/filter by relevance
    lines = []
    for i, el in enumerate(elements):
        parts = [f"[{i}] <{el.tag}>"]
        if el.text:
            parts.append(f'text="{el.text}"')
        if el.aria_label:
            parts.append(f'aria="{el.aria_label}"')
        if el.placeholder:
            parts.append(f'placeholder="{el.placeholder}"')
        if el.href:
            parts.append(f'href="{el.href}"')
        if el.type:
            parts.append(f'type="{el.type}"')
        lines.append(" ".join(parts))

    element_summary = "\n".join(lines)

    response = await llm.chat_json([
        {
            "role": "system",
            "content": (
                'You are an element selector. Given a list of page elements and an instruction, '
                'return a JSON object with an "indices" array of element indices that match the instruction. '
                'Order by relevance (most relevant first). Return {"indices": []} if none match.'
            ),
        },
        {
            "role": "user",
            "content": f"Instruction: {instruction}\n\nElements:\n{element_summary}",
        },
    ])

    indices = response.get("indices", []) if isinstance(response, dict) else []
    result = []
    for rank, idx in enumerate(indices):
        if isinstance(idx, int) and 0 <= idx < len(elements):
            el = elements[idx]
            el.score = 1 - rank / max(len(indices), 1)
            result.append(el)
    return result

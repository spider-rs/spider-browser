"""Autonomous multi-step agent."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..protocol.protocol_adapter import ProtocolAdapter
from ..events.emitter import SpiderEventEmitter
from ..utils.errors import TimeoutError
from ..utils.logger import logger
from .llm_provider import LLMProvider
from .prompts import SYSTEM_PROMPT, build_user_message


@dataclass
class AgentOptions:
    """Agent configuration."""

    max_rounds: int = 30
    step_delay_ms: int = 1500
    instruction: Optional[str] = None


@dataclass
class AgentResult:
    """Agent execution result."""

    done: bool
    rounds: int
    extracted: Any = None
    label: str = ""


class Agent:
    """
    Autonomous multi-step agent.

    Uses the same action vocabulary and system prompt as Spider's
    server-side captcha solver.

    Loop: screenshot -> HTML -> LLM -> parse plan -> execute actions -> repeat.
    """

    def __init__(
        self,
        adapter: ProtocolAdapter,
        llm: LLMProvider,
        emitter: SpiderEventEmitter,
        options: Optional[AgentOptions] = None,
    ) -> None:
        self._adapter = adapter
        self._llm = llm
        self._emitter = emitter
        opts = options or AgentOptions()
        self._max_rounds = opts.max_rounds
        self._step_delay_s = opts.step_delay_ms / 1000.0
        self._instruction = opts.instruction

    async def execute(self, instruction: str) -> AgentResult:
        """Execute the agent loop until done or max rounds reached."""
        extracted: Any = None
        last_label = ""

        await asyncio.sleep(0.5)

        for round_num in range(self._max_rounds):
            # 1. Screenshot
            try:
                screenshot = await self._adapter.capture_screenshot()
            except Exception as err:
                logger.warning(f"agent: screenshot failed round {round_num}: {err}")
                break

            # 2. HTML
            try:
                html = await self._adapter.get_html()
            except Exception as err:
                logger.warning(f"agent: get HTML failed round {round_num}: {err}")
                break

            # 3. URL and title
            try:
                url = str(await self._adapter.evaluate("window.location.href"))
            except Exception:
                url = "unknown"
            try:
                title = str(await self._adapter.evaluate("document.title"))
            except Exception:
                title = ""

            # 4. Call LLM
            context = f"Round {round_num + 1}/{self._max_rounds}. Task: {instruction}\nPAGE TITLE: {title}"

            try:
                plan = await self._llm.chat_json([
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": build_user_message(url, html, screenshot, context)},
                ])
            except Exception as err:
                logger.warning(f"agent: LLM call failed round {round_num}: {err}")
                await asyncio.sleep(2.0)
                continue

            if not isinstance(plan, dict):
                await asyncio.sleep(self._step_delay_s)
                continue

            last_label = plan.get("label", "")
            if plan.get("extracted") is not None:
                extracted = plan["extracted"]

            steps = plan.get("steps", [])
            logger.info(f"agent: round {round_num + 1} label={last_label} done={plan.get('done')} steps={len(steps)}")

            self._emitter.emit("agent.step", {
                "round": round_num + 1,
                "label": last_label,
                "stepsCount": len(steps),
            })

            # 5. Check if done
            if plan.get("done"):
                self._emitter.emit("agent.done", {"rounds": round_num + 1, "result": extracted})
                return AgentResult(done=True, rounds=round_num + 1, extracted=extracted, label=last_label)

            if not steps:
                logger.info("agent: no steps, retrying")
                await asyncio.sleep(self._step_delay_s)
                continue

            # 6. Execute steps
            for i, action in enumerate(steps):
                try:
                    await execute_action(self._adapter, action)
                except Exception as err:
                    logger.warning(f"agent: action failed round {round_num} step {i}: {err}")
                    break
                await asyncio.sleep(0.2)

            # 7. Wait for page settle
            await asyncio.sleep(self._step_delay_s)

        logger.warning("agent: max rounds exceeded")
        self._emitter.emit("agent.error", {"error": "max rounds exceeded", "round": self._max_rounds})
        return AgentResult(done=False, rounds=self._max_rounds, extracted=extracted, label=last_label)


# -------------------------------------------------------------------
# Action executor — mirrors agent.rs execute_action()
# -------------------------------------------------------------------

async def execute_action(adapter: ProtocolAdapter, action: Dict[str, Any]) -> None:
    """Execute a single agent action via the protocol adapter."""

    # Click actions
    if "Click" in action:
        pos = await _get_element_center(adapter, action["Click"])
        await adapter.click_point(pos["x"], pos["y"])
        return

    if "ClickAll" in action:
        selector = action["ClickAll"]
        points = await adapter.evaluate(f"""
            (function() {{
                const els = document.querySelectorAll({json.dumps(selector)});
                return Array.from(els).map(el => {{
                    const r = el.getBoundingClientRect();
                    return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
                }});
            }})()
        """)
        if isinstance(points, list):
            for pt in points:
                if isinstance(pt, dict):
                    await adapter.click_point(pt["x"], pt["y"])
                    await asyncio.sleep(0.1)
        return

    if "ClickPoint" in action:
        pt = action["ClickPoint"]
        await adapter.click_point(pt["x"], pt["y"])
        return

    if "ClickHold" in action:
        data = action["ClickHold"]
        pos = await _get_element_center(adapter, data["selector"])
        await adapter.click_hold_point(pos["x"], pos["y"], data.get("hold_ms", 500))
        return

    if "ClickHoldPoint" in action:
        pt = action["ClickHoldPoint"]
        await adapter.click_hold_point(pt["x"], pt["y"], pt.get("hold_ms", 500))
        return

    if "DoubleClick" in action:
        pos = await _get_element_center(adapter, action["DoubleClick"])
        await adapter.double_click_point(pos["x"], pos["y"])
        return

    if "DoubleClickPoint" in action:
        pt = action["DoubleClickPoint"]
        await adapter.double_click_point(pt["x"], pt["y"])
        return

    if "RightClick" in action:
        pos = await _get_element_center(adapter, action["RightClick"])
        await adapter.right_click_point(pos["x"], pos["y"])
        return

    if "RightClickPoint" in action:
        pt = action["RightClickPoint"]
        await adapter.right_click_point(pt["x"], pt["y"])
        return

    if "WaitForAndClick" in action:
        selector = action["WaitForAndClick"]
        await _wait_for_element(adapter, selector, 5000)
        pos = await _get_element_center(adapter, selector)
        await adapter.click_point(pos["x"], pos["y"])
        return

    # Drag actions
    if "ClickDrag" in action:
        data = action["ClickDrag"]
        f = await _get_element_center(adapter, data["from"])
        t = await _get_element_center(adapter, data["to"])
        await adapter.drag_point(f["x"], f["y"], t["x"], t["y"])
        return

    if "ClickDragPoint" in action:
        pt = action["ClickDragPoint"]
        await adapter.drag_point(pt["from_x"], pt["from_y"], pt["to_x"], pt["to_y"])
        return

    # Input actions
    if "Type" in action:
        await adapter.insert_text(action["Type"]["value"])
        return

    if "Fill" in action:
        data = action["Fill"]
        selector = data["selector"]
        value = data["value"]
        await adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) {{ el.focus(); el.value = ''; }}
            }})()
        """)
        try:
            pos = await _get_element_center(adapter, selector)
            await adapter.click_point(pos["x"], pos["y"])
        except Exception:
            pass
        await adapter.insert_text(value)
        await adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) {{
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }})()
        """)
        return

    if "Clear" in action:
        selector = action["Clear"]
        await adapter.evaluate(f"document.querySelector({json.dumps(selector)}).value = ''")
        return

    if "Press" in action:
        await adapter.press_key(action["Press"])
        return

    if "KeyDown" in action:
        await adapter.key_down(action["KeyDown"])
        return

    if "KeyUp" in action:
        await adapter.key_up(action["KeyUp"])
        return

    # Select & Focus
    if "Select" in action:
        data = action["Select"]
        selector = data["selector"]
        value = data["value"]
        await adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) {{
                    el.value = {json.dumps(value)};
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }})()
        """)
        return

    if "Focus" in action:
        await adapter.evaluate(f"document.querySelector({json.dumps(action['Focus'])})?.focus()")
        return

    if "Blur" in action:
        await adapter.evaluate(f"document.querySelector({json.dumps(action['Blur'])})?.blur()")
        return

    if "Hover" in action:
        pos = await _get_element_center(adapter, action["Hover"])
        await adapter.hover_point(pos["x"], pos["y"])
        return

    if "HoverPoint" in action:
        pt = action["HoverPoint"]
        await adapter.hover_point(pt["x"], pt["y"])
        return

    # Scroll actions
    if "ScrollY" in action:
        await adapter.evaluate(f"window.scrollBy(0, {action['ScrollY']})")
        return

    if "ScrollX" in action:
        await adapter.evaluate(f"window.scrollBy({action['ScrollX']}, 0)")
        return

    if "ScrollTo" in action:
        selector = action["ScrollTo"]["selector"] if isinstance(action["ScrollTo"], dict) else action["ScrollTo"]
        await adapter.evaluate(
            f"document.querySelector({json.dumps(selector)})?.scrollIntoView({{ behavior: 'smooth', block: 'center' }})"
        )
        return

    if "ScrollToPoint" in action:
        pt = action["ScrollToPoint"]
        await adapter.evaluate(f"window.scrollTo({pt['x']}, {pt['y']})")
        return

    if "InfiniteScroll" in action:
        count = action["InfiniteScroll"]
        for _ in range(count):
            await adapter.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(0.5)
        return

    # Wait actions
    if "Wait" in action:
        await asyncio.sleep(action["Wait"] / 1000.0)
        return

    if "WaitFor" in action:
        await _wait_for_element(adapter, action["WaitFor"], 5000)
        return

    if "WaitForWithTimeout" in action:
        data = action["WaitForWithTimeout"]
        await _wait_for_element(adapter, data["selector"], data.get("timeout", 5000))
        return

    if "WaitForNavigation" in action:
        await asyncio.sleep(1.0)
        return

    if "WaitForDom" in action:
        timeout = action["WaitForDom"].get("timeout", 5000) if isinstance(action["WaitForDom"], dict) else 5000
        await asyncio.sleep(timeout / 1000.0)
        return

    # Navigation actions
    if "Navigate" in action:
        await adapter.navigate(action["Navigate"])
        return

    if "GoBack" in action:
        await adapter.evaluate("window.history.back()")
        return

    if "GoForward" in action:
        await adapter.evaluate("window.history.forward()")
        return

    if "Reload" in action:
        await adapter.evaluate("window.location.reload()")
        return

    # Viewport
    if "SetViewport" in action:
        data = action["SetViewport"]
        await adapter.set_viewport(
            data["width"],
            data["height"],
            data.get("device_scale_factor", 2.0),
            data.get("mobile", False),
        )
        return

    # JavaScript
    if "Evaluate" in action:
        await adapter.evaluate(action["Evaluate"])
        return

    # Screenshot (no-op — handled by agent loop)
    if "Screenshot" in action:
        return

    logger.warning(f"agent: unknown action: {json.dumps(action)[:100]}")


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

async def _get_element_center(adapter: ProtocolAdapter, selector: str) -> Dict[str, float]:
    result = await adapter.evaluate(f"""
        (function() {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
            const r = el.getBoundingClientRect();
            return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
        }})()
    """)
    if not result or not isinstance(result, dict):
        raise RuntimeError(f"Element not found: {selector}")
    return result


async def _wait_for_element(adapter: ProtocolAdapter, selector: str, timeout_ms: int) -> None:
    interval = 0.1
    max_iter = int(timeout_ms / 100)
    check_js = f"!!document.querySelector({json.dumps(selector)})"
    for _ in range(max_iter):
        found = await adapter.evaluate(check_js)
        if found:
            return
        await asyncio.sleep(interval)
    raise TimeoutError(f"Timeout waiting for element: {selector}")

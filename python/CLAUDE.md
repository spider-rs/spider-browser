# Python SDK

Python >= 3.10. Uses hatchling for builds, pydantic for models, websockets + httpx for networking.

## Commands

```bash
pip install -e ".[dev]"    # install with dev deps (pytest, pytest-asyncio)
pytest                     # run all tests
pytest tests/test_e2e.py   # e2e test (requires SPIDER_API_KEY)
```

## Architecture

Package: `spider_browser/`

- `spider_browser.py` — `SpiderBrowser` class: async context manager, init/close, AI facades
- `page.py` — `SpiderPage`: goto, click, fill, screenshot, evaluate, wait_for_*
- `protocol/transport.py` — WebSocket connection
- `protocol/cdp_session.py` / `bidi_session.py` — CDP and BiDi adapters
- `protocol/protocol_adapter.py` — unified protocol interface
- `protocol/types.py` — protocol type definitions
- `retry/retry_engine.py` — retry orchestration with browser switching
- `retry/failure_tracker.py` — per-domain failure pattern tracking
- `retry/browser_selector.py` — browser selection based on failure history
- `ai/llm_provider.py` — provider factory + interface
- `ai/providers/openai_provider.py` / `anthropic_provider.py` — LLM implementations
- `ai/act.py` / `observe.py` / `extract.py` — single-step AI actions
- `ai/agent.py` — autonomous agent loop
- `ai/prompts.py` — system prompts
- `events/emitter.py` — async event emitter
- `events/types.py` — event type definitions
- `utils/` — logger, HTML truncation, DOM helpers, error classes

## Conventions

- Filenames: snake_case
- Async-first: `SpiderBrowser` is an async context manager (`async with`)
- Pydantic v2 for config/options models
- Type hints throughout, target Python 3.10+
- Tests in `tests/`, pytest with pytest-asyncio

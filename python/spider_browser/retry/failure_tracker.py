"""Per-domain failure tracking (mirrors server hints.rs FailureTracker)."""

from __future__ import annotations

import time
from typing import Dict

from ..events.types import BrowserType

# Mirrors hints.rs FAILURE_TTL (10 minutes).
FAILURE_TTL_S = 10 * 60

# Mirrors hints.rs ROTATE_AFTER_FAILURES.
ROTATE_AFTER_FAILURES = 2


class _FailureRecord:
    __slots__ = ("count", "last_failure")

    def __init__(self) -> None:
        self.count = 0
        self.last_failure = 0.0


class FailureTracker:
    """Track (domain, browser) failure counts with 10-minute TTL."""

    def __init__(self) -> None:
        self._failures: Dict[str, _FailureRecord] = {}

    @staticmethod
    def _key(domain: str, browser: BrowserType) -> str:
        return f"{domain}::{browser}"

    def record_failure(self, domain: str, browser: BrowserType) -> None:
        k = self._key(domain, browser)
        rec = self._failures.get(k)
        if rec:
            rec.count += 1
            rec.last_failure = time.monotonic()
        else:
            rec = _FailureRecord()
            rec.count = 1
            rec.last_failure = time.monotonic()
            self._failures[k] = rec

    def record_success(self, domain: str, browser: BrowserType) -> None:
        self._failures.pop(self._key(domain, browser), None)

    def failure_count(self, domain: str, browser: BrowserType) -> int:
        rec = self._failures.get(self._key(domain, browser))
        if not rec:
            return 0
        if time.monotonic() - rec.last_failure > FAILURE_TTL_S:
            self._failures.pop(self._key(domain, browser), None)
            return 0
        return rec.count

    def total_failure_count(self, domain: str) -> int:
        now = time.monotonic()
        total = 0
        prefix = f"{domain}::"
        for key, rec in list(self._failures.items()):
            if key.startswith(prefix):
                if now - rec.last_failure < FAILURE_TTL_S:
                    total += rec.count
        return total

    def cleanup(self) -> None:
        now = time.monotonic()
        expired = [k for k, r in self._failures.items() if now - r.last_failure > FAILURE_TTL_S]
        for k in expired:
            del self._failures[k]

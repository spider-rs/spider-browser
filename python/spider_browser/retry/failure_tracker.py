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
    __slots__ = ("count", "last_failure", "error_class")

    def __init__(self) -> None:
        self.count = 0
        self.last_failure = 0.0
        # Class of the most recent failure ("blocked", "transient", ...). Used by
        # clear_class() to selectively reset failures on stealth escalation.
        self.error_class = "transient"


class FailureTracker:
    """Track (domain, browser) failure counts with 10-minute TTL."""

    def __init__(self) -> None:
        self._failures: Dict[str, _FailureRecord] = {}

    @staticmethod
    def _key(domain: str, browser: BrowserType) -> str:
        return f"{domain}::{browser}"

    def record_failure(self, domain: str, browser: BrowserType, error_class: str = "transient") -> None:
        k = self._key(domain, browser)
        rec = self._failures.get(k)
        if rec:
            rec.count += 1
            rec.last_failure = time.monotonic()
            rec.error_class = error_class
        else:
            rec = _FailureRecord()
            rec.count = 1
            rec.last_failure = time.monotonic()
            rec.error_class = error_class
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

    def clear(self, domain: str) -> None:
        """Clear all failure records for a domain (regardless of class)."""
        prefix = f"{domain}::"
        # Snapshot the keys first so we never mutate the dict while iterating it.
        for key in [k for k in self._failures if k.startswith(prefix)]:
            self._failures.pop(key, None)

    def clear_class(self, domain: str, error_class: str) -> None:
        """Clear only failures of a given class for a domain.

        Used on stealth escalation: ``blocked`` failures are cleared (a higher
        stealth tier can bypass the block), while ``transient``/disconnect
        failures are retained (escalating stealth won't fix flaky infra, so we
        keep skipping a browser that keeps dropping on this domain).
        """
        prefix = f"{domain}::"
        # Snapshot the keys first so we never mutate the dict while iterating it.
        for key in [k for k, r in self._failures.items()
                    if k.startswith(prefix) and r.error_class == error_class]:
            self._failures.pop(key, None)

    def cleanup(self) -> None:
        now = time.monotonic()
        expired = [k for k, r in self._failures.items() if now - r.last_failure > FAILURE_TTL_S]
        for k in expired:
            del self._failures[k]

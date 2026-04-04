"""Browser rotation strategy (mirrors server hints.rs)."""

from __future__ import annotations

from typing import Optional, List

from ..events.types import BrowserType
from .failure_tracker import FailureTracker, ROTATE_AFTER_FAILURES

# Primary browsers (Chrome variants) — stable, high success rate.
# Used for ALL error types with transient retries.
PRIMARY_ROTATION: List[BrowserType] = [
    "chrome",
    "chrome-new",
    "navi",
]

# Extended browsers — less stable backends + different engine fingerprints.
# Used ONLY for blocked errors where primary browsers all fail.
# chrome-h (Xvfb shared process) is here because it's less stable under load.
EXTENDED_ROTATION: List[BrowserType] = [
    "chrome-h",
    "firefox",
    "lightpanda",
    "servo",
]

# Full rotation = primary + extended.
BROWSER_ROTATION: List[BrowserType] = [
    *PRIMARY_ROTATION,
    *EXTENDED_ROTATION,
]


class BrowserSelector:
    """Pick the next browser in rotation based on failure history."""

    def __init__(self, tracker: FailureTracker) -> None:
        self._tracker = tracker

    @property
    def failure_tracker(self) -> FailureTracker:
        return self._tracker

    def should_rotate(self, domain: str, current_browser: BrowserType) -> bool:
        return self._tracker.failure_count(domain, current_browser) >= ROTATE_AFTER_FAILURES

    def next_browser(self, domain: str, current_browser: BrowserType) -> Optional[BrowserType]:
        """Get next browser that hasn't exceeded the failure threshold, or None."""
        try:
            current_idx = BROWSER_ROTATION.index(current_browser)
        except ValueError:
            current_idx = 0

        for offset in range(1, len(BROWSER_ROTATION)):
            idx = (current_idx + offset) % len(BROWSER_ROTATION)
            candidate = BROWSER_ROTATION[idx]
            if self._tracker.failure_count(domain, candidate) < ROTATE_AFTER_FAILURES:
                return candidate
        return None

    def choose_browser(self, domain: str, fallback: BrowserType) -> BrowserType:
        """Choose best browser for a domain (mirrors hints.rs choose_browser_for_domain)."""
        for browser in BROWSER_ROTATION:
            if self._tracker.failure_count(domain, browser) < ROTATE_AFTER_FAILURES:
                return browser
        return fallback

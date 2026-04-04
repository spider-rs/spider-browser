"""Event and browser type definitions."""

from typing import Literal

# navi: Spider's custom Rust-based browser, optimized for fast scraping.
BrowserType = Literal["chrome", "chrome-new", "chrome-h", "firefox", "servo", "lightpanda", "navi", "auto"]

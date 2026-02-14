"""HTML utilities mirroring server's truncate_html."""


def truncate_html(html: str, max_chars: int = 12000) -> str:
    """Truncate HTML to roughly max_chars, breaking at a tag boundary."""
    if len(html) <= max_chars:
        return html
    s = html[:max_chars]
    last_close = s.rfind(">")
    return html[: last_close + 1] if last_close > 0 else s

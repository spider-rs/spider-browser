/**
 * Truncate HTML to roughly maxChars, trying to break at a tag boundary.
 * Mirrors server's truncate_html in llm.rs.
 */
export function truncateHtml(html: string, maxChars: number = 12000): string {
  if (html.length <= maxChars) return html;
  const slice = html.slice(0, maxChars);
  const lastClose = slice.lastIndexOf('>');
  return lastClose > 0 ? html.slice(0, lastClose + 1) : slice;
}

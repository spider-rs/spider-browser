/**
 * JavaScript snippets for evaluate() — element interaction, accessibility tree, etc.
 * Injected into the browser page via protocol evaluate.
 */

/** Get the center coordinates of an element (scrolls into view). */
export const GET_ELEMENT_CENTER = (selector: string) => `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()
`;

/** Get all interactive elements on the page with selectors and bounding rects. */
export const GET_INTERACTIVE_ELEMENTS = `
(function() {
  const interactiveSelectors = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[onclick]',
    '[tabindex]',
    'summary',
    'details',
    'label',
  ];
  const seen = new Set();
  const results = [];
  for (const sel of interactiveSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < 0 || r.right < 0) continue;

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const text = (el.textContent || '').trim().slice(0, 100);
      const ariaLabel = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const href = el.getAttribute('href') || '';
      const value = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? el.value.slice(0, 50) : '';

      // Build a unique-ish selector
      let cssSelector = tag;
      const id = el.getAttribute('id');
      if (id) {
        cssSelector = '#' + CSS.escape(id);
      } else {
        const cls = el.getAttribute('class');
        if (cls) {
          const classes = cls.trim().split(/\\s+/).slice(0, 2);
          cssSelector = tag + classes.map(c => '.' + CSS.escape(c)).join('');
        }
        const name = el.getAttribute('name');
        if (name) {
          cssSelector = tag + '[name="' + CSS.escape(name) + '"]';
        }
      }

      results.push({
        selector: cssSelector,
        tag,
        type,
        text,
        ariaLabel,
        placeholder,
        href,
        value,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    }
  }
  return results;
})()
`;

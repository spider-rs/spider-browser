"""JavaScript snippets injected into the browser page."""

import json


def get_element_center_js(selector: str) -> str:
    """JS to get center coordinates of an element (scrolls into view)."""
    sel = json.dumps(selector)
    return f"""(function() {{
  var el = document.querySelector({sel});
  if (!el) return null;
  el.scrollIntoView({{block: 'center', behavior: 'instant'}});
  var r = el.getBoundingClientRect();
  return {{x: r.x + r.width / 2, y: r.y + r.height / 2}};
}})()"""


GET_INTERACTIVE_ELEMENTS = """(function() {
  var selectors = [
    'a[href]','button','input','select','textarea',
    '[role="button"]','[role="link"]','[role="tab"]',
    '[role="menuitem"]','[role="checkbox"]','[role="radio"]',
    '[role="switch"]','[role="combobox"]','[onclick]',
    '[tabindex]','summary','details','label'
  ];
  var seen = new Set(), results = [];
  for (var s of selectors) {
    for (var el of document.querySelectorAll(s)) {
      if (seen.has(el)) continue;
      seen.add(el);
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < 0 || r.right < 0) continue;
      var tag = el.tagName.toLowerCase();
      var cssSelector = tag;
      var id = el.getAttribute('id');
      if (id) { cssSelector = '#' + CSS.escape(id); }
      else {
        var name = el.getAttribute('name');
        if (name) cssSelector = tag + '[name="' + CSS.escape(name) + '"]';
      }
      results.push({
        selector: cssSelector, tag: tag,
        type: el.getAttribute('type') || '',
        text: (el.textContent || '').trim().slice(0, 100),
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        href: el.getAttribute('href') || '',
        value: (el.value || '').slice(0, 50),
        rect: {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)}
      });
    }
  }
  return results;
})()"""

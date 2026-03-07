package spiderbrowser

// getInteractiveElementsJS is the JavaScript snippet injected to discover
// interactive elements on the page. Mirrors utils/dom.ts.
const getInteractiveElementsJS = `
(function() {
  var interactiveSelectors = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="combobox"]',
    '[onclick]', '[tabindex]', 'summary', 'details', 'label'
  ];
  var seen = new Set();
  var results = [];
  for (var s = 0; s < interactiveSelectors.length; s++) {
    var els = document.querySelectorAll(interactiveSelectors[s]);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (seen.has(el)) continue;
      seen.add(el);
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < 0 || r.right < 0) continue;
      var tag = el.tagName.toLowerCase();
      var type = el.getAttribute('type') || '';
      var text = (el.textContent || '').trim().slice(0, 100);
      var ariaLabel = el.getAttribute('aria-label') || '';
      var placeholder = el.getAttribute('placeholder') || '';
      var href = el.getAttribute('href') || '';
      var value = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? el.value.slice(0, 50) : '';
      var cssSelector = tag;
      var id = el.getAttribute('id');
      if (id) {
        cssSelector = '#' + CSS.escape(id);
      } else {
        var cls = el.getAttribute('class');
        if (cls) {
          var classes = cls.trim().split(/\s+/).slice(0, 2);
          cssSelector = tag + classes.map(function(c) { return '.' + CSS.escape(c); }).join('');
        }
        var name = el.getAttribute('name');
        if (name) {
          cssSelector = tag + '[name="' + CSS.escape(name) + '"]';
        }
      }
      results.push({
        selector: cssSelector, tag: tag, type: type, text: text,
        ariaLabel: ariaLabel, placeholder: placeholder, href: href,
        value: value,
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) }
      });
    }
  }
  return results;
})()
`

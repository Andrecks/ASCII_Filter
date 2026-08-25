// DOM text extraction v2 — the real "rotoscope" source. Recursively walks visible
// elements of a document (shadow DOM included), pruning whole subtrees outside the
// viewport, and returns {text, x, y, size, weight} items in viewport CSS pixels.
// Reads input/textarea values too (they are not text nodes). No OCR anywhere.
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE',
  'IFRAME', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
const MARGIN = 40;   // viewport prune margin, px

export function extractTextItems(doc, maxItems = 1500) {
  const items = [];
  if (!doc || !doc.body) return items;
  const win = doc.defaultView;
  const vw = win.innerWidth, vh = win.innerHeight;
  const range = doc.createRange();
  const seen = new Set();

  const push = (text, x, y, size, weight, w) => {
    if (!text || items.length >= maxItems) return;
    // dedup: same string at nearly the same spot (visible+aria twins on real sites)
    const key = text + '|' + Math.round(x / 6) + '|' + Math.round(y / 6);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ text, x, y, size, weight, w });
  };

  const pushRect = (text, r, size, weight) => {
    if (r.width < 1 || r.height < 1) return;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
    push(text, r.left, r.bottom - size * 0.2, size, weight, r.width);
  };

  function walk(el, depth) {
    if (items.length >= maxItems || depth > 48) return;
    if (SKIP_TAGS.has(el.tagName)) return;

    const r = el.getBoundingClientRect();
    // prune subtrees fully outside the viewport; keep zero-size wrappers (their
    // absolutely-positioned children may still be visible)
    if (r.width > 0 && r.height > 0 &&
        (r.bottom < -MARGIN || r.top > vh + MARGIN || r.right < -MARGIN || r.left > vw + MARGIN)) return;

    const cs = win.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    if ((cs.clip && cs.clip !== 'auto') || (cs.clipPath && cs.clipPath !== 'none')) return;
    const size = parseFloat(cs.fontSize) || 14;
    const weight = (parseInt(cs.fontWeight, 10) || 400) >= 600 ? 'bold' : '';

    // form fields: value/placeholder are not text nodes
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const isTexty = el.tagName === 'TEXTAREA' ||
        !el.type || ['text', 'search', 'url', 'email', 'tel', 'number', ''].includes(el.type);
      const val = isTexty ? (el.value || el.placeholder) : (el.type === 'submit' || el.type === 'button' ? el.value : '');
      if (val && size >= 6) {
        const padL = parseFloat(cs.paddingLeft) || 2;
        pushRect(String(val).replace(/\s+/g, ' ').slice(0, 300),
          { left: r.left + padL, right: r.right, width: r.width - padL, height: r.height,
            top: r.top, bottom: r.top + (r.height + size * 0.72) / 2 + size * 0.2 },
          size, weight);
      }
      return;
    }

    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (items.length >= maxItems) return;
      if (n.nodeType === 3) {
        if (size < 6) continue;
        const raw = n.nodeValue;
        if (!raw || !raw.trim()) continue;
        range.selectNodeContents(n);
        const rects = range.getClientRects();
        if (rects.length === 1) {
          pushRect(raw.replace(/\s+/g, ' ').trim(), rects[0], size, weight);
        } else if (rects.length > 1) {
          // multi-line node: place word by word so each lands on its own line
          const re = /\S+/g;
          let m;
          while ((m = re.exec(raw)) && items.length < maxItems) {
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            pushRect(m[0], range.getBoundingClientRect(), size, weight);
          }
        }
      } else if (n.nodeType === 1) {
        walk(n, depth + 1);
      }
    }
    if (el.shadowRoot) {
      for (const c of el.shadowRoot.children) {
        if (c.nodeType === 1) walk(c, depth + 1);
      }
    }
  }

  walk(doc.body, 0);
  return items;
}

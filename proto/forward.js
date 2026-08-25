// Input forwarding into a (same-origin) document — the prototype of the extension's
// content-script side. Events are synthetic (isTrusted:false): JS handlers, link
// navigation via click(), focus and value edits all work; CSS :hover and some native
// widgets don't — the extension phase can upgrade to chrome.debugger (CDP) for
// fully trusted input if needed.
export function forwardPointer(doc, type, x, y, init = {}) {
  const el = doc.elementFromPoint(x, y) || doc.body;
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: doc.defaultView,
    clientX: x, clientY: y, ...init,
  }));
  return el;
}

export function forwardClick(doc, x, y) {
  const el = doc.elementFromPoint(x, y) || doc.body;
  const o = { bubbles: true, cancelable: true, view: doc.defaultView, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', o));
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return el;
}

export function forwardWheel(doc, x, y, dx, dy) {
  const el = doc.elementFromPoint(x, y) || doc.body;
  const proceed = el.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, view: doc.defaultView,
    clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0,
  }));
  if (proceed) {
    // synthetic wheel doesn't scroll natively — walk up to the scrollable ancestor
    let n = el;
    while (n && n !== doc.documentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && n !== doc.body) { n.scrollBy(dx, dy); return el; }
      n = n.parentElement;
    }
    doc.defaultView.scrollBy(dx, dy);
  }
  return el;
}

export function forwardKey(doc, e) {
  const t = doc.activeElement || doc.body;
  const init = {
    bubbles: true, cancelable: true, view: doc.defaultView,
    key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
    altKey: e.altKey, metaKey: e.metaKey,
  };
  const proceed = t.dispatchEvent(new KeyboardEvent('keydown', init));
  if (proceed && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const start = t.selectionStart ?? t.value.length;
    const end = t.selectionEnd ?? t.value.length;
    if (e.key.length === 1) {
      t.value = t.value.slice(0, start) + e.key + t.value.slice(end);
      t.selectionStart = t.selectionEnd = start + 1;
      t.dispatchEvent(new InputEvent('input', { bubbles: true, data: e.key, inputType: 'insertText' }));
    } else if (e.key === 'Backspace') {
      const from = start === end ? Math.max(0, start - 1) : start;
      t.value = t.value.slice(0, from) + t.value.slice(end);
      t.selectionStart = t.selectionEnd = from;
      t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    } else if (e.key === 'Enter' && t.tagName === 'TEXTAREA') {
      t.value = t.value.slice(0, start) + '\n' + t.value.slice(end);
      t.selectionStart = t.selectionEnd = start + 1;
      t.dispatchEvent(new InputEvent('input', { bubbles: true, data: '\n', inputType: 'insertLineBreak' }));
    }
  }
  t.dispatchEvent(new KeyboardEvent('keyup', init));
  return t;
}

// Phase 1: fullscreen live ASCII "browser in a tab".
// Sources:
//  - demo:   synthetic animated canvas (no permissions; used for automated tests)
//  - tab:    getDisplayMedia(preferCurrentTab) of THIS tab; iframe shows the target
//            URL. With Element Capture (RestrictionTarget) the overlay sits right on
//            top of the iframe (true transparent window); otherwise a split layout.
//  - pick:   getDisplayMedia where the user picks ANOTHER tab/window in the dialog —
//            works for sites that refuse iframes; whole stage becomes the monitor.
import { AsciiRenderer } from './ascii.js';
import { Scene } from './scene.js';
import { PRESETS } from './presets.js';
import { paintTextLayer } from './textlayer.js';
import { extractTextItems } from './domtext.js';
import { CursorLayer } from './cursor.js';
import { forwardClick, forwardPointer, forwardWheel, forwardKey } from './forward.js';
import { buildCharGrid } from './textgrid.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), wrap = $('wrap'), frame = $('frame');
const outCanvas = $('out'), statusEl = $('status'), fpsEl = $('fps');

const renderer = new AsciiRenderer(outCanvas);
const textCanvas = document.createElement('canvas');
const textCtx = textCanvas.getContext('2d');

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;

const state = {
  running: false,
  source: null,           // 'demo' | 'tab' | 'pick'
  layout: 'full',         // 'overlay' | 'split' | 'full'
  mapping: 'full',        // 'element' (video==wrapper) | 'raw' (video==whole tab)
  stream: null,
  cell: 8,
  charset: PRESETS.ascii10,
  colorMode: 0,
  invert: false,
  textPass: true,
  domTextOk: false,
  domItems: null,
  cursorOn: true,
  hideNative: false,
};

const cursor = new CursorLayer();
const chip = $('chip');
let chipTimer = 0;
function note(msg) {
  chip.textContent = msg;
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => { chip.textContent = ''; }, 1500);
}

// map a real CSS cursor to a state, resolving 'auto' by element role
function resolveCursor(el) {
  try {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el).cursor;
    if (cs && cs !== 'auto') return cs;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'text';
    if (el.closest && el.closest('a, button, [role=button], summary, label')) return 'pointer';
    return 'default';
  } catch { return 'default'; }
}

// listen inside a same-origin document: feeds the ASCII cursor in overlay mode,
// where real input already passes through natively (canvas is pointer-events:none)
const trackedDocs = new WeakSet();
function attachTracking(doc) {
  if (!doc || trackedDocs.has(doc)) return;
  trackedDocs.add(doc);
  doc.addEventListener('mousemove', (e) => {
    cursor.update({ x: e.clientX, y: e.clientY, css: resolveCursor(e.target) });
  }, { passive: true });
  doc.addEventListener('mousedown', (e) => {
    cursor.press(e.clientX, e.clientY);
    note(`mousedown ${e.clientX},${e.clientY} → ${e.target.tagName.toLowerCase()}`);
  }, { passive: true });
  doc.addEventListener('mouseup', () => cursor.release(), { passive: true });
  doc.documentElement.addEventListener('mouseleave', () => cursor.leave(), { passive: true });
  doc.addEventListener('keydown', (e) => note(`key ${e.key}`), { passive: true });
  doc.addEventListener('wheel', () => note('wheel'), { passive: true });
}

function sameOriginDoc() {
  try { return frame.contentDocument || null; } catch { return null; }
}

const support = {
  getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
  elementCapture: typeof window.RestrictionTarget !== 'undefined',
  regionCapture: typeof window.CropTarget !== 'undefined',
};

// demo source: reuse the phase-0 scene at fullscreen size
const demoCanvas = document.createElement('canvas');
demoCanvas.width = 1280;
demoCanvas.height = 720;
const demoScene = new Scene(demoCanvas);

// ---------- layout ----------
function setLayout(layout) {
  state.layout = layout;
  stage.dataset.layout = layout;   // CSS switches iframe/canvas geometry
  resizeOut();
}

function resizeOut() {
  const r = (state.layout === 'split' ? $('rightHalf') : stage).getBoundingClientRect();
  const w = Math.max(2, Math.round(r.width));
  const h = Math.max(2, Math.round(r.height));
  if (outCanvas.width !== w || outCanvas.height !== h) {
    outCanvas.width = w;
    outCanvas.height = h;
    textCanvas.width = w;
    textCanvas.height = h;
  }
}
window.addEventListener('resize', resizeOut);

function setStatus(msg) { statusEl.textContent = msg; }

// ---------- sources ----------
function stop() {
  state.running = false;
  state.domItems = null;
  state.domTextOk = false;
  if (state.stream) {
    for (const tr of state.stream.getTracks()) tr.stop();
    state.stream = null;
  }
  video.srcObject = null;
  cursor.leave();
  outCanvas.classList.remove('visible', 'interactive');
  setLayout('full');
  setStatus('остановлено');
}

function updateInteractive() {
  // demo: canvas takes input itself; split: canvas forwards into the iframe;
  // overlay: canvas stays transparent — input reaches the page natively
  const interactive = state.running &&
    (state.source === 'demo' || (state.source === 'tab' && state.layout === 'split'));
  outCanvas.classList.toggle('interactive', interactive);
}

function startDemo() {
  stop();
  state.source = 'demo';
  setLayout('full');
  outCanvas.classList.add('visible');
  state.running = true;
  updateInteractive();
  setStatus('демо-поток (синтетика, без захвата) · курсор и клики — прямо по канвасу');
}

async function startTab() {
  stop();
  if (!support.getDisplayMedia) return setStatus('getDisplayMedia недоступен в этом браузере');
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } },
      audio: false,
      preferCurrentTab: true,
    });
    const [track] = stream.getVideoTracks();
    let layout = 'split', mapping = 'raw';
    if (support.elementCapture && track.restrictTo) {
      try {
        await track.restrictTo(await RestrictionTarget.fromElement(wrap));
        layout = 'overlay'; mapping = 'element';
      } catch (e) { console.warn('restrictTo failed, falling back', e); }
    }
    if (layout === 'split' && support.regionCapture && track.cropTo) {
      try {
        await track.cropTo(await CropTarget.fromElement(wrap));
        mapping = 'element';
      } catch (e) { console.warn('cropTo failed, falling back', e); }
    }
    runStream(stream, 'tab', layout, mapping);
    setStatus(layout === 'overlay'
      ? 'эта вкладка · Element Capture · оверлей: ввод проходит сквозь фильтр нативно'
      : 'эта вкладка · сплит: кликай/скролль/печатай ПО ASCII — ввод пробрасывается в страницу');
  } catch (e) {
    setStatus('захват отклонён: ' + e.message);
  }
}

async function startPick() {
  stop();
  if (!support.getDisplayMedia) return setStatus('getDisplayMedia недоступен в этом браузере');
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } },
      audio: false,
    });
    runStream(stream, 'pick', 'full', 'full');
    setStatus('другая вкладка/окно · монитор · проброс ввода туда — только через расширение (фаза 3)');
  } catch (e) {
    setStatus('захват отклонён: ' + e.message);
  }
}

function runStream(stream, source, layout, mapping) {
  state.stream = stream;
  state.source = source;
  state.mapping = mapping;
  setLayout(layout);
  outCanvas.classList.add('visible');
  const [track] = stream.getVideoTracks();
  track.addEventListener('ended', stop);   // user pressed "stop sharing"
  video.srcObject = stream;
  video.play().then(() => { state.running = true; updateInteractive(); });
  if (source === 'tab') {
    startDomTextWatch();
    attachTracking(sameOriginDoc());
  }
}

// ---------- DOM text rotoscope (same-origin iframe only) ----------
let domTimer = 0;
function refreshDomText() {
  try {
    const doc = frame.contentDocument;           // throws/null when cross-origin
    if (!doc) throw new Error('cross-origin');
    state.domItems = extractTextItems(doc);
    state.domTextOk = true;
  } catch {
    state.domItems = null;
    state.domTextOk = false;
  }
}
function startDomTextWatch() {
  clearInterval(domTimer);
  refreshDomText();
  domTimer = setInterval(() => { if (state.running && state.source === 'tab') refreshDomText(); }, 600);
  try {
    frame.contentWindow.addEventListener('scroll', refreshDomText, { passive: true });
  } catch { /* cross-origin — no scroll hook, interval still covers slow drift */ }
}
frame.addEventListener('load', () => {
  if (state.source === 'tab') startDomTextWatch();
  attachTracking(sameOriginDoc());
  if (state.hideNative) applyHideNative(true);
});

// canvas-side input: demo mode handles it directly, split mode forwards to iframe
function canvasPos(e) { return { x: e.offsetX, y: e.offsetY }; }
function splitDoc() {
  return state.running && state.source === 'tab' && state.layout === 'split' ? sameOriginDoc() : null;
}
outCanvas.addEventListener('mousemove', (e) => {
  if (!outCanvas.classList.contains('interactive')) return;
  const { x, y } = canvasPos(e);
  const doc = splitDoc();
  if (doc) {
    const el = forwardPointer(doc, 'mousemove', x, y);
    cursor.update({ x, y, css: resolveCursor(el) });
  } else {
    cursor.update({ x, y, css: 'default' });
  }
});
outCanvas.addEventListener('mouseleave', () => {
  if (outCanvas.classList.contains('interactive')) cursor.leave();
});
outCanvas.addEventListener('mousedown', (e) => {
  if (!outCanvas.classList.contains('interactive')) return;
  const { x, y } = canvasPos(e);
  cursor.press(x, y);
  outCanvas.focus();
});
outCanvas.addEventListener('mouseup', () => cursor.release());
outCanvas.addEventListener('click', (e) => {
  if (!outCanvas.classList.contains('interactive')) return;
  const { x, y } = canvasPos(e);
  const doc = splitDoc();
  if (doc) {
    const el = forwardClick(doc, x, y);
    note(`click ${x},${y} → ${el.tagName.toLowerCase()}`);
  } else {
    note(`click ${x},${y}`);
  }
});
outCanvas.addEventListener('wheel', (e) => {
  const doc = splitDoc();
  if (!doc) return;
  e.preventDefault();
  const { x, y } = canvasPos(e);
  forwardWheel(doc, x, y, e.deltaX, e.deltaY);
  note(`wheel ${e.deltaY > 0 ? '↓' : '↑'}`);
}, { passive: false });
outCanvas.addEventListener('keydown', (e) => {
  const doc = splitDoc();
  if (!doc) return;
  e.preventDefault();
  forwardKey(doc, e);
  note(`key ${e.key}`);
});

function applyHideNative(on) {
  const doc = sameOriginDoc();
  if (doc) doc.documentElement.style.cursor = on ? 'none' : '';
}

// ---------- render loop ----------
function computeCrop(sw, sh) {
  if (state.mapping === 'element' || state.mapping === 'full') {
    return { x: 0, y: 0, w: sw, h: sh };
  }
  // raw tab stream: cut the wrapper's rect out of the full-tab frame
  const scale = sw / window.innerWidth;
  const r = wrap.getBoundingClientRect();
  return { x: r.left * scale, y: r.top * scale, w: r.width * scale, h: r.height * scale };
}

let last = performance.now(), emaMs = 16.7;
function tick(t) {
  emaMs = emaMs * 0.92 + (t - last) * 0.08;
  last = t;
  if (state.running) {
    let src = null, sw = 0, sh = 0, items = null, scaleX = 1, scaleY = 1;
    if (state.source === 'demo') {
      demoScene.draw(t);
      src = demoCanvas; sw = demoCanvas.width; sh = demoCanvas.height;
      items = demoScene.textItems;
      scaleX = outCanvas.width / sw;
      scaleY = outCanvas.height / sh;
    } else if (video.readyState >= 2 && video.videoWidth) {
      src = video; sw = video.videoWidth; sh = video.videoHeight;
      if (state.domTextOk) items = state.domItems;   // iframe CSS px == overlay px (1:1)
    }
    if (src) {
      const useText = state.textPass && items;
      const useCursor = state.cursorOn && cursor.active && state.source !== 'pick';
      const layerOn = useText || useCursor;
      if (layerOn) {
        if (useText) paintTextLayer(textCtx, items, { x: 0, y: 0 }, { scaleX, scaleY });
        else textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
        if (useCursor) cursor.draw(textCtx, state.cell, t);
      }
      renderer.render(src, sw, sh, computeCrop(sw, sh), {
        colorMode: state.colorMode,
        invert: state.invert,
        ink: [0.55, 1.0, 0.55],
        bg: [0.02, 0.045, 0.02],
        textLayer: layerOn ? textCanvas : null,
      });
      fpsEl.textContent = `${(1000 / emaMs).toFixed(0)} fps · ${outCanvas.width}×${outCanvas.height} · ` +
        `${Math.floor(outCanvas.width / state.cell)}×${Math.floor(outCanvas.height / state.cell)} ячеек` +
        (state.domTextOk ? ' · DOM-текст: да' : '');
    }
  }
  requestAnimationFrame(tick);
}

// ---------- controls ----------
function applyCharset() { renderer.setCharset(state.charset, state.cell, state.cell); }

$('go').addEventListener('click', () => {
  let url = $('url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) url = 'https://' + url;
  frame.src = url;
});
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
$('openTab').addEventListener('click', () => {
  let url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) url = 'https://' + url;
  window.open(url, '_blank');
});
$('srcDemo').addEventListener('click', startDemo);
$('srcTab').addEventListener('click', startTab);
$('srcPick').addEventListener('click', startPick);
$('stop').addEventListener('click', stop);

$('cell').addEventListener('input', () => {
  state.cell = +$('cell').value;
  $('cellVal').textContent = state.cell + 'px';
  applyCharset();
});
$('preset').addEventListener('change', () => {
  if (PRESETS[$('preset').value]) {
    state.charset = PRESETS[$('preset').value];
    applyCharset();
  }
});
$('mode').addEventListener('change', () => { state.colorMode = +$('mode').value; });
$('invert').addEventListener('change', (e) => { state.invert = e.target.checked; });
$('textpass').addEventListener('change', (e) => { state.textPass = e.target.checked; });
$('cursoron').addEventListener('change', (e) => { state.cursorOn = e.target.checked; });
$('hidecur').addEventListener('change', (e) => {
  state.hideNative = e.target.checked;
  applyHideNative(state.hideNative);
});

setStatus(`готов · поддержка: getDisplayMedia=${support.getDisplayMedia} ` +
  `elementCapture=${support.elementCapture} regionCapture=${support.regionCapture}`);
applyCharset();
resizeOut();
requestAnimationFrame(tick);

// test hook (mirrors phase 0)
window.__live = {
  state, support, renderer, startDemo, stop, demoCanvas, cursor,
  forwardClick, forwardKey, forwardWheel, sameOriginDoc, attachTracking,
  // "page as raw characters": demo-source grid for automated tests
  buildGrid(t = 2600) {
    demoScene.draw(t);
    return buildCharGrid(demoCanvas,
      { x: 0, y: 0, w: demoCanvas.width, h: demoCanvas.height },
      state.cell, state.cell, outCanvas.width, outCanvas.height,
      renderer.charsSorted, {
        invert: state.invert,
        items: state.textPass ? demoScene.textItems : null,
        scaleX: outCanvas.width / demoCanvas.width,
        scaleY: outCanvas.height / demoCanvas.height,
      });
  },
  // rect (optional, output-canvas top-left coords): sample only that region
  stats(rect) {
    const gl = renderer.gl;
    const W = outCanvas.width, H = outCanvas.height;
    const r = rect || { x: 0, y: 0, w: W, h: H };
    const px = new Uint8Array(r.w * r.h * 4);
    gl.readPixels(r.x, H - (r.y + r.h), r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    for (let i = 0; i < r.w * r.h; i++) if (px[i * 4 + 1] > 60) lit++;
    return { size: [W, H], rect: r, litFrac: +(lit / (r.w * r.h)).toFixed(3), cells: [Math.floor(W / state.cell), Math.floor(H / state.cell)] };
  },
  frameOnce(t = 2000, rect) {
    if (state.source === 'demo') {
      demoScene.draw(t);
      const items = state.textPass ? demoScene.textItems : null;
      const useCursor = state.cursorOn && cursor.active;
      if (items) paintTextLayer(textCtx, items, { x: 0, y: 0 },
        { scaleX: outCanvas.width / demoCanvas.width, scaleY: outCanvas.height / demoCanvas.height });
      else textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
      if (useCursor) cursor.draw(textCtx, state.cell, t);
      renderer.render(demoCanvas, demoCanvas.width, demoCanvas.height,
        { x: 0, y: 0, w: demoCanvas.width, h: demoCanvas.height }, {
          colorMode: state.colorMode, invert: state.invert,
          ink: [0.55, 1.0, 0.55], bg: [0.02, 0.045, 0.02],
          textLayer: (items || useCursor) ? textCanvas : null,
        });
    }
    return this.stats(rect);
  },
};

import { AsciiRenderer } from './ascii.js';
import { Scene } from './scene.js';
import { PRESETS } from './presets.js';
import { paintTextLayer } from './textlayer.js';

const sceneCanvas = document.getElementById('scene');
const outCanvas = document.getElementById('out');
const frame = document.getElementById('frame');
const fpsEl = document.getElementById('fps');

const scene = new Scene(sceneCanvas);
const renderer = new AsciiRenderer(outCanvas);

const state = {
  crop: { x: 40, y: 60, w: 100, h: 100 },
  cell: 10,
  charset: ' .:-=+*#%@',
  colorMode: 0,
  invert: false,
  textPass: true,
  matrix: false, // easter egg: Matrix rain, toggled by the M key
};

// text passthrough layer — same size as output, composited by the shader
const textCanvas = document.createElement('canvas');
textCanvas.width = outCanvas.width;
textCanvas.height = outCanvas.height;
const textCtx = textCanvas.getContext('2d');

// --- controls ---
const cellInput = document.getElementById('cell');
const charsetInput = document.getElementById('charset');
const modeSelect = document.getElementById('mode');
const invertInput = document.getElementById('invert');
const zoomInput = document.getElementById('zoom');
const rampEl = document.getElementById('ramp');

function applyCharset() {
  renderer.setCharset(state.charset, state.cell, state.cell);
  rampEl.textContent = `ramp: "${renderer.charsSorted}" (${renderer.glyphCount} glyphs, ` +
    `${Math.floor(outCanvas.width / state.cell)}×${Math.floor(outCanvas.height / state.cell)} cells)`;
}
cellInput.addEventListener('input', () => {
  state.cell = +cellInput.value;
  document.getElementById('cellVal').textContent = `${state.cell}px`;
  applyCharset();
});
charsetInput.addEventListener('change', () => {
  state.charset = charsetInput.value || ' .:-=+*#%@';
  applyCharset();
});
modeSelect.addEventListener('change', () => { state.colorMode = +modeSelect.value; });
invertInput.addEventListener('change', () => { state.invert = invertInput.checked; });
const presetSelect = document.getElementById('preset');
presetSelect.addEventListener('change', () => {
  if (PRESETS[presetSelect.value]) {
    state.charset = PRESETS[presetSelect.value];
    charsetInput.value = state.charset;
    applyCharset();
  }
});
const textPassInput = document.getElementById('textpass');
textPassInput.addEventListener('change', () => { state.textPass = textPassInput.checked; });
zoomInput.addEventListener('change', () => {
  outCanvas.classList.toggle('zoom2x', zoomInput.checked);
});
outCanvas.classList.toggle('zoom2x', zoomInput.checked);

// easter egg: the M key toggles Matrix rain. Match by physical code OR by the
// letter (m / Russian ь on the same key) — on-screen keyboards, remote desktops
// and synthesized input often ship an empty e.code
addEventListener('keydown', (e) => {
  const isM = e.code === 'KeyM' || /^[mь]$/i.test(e.key || '');
  if (!isM || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  state.matrix = !state.matrix;
});

// --- draggable 100x100 source frame ---
function placeFrame() {
  frame.style.left = state.crop.x + 'px';
  frame.style.top = state.crop.y + 'px';
  frame.style.width = state.crop.w + 'px';
  frame.style.height = state.crop.h + 'px';
}
let drag = null;
frame.addEventListener('pointerdown', (e) => {
  drag = { dx: e.clientX - state.crop.x, dy: e.clientY - state.crop.y };
  frame.setPointerCapture(e.pointerId);
});
frame.addEventListener('pointermove', (e) => {
  if (!drag) return;
  state.crop.x = Math.max(0, Math.min(sceneCanvas.width - state.crop.w, e.clientX - drag.dx));
  state.crop.y = Math.max(0, Math.min(sceneCanvas.height - state.crop.h, e.clientY - drag.dy));
  placeFrame();
});
frame.addEventListener('pointerup', () => { drag = null; });
placeFrame();

// --- main loop ---
function renderFrame(t) {
  scene.draw(t);
  if (state.textPass) paintTextLayer(textCtx, scene.textItems, state.crop);
  renderer.render(sceneCanvas, sceneCanvas.width, sceneCanvas.height, state.crop, {
    colorMode: state.colorMode,
    invert: state.invert,
    ink: [0.55, 1.0, 0.55],
    bg: [0.02, 0.045, 0.02],
    textLayer: state.textPass ? textCanvas : null,
    matrix: state.matrix,
    time: t / 1000,
  });
}

let last = performance.now(), emaMs = 16.7, emaJs = 0.3;
function tick(t) {
  const frameMs = t - last;
  last = t;
  emaMs = emaMs * 0.92 + frameMs * 0.08;

  const t0 = performance.now();
  renderFrame(t);
  const jsMs = performance.now() - t0;
  emaJs = emaJs * 0.95 + jsMs * 0.05;

  fpsEl.textContent = `${(1000 / emaMs).toFixed(1)} fps · js ${emaJs.toFixed(2)} ms`;
  requestAnimationFrame(tick);
}

applyCharset();
requestAnimationFrame(tick);

// Test hook: drive one frame manually and read back output pixels. Lets automated
// checks verify the pipeline even when the tab isn't compositing (rAF paused).
window.__ascii = {
  state, renderer,
  renderOnce(t = 1234) {
    renderFrame(t);
    const gl = renderer.gl;
    const w = outCanvas.width, h = outCanvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0, sum = 0;
    const rows = new Set();
    for (let i = 0; i < w * h; i++) {
      const g = px[i * 4 + 1];
      sum += g;
      if (g > 60) { lit++; rows.add(Math.floor(i / w)); }
    }
    return {
      size: [w, h], litPixels: lit, litFrac: +(lit / (w * h)).toFixed(3),
      meanGreen: +(sum / (w * h)).toFixed(1), rowsWithInk: rows.size,
      glyphs: renderer.charsSorted, cells: Math.floor(w / state.cell),
    };
  },
};

// ASCII Shader — content-script main. Runs INSIDE the target page (any origin):
// - capture: getDisplayMedia(preferCurrentTab) or tabCapture streamId (promptless
//   experiment), restricted to <body> via Element Capture so the overlay (a sibling
//   of body inside <html>) never enters the stream — no feedback loop
// - input: never intercepted at all — the overlay is pointer-events:none, the page
//   receives real trusted events; we only listen to mirror the cursor in ASCII
// - text rotoscope: extractTextItems(document) — this page's own DOM, any language
// The build script concatenates ascii/presets/textlayer/domtext/cursor before this
// file inside one IIFE; imports below exist for editors and are stripped at build.
import { AsciiRenderer } from '../../proto/ascii.js';
import { PRESETS } from '../../proto/presets.js';
import { paintTextLayer } from '../../proto/textlayer.js';
import { extractTextItems } from '../../proto/domtext.js';
import { CursorLayer } from '../../proto/cursor.js';
import { buildCharGrid } from '../../proto/textgrid.js';

if (window.__asciiShader) {
  window.__asciiShader.togglePanel();
} else {
  const state = {
    running: false, mode: 'idle',            // 'overlay' | 'monitor'
    cell: 8, charset: PRESETS.ascii10, colorMode: 0, invert: false,
    textPass: true, cursorOn: true, hideNative: false, textMode: false,
    align: 'auto',                           // 'auto' | 'page' | 'viewport'
    debug: false,
    matrix: false,                           // easter egg: Matrix rain, M key
    matrixDrops: 3, matrixSpeed: 1,          // rain density/speed (panel selects)
  };
  const VERSION = '0.2.7';
  const isExt = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  const cursor = new CursorLayer();
  let stream = null, domItems = null, domTimer = 0, scrollTimer = 0;
  let renderer = null, emaMs = 16.7, last = performance.now();
  let targetEl = null;   // element the track is restricted to (usually <body>)
  let cropDebug = null;  // last alignment decision, for the debug readout

  // Element Capture frames cover the restricted element's PAINTED bounds — which,
  // depending on the page, may be its border box, the box plus layout overflow
  // (wide images, absolutely-positioned children), or effectively the viewport.
  // Guess which coordinate space the frame is in by matching its aspect ratio
  // against the candidates, then cut the currently visible window out of it so
  // mosaic coords always match DOM/viewport coords. `align` overrides the guess.
  function computeCrop(tr, scrollW, scrollH, vw, vh, iw, ih, align) {
    const full = { x: 0, y: 0, w: vw, h: vh };
    if (!tr || !tr.width || !tr.height || align === 'viewport') return full;
    const cands = [
      { name: 'box', w: tr.width, h: tr.height },
      { name: 'scroll', w: Math.max(tr.width, scrollW || 0), h: Math.max(tr.height, scrollH || 0) },
    ];
    const va = vw / vh;
    let best = cands[0], bestErr = Infinity;
    for (const c of cands) {
      const err = Math.abs(va - c.w / c.h) / va;
      if (err < bestErr) { bestErr = err; best = c; }
    }
    cropDebug = { vw, vh, box: `${Math.round(tr.width)}×${Math.round(tr.height)}@${Math.round(tr.top)}`,
      scroll: `${scrollW}×${scrollH}`, win: `${iw}×${ih}`, pick: best.name, err: +bestErr.toFixed(3) };
    if (align !== 'page' && bestErr > 0.06) {
      // frame aspect matches neither page-space candidate → frames are viewport-mapped
      cropDebug.pick = 'viewport-fallback';
      return full;
    }
    const kx = vw / best.w, ky = vh / best.h;
    let x = Math.max(0, Math.min(-tr.left * kx, vw - 2));
    let y = Math.max(0, Math.min(-tr.top * ky, vh - 2));
    return { x, y, w: Math.min(iw * kx, vw - x), h: Math.min(ih * ky, vh - y) };
  }

  function overlayCropRect() {
    if (state.mode === 'overlay' && targetEl) {
      return computeCrop(targetEl.getBoundingClientRect(),
        targetEl.scrollWidth, targetEl.scrollHeight,
        video.videoWidth, video.videoHeight, innerWidth, innerHeight, state.align);
    }
    return { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  }

  // ---------- DOM nodes (all outside <body> so restrictTo(body) excludes them) ----------
  const root = document.documentElement;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;' +
    'pointer-events:none;z-index:2147483646;display:none;background:#000;';
  root.appendChild(canvas);

  const textCanvas = document.createElement('canvas');
  const textCtx = textCanvas.getContext('2d');

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;' +
    'background:#15151cee;color:#ddd;border:1px solid #3a3a45;border-radius:8px;' +
    'padding:10px;font:12px Consolas,monospace;width:250px;pointer-events:auto;' +
    'box-shadow:0 4px 16px #000a;';
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b style="color:#8df59a">ASCII·Shader <span style="opacity:.55;font-weight:normal">v__VER__</span></b>
      <span data-k="fps" style="color:#7fe08a"></span>
    </div>
    <div data-k="st" style="color:#8a8;margin-bottom:8px;line-height:1.4">…</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button data-k="start" style="flex:1">▶ Старт</button>
      <button data-k="startq" style="flex:1">▶ без диалога</button>
      <button data-k="stopb">■</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
      <select data-k="preset" style="flex:1">
        <option value="ascii10">ASCII 10</option><option value="ascii70">ASCII 70</option>
        <option value="cyrillic">Кириллица</option><option value="japanese">Японский 日本</option><option value="blocks">Blocks</option>
      </select>
      <select data-k="mode"><option value="0">mono</option><option value="1">color</option></select>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
      <span>cell <b data-k="cellv">8</b></span>
      <input data-k="cell" type="range" min="4" max="16" value="8" style="flex:1">
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <label><input data-k="invert" type="checkbox"> inv</label>
      <label><input data-k="text" type="checkbox" checked> текст</label>
      <label><input data-k="cur" type="checkbox" checked> курсор</label>
      <label><input data-k="hidecur" type="checkbox"> скрыть сист.</label>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
      <label title="кадр замирает и становится выделяемым текстом; страница отключена; Esc — выход">
        <input data-k="textmode" type="checkbox"> режим текста</label>
      <button data-k="copyall" title="скопировать весь кадр как символы">📋 всё</button>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
      <select data-k="align" title="если текст едет относительно мозаики — попробуй переключить">
        <option value="auto">выравнивание: авто</option>
        <option value="page">страница</option>
        <option value="viewport">вьюпорт</option>
      </select>
      <label><input data-k="debug" type="checkbox"> debug</label>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
      <label title="пасхалка: клавиша M"><input data-k="mtx" type="checkbox"> матрица</label>
      <select data-k="mtxd" title="плотность дождя" style="flex:1">
        <option value="1">редкий</option><option value="2">обычный</option>
        <option value="3" selected>плотный</option><option value="4">ливень</option>
      </select>
      <select data-k="mtxs" title="скорость падения" style="flex:1">
        <option value="0.5">медленно</option><option value="1" selected>обычно</option>
        <option value="1.6">быстро</option>
      </select>
    </div>`;
  panel.innerHTML = panel.innerHTML.replace('__VER__', VERSION);
  root.appendChild(panel);
  const $ = (k) => panel.querySelector(`[data-k="${k}"]`);
  panel.querySelectorAll('button,select').forEach((el) => {
    el.style.cssText += 'background:#23232c;color:#ddd;border:1px solid #3a3a45;border-radius:4px;padding:4px 6px;cursor:pointer;';
  });
  const setStatus = (s) => { $('st').textContent = s; };

  // ---------- capture ----------
  function pickTarget() {
    const br = document.body.getBoundingClientRect();
    if (br.width >= innerWidth * 0.9 && br.height >= innerHeight * 0.9) return document.body;
    // rare SPA case: body collapsed — wrap its children so the box covers the page
    let wrap = document.getElementById('__ascii_wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = '__ascii_wrap';
      while (document.body.firstChild) wrap.appendChild(document.body.firstChild);
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  async function start(promptless) {
    if (state.running) stop(false, true);
    try {
      if (promptless) {
        if (!isExt) throw new Error('доступно только внутри расширения');
        const resp = await chrome.runtime.sendMessage({ cmd: 'streamId' });
        if (!resp || !resp.id) throw new Error((resp && resp.err) || 'streamId недоступен');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.id } },
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 60 } }, audio: false, preferCurrentTab: true,
        });
      }
    } catch (e) {
      setStatus('захват не удался: ' + (e.message || e.name));
      return false;
    }
    const [track] = stream.getVideoTracks();
    const target = pickTarget();
    targetEl = target;
    target.style.isolation = 'isolate';
    state.mode = 'monitor';
    if (typeof RestrictionTarget !== 'undefined' && track.restrictTo) {
      try {
        await track.restrictTo(await RestrictionTarget.fromElement(target));
        state.mode = 'overlay';
      } catch (e) { console.warn('[ascii-shader] restrictTo:', e); }
    }
    if (state.mode !== 'overlay' && typeof CropTarget !== 'undefined' && track.cropTo) {
      try { await track.cropTo(await CropTarget.fromElement(target)); } catch (e) {}
    }
    track.addEventListener('ended', () => stop(true));
    video.srcObject = stream;
    await video.play();
    state.running = true;
    layout();
    applyHideNative();
    startDomWatch();
    setStatus(state.mode === 'overlay'
      ? `оверлей поверх страницы${promptless ? ' · без диалога' : ''} · ввод нативный`
      : 'restrictTo недоступен → монитор в углу (страница видна как есть)');
    return true;
  }

  // one-click-less chain for auto-enabled tabs: try tabCapture first, then ask
  async function autoStart() {
    if (state.running) return;
    if (isExt && await start(true)) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    setStatus((($('st').textContent || '') + ' · автозапуск без диалога не прошёл — нажми ▶ Старт').trim());
  }

  // ---------- text mode: the frozen frame as selectable raw characters ----------
  let pre = null, lastGrid = null;

  function currentGrid() {
    if (!state.running || video.readyState < 2 || !video.videoWidth) return null;
    const s = scales();
    return buildCharGrid(video, overlayCropRect(),
      state.cell, state.cell, canvas.width, canvas.height,
      renderer ? renderer.charsSorted : state.charset, {
        invert: state.invert,
        items: state.textPass ? domItems : null,
        scaleX: s.x, scaleY: s.y,
      });
  }

  function enterTextMode() {
    const grid = currentGrid();
    if (!grid) { $('textmode').checked = false; setStatus('режим текста: сначала запусти захват'); return; }
    lastGrid = grid;
    state.textMode = true;
    const r = canvas.getBoundingClientRect();
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `${state.cell}px Consolas, monospace`;
    const adv = meas.measureText('M').width || state.cell * 0.55;
    pre = document.createElement('pre');
    pre.id = '__ascii_pre';
    pre.textContent = grid.join('\n');
    pre.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
      `margin:0;overflow:hidden;white-space:pre;background:#050b05;color:#8df59a;` +
      `font:${state.cell}px/${state.cell}px Consolas,monospace;letter-spacing:${(state.cell - adv).toFixed(2)}px;` +
      'z-index:2147483646;pointer-events:auto;user-select:text;cursor:text;';
    const sel = document.createElement('style');
    sel.textContent = '#__ascii_pre::selection{background:#2f5c39;color:#fff}';
    pre.appendChild(sel);
    root.appendChild(pre);
    canvas.style.visibility = 'hidden';
    setStatus('режим текста: кадр заморожен, выделяй и копируй · Esc — выход');
  }

  function exitTextMode() {
    state.textMode = false;
    if (pre) { pre.remove(); pre = null; }
    canvas.style.visibility = '';
    if (state.running) setStatus('оверлей · живой рендер продолжен');
  }

  async function copyAll() {
    const grid = state.textMode ? lastGrid : currentGrid();
    if (!grid) { setStatus('копировать нечего — захват не запущен'); return; }
    const text = grid.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`скопировано: ${grid.length} строк × ${grid[0].length} символов`);
    } catch (e) {
      setStatus('clipboard не дался: ' + (e.message || e.name));
    }
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.textMode) {
      $('textmode').checked = false;
      exitTextMode();
    }
    // easter egg: the M key toggles Matrix rain while the filter runs (physical
    // code OR letter m/ь — OSK/remote input often has empty e.code); never
    // fires from inputs or with modifiers held
    if ((e.code === 'KeyM' || /^[mь]$/i.test(e.key || '')) &&
        !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && state.running) {
      const t = e.target;
      if (!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) {
        state.matrix = !state.matrix;
        const cb = $('mtx');
        if (cb) cb.checked = state.matrix;
      }
    }
  }, { capture: true });

  function stop(byTrack, internal) {
    if (state.textMode) { const cb = $('textmode'); if (cb) cb.checked = false; exitTextMode(); }
    state.running = false;
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    video.srcObject = null;
    canvas.style.display = 'none';
    clearInterval(domTimer);
    domItems = null;
    root.style.cursor = '';
    if (internal) return;
    panel.style.display = '';
    setStatus(byTrack ? 'шаринг остановлен со стороны браузера' : 'остановлено');
  }

  // ---------- layout / render ----------
  function layout() {
    if (!state.running) return;
    if (state.mode === 'overlay') {
      canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;' +
        'pointer-events:none;z-index:2147483646;background:#000;';
      canvas.width = innerWidth;
      canvas.height = innerHeight;
    } else {
      const w = Math.round(innerWidth * 0.45);
      const h = Math.round(w * (video.videoHeight || 9 * 40) / (video.videoWidth || 16 * 40));
      canvas.style.cssText = 'position:fixed;inset:auto;right:10px;bottom:10px;display:block;' +
        `width:${w}px;height:${h}px;pointer-events:none;z-index:2147483646;background:#000;` +
        'border:1px solid #3a3a45;border-radius:6px;';
      canvas.width = w;
      canvas.height = h;
    }
    textCanvas.width = canvas.width;
    textCanvas.height = canvas.height;
    if (!renderer) renderer = new AsciiRenderer(canvas);
    renderer.setCharset(state.charset, state.cell, state.cell);
  }
  addEventListener('resize', layout, { passive: true });

  function scales() {
    return state.mode === 'overlay'
      ? { x: 1, y: 1 }
      : { x: canvas.width / innerWidth, y: canvas.height / innerHeight };
  }

  function tick(t) {
    emaMs = emaMs * 0.92 + (t - last) * 0.08;
    last = t;
    if (state.running && !state.textMode && video.readyState >= 2 && video.videoWidth) {
      const s = scales();
      const items = state.textPass ? domItems : null;
      const useCursor = state.cursorOn && cursor.active;
      const layerOn = !!items || useCursor;
      if (layerOn) {
        if (items) paintTextLayer(textCtx, items, { x: 0, y: 0 }, { scaleX: s.x, scaleY: s.y });
        else textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
        if (useCursor) cursor.draw(textCtx, state.cell, t);
      }
      renderer.render(video, video.videoWidth, video.videoHeight, overlayCropRect(), {
        colorMode: state.colorMode, invert: state.invert,
        ink: [0.55, 1.0, 0.55], bg: [0.02, 0.045, 0.02],
        textLayer: layerOn ? textCanvas : null,
        matrix: state.matrix, time: t / 1000,
        matrixDrops: state.matrixDrops, matrixSpeed: state.matrixSpeed,
      });
      $('fps').textContent = `${(1000 / emaMs).toFixed(0)} fps`;
      if (state.debug && cropDebug && (t - (tick._dbgT || 0)) > 500) {
        tick._dbgT = t;
        setStatus(`dbg v:${cropDebug.vw}×${cropDebug.vh} body:${cropDebug.box} ` +
          `scroll:${cropDebug.scroll} win:${cropDebug.win} dpr:${devicePixelRatio} ` +
          `pick:${cropDebug.pick} err:${cropDebug.err} align:${state.align} mode:${state.mode}`);
      }
    }
    requestAnimationFrame(tick);
  }

  // ---------- text rotoscope ----------
  function refreshDom() { domItems = extractTextItems(document); }
  function startDomWatch() {
    refreshDom();
    clearInterval(domTimer);
    domTimer = setInterval(() => { if (state.running) refreshDom(); }, 700);
  }
  addEventListener('scroll', () => {
    if (!state.running) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(refreshDom, 120);
  }, { passive: true, capture: true });

  // ---------- cursor mirror (listeners only — input itself stays native) ----------
  function resolveCursor(el) {
    try {
      const cs = getComputedStyle(el).cursor;
      if (cs && cs !== 'auto') return cs;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'text';
      if (el.closest && el.closest('a, button, [role=button], summary, label')) return 'pointer';
      return 'default';
    } catch { return 'default'; }
  }
  addEventListener('mousemove', (e) => {
    const s = scales();
    cursor.update({ x: e.clientX * s.x, y: e.clientY * s.y, css: resolveCursor(e.target) });
  }, { passive: true, capture: true });
  addEventListener('mousedown', (e) => {
    const s = scales();
    cursor.press(e.clientX * s.x, e.clientY * s.y);
  }, { passive: true, capture: true });
  addEventListener('mouseup', () => cursor.release(), { passive: true, capture: true });
  root.addEventListener('mouseleave', () => cursor.leave(), { passive: true });

  function applyHideNative() {
    root.style.cursor = (state.running && state.hideNative && state.mode === 'overlay') ? 'none' : '';
  }

  // ---------- controls ----------
  $('start').addEventListener('click', () => start(false));
  $('startq').addEventListener('click', () => start(true));
  if (!isExt) { $('startq').disabled = true; $('startq').title = 'только внутри расширения'; }
  $('stopb').addEventListener('click', () => {
    stop(false);
    if (isExt) chrome.runtime.sendMessage({ cmd: 'disable' }).catch(() => {});
  });
  $('preset').addEventListener('change', (e) => {
    state.charset = PRESETS[e.target.value] || PRESETS.ascii10;
    if (renderer) renderer.setCharset(state.charset, state.cell, state.cell);
  });
  $('mode').addEventListener('change', (e) => { state.colorMode = +e.target.value; });
  $('cell').addEventListener('input', (e) => {
    state.cell = +e.target.value;
    $('cellv').textContent = state.cell;
    if (renderer) renderer.setCharset(state.charset, state.cell, state.cell);
  });
  $('invert').addEventListener('change', (e) => { state.invert = e.target.checked; });
  $('text').addEventListener('change', (e) => { state.textPass = e.target.checked; });
  $('cur').addEventListener('change', (e) => { state.cursorOn = e.target.checked; });
  $('hidecur').addEventListener('change', (e) => { state.hideNative = e.target.checked; applyHideNative(); });
  $('textmode').addEventListener('change', (e) => { e.target.checked ? enterTextMode() : exitTextMode(); });
  $('copyall').addEventListener('click', copyAll);
  $('align').addEventListener('change', (e) => { state.align = e.target.value; });
  $('debug').addEventListener('change', (e) => { state.debug = e.target.checked; if (!state.debug) setStatus(''); });
  $('mtx').addEventListener('change', (e) => { state.matrix = e.target.checked; });
  $('mtxd').addEventListener('change', (e) => { state.matrixDrops = +e.target.value; });
  $('mtxs').addEventListener('change', (e) => { state.matrixSpeed = +e.target.value; });

  if (isExt) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.cmd === 'autostart') autoStart();
      if (msg.cmd === 'stopcmd') stop(false);
    });
  }

  window.__asciiShader = {
    togglePanel() { panel.style.display = panel.style.display === 'none' ? '' : 'none'; },
    stop, state, cursor, autoStart, computeCrop,
    probe() {
      return {
        restrictTo: typeof RestrictionTarget !== 'undefined',
        cropTo: typeof CropTarget !== 'undefined',
        getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
        isExt,
        textItems: extractTextItems(document).length,
      };
    },
  };

  const p = window.__asciiShader.probe();
  setStatus(`готов · текст: ${p.textItems} эл. · restrictTo: ${p.restrictTo ? 'да' : 'нет'}` +
    (isExt ? '' : ' · режим теста (без chrome.*)'));
  requestAnimationFrame(tick);
}

// ASCII Shader Desktop — Electron main process.
// A frameless, always-on-top, CLICK-THROUGH overlay covers the primary display and
// renders the screen behind it as ASCII. setContentProtection(true) sets
// WDA_EXCLUDEFROMCAPTURE so the overlay never appears in its own capture — no
// feedback loop (the ShaderGlass trick). Input is untouched: the window ignores
// mouse events and is not focusable, so everything goes to the apps beneath.
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, session, desktopCapturer, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Chromium's occlusion tracker marks fully-covered windows as occluded and stops
// painting them — a fullscreen app over the overlay would freeze the filter even
// with the z-order won back. Must be set before app ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// disable-direct-composition is a diagnostics-only flag: it makes content
// protection stick BUT layered (click-through) windows stop compositing at all —
// the overlay window is "shown" yet paints zero pixels on screen (field-proven).
// The shipping fix for self-capture is call ORDER instead: setContentProtection
// runs immediately after BrowserWindow creation, BEFORE setIgnoreMouseEvents adds
// WS_EX_LAYERED (a layered style blocks SetWindowDisplayAffinity from succeeding).
if (process.env.ASCII_NO_DCOMP) app.commandLine.appendSwitch('disable-direct-composition');
if (process.env.ASCII_SOFT) app.disableHardwareAcceleration();

const SELFTEST = process.argv.includes('--selftest');
// --probe: real fullscreen run that after ~2s dumps evidence to disk and quits:
// probe.json (stats), probe.png (ASCII output), probe-video.png (the RAW captured
// frame — the ground truth for "what does the capture actually see")
const PROBE = process.argv.includes('--probe');
// --ocrtest: small inactive window, full-res canvas; waits for the first OCR
// pass, dumps ocrtest.json + ocrtest.png (composited mosaic + text), quits
const OCRTEST = process.argv.includes('--ocrtest');
const WINDOWED = SELFTEST || OCRTEST || process.argv.includes('--windowed');
// The app STARTS in a normal framed window (guaranteed visible) and toggles to
// the fullscreen click-through overlay with F11. --overlay starts in overlay mode.
let overlayMode = PROBE || process.argv.includes('--overlay');

let win = null;
let tray = null;
let display = null;
let filterOn = true;
let topGuard = null;
let guardPausedUntil = 0; // while our tray menu is open the guard must not cover it
let shownOnce = false;

// field debugging: tray-only starts and crashes leave no trace otherwise
function logLine(s) {
  try { fs.appendFileSync(path.join(__dirname, 'debug.log'), `[${new Date().toISOString()}] ${s}\n`); }
  catch { /* logging must never kill the app */ }
}

// Direct Win32 capture exclusion. Electron's setContentProtection works for
// normal windows but silently fails once the window is the click-through overlay
// (WS_EX_LAYERED; measured: affinity stays 0 regardless of call order). The OS
// itself allows LAYERED + WDA_EXCLUDEFROMCAPTURE (ShaderGlass ships exactly
// that), so we set the affinity ourselves through user32.
let winapi = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  winapi = {
    RECT,
    setAffinity: user32.func('bool SetWindowDisplayAffinity(uint64 hwnd, uint32 affinity)'),
    getAffinity: user32.func('bool GetWindowDisplayAffinity(uint64 hwnd, _Out_ uint32* affinity)'),
    lastError: kernel32.func('uint32 GetLastError()'),
    // window-attachment support: enumerate the z-chain, track and own the target
    getTopWindow: user32.func('uint64 GetTopWindow(uint64 hwnd)'),
    getWindow: user32.func('uint64 GetWindow(uint64 hwnd, uint32 cmd)'),
    isWindowVisible: user32.func('bool IsWindowVisible(uint64 hwnd)'),
    isWindow: user32.func('bool IsWindow(uint64 hwnd)'),
    isIconic: user32.func('bool IsIconic(uint64 hwnd)'),
    getWindowText: user32.func('int GetWindowTextW(uint64 hwnd, _Out_ void* buf, int max)'),
    getWindowPid: user32.func('uint32 GetWindowThreadProcessId(uint64 hwnd, _Out_ uint32* pid)'),
    getExStyle: user32.func('int64 GetWindowLongPtrW(uint64 hwnd, int idx)'),
    setLongPtr: user32.func('int64 SetWindowLongPtrW(uint64 hwnd, int idx, int64 value)'),
    getForeground: user32.func('uint64 GetForegroundWindow()'),
    dwmAttr: dwmapi.func('int32 DwmGetWindowAttribute(uint64 hwnd, uint32 attr, _Out_ RECT* out, uint32 size)'),
    dwmAttrU32: dwmapi.func('int32 DwmGetWindowAttribute(uint64 hwnd, uint32 attr, _Out_ uint32* out, uint32 size)'),
  };
} catch (e) { logLine('koffi unavailable, content protection limited: ' + (e && e.message)); }

// visible on-screen bounds of a window (DWM extended frame — no shadow padding),
// in physical px; null if unavailable
function targetRectPx(hwnd) {
  if (!winapi || !hwnd) return null;
  const r = {};
  if (winapi.dwmAttr(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, r, 16) !== 0) return null;
  const w = r.right - r.left, h = r.bottom - r.top;
  if (w < 2 || h < 2) return null;
  return { x: r.left, y: r.top, width: w, height: h };
}

// top-level candidates for attachment: visible, titled, not ours, not cloaked
function listAttachTargets() {
  const out = [];
  if (!winapi) return out;
  let h = winapi.getTopWindow(0n);
  let hops = 0;
  while (h && h !== 0n && hops++ < 800 && out.length < 14) {
    const next = winapi.getWindow(h, 2 /* GW_HWNDNEXT */);
    try {
      if (winapi.isWindowVisible(h) && !winapi.isIconic(h)) {
        const ex = winapi.getExStyle(h, -20);
        const pidOut = [0];
        winapi.getWindowPid(h, pidOut);
        const cloakedOut = [0];
        winapi.dwmAttrU32(h, 14 /* DWMWA_CLOAKED */, cloakedOut, 4);
        if (!(Number(ex) & 0x80 /* WS_EX_TOOLWINDOW */) && pidOut[0] !== process.pid && !cloakedOut[0]) {
          const buf = Buffer.alloc(512);
          const n = winapi.getWindowText(h, buf, 256);
          const title = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
          if (title.trim()) out.push({ hwnd: h, title: title.trim() });
        }
      }
    } catch { /* skip odd windows */ }
    h = next;
  }
  return out;
}

// one-shot diagnostic: try the affinity at a given moment, log verdict + error
function affinityProbe(w, tag) {
  if (!winapi || !w || w.isDestroyed()) return;
  const hwnd = hwndOf(w);
  if (!hwnd) { logLine(`aff@${tag}: no hwnd`); return; }
  const ok = winapi.setAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
  const err = ok ? 0 : winapi.lastError();
  const out = [0];
  winapi.getAffinity(hwnd, out);
  logLine(`aff@${tag}: set=${ok} err=${err} readback=${out[0]}`);
}

const WDA_EXCLUDEFROMCAPTURE = 0x11;

function hwndOf(w) {
  try { return w.getNativeWindowHandle().readBigUInt64LE(0); } catch { return null; }
}

// returns the affinity actually on the window afterwards (for logging/verify).
// Electron's setContentProtection is used ONLY for plain framed windows — on
// layered (click-through) windows it not only fails but can CLEAR an affinity
// the direct call already set; those windows rely purely on user32.
function applyCaptureExclusion(w) {
  if (process.env.ASCII_NO_PROTECT || !w || w.isDestroyed()) return -1;
  const layered = !WINDOWED && (overlayMode || attached);
  if (!layered && !winapi) w.setContentProtection(true);
  const hwnd = hwndOf(w);
  if (winapi && hwnd) {
    winapi.setAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    const out = [0];
    if (winapi.getAffinity(hwnd, out)) return out[0];
  }
  return -1;
}

const settings = {
  cell: 8,
  preset: 'ascii10',
  colorMode: 0,
  invert: false,
  cursorOn: true,
  exposure: true, // auto-exposure: dark scenes (night games) get lifted into the ramp
  bias: 1.0,      // manual brightness multiplier on top, Ctrl+Alt+←/→
  debug: false,   // on-screen diagnostics line, Ctrl+Alt+D
  ocrOn: true,    // text rotoscope via Windows OCR helper, Ctrl+Alt+T
  // easter egg: Matrix rain, Ctrl+Alt+M / tray. ASCII_MATRIX=1 starts with it
  // on — lets --selftest capture render evidence
  matrix: !!process.env.ASCII_MATRIX,
  matrixDrops: 3,     // drops per column, 1..4
  matrixSpeed: 1,     // fall speed multiplier
  matrixLen: 1,       // trail length multiplier
  matrixAmbient: 0.35, // base brightness of the normal mosaic under the rain
};

// --- multi-display: capture follows the window -------------------------------
// `display` is the display we CAPTURE (the media handler picks the source by
// display.id at request time) and the coordinate space for cursor/crop math.
// It must track wherever the window (or the attach target) actually is — a
// fixed getPrimaryDisplay() meant monitor 2 always showed monitor 1's pixels.
function syncDisplayTo(rect) {
  if (!rect) return;
  const d = screen.getDisplayMatching(rect);
  if (!d || (display && d.id === display.id)) return;
  display = d;
  logLine(`display switch -> id=${d.id} bounds=${JSON.stringify(d.bounds)}`);
  if (win && !win.isDestroyed()) win.webContents.send('recapture');
}

// --- OCR helper (ocr-helper.ps1, Windows.Media.Ocr) --------------------------
// Persistent child process; one request in flight: renderer sends a JPEG of the
// captured frame, we drop it in temp, send the path, get back one JSON line with
// per-word boxes. Desktop has no DOM — this is the rotoscope's text source.
let ocrProc = null;
let ocrBuf = '';
let ocrPending = null;
let ocrRestartDelay = 1000;
const ocrTmpPath = () => path.join(app.getPath('temp'), 'ascii-shader-ocr.jpg');

let quitting = false;
app.on('before-quit', () => { quitting = true; });

function startOcrHelper() {
  if (ocrProc || SELFTEST || PROBE || quitting) return;
  try {
    ocrProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ocr-helper.ps1')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) { logLine('ocr spawn failed: ' + (e && e.message)); ocrProc = null; return; }
  logLine('ocr helper started, pid=' + ocrProc.pid);
  ocrProc.stdout.setEncoding('utf8');
  ocrProc.stdout.on('data', (chunk) => {
    ocrBuf += chunk;
    let i;
    while ((i = ocrBuf.indexOf('\n')) >= 0) {
      const line = ocrBuf.slice(0, i).trim();
      ocrBuf = ocrBuf.slice(i + 1);
      if (!line || !ocrPending) continue;
      const p = ocrPending;
      ocrPending = null;
      clearTimeout(p.timer);
      ocrRestartDelay = 1000;
      try { p.resolve(JSON.parse(line)); } catch { p.resolve({ ok: false, error: 'bad json' }); }
    }
  });
  ocrProc.stderr.on('data', (d) => logLine('ocr stderr: ' + String(d).slice(0, 300)));
  ocrProc.on('exit', (code) => {
    logLine('ocr helper exited: ' + code);
    ocrProc = null;
    if (ocrPending) {
      const p = ocrPending;
      ocrPending = null;
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'helper died' });
    }
    setTimeout(startOcrHelper, ocrRestartDelay);
    ocrRestartDelay = Math.min(15000, ocrRestartDelay * 2);
  });
}

// --- attachment to a specific application window ------------------------------
// The filter becomes an OWNED window of the target (Win32 owner chain): Windows
// itself keeps an owned window directly above its owner in z-order, so the target
// can never be raised (windowed OR fullscreen) without the filter on top — no
// topmost war, no polling race. We still follow bounds/minimize/close by polling.
let attached = null;        // { hwnd: BigInt, title, lastRect }
let attachTimer = null;
let attachTicks = 0;

const viewNow = () => (WINDOWED || overlayMode) ? 'overlay' : (attached ? 'attached' : 'windowed');

function pushSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('settings', { ...settings, view: viewNow() });
}

function createWindow() {
  // keep the display chosen by the mode switch / move tracking; fall back to
  // primary only when unset or unplugged
  if (!display || !screen.getAllDisplays().some((d) => d.id === display.id)) {
    display = screen.getPrimaryDisplay();
  }
  const b = display.bounds;
  shownOnce = false;
  const opts = {
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // keep rAF alive when Chromium thinks we're covered
    },
  };
  if (WINDOWED) {
    Object.assign(opts, { frame: false, width: 520, height: 340, x: b.x + 60, y: b.y + 60, resizable: true });
    if (OCRTEST) Object.assign(opts, { x: b.x + b.width - 560, y: b.y + b.height - 400 });
  } else if (attached) {
    // frameless click-through window glued to the target's bounds; NOT topmost —
    // the Win32 owner chain keeps it right above the target, and windows that
    // cover the target correctly cover the filter too
    const px = targetRectPx(attached.hwnd);
    const r = px ? screen.screenToDipRect(null, px) : { x: b.x + 80, y: b.y + 80, width: 800, height: 500 };
    Object.assign(opts, {
      frame: false,
      x: r.x, y: r.y, width: r.width, height: r.height,
      resizable: true, movable: false, focusable: false, minimizable: false,
      skipTaskbar: true,
    });
  } else if (overlayMode) {
    // resizable:true at creation — Windows clamps non-resizable windows to the
    // work area (screen minus taskbar), leaving an unfiltered strip; we lock it
    // after forcing the true bounds in ensureShown
    Object.assign(opts, {
      frame: false,
      x: b.x, y: b.y, width: b.width, height: b.height,
      resizable: true, movable: false, focusable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: true,
    });
  } else {
    // windowed filter mode (the default): a normal framed window that ALWAYS
    // visibly appears; F11 switches to the fullscreen click-through overlay
    Object.assign(opts, {
      frame: true, title: 'ASCII Shader — F11 на весь экран',
      width: Math.min(1100, b.width - 120), height: Math.min(660, b.height - 120),
      x: b.x + 60, y: b.y + 60, resizable: true,
    });
  }
  win = new BrowserWindow(opts);
  const w = win;
  if (!WINDOWED && overlayMode) {
    affinityProbe(win, 'created');
    win.setAlwaysOnTop(true, 'screen-saver');
    affinityProbe(win, 'alwaysOnTop');
    win.setIgnoreMouseEvents(true);
    affinityProbe(win, 'ignoreMouse');
  }
  if (!WINDOWED && attached) {
    affinityProbe(win, 'att-created'); // pin the exclusion BEFORE any style changes
    win.setIgnoreMouseEvents(true);
    affinityProbe(win, 'att-ignoreMouse');
    // become an owned window of the target: z-order glued right above it
    const ours = hwndOf(win);
    if (winapi && ours) {
      winapi.setLongPtr(ours, -8 /* GWLP_HWNDPARENT */, BigInt(attached.hwnd));
      affinityProbe(win, 'att-owned');
      logLine(`attached to "${attached.title}" (owner chain set)`);
    }
  }
  // capture exclusion AFTER all style setup — the direct Win32 call sticks on
  // the final style combo; ASCII_NO_PROTECT=1 disables for render diagnostics
  applyCaptureExclusion(win);
  // absolute path: loadFile resolves relative paths against the app root, which
  // differs between dev (desktop/) and the packaged build (resources/app/)
  win.loadFile(path.join(__dirname, 'overlay.html'), { query: { mode: SELFTEST ? 'selftest' : (PROBE ? 'probe' : (OCRTEST ? 'ocrtest' : 'live')) } });
  // ready-to-show is NOT guaranteed (observed in the field: stalled first paint →
  // tray alive, window never shown). Show through every available path: the event,
  // a fallback timer, and the topmost guard; ensureShown is idempotent.
  win.once('ready-to-show', () => ensureShown('ready-to-show'));
  setTimeout(() => ensureShown('timer'), 1500);
  win.webContents.on('render-process-gone', (e, d) => {
    logLine('renderer gone: ' + JSON.stringify(d) + ' — reloading');
    if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => logLine(`did-fail-load ${code} ${desc} ${url}`));
  win.on('unresponsive', () => logLine('window unresponsive'));
  win.on('closed', () => { if (win === w) win = null; });
  // dragging the framed window onto another monitor must retarget the capture
  // (debounced: 'move' fires continuously during a drag); overlay windows never
  // move, attached mode syncs from attachTick instead
  if (!SELFTEST && !PROBE && !OCRTEST) {
    let moveSync = null;
    win.on('move', () => {
      if (overlayMode || attached) return;
      if (moveSync) clearTimeout(moveSync);
      moveSync = setTimeout(() => {
        moveSync = null;
        if (win && !win.isDestroyed() && !overlayMode && !attached) syncDisplayTo(win.getBounds());
      }, 250);
    });
  }
}

function ensureShown(via) {
  if (!win || win.isDestroyed() || shownOnce) return;
  shownOnce = true;
  if (!WINDOWED && overlayMode && !attached) {
    win.setBounds(display.bounds); // undo any work-area clamp: cover the taskbar row too
    win.setResizable(false);
  }
  if (OCRTEST || attached) win.showInactive(); else win.show(); // never steal the user's focus
  const aff = applyCaptureExclusion(win); // showing can reshuffle styles — re-pin and read back
  logLine(`window shown via ${via} (${viewNow()}); bounds=${JSON.stringify(win.getBounds())}; captureExclusion=${aff === 0x11 ? 'ON' : aff}`);
}

// Mode changes rebuild the window: frame/focusable are creation-only options in
// Electron. The renderer restarts its capture on load (promptless). New window is
// created BEFORE the old one dies so 'window-all-closed' never fires mid-switch.
function rebuildWindow() {
  logLine('mode switch -> ' + viewNow());
  const old = win;
  win = null;
  createWindow();
  if (old && !old.isDestroyed()) old.destroy();
  buildTray();
}

function setOverlayMode(on) {
  if (WINDOWED) return;
  if (attached) stopAttach(false);
  if (overlayMode === on && !attached) { buildTray(); return; }
  // F11 fullscreens onto the monitor the window is currently on (and back)
  if (win && !win.isDestroyed()) {
    const d = screen.getDisplayMatching(win.getBounds());
    if (d) display = d;
  }
  overlayMode = on;
  rebuildWindow();
}

function attachTo(target) {
  if (WINDOWED || !winapi) return;
  overlayMode = false;
  attached = { hwnd: target.hwnd, title: target.title, lastRect: null };
  settings.attachedTitle = target.title;
  // capture the monitor the TARGET lives on, before the first frame
  const px = targetRectPx(target.hwnd);
  if (px) {
    const d = screen.getDisplayMatching(screen.screenToDipRect(null, px));
    if (d) display = d;
  }
  rebuildWindow();
  attachTicks = 0;
  if (!attachTimer) attachTimer = setInterval(attachTick, 150);
}

function stopAttach(rebuild) {
  if (attachTimer) { clearInterval(attachTimer); attachTimer = null; }
  attached = null;
  delete settings.attachedTitle;
  if (rebuild) rebuildWindow();
}

function attachTick() {
  if (!attached || !win || win.isDestroyed()) return;
  if (!winapi.isWindow(attached.hwnd)) {
    logLine('attach target closed — back to windowed mode');
    stopAttach(true);
    return;
  }
  if (winapi.isIconic(attached.hwnd)) {           // target minimized → filter hides with it
    if (win.isVisible()) win.hide();
    return;
  }
  if (!win.isVisible() && filterOn) win.showInactive();
  const px = targetRectPx(attached.hwnd);
  if (px) {
    const dip = screen.screenToDipRect(null, px);
    const r = attached.lastRect;
    if (!r || r.x !== dip.x || r.y !== dip.y || r.width !== dip.width || r.height !== dip.height) {
      attached.lastRect = dip;
      win.setBounds(dip);
      syncDisplayTo(dip); // target dragged to another monitor -> recapture there
    }
  }
  // if the target is foreground its owner chain already keeps us above it, but a
  // nudge costs nothing and covers exotic self-raising apps
  if (winapi.getForeground() === attached.hwnd) win.moveTop();
  if (++attachTicks % 20 === 0) applyCaptureExclusion(win);
}

// Fullscreen apps put themselves into the topmost band; among topmost windows the
// LAST one to assert wins, so we re-assert on a timer. The window has
// WS_EX_NOACTIVATE (focusable:false) — a raise can never activate it, so focus
// and all input stay with the app underneath.
function assertTopmost() {
  if (!overlayMode || !win || win.isDestroyed() || !filterOn || Date.now() < guardPausedUntil) return;
  ensureShown('guard');
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  applyCaptureExclusion(win); // re-pin WDA_EXCLUDEFROMCAPTURE in case a style change cleared it
}

function toggleFilter() {
  if (!win) return;
  filterOn = !filterOn;
  filterOn ? (attached ? win.showInactive() : win.show()) : win.hide();
  logLine('filter -> ' + (filterOn ? 'on' : 'off'));
  buildTray();
}

function toggleMatrix() {
  settings.matrix = !settings.matrix;
  pushSettings();
  buildTray();
  logLine('matrix -> ' + (settings.matrix ? 'on' : 'off'));
}

// --- configurable global hotkeys ---------------------------------------------
// One registry for every action; bindings persist in userData/hotkeys.json and
// are editable in the «Горячие клавиши» window (tray). Field lesson: a global
// combo can be silently owned by ANOTHER app (register() just returns false),
// so failures surface both in debug.log and in the editor UI, and every combo
// is rebindable.
const HOTKEY_ACTIONS = [
  { id: 'toggle',    label: 'Фильтр вкл/выкл',        def: 'Control+Alt+A', run: () => toggleFilter() },
  { id: 'overlay',   label: 'На весь экран / в окно', def: 'F11',           run: () => setOverlayMode(!overlayMode) },
  { id: 'cellMinus', label: 'Ячейка мельче',          def: 'Control+Alt+Up',    run: () => setCell(-1) },
  { id: 'cellPlus',  label: 'Ячейка крупнее',         def: 'Control+Alt+Down',  run: () => setCell(1) },
  { id: 'brighter',  label: 'Ярче',                   def: 'Control+Alt+Right', run: () => setBias(1.25) },
  { id: 'darker',    label: 'Темнее',                 def: 'Control+Alt+Left',  run: () => setBias(0.8) },
  { id: 'ocr',       label: 'Текст поверх мозаики',   def: 'Control+Alt+T',
    run: () => { settings.ocrOn = !settings.ocrOn; pushSettings(); buildTray(); } },
  { id: 'debug',     label: 'Отладка',                def: 'Control+Alt+D',
    run: () => { settings.debug = !settings.debug; pushSettings(); buildTray(); } },
  { id: 'matrix',    label: 'Матрица (пасхалка)',     def: 'Control+Alt+M', run: () => toggleMatrix() },
  { id: 'quit',      label: 'Выход',                  def: 'Control+Alt+X', run: () => app.quit() },
];
const binds = {};          // id -> accelerator string
let hotkeyErrors = {};     // id -> error from the last registration pass
let hotkeysWin = null;
let hotkeysSuspended = false; // true while the editor captures a combo

const hotkeysPath = () => path.join(app.getPath('userData'), 'hotkeys.json');

function loadHotkeys() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(hotkeysPath(), 'utf8')); } catch { /* first run */ }
  for (const a of HOTKEY_ACTIONS) binds[a.id] = typeof saved[a.id] === 'string' && saved[a.id] ? saved[a.id] : a.def;
}

function saveHotkeys() {
  try { fs.writeFileSync(hotkeysPath(), JSON.stringify(binds, null, 2)); }
  catch (e) { logLine('hotkeys save failed: ' + e.message); }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = {};
  if (hotkeysSuspended) return; // editor is capturing — keys must reach its window
  for (const a of HOTKEY_ACTIONS) {
    const acc = binds[a.id];
    if (!acc) continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, a.run); }
    catch (e) { hotkeyErrors[a.id] = 'некорректная комбинация'; logLine(`hotkey INVALID: ${a.id} = ${acc} (${e.message})`); continue; }
    if (!ok) {
      hotkeyErrors[a.id] = 'занято другой программой';
      logLine(`hotkey REGISTER FAILED: ${a.id} = ${acc} (taken by another app?)`);
    }
  }
}

const prettyAccel = (acc) => String(acc || '')
  .replace(/Control/g, 'Ctrl').replace(/\bUp\b/, '↑').replace(/\bDown\b/, '↓')
  .replace(/\bLeft\b/, '←').replace(/\bRight\b/, '→');

function openHotkeysWindow() {
  if (hotkeysWin && !hotkeysWin.isDestroyed()) { hotkeysWin.show(); hotkeysWin.focus(); return; }
  // the overlay guard must not cover the editor; screen-saver level + paused
  // guard keeps the editor above the overlay (last asserter wins in the band)
  guardPausedUntil = Date.now() + 3600 * 1000;
  hotkeysWin = new BrowserWindow({
    width: 500, height: 620, resizable: false, minimizable: false, maximizable: false,
    title: 'Горячие клавиши — ASCII Shader', backgroundColor: '#0b100b',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  hotkeysWin.setMenuBarVisibility(false);
  hotkeysWin.setAlwaysOnTop(true, 'screen-saver');
  hotkeysWin.loadFile(path.join(__dirname, 'hotkeys.html'));
  hotkeysWin.on('closed', () => {
    hotkeysWin = null;
    hotkeysSuspended = false;
    registerHotkeys(); // capture may have been active when the window died
    guardPausedUntil = 0;
  });
  logLine('hotkeys editor opened');
}

function setCell(delta) {
  settings.cell = Math.max(4, Math.min(20, settings.cell + delta));
  pushSettings();
  buildTray();
}

function setBias(mul) {
  settings.bias = Math.max(0.25, Math.min(8, +(settings.bias * mul).toFixed(2)));
  pushSettings();
  buildTray();
}

function trayIcon() {
  // 16x16 blocky "A" drawn into a raw BGRA bitmap — no asset files needed
  const W = 16, H = 16;
  const buf = Buffer.alloc(W * H * 4);
  const A = [
    '................',
    '......####......',
    '.....##..##.....',
    '....##....##....',
    '....##....##....',
    '....########....',
    '....##....##....',
    '....##....##....',
    '................',
    '..##..##..##..##',
    '................',
    '##..##..##..##..',
    '................',
    '..##..##..##..##',
    '................',
    '................',
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (A[y][x] === '#') {
        buf[i] = 0x6a; buf[i + 1] = 0xe0; buf[i + 2] = 0x7f; buf[i + 3] = 0xff; // BGRA green
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: H });
}

function buildTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    // fallback pause in case menu-will-show doesn't fire for native tray popups
    tray.on('right-click', () => { guardPausedUntil = Date.now() + 8000; });
  }
  const presetItem = (label, value) => ({
    label, type: 'radio', checked: settings.preset === value,
    click: () => { settings.preset = value; pushSettings(); },
  });
  const hk = (id) => (binds[id] ? ` (${prettyAccel(binds[id])})` : '');
  const menu = Menu.buildFromTemplate([
    { label: `ASCII Shader — ${filterOn ? 'включён' : 'выключен'}`, enabled: false },
    { type: 'separator' },
    { label: (overlayMode ? 'Оконный режим' : 'На весь экран') + hk('overlay'),
      click: () => setOverlayMode(!overlayMode) },
    { label: 'Привязка к приложению', submenu: (() => {
        if (attached) return [
          { label: `Привязан: ${attached.title.slice(0, 42)}`, enabled: false },
          { label: 'Отвязать (в оконный режим)', click: () => stopAttach(true) },
        ];
        const targets = winapi ? listAttachTargets() : [];
        const items = targets.map((t) => ({
          label: t.title.length > 46 ? t.title.slice(0, 45) + '…' : t.title,
          click: () => attachTo(t),
        }));
        if (!items.length) items.push({ label: winapi ? '(подходящих окон нет)' : '(нет koffi)', enabled: false });
        items.push({ type: 'separator' }, { label: 'Обновить список', click: () => buildTray() });
        return items;
      })() },
    { label: (filterOn ? 'Выключить' : 'Включить') + hk('toggle'), click: toggleFilter },
    { type: 'separator' },
    { label: `Ячейка: ${settings.cell}px`, enabled: false },
    { label: 'Мельче' + hk('cellMinus'), click: () => setCell(-1) },
    { label: 'Крупнее' + hk('cellPlus'), click: () => setCell(1) },
    { type: 'separator' },
    presetItem('ASCII 10', 'ascii10'),
    presetItem('ASCII 70', 'ascii70'),
    presetItem('Кириллица', 'cyrillic'),
    presetItem('Японский 日本', 'japanese'),
    presetItem('Блоки ▁▂▃', 'blocks'),
    { type: 'separator' },
    { label: 'Цвет по ячейкам', type: 'checkbox', checked: settings.colorMode === 1,
      click: (m) => { settings.colorMode = m.checked ? 1 : 0; pushSettings(); } },
    { label: 'Инверсия', type: 'checkbox', checked: settings.invert,
      click: (m) => { settings.invert = m.checked; pushSettings(); } },
    { label: 'Матрица' + hk('matrix'), submenu: (() => {
        const opt = (label, field, value) => ({
          label, type: 'radio', checked: settings[field] === value,
          click: () => { settings[field] = value; pushSettings(); },
        });
        return [
          { label: 'Включена', type: 'checkbox', checked: !!settings.matrix,
            click: () => toggleMatrix() },
          { type: 'separator' },
          { label: 'Плотность', enabled: false },
          opt('Редкий дождь', 'matrixDrops', 1),
          opt('Обычный', 'matrixDrops', 2),
          opt('Плотный', 'matrixDrops', 3),
          opt('Ливень', 'matrixDrops', 4),
          { type: 'separator' },
          { label: 'Скорость', enabled: false },
          opt('Медленно', 'matrixSpeed', 0.5),
          opt('Обычно', 'matrixSpeed', 1),
          opt('Быстро', 'matrixSpeed', 1.6),
          { type: 'separator' },
          { label: 'Хвосты', enabled: false },
          opt('Короткие', 'matrixLen', 0.6),
          opt('Обычные', 'matrixLen', 1),
          opt('Длинные', 'matrixLen', 1.5),
          { type: 'separator' },
          { label: 'Яркость фоновой мозаики', enabled: false },
          opt('Выкл (только дождь)', 'matrixAmbient', 0),
          opt('Тусклая', 'matrixAmbient', 0.2),
          opt('Обычная', 'matrixAmbient', 0.35),
          opt('Яркая', 'matrixAmbient', 0.5),
        ];
      })() },
    { label: 'ASCII-курсор', type: 'checkbox', checked: settings.cursorOn,
      click: (m) => { settings.cursorOn = m.checked; pushSettings(); } },
    { type: 'separator' },
    { label: 'Авто-яркость (ночные сцены)', type: 'checkbox', checked: settings.exposure,
      click: (m) => { settings.exposure = m.checked; pushSettings(); } },
    { label: `Яркость: ×${settings.bias.toFixed(2)}`, enabled: false },
    { label: 'Ярче' + hk('brighter'), click: () => setBias(1.25) },
    { label: 'Темнее' + hk('darker'), click: () => setBias(0.8) },
    { label: 'Текст поверх мозаики' + hk('ocr'), type: 'checkbox', checked: settings.ocrOn,
      click: (m) => { settings.ocrOn = m.checked; pushSettings(); } },
    { label: 'Отладка' + hk('debug'), type: 'checkbox', checked: settings.debug,
      click: (m) => { settings.debug = m.checked; pushSettings(); } },
    { type: 'separator' },
    { label: 'Горячие клавиши…', click: openHotkeysWindow },
    { label: 'Выход' + hk('quit'), click: () => app.quit() },
  ]);
  menu.on('menu-will-show', () => { guardPausedUntil = Date.now() + 60000; });
  menu.on('menu-will-close', () => { guardPausedUntil = 0; });
  tray.setToolTip('ASCII Shader');
  tray.setContextMenu(menu);
}

app.whenReady().then(() => {
  // promptless capture: auto-pick the screen source for the CURRENT display, no
  // share dialog. display_id can be empty on some Windows setups — fall back to
  // matching by monitor index (Chromium enumerates screens in display order)
  // before the old first-source fallback, and log the pick for field diagnosis.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
      const target = sources.find((s) => String(s.display_id) === String(display.id))
        || sources[idx] || sources[0];
      logLine(`capture: display=${display.id} -> source "${target && target.name}" ` +
        `display_id=${target && target.display_id} (${sources.length} screens)`);
      callback(target ? { video: target } : {});
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  logLine(`start: mode=${SELFTEST ? 'selftest' : (PROBE ? 'probe' : 'live')} dcomp=${process.env.ASCII_NO_DCOMP ? 'off' : 'on'} soft=${process.env.ASCII_SOFT ? 1 : 0} protect=${process.env.ASCII_NO_PROTECT ? 'off' : 'on'} electron=${process.versions.electron}`);
  Menu.setApplicationMenu(null); // no default File/Edit bar in the framed window
  createWindow();
  // the guard starts here, NOT inside ready-to-show: it is also the rescue path
  // that shows the window when ready-to-show never fired
  if (!WINDOWED && !topGuard) topGuard = setInterval(assertTopmost, 500);

  // ASCII_ATTACH="substring" — auto-attach to the first window whose title
  // matches (used by automated tests; handy for power users too)
  if (process.env.ASCII_ATTACH && winapi && !WINDOWED && !SELFTEST && !PROBE) {
    setTimeout(() => {
      const needle = process.env.ASCII_ATTACH.toLowerCase();
      const t = listAttachTargets().find((x) => x.title.toLowerCase().includes(needle));
      if (t) attachTo(t);
      else logLine(`ASCII_ATTACH: no window matching "${process.env.ASCII_ATTACH}"`);
    }, 1200);
  }
  if (!SELFTEST && !PROBE) {
    loadHotkeys();
    registerHotkeys();
    buildTray();
    // ASCII_HOTKEYS=1 — open the bind editor right away (diagnostics/automation)
    if (process.env.ASCII_HOTKEYS) setTimeout(openHotkeysWindow, 2500);
  }

  ipcMain.handle('hotkeys:list', () => HOTKEY_ACTIONS.map((a) => ({
    id: a.id, label: a.label, accel: binds[a.id], pretty: prettyAccel(binds[a.id]),
    error: hotkeyErrors[a.id] || null,
  })));
  ipcMain.handle('hotkeys:set', (e, id, accel) => {
    const act = HOTKEY_ACTIONS.find((a) => a.id === id);
    if (!act || typeof accel !== 'string' || !accel) return { ok: false, error: 'некорректный запрос' };
    const clash = HOTKEY_ACTIONS.find((a) => a.id !== id && binds[a.id] === accel);
    if (clash) {
      hotkeysSuspended = false;
      registerHotkeys();
      return { ok: false, error: `уже используется: ${clash.label}` };
    }
    binds[id] = accel;
    hotkeysSuspended = false;
    registerHotkeys();
    saveHotkeys();
    buildTray();
    logLine(`hotkey set: ${id} = ${accel}` + (hotkeyErrors[id] ? ` (FAILED: ${hotkeyErrors[id]})` : ''));
    return { ok: !hotkeyErrors[id], error: hotkeyErrors[id] || null };
  });
  ipcMain.handle('hotkeys:reset', () => {
    for (const a of HOTKEY_ACTIONS) binds[a.id] = a.def;
    hotkeysSuspended = false;
    registerHotkeys();
    saveHotkeys();
    buildTray();
    logLine('hotkeys reset to defaults');
    return true;
  });
  ipcMain.on('hotkeys:capture', (e, on) => {
    hotkeysSuspended = !!on;
    registerHotkeys();
  });

  // fullscreen games may switch the display mode; refit the window and let the
  // renderer restart its capture (the old track often dies on a mode change)
  screen.on('display-metrics-changed', () => {
    if (WINDOWED || !win || win.isDestroyed()) return;
    // keep following the SAME display through mode changes; fall back to
    // primary only if it disappeared (unplugged)
    display = screen.getAllDisplays().find((d) => d.id === display.id) || screen.getPrimaryDisplay();
    if (overlayMode) win.setBounds(display.bounds);
    win.webContents.send('recapture');
  });

  ipcMain.handle('cursor', () => {
    const p = screen.getCursorScreenPoint();
    // rect = the screen region the renderer should crop to (DIPs): the window's
    // own content area in windowed "lens" mode, the target bounds when attached
    let rect = null;
    if (!WINDOWED && !overlayMode && win && !win.isDestroyed()) {
      rect = attached ? (attached.lastRect || null) : win.getContentBounds();
    }
    return {
      x: p.x - display.bounds.x,
      y: p.y - display.bounds.y,
      dpr: display.scaleFactor || 1,
      disp: display.bounds,
      rect,
    };
  });
  ipcMain.handle('settings', () => ({ ...settings, view: viewNow() }));

  ipcMain.handle('ocr', (e, jpeg) => {
    if (!ocrProc || ocrPending) return { ok: false, error: ocrProc ? 'busy' : 'unavailable' };
    try { fs.writeFileSync(ocrTmpPath(), Buffer.from(jpeg)); }
    catch (err) { return { ok: false, error: 'tmp write: ' + err.message }; }
    return new Promise((resolve) => {
      ocrPending = {
        resolve,
        timer: setTimeout(() => {
          if (ocrPending) { const p = ocrPending; ocrPending = null; p.resolve({ ok: false, error: 'timeout' }); }
        }, 4000),
      };
      ocrProc.stdin.write(ocrTmpPath() + '\n');
    });
  });
  startOcrHelper();
  const reportBase = PROBE ? 'probe' : (OCRTEST ? 'ocrtest' : 'selftest');
  ipcMain.on('selftest-report', (e, data) => {
    try {
      fs.writeFileSync(path.join(__dirname, reportBase + '.json'), JSON.stringify(data.stats, null, 2));
      if (data.png) {
        fs.writeFileSync(path.join(__dirname, reportBase + '.png'),
          Buffer.from(data.png.split(',')[1], 'base64'));
      }
      if (data.videoPng) {
        fs.writeFileSync(path.join(__dirname, reportBase + '-video.png'),
          Buffer.from(data.videoPng.split(',')[1], 'base64'));
      }
    } catch (err) { console.error('report write failed:', err); }
    app.quit();
  });

  if (SELFTEST || PROBE || OCRTEST) setTimeout(() => {
    try { fs.writeFileSync(path.join(__dirname, reportBase + '.json'), JSON.stringify({ error: 'timeout: no report in 25s' })); } catch {}
    app.quit();
  }, 25000);
});

app.on('child-process-gone', (e, d) => logLine('child process gone: ' + JSON.stringify(d)));

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (topGuard) clearInterval(topGuard);
  if (attachTimer) clearInterval(attachTimer);
  if (ocrProc) { try { ocrProc.kill(); } catch { /* already gone */ } }
});
app.on('window-all-closed', () => app.quit());

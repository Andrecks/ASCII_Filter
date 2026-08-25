// ASCII Shader Desktop — Electron main process.
// A frameless, always-on-top, CLICK-THROUGH overlay covers the primary display and
// renders the screen behind it as ASCII. setContentProtection(true) sets
// WDA_EXCLUDEFROMCAPTURE so the overlay never appears in its own capture — no
// feedback loop (the ShaderGlass trick). Input is untouched: the window ignores
// mouse events and is not focusable, so everything goes to the apps beneath.
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, session, desktopCapturer, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Chromium's occlusion tracker marks fully-covered windows as occluded and stops
// painting them — a fullscreen app over the overlay would freeze the filter even
// with the z-order won back. Must be set before app ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// SetWindowDisplayAffinity (content protection) FAILS on windows created with
// WS_EX_NOREDIRECTIONBITMAP, which Chromium uses when DirectComposition is on —
// the overlay then captures ITSELF (hall of mirrors → black screen; field bug
// found on ETS2, confirmed by --probe: affinity stayed 0, captured frame was our
// own glyph field). With DCOMP off the window gets a redirection surface, the
// flag sticks, and the capture sees the real screen. GPU rendering is unaffected
// (presentation path only; probe: 120 fps at 2560×1080).
// ASCII_KEEP_DCOMP=1 reverts the switch; ASCII_SOFT=1 forces software rendering.
if (!process.env.ASCII_KEEP_DCOMP) app.commandLine.appendSwitch('disable-direct-composition');
if (process.env.ASCII_SOFT) app.disableHardwareAcceleration();

const SELFTEST = process.argv.includes('--selftest');
// --probe: real fullscreen run that after ~2s dumps evidence to disk and quits:
// probe.json (stats), probe.png (ASCII output), probe-video.png (the RAW captured
// frame — the ground truth for "what does the capture actually see")
const PROBE = process.argv.includes('--probe');
const WINDOWED = SELFTEST || process.argv.includes('--windowed');

let win = null;
let tray = null;
let display = null;
let filterOn = true;
let topGuard = null;
let guardPausedUntil = 0; // while our tray menu is open the guard must not cover it

const settings = {
  cell: 8,
  preset: 'ascii10',
  colorMode: 0,
  invert: false,
  cursorOn: true,
  exposure: true, // auto-exposure: dark scenes (night games) get lifted into the ramp
  bias: 1.0,      // manual brightness multiplier on top, Ctrl+Alt+←/→
  debug: false,   // on-screen diagnostics line, Ctrl+Alt+D
};

function pushSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('settings', settings);
}

function createWindow() {
  display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const opts = {
    frame: false,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // keep rAF alive when Chromium thinks we're covered
    },
  };
  if (WINDOWED) {
    Object.assign(opts, { width: 520, height: 340, x: b.x + 60, y: b.y + 60, resizable: true });
  } else {
    // resizable:true at creation — Windows clamps non-resizable windows to the
    // work area (screen minus taskbar), leaving an unfiltered strip; we lock it
    // after forcing the true bounds in ready-to-show
    Object.assign(opts, {
      x: b.x, y: b.y, width: b.width, height: b.height,
      resizable: true, movable: false, focusable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: true,
    });
  }
  win = new BrowserWindow(opts);
  if (!WINDOWED) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
  }
  // exclude the overlay from screen capture (Win10 2004+): kills the feedback loop
  win.setContentProtection(true);
  win.loadFile('overlay.html', { query: { mode: SELFTEST ? 'selftest' : (PROBE ? 'probe' : 'live') } });
  win.once('ready-to-show', () => {
    if (!WINDOWED) {
      win.setBounds(display.bounds); // undo any work-area clamp: cover the taskbar row too
      win.setResizable(false);
    }
    win.show();
    if (!WINDOWED && !topGuard) topGuard = setInterval(assertTopmost, 500);
  });
  win.on('closed', () => { win = null; });
}

// Fullscreen apps put themselves into the topmost band; among topmost windows the
// LAST one to assert wins, so we re-assert on a timer. The window has
// WS_EX_NOACTIVATE (focusable:false) — a raise can never activate it, so focus
// and all input stay with the app underneath.
function assertTopmost() {
  if (!win || win.isDestroyed() || !filterOn || Date.now() < guardPausedUntil) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.setContentProtection(true); // re-assert WDA_EXCLUDEFROMCAPTURE — cheap, idempotent
}

function toggleFilter() {
  if (!win) return;
  filterOn = !filterOn;
  filterOn ? win.show() : win.hide();
  buildTray();
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
  const menu = Menu.buildFromTemplate([
    { label: `ASCII Shader — ${filterOn ? 'включён' : 'выключен'}`, enabled: false },
    { type: 'separator' },
    { label: filterOn ? 'Выключить (Ctrl+Alt+A)' : 'Включить (Ctrl+Alt+A)', click: toggleFilter },
    { type: 'separator' },
    { label: `Ячейка: ${settings.cell}px`, enabled: false },
    { label: 'Мельче (Ctrl+Alt+↑)', click: () => setCell(-1) },
    { label: 'Крупнее (Ctrl+Alt+↓)', click: () => setCell(1) },
    { type: 'separator' },
    presetItem('ASCII 10', 'ascii10'),
    presetItem('ASCII 70', 'ascii70'),
    presetItem('Кириллица', 'cyrillic'),
    presetItem('Блоки ▁▂▃', 'blocks'),
    { type: 'separator' },
    { label: 'Цвет по ячейкам', type: 'checkbox', checked: settings.colorMode === 1,
      click: (m) => { settings.colorMode = m.checked ? 1 : 0; pushSettings(); } },
    { label: 'Инверсия', type: 'checkbox', checked: settings.invert,
      click: (m) => { settings.invert = m.checked; pushSettings(); } },
    { label: 'ASCII-курсор', type: 'checkbox', checked: settings.cursorOn,
      click: (m) => { settings.cursorOn = m.checked; pushSettings(); } },
    { type: 'separator' },
    { label: 'Авто-яркость (ночные сцены)', type: 'checkbox', checked: settings.exposure,
      click: (m) => { settings.exposure = m.checked; pushSettings(); } },
    { label: `Яркость: ×${settings.bias.toFixed(2)}`, enabled: false },
    { label: 'Ярче (Ctrl+Alt+→)', click: () => setBias(1.25) },
    { label: 'Темнее (Ctrl+Alt+←)', click: () => setBias(0.8) },
    { label: 'Отладка (Ctrl+Alt+D)', type: 'checkbox', checked: settings.debug,
      click: (m) => { settings.debug = m.checked; pushSettings(); } },
    { type: 'separator' },
    { label: 'Выход (Ctrl+Alt+X)', click: () => app.quit() },
  ]);
  menu.on('menu-will-show', () => { guardPausedUntil = Date.now() + 60000; });
  menu.on('menu-will-close', () => { guardPausedUntil = 0; });
  tray.setToolTip('ASCII Shader');
  tray.setContextMenu(menu);
}

app.whenReady().then(() => {
  // promptless capture: auto-pick the screen source, no share dialog
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const target = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      callback(target ? { video: target } : {});
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  createWindow();
  if (!SELFTEST && !PROBE) {
    buildTray();
    globalShortcut.register('Control+Alt+A', toggleFilter);
    globalShortcut.register('Control+Alt+X', () => app.quit());
    globalShortcut.register('Control+Alt+Up', () => setCell(-1));
    globalShortcut.register('Control+Alt+Down', () => setCell(1));
    globalShortcut.register('Control+Alt+Right', () => setBias(1.25));
    globalShortcut.register('Control+Alt+Left', () => setBias(0.8));
    globalShortcut.register('Control+Alt+D', () => {
      settings.debug = !settings.debug; pushSettings(); buildTray();
    });
  }

  // fullscreen games may switch the display mode; refit the window and let the
  // renderer restart its capture (the old track often dies on a mode change)
  screen.on('display-metrics-changed', () => {
    if (WINDOWED || !win || win.isDestroyed()) return;
    display = screen.getPrimaryDisplay();
    win.setBounds(display.bounds);
    win.webContents.send('recapture');
  });

  ipcMain.handle('cursor', () => {
    const p = screen.getCursorScreenPoint();
    return {
      x: p.x - display.bounds.x,
      y: p.y - display.bounds.y,
      dpr: display.scaleFactor || 1,
    };
  });
  ipcMain.handle('settings', () => settings);
  const reportBase = PROBE ? 'probe' : 'selftest';
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

  if (SELFTEST || PROBE) setTimeout(() => {
    try { fs.writeFileSync(path.join(__dirname, reportBase + '.json'), JSON.stringify({ error: 'timeout: no report in 25s' })); } catch {}
    app.quit();
  }, 25000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (topGuard) clearInterval(topGuard);
});
app.on('window-all-closed', () => app.quit());

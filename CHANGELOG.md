# Changelog

Versions are tracked separately per component: **desktop** (`desktop/package.json`,
shown in the dist artifact name) and **extension** (`extension/manifest.json` +
the panel header — that string is how you verify which build is running after
a chrome://extensions Reload). The web proto pages always run current source.
Deeper background for every entry (root causes, measurements, field-bug
postmortems) lives in [PLAN.md](PLAN.md).

## 2026-08-26 — desktop 0.2.5 · extension 0.2.7

### Multi-display capture fixed (desktop)
- The captured monitor now FOLLOWS the filter: drag the framed window to
  another display, hit F11 there, or attach to an app on another display —
  capture, crop math and exposure retarget automatically (previously always
  the primary monitor).
- Capture source is matched by `display_id` with a monitor-index fallback for
  systems where sources report an empty id; every display switch and source
  pick is logged to `desktop/debug.log` (`display switch ->` / `capture:`).

### Matrix rain easter egg (all three forms, shared shader)
- Toggle: **M** on web pages and in the extension (physical KeyM or the
  letter m/ь — works in the Russian layout and with on-screen/remote
  keyboards that ship an empty `e.code`), **Ctrl+Alt+M** or the tray on
  desktop (a bare global M would swallow the letter system-wide).
- Final model after three iterations: the regular luminance-mapped mosaic
  stays visible at a dim base brightness, and bright glyph drops rain over
  it, lighting cells up to full as they pass; only the 1-cell drop head
  scrambles randomly (the "decoding" look). Same cell grid and glyph ramp as
  every other mode, so the image behind the filter stays readable.
- Tunable: drops per column (1–4), fall speed, trail length, base-mosaic
  brightness — tray submenu «Матрица» on desktop; the extension panel has a
  matrix checkbox (synced with the M key) plus density/speed selects.

### Configurable hotkeys + editor (desktop)
- Every global hotkey lives in one registry and is rebindable: tray →
  «Горячие клавиши…» opens an editor — click «изменить», press the new
  combo (Esc cancels). Bindings persist in `userData/hotkeys.json`; combos
  taken by other apps are flagged per-row («занято другой программой») and
  logged; global binds suspend while the editor captures, so any combo can
  be assigned. Tray labels always show the current bindings.
- Defaults: Ctrl+Alt+A toggle, F11 overlay/windowed, Ctrl+Alt+↑/↓ cell,
  Ctrl+Alt+←/→ brightness, Ctrl+Alt+T text layer, Ctrl+Alt+D debug,
  Ctrl+Alt+M matrix, Ctrl+Alt+X quit.

### Japanese charset preset (all forms)
- «Японский 日本»: 39 glyphs from light punctuation (・。、ー) through kana to
  dense kanji (龍響鬱). The atlas auto-fits fullwidth glyphs into the cell
  and auto-sorts by ink density, so the set forms a proper luminance ramp
  (39 distinct measured ink levels, no gaps).

### Build & diagnostics
- `node desktop/build-dist.js` self-bootstraps on a fresh clone (runs
  `npm install` when electron-builder is missing) and resolves the
  electron-builder CLI from the package's own `bin` field.
- New diagnostic switches: `ASCII_MATRIX=1` (start with matrix on — used by
  `--selftest` render evidence), `ASCII_HOTKEYS=1` (auto-open the hotkey
  editor). New debug.log lines: capture source picks, display switches,
  `matrix -> on/off`, `filter -> on/off`, `hotkey set/REGISTER FAILED`.

## Earlier

- **desktop 0.2.0 · extension 0.2.1** — first standalone Windows
  distributable (portable exe + zip, koffi capture exclusion, OCR text
  rotoscope), Chrome MV3 extension, web proto. History: [PLAN.md](PLAN.md).

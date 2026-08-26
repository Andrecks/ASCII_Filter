# ASCII Shader — Development Plan

Goal: an installable Chrome extension (Manifest V3) that overlays a movable "transparent
window" on any web page and shows, in real time, an ASCII-rendered view of the page
content behind it. MVP starts as a plain web page with a fixed ~100×100 px window.

Architecture principle: the ASCII conversion is a WebGL2 fragment shader (sub-millisecond);
the hard part is *capture* (getting page pixels) and avoiding the feedback loop
(capturing our own overlay). The render pipeline accepts any `TexImageSource`
(canvas, video, image), so capture sources are swappable — this is what makes each
phase testable without the next one existing.

---

## Phase 0 — Core shader pipeline (no real capture)  ✅ DONE
A test page with a fake "web page" (animated canvas scene: text, shapes, motion,
gradients) and a draggable 100×100 frame over it. A 100×100 WebGL2 canvas renders the
framed region as ASCII every animation frame.

- [x] Dependency-free static dev server (server.js, port 8137)
- [x] Glyph atlas builder: draws charset with Canvas2D, measures ink density of each
      glyph, auto-sorts sparse→dense so any charset becomes a luminance ramp
- [x] WebGL2 renderer: fullscreen-triangle pass; per-cell luminance via mipmap
      `textureLod`, glyph lookup in atlas; mono + per-cell-color modes; invert toggle
- [x] Draggable 100×100 source frame; crop rect → shader uniforms
- [x] Controls: cell size, charset, color mode, invert, 2× pixelated zoom preview
- [x] FPS/frame-time meter
- Test: drag frame over moving scene → ASCII follows in real time, ~60 fps, no
  console errors. Verified in embedded browser (2026-08-24): 60.0 fps, 0.1–0.3 ms JS
  frame time.

## Phase 0.5 — Text passthrough ("rotoscoping") + UTF-8 charsets  ✅ DONE
Small text turns into noise under ASCII cells. Decision: NO OCR (not real-time).
Instead, exploit that in a browser we know the real text without recognizing pixels:
the DOM holds every string and its position. The pipeline gains a "text layer" —
actual text re-drawn in terminal style over the ASCII mosaic, with a knockout halo
that suppresses glyph noise underneath. In Phase 0 the fake scene exposes its text
items (string, x/y, size) exactly like DOM extraction will in Phase 2/3.

- [x] Scene exposes textItems per frame (stand-in for DOM text extraction)
- [x] Text-layer canvas: terminal-styled real text + dark halo (knockout), uploaded
      as a third texture; shader composites it over the ASCII pass
- [x] UTF-8 charsets: per-glyph fit in atlas builder (wide/tall glyphs scaled to
      their slot), presets: ASCII-10, ASCII-70, Cyrillic, block elements
- [x] Cyrillic text in the fake scene to prove end-to-end UTF-8
- [ ] Polish ideas parked: dot-matrix text mode, font-size quantization to cell grid
- Test: frame over the article text → text readable in the output (incl. Russian),
  mosaic continues around it; toggling passthrough on/off changes only text areas.

## Phase 1 — Fullscreen live "browser in a tab" (live.html)  🟡 built, awaiting manual capture test
Fullscreen pipeline + the "tab in a tab" prototype: URL bar, iframe with the target
page, three capture sources. Server-side proxy rewriting REJECTED (fragile rabbit
hole); iframe-refusing sites are covered by the pick-another-tab mode instead.

- [x] Fullscreen output canvas (stage-sized, resize-aware), cell 4–16 px controls
- [x] Source "demo": synthetic fullscreen scene, no permissions — automated testing
- [x] Source "this tab": `getDisplayMedia(preferCurrentTab)` + iframe; Element
      Capture `restrictTo(wrapper)` → true overlay (pointer-events:none, clicks pass
      to iframe); fallbacks: `cropTo` → split layout; raw stream → split + in-shader
      crop of wrapper rect
- [x] Source "pick tab/window": user picks another tab in the dialog → whole stage
      is the ASCII monitor; works for ANY site (youtube, google, …), no framing limits
- [x] DOM-text rotoscope from the same-origin iframe (TreeWalker + per-word Range
      rects, scroll + 600ms refresh) feeding the Phase 0.5 text layer
- [x] Headless verification (embedded pane, demo source): 1280×625 out, 160×78
      cells, 10.6 ms/frame WITH debug readback (~3.2MB/frame readPixels) → real loop
      well past 60 fps; DOM extractor on the demo article: 71 items incl. Russian
      words with sane coords; support probe: getDisplayMedia ✓ RestrictionTarget ✓
      CropTarget ✓
- [ ] MANUAL (needs a human "Share" click, security gate): verify overlay mode on
      /article.html, split fallback, and pick-a-tab mode on an arbitrary site

### Phase 1.5 — Input passthrough + ASCII cursor  ✅ DONE (headless-verified)
Input by mode: OVERLAY — native passthrough by construction (canvas is
pointer-events:none; page gets real trusted events; nothing to forward). SPLIT/DEMO —
canvas takes input; forward.js dispatches synthetic events into the same-origin
iframe (the prototype of the extension's content-script side). PICK — impossible
from a web page by browser security design; solved in Phase 3 by the extension
(content script messaging; optionally chrome.debugger/CDP for fully trusted input).

- [x] cursor.js: ASCII cursor — inverse block snapped to the cell grid, glyph
      mirrors real CSS cursor state (> pointer, | text, % grab, x not-allowed, ~ wait,
      + default), pressed tint + ~320ms click ripple; "hide system cursor" toggle
- [x] Cursor state sourced from same-origin doc listeners (overlay/split) or the
      canvas itself (demo); resolves cursor:auto via element role (a/button/input)
- [x] forward.js: click (mousedown→focus→mouseup→click), wheel (event + scrollable-
      ancestor scroll), keys (keydown/keyup + manual value edit for INPUT/TEXTAREA
      with caret handling); input-event chips in the toolbar
- [x] Verified headlessly: hover over link → pointer state '>'; button clicked
      twice → counter 2; typed «привет»+Backspace → «приве», focus correct; anchor
      link click navigated (scroll 821→1626); wheel scrolled window; cursor cell
      3.1%→53.1% lit when drawn. Zero console errors.
- Known synthetic-event limits (fine for proto, CDP upgrade path in Phase 3):
  isTrusted=false, CSS :hover doesn't engage, drag/text-selection not forwarded.
- Files: proto/live.html, proto/live.js, proto/domtext.js, proto/textlayer.js,
  proto/presets.js, proto/article.html (demo article, RU/EN)

## Phase 2 — True "transparent window" (overlay directly over the source region)
The illusion the project is named for: ASCII drawn exactly where the content is.
NOTE: largely pre-built inside Phase 1's live.html (restrictTo overlay over the
iframe, pointer-events:none, DOM-text rotoscope). Remaining work is hardening on
real sites + the movable/resizable window variant, then folding into the extension.

- [ ] Element Capture API (`RestrictionTarget.fromElement`): wrap page content in a
      container, restrict capture to it → our overlay (outside the container) is
      excluded from the stream → no hall-of-mirrors. Feature-detect; keep Phase 1
      periscope as fallback. (Chrome-only API; verify current ship status.)
- [ ] DOM text extraction feeding the Phase 0.5 text layer: walk visible text nodes
      in the framed region (TreeWalker + Range.getClientRects), emit the same
      {text, x, y, size, weight} items the fake scene produces today. This is the
      real "rotoscope": genuine page text (any language) stays readable while
      everything else is ASCII. No OCR anywhere.
- [ ] Overlay canvas with `pointer-events: none` — clicks/scroll pass through to the
      real page; zero added input latency (only visual feedback lags ~1–2 frames)
- [ ] Make the window draggable via a small grab handle (the only part that takes
      pointer events)
- Test: overlay shows the content directly beneath itself; interact with page
  through it (click links, select text, scroll); confirm no recursion artifacts.

## Phase 3 — Chrome extension (MV3)  🟡 built, awaiting install test
User feedback trigger: external sites in the iframe are cross-origin (no DOM text,
no forwarding) and pick-a-tab mode can't receive input — both are web-sandbox walls
solvable ONLY by an extension. Architecture: content script runs INSIDE the target
page: input is native by construction (overlay never intercepts), text rotoscope
reads this page's own DOM, capture restricted to <body> while overlay+panel live
outside body (siblings in <html>) → excluded from stream, no feedback loop, no DOM
surgery of page content (wrap fallback only if body box is collapsed).

- [x] manifest.json (MV3: action, activeTab, scripting, tabCapture), bg.js worker
      (inject on action click; streamId provider)
- [x] ext-main.js content script: floating control panel, capture start
      (getDisplayMedia+preferCurrentTab), restrictTo(body) → fullscreen overlay;
      fallbacks: cropTo / corner-monitor; DOM-text watch (interval+scroll), ASCII
      cursor from real listeners, hide-system-cursor, resize handling
- [x] Promptless experiment: tabCapture streamId → getUserMedia → try restrictTo
      (unknown if Chrome allows on tabCapture tracks — button reports the verdict)
- [x] build-ext.js: strips ES module syntax, bundles proto modules + main into one
      classic-script IIFE (27 KB); `node --check` clean
- [x] Smoke test via script-tag injection on article.html: panel mounts, 71 DOM text
      items, restrictTo=да, cursor tracks real mousemove, overlay confirmed outside
      <body>
- [ ] MANUAL: load unpacked in real Chrome (chrome://extensions → Developer mode →
      Load unpacked → extension/), click icon on: static article, news site, YouTube,
      the user's torrent tracker; verify text rotoscope + native input + fps
- [ ] Icons, options persistence (chrome.storage), site test matrix hardening

### Phase 3.1 — Scanner v2 + auto-enable  ✅ built (real-site test by user pending)
User field-test on Google found missed text. Root causes were NOT contrast/thin
fonts: (1) 500-item cap eaten from the top of the DOM by hidden a11y links, which
also painted as garbage at the left edge; (2) input/textarea values are not text
nodes — the search query was invisible to the walker; (3) no shadow DOM descent;
(4) visible+aria duplicate strings drawn twice.

- [x] domtext v2: recursive element walk with whole-subtree viewport pruning
      (±40px margin), shadow DOM descent, INPUT/TEXTAREA value+placeholder items,
      clip/clip-path/opacity/fontSize<6 filtering, off-viewport rect rejection,
      position-keyed dedup, cap raised to 1500
- [x] Verified on live ru.wikipedia.org (embedded pane): 176 items in 17.6 ms,
      search-input value caught, 0 offscreen items, 0 dups, 120 Cyrillic items
- [x] Auto-enable: action icon is now a per-tab TOGGLE ('ON' badge); enabled set in
      storage.session; bg re-injects + auto-starts on every navigation
      (tabs.onUpdated) and tabs opened from an enabled tab inherit it
      (tabs.onCreated/openerTabId); host_permissions <all_urls> added for that
- [x] Auto-start chain: tabCapture streamId (no dialog) → on failure panel asks for
      one ▶ Старт (Share) click. Whether restrictTo applies to tabCapture tracks is
      still an open Chrome question — the status line reports the verdict per run.
- [ ] USER TEST: reload extension (manifest changed — Chrome will re-ask
      permissions), re-test Google: query text + no left-edge garbage; check how
      often the Share dialog still appears in practice

### Phase 3.2 — Text mode: the page as raw copyable characters  ✅ built
- [x] textgrid.js: buildCharGrid() — the frame as an array of row strings; same
      mapping as the shader (downsampled per-cell luminance → density-sorted ramp),
      rotoscoped DOM text stamped into cells one char each
- [x] Panel: "режим текста" checkbox — freezes the frame and swaps the canvas for a
      <pre> with identical cell metrics (font-size=line-height=cell, letter-spacing
      = cell − glyph advance): native mouse selection + Ctrl+C of raw characters;
      page underneath is fully blocked (pointer-events:auto); Esc exits
- [x] "📋 всё" button: copies the whole current frame (works live, without entering
      text mode) via navigator.clipboard
- [x] Headless test (demo source): 74×160 grid; row 3 = "..ASCII Times...-+.@@@.#";
      row 9 = "..Русский текст остаётся читаемым,++=..."; marquee caught; 5440
      mosaic chars in text-free zone are 100% from the ramp
- [ ] Ideas parked: per-cell color spans in text mode, live-updating text mode,
      copy-selection-only button in panel

### Phase 3.3 — Long-page alignment fix + width-fit text  ✅ built (user retest pending)
Field bug (image-gallery site): rotoscoped text drifted vs the mosaic, drift varied
with scroll. Root cause: Element Capture frames cover the WHOLE restricted element
(full body height, scrolled-out parts included) — the shader squeezed the entire
page into the viewport while DOM items use viewport coords. Invisible on short
pages (body ≈ viewport), broke on long ones.

- [x] computeViewportCrop(): per-frame crop of the visible window out of the body
      box (from body's getBoundingClientRect; scroll- and dpr-proof); applied in
      the render loop and in text-mode grid building; full-video crop kept for
      monitor/raw modes (those are viewport-based already)
- [x] Unit-verified: scrolled, dpr×2, page-top, short-page clamp, body-margin cases
- [x] Width-fit rotoscope: scanner now records each item's real box width; painter
      squeezes monospace text horizontally (down to 0.55×) when it overflows that
      box — fixes strings running into each other ("…this imagReload broken image")
- [ ] USER RETEST on the gallery site: text under the image, no drift while
      scrolling; neighbouring links no longer merge

### Phase 3.4 — Adaptive alignment + diagnostics  ✅ built (v0.2.1)
Retest still drifted → the captured frame's coordinate space varies by page more
than assumed (border box vs painted bounds with layout overflow vs viewport).
Stopped guessing; made it adaptive and observable:

- [x] computeCrop(): matches the video frame's aspect against candidates (body
      border box | box∪scrollWidth/Height overflow bounds); >6% mismatch with both
      → frames treated as viewport-mapped (full crop). Unit-tested: box model,
      overflow model, viewport fallback, forced modes.
- [x] Panel: "выравнивание: авто/страница/вьюпорт" manual override — instant user-
      side fix while auto-detection is imperfect
- [x] Debug checkbox → live readout: video size, body box@top, scroll bounds,
      window, dpr, picked model, aspect error, mode. One screenshot of this line
      pins the true coordinate space of any problem page.
- [x] Version shown in panel header (v0.2.1) + manifest bump — confirms which build
      actually runs after Reload
- [x] USER: confirmed fixed on the gallery site after updating to v0.2.1 ✓
      (adaptive alignment picked the right space; no drift reported)

## Phase 5 — Windows desktop app: whole-screen ASCII filter  🟡 in progress
The OS-level overlay from the original concept (ShaderGlass-style). Electron by
deliberate choice: reuses the exact WebGL pipeline + modules from proto/ unchanged;
`setContentProtection(true)` = WDA_EXCLUDEFROMCAPTURE → overlay excluded from its
own screen capture, no feedback loop; `setIgnoreMouseEvents(true)` = full click-
through, input stays native. No DOM at OS level → the text rotoscope runs on the
Windows built-in OCR instead (Phase 5.5) — the one place OCR earned its slot; the
browser variants keep the DOM source. Native C++/DXGI port stays a possible
later optimization if capture latency ever matters.

- [x] desktop/: main.js (fullscreen frameless click-through overlay on primary
      display, promptless screen pick via setDisplayMediaRequestHandler, tray menu,
      global hotkeys), preload.js, overlay.html/js (reuses ../proto modules via
      direct file:// module imports — zero duplication)
- [x] ASCII block cursor from screen.getCursorScreenPoint polled at 60Hz (no
      ripple — no global mouse hooks in v1); dpr-scaled to physical px
- [x] Selftest mode: small window, 60 frames, stats JSON + frame PNG (disk only)
- [x] Tray (generated 16×16 icon, no assets): toggle, cell, presets, color, invert,
      cursor, quit; hotkeys Ctrl+Alt+A / Ctrl+Alt+↑↓ / Ctrl+Alt+X
- [x] start.cmd launcher (machine's global npx shim is broken — bypassed with the
      local electron binary; electron postinstall had to be run manually)
- [x] SELFTEST PASSED on the user's machine: display 2560×1080 captured with no
      dialog, 123.9 fps, 7.1% ink, 65×42 cells at 520×340 test window
- [x] Above-fullscreen hardening (2026-08-25): fullscreen apps no longer bury or
      freeze the overlay. Three-part fix: (1) `CalculateNativeWinOcclusion`
      disabled + `backgroundThrottling:false` — Chromium kept painting us even
      when it thinks we're covered; (2) topmost guard: 500ms re-assert
      (setAlwaysOnTop+moveTop) — among topmost windows the last to assert wins,
      so we undercut any fullscreen app that raised itself above us; restores if
      minimized/hidden; (3) input untouched by construction: WS_EX_NOACTIVATE
      (focusable:false) means a raise can never activate the window — no focus
      steal ever. Guard pauses while our tray menu is open (menu-will-show/close
      + right-click 8s fallback) so it doesn't cover the menu. Selftest re-passed
      (181 fps); 7s real-fullscreen smoke run clean. LIMIT: legacy true exclusive
      fullscreen (old DX, fullscreen optimizations off) bypasses DWM — nothing
      can overlay it (same as ShaderGlass).
- [x] FIELD BUG (ETS2, night scene): screen almost black + user's screenshot showed
      the overlay. Diagnosed via new `--probe` mode (real fullscreen run that dumps
      probe.json stats, probe.png output, probe-video.png = RAW captured frame, and
      a green-dominance self-capture detector). Verdict: THREE stacked bugs —
      (a) capture contained our own glyph field: content protection silently broken
      from day one (selftest window too small to expose it); (b) window clamped to
      the work area (2560×1040 → unfiltered 40px taskbar strip, the "strip" in the
      user's screenshot); (c) night scene avg lum ~0.04 → linear ramp maps almost
      every cell to space.
- [x] Fix a — self-capture: SetWindowDisplayAffinity FAILS on windows with
      WS_EX_NOREDIRECTIONBITMAP (Chromium + DirectComposition); measured
      GetWindowDisplayAffinity=0 despite setContentProtection(true) + re-asserts.
      `disable-direct-composition` now default → flag sticks, probe captures the
      real desktop (verified visually and by RGB stats), GPU rendering unaffected
      (probe 72–120 fps at 2560×1080). Env escapes: ASCII_KEEP_DCOMP=1, ASCII_SOFT=1
      (software rendering). Guard also re-asserts protection every tick.
- [x] Fix b — coverage: window created resizable, setBounds(display.bounds) on
      ready-to-show, then setResizable(false); canvas now true 2560×1080.
- [x] Fix c — exposure: shader gets uGain/uGamma (neutral defaults, proto and
      extension behavior unchanged); desktop auto-exposure: 48×27 CPU downsample at
      4 Hz, scene avg pulled toward 0.32, gain 1–10 smoothed, γ=0.6 in auto mode;
      tray «Авто-яркость» + manual bias ×0.25–8 (Ctrl+Alt+←/→); debug line
      Ctrl+Alt+D (video size, avg/max lum, gain, fps, track state, restarts);
      capture auto-restarts on track end and display-metrics-changed (games
      switching display mode no longer freeze the filter).
- [x] FIELD BUG #2 (start.cmd → tray icon appears, window never does): the show
      path hinged on a single unguaranteed event — `ready-to-show` didn't fire on
      that boot (stalled first paint; same signature as the one blank --probe run
      earlier), and the topmost guard was ALSO started inside that callback, so
      the rescue path never armed. Fix: idempotent ensureShown() reachable three
      ways (ready-to-show, 1.5s fallback timer, every guard tick — guard now
      starts in whenReady); renderer crash → auto reloadIgnoringCache;
      did-fail-load / unresponsive / child-process-gone and the show path+bounds
      logged to desktop/debug.log (gitignored). Verified with a real start.cmd
      launch: window visible 2560×1080, exstyle NOACTIVATE|LAYERED|TRANSPARENT|
      TOPMOST, no NOREDIRECTIONBITMAP (protection intact); 4 stale processes from
      the user's broken run found and killed.
- [x] FIELD BUG #3 (window STILL never appeared): two independent faults were
      masking each other. (1) disable-direct-composition — the earlier "fix" —
      kills compositing of LAYERED (click-through) windows entirely: WS_VISIBLE
      yes, zero pixels on screen; normal windows render fine, so selftest stayed
      green. Reverted, DCOMP is ON again (ASCII_NO_DCOMP=1 for experiments).
      (2) The ORIGINAL self-capture bug returned with DCOMP: Electron's
      setContentProtection works on the framed window (affinity 17) but never
      sticks on the overlay (0, any call order). Fix: direct user32
      SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) via koffi (new dep) at
      creation + re-pin each guard tick; per-step aff@ probes in debug.log.
      Evidence chain: screenshot (dcomp on, ASCII_NO_PROTECT=1) = overlay renders
      fullscreen; probe (protection on) = greenDominance 1.01,
      selfCaptureSuspected FALSE, 140 fps; selftest 134 fps; on-screen
      verification now uses real CopyFromScreen screenshots — WS_VISIBLE proved
      nothing and had validated an invisible window in bug #2.
- [x] UX rework (user request): app STARTS as a normal framed window — always
      visibly appears, system cursor, no app menu; F11 (global hotkey, also in
      tray) toggles fullscreen click-through overlay ↔ window by recreating the
      window (frame/focusable are creation-only); --overlay starts in overlay
      mode. Verified: F11 cycle log shows both directions with
      captureExclusion=ON on every window.
- [ ] USER RETEST: start.cmd → framed window with live ASCII appears; F11 →
      whole screen becomes the mosaic (click-through, input native); F11 → back
      to window. Then the ETS2 pass: night scene readable, no black screen,
      mosaic over the game, tray/hotkeys; Ctrl+Alt+D + debug.log if anything's
      off

### Phase 5.5 — Desktop text rotoscope via Windows OCR  ✅ built (user test pending)
Desktop has no DOM, and games expose no accessibility tree either — pixels are
the only text source there. Windows 10 ships a native OCR engine
(Windows.Media.Ocr — the PowerToys Text Extractor one): ru+en available on this
machine, full 2560×1080 frame in ~60–220 ms, per-word bounding boxes. Fast
enough for a change-driven rotoscope. OCR was rejected for the browser because
the DOM is strictly better, not as dogma — here it earns its place.

- [x] ocr-helper.ps1: persistent PowerShell child hosting the WinRT OcrEngine
      (TryCreateFromUserProfileLanguages, ru active); stdin: image path →
      stdout: one JSON line {ok, ms, words:[{t,x,y,w,h}]}; -Test mode measured
      137→59 ms warm, Russian words with correct coords
- [x] main.js: spawn/respawn with backoff, single-flight 'ocr' ipc (renderer
      JPEG buffer → temp file → helper → parsed JSON), killed on quit,
      lifecycle + stderr in debug.log
- [x] overlay.js: 500 ms scheduler — 64×36 frame signature, re-OCR only when
      the frame changed (diff>3.5), instant stale-text drop on scene cuts
      (diff>30); words (h 7–200 px) → {text, x, baseline≈y+0.82h, size:h, w} →
      the SHARED proto/textlayer.js painter (terminal ink + knockout halo) →
      composited by the shader's uText pass; scale-aware (overlay 1:1,
      windowed scaled down)
- [x] Tray «Текст поверх мозаики» checkbox + Ctrl+Alt+T; debug line shows
      ocr word count / ms / errors
- [x] --ocrtest evidence mode: small inactive window (no focus steal),
      full-res composite dumped to ocrtest.json/.png (gitignored). Result:
      118 words, 219 ms, Cyrillic intact end-to-end (false alarm on mojibake
      was Get-Content decoding UTF-8 as cp1251 — read artifacts as UTF-8);
      composite shows mixed RU/EN desktop text readable in place over the
      mosaic ✓
- [ ] USER: real-world pass incl. ETS2 menus/HUD (stylized game fonts are
      OCR's hard mode — expect partial pickup; cell size ↓ helps the rest)
- [ ] Polish candidates parked: line-level grouping (calmer than per-word),
      flicker damping between passes (match words by position), UIA text
      source for a11y-friendly apps (exact strings, browser-grade), region
      OCR (only changed tiles) if full-frame latency ever hurts

### Phase 5.6 — Attach-to-app + windowed x-ray lens  ✅ built (user test pending)
Two user asks: (1) bind the filter to ONE application so it can never be shown
unfiltered — born from an app that out-toposted even the fullscreen overlay;
(2) windowed mode should show only the region directly behind the window, 1:1,
instead of squeezing the whole screen.

- [x] Shared crop pipeline: the 60 Hz cursor poll now also carries the view
      rect (DIPs) + display bounds; renderer maps them to video px (cropNow),
      renders just the crop, and routes exposure sampling and the OCR text
      painter through the same rect. Windowed = own content bounds (drag the
      window = x-ray lens); attached = target bounds; overlay/selftest/probe/
      ocrtest = full frame (baselines unchanged).
- [x] Attachment WITHOUT a topmost war: the filter becomes an OWNED window of
      the target (SetWindowLongPtr GWLP_HWNDPARENT via koffi) — Win32 keeps an
      owned window directly above its owner in z-order, windowed or fullscreen,
      so the target cannot be raised unfiltered; windows covering the target
      correctly cover the filter too (no fake x-ray of occluded apps). 150 ms
      follow tick: DWM extended-frame bounds → setBounds; minimize → hide;
      restore → showInactive; close → auto-detach back to windowed;
      moveTop nudge when target is foreground; exclusion re-pin every ~3 s.
- [x] Tray submenu «Привязка к приложению»: live top-level window list
      (GetTopWindow/GetWindow z-walk; filtered: visible, titled, not cloaked,
      no toolwindows, not ours), «Отвязать», «Обновить список»;
      ASCII_ATTACH="substring" env = auto-attach for tests/power users.
- [x] FIELD FIX en route: Electron's setContentProtection on LAYERED windows
      not only fails to set the affinity — it CLEARS one the direct call had
      already set (fresh attached window regressed to 0). applyCaptureExclusion
      now uses the direct user32 path exclusively whenever koffi is present;
      the Electron call remains only as a no-koffi fallback. att-created/
      ignoreMouse/owned probes: all readback=17.
- [x] Verified live with a notepad target: mosaic lands exactly on the target
      rect (uniform white field = 1:1 crop, not screen-squeeze), auto-detach on
      target close in the log, affinity ON at every step. DISCOVERY: windows
      with WDA_EXCLUDEFROMCAPTURE are invisible to GDI screenshots on this
      build too — any on-screen visual verification MUST run with
      ASCII_NO_PROTECT=1 (the t10 methodology).
- [x] Fresh-clone fix (field report from a second PC: "electron.exe not
      found"): start.cmd now self-bootstraps — binary check → npm install →
      node_modules/electron/install.js fallback (the known postinstall skip) →
      start; clear message + pause when Node.js/npm is absent. Verified here by
      renaming dist/ away: installer restored it and the app started (log);
      first spawn after extraction can lag seconds — AV scans the fresh exe.
      Second-PC prereq is ONLY Node.js; ru OCR needs the RU language pack.
- [ ] USER: attach to the stubborn app that ignored fullscreen mode (tray →
      Привязка) → verify it cannot appear unfiltered through moves/resizes/
      fullscreen; windowed lens: drag the framed window around — it should
      show what's directly behind it, 1:1.

### Phase 5.7 — Standalone distributable (nothing to install)  ✅ built
User ask: a ready-to-run exe for other PCs — no Node.js, no npm, no steps.

- [x] desktop/build-dist.js: stages the repo structure (desktop/ + proto/ as
      siblings so the file:// ../proto imports keep working), generates a stage
      package.json, runs the local electron-builder. asar OFF by design:
      PowerShell must read ocr-helper.ps1 as a real file, koffi is native,
      proto loads as plain file:// ES modules. npmRebuild off.
- [x] Output (desktop/dist/, gitignored): ASCII-Shader-0.2.0-portable.exe
      (89 MB single file; self-extracts on launch — first start takes ~5–15 s
      under AV scan) + ASCII-Shader-0.2.0-win.zip (139 MB; unzip once → run
      "ASCII Shader.exe", instant start — recommended) + win-unpacked/.
- [x] Packaging field bugs fixed en route: (a) loadFile('overlay.html')
      resolves against the APP ROOT, which differs between dev (desktop/) and
      package (resources/app/) — must be absolute via __dirname; (b)
      electron-builder's node_modules pruning stripped koffi's native — koffi
      3.x keeps the .node in a SEPARATE platform package
      @koromix/koffi-win32-x64; both packages now ship via extraResources,
      bypassing the pruner entirely.
- [x] Verified on this machine: packaged app runs with captureExclusion=ON and
      the OCR helper alive (debug.log inside the package); portable stub
      extracts and launches the app.
- [x] Field bug (c): with desktop/node_modules absent (fresh checkout) the
      build died on the hardcoded node_modules/electron-builder/cli.js path —
      start.cmd self-bootstraps but build-dist.js didn't. Fix: build-dist.js
      now runs npm install itself when electron-builder is missing and
      resolves the CLI entry from electron-builder's own package.json bin
      field. Verified end-to-end from empty node_modules: both artifacts
      built, packaged exe --selftest ok:true 58.3 fps, gain 1.67, koffi loads.
- [ ] Later polish: app icon (.ico), code signing (unsigned exe triggers a
      one-time SmartScreen prompt on other PCs), GitHub Releases upload.
- [ ] Multi-display picker, settings persistence, packaged .exe (electron-builder)
      — later polish

### Phase 5.8 — Multi-display capture + Matrix easter egg  ✅ built
User field report: on a second monitor the filter still shows monitor 1 — in
windowed mode after dragging the window over, AND when attached to an app there.

- [x] Root cause: `display` was set to getPrimaryDisplay() once at window
      creation and re-set to primary on display-metrics-changed; the capture
      handler picks the source by display.id, and cursor/crop math uses
      display.bounds — so every view mode captured monitor 1 forever.
- [x] Fix (desktop/main.js): `display` now follows the window — syncDisplayTo()
      on debounced framed-window 'move', on every attachTick bounds change, on
      F11 (overlay opens on the window's current monitor), and attachTo() seeds
      it from the target's monitor before the first frame. Each switch logs
      `display switch -> id=...` and sends 'recapture'; display-metrics-changed
      keeps the SAME display (primary only if unplugged). Capture handler got a
      monitor-index fallback for setups where source.display_id is empty, and
      logs the picked source (field diagnosis).
- [x] Verified end-to-end on the dev machine (1280×800 primary + 1920×1080
      secondary at -1920,0): started windowed → log shows capture of "Экран 1"
      (id 3403897437); SetWindowPos to -1500,120 → 'display switch ->
      id=2661095462' + new capture line "Экран 2" with matching display_id.
      --selftest regression: ok:true, 57 fps.
- [ ] USER: drag the window to the second monitor — the lens must show what's
      behind it THERE; F11 there — overlay covers that monitor; «Привязка» to an
      app on the second monitor — filter shows that app. (Log evidence already
      green; this is the eyes-on confirmation.)
- [x] Matrix rain easter egg, shared shader (proto/ascii.js: uMatrix/uTime):
      per-column drops, random flickering glyphs (blank slot excluded), trail
      fades upward, head cell always lit + whitened; trail brightness carries
      scene luminance so the image ghosts through. Verified by pixel probe on
      the phase-0 page: per-cell max-green profile rises top→bottom
      (59→…→211), head brightest; animation advances with time; toggle clean.
      Binds: desktop Ctrl+Alt+M (global; bare M would eat the key system-wide —
      overlay never has keyboard focus; deliberately NOT in the tray), web
      pages + extension: physical KeyM outside inputs/no modifiers (ext v0.2.3).
- [x] Field report "бинд M не работает" → verified the whole chain live and
      hardened it: (a) desktop hotkey PROVEN working — injected Ctrl+Alt+M via
      keybd_event → debug.log 'matrix -> on'/'off'; render PROVEN — selftest
      with new diagnostic env ASCII_MATRIX=1 renders real rain (selftest.png,
      litFrac 0.008 vs ~0.21 mosaic); (b) real bug found in the web listener:
      it required e.code==='KeyM', but e.code arrives EMPTY from on-screen
      keyboards / remote desktop / synthesized input (caught via CDP key
      injection) — now also matches the letter itself (m/ь, RU layout's key);
      (c) hotkey registration failures now logged ('hotkey REGISTER FAILED' —
      register() silently returns false when another app owns the combo), and
      every matrix toggle logs. Ext bumped to v0.2.4.
- [x] Field follow-up "по бинду не работает" → configurable hotkeys + tray
      access (v0.2.2): «Матрица» checkbox in the tray (no hotkey needed at
      all), «Горячие клавиши…» opens desktop/hotkeys.html — an editor listing
      every action (single HOTKEY_ACTIONS registry in main.js) where a row is
      rebound by clicking «изменить» and pressing the combo; bindings persist
      in userData/hotkeys.json, registration failures («занято другой
      программой») show per-row, global binds SUSPEND while capturing so the
      pressed combo reaches the editor, tray labels render live binds.
      ASCII_HOTKEYS=1 auto-opens the editor (diagnostics). Verified: editor
      opens + rows render over real IPC (screenshot); capture logic (lone
      modifier wait, RU layout Ctrl+Alt+M, F9, num5, bare M, Esc cancel)
      verified against a stubbed IPC in the browser pane; full in-Electron
      keystroke e2e was impractical — the user was actively using the machine
      (their own Ctrl+Alt+M press landed in debug.log as 'matrix -> on',
      incidentally proving the hotkey fires on their setup).
- [x] Matrix v2 — adaptive (user: "чтобы передавали суть того, что за
      фильтром"): the trail now keeps the LUMINANCE-mapped glyph of the cell
      (dark cells stay empty, bright cells dense — the mosaic essence), drops
      only modulate brightness; only the 1-cell head scrambles randomly (the
      "decoding" look). Density up: 3 independent drops/column, speed
      8–22 cells/s, trails 10–26 cells, faint 0.08 ambient keeps the image
      ghost-readable between drops. Verified on a synthetic half-black /
      half-white frame: white side 67–73% cells lit (mean ~98), black side
      6–16% (heads only) — the image passes through; desktop selftest PNG
      shows the taskbar readable as a glyph band through the rain. Same grid
      and same glyph ramp as every other mode by construction. Ext v0.2.5,
      desktop v0.2.3.
- [x] Matrix settings exposed (desktop v0.2.4, ext v0.2.6): shader takes
      uMatrixP vec4 (drops/column 1..4, speed mul, trail mul, ambient). Tray
      «Матрица» became a submenu: Включена + Плотность (Редкий/Обычный/
      Плотный/Ливень) + Скорость (Медленно/Обычно/Быстро) + Хвосты (Короткие/
      Обычные/Длинные) + Фон (Выкл/Слабый/Заметный). Ext panel: «матрица»
      checkbox (synced with the M key) + density/speed selects. Measured, each
      knob monotone: drops 1/3/4 -> 6/18/23% lit px; len 0.6x -> 15%; speed
      0.5x vs 1.6x -> 12% vs 33% px changed per 0.3s; ambient 0/0.08/0.16 ->
      16/46/57% dim px. Live-mode smoke: tray submenu builds, no crash.
- [x] Matrix v3 — base-mosaic model (user: v2 still didn't convey the image;
      their proposal adopted verbatim): matrix = the NORMAL mosaic at a dim
      base brightness (uMatrixP.w, default 0.35) with drops LIGHTING cells up
      to full — bright symbols raining over a dark copy of the image. Dropped
      the trail's extra lum scaling (glyph already encodes luminance; the
      double-dimming was hiding the picture). Tray «Фон между каплями» became
      «Яркость фоновой мозаики»: Выкл (только дождь) / Тусклая 0.2 / Обычная
      0.35 / Яркая 0.5. Gradient-stand correlation matrix-vs-normal rose
      0.19 -> 0.42 full-frame (rain is uncorrelated by nature and dilutes the
      stat); desktop selftest PNG: windows/taskbar readable through the rain.
      Desktop v0.2.5, ext v0.2.7.
- [ ] USER: tray → «Матрица» submenu: toggle + Плотность/Скорость/Хвосты +
      «Яркость фоновой мозаики» (applies instantly; raise it if the image
      should show more). «Горячие клавиши…» → rebind matrix to bare M if
      wanted (warning: global). Extension (panel header 0.2.7): «матрица»
      checkbox + selects, M key flips the checkbox. Eyeball: dim normal
      mosaic must be readable everywhere, bright symbols fall over it.

## Phase 4 — Polish & ship
- [ ] Resizable window, remembered position/size (storage)
- [ ] Presets: charset packs, green/amber terminal, per-cell color; optional Sobel
      edge-glyph mode (| / — \)
  - [x] japanese preset (v0.2.2): 39 glyphs, punctuation -> sparse kanji ->
        kana -> dense kanji (鬱/響). Relies on the atlas auto-fit (fullwidth
        glyphs shrunk to cell) + ink sort; measured in-page: 39 distinct ink
        levels, smooth 0->0.482 ramp, no font-fallback tofu. Wired into all
        four UIs (index/live selects, ext panel, desktop tray).
- [ ] Performance knobs: fps cap, cell size, pause-when-hidden
- [ ] Options page, icons, store-ready zip
- Test: 10-minute soak on heavy site — no leaks (memory flat), stable fps.

---

## Risks / open questions
- Element Capture API availability & whether it applies to tabCapture streams
  (Phase 3 decision checkpoint). Fallbacks exist (periscope / one-time prompt).
- Screen-share permission UX in the extension: promptless requires tabCapture route.
- Sites with heavy iframes: cross-origin iframe content IS captured by tab capture
  (it's pixels, not DOM) — good; but DOM-wrapping for Element Capture must not touch
  iframe internals.
- The embedded dev browser may not allow getDisplayMedia picker automation — Phase 1+
  live-capture verification is a manual step for the user in real Chrome.

## Running the prototype
    node server.js
then open http://localhost:8137

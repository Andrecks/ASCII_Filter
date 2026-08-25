// ASCII Shader Desktop — renderer. Reuses the proto pipeline modules unchanged.
import { AsciiRenderer } from '../proto/ascii.js';
import { PRESETS } from '../proto/presets.js';
import { CursorLayer } from '../proto/cursor.js';

const MODE = new URLSearchParams(location.search).get('mode');
const SELFTEST = MODE === 'selftest';
const PROBE = MODE === 'probe';
const REPORT_AT = SELFTEST ? 60 : 120; // probe waits ~2s so auto-exposure settles

const outCanvas = document.getElementById('out');
const renderer = new AsciiRenderer(outCanvas);
const cursor = new CursorLayer();

const textCanvas = document.createElement('canvas');
const textCtx = textCanvas.getContext('2d');

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;

let settings = { cell: 8, preset: 'ascii10', colorMode: 0, invert: false,
                 cursorOn: true, exposure: true, bias: 1, debug: false };

function applyCharset() {
  renderer.setCharset(PRESETS[settings.preset] || PRESETS.ascii10, settings.cell, settings.cell);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(2, Math.round(innerWidth * dpr));
  const h = Math.max(2, Math.round(innerHeight * dpr));
  if (outCanvas.width !== w || outCanvas.height !== h) {
    outCanvas.width = w;
    outCanvas.height = h;
    textCanvas.width = w;
    textCanvas.height = h;
  }
}
addEventListener('resize', resize);

// --- capture with auto-restart (display mode changes kill the track) ---------
let stream = null;
let recaptures = 0;
let recapturing = false;

async function capture() {
  // the display-media handler in main auto-picks the screen — no dialog appears
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60 } },
    audio: false,
  });
  stream.getVideoTracks()[0].addEventListener('ended', () => recapture());
  video.srcObject = stream;
  await video.play();
}

async function recapture() {
  if (recapturing) return;
  recapturing = true;
  recaptures++;
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch { /* already dead */ }
  for (;;) {
    try { await capture(); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  recapturing = false;
}

// --- auto-exposure -----------------------------------------------------------
// Night scenes (games) average ~0.03 luminance — linear mapping drops nearly every
// cell below the first glyph. A tiny CPU downsample of the frame drives a gain that
// pulls the scene average toward mid-ramp; blown highlights are fine in ASCII.
const expo = { avg: 0, max: 0, gain: 1 };
const expoCanvas = document.createElement('canvas');
expoCanvas.width = 48;
expoCanvas.height = 27;
const expoCtx = expoCanvas.getContext('2d', { willReadFrequently: true });

function sampleExposure() {
  if (video.readyState < 2 || !video.videoWidth) return;
  expoCtx.drawImage(video, 0, 0, expoCanvas.width, expoCanvas.height);
  const d = expoCtx.getImageData(0, 0, expoCanvas.width, expoCanvas.height).data;
  let sum = 0, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    sum += l;
    if (l > max) max = l;
  }
  expo.avg = sum / (d.length / 4);
  expo.max = max;
  const goal = Math.max(1, Math.min(10, 0.32 / Math.max(expo.avg, 0.01)));
  expo.gain += (goal - expo.gain) * 0.3; // smoothed — no flicker on scene cuts
}
setInterval(sampleExposure, 250);

const gainNow = () => (settings.exposure ? expo.gain : 1) * (settings.bias || 1);
const gammaNow = () => (settings.exposure ? 0.6 : 1);

function drawDebug() {
  const k = window.devicePixelRatio || 1;
  const track = stream && stream.getVideoTracks()[0];
  const line = `видео ${video.videoWidth}×${video.videoHeight}` +
    ` | ср.ярк ${expo.avg.toFixed(3)} макс ${expo.max.toFixed(2)}` +
    ` | gain ${gainNow().toFixed(2)} (авто ${expo.gain.toFixed(2)} × ${(settings.bias || 1).toFixed(2)}) γ${gammaNow()}` +
    ` | ${(1000 / emaMs).toFixed(0)} fps` +
    ` | трек ${track ? track.readyState + (track.muted ? ' MUTED' : '') : '—'}` +
    ` | рестартов ${recaptures}`;
  const fs = Math.round(13 * k);
  textCtx.font = `${fs}px Consolas, monospace`;
  textCtx.fillStyle = 'rgba(0,0,0,0.75)';
  textCtx.fillRect(0, 0, textCtx.measureText(line).width + fs, fs * 2);
  textCtx.fillStyle = '#7fe08a';
  textCtx.textBaseline = 'middle';
  textCtx.fillText(line, fs / 2, fs);
}

async function start() {
  settings = await window.desk.getSettings();
  window.desk.onSettings((s) => {
    const cellChanged = s.cell !== settings.cell || s.preset !== settings.preset;
    settings = s;
    if (cellChanged) applyCharset();
  });
  window.desk.onRecapture(() => recapture());
  applyCharset();
  resize();

  try { await capture(); }
  catch (e) {
    if (SELFTEST || PROBE) throw e; // report the failure instead of retrying forever
    await recapture();
  }
  requestAnimationFrame(tick);
}

let cursorPos = { x: 0, y: 0, dpr: 1 };
let cursorBusy = false;
async function pollCursor() {
  if (cursorBusy || !window.desk) return;
  cursorBusy = true;
  try { cursorPos = await window.desk.getCursor(); } catch { /* main gone */ }
  cursorBusy = false;
}
setInterval(pollCursor, 16);

let frames = 0, emaMs = 16.7, last = performance.now();
function tick(t) {
  emaMs = emaMs * 0.92 + (t - last) * 0.08;
  last = t;
  if (video.readyState >= 2 && video.videoWidth) {
    const textOn = settings.cursorOn || settings.debug;
    if (textOn) {
      textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
      if (settings.cursorOn) {
        // cursor pos arrives in display DIPs; canvas is physical px
        const k = (window.devicePixelRatio || 1);
        cursor.update({ x: cursorPos.x * k, y: cursorPos.y * k, css: 'default' });
        cursor.draw(textCtx, settings.cell, t);
      }
      if (settings.debug) drawDebug();
    }
    renderer.render(video, video.videoWidth, video.videoHeight,
      { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight }, {
        colorMode: settings.colorMode,
        invert: settings.invert,
        gain: gainNow(),
        gamma: gammaNow(),
        ink: [0.55, 1.0, 0.55],
        bg: [0.02, 0.045, 0.02],
        textLayer: textOn ? textCanvas : null,
      });
    if (SELFTEST || PROBE) {
      frames++;
      if (frames === REPORT_AT) {
        const gl = renderer.gl;
        const w = outCanvas.width, h = outCanvas.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let lit = 0;
        for (let i = 0; i < w * h; i++) if (px[i * 4 + 1] > 60) lit++;
        let videoPng = null;
        let feedback = null;
        if (PROBE) {
          // the raw captured frame — ground truth for what the capture sees
          const s = Math.min(1, 1280 / video.videoWidth);
          const vc = document.createElement('canvas');
          vc.width = Math.round(video.videoWidth * s);
          vc.height = Math.round(video.videoHeight * s);
          const vctx = vc.getContext('2d');
          vctx.drawImage(video, 0, 0, vc.width, vc.height);
          videoPng = vc.toDataURL('image/png');
          // self-capture litmus: our output is green-on-black — if the captured
          // frame is dark AND green-dominant, the capture is seeing the overlay
          const vd = vctx.getImageData(0, 0, vc.width, vc.height).data;
          let r = 0, g = 0, b = 0;
          for (let i = 0; i < vd.length; i += 4) { r += vd[i]; g += vd[i + 1]; b += vd[i + 2]; }
          const n = vd.length / 4;
          feedback = {
            videoRGB: [+(r / n / 255).toFixed(4), +(g / n / 255).toFixed(4), +(b / n / 255).toFixed(4)],
            greenDominance: +(g / Math.max(1, (r + b) / 2)).toFixed(2),
            selfCaptureSuspected: g > ((r + b) / 2) * 1.5 && (g / n / 255) < 0.25,
          };
        }
        window.desk.report({
          stats: {
            ok: true,
            videoSize: [video.videoWidth, video.videoHeight],
            canvasSize: [w, h],
            fps: +(1000 / emaMs).toFixed(1),
            litFrac: +(lit / (w * h)).toFixed(3),
            cells: [Math.floor(w / settings.cell), Math.floor(h / settings.cell)],
            videoAvgLum: +expo.avg.toFixed(4),
            videoMaxLum: +expo.max.toFixed(3),
            autoGain: +expo.gain.toFixed(2),
            gainApplied: +gainNow().toFixed(2),
            recaptures,
            ...(feedback || {}),
          },
          png: outCanvas.toDataURL('image/png'),
          videoPng,
        });
        return; // main quits the app
      }
    }
  }
  requestAnimationFrame(tick);
}

start().catch((e) => {
  if ((SELFTEST || PROBE) && window.desk) window.desk.report({ stats: { ok: false, error: String(e && e.message || e) } });
  else document.title = 'capture failed: ' + e;
});

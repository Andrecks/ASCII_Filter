// CursorLayer — the pointer rendered inside the ASCII aesthetic: an inverse block
// snapped to the cell grid, whose glyph mirrors the real CSS cursor state, plus a
// short ripple on click. Coordinates are OUTPUT-canvas pixels (callers map).
const GLYPHS = [
  ['pointer', '>'],
  ['text', '|'],
  ['vertical-text', '-'],
  ['grabbing', '%'],
  ['grab', '%'],
  ['not-allowed', 'x'],
  ['no-drop', 'x'],
  ['wait', '~'],
  ['progress', '~'],
  ['crosshair', '+'],
  ['move', '+'],
  ['all-scroll', '+'],
];

export class CursorLayer {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.css = 'default';
    this.pressed = false;
    this.clickT = -1e9;
    this.clickX = 0;
    this.clickY = 0;
  }

  update(p) { Object.assign(this, p); this.active = true; }
  leave() { this.active = false; }
  press(x, y) { this.pressed = true; this.clickT = performance.now(); this.clickX = x; this.clickY = y; }
  release() { this.pressed = false; }

  glyph() {
    for (const [k, g] of GLYPHS) if (this.css.startsWith(k)) return g;
    return '+';
  }

  draw(ctx, cell, now = performance.now()) {
    if (!this.active) return;
    const cx = Math.floor(this.x / cell) * cell;
    const cy = Math.floor(this.y / cell) * cell;

    // inverse block cell
    ctx.fillStyle = this.pressed ? 'rgba(255, 255, 210, 0.95)' : 'rgba(141, 245, 154, 0.92)';
    ctx.fillRect(cx, cy, cell, cell);
    ctx.fillStyle = '#04120a';
    ctx.font = `bold ${Math.max(6, cell - 1)}px Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.glyph(), cx + cell / 2, cy + cell / 2 + 0.5);

    // click ripple, ~320ms
    const age = now - this.clickT;
    if (age >= 0 && age < 320) {
      const k = age / 320;
      const rcx = Math.floor(this.clickX / cell) * cell + cell / 2;
      const rcy = Math.floor(this.clickY / cell) * cell + cell / 2;
      ctx.strokeStyle = `rgba(141, 245, 154, ${(1 - k).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rcx, rcy, cell * (0.5 + k * 3), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

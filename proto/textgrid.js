// Builds the current frame as an actual character grid — the "page as raw text".
// Mirrors the shader's mapping: per-cell luminance (downsampled via drawImage)
// indexed into the density-sorted ramp; rotoscoped text items are stamped into the
// grid one character per cell. Returns an array of row strings.
export function buildCharGrid(source, crop, cellW, cellH, outW, outH, ramp, opts = {}) {
  const cols = Math.max(1, Math.floor(outW / cellW));
  const rows = Math.max(1, Math.floor(outH / cellH));
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, cols, rows);
  const d = x.getImageData(0, 0, cols, rows).data;
  const N = ramp.length || 1;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let ci = 0; ci < cols; ci++) {
      const i = (r * cols + ci) * 4;
      let lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      if (opts.invert) lum = 1 - lum;
      row[ci] = ramp[Math.min(N - 1, Math.floor(lum * N))] || ' ';
    }
    grid.push(row);
  }
  if (opts.items) {
    const sx = opts.scaleX || 1, sy = opts.scaleY || 1;
    for (const it of opts.items) {
      // baseline -> the row containing the text's visual middle
      const row = Math.floor((it.y * sy - it.size * sy * 0.45) / cellH);
      if (row < 0 || row >= rows) continue;
      let col = Math.floor((it.x * sx) / cellW);
      for (const ch of it.text) {
        if (col >= cols) break;
        if (col >= 0) grid[row][col] = ch;
        col++;
      }
    }
  }
  return grid.map((r) => r.join(''));
}

// Paints "rotoscoped" text into a layer canvas: real strings drawn in terminal
// style with a dark knockout halo that suppresses the ASCII mosaic underneath.
// items: [{text, x, y, size, weight}] with y = text baseline, coords in source px.
// crop: {x, y} source-px offset of the visible region.
// scaleX/scaleY: source px -> layer canvas px.
export function paintTextLayer(ctx, items, crop, opts = {}) {
  const { scaleX = 1, scaleY = 1, ink = '#8df59a' } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!items) return;
  const cropH = H / scaleY;
  for (const it of items) {
    if (it.y < crop.y - 2 || it.y - it.size > crop.y + cropH + 2) continue;
    const size = Math.max(6, it.size * scaleY);
    ctx.font = `${it.weight ? it.weight + ' ' : ''}${size.toFixed(1)}px Consolas, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeStyle = 'rgba(2, 9, 4, 0.92)';
    const dx = (it.x - crop.x) * scaleX;
    const dy = (it.y - crop.y) * scaleY;
    // monospace is wider than most site fonts — squeeze into the item's real box
    // so neighbouring strings don't run into each other
    let f = 1;
    if (it.w) {
      const m = ctx.measureText(it.text).width;
      const targetW = it.w * scaleX;
      if (m > targetW && m > 0) f = Math.max(0.55, targetW / m);
    }
    if (f < 1) {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.scale(f, 1);
      ctx.strokeText(it.text, 0, 0);
      ctx.fillStyle = ink;
      ctx.fillText(it.text, 0, 0);
      ctx.restore();
    } else {
      ctx.strokeText(it.text, dx, dy);
      ctx.fillStyle = ink;
      ctx.fillText(it.text, dx, dy);
    }
  }
}

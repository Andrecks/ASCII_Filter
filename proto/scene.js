// Fake "web page" — an animated canvas standing in for real captured content in
// Phase 0. Mixes the things a real page has: text at several sizes, images
// (procedural photo-ish gradient), motion, hard edges, fine detail.

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.textItems = [];
    this.balls = Array.from({ length: 6 }, (_, i) => ({
      x: 60 + i * 70, y: 80 + (i % 3) * 90,
      vx: (0.6 + i * 0.13) * (i % 2 ? 1 : -1),
      vy: (0.5 + i * 0.11) * (i % 3 ? 1 : -1),
      r: 14 + i * 5,
      hue: i * 60,
    }));
  }

  draw(t) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    // rebuilt every frame — the Phase 2/3 DOM extractor will produce the same shape
    this.textItems = [];

    // page background: slow-moving diagonal gradient
    const g = ctx.createLinearGradient(0, 0, W, H);
    const shift = (Math.sin(t / 4000) + 1) / 2;
    g.addColorStop(0, `hsl(${220 + shift * 40}, 35%, ${18 + shift * 8}%)`);
    g.addColorStop(1, `hsl(${280 - shift * 40}, 30%, ${10 + shift * 6}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // "hero image": bright procedural sun over hills
    ctx.save();
    ctx.beginPath();
    ctx.rect(W - 190, 16, 174, 120);
    ctx.clip();
    const sky = ctx.createLinearGradient(0, 16, 0, 136);
    sky.addColorStop(0, '#ffd27a');
    sky.addColorStop(1, '#ff6a3d');
    ctx.fillStyle = sky;
    ctx.fillRect(W - 190, 16, 174, 120);
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath();
    ctx.arc(W - 103, 70 + Math.sin(t / 1700) * 8, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a2a4d';
    ctx.beginPath();
    ctx.moveTo(W - 190, 136);
    for (let x = 0; x <= 174; x += 6) {
      ctx.lineTo(W - 190 + x, 112 + Math.sin(x / 22 + 2) * 10);
    }
    ctx.lineTo(W - 16, 136);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // headline + body text (recorded as text items for the passthrough layer)
    const putText = (text, x, y, size, weight = '') => {
      ctx.font = `${weight ? weight + ' ' : ''}${size}px ${size > 20 ? 'Georgia, serif' : 'Arial'}`;
      ctx.fillText(text, x, y);
      this.textItems.push({ text, x, y, size, weight });
    };
    ctx.fillStyle = '#f2f2f2';
    putText('ASCII Times', 20, 48, 30, 'bold');
    ctx.fillStyle = '#c9c9c9';
    const lines = [
      'Local shader turns web into text,',
      'Русский текст остаётся читаемым,',
      'смотри — работает как есть.',
    ];
    lines.forEach((s, i) => putText(s, 20, 78 + i * 18, 13));

    // scrolling marquee (motion + text)
    ctx.fillStyle = '#0d0d16';
    ctx.fillRect(0, H - 34, W, 34);
    ctx.fillStyle = '#7fe08a';
    ctx.font = 'bold 20px Consolas, monospace';
    const msg = ' +++ BREAKING: 60 FPS +++ ГЛИФЫ ПОДОРОЖАЛИ НА 400% +++ ';
    const tw = ctx.measureText(msg).width;
    const off = (t / 12) % tw;
    ctx.fillText(msg, -off, H - 10);
    ctx.fillText(msg, -off + tw, H - 10);
    this.textItems.push({ text: msg, x: -off, y: H - 10, size: 20, weight: 'bold', mono: true });
    this.textItems.push({ text: msg, x: -off + tw, y: H - 10, size: 20, weight: 'bold', mono: true });

    // checkerboard patch (fine detail / aliasing torture)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#e8e8e8' : '#1a1a1a';
        ctx.fillRect(20 + x * 9, 150 + y * 9, 9, 9);
      }
    }

    // bouncing balls (motion + saturated color)
    for (const b of this.balls) {
      b.x += b.vx * 2.2;
      b.y += b.vy * 2.2;
      if (b.x < b.r || b.x > W - b.r) b.vx *= -1;
      if (b.y < b.r || b.y > H - 34 - b.r) b.vy *= -1;
      const rg = ctx.createRadialGradient(b.x - b.r / 3, b.y - b.r / 3, 2, b.x, b.y, b.r);
      rg.addColorStop(0, `hsl(${b.hue}, 90%, 75%)`);
      rg.addColorStop(1, `hsl(${b.hue}, 80%, 35%)`);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

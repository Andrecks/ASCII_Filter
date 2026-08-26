// AsciiRenderer — WebGL2 pipeline that turns any TexImageSource (canvas/video/image)
// into ASCII art on its own canvas. Capture-source-agnostic by design: later phases
// feed it a screen-capture <video> instead of the fake scene canvas.

const VS = `#version 300 es
void main() {
  // fullscreen triangle from gl_VertexID, no buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;      // source frame (mipmapped)
uniform sampler2D uAtlas;    // glyph strip: uGlyphCount slots of uCell px each
uniform vec2  uOutSize;      // output canvas size, px
uniform vec2  uCell;         // cell size, px
uniform vec2  uRectOrigin;   // crop origin in source UV (GL space, v up)
uniform vec2  uRectSize;     // crop size in source UV
uniform float uGlyphCount;
uniform float uLod;          // mip level that averages ~one cell of source
uniform int   uColorMode;    // 0 = mono ink, 1 = per-cell color
uniform vec3  uInk;
uniform vec3  uBg;
uniform float uInvert;       // 0 or 1
uniform float uGain;         // exposure multiplier, 1 = neutral (dark-scene lift)
uniform float uGamma;        // tone-curve exponent, 1 = linear
uniform sampler2D uText;     // text passthrough layer (output-sized, straight alpha)
uniform float uTextOn;       // 0 or 1
uniform float uMatrix;       // Matrix-rain easter egg, 0 or 1
uniform float uTime;         // seconds (pre-wrapped on CPU to keep fp32 precision)
uniform vec4  uMatrixP;      // rain params: drops/column (1..4), speed mul, trail mul, ambient
out vec4 outColor;

float hash1(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 cellIdx = floor(px / uCell);
  vec2 cellCenter = (cellIdx + 0.5) * uCell / uOutSize;      // 0..1 across output
  vec2 suv = uRectOrigin + cellCenter * uRectSize;           // into source crop
  vec3 c = textureLod(uSrc, suv, uLod).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  lum = pow(clamp(lum * uGain, 0.0, 1.0), uGamma);
  lum = mix(lum, 1.0 - lum, uInvert);
  float gi = clamp(floor(lum * uGlyphCount), 0.0, uGlyphCount - 1.0);
  float bright = 1.0;
  vec3 headTint = vec3(0.0);
  if (uMatrix > 0.5) {
    // Matrix rain over the NORMAL mosaic: the regular luminance-mapped frame
    // stays fully readable at a dim base level (uMatrixP.w), and drops LIGHT
    // CELLS UP to full brightness as they fall — bright symbols raining over
    // a dark copy of the image. Glyphs are the image's own everywhere; only
    // the 1-cell head scrambles (the classic "decoding" look).
    float rows = max(1.0, floor(uOutSize.y / uCell.y));
    float rowTop = rows - 1.0 - cellIdx.y;                   // 0 at the top edge
    float m = 0.0;
    float isHead = 0.0;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= uMatrixP.x) break;                     // density setting
      float ch = hash1(cellIdx.x * 127.1 + float(k) * 51.7); // per-drop phase
      float speed = mix(8.0, 22.0, fract(ch * 7.31)) * uMatrixP.y; // cells/sec
      float len = max(3.0, mix(10.0, 26.0, fract(ch * 3.77)) * uMatrixP.z);
      float head = mod(uTime * speed + ch * 331.7, rows + len);
      float d = head - rowTop;                               // 0 at head, grows up the trail
      if (d >= 0.0 && d < len) m = max(m, pow(1.0 - d / len, 1.6));
      if (d >= 0.0 && d < 1.0) isHead = 1.0;
    }
    if (isHead > 0.5) {
      float g = hash1(dot(vec2(cellIdx.x, rowTop * 0.37 + floor(uTime * 12.0)),
                          vec2(12.9898, 78.233)));
      gi = 1.0 + floor(g * (uGlyphCount - 1.0));
      bright = 1.0;
      headTint = vec3(0.35);
    } else {
      // dim base everywhere + the trail lifts the cell toward full brightness;
      // no extra lum scaling — the glyph itself already encodes luminance
      bright = clamp(uMatrixP.w + m * (1.0 - uMatrixP.w), 0.0, 1.0);
    }
  }
  vec2 inCell = fract(px / uCell);
  vec2 atlasUV = vec2((gi + inCell.x) / uGlyphCount, inCell.y);
  float ink = texture(uAtlas, atlasUV).r;
  vec3 inkColor = (uColorMode == 1) ? clamp(c * uGain * 1.8, 0.0, 1.0) : uInk;
  inkColor = clamp(inkColor * bright + headTint, 0.0, 1.0);
  vec3 asciiCol = mix(uBg, inkColor, ink);
  // rotoscoped text on top: halo (bg-colored, alpha) knocks out mosaic, fill is text
  vec4 txt = texture(uText, px / uOutSize) * uTextOn;
  outColor = vec4(mix(asciiCol, txt.rgb, txt.a), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class AsciiRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    this.u = {};
    for (const name of ['uSrc','uAtlas','uOutSize','uCell','uRectOrigin','uRectSize',
                        'uGlyphCount','uLod','uColorMode','uInk','uBg','uInvert',
                        'uGain','uGamma','uText','uTextOn','uMatrix','uTime','uMatrixP']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    this.vao = gl.createVertexArray();

    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.atlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    // atlas slots match output cells 1:1, NEAREST keeps glyph pixels crisp
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.textTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1x1 transparent placeholder so the sampler is always valid
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 0]));

    this.glyphCount = 0;
    this.cellW = 10;
    this.cellH = 10;
    this.charsSorted = '';
  }

  // Build the glyph strip for `charset` at cell size, auto-sorted by ink density so
  // the strip is a luminance ramp regardless of the order the user typed.
  setCharset(charset, cellW, cellH) {
    const chars = [...new Set([...charset])];
    if (chars.length < 2) chars.push(' ', '@');
    this.cellW = cellW;
    this.cellH = cellH;

    const c2d = document.createElement('canvas');
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    const baseSize = Math.max(6, Math.floor(cellH * 0.95));
    const fontFor = (px) => `${px}px Consolas, "Courier New", monospace`;
    const draw = (order) => {
      c2d.width = order.length * cellW;
      c2d.height = cellH;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c2d.width, c2d.height);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      order.forEach((ch, i) => {
        // fit wide/tall glyphs (Cyrillic caps, block elements) into their slot
        ctx.font = fontFor(baseSize);
        const m = ctx.measureText(ch);
        const gw = Math.max(m.width, 1e-3);
        const gh = Math.max((m.actualBoundingBoxAscent || baseSize * 0.8) +
                            (m.actualBoundingBoxDescent || baseSize * 0.2), 1e-3);
        const s = Math.min(1, (cellW * 0.98) / gw, (cellH * 0.98) / gh);
        if (s < 1) ctx.font = fontFor(Math.max(4, Math.floor(baseSize * s)));
        ctx.fillText(ch, i * cellW + cellW / 2, cellH / 2 + 1);
      });
    };

    draw(chars);
    const img = ctx.getImageData(0, 0, c2d.width, c2d.height).data;
    const density = chars.map((ch, i) => {
      let sum = 0;
      for (let y = 0; y < cellH; y++) {
        const row = (y * c2d.width + i * cellW) * 4;
        for (let x = 0; x < cellW; x++) sum += img[row + x * 4];
      }
      return { ch, sum };
    });
    density.sort((a, b) => a.sum - b.sum);
    const sorted = density.map(d => d.ch);
    draw(sorted);
    this.charsSorted = sorted.join('');
    this.glyphCount = sorted.length;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2d);
  }

  // source: TexImageSource; crop: {x,y,w,h} in source pixels (top-left origin);
  // opts: {colorMode, ink:[r,g,b], bg:[r,g,b], invert, textLayer: TexImageSource|null}
  render(source, srcW, srcH, crop, opts = {}) {
    const gl = this.gl;
    const outW = this.canvas.width, outH = this.canvas.height;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    if (opts.textLayer) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, opts.textLayer);
    }

    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);

    // top-left crop rect -> GL UV space (v up)
    const u0 = crop.x / srcW;
    const v0 = (srcH - (crop.y + crop.h)) / srcH;
    const su = crop.w / srcW;
    const sv = crop.h / srcH;
    // mip level whose texel covers ~one output cell of source pixels
    const lod = Math.log2(Math.max(
      this.cellW * (crop.w / outW),
      this.cellH * (crop.h / outH), 1));

    gl.uniform1i(this.u.uSrc, 0);
    gl.uniform1i(this.u.uAtlas, 1);
    gl.uniform2f(this.u.uOutSize, outW, outH);
    gl.uniform2f(this.u.uCell, this.cellW, this.cellH);
    gl.uniform2f(this.u.uRectOrigin, u0, v0);
    gl.uniform2f(this.u.uRectSize, su, sv);
    gl.uniform1f(this.u.uGlyphCount, this.glyphCount);
    gl.uniform1f(this.u.uLod, lod);
    gl.uniform1i(this.u.uColorMode, opts.colorMode | 0);
    gl.uniform3fv(this.u.uInk, opts.ink || [0.55, 1.0, 0.55]);
    gl.uniform3fv(this.u.uBg, opts.bg || [0.02, 0.04, 0.02]);
    gl.uniform1f(this.u.uInvert, opts.invert ? 1 : 0);
    gl.uniform1f(this.u.uGain, opts.gain || 1);
    gl.uniform1f(this.u.uGamma, opts.gamma || 1);
    gl.uniform1i(this.u.uText, 2);
    gl.uniform1f(this.u.uTextOn, opts.textLayer ? 1 : 0);
    gl.uniform1f(this.u.uMatrix, opts.matrix ? 1 : 0);
    // wrap so fp32 sin() hashes stay clean on long sessions; a drop teleport
    // once per ~68 min is invisible next to the constant flicker
    gl.uniform1f(this.u.uTime, (opts.time || 0) % 4096);
    gl.uniform4f(this.u.uMatrixP,
      Math.max(1, Math.min(4, opts.matrixDrops || 3)),
      opts.matrixSpeed || 1,
      opts.matrixLen || 1,
      opts.matrixAmbient == null ? 0.35 : opts.matrixAmbient);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

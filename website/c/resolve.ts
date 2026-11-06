/**
 * Glyph resolve renderer (raw WebGL2).
 *
 * Two passes. The cell pass reduces the source image to one texel per text cell:
 * tint in rgb, chosen glyph in alpha (density ramp, or a box-drawing stroke where
 * the cell sits on a strong edge, which is why UI panels come out as real line art).
 * The screen pass stamps glyphs from a texture array and cross-fades each block
 * of cells to the true image as a front sweeps across.
 */
const VS = `#version 300 es
in vec2 a;
void main(){ gl_Position = vec4(a, 0., 1.); }`;

const CELL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_a, u_b;
uniform float u_mix, u_rampN, u_lodA, u_lodB, u_edge;
uniform vec2 u_cell, u_res;
uniform vec4 u_xa, u_xb;
out vec4 o;
float luma(vec3 c){ return dot(c, vec3(.2126,.7152,.0722)); }
bool inside(vec2 uv){ return all(greaterThanEqual(uv, vec2(0.))) && all(lessThanEqual(uv, vec2(1.))); }
vec3 at(vec2 px, float lod){
  vec2 n = px / u_res;
  vec2 ua = n * u_xa.xy + u_xa.zw;
  vec3 c = inside(ua) ? textureLod(u_a, ua, u_lodA + lod).rgb : vec3(0.);
  if (u_mix > .001) {
    vec2 ub = n * u_xb.xy + u_xb.zw;
    vec3 d = inside(ub) ? textureLod(u_b, ub, u_lodB + lod).rgb : vec3(0.);
    c = mix(c, d, u_mix);
  }
  return c;
}
void main(){
  vec2 p = gl_FragCoord.xy * u_cell;
  vec3 c = at(p, 0.);
  vec2 h = u_cell * .32;
  // Cell-scale derivative on sharper samples: a one pixel divider still registers.
  float l = luma(at(p - vec2(h.x,0.), -1.)), r = luma(at(p + vec2(h.x,0.), -1.));
  float d = luma(at(p - vec2(0.,h.y), -1.)), u = luma(at(p + vec2(0.,h.y), -1.));
  float peak = max(max(l,r), max(d,u));
  vec2 g = vec2(r - l, u - d);
  float mag = length(g);
  float lum = luma(c);
  float sig = max(lum, peak * .72);
  // Dark UI lives in a narrow band near black, so spread that band before ramping.
  float t = smoothstep(.055, .62, sig);
  t = pow(t, .78);
  float idx = floor(t * (u_rampN - 1.) + .5);
  float isEdge = 0.;
  if (mag > u_edge && lum < .55) {
    float ang = atan(g.y, g.x);
    float q = abs(cos(ang)), s = abs(sin(ang));
    isEdge = 1.;
    if (q > .86) idx = u_rampN + 1.;         // vertical stroke
    else if (s > .86) idx = u_rampN;         // horizontal stroke
    else idx = (g.x * g.y > 0.) ? u_rampN + 2. : u_rampN + 3.;
  }
  // Chroma survives; grey UI gets lifted toward off-white so glyphs stay legible.
  float m = max(max(c.r,c.g),c.b);
  vec3 hue = m > .001 ? c / m : vec3(1.);
  float sat = m > .001 ? (m - min(min(c.r,c.g),c.b)) / m : 0.;
  float v = mix(.58, 1.08, pow(t, .55));
  if (isEdge > .5) v = max(v, .62);
  vec3 tint = mix(vec3(.86,.85,.88), hue, smoothstep(.08,.5,sat)) * v;
  o = vec4(tint, idx / 255.);
}`;

const SCREEN_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2D u_cellA, u_cellB, u_a, u_b;
uniform sampler2DArray u_atlas;
uniform vec2 u_res, u_sizeA, u_sizeB, u_mouse, u_block, u_dir;
uniform vec4 u_xa, u_xb;
uniform float u_mix, u_lvl, u_reveal, u_lens, u_lensR, u_time, u_gain, u_dim, u_alpha, u_flicker;
uniform vec3 u_accent, u_ink;
out vec4 o;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
bool inside(vec2 uv){ return all(greaterThanEqual(uv, vec2(0.))) && all(lessThanEqual(uv, vec2(1.))); }
vec4 glyph(sampler2D buf, vec2 size, vec2 px){
  vec2 q = px / size;
  ivec2 c = ivec2(floor(q));
  vec2 f = fract(q);
  vec4 d = texelFetch(buf, c, 0);
  float idx = floor(d.a * 255. + .5);
  if (u_flicker > 0. && hash(vec2(c) + floor(u_time * 2.5) * .37) > 1. - u_flicker * .012) idx = max(0., idx - 3.);
  float mask = textureGrad(u_atlas, vec3(f, idx), vec2(1./size.x, 0.), vec2(0., 1./size.y)).r;
  return vec4(d.rgb, mask);
}
vec3 trueColor(vec2 px){
  vec2 n = px / u_res;
  vec2 ua = n * u_xa.xy + u_xa.zw;
  vec3 c = inside(ua) ? texture(u_a, ua, -.35).rgb : u_ink;
  if (u_mix > .001) {
    vec2 ub = n * u_xb.xy + u_xb.zw;
    vec3 d = inside(ub) ? texture(u_b, ub, -.35).rgb : u_ink;
    c = mix(c, d, u_mix);
  }
  return c;
}
void main(){
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 blockId = floor(px / u_block);
  vec2 blockC = (blockId + .5) * u_block;
  float r = u_reveal;
  float k = r >= 1. ? 1. : 0.;
  float band = 0.;
  if (r > 0. && r < 1.) {
    vec2 n = blockC / u_res - .5;
    float t = (dot(n, u_dir) + .5 + hash(blockId) * .24) / 1.24;
    const float w = .035;
    float rr = r * (1. + 2. * w) - w;
    k = smoothstep(t - w, t + w, rr);
    band = smoothstep(.055, .0, abs(rr - t));
  }
  if (u_lens > .001) {
    float dist = length(blockC - u_mouse);
    float ins = smoothstep(u_lensR, u_lensR * .62, dist + hash(blockId) * u_block.x * 1.6) * u_lens;
    k = k * (1. - ins) + (1. - k) * ins;
  }
  vec3 col = u_ink;
  float alpha = 1.;
  if (k < .999) {
    vec4 ga = glyph(u_cellA, u_sizeA, px);
    vec4 gb = u_lvl > .001 ? glyph(u_cellB, u_sizeB, px) : ga;
    vec3 ca = ga.rgb * ga.a, cb = gb.rgb * gb.a;
    vec3 g = mix(ca, cb, u_lvl);
    float dimX = mix(1., smoothstep(.3, .64, px.x / u_res.x + (1. - px.y / u_res.y) * .22) * .92 + .08, u_dim);
    g *= u_gain * dimX;
    float mask = mix(ga.a, gb.a, u_lvl);
    g = mix(g, u_accent * (mask * 1.15 + .035), band);
    col = u_ink + g;
  }
  if (k > .001) col = mix(col, trueColor(px), k);
  if (u_alpha > .5) { alpha = clamp(max(max(col.r - u_ink.r, col.g - u_ink.g), col.b - u_ink.b) * 2.4, 0., 1.); col = (col - u_ink) + u_ink * (1. - alpha); }
  o = vec4(col, alpha);
}`;

/** Cell heights in CSS px. Levels cross-fade so the grid never visibly swims. */
const DEFAULT_LADDER = [20, 15, 12, 9, 7, 5, 4];
const RAMP_CANDIDATES = " .`',:;-~_=+<>/\\|!*?ri1tcolxzvunJCOQ0Z#%&8@$";
const CELL_ASPECT = 0.6;

export type Frame = { fit: "cover" | "contain"; top?: number; bottom?: number; focusX?: number; focusY?: number; zoom?: number };

type Tex = { tex: WebGLTexture; w: number; h: number };
type Buf = { fbo: WebGLFramebuffer; tex: WebGLTexture; cols: number; rows: number; cw: number; ch: number; key: string };

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): { p: WebGLProgram; u: (n: string) => WebGLUniformLocation | null } {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "a");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  const cache = new Map<string, WebGLUniformLocation | null>();
  return { p, u: (n) => { if (!cache.has(n)) cache.set(n, gl.getUniformLocation(p, n)); return cache.get(n)!; } };
}

/** Stroke tiles are drawn, not typed, so they meet edge to edge across cells. */
function drawStroke(ctx: CanvasRenderingContext2D, kind: number, w: number, h: number, y: number): void {
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(2, h * 0.075);
  ctx.beginPath();
  if (kind === 0) { ctx.moveTo(0, y + h / 2); ctx.lineTo(w, y + h / 2); }
  if (kind === 1) { ctx.moveTo(w / 2, y); ctx.lineTo(w / 2, y + h); }
  if (kind === 2) { ctx.moveTo(0, y + h); ctx.lineTo(w, y); }
  if (kind === 3) { ctx.moveTo(0, y); ctx.lineTo(w, y + h); }
  ctx.stroke();
}

type Atlas = { data: Uint8Array; w: number; h: number; layers: number; rampN: number };
let atlasCache: Atlas | null = null;

function buildAtlas(): Atlas {
  if (atlasCache) return atlasCache;
  const w = 36, h = 60;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const font = `500 ${h * 0.8}px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace`;
  const ink = (ch: string) => {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff"; ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ch, w / 2, h * 0.53);
    const px = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i]!;
    return sum / (255 * w * h);
  };
  // Order by measured ink so the ramp is monotone in whichever font actually loaded.
  const ranked = [...new Set(RAMP_CANDIDATES)].map((ch) => ({ ch, cov: ink(ch) })).sort((a, b) => a.cov - b.cov);
  const ramp: string[] = [" "];
  const targets = 22;
  const max = ranked[ranked.length - 1]!.cov;
  for (let i = 1; i < targets; i++) {
    const want = (i / (targets - 1)) * max;
    const hit = ranked.reduce((best, x) => (Math.abs(x.cov - want) < Math.abs(best.cov - want) ? x : best));
    if (!ramp.includes(hit.ch)) ramp.push(hit.ch);
  }
  const layers = ramp.length + 4;
  const sheet = document.createElement("canvas");
  sheet.width = w; sheet.height = h * layers;
  const s = sheet.getContext("2d", { willReadFrequently: true })!;
  s.fillStyle = "#000"; s.fillRect(0, 0, sheet.width, sheet.height);
  s.fillStyle = "#fff"; s.font = font; s.textAlign = "center"; s.textBaseline = "middle";
  ramp.forEach((ch, i) => s.fillText(ch, w / 2, h * i + h * 0.53));
  for (let k = 0; k < 4; k++) drawStroke(s, k, w, h, h * (ramp.length + k));
  const rgba = s.getImageData(0, 0, sheet.width, sheet.height).data;
  const data = new Uint8Array(sheet.width * sheet.height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]!;
  atlasCache = { data, w, h, layers, rampN: ramp.length };
  return atlasCache;
}

export type ResolverOptions = { ladder?: number[]; transparent?: boolean; maxDpr?: number; edge?: number; block?: number; onLost?: () => void };
export type ResolveState = {
  /** 0 pure glyphs at the coarsest level, 1 true image. */
  p: number;
  mix: number;
  gain: number;
  dim: number;
  lens: number;
  lensR: number;
  mx: number;
  my: number;
  flicker: number;
  dirX: number;
  dirY: number;
};

export class Resolver {
  readonly canvas: HTMLCanvasElement;
  readonly state: ResolveState = { p: 0, mix: 0, gain: 1, dim: 0, lens: 0, lensR: 170, mx: -9999, my: -9999, flicker: 0, dirX: 0, dirY: 1 };
  private gl: WebGL2RenderingContext;
  private cellProg: ReturnType<typeof compile>;
  private screenProg: ReturnType<typeof compile>;
  private atlas: WebGLTexture;
  private rampN: number;
  private texA: Tex | null = null;
  private texB: Tex | null = null;
  private frameA: Frame = { fit: "cover" };
  private frameB: Frame = { fit: "cover" };
  private bufs = new Map<number, Buf>();
  private ladder: number[];
  private opts: ResolverOptions;
  private dpr = 1;
  private w = 1;
  private h = 1;
  private dirty = true;
  private running = false;
  private raf = 0;
  private lost = false;
  private startedAt = performance.now();
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private visible = true;

  constructor(canvas: HTMLCanvasElement, opts: ResolverOptions = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.ladder = opts.ladder ?? DEFAULT_LADDER;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: !!opts.transparent, premultipliedAlpha: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
    if (!gl) throw new Error("no webgl2");
    this.gl = gl;
    this.cellProg = compile(gl, VS, CELL_FS);
    this.screenProg = compile(gl, VS, SCREEN_FS);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const a = buildAtlas();
    this.rampN = a.rampN;
    this.atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, a.w, a.h, a.layers, 0, gl.RED, gl.UNSIGNED_BYTE, a.data);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      this.stop();
      opts.onLost?.();
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver((es) => {
      this.visible = es[es.length - 1]!.isIntersecting;
      if (this.visible) this.start(); else this.stop();
    });
    this.io.observe(canvas);
    this.resize();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const area = r.width * r.height;
    const cap = this.opts.maxDpr ?? (area > 1.6e6 ? 1.5 : 2);
    this.dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.w = Math.max(1, Math.round(r.width * this.dpr));
    this.h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== this.w || this.canvas.height !== this.h) {
      this.canvas.width = this.w;
      this.canvas.height = this.h;
      for (const b of this.bufs.values()) { this.gl.deleteTexture(b.tex); this.gl.deleteFramebuffer(b.fbo); }
      this.bufs.clear();
    }
    this.invalidate();
  }

  upload(src: TexImageSource & { width: number; height: number }): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w: src.width, h: src.height };
  }

  setImages(a: Tex | null, fa: Frame, b: Tex | null = null, fb: Frame = fa): void {
    this.texA = a; this.frameA = fa;
    this.texB = b; this.frameB = fb;
    this.invalidate();
  }

  invalidate(): void { this.dirty = true; if (this.visible) this.start(); }

  start(): void {
    if (this.running || this.lost) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (this.dirty || this.state.flicker > 0) { this.dirty = false; this.draw(); }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }

  destroy(): void { this.stop(); this.ro.disconnect(); this.io.disconnect(); this.gl.getExtension("WEBGL_lose_context")?.loseContext(); }

  /** Maps normalised screen coordinates to image uv for a given frame policy. */
  private xform(t: Tex, f: Frame): [number, number, number, number] {
    const W = this.w, H = this.h;
    const top = (f.top ?? 0) * this.dpr, bottom = (f.bottom ?? 0) * this.dpr;
    const AH = Math.max(1, H - top - bottom);
    const scaleFit = f.fit === "cover" ? Math.max(W / t.w, AH / t.h) : Math.min(W / t.w, AH / t.h);
    const scale = scaleFit * (f.zoom ?? 1);
    const dw = t.w * scale, dh = t.h * scale;
    const fx = f.focusX ?? 0.5, fy = f.focusY ?? 0.5;
    const ox = dw > W ? Math.min(0, Math.max(W - dw, W / 2 - fx * dw)) : (W - dw) / 2;
    const oy = top + (dh > AH ? Math.min(0, Math.max(AH - dh, AH / 2 - fy * dh)) : (AH - dh) / 2);
    return [W / dw, H / dh, -ox / dw, -oy / dh];
  }

  private cellBuf(level: number): Buf {
    const heightCss = this.ladder[level]!;
    const ch = Math.max(3, Math.round(heightCss * this.dpr));
    const cw = Math.max(2, Math.round(ch * CELL_ASPECT));
    let b = this.bufs.get(level);
    if (!b) {
      const gl = this.gl;
      const cols = Math.ceil(this.w / cw) + 1, rows = Math.ceil(this.h / ch) + 1;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      b = { fbo, tex, cols, rows, cw, ch, key: "" };
      this.bufs.set(level, b);
    }
    return b;
  }

  private bind(unit: number, target: number, tex: WebGLTexture | null): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(target, tex);
  }

  /** Reduce the source to one texel per cell; cached until the image or mix changes. */
  private renderCells(b: Buf, xa: number[], xb: number[], mix: number, key: string): void {
    if (b.key === key) return;
    b.key = key;
    const gl = this.gl;
    const { p, u } = this.cellProg;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
    gl.viewport(0, 0, b.cols, b.rows);
    gl.uniform2f(u("u_cell"), b.cw, b.ch);
    gl.uniform2f(u("u_res"), this.w, this.h);
    gl.uniform1f(u("u_mix"), mix);
    gl.uniform1f(u("u_rampN"), this.rampN);
    gl.uniform1f(u("u_edge"), this.opts.edge ?? 0.085);
    gl.uniform4fv(u("u_xa"), xa);
    gl.uniform4fv(u("u_xb"), xb);
    const lod = (t: Tex | null, x: number[]) => (t ? Math.log2(Math.max(1, (t.w * x[0]! / this.w) * b.cw)) : 0);
    gl.uniform1f(u("u_lodA"), lod(this.texA, xa));
    gl.uniform1f(u("u_lodB"), lod(this.texB, xb));
    this.bind(0, gl.TEXTURE_2D, this.texA?.tex ?? null);
    this.bind(1, gl.TEXTURE_2D, (this.texB ?? this.texA)?.tex ?? null);
    gl.uniform1i(u("u_a"), 0);
    gl.uniform1i(u("u_b"), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private draw(): void {
    if (this.lost || !this.texA) return;
    const gl = this.gl;
    const s = this.state;
    const n = this.ladder.length;
    // p drives the level down the ladder; once the image has taken over, the level
    // parks at a mid size so the hover lens has readable glyphs to show.
    const pp = Math.max(0, Math.min(1, s.p));
    const descend = Math.min(1, pp / 0.78);
    const park = Math.max(1, Math.floor(n * 0.5));
    let lv = descend * (n - 1);
    if (pp > 0.94) lv = (n - 1) + ((pp - 0.94) / 0.06) * (park - (n - 1));
    const i = Math.min(n - 1, Math.floor(lv));
    const j = Math.min(n - 1, i + 1);
    const m = lv - i;
    const reveal = Math.max(0, Math.min(1, (pp - 0.3) / 0.68));

    const xa = this.xform(this.texA, this.frameA);
    const xb = this.texB ? this.xform(this.texB, this.frameB) : xa;
    const bKey = `${xa.join()}|${xb.join()}|${s.mix.toFixed(3)}|${this.bufGen(this.texA, this.texB)}`;
    const bi = this.cellBuf(i);
    const bj = this.cellBuf(j);
    this.renderCells(bi, xa, xb, s.mix, bKey);
    this.renderCells(bj, xa, xb, s.mix, bKey);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const { p, u } = this.screenProg;
    gl.useProgram(p);
    gl.uniform2f(u("u_res"), this.w, this.h);
    gl.uniform2f(u("u_sizeA"), bi.cw, bi.ch);
    gl.uniform2f(u("u_sizeB"), bj.cw, bj.ch);
    const blockH = (this.opts.block ?? 15) * this.dpr;
    gl.uniform2f(u("u_block"), Math.round(blockH * 0.8), Math.round(blockH));
    gl.uniform2f(u("u_mouse"), s.mx * this.dpr, s.my * this.dpr);
    gl.uniform2f(u("u_dir"), s.dirX, s.dirY);
    gl.uniform4fv(u("u_xa"), xa);
    gl.uniform4fv(u("u_xb"), xb);
    gl.uniform1f(u("u_mix"), s.mix);
    gl.uniform1f(u("u_lvl"), m);
    gl.uniform1f(u("u_reveal"), reveal);
    gl.uniform1f(u("u_lens"), s.lens);
    gl.uniform1f(u("u_lensR"), s.lensR * this.dpr);
    gl.uniform1f(u("u_time"), (performance.now() - this.startedAt) / 1000);
    // Small glyphs cover less of their cell, so lift them or the mid-resolve goes muddy.
    gl.uniform1f(u("u_gain"), s.gain * (1 + 1.5 * descend * descend));
    gl.uniform1f(u("u_dim"), s.dim);
    gl.uniform1f(u("u_alpha"), this.opts.transparent ? 1 : 0);
    gl.uniform1f(u("u_flicker"), s.flicker);
    gl.uniform3f(u("u_accent"), 1.0, 0.353, 0.82);
    if (this.opts.transparent) gl.uniform3f(u("u_ink"), 0, 0, 0);
    else gl.uniform3f(u("u_ink"), 0.039, 0.039, 0.047);
    this.bind(0, gl.TEXTURE_2D, bi.tex);
    this.bind(1, gl.TEXTURE_2D, bj.tex);
    this.bind(2, gl.TEXTURE_2D, this.texA.tex);
    this.bind(3, gl.TEXTURE_2D, (this.texB ?? this.texA).tex);
    this.bind(4, gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.uniform1i(u("u_cellA"), 0);
    gl.uniform1i(u("u_cellB"), 1);
    gl.uniform1i(u("u_a"), 2);
    gl.uniform1i(u("u_b"), 3);
    gl.uniform1i(u("u_atlas"), 4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private ids = new WeakMap<object, number>();
  private nextId = 1;
  private bufGen(a: Tex | null, b: Tex | null): string {
    const id = (t: Tex | null) => {
      if (!t) return 0;
      let v = this.ids.get(t);
      if (!v) { v = this.nextId++; this.ids.set(t, v); }
      return v;
    };
    return `${id(a)}/${id(b)}`;
  }
}

export function webgl2Available(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export async function loadBitmap(url: string, maxWidth?: number): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  const opts: ImageBitmapOptions = maxWidth ? { resizeWidth: maxWidth, resizeQuality: "high" } : {};
  return createImageBitmap(blob, opts);
}

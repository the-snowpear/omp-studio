import type { ActivityPhase, ActivityRetry } from "./activityStatus";

export type ActivityGlyphKind = "working" | "thinking" | "responding" | "read" | "edit" | "write"
  | "bash" | "search" | "web" | "agents" | "todo" | "retry";

/** The single mapping from the existing activity phase / tool kind to a glyph. */
export function activityGlyphFor(phase: ActivityPhase, kind?: string, retry?: ActivityRetry): ActivityGlyphKind {
  if (retry?.nextRetryAt !== undefined) return "retry";
  if (phase === "thinking" || phase === "responding") return phase;
  if (phase !== "tool") return "working";
  switch (kind) {
    case "read": return "read";
    case "edit": case "ast_edit": return "edit";
    case "write": return "write";
    case "bash": case "eval": case "debug": return "bash";
    case "grep": case "ast_grep": case "glob": case "lsp": return "search";
    case "web": case "web_search": case "browser": return "web";
    case "task": case "hub": return "agents";
    case "todo": return "todo";
    case "think": case "reflect": return "thinking";
    default: return "working";
  }
}

/** Seconds, copied from activity-glyph-mix.html's POSE table. */
export const ACTIVITY_GLYPH_POSE: Readonly<Record<ActivityGlyphKind, number>> = {
  working: .2, thinking: .55, responding: .25, read: .3, edit: 1.3, write: 1.9,
  bash: .1, search: .6, web: .5, agents: 1.9, todo: 1.4, retry: .3,
};

/** Drawing mathematics from activity-glyph-mix.html, in seconds (not UI transition durations). */
const CYCLE = {
  working: 1.9, thinking: 1.7, respondingSpeed: 1.15, read: 2.6, edit: 2.8,
  write: 3.6, bash: 1.8, blinkHz: .9, search: 3.3, web: 7, agents: 2.8,
  agentsPulse: 1.4, todo: 1.6, retry: 1.5, trailStep: .018,
} as const;

const PI = Math.PI, TAU = PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fract = (x: number) => x - Math.floor(x);
/** The prototype's cubic blend, also used between the two isolated glyph layers. */
export const activityGlyphEase = (x: number) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const ease = activityGlyphEase;
const smooth = (x: number) => x * x * (3 - 2 * x);
const backOut = (x: number) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const pop = (age: number, dur = .32) => age <= 0 ? 0 : backOut(clamp(age / dur, 0, 1));
const hash = (i: number, j: number, s: number) => fract(Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453);
const blink = (t: number) => smooth(clamp(Math.cos(TAU * t * CYCLE.blinkHz) * 2.2 + .6, 0, 1));
const gx = (i: number) => 2.2 + i * 2.9;
type Point = [number, number];
type TracePoint = [number, number, number];
type Path = (c: CanvasRenderingContext2D) => void;
const PAGE: Point[] = [[3.2, 1.6], [10, 1.6], [12.8, 4.4], [12.8, 14.4], [3.2, 14.4], [3.2, 1.6]];
const FOLD: Point[] = [[10, 1.6], [10, 4.4], [12.8, 4.4]];

/**
 * Only the twelve selected CANDS / CMT.retry draws from activity-glyph-mix.html.
 * No DOM, clock, theme or scheduling: each painter owns its canvas context.
 * Keep the prototype's <24px compensation; the product renders at 14px.
 */
export function createActivityGlyphPainter(ctx: CanvasRenderingContext2D, size = 14) {
  const G = { ctx, a: 1, small: size < 24 };
  const W = (w: number) => G.small ? w + .25 : w;
  function dot(x: number, y: number, v: number, scale = 1) {
    v = clamp(v, 0, 1); const c = G.ctx;
    c.globalAlpha = G.a * ((G.small ? .2 : .13) + (G.small ? .8 : .87) * v);
    c.beginPath(); c.arc(x, y, Math.max(.05, ((G.small ? .66 : .5) + .74 * v) * scale), 0, TAU); c.fill();
  }
  function path(fn: Path, o = 1, w = 1.35, fill = false) {
    const c = G.ctx; c.globalAlpha = G.a * clamp(o, 0, 1); c.lineWidth = W(w);
    c.beginPath(); fn(c); if (fill) c.fill(); else c.stroke();
  }
  const ln = (x1: number, y1: number, x2: number, y2: number, o = 1, w = 1.35) => path(c => { c.moveTo(x1, y1); c.lineTo(x2, y2); }, o, w);
  const poly = (pts: Point[], o = 1, w = 1.35, close = false) => path(c => { pts.forEach(([x, y], k) => k ? c.lineTo(x, y) : c.moveTo(x, y)); if (close) c.closePath(); }, o, w);
  const ring = (x: number, y: number, r: number, o = 1, w = 1.35) => path(c => c.arc(x, y, r, 0, TAU), o, w);
  const disc = (x: number, y: number, r: number, o = 1) => path(c => c.arc(x, y, r, 0, TAU), o, 0, true);
  function erase(fn: Path) {
    const c = G.ctx; c.save(); c.globalCompositeOperation = "destination-out"; c.globalAlpha = G.a;
    c.beginPath(); fn(c); c.fill(); c.restore();
  }
  function dashed(progress: number, len: number, draw: () => void) {
    const c = G.ctx; c.setLineDash([Math.max(.001, progress * len), len + 50]); draw(); c.setLineDash([]);
  }
  function grid(fn: (i: number, j: number) => number) {
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) dot(gx(i), gx(j), fn(i, j));
  }
  function pencilIcon(tx: number, ty: number, o: number) {
    const ux = .707, uy = -.707, nx = .707, ny = .707, h = 1.25;
    const C1: Point = [tx + ux * 2.2, ty + uy * 2.2], C2: Point = [tx + ux * 7.2, ty + uy * 7.2], E: Point = [tx + ux * 5.9, ty + uy * 5.9];
    const pts: Point[] = [[tx, ty], [C1[0] + nx * h, C1[1] + ny * h], [C2[0] + nx * h, C2[1] + ny * h], [C2[0] - nx * h, C2[1] - ny * h], [C1[0] - nx * h, C1[1] - ny * h]];
    erase(c => { c.moveTo(...pts[0]!); pts.slice(1).forEach(p => c.lineTo(...p)); c.closePath(); });
    poly(pts, o, 1.15, true);
    ln(C1[0] + nx * h, C1[1] + ny * h, C1[0] - nx * h, C1[1] - ny * h, o, 1);
    ln(E[0] + nx * h, E[1] + ny * h, E[0] - nx * h, E[1] - ny * h, o * .7, 1);
  }

  const CMT = {
    retry: {
      n: 28,
      ghost: () => ring(8, 8, 4.8, .1, 1),
      p: (t: number): TracePoint[] => {
        const ph = t * TAU / CYCLE.retry, a = -(ph + .8 * Math.sin(ph)) - PI / 2;
        return [[8 + 4.8 * Math.cos(a), 8 + 4.8 * Math.sin(a), 1]];
      },
    },
  };
  function comet(id: "retry", t: number) {
    const def = CMT[id], N = def.n;
    def.ghost();
    const S: TracePoint[][] = []; for (let k = 0; k <= N; k++) S.push(def.p(t - k * CYCLE.trailStep));
    for (let m = 0; m < S[0]!.length; m++) {
      for (let k = 0; k < N; k++) {
        const p0 = S[k]![m]!, p1 = S[k + 1]![m]!;
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 3.2) break;
        const q = 1 - k / N;
        ln(p0[0], p0[1], p1[0], p1[1], Math.pow(q, 1.5) * p0[2] * .95, 1.7 * q + .25);
      }
      const [x, y, o] = S[0]![m]!;
      disc(x, y, 2.7, .14 * o); disc(x, y, 1.75, .28 * o); disc(x, y, 1.05, o);
    }
  }

  const draws: Record<ActivityGlyphKind, (t: number) => void> = {
    // working=wave
    working: t => grid((i, j) => Math.pow(.5 + .5 * Math.sin(t * TAU / CYCLE.working - (i + j) * .62), 2.4)),
    // thinking=twinkle
    thinking: t => grid((i, j) => { const sp = .55 + .9 * hash(i, j, 1); return Math.pow(.5 + .5 * Math.sin(t * TAU * sp / CYCLE.thinking + hash(i, j, 2) * TAU), 5); }),
    // responding=stream
    responding: t => {
      const s = t * CYCLE.respondingSpeed, top = Math.floor(s);
      for (let n = top - 4; n <= top; n++) {
        const age = s - n, y = 12.8 - age * 3.4; if (y < 1) continue;
        const L = 5.5 + hash(n, 2, 3) * 6, g = ease(clamp(age * 1.5, 0, 1)), edge = clamp((y - 1.2) / 2.4, 0, 1), x2 = 2.4 + L * g;
        ln(2.4, y, x2, y, (n === top ? 1 : .5) * edge, 1.4);
        if (n === top) ln(x2 + 1.2, y - 1.5, x2 + 1.2, y + 1.5, g < 1 ? 1 : blink(t), 1.1);
      }
    },
    // read=doc
    read: t => {
      poly(PAGE, .5, 1.2); poly(FOLD, .5, 1.2);
      const f = fract(t / CYCLE.read), y = 2.6 + 11 * (.5 - .5 * Math.cos(f * TAU));
      [[6.6, 10.8], [9, 10.8], [11.4, 9]].forEach(([yy, x2]) => { const near = Math.exp(-((yy! - y) ** 2) / 1.6); ln(5.2, yy!, x2!, yy!, .32 + .68 * near, 1.2 + .5 * near); });
      ln(1.6, y, 14.4, y, .14, 3.2); ln(1.6, y, 14.4, y, .9, 1);
    },
    // edit=pencil
    edit: t => {
      const f = fract(t / CYCLE.edit), u = ease(clamp(f / .62, 0, 1)), fade = f > .84 ? 1 - (f - .84) / .16 : 1;
      const sq = (x: number) => 12.2 + .9 * Math.sin((x - 2.2) * 1.55), x0 = 2.2, tx = x0 + 7.2 * u;
      ln(2.2, 3.4, 9, 3.4, .32, 1.2); ln(2.2, 6.6, 7, 6.6, .32, 1.2);
      if (tx > x0 + .05) { const pts: Point[] = []; for (let k = 0; k <= 28; k++) { const x = x0 + (tx - x0) * k / 28; pts.push([x, sq(x)]); } poly(pts, fade, 1.35); }
      const lift = f > .66 ? ease(clamp((f - .66) / .2, 0, 1)) * 1.4 : 0;
      pencilIcon(tx + lift, sq(tx) - lift, f < .06 ? f / .06 : fade);
    },
    // write=newfile
    write: t => {
      const f = fract(t / CYCLE.write), fade = f > .88 ? 1 - (f - .88) / .12 : 1;
      dashed(ease(clamp(f / .28, 0, 1)), 43.2, () => poly(PAGE, .85 * fade, 1.25));
      poly(FOLD, .85 * fade * clamp((f - .22) / .08, 0, 1), 1.25);
      [[6.6, 10.8], [9, 10.8], [11.4, 8.6]].forEach(([y, x2], k) => { const g = ease(clamp((f - .3 - k * .14) / .16, 0, 1)); if (g > 0) ln(5.2, y!, 5.2 + (x2! - 5.2) * g, y!, fade, 1.35); });
    },
    // bash=prompt
    bash: t => {
      const f = fract(t / CYCLE.bash), nud = f < .2 ? Math.sin(f / .2 * PI) * .9 : 0;
      poly([[2.8 + nud, 4.4], [6.6 + nud, 8], [2.8 + nud, 11.6]], 1, 1.5);
      ln(9, 11.6, 13.2, 11.6, blink(t), 1.6);
    },
    // search=magnify
    search: t => {
      const ys = [3.6, 7.6, 11.6], ends = [13.6, 12, 13], R = 3;
      const pos = fract(t / CYCLE.search) * 3, r = Math.floor(pos), u = pos - r;
      let cx: number, cy: number;
      if (u < .82) { cx = 3.6 + 8.4 * smooth(u / .82); cy = ys[r]!; }
      else { const e = ease((u - .82) / .18), ny = ys[(r + 1) % 3]!; cx = 12 - 8.4 * e; cy = ys[r]! + (ny - ys[r]!) * e; }
      const lines = (o: number, w: number) => ys.forEach((y, k) => ln(1.8, y, ends[k]!, y, o, w));
      lines(.3, 1.2);
      const c = G.ctx;
      c.save(); c.beginPath(); c.arc(cx, cy, R - .3, 0, TAU); c.clip();
      erase(cc => cc.arc(cx, cy, R, 0, TAU));
      c.translate(cx, cy); c.scale(1.6, 1.6); c.translate(-cx, -cy); lines(.95, 1.1);
      c.restore();
      ring(cx, cy, R, 1, 1.3);
      ln(cx + (R + .2) * .707, cy + (R + .2) * .707, cx + (R + 2.2) * .707, cy + (R + 2.2) * .707, 1, 1.9);
    },
    // web=globe
    web: t => {
      const R = 6;
      ring(8, 8, R, .95, 1.3);
      ln(8 - R, 8, 8 + R, 8, .5, 1.1);
      const h = Math.sqrt(R * R - 3.6 * 3.6);
      ln(8 - h, 4.4, 8 + h, 4.4, .38, 1); ln(8 - h, 11.6, 8 + h, 11.6, .38, 1);
      for (let k = 0; k < 6; k++) {
        const lam = t * TAU / CYCLE.web + k * PI / 3, front = Math.cos(lam);
        if (front <= 0) continue;
        const rx = Math.max(.01, R * Math.abs(Math.sin(lam)));
        path(c => c.ellipse(8, 8, rx, R, 0, -PI / 2, PI / 2, Math.sin(lam) < 0), .2 + .75 * front, 1.15);
      }
    },
    // agents=fork
    agents: t => {
      const f = fract(t / CYCLE.agents), fade = f > .86 ? 1 - (f - .86) / .14 : 1;
      ring(3, 8, 1.5, fade, 1.3); disc(3, 8, .6, fade * (.5 + .5 * Math.sin(t * TAU / CYCLE.agentsPulse)));
      [[12.8, 3.4], [12.8, 8], [12.8, 12.6]].forEach(([ex, ey], k) => {
        const g = ease(clamp((f - .08 - k * .1) / .32, 0, 1)); if (g <= 0) return;
        dashed(g, 10.5, () => path(c => { c.moveTo(4.5, 8); c.bezierCurveTo(8, 8, 8.4, ey!, ex! - 1.5, ey!); }, .85 * fade, 1.25));
        const age = (f - .08 - k * .1 - .3) * 3; if (age > 0) ring(ex!, ey!, 1.4 * pop(age, .35), fade, 1.3);
      });
    },
    // todo=reorder
    todo: t => {
      const T = CYCLE.todo, s = Math.floor(t / T), u = ease(clamp((fract(t / T) - .4) / .6, 0, 1)), ys = [3.8, 8, 12.2], lens = [6.6, 5, 5.8];
      for (let i = 0; i < 3; i++) {
        const slot = ((i - s) % 3 + 3) % 3; let y: number, x = 0, o: number;
        if (slot === 0) { y = ys[0]! + (ys[2]! - ys[0]!) * u; x = 1.6 * Math.sin(u * PI); o = .95 - .55 * u; }
        else { y = ys[slot]! + (ys[slot - 1]! - ys[slot]!) * u; o = slot === 1 ? .4 + .55 * u : .4; }
        ln(6 + x, y, 6 + x + lens[i]!, y, o, 1.35); disc(3.3 + x, y, 1, o);
      }
    },
    retry: t => comet("retry", t),
  };

  return (glyph: ActivityGlyphKind, t: number, color: string): void => {
    ctx.save();
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round";
    draws[glyph](t);
    ctx.restore();
  };
}

// The camera. Scroll progress through the take picks a view (scale + offset)
// of the world; between shots the scale moves exponentially and the offset
// follows it, so every point of the scene travels in a straight line.
import { PIN_MODES, LAYOUTS } from "../shared/ui";
import { buildWorld, SENTENCE, SNAP_STEPS, WORLD, type Rect, type World, type WorldState } from "./world";

interface View {
  s: number;
  x: number;
  y: number;
}

/** Scroll progress where each shot is held, and what the slate calls it. */
export const SHOTS = [
  { name: "一句话", from: 0, to: 0.055 },
  { name: "一扇窗", from: 0.19, to: 0.335 },
  { name: "一张工作台", from: 0.455, to: 0.635 },
  { name: "一张桌面", from: 0.74, to: 0.855 },
  { name: "一个图标", from: 0.95, to: 1 },
];
const SENT_AT = 0.228;
/** Replies arrive one by one across this stretch of the hold on shot 2. */
const REPLIES = { from: 0.24, to: 0.312 };
const SNAPS_AT = [0.5, 0.548, 0.596];
const PINS_AT = [0.7, 0.752];
/** Each hold keeps creeping back by this much, so the camera never fully stops. */
const CREEP = 0.955;
const RUNTIME_FRAMES = 90 * 24;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ramp = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const smooth = (u: number) => u * u * (3 - 2 * u);
const travel = (u: number) => 0.5 - Math.cos(Math.PI * clamp(u)) / 2;

/** The view that fits focus rect `f` inside screen rect `r`. */
function fit(f: Rect, r: Rect, maxScale = Infinity, alignY = 0.5): View {
  const s = Math.min(r.w / f.w, r.h / f.h, maxScale);
  return { s, x: r.x + (r.w - f.w * s) / 2 - f.x * s, y: r.y + (r.h - f.h * s) * alignY - f.y * s };
}
/** Pull back by `k` around a screen point. */
const pull = (v: View, k: number, cx: number, cy: number): View => ({ s: v.s * k, x: cx + (v.x - cx) * k, y: cy + (v.y - cy) * k });

function between(a: View, b: View, u: number): View {
  const s = a.s * Math.pow(b.s / a.s, u);
  const k = Math.abs(b.s - a.s) < 1e-6 ? u : (s - a.s) / (b.s - a.s);
  return { s, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

export interface Take {
  world: World;
  /** Re-measure after a resize or font load. */
  measure(): void;
  /** Render scroll progress 0 to 1. */
  render(progress: number): void;
  /** Characters of the opening sentence typed so far (driven by time, not scroll). */
  setTyped(count: number): void;
}

export function createTake(stage: HTMLElement): Take {
  const world = buildWorld();
  stage.querySelector<HTMLElement>("[data-cam]")!.append(world.root);
  const caps = [...stage.querySelectorAll<HTMLElement>(".b-cap")];
  const icon = stage.querySelector<HTMLElement>("[data-icon]")!;
  const glow = stage.querySelector<HTMLElement>(".b-glow-back")!;
  const slateN = stage.querySelector<HTMLElement>("[data-slate-n]")!;
  const slateName = stage.querySelector<HTMLElement>("[data-slate-name]")!;
  const slateTc = stage.querySelector<HTMLElement>("[data-slate-tc]")!;
  const slateBar = stage.querySelector<HTMLElement>("[data-slate-bar]")!;

  // Caption furniture that mirrors the scene: layout templates and pin modes.
  const layouts = stage.querySelector<HTMLElement>("[data-layouts]")!;
  layouts.innerHTML = LAYOUTS.map((l) => `<span title="${l.name}">${l.cells.map(([x, y, w, h]) =>
    `<i style="left:calc(${x * 100}% + 3px);top:calc(${y * 100}% + 3px);width:calc(${w * 100}% - 6px);height:calc(${h * 100}% - 6px)"></i>`).join("")}</span>`).join("");
  const layoutChips = [...layouts.children] as HTMLElement[];
  const pins = stage.querySelector<HTMLElement>("[data-pins]")!;
  pins.innerHTML = PIN_MODES.map((m) => `<li>${m}</li>`).join("");
  const pinChips = [...pins.children] as HTMLElement[];

  let views: { hold: View; end: View }[] = [];
  let glowAt: { x: number; y: number; o: number }[] = [];
  let typed = 0;
  let vw = 0;
  let vh = 0;

  const measure = () => {
    vw = stage.clientWidth;
    vh = stage.clientHeight;
    const narrow = vw <= 860;
    const pad = clamp(vw * 0.052, 20, 88);
    world.set({ typed, sent: false, replies: 0, snap: 0, pins: 0 });
    const r = world.rects();
    const below = (n: number, gap: number) => caps[n]!.offsetTop + caps[n]!.offsetHeight + gap;
    const side = (capWidth: number, gap: number): Rect => {
      const x = pad + capWidth + gap;
      return { x, y: 78, w: vw - x - pad * 0.55, h: vh - 78 - 46 };
    };
    const under = (n: number): Rect => {
      const y = below(n, narrow ? 22 : 30);
      return { x: pad, y, w: vw - pad * 2, h: Math.max(140, vh - y - 62) };
    };

    // 1. The sentence spans the frame. 2. One window. 3. The workbench. 4. The desktop. 5. The icon.
    const sentenceY = vh * (narrow ? 0.74 : 0.76);
    const v1 = fit(r.sentence, { x: pad, y: sentenceY - 1, w: vw - pad * 2, h: 2e4 }, narrow ? 3 : 7, 0);
    v1.y = sentenceY - (r.sentence.y + r.sentence.h / 2) * v1.s;
    const v2 = fit(r.chat, narrow ? under(1) : side(Math.min(vw * 0.3, 440), 56));
    const ws: Rect = { x: r.app.x + 260, y: r.app.y + 38, w: r.app.w - 260, h: r.app.h - 38 };
    const v3 = narrow ? fit(ws, under(2), Infinity, 0.3) : fit(r.app, side(Math.min(vw * 0.27, 400), 44));
    const far: Rect = narrow ? { x: 760, y: 0, w: WORLD.w - 760, h: WORLD.h } : { x: -40, y: -30, w: WORLD.w + 80, h: WORLD.h + 60 };
    const v4 = fit(far, under(3), Infinity, 0.35);
    const ir = icon.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const size = icon.offsetWidth * 0.7;
    const ic = { x: ir.left - sr.left + ir.width / 2, y: ir.top - sr.top + ir.height / 2 };
    const v5 = fit(r.app, { x: ic.x - size / 2, y: ic.y - size / 2, w: size, h: size });

    const centre = (v: View, f: Rect) => ({ x: v.x + (f.x + f.w / 2) * v.s, y: v.y + (f.y + f.h / 2) * v.s });
    const subjects: [View, Rect][] = [[v1, r.sentence], [v2, r.chat], [v3, narrow ? ws : r.app], [v4, far], [v5, r.app]];
    views = subjects.map(([v, f], n) => {
      const c = centre(v, f);
      return { hold: v, end: n === 4 ? v : pull(v, CREEP, c.x, c.y) };
    });
    const strength = [0.6, 0.95, 0.7, 0.5, 1];
    glowAt = subjects.map(([v, f], n) => ({ ...centre(v, f), o: strength[n]! }));
    // In the opening the sentence fills the frame, so the light sits behind the title instead.
    glowAt[0] = { x: vw * (narrow ? 0.7 : 0.74), y: vh * 0.4, o: 0.6 };
  };

  let lastShot = -1;
  let lastSnap = -1;
  let lastPins = -1;

  const render = (p: number) => {
    if (!views.length) return;
    // Which shot is held, or which pair the camera is travelling between.
    let n = 0;
    while (n < SHOTS.length - 1 && p >= SHOTS[n + 1]!.from) n++;
    const here = SHOTS[n]!;
    const next = SHOTS[n + 1];
    let view: View;
    let mix = 0; // 0 while held on shot n, up to 1 on arrival at n + 1
    if (p <= here.to || !next) {
      view = between(views[n]!.hold, views[n]!.end, ramp(p, here.from, here.to));
    } else {
      mix = travel(ramp(p, here.to, next.from));
      view = between(views[n]!.end, views[n + 1]!.hold, mix);
    }
    world.root.style.transform = `translate(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px) scale(${view.s.toFixed(5)})`;

    const state: WorldState = {
      typed: p > 0.02 ? SENTENCE.length : typed,
      sent: p >= SENT_AT,
      replies: Math.floor(ramp(p, REPLIES.from, REPLIES.to) * world.replyCount + 1e-6),
      snap: SNAPS_AT.filter((t) => p >= t).length,
      pins: PINS_AT.filter((t) => p >= t).length,
    };
    world.set(state);

    // The rest of the app fades in as the camera leaves the single window; the monitors after that.
    const style = world.root.style;
    world.root.toggleAttribute("data-near", p < SHOTS[1]!.to + 0.012);
    world.root.toggleAttribute("data-close", p < 0.045);
    const leaving = ramp(p, SHOTS[3]!.to, SHOTS[4]!.from);
    style.setProperty("--mon", (smooth(ramp(p, SHOTS[2]!.to, SHOTS[3]!.from - 0.02)) * (1 - ramp(leaving, 0.1, 0.6))).toFixed(3));
    style.opacity = (1 - smooth(ramp(leaving, 0.62, 0.97))).toFixed(3);
    icon.style.opacity = smooth(ramp(leaving, 0.7, 1)).toFixed(3);
    icon.style.scale = (0.86 + 0.14 * smooth(ramp(leaving, 0.6, 1))).toFixed(4);

    // Brand light follows the subject.
    const ga = glowAt[n]!;
    const gb = glowAt[Math.min(n + 1, glowAt.length - 1)]!;
    glow.style.opacity = (ga.o + (gb.o - ga.o) * mix).toFixed(3);
    glow.style.transform = `translate(${(ga.x + (gb.x - ga.x) * mix - vw / 2).toFixed(1)}px, ${(ga.y + (gb.y - ga.y) * mix - vh / 2).toFixed(1)}px)`;

    // Captions: each arrives as its shot settles and leaves as the camera moves on.
    caps.forEach((cap, k) => {
      const shot = SHOTS[k]!;
      const prev = SHOTS[k - 1];
      const after = SHOTS[k + 1];
      const arrive = prev ? smooth(ramp(p, prev.to + (shot.from - prev.to) * 0.62, shot.from + 0.004)) : 1;
      const leave = after ? smooth(ramp(p, shot.to - 0.006, shot.to + (after.from - shot.to) * 0.34)) : 0;
      const o = arrive * (1 - leave);
      cap.style.opacity = o.toFixed(3);
      cap.style.transform = `translate3d(0, ${((1 - arrive) * 22 - leave * 22).toFixed(1)}px, 0)`;
      cap.toggleAttribute("data-on", o > 0.004);
      cap.inert = o < 0.5;
    });

    const shotNow = mix > 0.62 ? n + 1 : n;
    if (shotNow !== lastShot) {
      lastShot = shotNow;
      slateN.textContent = String(shotNow + 1);
      slateName.textContent = SHOTS[shotNow]!.name;
    }
    if (state.snap !== lastSnap) {
      lastSnap = state.snap;
      const active = SNAP_STEPS[state.snap]!.layout;
      layoutChips.forEach((chip, k) => chip.toggleAttribute("data-on", k === active));
    }
    if (state.pins !== lastPins) {
      lastPins = state.pins;
      // No pin → 独立窗口 (git) → 独立窗口并置顶 (terminal).
      const lit = [0, 3, 4][state.pins]!;
      pinChips.forEach((chip, k) => chip.toggleAttribute("data-on", k === lit));
    }
    const f = Math.round(clamp(p) * RUNTIME_FRAMES);
    const two = (v: number) => String(v).padStart(2, "0");
    slateTc.textContent = `00:${two(Math.floor(f / 1440))}:${two(Math.floor(f / 24) % 60)}:${two(f % 24)}`;
    slateBar.style.transform = `scaleX(${clamp(p).toFixed(4)})`;
  };

  return {
    world,
    measure,
    render,
    setTyped(count) {
      typed = count;
    },
  };
}

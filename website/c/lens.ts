// The lens: a window-shaped opening onto the real interface. The real layer
// sits exactly over the line drawing and is clipped to the lens and to every
// pinned window; frames are drawn separately so they are never clipped.
import { i } from "../shared/icons";
import type { Assembly } from "./assembly";

interface Rect { x: number; y: number; w: number; h: number }

const RADIUS = 9;
const MAX_PINS = 4;

const roundRect = ({ x, y, w, h }: Rect, r = RADIUS) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;

export function initLens(a: Assembly): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const touch = matchMedia("(hover: none)").matches;
  const hint = a.root.querySelector<HTMLElement>("[data-lens-hint]")!;
  const unpin = a.root.querySelector<HTMLButtonElement>("[data-unpin]")!;

  if (touch) hint.textContent = "镜头里是真实界面。拖动它四处看看，点一下把它钉成窗口。";

  const lens = document.createElement("div");
  lens.className = "lens";
  lens.dataset.live = "";
  if (touch) lens.dataset.touch = "";
  lens.innerHTML = `<div class="lens-bar">${i("search")}<span>真实界面</span><output></output></div>`;
  a.frames.append(lens);
  const readout = lens.querySelector("output")!;

  let lw = 320;
  let lh = 224;
  // Position of the lens centre, in drawing pixels.
  const pos = { x: 0, y: 0 };
  const vel = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  const pins: { rect: Rect; el: HTMLElement }[] = [];
  let driving = false; // the visitor is steering
  let idleAt = 0;
  let visible = true;
  let dirty = true;

  const clampTarget = () => {
    const { w, h } = a.size();
    target.x = Math.min(w - lw / 2 - 2, Math.max(lw / 2 + 2, target.x));
    target.y = Math.min(h - lh / 2 - 2, Math.max(lh / 2 + 2, target.y));
  };
  const home = () => {
    const { w, h } = a.size();
    const compact = w < 600;
    lw = compact ? 250 : 320;
    lh = compact ? 190 : 224;
    lens.style.setProperty("--lw", String(lw));
    lens.style.setProperty("--lh", String(lh));
    // Default spot: straddling the chat and the plan window.
    target.x = compact ? w * 0.56 : w * 0.6;
    target.y = compact ? h * 0.34 : h * 0.4;
    clampTarget();
    if (!pos.x) Object.assign(pos, target);
    dirty = true;
  };

  const rectOf = (): Rect => ({ x: Math.round(pos.x - lw / 2), y: Math.round(pos.y - lh / 2), w: lw, h: lh });

  const paint = () => {
    const r = rectOf();
    lens.style.transform = `translate(${r.x}px, ${r.y}px)`;
    a.real.style.clipPath = `path("${[...pins.map((p) => p.rect), r].map((x) => roundRect(x)).join("")}")`;
    readout.textContent = `x ${String(r.x).padStart(3, "0")}  y ${String(r.y).padStart(3, "0")}`;
  };

  const drift = (t: number) => {
    const { w, h } = a.size();
    const ax = (w - lw) / 2 - 12;
    const ay = (h - lh) / 2 - 12;
    target.x = w / 2 + ax * Math.sin(t * 0.00021 + 0.6);
    target.y = h / 2 + ay * Math.sin(t * 0.00033 + 2.1) * 0.82;
  };

  const tick = (t: number) => {
    requestAnimationFrame(tick);
    if (!visible) return;
    if (!driving && !reduce && t - idleAt > 1800) drift(t);
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    if (reduce) {
      if (dx || dy) {
        Object.assign(pos, target);
        dirty = true;
      }
    } else if (Math.abs(dx) + Math.abs(dy) + Math.abs(vel.x) + Math.abs(vel.y) > 0.05) {
      // A lightly damped spring: the frame trails the pointer and settles without ringing.
      vel.x = (vel.x + dx * 0.16) * 0.66;
      vel.y = (vel.y + dy * 0.16) * 0.66;
      pos.x += vel.x;
      pos.y += vel.y;
      dirty = true;
    }
    if (dirty) {
      paint();
      dirty = false;
    }
  };

  const toDrawing = (e: PointerEvent | MouseEvent) => {
    const box = a.drawing.getBoundingClientRect();
    const s = a.scale();
    return { x: (e.clientX - box.left) / s, y: (e.clientY - box.top) / s };
  };
  const steer = (p: { x: number; y: number }) => {
    driving = true;
    target.x = p.x;
    target.y = p.y;
    clampTarget();
  };
  const release = () => {
    driving = false;
    idleAt = performance.now();
  };

  const syncPins = () => {
    unpin.hidden = pins.length === 0;
    dirty = true;
  };
  const removePin = (el: HTMLElement) => {
    const at = pins.findIndex((p) => p.el === el);
    if (at === -1) return;
    pins.splice(at, 1);
    el.remove();
    syncPins();
  };
  const pin = () => {
    const rect = rectOf();
    if (pins.some((p) => Math.abs(p.rect.x - rect.x) < 12 && Math.abs(p.rect.y - rect.y) < 12)) return;
    if (pins.length >= MAX_PINS) removePin(pins[0]!.el);
    const el = document.createElement("div");
    el.className = "lens";
    el.dataset.pinned = "";
    el.style.cssText = `--lw:${rect.w};--lh:${rect.h};transform:translate(${rect.x}px, ${rect.y}px)`;
    el.innerHTML = `<div class="lens-bar">${i("pin")}<span>已钉住</span><button class="lens-close" type="button" aria-label="收起这扇窗口">${i("x")}</button></div>`;
    el.querySelector("button")!.addEventListener("click", (e) => {
      e.stopPropagation();
      removePin(el);
    });
    a.frames.insertBefore(el, lens);
    pins.push({ rect, el });
    hint.textContent = "钉住了。再去别处看看，最多留四扇。";
    syncPins();
  };
  unpin.addEventListener("click", () => {
    pins.splice(0).forEach((p) => p.el.remove());
    syncPins();
  });

  // Mouse and pen: the lens follows the pointer, a click pins it.
  a.drawing.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") steer(toDrawing(e));
  });
  a.drawing.addEventListener("pointerleave", release);
  a.drawing.addEventListener("click", (e) => {
    if ((e.target as Element).closest(".lens-close")) return;
    if (touch) {
      // A tap away from the lens sends it there; a tap on it pins (below).
      if (!(e.target as Element).closest(".lens[data-live]")) steer(toDrawing(e)), release();
      return;
    }
    pin();
  });

  // Touch: drag the lens itself, so the page still scrolls everywhere else.
  let dragFrom: { x: number; y: number; moved: boolean } | null = null;
  lens.addEventListener("pointerdown", (e) => {
    if (!touch) return;
    lens.setPointerCapture(e.pointerId);
    dragFrom = { x: e.clientX, y: e.clientY, moved: false };
  });
  lens.addEventListener("pointermove", (e) => {
    if (!dragFrom) return;
    if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) > 6) dragFrom.moved = true;
    if (dragFrom.moved) steer(toDrawing(e));
  });
  const endDrag = () => {
    if (!dragFrom) return;
    if (!dragFrom.moved) pin();
    dragFrom = null;
    release();
  };
  lens.addEventListener("pointerup", endDrag);
  lens.addEventListener("pointercancel", () => ((dragFrom = null), release()));

  // Keyboard: arrows move the lens, Enter or Space pins, Escape clears.
  a.drawing.tabIndex = 0;
  a.drawing.setAttribute("role", "group");
  a.drawing.setAttribute("aria-label", "工作台总装图。方向键移动镜头，回车把镜头钉成窗口，Esc 收起全部。");
  a.drawing.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 80 : 28;
    const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (move[e.key]) {
      steer({ x: target.x + move[e.key]![0], y: target.y + move[e.key]![1] });
    } else if (e.key === "Enter" || e.key === " ") {
      pin();
    } else if (e.key === "Escape") {
      unpin.click();
    } else return;
    e.preventDefault();
  });
  a.drawing.addEventListener("blur", release);

  a.onLayout(() => {
    pins.splice(0).forEach((p) => p.el.remove());
    syncPins();
    pos.x = 0;
    home();
  });
  new IntersectionObserver(([entry]) => (visible = entry!.isIntersecting)).observe(a.drawing);
  home();
  paint();
  requestAnimationFrame(tick);
}

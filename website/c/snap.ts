// 图 2: a window that snaps to edges and corners, and six layout templates.
import gsap from "gsap";
import { KINDS, LAYOUTS, ompWindow, type Kind } from "../shared/ui";

type Rect = [number, number, number, number]; // x, y, w, h as fractions of the stage

const ZONES: { id: string; rect: Rect; label: string }[] = [
  { id: "full", rect: [0, 0, 1, 1], label: "全屏" },
  { id: "left", rect: [0, 0, 0.5, 1], label: "左半 1/2" },
  { id: "right", rect: [0.5, 0, 0.5, 1], label: "右半 1/2" },
  { id: "tl", rect: [0, 0, 0.5, 0.5], label: "左上 1/4" },
  { id: "tr", rect: [0.5, 0, 0.5, 0.5], label: "右上 1/4" },
  { id: "bl", rect: [0, 0.5, 0.5, 0.5], label: "左下 1/4" },
  { id: "br", rect: [0.5, 0.5, 0.5, 0.5], label: "右下 1/4" },
];
const zone = (id: string) => ZONES.find((z) => z.id === id)!;
/** Where a displaced window may go, largest first. */
const REFUGES: Rect[] = [zone("left").rect, zone("right").rect, [0, 0, 1, 0.5], [0, 0.5, 1, 0.5], zone("tl").rect, zone("tr").rect, zone("bl").rect, zone("br").rect];

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

interface Win { kind: Kind; el: HTMLElement; rect: Rect; float: Rect; shown: boolean }

export function initSnap(): void {
  const stage = document.querySelector<HTMLElement>("[data-snap-stage]")!;
  const zoneEl = stage.querySelector<HTMLElement>("[data-snap-zone]")!;
  const zoneLabel = stage.querySelector<HTMLElement>("[data-snap-zone-label]")!;
  const tplHost = document.querySelector<HTMLElement>("[data-templates]")!;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let top = 10;

  const place = (w: Win, rect: Rect, animate = true) => {
    w.rect = rect;
    const to = { left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` };
    gsap.killTweensOf(w.el);
    if (animate && !reduce) gsap.to(w.el, { ...to, duration: 0.55, ease: "back.out(1.25)" });
    else gsap.set(w.el, to);
  };
  const focus = (w: Win) => {
    wins.forEach((o) => (o.el.dataset.theme = o === w ? "light" : "blueprint"));
    w.el.style.zIndex = String(++top);
  };
  const show = (w: Win, on: boolean) => {
    w.shown = on;
    w.el.hidden = !on;
  };

  const FLOATS: Rect[] = [[0.16, 0.2, 0.46, 0.62], [0.5, 0, 0.5, 1], [0.3, 0.3, 0.42, 0.5], [0.4, 0.36, 0.42, 0.5]];
  const wins: Win[] = (["chat", "plan", "browser", "git"] as Kind[]).map((kind, n) => {
    const el = document.createElement("div");
    el.className = "snap-win omp";
    el.dataset.theme = "blueprint";
    el.tabIndex = 0;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", `${KINDS[kind].title} 窗口。方向键吸附，向下键还原为浮窗。`);
    const win = ompWindow({ kind, buttons: ["max"] });
    win.querySelectorAll("button").forEach((b) => (b.tabIndex = -1));
    el.append(win);
    el.insertAdjacentHTML("beforeend", `<output class="snap-read"></output>`);
    stage.append(el);
    const w: Win = { kind, el, rect: FLOATS[n]!, float: FLOATS[n]!, shown: n < 2 };
    return w;
  });

  const setTemplate = (at: number | null) =>
    tplHost.querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-pressed", String(n === at)));

  /** Snap `w` into `rect` and move whatever it lands on to the largest free space. */
  const snap = (w: Win, rect: Rect) => {
    place(w, rect);
    if (rect[2] * rect[3] > 0.99) return; // maximised: it just covers the rest
    const taken: Rect[] = [rect];
    for (const o of wins) {
      if (o === w || !o.shown) continue;
      if (overlap(o.rect, rect) / (o.rect[2] * o.rect[3]) < 0.4) {
        taken.push(o.rect);
        continue;
      }
      const refuge = REFUGES.find((r) => taken.every((t) => overlap(r, t) < 0.001));
      if (refuge) {
        place(o, refuge);
        taken.push(refuge);
      }
    }
  };

  const zoneAt = (fx: number, fy: number): string | null => {
    const edge = 0.1;
    const corner = 0.2;
    const l = fx < edge, r = fx > 1 - edge, t = fy < edge, b = fy > 1 - edge;
    if ((l || fx < corner) && (t || fy < corner) && (l || t)) return "tl";
    if ((r || fx > 1 - corner) && (t || fy < corner) && (r || t)) return "tr";
    if ((l || fx < corner) && (b || fy > 1 - corner) && (l || b)) return "bl";
    if ((r || fx > 1 - corner) && (b || fy > 1 - corner) && (r || b)) return "br";
    if (t) return "full";
    if (l) return "left";
    if (r) return "right";
    return null;
  };
  const showZone = (id: string | null) => {
    zoneEl.hidden = !id;
    if (!id) return;
    const z = zone(id);
    Object.assign(zoneEl.style, { left: `${z.rect[0] * 100}%`, top: `${z.rect[1] * 100}%`, width: `${z.rect[2] * 100}%`, height: `${z.rect[3] * 100}%` });
    zoneLabel.textContent = z.label;
  };

  for (const w of wins) {
    const bar = w.el.querySelector<HTMLElement>(".ow-bar")!;
    const read = w.el.querySelector<HTMLElement>(".snap-read")!;
    let drag: { id: number; ox: number; oy: number; from: Rect; zone: string | null } | null = null;

    w.el.addEventListener("pointerdown", () => focus(w));
    w.el.addEventListener("focus", () => focus(w));
    bar.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      const box = stage.getBoundingClientRect();
      const fx = (e.clientX - box.left) / box.width;
      const fy = (e.clientY - box.top) / box.height;
      bar.setPointerCapture(e.pointerId);
      gsap.killTweensOf(w.el);
      // Dragging a snapped window off its slot restores its floating size, as in the app.
      const size: [number, number] = [w.float[2], w.float[3]];
      const grabX = Math.min(Math.max((fx - w.rect[0]) / w.rect[2], 0.08), 0.92) * size[0];
      drag = { id: e.pointerId, ox: grabX, oy: fy - w.rect[1], from: w.rect, zone: null };
      w.el.dataset.drag = "";
      setTemplate(null);
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const box = stage.getBoundingClientRect();
      const fx = (e.clientX - box.left) / box.width;
      const fy = (e.clientY - box.top) / box.height;
      const rect: Rect = [fx - drag.ox, Math.max(0, fy - drag.oy), w.float[2], w.float[3]];
      place(w, rect, false);
      drag.zone = e.ctrlKey || e.metaKey ? null : zoneAt(Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy)));
      showZone(drag.zone);
      read.textContent = drag.zone ? zone(drag.zone).label : `x ${Math.round(rect[0] * 100)}%  y ${Math.round(rect[1] * 100)}%`;
    });
    const end = (commit: boolean) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      delete w.el.dataset.drag;
      showZone(null);
      if (!commit) return place(w, d.from);
      if (d.zone) return snap(w, zone(d.zone).rect);
      // Left floating: keep it inside the stage and remember the spot.
      const r: Rect = [Math.min(1 - w.rect[2], Math.max(0, w.rect[0])), Math.min(1 - w.rect[3], Math.max(0, w.rect[1])), w.rect[2], w.rect[3]];
      w.float = r;
      place(w, r);
    };
    bar.addEventListener("pointerup", () => end(true));
    bar.addEventListener("pointercancel", () => end(false));
    w.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drag) return end(false);
      const to: Record<string, string> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "full" };
      if (to[e.key]) snap(w, zone(to[e.key]!).rect);
      else if (e.key === "ArrowDown") place(w, w.float);
      else return;
      setTemplate(null);
      e.preventDefault();
    });
  }

  LAYOUTS.forEach((layout, n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tpl";
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `<span class="tpl-fig">${layout.cells.map(([x, y, w, h]) => `<i style="left:${x * 100}%;top:${y * 100}%;width:calc(${w * 100}% - 3px);height:calc(${h * 100}% - 3px)"></i>`).join("")}</span>${layout.name}`;
    b.addEventListener("click", () => {
      wins.forEach((w, k) => {
        const cell = layout.cells[k];
        show(w, !!cell);
        if (cell) place(w, cell);
      });
      setTemplate(n);
    });
    tplHost.append(b);
  });

  wins.forEach((w) => {
    show(w, w.shown);
    place(w, w.rect, false);
  });
  focus(wins[0]!);
}

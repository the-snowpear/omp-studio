// A small window manager that behaves like the OMP Studio workbench:
// drag by the title bar, snap to edges and corners, pick a layout template
// from the maximize button, resize from eight directions, minimise to the
// tool shelf, and pin a window so it stays above the page.
import gsap from "gsap";
import { i } from "../shared/icons";
import { KINDS, LAYOUTS, ompWindow, type Kind } from "../shared/ui";

export type WmEvent = "snap" | "layout" | "open" | "pin" | "move";

type Cell = [number, number, number, number];
interface Rect { x: number; y: number; w: number; h: number }

interface Win {
  kind: Kind;
  el: HTMLElement;
  /** Where it is now, in px of its layer (the desk, or the viewport when pinned). */
  rect: Rect;
  /** Its last free-floating rect on the desk, restored when it leaves a snap. */
  float: Rect;
  /** Snapped cell as fractions of the desk, or null while floating. */
  cell: Cell | null;
  state: "open" | "min" | "closed";
  pinned: boolean;
  tween?: gsap.core.Tween;
}

const ZONES = {
  left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], full: [0, 0, 1, 1],
  tl: [0, 0, 0.5, 0.5], tr: [0.5, 0, 0.5, 0.5], bl: [0, 0.5, 0.5, 0.5], br: [0.5, 0.5, 0.5, 0.5],
} satisfies Record<string, Cell>;
/** Where a displaced window may go, largest first. */
const REFUGES: Cell[] = [ZONES.left, ZONES.right, [0, 0, 1, 0.5], [0, 0.5, 1, 0.5], ZONES.tl, ZONES.tr, ZONES.bl, ZONES.br];

const MARGIN = 8;
const GAP = 8;
const DOCK_SPACE = 70;
const MIN_W = 250;
const MIN_H = 150;
const DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const overlaps = (a: Cell, b: Cell) =>
  a[0] < b[0] + b[2] - 0.01 && b[0] < a[0] + a[2] - 0.01 && a[1] < b[1] + b[3] - 0.01 && b[1] < a[1] + a[3] - 0.01;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Workbench {
  private wins = new Map<Kind, Win>();
  private z = 10;
  private focused: Win | null = null;
  private picker: HTMLElement;
  private pickerFor: Win | null = null;
  private pickerTimer = 0;
  private dockKinds: Kind[];

  constructor(
    private canvas: HTMLElement,
    private pip: HTMLElement,
    private dock: HTMLElement,
    private preview: HTMLElement,
    private emit: (event: WmEvent) => void,
  ) {
    const all = Object.keys(KINDS) as Kind[];
    this.dockKinds = canvas.clientWidth < 620 ? all.filter((k) => !["plan", "logs", "changes", "files"].includes(k)) : all;
    this.buildDock();
    this.picker = this.buildPicker();
    new ResizeObserver(() => this.reflow()).observe(canvas);
    addEventListener("resize", () => this.reflowPinned());
  }

  // ---------- geometry ----------
  private area() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight - DOCK_SPACE };
  }

  private cellRect([cx, cy, cw, ch]: Cell): Rect {
    const { w, h } = this.area();
    const iw = w - MARGIN * 2;
    const ih = h - MARGIN * 2;
    const l = cx > 0.01 ? GAP / 2 : 0;
    const t = cy > 0.01 ? GAP / 2 : 0;
    const r = cx + cw < 0.99 ? GAP / 2 : 0;
    const b = cy + ch < 0.99 ? GAP / 2 : 0;
    return { x: MARGIN + cx * iw + l, y: MARGIN + cy * ih + t, w: cw * iw - l - r, h: ch * ih - t - b };
  }

  private defaults(kind: Kind): Rect {
    const { w: W, h: H } = this.area();
    if (W < 620) {
      if (kind === "chat") return { x: W * 0.03, y: 8, w: W * 0.88, h: H * 0.6 };
      if (kind === "browser") return { x: W * 0.1, y: H * 0.46, w: W * 0.87, h: H * 0.5 };
      return { x: W * 0.07, y: H * 0.16, w: W * 0.86, h: H * 0.55 };
    }
    if (kind === "chat") return { x: W * 0.05, y: H * 0.06, w: clamp(W * 0.44, 340, 470), h: clamp(H * 0.8, 380, 560) };
    if (kind === "plan") {
      const w = clamp(W * 0.4, 320, 430);
      return { x: W - w - W * 0.04, y: H * 0.03, w, h: clamp(H * 0.48, 270, 340) };
    }
    if (kind === "browser") return { x: W * 0.4, y: H * 0.5, w: clamp(W * 0.46, 340, 480), h: clamp(H * 0.44, 230, 300) };
    const n = [...this.wins.values()].filter((w) => w.state === "open").length % 5;
    return { x: W * 0.24 + n * 30, y: H * 0.12 + n * 30, w: 400, h: 300 };
  }

  /** Keep a floating rect reachable: the title bar must stay on the desk. */
  private fit(r: Rect): Rect {
    const { w: W, h: H } = this.area();
    const w = Math.min(r.w, W - MARGIN * 2);
    const h = Math.min(r.h, H - MARGIN);
    return { w, h, x: clamp(r.x, 90 - w, W - 90), y: clamp(r.y, 0, H - 40) };
  }

  private apply(win: Win) {
    const { x, y, w, h } = win.rect;
    win.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    win.el.style.width = `${w}px`;
    win.el.style.height = `${h}px`;
  }

  private moveTo(win: Win, to: Rect, delay = 0) {
    win.tween?.kill();
    if (reduced()) {
      Object.assign(win.rect, to);
      this.apply(win);
      return;
    }
    win.tween = gsap.to(win.rect, { ...to, delay, duration: 0.5, ease: "expo.out", onUpdate: () => this.apply(win) });
  }

  private reflow() {
    for (const win of this.wins.values()) {
      if (win.pinned || win.state !== "open") continue;
      win.tween?.kill();
      win.rect = win.cell ? this.cellRect(win.cell) : this.fit(win.rect);
      this.apply(win);
    }
    this.closePicker();
  }

  private reflowPinned() {
    for (const win of this.wins.values()) {
      if (!win.pinned || win.state !== "open") continue;
      win.rect.x = clamp(win.rect.x, 8, innerWidth - win.rect.w - 8);
      win.rect.y = clamp(win.rect.y, 8, innerHeight - win.rect.h - 8);
      this.apply(win);
    }
  }

  // ---------- windows ----------
  private create(kind: Kind): Win {
    const el = ompWindow({ kind });
    el.classList.add("wm-win");
    const bar = el.querySelector<HTMLElement>(".ow-bar")!;
    bar.tabIndex = 0;
    bar.setAttribute("aria-label", `${KINDS[kind].title} 窗口。方向键移动，Alt 加方向键吸附`);
    for (const dir of DIRS) {
      const handle = document.createElement("span");
      handle.className = "wm-grip";
      handle.dataset.dir = dir;
      el.append(handle);
    }
    const rect = this.defaults(kind);
    const win: Win = { kind, el, rect, float: { ...rect }, cell: null, state: "closed", pinned: false };
    this.wins.set(kind, win);

    el.addEventListener("pointerdown", () => this.focus(win), true);
    bar.addEventListener("pointerdown", (e) => this.drag(win, e));
    bar.addEventListener("dblclick", (e) => {
      if (!(e.target as Element).closest("button")) this.toggleMax(win);
    });
    bar.addEventListener("keydown", (e) => this.keys(win, e));
    el.querySelectorAll<HTMLElement>(".wm-grip").forEach((g) => g.addEventListener("pointerdown", (e) => this.resize(win, g.dataset.dir!, e)));
    el.addEventListener("click", (e) => {
      const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "close") this.close(win);
      else if (act === "min") this.minimize(win);
      // No hover on a touch screen: a tap opens the layout picker; double-tap the title bar to maximise.
      else if (act === "max" && (e as PointerEvent).pointerType === "touch" && !win.pinned) this.pickerFor === win ? this.closePicker() : this.openPicker(win);
      else if (act === "max") this.toggleMax(win);
      else if (act === "pin") this.togglePin(win);
    });
    const max = el.querySelector<HTMLElement>('[data-act="max"]')!;
    max.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || win.pinned) return;
      clearTimeout(this.pickerTimer);
      this.pickerTimer = window.setTimeout(() => this.openPicker(win), 300);
    });
    max.addEventListener("pointerleave", () => this.closePickerSoon());
    max.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || win.pinned) return;
      e.preventDefault();
      e.stopPropagation();
      this.openPicker(win);
      this.picker.querySelector<HTMLElement>("button")?.focus();
    });
    return win;
  }

  private layer(win: Win) {
    return win.pinned ? this.pip : this.canvas;
  }

  /** Position of a tool-shelf icon inside the given window's layer. */
  private iconSpot(win: Win) {
    const icon = this.dock.querySelector(`[data-kind="${win.kind}"]`) ?? this.dock;
    const a = icon.getBoundingClientRect();
    const o = this.layer(win).getBoundingClientRect();
    return { x: a.left - o.left + a.width / 2, y: a.top - o.top + a.height / 2 };
  }

  private focus(win: Win) {
    if (this.focused === win) return;
    this.focused?.el.removeAttribute("data-focused");
    this.focused = win;
    win.el.dataset.focused = "";
    win.el.style.zIndex = String(++this.z);
    this.syncDock();
  }

  private topmost(except?: Win) {
    return [...this.wins.values()]
      .filter((w) => w.state === "open" && w !== except)
      .sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
  }

  /** Open a window, flying out of its tool-shelf icon unless `quiet`. */
  open(kind: Kind, quiet = false, delay = 0) {
    const win = this.wins.get(kind) ?? this.create(kind);
    if (win.state === "open") return this.focus(win);
    win.state = "open";
    win.rect = win.cell ? this.cellRect(win.cell) : this.fit(win.float);
    this.layer(win).append(win.el);
    this.apply(win);
    this.focus(win);
    if (!reduced()) {
      const { x, y, w, h } = win.rect;
      const from = quiet
        ? `translate3d(${x}px, ${y + 34}px, 0) scale(0.97)`
        : `translate3d(${this.iconSpot(win).x - w * 0.06}px, ${this.iconSpot(win).y - h * 0.06}px, 0) scale(0.12)`;
      win.el.animate(
        [{ transform: from, opacity: 0 }, { transform: `translate3d(${x}px, ${y}px, 0) scale(1)`, opacity: 1 }],
        { duration: quiet ? 620 : 380, delay, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
      );
    }
    if (!quiet) this.emit("open");
  }

  private leave(win: Win, state: "min" | "closed") {
    if (win.state !== "open") return;
    win.tween?.kill();
    win.state = state;
    if (this.pickerFor === win) this.closePicker();
    const done = () => {
      win.el.remove();
      if (win.pinned) this.setPinned(win, false);
      if (state === "closed") win.cell = null;
    };
    if (this.focused === win) {
      win.el.removeAttribute("data-focused");
      this.focused = null;
      const next = this.topmost(win);
      if (next) this.focus(next);
    }
    this.syncDock();
    if (reduced()) return done();
    const { x, y, w, h } = win.rect;
    const spot = this.iconSpot(win);
    const to = state === "min"
      ? `translate3d(${spot.x - w * 0.06}px, ${spot.y - h * 0.06}px, 0) scale(0.12)`
      : `translate3d(${x}px, ${y + 10}px, 0) scale(0.96)`;
    win.el.animate([{ transform: `translate3d(${x}px, ${y}px, 0) scale(1)`, opacity: 1 }, { transform: to, opacity: 0 }], {
      duration: state === "min" ? 300 : 170,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "forwards",
    }).finished.then((anim) => {
      anim.cancel();
      done();
    });
  }

  private close(win: Win) { this.leave(win, "closed"); }
  private minimize(win: Win) { this.leave(win, "min"); }

  private toggleMax(win: Win) {
    if (win.pinned) this.togglePin(win);
    if (win.cell && win.cell[2] === 1 && win.cell[3] === 1) {
      win.cell = null;
      this.moveTo(win, this.fit(win.float));
    } else {
      this.snap(win, ZONES.full);
    }
  }

  private snap(win: Win, cell: Cell) {
    win.cell = cell;
    this.moveTo(win, this.cellRect(cell));
    if (cell[2] === 1 && cell[3] === 1) return;
    // A window already in that spot moves to the largest space left, rather than hiding behind.
    for (const other of this.wins.values()) {
      if (other === win || other.state !== "open" || other.pinned || !other.cell || !overlaps(other.cell, cell)) continue;
      const taken = [...this.wins.values()].filter((w) => w !== other && w.state === "open" && !w.pinned && w.cell).map((w) => w.cell!);
      const refuge = REFUGES.find((c) => taken.every((t) => !overlaps(c, t)));
      other.cell = refuge ?? null;
      this.moveTo(other, refuge ? this.cellRect(refuge) : this.fit(other.float), 0.05);
    }
  }

  private applyLayout(index: number, cellIndex: number, win: Win) {
    const cells = LAYOUTS[index]!.cells;
    const rest = cells.filter((_, n) => n !== cellIndex);
    const others = [...this.wins.values()]
      .filter((w) => w !== win && w.state === "open" && !w.pinned)
      .sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex));
    win.cell = cells[cellIndex]!;
    this.moveTo(win, this.cellRect(win.cell));
    others.forEach((other, n) => {
      const cell = rest[n];
      if (!cell) return this.minimize(other);
      other.cell = cell;
      this.moveTo(other, this.cellRect(cell), 0.05 * (n + 1));
    });
    this.closePicker();
    this.emit("layout");
  }

  // ---------- pinning ----------
  private setPinned(win: Win, pinned: boolean) {
    win.pinned = pinned;
    win.el.toggleAttribute("data-pinned", pinned);
    win.el.querySelector('[data-act="pin"]')?.setAttribute("aria-pressed", String(pinned));
  }

  private togglePin(win: Win) {
    win.tween?.kill();
    const now = win.el.getBoundingClientRect();
    if (!win.pinned) {
      if (!win.cell) win.float = { ...win.rect };
      this.setPinned(win, true);
      this.pip.append(win.el);
      win.rect = { x: now.left, y: now.top, w: now.width, h: now.height };
      this.apply(win);
      const w = Math.min(380, innerWidth - 24);
      const h = Math.min(280, innerHeight * 0.42);
      this.moveTo(win, { w, h, x: innerWidth - w - 20, y: innerHeight - h - 20 });
      this.emit("pin");
    } else {
      const o = this.canvas.getBoundingClientRect();
      this.setPinned(win, false);
      this.canvas.append(win.el);
      win.rect = { x: now.left - o.left, y: now.top - o.top, w: now.width, h: now.height };
      this.apply(win);
      this.moveTo(win, win.cell ? this.cellRect(win.cell) : this.fit(win.float));
    }
    this.focus(win);
  }

  // ---------- pointer: drag ----------
  private zoneAt(e: PointerEvent): Cell | null {
    if (e.ctrlKey || e.metaKey) return null;
    const o = this.canvas.getBoundingClientRect();
    const { w, h } = this.area();
    const x = e.clientX - o.left;
    const y = e.clientY - o.top;
    const edge = clamp(w * 0.06, 28, 64);
    const row = y < h * 0.28 ? "t" : y > h * 0.72 ? "b" : "";
    if (x < edge) return row ? ZONES[`${row}l` as "tl" | "bl"] : ZONES.left;
    if (x > w - edge) return row ? ZONES[`${row}r` as "tr" | "br"] : ZONES.right;
    if (y < edge * 0.7) return ZONES.full;
    return null;
  }

  private showPreview(cell: Cell | null, from: Rect) {
    const p = this.preview;
    if (!cell) return p.removeAttribute("data-on");
    const set = (r: Rect) => {
      p.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
      p.style.width = `${r.w}px`;
      p.style.height = `${r.h}px`;
    };
    if (!p.hasAttribute("data-on")) {
      // Grow out of the window being dragged, so the eye sees where it will land.
      p.style.transition = "none";
      set(from);
      void p.offsetWidth;
      p.style.transition = "";
      p.dataset.on = "";
    }
    set(this.cellRect(cell));
  }

  private drag(win: Win, e: PointerEvent) {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const bar = e.currentTarget as HTMLElement;
    const start = { px: e.clientX, py: e.clientY, rect: { ...win.rect }, cell: win.cell };
    let base = start.rect;
    let moving = false;
    let zone: Cell | null = null;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!moving) {
        if (Math.hypot(dx, dy) < 4) return;
        moving = true;
        bar.setPointerCapture(e.pointerId);
        win.tween?.kill();
        win.el.dataset.dragging = "";
        document.documentElement.dataset.wmDragging = "";
        if (win.cell) {
          // Leaving a snap: shrink back to the floating size under the pointer.
          const grab = (start.px - win.el.getBoundingClientRect().left) / win.rect.w;
          base = { ...win.float, x: win.rect.x + grab * (win.rect.w - win.float.w), y: win.rect.y };
          win.cell = null;
          win.rect.w = base.w;
          win.rect.h = base.h;
        }
      }
      win.rect.x = base.x + dx;
      win.rect.y = base.y + dy;
      if (win.pinned) {
        win.rect.x = clamp(win.rect.x, 8 - win.rect.w * 0.6, innerWidth - win.rect.w * 0.4);
        win.rect.y = clamp(win.rect.y, 8, innerHeight - 44);
      } else {
        win.rect.y = Math.max(win.rect.y, 0);
        zone = this.zoneAt(ev);
        this.showPreview(zone, win.rect);
      }
      this.apply(win);
    };

    const finish = (cancelled: boolean) => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", cancel);
      removeEventListener("keydown", esc, true);
      if (!moving) return;
      delete win.el.dataset.dragging;
      delete document.documentElement.dataset.wmDragging;
      this.preview.removeAttribute("data-on");
      if (cancelled) {
        win.cell = start.cell;
        this.moveTo(win, start.rect);
      } else if (zone) {
        this.snap(win, zone);
        this.emit("snap");
      } else {
        if (!win.pinned) {
          win.float = this.fit(win.rect);
          this.moveTo(win, win.float);
        }
        this.emit("move");
      }
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !moving) return;
      ev.preventDefault();
      finish(true);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", cancel);
    addEventListener("keydown", esc, true);
  }

  // ---------- pointer: resize ----------
  private resize(win: Win, dir: string, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    win.tween?.kill();
    win.cell = null;
    const start = { px: e.clientX, py: e.clientY, ...win.rect };
    win.el.dataset.dragging = "";
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      const r = win.rect;
      if (dir.includes("e")) r.w = Math.max(MIN_W, start.w + dx);
      if (dir.includes("s")) r.h = Math.max(MIN_H, start.h + dy);
      if (dir.includes("w")) {
        r.w = Math.max(MIN_W, start.w - dx);
        r.x = start.x + start.w - r.w;
      }
      if (dir.includes("n")) {
        r.h = Math.max(MIN_H, start.h - dy);
        r.y = start.y + start.h - r.h;
      }
      this.apply(win);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      delete win.el.dataset.dragging;
      if (!win.pinned) win.float = { ...win.rect };
      this.emit("move");
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  }

  // ---------- keyboard ----------
  private keys(win: Win, e: KeyboardEvent) {
    if (e.target !== e.currentTarget || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    if (e.altKey && !win.pinned) {
      if (e.key === "ArrowLeft") this.snap(win, ZONES.left);
      else if (e.key === "ArrowRight") this.snap(win, ZONES.right);
      else if (e.key === "ArrowUp") this.snap(win, ZONES.full);
      else {
        win.cell = null;
        this.moveTo(win, this.fit(win.float));
      }
      if (e.key !== "ArrowDown") this.emit("snap");
      return;
    }
    const step = e.shiftKey ? 64 : 24;
    const to = { ...win.rect };
    if (win.cell) Object.assign(to, { w: win.float.w, h: win.float.h });
    win.cell = null;
    if (e.key === "ArrowLeft") to.x -= step;
    if (e.key === "ArrowRight") to.x += step;
    if (e.key === "ArrowUp") to.y -= step;
    if (e.key === "ArrowDown") to.y += step;
    const fitted = win.pinned ? to : this.fit(to);
    if (!win.pinned) win.float = fitted;
    this.moveTo(win, fitted);
  }

  // ---------- layout picker ----------
  private buildPicker() {
    const el = document.createElement("div");
    el.className = "picker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "选择布局和位置");
    el.innerHTML = `<p>选择布局和位置</p><div class="picker-grid">${LAYOUTS.map(
      (layout, n) => `<figure><div class="picker-tile">${layout.cells
        .map(([x, y, w, h], c) => `<button type="button" data-layout="${n}" data-cell="${c}" aria-label="${layout.name}，第 ${c + 1} 格" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></button>`)
        .join("")}</div><figcaption>${layout.name}</figcaption></figure>`,
    ).join("")}</div>`;
    el.addEventListener("pointerenter", () => clearTimeout(this.pickerTimer));
    el.addEventListener("pointerleave", () => this.closePickerSoon());
    el.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-layout]");
      if (b && this.pickerFor) this.applyLayout(Number(b.dataset.layout), Number(b.dataset.cell), this.pickerFor);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const back = this.pickerFor?.el.querySelector<HTMLElement>('[data-act="max"]');
      this.closePicker();
      back?.focus();
    });
    this.canvas.append(el);
    return el;
  }

  private openPicker(win: Win) {
    if (win.state !== "open" || win.pinned) return;
    this.pickerFor = win;
    const b = win.el.querySelector('[data-act="max"]')!.getBoundingClientRect();
    const o = this.canvas.getBoundingClientRect();
    const pw = this.picker.offsetWidth;
    const ph = this.picker.offsetHeight;
    const x = clamp(b.right - o.left - pw + 34, 8, o.width - pw - 8);
    const below = b.bottom - o.top + 8;
    const y = below + ph > o.height - 8 ? Math.max(8, b.top - o.top - ph - 8) : below;
    this.picker.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.picker.dataset.on = "";
  }

  private closePicker() {
    clearTimeout(this.pickerTimer);
    this.picker.removeAttribute("data-on");
    this.pickerFor = null;
  }

  private closePickerSoon() {
    clearTimeout(this.pickerTimer);
    this.pickerTimer = window.setTimeout(() => this.closePicker(), 220);
  }

  // ---------- tool shelf ----------
  private buildDock() {
    this.dock.innerHTML = this.dockKinds
      .map((kind) => {
        const k = KINDS[kind];
        const name = kind === "chat" ? "对话" : kind === "plan" ? "计划审批" : k.title;
        return `<button type="button" class="dock-item" data-kind="${kind}" style="--tint:${k.tint}" aria-label="${name}" aria-pressed="false"><span class="dock-ico">${i(k.icon)}</span><span class="dock-tip">${name}</span></button>`;
      })
      .join("");
    const items = [...this.dock.querySelectorAll<HTMLElement>(".dock-item")];
    this.dock.addEventListener("click", (e) => {
      const kind = (e.target as Element).closest<HTMLElement>("[data-kind]")?.dataset.kind as Kind | undefined;
      if (!kind) return;
      const win = this.wins.get(kind);
      if (win?.state === "open" && this.focused === win) this.minimize(win);
      else this.open(kind);
    });
    // Icons swell under the pointer, the way a dock does.
    let frame = 0;
    this.dock.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" || reduced()) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        this.dock.dataset.live = "";
        for (const item of items) {
          const r = item.getBoundingClientRect();
          const d = Math.abs(e.clientX - (r.left + r.width / 2));
          item.style.setProperty("--grow", String(Math.exp(-(d * d) / 3200)));
        }
      });
    });
    this.dock.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      this.dock.removeAttribute("data-live");
      for (const item of items) item.style.setProperty("--grow", "0");
    });
  }

  private syncDock() {
    for (const item of this.dock.querySelectorAll<HTMLElement>(".dock-item")) {
      const win = this.wins.get(item.dataset.kind as Kind);
      item.toggleAttribute("data-open", !!win && win.state !== "closed");
      item.setAttribute("aria-pressed", String(win?.state === "open"));
    }
  }

  /** Screen rect of a window's title bar, for the first-run hint. */
  barRect(kind: Kind) {
    return this.wins.get(kind)?.el.querySelector(".ow-bar")?.getBoundingClientRect();
  }
}

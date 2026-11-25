// A window manager that behaves like the OMP Studio workbench. A window holds one tool or
// several as tabs; it is dragged by its title bar, snaps to edges and corners, joins another
// window's tabs, tiles from the layout picker, and can be pinned or popped out. The strip
// along the top of the desk lists every window, as the app's top bar does.
import gsap from "gsap";
import { a } from "../shared/app-icons";
import { t } from "../shared/i18n";
import { i as lucide } from "../shared/icons";
import { KINDS, LAYOUTS, PIN_MODES, ompWindow, windowHead, windowTab, isConversation, SOURCE, type Kind } from "../shared/ui";
import { enliven } from "./live";
import { Menu, type MenuItem } from "./menu";
import { FULL, displace, dividers, overlaps, shift, vacancy, zones, type Cell, type Divider, type ZoneName } from "./snap";
import type { Wall } from "./wall";

export type WmEvent = "snap" | "layout" | "open" | "pin" | "move" | "merge";

interface Rect { x: number; y: number; w: number; h: number }
/** Index into PIN_MODES: none, this workspace, the whole app, its own window, its own window on top. */
type PinMode = 0 | 1 | 2 | 3 | 4;

/** A tool's contents. They outlive the window they are shown in. */
interface Panel { body: HTMLElement; sub: string; float?: Rect }

interface Win {
  el: HTMLElement;
  bar: HTMLElement;
  strip: HTMLElement;
  stack: HTMLElement;
  tabs: Kind[];
  active: Kind;
  /** Where it is now, in px of its layer (the desk, or the viewport when pinned). */
  rect: Rect;
  /** Its last free-floating rect on the desk, restored when it leaves a snap. */
  float: Rect;
  /** Its snapped place, or null while floating. Kept while maximised or minimised. */
  cell: Cell | null;
  max: boolean;
  state: "open" | "min" | "closed";
  pin: PinMode;
  native?: Window;
  tween?: gsap.core.Tween;
}

const STRIP = 42;
const MARGIN = 6;
const GAP = 6;
const DOCK_SPACE = 70;
const MIN_W = 250;
const MIN_H = 150;
const DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
const ZONE_LABELS: [ZoneName, string][] = [
  ["left", t("左半", "Left half")],
  ["right", t("右半", "Right half")],
  ["tl", t("左上", "Top left")],
  ["tr", t("右上", "Top right")],
  ["bl", t("左下", "Bottom left")],
  ["br", t("右下", "Bottom right")],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const inside = (r: { left: number; top: number; right: number; bottom: number }, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

interface DocumentPip { requestWindow(o: { width: number; height: number }): Promise<Window> }
const documentPip = () => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

/** Move a surface without losing where it was scrolled to. */
function carry(el: HTMLElement, parent: HTMLElement) {
  const spots = [el, ...el.querySelectorAll<HTMLElement>("*")].filter((n) => n.scrollTop > 0).map((n) => [n, n.scrollTop] as const);
  parent.append(el);
  for (const [n, top] of spots) n.scrollTop = top;
}

export class Workbench {
  private wins: Win[] = [];
  private panels = new Map<Kind, Panel>();
  private z = 10;
  private focused: Win | null = null;
  private picker: HTMLElement;
  private pickerFor: Win | null = null;
  private pickerTimer = 0;
  private dockKinds: Kind[];
  private compact: boolean;
  private strip = document.createElement("div");
  private label = document.createElement("div");
  private assist = document.createElement("div");
  private assistFor: { cell: Cell; wins: Win[] } | null = null;
  private lines: HTMLElement[] = [];
  private menu: Menu;
  private capsules = document.createElement("div");

  constructor(
    private canvas: HTMLElement,
    private pip: HTMLElement,
    private dock: HTMLElement,
    private preview: HTMLElement,
    private wall: Wall,
    private emit: (event: WmEvent) => void,
    private say: (text: string) => void,
  ) {
    const all = Object.keys(KINDS) as Kind[];
    this.compact = canvas.clientWidth < 620;
    this.dockKinds = this.compact ? all.filter((k) => !["plan", "logs", "changes", "files"].includes(k)) : all;
    this.menu = new Menu(pip);
    this.buildStrip();
    this.buildDock();
    this.picker = this.buildPicker();
    this.label.className = "wm-label";
    this.label.setAttribute("aria-hidden", "true");
    this.assist.className = "wm-assist";
    this.assist.setAttribute("role", "region");
    this.assist.setAttribute("aria-label", t("补齐空位", "Fill empty space"));
    this.assist.addEventListener("click", (e) => this.pickAssist(e));
    canvas.append(this.label, this.assist);
    this.capsules.className = "wm-capsules";
    pip.append(this.capsules);
    new ResizeObserver(() => this.reflow()).observe(canvas);
    addEventListener("resize", () => this.reflowPinned());
    addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeAssist();
    });
    addEventListener("pointerdown", (e) => {
      if (this.assistFor && !this.assist.contains(e.target as Node)) this.closeAssist();
    }, true);
    // A window pinned to the workspace belongs to the desk: it steps aside when the desk is not on screen.
    new IntersectionObserver(([entry]) => pip.toggleAttribute("data-away", !entry!.isIntersecting), { threshold: 0.12 }).observe(canvas);
    new MutationObserver(() => {
      for (const w of this.wins) if (w.native) w.native.document.body.dataset.theme = document.documentElement.dataset.theme ?? "light";
    }).observe(document.documentElement, { attributeFilter: ["data-theme"] });
  }

  // ---------- geometry ----------
  /** The space windows live in: below the strip, above the shelf. */
  private area() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight - DOCK_SPACE - STRIP };
  }

  private cellRect([cx, cy, cw, ch]: Cell): Rect {
    const { w, h } = this.area();
    const iw = w - MARGIN * 2;
    const ih = h - MARGIN;
    const l = cx > 0.01 ? GAP / 2 : 0;
    const t = cy > 0.01 ? GAP / 2 : 0;
    const r = cx + cw < 0.99 ? GAP / 2 : 0;
    const b = cy + ch < 0.99 ? GAP / 2 : 0;
    return { x: MARGIN + cx * iw + l, y: STRIP + MARGIN + cy * ih + t, w: cw * iw - l - r, h: ch * ih - t - b };
  }

  private defaults(kind: Kind): Rect {
    const { w: W, h: H } = this.area();
    const at = (x: number, y: number, w: number, h: number): Rect => ({ x, y: STRIP + y, w, h });
    if (W < 620) {
      if (kind === "chat") return at(W * 0.03, 8, W * 0.88, H * 0.6);
      if (kind === "browser") return at(W * 0.1, H * 0.46, W * 0.87, H * 0.5);
      return at(W * 0.07, H * 0.16, W * 0.86, H * 0.55);
    }
    // One composition: the conversation stands tall on the left, the other two step down the right.
    if (kind === "chat") return at(W * 0.04, H * 0.06, clamp(W * 0.46, 340, 600), clamp(H * 0.86, 380, 720));
    if (kind === "plan") {
      const w = clamp(W * 0.42, 320, 540);
      return at(W - w - W * 0.035, H * 0.03, w, clamp(H * 0.5, 280, 420));
    }
    if (kind === "browser") return at(W * 0.525, H * 0.57, clamp(W * 0.44, 340, 640), clamp(H * 0.4, 230, 380));
    const n = this.wins.filter((w) => w.state === "open").length % 5;
    return at(W * 0.24 + n * 30, H * 0.1 + n * 30, clamp(W * 0.44, 340, 500), clamp(H * 0.52, 300, 420));
  }

  /** Keep a floating rect reachable: the title bar must stay on the desk. */
  private fit(r: Rect): Rect {
    const { w: W, h: H } = this.area();
    const w = Math.min(r.w, W - MARGIN * 2);
    const h = Math.min(r.h, H - MARGIN);
    return { w, h, x: clamp(r.x, 90 - w, W - 90), y: clamp(r.y, STRIP, STRIP + H - 40) };
  }

  private apply(win: Win) {
    // Whole pixels, so text inside a window at rest is never smeared across two.
    const { x, y, w, h } = win.rect;
    win.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    win.el.style.width = `${Math.round(w)}px`;
    win.el.style.height = `${Math.round(h)}px`;
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

  /** Where a window on the desk belongs right now. */
  private home(win: Win): Rect {
    return win.max ? this.cellRect(FULL) : win.cell ? this.cellRect(win.cell) : this.fit(win.float);
  }

  private reflow() {
    for (const win of this.wins) {
      if (win.pin || win.state !== "open") continue;
      win.tween?.kill();
      win.rect = win.max || win.cell ? this.home(win) : this.fit(win.rect);
      this.apply(win);
    }
    this.closePicker();
    this.closeAssist();
    this.drawLines();
  }

  private reflowPinned() {
    for (const win of this.wins) {
      if (!win.pin || win.native || win.state !== "open") continue;
      win.rect.x = clamp(win.rect.x, 8, innerWidth - win.rect.w - 8);
      win.rect.y = clamp(win.rect.y, 8, innerHeight - win.rect.h - 8);
      this.apply(win);
    }
  }

  /** Windows standing on the desk, frontmost first. */
  private standing(except?: Win) {
    return this.wins
      .filter((w) => w.state === "open" && !w.pin && w !== except)
      .sort((p, q) => Number(q.el.style.zIndex) - Number(p.el.style.zIndex));
  }

  private snapped(except?: Win) {
    return this.standing(except).filter((w) => w.cell && !w.max);
  }

  // ---------- tools and windows ----------
  private panel(kind: Kind): Panel {
    let panel = this.panels.get(kind);
    if (panel) return panel;
    const body = ompWindow({ kind }).querySelector<HTMLElement>(".ow-body")!;
    const made: Panel = (panel = { body, sub: KINDS[kind].sub });
    this.panels.set(kind, made);
    enliven(body, kind, (text) => {
      made.sub = text;
      const win = this.holder(kind);
      if (win) this.paint(win);
    });
    return made;
  }

  private holder(kind: Kind) {
    return this.wins.find((w) => w.tabs.includes(kind));
  }

  private create(kind: Kind, rect?: Rect): Win {
    const el = ompWindow({ kind });
    el.classList.add("wm-win");
    const bar = el.querySelector<HTMLElement>(".ow-bar")!;
    const strip = el.querySelector<HTMLElement>(".ow-tabs")!;
    const stack = el.querySelector<HTMLElement>(".ow-stack")!;
    stack.replaceChildren();
    bar.tabIndex = 0;
    strip.setAttribute("role", "tablist");
    for (const dir of DIRS) {
      const handle = document.createElement("span");
      handle.className = "wm-grip";
      handle.dataset.dir = dir;
      el.append(handle);
      handle.addEventListener("pointerdown", (e) => this.resize(win, dir, e));
    }
    const start = rect ?? this.panel(kind).float ?? this.defaults(kind);
    const win: Win = { el, bar, strip, stack, tabs: [kind], active: kind, rect: { ...start }, float: { ...start }, cell: null, max: false, state: "closed", pin: 0 };
    this.wins.push(win);

    el.addEventListener("pointerdown", () => this.focus(win), true);
    bar.addEventListener("pointerdown", (e) => {
      if (e.button === 0 && !win.native && !(e.target as Element).closest("button")) this.drag(win, e);
    });
    bar.addEventListener("dblclick", (e) => {
      if (!win.native && !(e.target as Element).closest("button")) this.toggleMax(win);
    });
    bar.addEventListener("keydown", (e) => this.keys(win, e));
    bar.addEventListener("contextmenu", (e) => {
      if (win.native) return;
      e.preventDefault();
      this.windowMenu(win, e.clientX, e.clientY);
    });
    strip.addEventListener("pointerdown", (e) => this.grabTab(win, e));
    strip.addEventListener("click", (e) => this.clickTab(win, e));
    strip.addEventListener("keydown", (e) => this.tabKeys(win, e));
    strip.addEventListener("contextmenu", (e) => {
      const kind = (e.target as Element).closest<HTMLElement>("[data-tab]")?.dataset.tab as Kind | undefined;
      if (win.native) return;
      e.preventDefault();
      if (kind) this.tabMenu(win, kind, e.clientX, e.clientY);
      else this.windowMenu(win, e.clientX, e.clientY);
    });
    el.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-act]");
      const act = button?.dataset.act;
      if (act === "close") this.close(win);
      else if (act === "min") this.minimize(win);
      // No hover on a touch screen: a tap opens the layout picker; double-tap the title bar to maximise.
      else if (act === "max" && (e as PointerEvent).pointerType === "touch" && !win.pin) this.pickerFor === win ? this.closePicker() : this.openPicker(win);
      else if (act === "max") this.toggleMax(win);
      else if (act === "pin") win.native ? this.setPin(win, 0) : this.pinMenu(win, button!);
      else if (act === "more") {
        const r = button!.getBoundingClientRect();
        if (!win.native) this.windowMenu(win, r.right, r.bottom + 4, true);
      }
    });
    const max = el.querySelector<HTMLElement>('[data-act="max"]')!;
    max.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || win.pin) return;
      clearTimeout(this.pickerTimer);
      this.pickerTimer = window.setTimeout(() => this.openPicker(win), 300);
    });
    max.addEventListener("pointerleave", () => this.closePickerSoon());
    max.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || win.pin) return;
      e.preventDefault();
      e.stopPropagation();
      this.openPicker(win);
      this.picker.querySelector<HTMLElement>("button")?.focus();
    });
    carry(this.panel(kind).body, stack);
    this.paint(win);
    return win;
  }

  private nameOf(win: Win) {
    return KINDS[win.active].title;
  }

  /** Bring a window's chrome in line with its tabs. `ghosts` are tabs about to join. */
  private paint(win: Win, ghosts: Kind[] = []) {
    const { el, active, tabs } = win;
    el.dataset.kind = active;
    el.dataset.tabs = String(tabs.length);
    el.style.setProperty("--tint", KINDS[active].tint);
    win.bar.querySelector(".ow-head")!.innerHTML = windowHead(active, { sub: this.panel(active).sub, count: tabs.length });
    win.bar.setAttribute("aria-label", t(`${KINDS[active].title} 窗口。方向键移动，Alt 加方向键吸附`, `${KINDS[active].title} window. Arrow keys move, Alt + Arrows snap`));
    for (const kind of tabs) this.panel(kind).body.hidden = kind !== active;
    win.strip.hidden = tabs.length + ghosts.length < 2;
    win.strip.innerHTML = win.strip.hidden
      ? ""
      : `${tabs.map((k) => windowTab(k, k === active && !ghosts.length)).join("")}${ghosts.map((k) => windowTab(k, false, true)).join("")}<button type="button" class="ow-btn ow-tabs-all" data-tabs-all aria-label="${t("全部标签", "All tabs")}">${a("chevron-d")}</button>`;
    for (const tab of win.strip.querySelectorAll<HTMLElement>("[role=tab]")) tab.tabIndex = tab.ariaSelected === "true" ? 0 : -1;
    const pin = win.bar.querySelector<HTMLElement>('[data-act="pin"]')!;
    pin.setAttribute("aria-pressed", String(win.pin > 0));
    pin.setAttribute("aria-label", win.native ? t("收回应用", "Return to app") : t("固定浮窗", "Pin window"));
    const maxed = win.max;
    const max = win.bar.querySelector<HTMLElement>('[data-act="max"]')!;
    max.innerHTML = a(maxed ? "restore" : "maximize");
    max.setAttribute("aria-label", maxed ? t("还原", "Restore") : t("最大化，悬停可选布局", "Maximize, hover for layouts"));
    this.drawStrip();
  }

  private activate(win: Win, kind: Kind) {
    if (win.active === kind) return;
    win.active = kind;
    this.paint(win);
    this.syncDock();
  }

  private layer(win: Win) {
    return win.pin ? this.pip : this.canvas;
  }

  /** Where a window goes when it is put away: its tab on the strip. */
  private tabSpot(win: Win) {
    const tab = this.strip.querySelector(`[data-win="${this.wins.indexOf(win)}"]`) ?? this.strip;
    const r = tab.getBoundingClientRect();
    const o = this.layer(win).getBoundingClientRect();
    return { x: r.left - o.left + r.width / 2, y: r.top - o.top + r.height / 2 };
  }

  private iconSpot(kind: Kind) {
    const r = (this.dock.querySelector(`[data-kind="${kind}"]`) ?? this.dock).getBoundingClientRect();
    const o = this.canvas.getBoundingClientRect();
    return { x: r.left - o.left + r.width / 2, y: r.top - o.top + r.height / 2 };
  }

  private focus(win: Win) {
    if (this.focused === win) return;
    this.focused?.el.removeAttribute("data-focused");
    this.focused = win;
    win.el.dataset.focused = "";
    win.el.style.zIndex = String(++this.z);
    this.syncDock();
    this.drawStrip();
    this.drawLines();
  }

  /** Show a tool, in its window or a new one, flying out of its shelf icon unless `quiet`. */
  open(kind: Kind, quiet = false, delay = 0) {
    const win = this.holder(kind) ?? this.create(kind);
    this.activate(win, kind);
    if (win.native) return win.native.focus();
    if (win.state === "open") return this.focus(win);
    this.show(win, quiet ? null : win.state === "min" ? this.tabSpot(win) : this.iconSpot(kind), delay);
    if (!quiet) this.emit("open");
  }

  private show(win: Win, from: { x: number; y: number } | null, delay = 0) {
    this.closeAssist();
    win.state = "open";
    // A place that someone else took meanwhile is not taken back.
    if (win.cell && this.snapped(win).some((o) => overlaps(o.cell!, win.cell!))) win.cell = null;
    if (!win.pin) win.rect = this.home(win);
    this.layer(win).append(win.el);
    this.apply(win);
    this.focus(win);
    this.drawStrip();
    this.drawLines();
    this.drawCapsules();
    if (reduced()) return;
    const { x, y, w, h } = win.rect;
    const start = from
      ? `translate3d(${from.x - w * 0.06}px, ${from.y - h * 0.06}px, 0) scale(0.12)`
      : `translate3d(${x}px, ${y + 34}px, 0) scale(0.97)`;
    win.el.animate(
      [{ transform: start, opacity: 0 }, { transform: `translate3d(${x}px, ${y}px, 0) scale(1)`, opacity: 1 }],
      { duration: from ? 380 : 620, delay, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
    );
  }

  private leave(win: Win, state: "min" | "closed") {
    if (win.state !== "open") return;
    win.tween?.kill();
    win.state = state;
    if (this.pickerFor === win) this.closePicker();
    this.closeAssist();
    if (this.focused === win) {
      win.el.removeAttribute("data-focused");
      this.focused = null;
      const next = this.standing(win)[0];
      if (next) this.focus(next);
    }
    const { x, y, w, h } = win.rect;
    const spot = state === "min" ? (win.pin ? this.capsuleSpot() : this.tabSpot(win)) : null;
    if (state === "closed") this.retire(win);
    this.syncDock();
    this.drawStrip();
    this.drawLines();
    this.drawCapsules();
    const done = () => {
      if (win.state !== "open") win.el.remove();
    };
    if (reduced() || win.native) return done();
    const to = spot
      ? `translate3d(${spot.x - w * 0.06}px, ${spot.y - h * 0.06}px, 0) scale(0.12)`
      : `translate3d(${x}px, ${y + 10}px, 0) scale(0.96)`;
    win.el.animate([{ transform: `translate3d(${x}px, ${y}px, 0) scale(1)`, opacity: 1 }, { transform: to, opacity: 0 }], {
      duration: spot ? 300 : 170,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "forwards",
    }).finished.then((anim) => {
      anim.cancel();
      done();
    });
  }

  /** Take a closed window out of the books. Its tools keep their contents for the next time. */
  private retire(win: Win) {
    this.wins = this.wins.filter((w) => w !== win);
    for (const kind of win.tabs) this.panel(kind).float = win.tabs.length === 1 ? { ...win.float } : undefined;
  }

  private close(win: Win) {
    const native = win.native;
    win.native = undefined;
    this.leave(win, "closed");
    native?.close();
  }

  private minimize(win: Win) { this.leave(win, "min"); }

  private toggleMax(win: Win) {
    if (win.pin) return this.setPin(win, 0);
    win.max = !win.max;
    this.focus(win);
    this.paint(win);
    this.moveTo(win, this.home(win));
    this.drawLines();
  }

  // ---------- tabs ----------
  /** Put every tab of `from` into `to`, at `index` or the end. */
  private merge(from: Win, to: Win, index = to.tabs.length) {
    const top = this.focused === from;
    to.tabs.splice(index, 0, ...from.tabs);
    for (const kind of from.tabs) carry(this.panel(kind).body, to.stack);
    to.active = from.active;
    this.wins = this.wins.filter((w) => w !== from);
    from.tween?.kill();
    from.el.remove();
    from.state = "closed";
    if (top) this.focused = null;
    this.focus(to);
    this.paint(to);
    this.syncDock();
    this.drawLines();
    const tab = to.strip.querySelector<HTMLElement>(`[data-tab="${to.active}"]`);
    if (!reduced()) tab?.animate([{ scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1 }], { duration: 320, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
  }

  /** Take one tab out into a window of its own. */
  private split(win: Win, kind: Kind, rect: Rect): Win {
    win.tabs = win.tabs.filter((k) => k !== kind);
    if (win.active === kind) win.active = win.tabs.at(-1)!;
    const next = this.create(kind, rect);
    next.state = "open";
    next.pin = win.pin;
    this.paint(win);
    this.layer(next).append(next.el);
    this.apply(next);
    this.focus(next);
    this.drawStrip();
    return next;
  }

  private hideTab(win: Win, kind: Kind) {
    if (win.tabs.length === 1) return this.close(win);
    const at = win.tabs.indexOf(kind);
    win.tabs = win.tabs.filter((k) => k !== kind);
    if (win.active === kind) win.active = win.tabs[Math.min(at, win.tabs.length - 1)]!;
    this.panel(kind).body.remove();
    this.paint(win);
    this.syncDock();
  }

  private addTab(win: Win, kind: Kind) {
    const from = this.holder(kind);
    if (from === win) return this.activate(win, kind);
    if (from) return from.tabs.length === 1 ? this.merge(from, win) : this.merge(this.split(from, kind, { ...win.rect }), win);
    this.merge(this.create(kind), win);
    return;
  }

  private clickTab(win: Win, e: MouseEvent) {
    const target = e.target as Element;
    const tab = target.closest<HTMLElement>("[data-tab]");
    if (target.closest("[data-tabs-all]")) {
      const b = target.closest<HTMLElement>("[data-tabs-all]")!;
      const r = b.getBoundingClientRect();
      if (win.native) return;
      return this.menu.open(r.right, r.bottom + 4, t("全部标签", "All tabs"), [
        ...win.tabs.map((k): MenuItem => ({ label: KINDS[k].title, icon: KINDS[k].icon, checked: k === win.active, run: () => this.activate(win, k) })),
        { label: t("添加工具", "Add tool"), icon: "plus", rule: true, items: this.addable(win) },
      ], { alignRight: true, back: b });
    }
    if (!tab) return;
    const kind = tab.dataset.tab as Kind;
    if (target.closest("[data-tab-close]")) return this.hideTab(win, kind);
    this.activate(win, kind);
  }

  private tabKeys(win: Win, e: KeyboardEvent) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (e.key === "Delete") {
      e.preventDefault();
      return this.hideTab(win, win.active);
    }
    if (!step || !(e.target as Element).closest("[role=tab]")) return;
    e.preventDefault();
    const at = win.tabs.indexOf(win.active);
    if (e.altKey) this.reorder(win, win.active, at + step);
    else this.activate(win, win.tabs[(at + step + win.tabs.length) % win.tabs.length]!);
    win.strip.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }

  private reorder(win: Win, kind: Kind, to: number) {
    const at = win.tabs.indexOf(kind);
    if (to < 0 || to >= win.tabs.length || to === at) return;
    const before = new Map([...win.strip.querySelectorAll<HTMLElement>("[data-tab]")].map((t) => [t.dataset.tab, t.getBoundingClientRect().left]));
    win.tabs.splice(at, 1);
    win.tabs.splice(to, 0, kind);
    this.paint(win);
    if (reduced()) return;
    for (const tab of win.strip.querySelectorAll<HTMLElement>("[data-tab]")) {
      const dx = before.get(tab.dataset.tab)! - tab.getBoundingClientRect().left;
      if (dx) tab.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
  }

  /** A tab under the hand: along the strip it changes places, off the strip it becomes a window. */
  private grabTab(win: Win, e: PointerEvent) {
    const target = e.target as Element;
    if (e.button !== 0 || win.native) return;
    const tab = target.closest<HTMLElement>("[data-tab]");
    // The bare part of the strip carries the whole window, like the title bar.
    if (!tab) return target.closest("button") ? undefined : this.drag(win, e);
    if (target.closest("[data-tab-close]")) return;
    const kind = tab.dataset.tab as Kind;
    const width = tab.offsetWidth;
    let sorting = false;
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      removeEventListener("pointercancel", stop);
      delete document.documentElement.dataset.wmDragging;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const far = Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY);
      if (!sorting && far < 6) return;
      if (!sorting) {
        sorting = true;
        document.documentElement.dataset.wmDragging = "";
        this.activate(win, kind);
      }
      const r = win.strip.getBoundingClientRect();
      if (ev.clientY > r.top - 16 && ev.clientY < r.bottom + 16 && ev.clientX > r.left - 24 && ev.clientX < r.right + 24) {
        const tabs = [...win.strip.querySelectorAll<HTMLElement>("[data-tab]")];
        const at = win.tabs.indexOf(kind);
        const over = tabs.findIndex((t) => {
          const b = t.getBoundingClientRect();
          // Past the middle of a neighbour, so two tabs of unequal width do not trade places back and forth.
          return at < win.tabs.indexOf(t.dataset.tab as Kind) ? ev.clientX > b.left + b.width / 2 && ev.clientX < b.right + width : ev.clientX < b.left + b.width / 2 && ev.clientX > b.left - width;
        });
        if (over >= 0 && over !== at) this.reorder(win, kind, over);
        return;
      }
      stop();
      const index = win.tabs.indexOf(kind);
      const o = this.layer(win).getBoundingClientRect();
      const size = win.max || win.cell ? this.defaults(kind) : win.rect;
      const next = this.split(win, kind, { w: size.w, h: size.h, x: ev.clientX - o.left - 70, y: ev.clientY - o.top - 17 });
      this.drag(next, ev, () => this.merge(next, win, index));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop);
    addEventListener("pointercancel", stop);
  }

  // ---------- menus ----------
  /** Tools that could join a window, the ones without a window first. */
  private addable(win: Win): MenuItem[] {
    return this.dockKinds
      .filter((k) => !win.tabs.includes(k) && !isConversation(k))
      .map((k) => ({ label: KINDS[k].title, icon: KINDS[k].icon, run: () => this.addTab(win, k) }));
  }

  private snapItems(win: Win): MenuItem[] {
    return [
      ...ZONE_LABELS.map(([name, label]): MenuItem => ({ label, run: () => {
        this.snap(win, zones(this.snapped(win).map((w) => w.cell!))[name]);
        this.emit("snap");
      } })),
      { label: t("浮窗", "Float"), run: () => {
        win.cell = null;
        win.max = false;
        this.paint(win);
        this.moveTo(win, this.home(win));
        this.drawLines();
      } },
    ];
  }

  private windowMenu(win: Win, x: number, y: number, alignRight = false) {
    const others = this.standing(win);
    const joins: MenuItem[] = others.map((o) => ({ label: t(`合并到「${this.nameOf(o)}」`, `Merge into "${this.nameOf(o)}"`), icon: KINDS[o.active].icon, run: () => {
      this.merge(win, o);
      this.emit("merge");
    } }));
    if (win.tabs.length > 1) joins.unshift({ label: t("每个标签拆成一个窗口", "Split every tab into windows"), icon: "split", run: () => this.scatter(win) });
    this.menu.open(x, y, win.tabs.length > 1 ? t("整组操作", "Window group") : KINDS[win.active].title, [
      { label: t("添加工具", "Add tool"), icon: "plus", items: this.addable(win) },
      ...(win.pin ? [] : [{ label: win.tabs.length > 1 ? t("整组移动到", "Snap group to") : t("移动到", "Snap to"), icon: "handoff" as const, items: this.snapItems(win) }]),
      ...(joins.length && !win.pin ? [{ label: t("拆分与合并", "Split & merge"), icon: "split" as const, items: joins }] : []),
      { label: win.tabs.length > 1 ? t("隐藏整组", "Hide group") : isConversation(win.active) ? t("关闭对话视图", "Close chat view") : t("隐藏工具", "Hide tool"), icon: "eye-off", rule: true, run: () => this.close(win) },
    ], { alignRight, back: win.bar });
  }

  private tabMenu(win: Win, kind: Kind, x: number, y: number) {
    const at = win.tabs.indexOf(kind);
    const others = this.standing(win);
    this.menu.open(x, y, KINDS[kind].title, [
      { label: t("移动到", "Move to"), icon: "handoff", items: [
        { label: t("单独的浮窗", "New floating window"), icon: "external", run: () => this.popTab(win, kind) },
        ...others.map((o): MenuItem => ({ label: t(`「${this.nameOf(o)}」的标签组`, `"${this.nameOf(o)}" tab group`), icon: KINDS[o.active].icon, run: () => this.addTab(o, kind) })),
      ] },
      { label: t("向前排列", "Move tab left"), icon: "arrow-u", disabled: at === 0 ? t("已经在最前面", "Already first") : undefined, run: () => this.reorder(win, kind, at - 1) },
      { label: t("向后排列", "Move tab right"), icon: "arrow-d", disabled: at === win.tabs.length - 1 ? t("已经在最后面", "Already last") : undefined, run: () => this.reorder(win, kind, at + 1) },
      { label: t("隐藏工具", "Hide tool"), icon: "eye-off", rule: true, run: () => this.hideTab(win, kind) },
      { label: t("标签组", "Tab group"), icon: "layers", items: [
        { label: t("每个标签拆成一个窗口", "Split every tab into windows"), icon: "split", run: () => this.scatter(win) },
        { label: t("隐藏整组", "Hide group"), icon: "eye-off", run: () => this.close(win) },
      ] },
    ], { back: win.strip.querySelector<HTMLElement>('[aria-selected="true"]') });
  }

  private popTab(win: Win, kind: Kind, n = 1) {
    const from = { ...win.rect };
    const next = this.split(win, kind, from);
    const size = win.max || win.cell ? this.defaults(kind) : from;
    next.float = this.fit({ ...size, x: from.x + 46 * n, y: from.y + 46 * n });
    next.pin ? this.moveTo(next, { ...from, x: from.x - 46 * n, y: from.y - 46 * n }) : this.moveTo(next, next.float);
  }

  private scatter(win: Win) {
    win.tabs.slice(0, -1).forEach((kind, n) => this.popTab(win, kind, n + 1));
  }

  private pinMenu(win: Win, button: HTMLElement) {
    const roomy = !matchMedia("(hover: none)").matches;
    const why = (mode: number) => {
      if (mode === 3 && !roomy) return t("手机上没有独立窗口", "Standalone windows unavailable on mobile");
      if (mode === 4 && (!roomy || !documentPip())) return t("这个浏览器不支持置顶小窗，桌面版可用", "Document PiP unsupported in this browser; available on desktop");
      return undefined;
    };
    const r = button.getBoundingClientRect();
    button.dataset.open = "";
    this.menu.open(r.right + 12, r.bottom + 5, t("固定浮窗", "Pin window"), PIN_MODES.map((label, n): MenuItem => ({
      label,
      checked: n === win.pin,
      disabled: why(n),
      run: () => this.setPin(win, n as PinMode),
    })), { alignRight: true, back: button, onClose: () => delete button.dataset.open });
  }

  // ---------- pinning and separate windows ----------
  private setPin(win: Win, mode: PinMode) {
    if (mode === win.pin) return;
    if (mode >= 3) return void this.popOut(win, mode);
    const wasDesk = !win.pin;
    this.closeAssist();
    win.tween?.kill();
    if (win.native) {
      const native = win.native;
      win.native = undefined;
      delete win.el.dataset.native;
      native.close();
      win.rect = { ...win.float, x: innerWidth, y: innerHeight - 320 };
    }
    const now = win.el.isConnected && win.el.ownerDocument === document && win.el.parentElement ? win.el.getBoundingClientRect() : null;
    win.pin = mode;
    win.state = "open";
    win.el.dataset.pin = String(mode);
    if (!mode) {
      const o = this.canvas.getBoundingClientRect();
      win.el.removeAttribute("data-pin");
      this.canvas.append(win.el);
      if (now) win.rect = { x: now.left - o.left, y: now.top - o.top, w: now.width, h: now.height };
      this.apply(win);
      if (win.cell && this.snapped(win).some((x) => overlaps(x.cell!, win.cell!))) win.cell = null;
      this.moveTo(win, this.home(win));
    } else {
      if (wasDesk && !win.cell && !win.max) win.float = { ...win.rect };
      win.max = false;
      this.pip.append(win.el);
      if (now) win.rect = { x: now.left, y: now.top, w: now.width, h: now.height };
      this.apply(win);
      if (wasDesk || !now) {
        const w = Math.min(400, innerWidth - 24);
        const h = Math.min(win.tabs.length > 1 ? 330 : 290, innerHeight * 0.44);
        this.moveTo(win, { w, h, x: innerWidth - w - 20, y: innerHeight - h - 20 });
      }
      this.emit("pin");
    }
    this.focused = null;
    this.focus(win);
    this.paint(win);
    this.drawLines();
  }

  /** A real window of the visitor's own system. "On top" uses the browser's picture-in-picture window. */
  private async popOut(win: Win, mode: PinMode) {
    const { w, h } = { w: Math.max(Math.round(win.rect.w), 360), h: Math.max(Math.round(win.rect.h), 300) };
    let native: Window | null = null;
    try {
      native = mode === 4 ? await documentPip()!.requestWindow({ width: w, height: h }) : window.open("", "", `popup,width=${w},height=${h}`);
    } catch { /* refused: told below */ }
    if (!native) return this.say(t("浏览器拦下了新窗口，允许弹窗后再试", "Browser blocked the pop-out window — allow popups and try again"));
    if (win.native) {
      const old = win.native;
      win.native = undefined;
      old.close();
    }
    const doc = native.document;
    doc.title = `${this.nameOf(win)} · OMP Studio`;
    for (const node of document.head.querySelectorAll<HTMLElement>("style, link[rel=stylesheet]")) {
      const copy = doc.importNode(node, true) as HTMLElement;
      if (copy instanceof HTMLLinkElement || copy.tagName === "LINK") copy.setAttribute("href", (node as HTMLLinkElement).href);
      doc.head.append(copy);
    }
    doc.body.className = "omp wm-native";
    doc.body.dataset.theme = document.documentElement.dataset.theme ?? "light";
    doc.documentElement.dataset.theme = doc.body.dataset.theme;
    win.tween?.kill();
    if (!win.pin && !win.cell && !win.max) win.float = { ...win.rect };
    win.pin = mode;
    win.state = "open";
    win.native = native;
    win.max = false;
    win.el.dataset.native = "";
    win.el.dataset.pin = String(mode);
    win.el.removeAttribute("style");
    carry(win.el, doc.body);
    this.paint(win);
    this.syncDock();
    this.drawLines();
    this.emit("pin");
    // Closing it with the system's own button brings the tool home rather than losing it.
    native.addEventListener("pagehide", () => {
      if (win.native !== native) return;
      this.setPin(win, 0);
    });
  }

  // ---------- snapping ----------
  private snap(win: Win, cell: Cell) {
    const moves = displace(this.snapped(win).map((o): [Win, Cell] => [o, o.cell!]), cell);
    win.max = false;
    win.cell = cell;
    this.moveTo(win, this.cellRect(cell));
    for (const [other, to] of moves) {
      other.cell = to;
      this.moveTo(other, this.home(other), 0.04);
    }
    this.focus(win);
    this.paint(win);
    this.drawLines();
    this.offer();
  }

  private maximize(win: Win) {
    win.max = true;
    this.paint(win);
    this.moveTo(win, this.home(win));
    this.drawLines();
  }

  private applyLayout(index: number, cellIndex: number, win: Win) {
    const cells = LAYOUTS[index]!.cells;
    const rest = cells.filter((_, n) => n !== cellIndex);
    const others = this.standing(win);
    win.cell = [...cells[cellIndex]!];
    win.max = false;
    this.moveTo(win, this.cellRect(win.cell));
    others.forEach((other, n) => {
      const cell = rest[n];
      other.max = false;
      if (!cell) return this.minimize(other);
      other.cell = [...cell];
      this.moveTo(other, this.cellRect(cell), 0.05 * (n + 1));
    });
    this.closePicker();
    this.focus(win);
    this.paint(win);
    this.drawLines();
    this.offer();
    this.emit("layout");
  }

  /** Offer the other windows for the largest space left over. */
  private offer() {
    this.closeAssist();
    const cell = vacancy(this.snapped().map((w) => w.cell!));
    const wins = this.wins.filter((w) => !w.pin && w.state !== "closed" && !(w.cell && w.state === "open"));
    if (!cell || !wins.length || cell[2] * this.area().w < 220 || !this.snapped().length) return;
    this.assistFor = { cell, wins };
    const r = this.cellRect(cell);
    Object.assign(this.assist.style, { transform: `translate3d(${r.x + 8}px, ${r.y + 8}px, 0)`, width: `${r.w - 16}px`, height: `${r.h - 16}px` });
    this.assist.innerHTML = `<header><span>${t("选一个窗口补齐这里", "Pick a window to fill")}</span><button type="button" class="ow-btn" data-skip aria-label="${t("不补齐", "Dismiss")}">${a("x")}</button></header><div>${wins
      .map((w, n) => `<button type="button" data-n="${n}" style="--tint:${KINDS[w.active].tint}"><span class="ow-mark">${a(KINDS[w.active].icon)}</span><span><b>${KINDS[w.active].title}${w.tabs.length > 1 ? ` <i>${w.tabs.length}</i>` : ""}</b><small>${w.state === "min" ? t("已最小化", "Minimized") : t("浮窗", "Floating")}</small></span></button>`)
      .join("")}</div>`;
    this.assist.dataset.on = "";
  }

  private pickAssist(e: MouseEvent) {
    const b = (e.target as Element).closest<HTMLElement>("button");
    const at = this.assistFor;
    if (!b || !at) return;
    this.closeAssist();
    const win = at.wins[Number(b.dataset.n)];
    if (b.dataset.skip !== undefined || !win) return;
    if (win.state === "min") this.show(win, this.tabSpot(win));
    this.snap(win, at.cell);
  }

  private closeAssist() {
    this.assistFor = null;
    this.assist.removeAttribute("data-on");
  }

  /** The shared edges between snapped windows. */
  private drawLines() {
    const wins = this.snapped();
    const { w, h } = this.area();
    const all = wins.length > 1 && !this.standing().some((x) => x.max) ? dividers(wins.map((x) => x.cell!), MIN_W / w, MIN_H / h) : [];
    while (this.lines.length > all.length) this.lines.pop()!.remove();
    while (this.lines.length < all.length) {
      const el = document.createElement("div");
      el.className = "wm-line";
      el.tabIndex = 0;
      el.setAttribute("role", "separator");
      el.setAttribute("aria-label", t("调整窗口分区", "Resize split panes"));
      const n = this.lines.push(el) - 1;
      el.addEventListener("pointerdown", (e) => this.dragLine(n, e));
      el.addEventListener("dblclick", () => {
        const d = this.lineAt(n);
        if (d) this.setLine(d, d.even, true);
      });
      el.addEventListener("keydown", (e) => {
        const d = this.lineAt(n);
        if (!d) return;
        const step = e.key === (d.axis === "x" ? "ArrowLeft" : "ArrowUp") ? -1 : e.key === (d.axis === "x" ? "ArrowRight" : "ArrowDown") ? 1 : 0;
        if (!step && e.key !== "Home" && e.key !== "Enter") return;
        e.preventDefault();
        this.setLine(d, step ? d.at + step * (e.shiftKey ? 0.1 : 0.025) : d.even, true);
      });
      this.canvas.append(el);
    }
    const z = Math.max(0, ...wins.map((x) => Number(x.el.style.zIndex)));
    all.forEach((d, n) => {
      const el = this.lines[n]!;
      const iw = w - MARGIN * 2;
      const ih = h - MARGIN;
      const along = d.axis === "x" ? ih : iw;
      // A row edge stops short of the column edges it meets, so each can be taken hold of.
      const inset = d.axis === "y" ? 12 : 0;
      const px = d.axis === "x" ? MARGIN + d.at * iw : MARGIN + d.from * iw + inset;
      const py = STRIP + MARGIN + (d.axis === "x" ? d.from : d.at) * ih;
      el.dataset.axis = d.axis;
      el.setAttribute("aria-orientation", d.axis === "x" ? "vertical" : "horizontal");
      el.setAttribute("aria-valuenow", String(Math.round(d.at * 100)));
      el.style.transform = `translate3d(${Math.round(px)}px, ${Math.round(py)}px, 0)`;
      el.style[d.axis === "x" ? "height" : "width"] = `${Math.round((d.to - d.from) * along - inset * 2)}px`;
      el.style[d.axis === "x" ? "width" : "height"] = "";
      el.style.zIndex = String(z);
    });
  }

  private lineAt(n: number): Divider | undefined {
    const { w, h } = this.area();
    return dividers(this.snapped().map((x) => x.cell!), MIN_W / w, MIN_H / h)[n];
  }

  private setLine(d: Divider, at: number, animate = false) {
    const wins = this.snapped();
    const cells = shift(wins.map((x) => x.cell!), d, at);
    wins.forEach((win, n) => {
      win.cell = cells[n]!;
      if (animate) return this.moveTo(win, this.cellRect(win.cell));
      win.tween?.kill();
      win.rect = this.cellRect(win.cell);
      this.apply(win);
    });
    this.drawLines();
  }

  private dragLine(n: number, e: PointerEvent) {
    const d = this.lineAt(n);
    if (e.button !== 0 || !d) return;
    e.preventDefault();
    const el = this.lines[n]!;
    const { w, h } = this.area();
    const size = d.axis === "x" ? w - MARGIN * 2 : h - MARGIN;
    this.closeAssist();
    el.dataset.live = "";
    document.documentElement.dataset.wmDragging = d.axis;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) this.setLine(d, d.at + ((d.axis === "x" ? ev.clientX - e.clientX : ev.clientY - e.clientY)) / size);
    };
    const end = (back: boolean) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", cancel);
      removeEventListener("keydown", esc, true);
      delete el.dataset.live;
      delete document.documentElement.dataset.wmDragging;
      if (back) this.setLine(d, d.at);
      this.emit("move");
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) end(false); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) end(true); };
    const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape") end(true); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cancel);
    addEventListener("keydown", esc, true);
  }

  // ---------- pointer: drag ----------
  /** The snap zone under the pointer. Once in a zone it holds on a little, so its edge does not flicker. */
  private zoneAt(e: PointerEvent, win: Win, held: string | null): { name: string; cell: Cell } | null {
    const o = this.canvas.getBoundingClientRect();
    const { w, h } = this.area();
    const x = e.clientX - o.left;
    const y = e.clientY - o.top - STRIP;
    const stay = (names: string[]) => (held && names.includes(held) ? 24 : 0);
    const edge = clamp(w * 0.07, 30, 84);
    const corner = clamp(h * 0.26, 70, 190);
    const side = x < edge + stay(["left", "tl", "bl"]) ? "l" : x > w - edge - stay(["right", "tr", "br"]) ? "r" : "";
    if (!side) return y < 14 + stay(["full"]) ? { name: "full", cell: FULL } : null;
    const row = y < corner + stay([`t${side}`]) ? "t" : y > h - corner - stay([`b${side}`]) ? "b" : "";
    const name: ZoneName = row ? (`${row}${side}` as ZoneName) : side === "l" ? "left" : "right";
    return { name, cell: zones(this.snapped(win).map((p) => p.cell!))[name] };
  }

  /** The window whose title bar or tabs are under the pointer, if it is not behind another. */
  private joinAt(e: PointerEvent, win: Win): Win | null {
    const layer = win.pin ? this.wins.filter((o) => o !== win && o.pin && !o.native && o.state === "open") : this.standing(win);
    for (const other of layer) {
      const r = other.el.getBoundingClientRect();
      if (!inside(r, e.clientX, e.clientY)) continue;
      return e.clientY < r.top + (other.strip.hidden ? 34 : 70) && e.clientX < r.right - 112 ? other : null;
    }
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

  private showLabel(text: string, e?: PointerEvent) {
    if (!text || !e) return this.label.removeAttribute("data-on");
    const o = this.canvas.getBoundingClientRect();
    this.label.textContent = text;
    this.label.style.transform = `translate3d(${clamp(e.clientX - o.left + 16, 8, o.width - 130)}px, ${clamp(e.clientY - o.top + 20, 8, o.height - 40)}px, 0)`;
    this.label.dataset.on = "";
  }

  /** Carry a window. `undo` puts things back for a drag that began by tearing off a tab. */
  private drag(win: Win, e: PointerEvent, undo?: () => void) {
    const start = { px: e.clientX, py: e.clientY, rect: { ...win.rect }, cell: win.cell, max: win.max };
    let base = start.rect;
    let moving = !!undo;
    let zone: { name: string; cell: Cell } | null = null;
    let join: Win | null = null;
    let nudged: Win[] = [];
    document.documentElement.dataset.wmDragging = "";
    if (moving) win.el.dataset.dragging = "";

    const begin = () => {
      moving = true;
      try {
        win.bar.setPointerCapture(e.pointerId);
      } catch { /* synthetic pointers may not support capture */ }
      win.tween?.kill();
      this.closeAssist();
      win.el.dataset.dragging = "";
      if (!win.cell && !win.max) return;
      // Leaving a snap: shrink back to the floating size under the pointer.
      const grab = (start.px - win.el.getBoundingClientRect().left) / win.rect.w;
      base = { ...win.float, x: win.rect.x + grab * (win.rect.w - win.float.w), y: win.rect.y };
      win.cell = null;
      win.max = false;
      win.rect.w = base.w;
      win.rect.h = base.h;
      this.paint(win);
      this.drawLines();
    };

    /** Neighbours show where they would go, and come back if the window moves on. */
    const rehearse = (next: typeof zone) => {
      for (const other of nudged) this.moveTo(other, this.home(other));
      nudged = [];
      if (!next || next.name === "full") return;
      const moves = displace(this.snapped(win).map((o): [Win, Cell] => [o, o.cell!]), next.cell);
      for (const [other, to] of moves) {
        this.moveTo(other, to ? this.cellRect(to) : this.fit(other.float));
        nudged.push(other);
      }
    };

    const aim = (nextJoin: Win | null, nextZone: typeof zone, ev: PointerEvent) => {
      if (nextJoin !== join) {
        if (join) {
          delete join.el.dataset.drop;
          this.paint(join);
        }
        join = nextJoin;
        if (join) {
          join.el.dataset.drop = "";
          this.paint(join, win.tabs);
        }
        win.el.toggleAttribute("data-joining", !!join);
      }
      if (nextZone?.name !== zone?.name) {
        zone = nextZone;
        rehearse(zone);
        this.showPreview(zone?.cell ?? null, win.rect);
      }
      this.showLabel(join ? t("加入浮窗标签组", "Join tab group") : zone ? (zone.name === "full" ? t("最大化", "Maximize") : t("吸附窗口", "Snap window")) : "", ev);
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!moving) {
        if (Math.hypot(dx, dy) < 6) return;
        begin();
      }
      win.rect.x = base.x + dx;
      win.rect.y = base.y + dy;
      const free = ev.ctrlKey || ev.metaKey;
      if (win.pin) {
        win.rect.x = clamp(win.rect.x, 8 - win.rect.w * 0.6, innerWidth - win.rect.w * 0.4);
        win.rect.y = clamp(win.rect.y, 8, innerHeight - 44);
        aim(free ? null : this.joinAt(ev, win), null, ev);
      } else {
        win.rect.y = Math.max(win.rect.y, STRIP - 10);
        const o = this.canvas.getBoundingClientRect();
        // The very edge is for snapping; anywhere else, another window's tabs come first.
        const brink = ev.clientX - o.left < 22 || o.right - ev.clientX < 22 || ev.clientY - o.top < STRIP + 4;
        const over = free || brink ? null : this.joinAt(ev, win);
        aim(over, free || over ? null : this.zoneAt(ev, win, zone?.name ?? null), ev);
      }
      this.apply(win);
      if (!win.pin) this.wall.press(ev.clientX, ev.clientY + win.rect.h * 0.3);
    };

    const finish = (cancelled: boolean) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", cancel);
      removeEventListener("blur", blur);
      removeEventListener("keydown", esc, true);
      delete win.el.dataset.dragging;
      delete win.el.dataset.joining;
      delete document.documentElement.dataset.wmDragging;
      if (!moving) return;
      this.wall.release();
      this.preview.removeAttribute("data-on");
      this.showLabel("");
      if (join) delete join.el.dataset.drop;
      if (cancelled) {
        if (join) this.paint(join);
        rehearse(null);
        if (undo) return undo();
        win.cell = start.cell;
        win.max = start.max;
        this.paint(win);
        this.drawLines();
        return this.moveTo(win, start.rect);
      }
      if (join) {
        this.merge(win, join);
        this.emit("merge");
      } else if (zone) {
        zone.name === "full" ? this.maximize(win) : this.snap(win, zone.cell);
        this.emit("snap");
      } else {
        if (!win.pin) {
          win.float = this.fit(win.rect);
          this.moveTo(win, win.float);
        }
        this.emit("move");
      }
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(false); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(true); };
    const blur = () => finish(true);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !moving) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cancel);
    addEventListener("blur", blur);
    addEventListener("keydown", esc, true);
  }

  // ---------- pointer: resize ----------
  private resize(win: Win, dir: string, e: PointerEvent) {
    if (e.button !== 0 || win.cell || win.max || win.native) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    try {
      grip.setPointerCapture(e.pointerId);
    } catch { /* synthetic pointers may not support capture */ }
    win.tween?.kill();
    const start = { px: e.clientX, py: e.clientY, ...win.rect };
    win.el.dataset.dragging = "";
    document.documentElement.dataset.wmDragging = "";
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
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
        r.h = Math.max(MIN_H, Math.min(start.h - dy, start.y + start.h - (win.pin ? 8 : STRIP)));
        r.y = start.y + start.h - r.h;
      }
      this.apply(win);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      delete win.el.dataset.dragging;
      delete document.documentElement.dataset.wmDragging;
      if (!win.pin) win.float = { ...win.rect };
      this.emit("move");
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  // ---------- keyboard ----------
  private keys(win: Win, e: KeyboardEvent) {
    if (e.target !== e.currentTarget || !e.key.startsWith("Arrow") || win.native) return;
    e.preventDefault();
    if (e.altKey && !win.pin) {
      const z = zones(this.snapped(win).map((w) => w.cell!));
      if (e.key === "ArrowLeft") this.snap(win, z.left);
      else if (e.key === "ArrowRight") this.snap(win, z.right);
      else if (e.key === "ArrowUp") this.maximize(win);
      else {
        win.max = false;
        win.cell = null;
        this.paint(win);
        this.moveTo(win, this.home(win));
        this.drawLines();
      }
      if (e.key !== "ArrowDown") this.emit("snap");
      return;
    }
    const step = e.shiftKey ? 64 : 24;
    const to = { ...win.rect };
    if (win.cell || win.max) Object.assign(to, { w: win.float.w, h: win.float.h });
    win.cell = null;
    win.max = false;
    if (e.key === "ArrowLeft") to.x -= step;
    if (e.key === "ArrowRight") to.x += step;
    if (e.key === "ArrowUp") to.y -= step;
    if (e.key === "ArrowDown") to.y += step;
    const fitted = win.pin ? to : this.fit(to);
    if (!win.pin) win.float = fitted;
    this.paint(win);
    this.moveTo(win, fitted);
    this.drawLines();
  }

  // ---------- layout picker ----------
  private buildPicker() {
    const el = document.createElement("div");
    el.className = "picker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", t("选择布局和位置", "Choose layout & slot"));
    el.innerHTML = `<p>${t("选择布局和位置", "Choose layout & slot")}</p><div class="picker-grid">${LAYOUTS.map(
      (layout, n) => `<figure><div class="picker-tile">${layout.cells
        .map(([x, y, w, h], c) => `<button type="button" data-layout="${n}" data-cell="${c}" aria-label="${layout.name}${t(`，第 ${c + 1} 格`, `, slot ${c + 1}`)}" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></button>`)
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
    if (win.state !== "open" || win.pin) return;
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

  // ---------- window strip ----------
  private buildStrip() {
    this.strip.className = "wm-strip";
    this.strip.setAttribute("role", "toolbar");
    this.strip.setAttribute("aria-label", t("窗口", "Windows"));
    this.canvas.append(this.strip);
    this.strip.addEventListener("click", (e) => {
      const target = e.target as Element;
      const add = target.closest<HTMLElement>("[data-add]");
      if (add) {
        const r = add.getBoundingClientRect();
        const left = this.dockKinds.filter((k) => !this.holder(k));
        return this.menu.open(r.left, r.bottom + 6, t("新建标签", "Open tool"), left.length
          ? left.map((k): MenuItem => ({ label: KINDS[k].title, icon: KINDS[k].icon, run: () => this.open(k) }))
          : [{ label: t("所有工具都已打开", "All tools open"), disabled: t("所有工具都已打开", "All tools open") }], { back: add });
      }
      const win = this.wins[Number(target.closest<HTMLElement>("[data-win]")?.dataset.win ?? -1)];
      if (!win) return;
      if (target.closest("[data-x]")) return this.close(win);
      this.open(win.active, win.state === "open");
    });
    this.strip.addEventListener("contextmenu", (e) => {
      const win = this.wins[Number((e.target as Element).closest<HTMLElement>("[data-win]")?.dataset.win ?? -1)];
      if (!win || win.native || win.state !== "open") return;
      e.preventDefault();
      this.windowMenu(win, e.clientX, e.clientY);
    });
  }

  private drawStrip() {
    const focus = document.activeElement?.closest?.(".wm-strip") ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-win]")?.dataset.win : undefined;
    this.strip.innerHTML = `<div class="wm-tabs">${this.wins
      .map((w, n) => {
        if (w.state === "closed") return "";
        const k = KINDS[w.active];
        const from = isConversation(w.active) ? "" : ` · ${SOURCE}`;
        const state = w.state === "min" ? " data-min" : w.native ? " data-out" : "";
        const tone = w.active === "chat" ? "green" : w.active === "plan" ? "amber" : "";
        return `<span class="wm-tab" data-win="${n}" style="--tint:${k.tint}"${w === this.focused && w.state === "open" ? " data-on" : ""}${state}><button type="button" aria-label="${k.title}${w.state === "min" ? t("，已最小化", ", minimized") : ""}">${a(k.icon)}<span class="wm-tab-t">${k.title}<i>${from}</i></span>${tone ? `<span class="ow-dot" data-tone="${tone}"></span>` : ""}${w.tabs.length > 1 ? `<span class="ow-count">${w.tabs.length}</span>` : ""}${w.pin ? a(w.native ? "external" : "pin", "wm-tab-pin") : ""}</button><button type="button" class="ow-tab-x" data-x aria-label="${t("关闭", "Close")} ${k.title}">${a("x")}</button></span>`;
      })
      .join("")}</div><button type="button" class="ow-btn" data-add aria-label="${t("新建标签", "Open tool")}">${a("plus")}</button>`;
    if (focus !== undefined) this.strip.querySelector<HTMLElement>(`[data-win="${focus}"] button`)?.focus({ preventScroll: true });
    const tabsEl = this.strip.querySelector<HTMLElement>(".wm-tabs");
    const activeTab = tabsEl?.querySelector<HTMLElement>("[data-on]");
    if (tabsEl && activeTab) {
      const left = activeTab.offsetLeft;
      const right = left + activeTab.offsetWidth;
      if (left < tabsEl.scrollLeft) tabsEl.scrollLeft = left;
      else if (right > tabsEl.scrollLeft + tabsEl.clientWidth) tabsEl.scrollLeft = right - tabsEl.clientWidth;
    }
  }

  // ---------- capsules: minimised windows that are pinned, so they can be found from anywhere on the page ----------
  private capsuleSpot() {
    return { x: innerWidth - 90, y: innerHeight - 32 };
  }

  private drawCapsules() {
    const wins = this.wins.filter((w) => w.pin && !w.native && w.state === "min");
    this.capsules.replaceChildren(...wins.map((win) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wm-capsule";
      b.style.setProperty("--tint", KINDS[win.active].tint);
      b.dataset.pin = String(win.pin);
      b.innerHTML = `${a(KINDS[win.active].icon)}<span>${KINDS[win.active].title}</span>${win.tabs.length > 1 ? `<i>${win.tabs.length}</i>` : ""}`;
      b.setAttribute("aria-label", `${t("恢复", "Restore")} ${KINDS[win.active].title}`);
      const at = { x: 0, y: 0 };
      let moved = false;
      b.addEventListener("pointerdown", (e) => {
        const from = { x: e.clientX - at.x, y: e.clientY - at.y };
        moved = false;
        const move = (ev: PointerEvent) => {
          if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
          if (!moved) b.setPointerCapture(e.pointerId);
          moved = true;
          at.x = ev.clientX - from.x;
          at.y = ev.clientY - from.y;
          b.style.translate = `${at.x}px ${at.y}px`;
        };
        const up = () => {
          b.removeEventListener("pointermove", move);
          // Wherever it is let go, it stays in reach.
          const r = b.getBoundingClientRect();
          at.x += clamp(r.left, 8, innerWidth - r.width - 8) - r.left;
          at.y += clamp(r.top, 64, innerHeight - r.height - 8) - r.top;
          b.style.translate = `${at.x}px ${at.y}px`;
        };
        b.addEventListener("pointermove", move);
        b.addEventListener("pointerup", up, { once: true });
        b.addEventListener("pointercancel", up, { once: true });
      });
      b.addEventListener("click", () => {
        if (moved) return;
        const r = b.getBoundingClientRect();
        this.show(win, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      });
      return b;
    }));
  }

  // ---------- tool shelf ----------
  private buildDock() {
    this.dock.innerHTML = this.dockKinds
      .map((kind) => {
        const k = KINDS[kind];
        const name = kind === "chat" ? t("对话", "Chat") : kind === "plan" ? t("计划审批", "Plan review") : k.title;
        const icon = kind === "plan" ? lucide("clipboardCheck") : a(k.icon);
        return `<button type="button" class="dock-item" data-kind="${kind}" style="--tint:${k.tint}" aria-label="${name}" aria-pressed="false"><span class="dock-ico">${icon}</span><span class="dock-tip">${name}</span></button>`;
      })
      .join("");
    const items = [...this.dock.querySelectorAll<HTMLElement>(".dock-item")];
    this.dock.addEventListener("click", (e) => {
      const kind = (e.target as Element).closest<HTMLElement>("[data-kind]")?.dataset.kind as Kind | undefined;
      if (!kind) return;
      const win = this.holder(kind);
      if (win?.state === "open" && this.focused === win && win.active === kind && !win.native) this.minimize(win);
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
      const win = this.holder(item.dataset.kind as Kind);
      item.toggleAttribute("data-open", !!win);
      item.setAttribute("aria-pressed", String(win?.state === "open" && win.active === item.dataset.kind));
    }
  }

  // ---------- for the rest of the page ----------
  /** Open several tools as the tabs of one window. */
  openGroup(kinds: Kind[], quiet = false, delay = 0) {
    this.open(kinds[0]!, quiet, delay);
    const win = this.holder(kinds[0]!)!;
    for (const kind of kinds.slice(1)) this.addTab(win, kind);
    this.activate(win, kinds[0]!);
  }

  /** The windows standing on the desk, the one in front first. */
  fronts() {
    return this.standing().map((w) => w.el);
  }

  /** Screen rect of a window's title bar, for the first-run hint. */
  barRect(kind: Kind) {
    return this.holder(kind)?.bar.getBoundingClientRect();
  }
}

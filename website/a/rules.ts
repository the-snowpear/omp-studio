// "Four things" section: one sticky miniature of the app, and four short
// texts beside it. Scrolling a text into view puts the miniature into that
// rule's state; the controls under each text let the visitor drive it.
import gsap from "gsap";
import { i, piMark } from "../shared/icons";
import { DOCK_ZONES, LAYOUTS, PIN_MODES, ompWindow, type Kind } from "../shared/ui";

interface Box { x: number; y: number; w: number; h: number; o: number }

// The miniature is laid out at 1280 x 800 and scaled to fit with CSS zoom.
const VW = 1280;
const VH = 800;
const WS = { x: 304, y: 52, w: 968, h: 740 };
const GAP = 8;

const STEPS = [
  {
    title: "拖出来就是一个窗口",
    text: "从侧栏拖一场会话到列表外，松手就是一个浮窗，原来的对话保持不动。移动、最小化、收回都不会重建对话，草稿、阅读位置和终端状态全部保留。",
  },
  {
    title: "贴边吸附，六种模板",
    text: "拖到左右边缘是半屏，拖到四角是四分之一，拖到顶部是最大化。鼠标在最大化按钮上停 300 毫秒，会弹出布局选择器。新窗口吸附进来时，原来的窗口自动移到剩下最大的空位。",
  },
  {
    title: "工具停在哪都行",
    text: "Files、Changes、Git、Browser、Computer、Agents、Terminal、Logs、BTW 都能在五个位置之间移动。拖动超过 6 像素就显示真实内容的落点预览，松手才提交。",
  },
  {
    title: "钉住，或者干脆独立出去",
    text: "浮窗的图钉菜单有五档，决定这个窗口跟着谁走。独立窗口在任务栏有自己的图标，可以拖到另一块显示器，重启后恢复位置。",
  },
];

const ZONE_NOTES = [
  "停在左侧栏，和会话列表、文件树在一起。",
  "停在对话工具区，跟着这场对话走。",
  "停在右侧栏。右侧栏最多可以分上下两组。",
  "停在底栏。底栏最多可以分左右两组。",
  "浮起来。一个浮窗里可以放多个标签。",
];
const PIN_NOTES = [
  "不固定：跟随当前会话的布局，只在工作台显示。",
  "固定在工作区：同一个工作区里，换页面、换会话都还在。",
  "固定在应用：换页面、换会话、换工作区都还在。",
  "独立窗口：成为普通的系统窗口，任务栏有自己的图标，可以拖到另一块显示器。",
  "独立窗口并置顶：同一个独立窗口，保持在其他应用窗口上方。",
];

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const cellBox = ([cx, cy, cw, ch]: number[]): Box => {
  const l = cx! > 0.01 ? GAP / 2 : 0;
  const t = cy! > 0.01 ? GAP / 2 : 0;
  const r = cx! + cw! < 0.99 ? GAP / 2 : 0;
  const b = cy! + ch! < 0.99 ? GAP / 2 : 0;
  return { x: WS.x + cx! * WS.w + l, y: WS.y + cy! * WS.h + t, w: cw! * WS.w - l - r, h: ch! * WS.h - t - b, o: 1 };
};

export function mountRules(root: HTMLElement) {
  root.innerHTML = `<div class="rules-steps">${STEPS.map(
    (s, n) => `<article class="rule" data-step="${n}"><h3>${s.title}</h3><p>${s.text}</p><div class="rule-ctl" data-ctl="${n}"></div></article>`,
  ).join("")}</div>
<div class="rules-stage"><div class="mini omp" data-theme="${document.documentElement.dataset.theme ?? "light"}"><div class="mini-inner">
<div class="mini-desktop" aria-hidden="true"><div class="mini-taskbar"><span class="mini-task" data-on>${piMark(20)}</span><span class="mini-task" data-task="git">${i("gitBranch")}</span></div></div>
<div class="mini-app"><div class="mini-top"><span class="mini-brand">${piMark(18)}OMP Studio</span></div>
<div class="mini-rail">${(["layoutGrid", "house", "history", "boxes", "brain", "settings"] as const).map((n, k) => `<span${k ? "" : " data-on"}>${i(n)}</span>`).join("")}</div>
<div class="mini-side"><p>omp-web</p>
<span class="mini-row" data-on>${i("messageSquare")}跟踪上游 pi-web 更新</span>
<button class="mini-row" type="button" data-pull>${i("messageSquare")}Mermaid 全屏缩放<em>待审批</em></button>
<span class="mini-row">${i("messageSquare")}Audit and fix OSS repository</span>
<span class="mini-row">${i("messageSquare")}修复 Git Bash 路径未找到</span></div></div>
<div class="mini-scope" aria-hidden="true"><span></span></div>
</div></div><p class="mini-note" aria-live="polite"></p></div>`;

  const mini = root.querySelector<HTMLElement>(".mini")!;
  const inner = root.querySelector<HTMLElement>(".mini-inner")!;
  const app = root.querySelector<HTMLElement>(".mini-app")!;
  const scope = root.querySelector<HTMLElement>(".mini-scope")!;
  const note = root.querySelector<HTMLElement>(".mini-note")!;
  const pullRow = root.querySelector<HTMLElement>("[data-pull]")!;
  const articles = [...root.querySelectorAll<HTMLElement>(".rule")];

  // ---- actors ----
  const make = (kind: Kind, parent: HTMLElement, z: number, title?: string) => {
    const el = ompWindow({ kind, title });
    el.classList.add("mini-win");
    el.inert = true;
    el.style.zIndex = String(z);
    parent.append(el);
    return { el, box: { x: WS.x, y: WS.y, w: WS.w, h: WS.h, o: 0 } as Box };
  };
  const actors = {
    chat: make("chat", app, 1),
    plan: make("plan", app, 2),
    browser: make("browser", app, 3),
    other: make("files", inner, 4, "其他应用"),
    git: make("git", inner, 5),
  };
  type Actor = keyof typeof actors;
  const frame = { x: 0, y: 0, s: 1 };
  const scopeBox: Box = { x: 0, y: 0, w: VW, h: VH, o: 0 };

  const paint = (name: Actor) => {
    const { el, box } = actors[name];
    el.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    el.style.opacity = String(box.o);
    el.style.visibility = box.o < 0.01 ? "hidden" : "visible";
  };
  const paintFrame = () => {
    app.style.transform = `translate3d(${frame.x}px, ${frame.y}px, 0) scale(${frame.s})`;
  };
  const paintScope = () => {
    scope.style.transform = `translate3d(${scopeBox.x}px, ${scopeBox.y}px, 0)`;
    scope.style.width = `${scopeBox.w}px`;
    scope.style.height = `${scopeBox.h}px`;
    scope.style.opacity = String(scopeBox.o);
  };

  // ---- state ----
  const state = { step: -1, pulled: false, drop: null as { x: number; y: number } | null, layout: 4, zone: 2, pin: 0 };
  const touched = [false, false, false, false];

  function targets() {
    const hidden = (b: Omit<Box, "o">): Box => ({ ...b, o: 0 });
    const full: Box = { ...WS, o: 1 };
    const float = { x: 700, y: 250, w: 440, h: 340 };
    const t: Record<Actor, Box> = {
      chat: full,
      plan: hidden({ x: 70, y: 150, w: 300, h: 200 }),
      browser: hidden({ x: WS.x + 500, y: WS.y + 400, w: 420, h: 300 }),
      other: hidden({ x: 610, y: 330, w: 400, h: 300 }),
      git: hidden(float),
    };
    let scopeTo: Box = { ...scopeBox, o: 0 };
    let scopeLabel = "";
    let frameTo = { x: 0, y: 0, s: 1 };
    let text = "";

    if (state.step === 0) {
      if (state.pulled) {
        const w = 520;
        const h = 430;
        const cx = state.drop?.x ?? WS.x + WS.w * 0.62;
        const cy = state.drop?.y ?? WS.y + WS.h * 0.46;
        t.plan = { w, h, o: 1, x: Math.min(Math.max(cx - w / 2, WS.x + 12), WS.x + WS.w - w - 12), y: Math.min(Math.max(cy - 20, WS.y + 12), WS.y + WS.h - h - 12) };
        text = "「Mermaid 全屏缩放」现在是一个浮窗，主对话没有动。";
      } else {
        text = "把侧栏里的「Mermaid 全屏缩放」拖进工作区，或者直接点它。";
      }
    } else if (state.step === 1) {
      const cells = LAYOUTS[state.layout]!.cells;
      const order: Actor[] = ["chat", "plan", "browser", "git"];
      order.forEach((name, n) => {
        if (cells[n]) t[name] = cellBox(cells[n]);
      });
      text = `${LAYOUTS[state.layout]!.name}。拖动窗口之间的分界线，相邻的窗口会一起调整。`;
    } else if (state.step === 2) {
      const side = 336;
      const bottom = 250;
      if (state.zone === 0) t.git = { x: 62, y: 330, w: 230, h: 462, o: 1 };
      else if (state.zone === 1) t.git = { x: WS.x + WS.w - 372, y: WS.y + 46, w: 360, h: 330, o: 1 };
      else if (state.zone === 2) {
        t.chat = { ...WS, w: WS.w - side - GAP, o: 1 };
        t.git = { x: WS.x + WS.w - side, y: WS.y, w: side, h: WS.h, o: 1 };
      } else if (state.zone === 3) {
        t.chat = { ...WS, h: WS.h - bottom - GAP, o: 1 };
        t.git = { x: WS.x, y: WS.y + WS.h - bottom, w: WS.w, h: bottom, o: 1 };
      } else t.git = { x: 640, y: 210, w: 470, h: 370, o: 1 };
      text = ZONE_NOTES[state.zone]!;
    } else if (state.step === 3) {
      t.git = { ...float, o: 1 };
      text = PIN_NOTES[state.pin]!;
      if (state.pin === 0) {
        scopeTo = { x: WS.x - 4, y: WS.y - 4, w: WS.w + 8, h: WS.h + 8, o: 1 };
        scopeLabel = "这场对话";
      } else if (state.pin === 1) {
        scopeTo = { x: 58, y: 46, w: VW - 60, h: VH - 48, o: 1 };
        scopeLabel = "工作区 omp-web";
      } else if (state.pin === 2) {
        scopeTo = { x: 6, y: 16, w: VW - 12, h: VH - 22, o: 1 };
        scopeLabel = "整个应用";
      } else {
        frameTo = { x: 24, y: 24, s: 0.64 };
        t.git = { x: 800, y: 372, w: 440, h: 340, o: 1 };
        if (state.pin === 4) t.other = { x: 600, y: 300, w: 420, h: 330, o: 1 };
      }
    }
    return { t, scopeTo, scopeLabel, frameTo, text };
  }

  function render(instant = false) {
    const { t, scopeTo, scopeLabel, frameTo, text } = targets();
    const duration = instant || reduced() ? 0 : 0.7;
    const ease = "expo.out";
    (Object.keys(actors) as Actor[]).forEach((name, n) => {
      const box = actors[name].box;
      // A hidden actor jumps to where it will appear from, then fades in while moving.
      if (box.o < 0.01 && t[name].o > 0 && name !== "plan") Object.assign(box, { ...t[name], o: 0, y: t[name].y + 24 });
      gsap.to(box, { ...t[name], duration, ease, delay: duration ? n * 0.03 : 0, overwrite: true, onUpdate: () => paint(name) });
      if (!duration) paint(name);
    });
    gsap.to(frame, { ...frameTo, duration, ease, overwrite: true, onUpdate: paintFrame });
    if (scopeTo.o && scopeBox.o < 0.01) Object.assign(scopeBox, { ...scopeTo, o: 0 });
    gsap.to(scopeBox, { ...scopeTo, duration, ease, overwrite: true, onUpdate: paintScope });
    if (!duration) {
      paintFrame();
      paintScope();
    }
    if (scopeLabel) scope.firstElementChild!.textContent = scopeLabel;
    note.textContent = text;
    mini.dataset.step = String(state.step);
    mini.toggleAttribute("data-standalone", state.step === 3 && state.pin >= 3);
    mini.toggleAttribute("data-ontop", state.step === 3 && state.pin === 4);
    pullRow.toggleAttribute("data-out", state.step === 0 && state.pulled);
    actors.git.el.toggleAttribute("data-float", state.step === 3 || (state.step === 2 && state.zone === 4));
    articles.forEach((a, n) => a.toggleAttribute("data-active", n === state.step));
    syncControls();
  }

  // ---- controls ----
  const ctl = (n: number) => root.querySelector<HTMLElement>(`[data-ctl="${n}"]`)!;
  ctl(0).innerHTML = `<button class="seg-btn" type="button" data-pull-btn></button>`;
  ctl(1).innerHTML = `<div class="tiles" role="group" aria-label="布局模板">${LAYOUTS.map(
    (l, n) => `<button type="button" class="tile" data-layout="${n}" aria-label="${l.name}">${l.cells
      .map(([x, y, w, h]) => `<i style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i>`)
      .join("")}</button>`,
  ).join("")}</div>`;
  ctl(2).innerHTML = `<div class="seg" role="group" aria-label="停靠位置">${DOCK_ZONES.map((z, n) => `<button class="seg-btn" type="button" data-zone="${n}">${z}</button>`).join("")}</div>`;
  ctl(3).innerHTML = `<div class="seg" role="group" aria-label="固定方式">${PIN_MODES.map((p, n) => `<button class="seg-btn" type="button" data-pin="${n}">${p}</button>`).join("")}</div>`;

  function syncControls() {
    const pullBtn = root.querySelector<HTMLElement>("[data-pull-btn]")!;
    pullBtn.textContent = state.pulled ? "收回去" : "把「Mermaid 全屏缩放」拖出来";
    pullBtn.setAttribute("aria-pressed", String(state.pulled));
    root.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.layout) === state.layout)));
    root.querySelectorAll<HTMLElement>("[data-zone]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.zone) === state.zone)));
    root.querySelectorAll<HTMLElement>("[data-pin]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.pin) === state.pin)));
  }

  const act = (step: number, change: () => void) => {
    touched[step] = true;
    state.step = step;
    change();
    render();
  };
  root.querySelector(".rules-steps")!.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.pullBtn !== undefined) act(0, () => { state.pulled = !state.pulled; state.drop = null; });
    else if (b.dataset.layout) act(1, () => (state.layout = Number(b.dataset.layout)));
    else if (b.dataset.zone) act(2, () => (state.zone = Number(b.dataset.zone)));
    else if (b.dataset.pin) act(3, () => (state.pin = Number(b.dataset.pin)));
  });

  // Dragging the session row out of the miniature's sidebar, for real.
  pullRow.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const k = inner.getBoundingClientRect().width / VW;
    const start = { x: e.clientX, y: e.clientY };
    let ghost: HTMLElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        pullRow.setPointerCapture(e.pointerId);
        ghost = pullRow.cloneNode(true) as HTMLElement;
        ghost.classList.add("mini-ghost");
        inner.append(ghost);
      }
      const o = inner.getBoundingClientRect();
      ghost.style.transform = `translate3d(${(ev.clientX - o.left) / k - 110}px, ${(ev.clientY - o.top) / k - 18}px, 0)`;
    };
    const up = (ev: PointerEvent) => {
      pullRow.removeEventListener("pointermove", move);
      if (!ghost) return act(0, () => { state.pulled = !state.pulled; state.drop = null; });
      ghost.remove();
      const o = inner.getBoundingClientRect();
      const x = (ev.clientX - o.left) / k;
      const y = (ev.clientY - o.top) / k;
      if (x > WS.x && y > WS.y && x < VW && y < VH) act(0, () => { state.pulled = true; state.drop = { x, y }; });
    };
    pullRow.addEventListener("pointermove", move);
    pullRow.addEventListener("pointerup", up, { once: true });
    pullRow.addEventListener("pointercancel", () => { pullRow.removeEventListener("pointermove", move); ghost?.remove(); }, { once: true });
  });

  // ---- scale to fit ----
  const fit = () => {
    const k = mini.clientWidth / VW;
    inner.style.zoom = String(k);
    mini.style.height = `${VH * k}px`;
  };
  new ResizeObserver(fit).observe(mini);
  fit();

  // ---- scroll picks the step ----
  let queued = false;
  const pick = () => {
    queued = false;
    const line = innerHeight * (matchMedia("(max-width: 960px)").matches ? 0.72 : 0.5);
    let best = 0;
    let bestD = Infinity;
    articles.forEach((a, n) => {
      const r = a.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - line);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    });
    if (best === state.step) return;
    state.step = best;
    render();
  };
  addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(pick);
  }, { passive: true });
  state.step = 0;
  render(true);
  pick();

  // Until the visitor takes over a rule, the miniature walks through its options.
  let visible = false;
  new IntersectionObserver(([entry]) => (visible = !!entry?.isIntersecting), { threshold: 0.35 }).observe(mini);
  setInterval(() => {
    if (!visible || document.hidden || reduced() || touched[state.step] || root.matches(":focus-within")) return;
    if (state.step === 0) { state.pulled = !state.pulled; state.drop = null; }
    else if (state.step === 1) state.layout = (state.layout + 1) % LAYOUTS.length;
    else if (state.step === 2) state.zone = (state.zone + 1) % DOCK_ZONES.length;
    else state.pin = (state.pin + 1) % PIN_MODES.length;
    render();
  }, 2600);

  return {
    setTheme(theme: string) {
      mini.dataset.theme = theme;
    },
  };
}

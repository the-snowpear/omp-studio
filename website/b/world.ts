// The scene the camera pulls back through: a sentence in a composer, inside a
// conversation window, inside the workbench, on a desktop with two monitors.
// Everything is laid out once in "app pixels"; the camera only transforms the
// root. State (message sent, replies shown, snap layout, pinned windows) is
// set from scroll position and animates with ordinary CSS transitions.
import { i, piMark } from "../shared/icons";
import iconUrl from "../shared/media/icon-256.webp";
import { LAYOUTS, ompWindow, surface, type Kind } from "../shared/ui";

export const SENTENCE = "跟踪上游 pi-web 的更新，同步到 omp-web";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorldState {
  /** Characters of the sentence typed so far. */
  typed: number;
  sent: boolean;
  /** How many reply blocks of the conversation are visible (0 to World.replyCount). */
  replies: number;
  /** Index into SNAP_STEPS. */
  snap: number;
  /** How many standalone windows have left the app (0 to 2). */
  pins: number;
}

/** World geometry, in app pixels. Monitor 1 is landscape, monitor 2 stands portrait beside it. */
const MON1: Rect = { x: 0, y: 0, w: 1560, h: 980 };
const MON2: Rect = { x: 1620, y: 0, w: 620, h: 980 };
const APP: Rect = { x: 170, y: 70, w: 1200, h: 760 };
const TOPBAR = 38;
const RAIL = 48;
const SIDEBAR = 212;
const WS: Rect = { x: RAIL + SIDEBAR, y: TOPBAR, w: APP.w - RAIL - SIDEBAR, h: APP.h - TOPBAR };
const PAD = 6;
const GAP = 6;
export const WORLD: Rect = { x: 0, y: 0, w: MON2.x + MON2.w, h: MON1.h };

type Docked = "chat" | "plan" | "browser" | "agents";

/** The snap layouts the workbench steps through while the camera holds on it. */
export const SNAP_STEPS: { layout: number; cells: Partial<Record<Docked, number>> }[] = [
  { layout: 4, cells: { chat: 0, plan: 1, browser: 2 } },
  { layout: 2, cells: { chat: 0, plan: 1, browser: 2 } },
  { layout: 3, cells: { plan: 0, browser: 1, chat: 2 } },
  { layout: 5, cells: { plan: 0, chat: 1, browser: 2, agents: 3 } },
];

/** Pixel rect of a layout cell inside the workspace, leaving a gap between neighbours. */
function cellRect(layout: number, cell: number): Rect {
  const [cx, cy, cw, ch] = LAYOUTS[layout]!.cells[cell]!;
  const iw = WS.w - PAD * 2;
  const ih = WS.h - PAD * 2;
  const half = GAP / 2;
  const left = PAD + cx * iw + (cx > 0.001 ? half : 0);
  const right = PAD + (cx + cw) * iw - (cx + cw < 0.999 ? half : 0);
  const top = PAD + cy * ih + (cy > 0.001 ? half : 0);
  const bottom = PAD + (cy + ch) * ih - (cy + ch < 0.999 ? half : 0);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const place = (el: HTMLElement, r: Rect) => {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
};

const session = (title: string, tail = "", on = false) => `<li${on ? " data-on" : ""}><span>${title}</span>${tail}</li>`;
const tag = (text: string, tone: string) => `<em class="os-chip" data-tone="${tone}">${text}</em>`;

function appShell(): string {
  const rail = (["layoutGrid", "house", "history", "boxes", "brain", "settings"] as const)
    .map((name, n) => `<span${n === 0 ? " data-on" : ""}>${i(name)}</span>`)
    .join("");
  return `
<header class="b-app-bar">
  <span class="b-app-menu">${i("panelLeft")}<b>文件</b><b>编辑</b><b>视图</b><b>帮助</b></span>
  <span class="b-app-tabs"><span data-on><i class="os-dot" data-tone="green"></i>跟踪上游 pi-web 更新</span><span>Mermaid 全屏缩放</span><span>Studio 组件预览</span>${i("plus")}</span>
  <span class="b-app-meter mono">↑ 3.5M　↓ 73k　22%</span>
  <span class="b-app-ctl">${i("minus")}${i("maximize")}${i("x")}</span>
</header>
<nav class="b-app-rail">${rail}<span class="b-app-me">S</span></nav>
<aside class="b-app-side">
  <div class="b-side-h">${piMark(18)}<b>OMP Studio</b>${i("search")}</div>
  <div class="b-side-new">${i("plus")}新建对话<kbd class="mono">Ctrl ⇧ O</kbd></div>
  <p class="b-side-label">项目与对话</p>
  <div class="b-side-proj">${i("folderOpen")}omp-web</div>
  <ul class="b-side-list">
    ${session("跟踪上游 pi-web 更新到 omp-web", '<i class="os-spin"></i>', true)}
    ${session("Audit and fix OSS repository", tag("待回答", "blue"))}
    ${session("Mermaid 全屏缩放计划与交互", tag("待审核", "amber"))}
    ${session("修复 Git Bash 路径未找到", tag("待确认", "accent"))}
  </ul>
  <div class="b-side-proj">${i("folder")}pi-web (upstream)</div>
  <div class="b-side-proj">${i("folder")}omp-web (feat/mermaid)</div>
  <p class="b-side-label">Explorer</p>
  ${surface("files")}
</aside>`;
}

const taskbar = () => `<div class="b-dock">
<span class="b-dock-app" data-run><img src="${iconUrl}" alt="" width="34" height="34" decoding="async"></span>
<span class="b-dock-pin" data-pin="git" style="--tint:#ff8a4c">${i("gitBranch")}</span>
<span class="b-dock-pin" data-pin="terminal" style="--tint:#4cc38a">${i("terminal")}</span>
<i></i><span class="b-dock-idle">${i("folder")}</span><span class="b-dock-idle">${i("globe")}</span><span class="b-dock-idle">${i("settings")}</span>
</div>`;

export interface World {
  root: HTMLElement;
  /** Blocks of the conversation that follow the sent message. */
  replyCount: number;
  set(state: WorldState): void;
  /** Focus rects in world pixels, measured from the built DOM. */
  rects(): { sentence: Rect; chat: Rect; app: Rect; desktop: Rect };
}

export function buildWorld(): World {
  const root = document.createElement("div");
  root.className = "b-world omp";
  root.dataset.theme = "dark";
  root.style.width = `${WORLD.w}px`;
  root.style.height = `${WORLD.h}px`;
  root.setAttribute("aria-hidden", "true");
  root.inert = true;

  const mon1 = document.createElement("div");
  mon1.className = "b-mon";
  place(mon1, MON1);
  mon1.innerHTML = taskbar();
  const mon2 = document.createElement("div");
  mon2.className = "b-mon b-mon-2";
  place(mon2, MON2);

  const app = document.createElement("div");
  app.className = "b-app";
  place(app, APP);
  app.innerHTML = appShell();
  const ws = document.createElement("div");
  ws.className = "b-ws";
  place(ws, WS);
  app.append(ws);

  const docked = {} as Record<Docked, HTMLElement>;
  for (const kind of ["plan", "browser", "agents", "chat"] as const) {
    const win = ompWindow({ kind: kind as Kind, focused: kind === "chat" });
    win.classList.add("b-docked");
    docked[kind] = win;
    ws.append(win);
  }

  // The conversation holds its earlier exchange; the sentence and everything
  // after it appear one by one once the message is sent.
  const chat = docked.chat;
  const blocks = [...chat.querySelectorAll<HTMLElement>(".os-msgs > *")];
  const sentAt = Math.max(0, blocks.findIndex((b) => b.textContent?.includes(SENTENCE)));
  const replyCount = blocks.length - sentAt - 1;
  const input = chat.querySelector<HTMLElement>(".os-composer-input")!;
  const placeholder = input.textContent ?? "";
  const typedSpan = document.createElement("span");
  typedSpan.className = "b-typed";

  const pinned = {
    git: ompWindow({ kind: "git", sub: "独立窗口" }),
    terminal: ompWindow({ kind: "terminal", sub: "独立窗口并置顶" }),
  };
  pinned.git.classList.add("b-pin");
  pinned.terminal.classList.add("b-pin");
  place(pinned.git, { x: MON2.x + 40, y: 170, w: MON2.w - 80, h: 600 });
  place(pinned.terminal, { x: 1050, y: 596, w: 452, h: 290 });
  // They leave from the middle of the workbench, so that is where the entrance starts.
  pinned.git.style.setProperty("--from-x", `${APP.x + 820 - (MON2.x + MON2.w / 2)}px`);
  pinned.git.style.setProperty("--from-y", "-40px");
  pinned.terminal.style.setProperty("--from-x", "-190px");
  pinned.terminal.style.setProperty("--from-y", "-170px");
  for (const win of Object.values(pinned)) win.querySelector('[data-act="pin"]')?.setAttribute("aria-pressed", "true");

  root.append(mon1, mon2, app, pinned.git, pinned.terminal);

  let last: WorldState | undefined;
  const set = (s: WorldState) => {
    if (!last || last.typed !== s.typed || last.sent !== s.sent) {
      const typing = !s.sent && s.typed > 0;
      if (typing) {
        typedSpan.textContent = SENTENCE.slice(0, s.typed);
        input.replaceChildren(typedSpan);
        input.dataset.typed = "";
      } else {
        input.textContent = placeholder;
        delete input.dataset.typed;
      }
    }
    if (!last || last.sent !== s.sent || last.replies !== s.replies) {
      const shown = sentAt + (s.sent ? 1 + s.replies : 0);
      blocks.forEach((block, n) => {
        const hide = n >= shown;
        // Only blocks that appear after the first paint get the entrance.
        if (block.hidden && !hide && last) block.classList.add("b-arrive");
        block.hidden = hide;
      });
    }
    if (!last || last.snap !== s.snap) {
      const step = SNAP_STEPS[s.snap]!;
      const rest = SNAP_STEPS[SNAP_STEPS.length - 1]!;
      (Object.keys(docked) as Docked[]).forEach((kind) => {
        const cell = step.cells[kind];
        docked[kind].toggleAttribute("data-away", cell === undefined);
        // A window that is not in this layout waits where it will next appear.
        place(docked[kind], cell === undefined ? cellRect(rest.layout, rest.cells[kind]!) : cellRect(step.layout, cell));
      });
      root.dataset.snap = String(s.snap);
    }
    if (!last || last.pins !== s.pins) {
      pinned.git.toggleAttribute("data-out", s.pins >= 1);
      pinned.terminal.toggleAttribute("data-out", s.pins >= 2);
      root.dataset.pins = String(s.pins);
    }
    last = { ...s };
  };

  const rects = () => {
    // Measured against the root, at whatever scale the camera currently has.
    const base = root.getBoundingClientRect();
    const k = base.width / WORLD.w || 1;
    const measure = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - base.left) / k, y: (r.top - base.top) / k, w: r.width / k, h: r.height / k };
    };
    // The sentence is measured at full length, whatever is typed right now.
    const probe = document.createElement("span");
    probe.className = "b-typed";
    probe.textContent = SENTENCE;
    const keep = [...input.childNodes];
    input.replaceChildren(probe);
    const sentence = measure(probe);
    input.replaceChildren(...keep);
    const first = cellRect(SNAP_STEPS[0]!.layout, SNAP_STEPS[0]!.cells.chat!);
    return {
      sentence,
      chat: { x: APP.x + WS.x + first.x, y: APP.y + WS.y + first.y, w: first.w, h: first.h },
      app: APP,
      desktop: WORLD,
    };
  };

  return { root, replyCount, set, rects };
}

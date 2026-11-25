// "Four things" section: a list of four beside a miniature of the app. On wide screens the
// pair is pinned and scrolling walks down the list; on narrow ones the list is tapped. Either
// way the open item puts the miniature into its state, and its controls drive it from there.
import gsap from "gsap";
import { a, type AppIcon } from "../shared/app-icons";
import { piMark } from "../shared/icons";
import { DOCK_ZONES, KINDS, LAYOUTS, PIN_MODES, SOURCE, composer, ompWindow, shot, surface, toolHead, userMessage, windowTab, type Kind, type Theme } from "../shared/ui";

interface Box { x: number; y: number; w: number; h: number; o: number }

// The miniature is laid out at a fixed size and scaled to fit with CSS zoom. On a phone it is
// a smaller app, not a smaller picture of the big one, so its type stays legible.
// The measures are the app's: title row, navigation rail, sidebar, top bar.
const SMALL = matchMedia("(max-width: 620px)").matches;
const VW = SMALL ? 720 : 1160;
const VH = SMALL ? 560 : 725;
const TOP = 34;
const RAIL = SMALL ? 0 : 50;
const SIDE = SMALL ? 184 : 244;
const BAR = 42;
const WS = { x: RAIL + SIDE, y: TOP + BAR, w: VW - RAIL - SIDE, h: VH - TOP - BAR };
/** The column of tool cards inside the conversation. */
const CARDS = SMALL ? 0 : 240;
/** A box inside the workspace, given in fractions of it. */
const part = (x: number, y: number, w: number, h: number): Omit<Box, "o"> => ({ x: WS.x + x * WS.w, y: WS.y + y * WS.h, w: w * WS.w, h: h * WS.h });
const GAP = 4;

const STEPS = [
  {
    title: "拖出来就是一个窗口",
    text: "从侧栏拖一场会话到列表外，松手就是一个浮窗。移动、最小化、收回都不会重建对话，草稿、阅读位置和终端状态全部保留。",
  },
  {
    title: "贴边吸附，六种模板",
    text: "左右边缘是半屏，四角是四分之一，顶部是最大化。新窗口吸附进来时，原来的窗口自动移到剩下最大的空位。",
  },
  {
    title: "工具停在哪都行",
    text: "Explorer、Git、Browser、Terminal、Agents 等工具都能在五个位置之间移动。拖动时就能看到落点，松手才提交。",
  },
  {
    title: "钉住，或者干脆独立出去",
    text: "图钉有五档，决定窗口跟着谁走。独立窗口在任务栏有自己的图标，可以拖到另一块显示器，重启后恢复位置。",
  },
];

const ORDER = ["chat", "plan", "browser", "git"] as const;

const ZONE_NOTES = [
  "停在左侧栏，和会话列表、Explorer 在一起。",
  "停在对话工具区，是一张可折叠的卡片，跟着这场对话走。",
  "停在右侧栏，和其他工具排成标签。右侧栏最多可以分上下两组。",
  "停在底栏，和 Terminal、OMP Logs 排成标签。底栏最多可以分左右两组。",
  "浮起来。拖到另一个浮窗的标题栏上，就合成一组标签。",
];
const PIN_NOTES = [
  "不固定：跟随当前会话的布局，只在工作台显示。",
  "固定在工作区：换到另一场会话，Git 还在。",
  "固定在应用：离开工作台去了首页，Git 还在。",
  "独立窗口：成为普通的系统窗口，任务栏有自己的图标，可以拖到另一块显示器。",
  "独立窗口并置顶：同一个独立窗口，保持在其他应用窗口上方。",
];

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const cellBox = ([cx, cy, cw, ch]: number[]): Box => {
  const l = cx! > 0.01 ? GAP / 2 : GAP;
  const t = cy! > 0.01 ? GAP / 2 : GAP;
  const r = cx! + cw! < 0.99 ? GAP / 2 : GAP;
  const b = cy! + ch! < 0.99 ? GAP / 2 : GAP;
  return { x: WS.x + cx! * WS.w + l, y: WS.y + cy! * WS.h + t, w: cw! * WS.w - l - r, h: ch! * WS.h - t - b, o: 1 };
};

const chip = (text: string, tone: string) => `<em data-tone="${tone}">${text}</em>`;
const card = (icon: AppIcon, title: string, sum: string, body = "", id = "") =>
  `<section class="mini-card"${id ? ` data-card="${id}"` : ""}${body ? " data-open" : ""}><header>${a(icon)}<b>${title}</b>${a(body ? "chevron-d" : "chevron-r", "mini-fold")}<span>${sum}</span></header>${body}</section>`;
const task = (icon: AppIcon, name: string, tone: string, time: string) => `<li>${a(icon)}<b>${name}</b><i data-tone="${tone}"></i><span class="mono">${time}</span></li>`;
const ring = (icon: AppIcon, c: string, n = "") => `<span style="--c:${c}">${a(icon)}${n ? `<b>${n}</b>` : ""}</span>`;

/** The app around the windows: title row, rail, sidebar with Explorer, top bar, tool cards. */
const APP = `<div class="mini-top">${a("layout")}${a("arrow-l")}${a("arrow-r")}<span>文件</span><span>编辑</span><span>视图</span><span>帮助</span><i></i>${a("minimize")}${a("maximize")}${a("x")}</div>
<div class="mini-rail">${(["workbench", "home", "history", "package", "server", "settings"] as const).map((n, k) => `<span${k ? "" : " data-on"}>${a(n)}</span>`).join("")}<i></i><span class="mini-up">${a("download")}</span><span class="mini-face">S</span></div>
<div class="mini-side"><header>${a("menu")}${piMark(17)}<b>OMP Studio</b><i></i>${a("search")}</header>
<p class="mini-new">${a("plus")}新建对话</p><p class="mini-new">${a("layers")}技能&插件<i></i><small>5</small>${a("chevron-r")}</p>
<p class="mini-cap">项目与对话</p>
<p class="mini-proj">${a("folder-open")}<b>omp-web</b><i></i><u></u>3</p>
<span class="mini-row" data-row="chat"><span class="os-spin"></span>跟踪上游 pi-web 更新</span>
<span class="mini-row" data-row="audit">Audit and fix OSS repo${chip("待回答", "blue")}</span>
<button class="mini-row" type="button" data-pull data-row="plan">Mermaid 全屏缩放计划${chip("待审核", "violet")}</button>
<span class="mini-row">修复 Git Bash 路径未找到${chip("待确认", "amber")}</span>
<p class="mini-proj mini-more">${a("folder")}<b>pi-web (upstream)</b></p>
<div class="mini-explorer"><header>${a("chevron-d")}${a("file-tree")}Explorer<i></i>${a("more")}</header>${surface("files")}</div></div>
<div class="mini-bar"><div class="mini-crumb">${a("folder-open")}<span>omp-web</span>${a("chevron-d")}<i>›</i>${a("branch")}<span>main</span><i>›</i><b class="mini-crumb-t"></b>${a("chevron-d")}${a("fork")}${a("handoff")}</div><div class="mini-tabs"></div><span class="mini-grow"></span>
<div class="mini-tools">${a("bot")}${a("history")}<span class="mini-meter"></span>${a("formation", "mini-t-cards")}${a("panel", "mini-t-right")}${a("light")}${a("home")}</div></div>
<div class="mini-cards">${card("cpu", "Environment", "", `<div class="mini-env"><p>${a("folder-open")}<b>omp-web</b><small>此计算机</small></p><p>${a("branch")}<span class="mono">fix/mermaid-theme</span><small>↑2</small></p><p>${a("changes")}3 个文件<small><span class="os-add">+87</span> <span class="os-del">−45</span></small></p></div>`)}
${card("layers", "Context", '22% <u style="--v:22%"></u>')}
${card("branch", "Git", '↑2 <i data-tone="amber"></i>1 M <i data-tone="green"></i>1 U <i data-tone="red"></i>1 D', "", "git")}
${card("bot", "Agents", '<i data-tone="red"></i>1 失败 <i data-tone="green"></i>2 运行')}
${card("terminal", "Background tasks", "", `<ul>${task("terminal", "bunx tsc --noEmit", "green", "28s")}${task("terminal", "npm run check", "amber", "–")}${task("server", "web-dev", "green", ":30141")}${task("server", "test-watch", "amber", "59s")}</ul>`)}</div>
<div class="mini-rings">${ring("cpu", "var(--o-border-strong)")}${ring("layers", "conic-gradient(var(--t-blue) 22%, var(--o-surface-3) 0)")}${ring("branch", "var(--t-orange)", "3")}${ring("bot", "conic-gradient(var(--t-green) 60%, var(--o-red) 0)", "4")}${ring("terminal", "var(--t-green)", "4")}</div>`;

export function mountRules(root: HTMLElement) {
  root.innerHTML = `<div class="rules-pin"><div class="rules-text"><h2 id="windows-h"><span class="keep">四件事，</span><span class="keep">就是整个工作台</span></h2><ol class="rules-steps">${STEPS.map(
    (s, n) => `<li class="rule" data-step="${n}"><h3><button type="button" id="rule-${n}" aria-controls="rule-body-${n}">${s.title}</button></h3><div class="rule-body" id="rule-body-${n}" role="region" aria-labelledby="rule-${n}"><div><p>${s.text}</p><div class="rule-ctl" data-ctl="${n}"></div></div></div><i class="rule-bar" aria-hidden="true"></i></li>`,
  ).join("")}</ol></div>
<div class="rules-stage"><div class="mini omp" data-theme="${document.documentElement.dataset.theme ?? "light"}"><div class="mini-inner">
<div class="mini-desktop" aria-hidden="true"><div class="mini-taskbar"><span class="mini-task" data-on>${piMark(20)}</span><span class="mini-task" data-task="git">${a("branch")}</span></div></div>
<div class="mini-app">${APP}<img class="mini-page" alt="" aria-hidden="true"></div>
<div class="mini-drop" aria-hidden="true"><span></span></div>
<div class="mini-menu" role="group" aria-label="固定浮窗"><p>固定浮窗</p>${PIN_MODES.map((p, n) => `<button type="button" data-pin="${n}"><span>${p}</span>${a("check")}</button>`).join("")}</div>
</div></div><p class="mini-note"></p></div></div>`;

  const mini = root.querySelector<HTMLElement>(".mini")!;
  const inner = root.querySelector<HTMLElement>(".mini-inner")!;
  const pin = root.querySelector<HTMLElement>(".rules-pin")!;
  mini.toggleAttribute("data-small", SMALL);
  inner.style.width = `${VW}px`;
  inner.style.height = `${VH}px`;
  for (const [name, v] of Object.entries({ top: TOP, rail: RAIL, side: SIDE, bar: BAR, cards: CARDS })) inner.style.setProperty(`--m-${name}`, `${v}px`);
  const app = root.querySelector<HTMLElement>(".mini-app")!;
  const crumb = root.querySelector<HTMLElement>(".mini-crumb-t")!;
  const tabs = root.querySelector<HTMLElement>(".mini-tabs")!;
  const drop = root.querySelector<HTMLElement>(".mini-drop")!;
  const menu = root.querySelector<HTMLElement>(".mini-menu")!;
  const page = root.querySelector<HTMLImageElement>(".mini-page")!;
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
    return { el, box: { ...WS, o: 0 } as Box };
  };
  const actors = {
    chat: make("chat", app, 1),
    audit: make("chat", app, 1, "Audit and fix OSS repository"),
    plan: make("plan", app, 3),
    browser: make("browser", app, 3),
    other: make("files", inner, 5, "其他应用"),
    git: make("git", inner, 6),
  };
  type Actor = keyof typeof actors;

  // The other conversation, for showing what outlives a switch.
  const auditBody = actors.audit.el.querySelector<HTMLElement>(".ow-body")!;
  auditBody.innerHTML = `<div class="os-chat"><div class="os-msgs">${userMessage("审一遍这个开源仓库，能直接修的就修", "13:40")}<p class="os-say">看完了。许可证和依赖没有问题，有两处需要你决定。</p><div class="os-tool">${toolHead("Grep", "eval\\(", a("search"))}<p class="os-cwd">2 处命中</p></div><p class="os-say">第一处在 <code>scripts/build.ts</code>，可以换成静态导入。要我改吗？</p></div>${composer()}</div>`;
  actors.other.el.querySelector(".ow-from")?.remove();
  actors.other.el.style.setProperty("--tint", "var(--o-glyph)");
  actors.other.el.querySelector(".ow-mark")!.innerHTML = a("file");
  actors.other.el.querySelector(".ow-body")!.innerHTML = `<div class="mini-doc">${"<i></i>".repeat(9)}</div>`;

  // Git wears a different head in each place it can stop.
  const git = actors.git.el;
  git.inert = false;
  git.querySelectorAll<HTMLElement>("button, input").forEach((n) => (n.tabIndex = -1));
  git.querySelector<HTMLElement>(".ow-stack")!.inert = true;
  git.insertAdjacentHTML("afterbegin", `<header class="mini-sec">${a("chevron-d")}${a("branch")}<b>Git</b><i></i>${a("more")}</header><div class="mini-strip" data-for="right">${windowTab("context", false)}${windowTab("git", true)}${a("plus")}<i></i>${a("chevron-d")}${a("expand")}</div><div class="mini-strip" data-for="bottom">${windowTab("terminal", false)}${windowTab("logs", false)}${windowTab("git", true)}${a("plus")}<i></i>${a("expand")}${a("chevron-d")}${a("x")}</div>`);
  const gitStack = git.querySelector<HTMLElement>(".ow-stack")!;
  git.querySelectorAll<HTMLElement>(".mini-strip button").forEach((n) => (n.tabIndex = -1));

  const frame = { x: 0, y: 0, s: 1 };
  const paint = (name: Actor) => {
    const { el, box } = actors[name];
    el.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    el.style.opacity = String(box.o);
    el.style.visibility = box.o < 0.01 ? "hidden" : "visible";
    if (name === "git") menu.style.transform = `translate3d(${Math.min(Math.max(box.x + box.w - 258, 8), VW - 226)}px, ${box.y + 38}px, 0)`;
  };
  const paintFrame = () => {
    app.style.transform = `translate3d(${frame.x}px, ${frame.y}px, 0) scale(${frame.s})`;
  };

  // ---- state ----
  const state = { step: -1, pulled: false, drop: null as { x: number; y: number } | null, layout: 4, zone: 2, pin: 0, float: null as { x: number; y: number } | null };
  const touched = [false, false, false, false];
  let theme = (document.documentElement.dataset.theme ?? "light") as Theme;

  const cardTop = () => (root.querySelector<HTMLElement>('[data-card="git"]')?.offsetTop ?? 0) + WS.y;
  /** Where Git stands in each of the five places. */
  function gitBox(zone: number): Box {
    if (zone === 0) return { x: RAIL, y: VH * 0.62, w: SIDE, h: VH * 0.38, o: 1 };
    if (zone === 1) return SMALL ? { ...part(0.52, 0.03, 0.46, 0.5), o: 1 } : { x: VW - CARDS, y: cardTop(), w: CARDS - 12, h: 264, o: 1 };
    const side = WS.w * (SMALL ? 0.46 : 0.4);
    const bottom = WS.h * (SMALL ? 0.46 : 0.42);
    if (zone === 2) return { x: VW - side, y: WS.y, w: side, h: WS.h, o: 1 };
    if (zone === 3) return { x: WS.x, y: VH - bottom, w: WS.w, h: bottom, o: 1 };
    const w = SMALL ? 300 : 400;
    const h = SMALL ? 300 : 340;
    const at = state.float ?? { x: WS.x + WS.w * (SMALL ? 0.36 : 0.22), y: WS.y + WS.h * 0.16 };
    return { x: Math.min(Math.max(at.x, 8), VW - w - 8), y: Math.min(Math.max(at.y, WS.y), VH - h - 8), w, h, o: 1 };
  }

  function targets() {
    const hidden = (b: Omit<Box, "o">): Box => ({ ...b, o: 0 });
    const full: Box = { ...WS, o: 1 };
    const float = SMALL ? part(0.3, 0.1, 0.6, 0.62) : part(0.34, 0.07, 0.46, 0.6);
    const t: Record<Actor, Box> = {
      chat: full,
      audit: hidden(WS),
      plan: hidden({ x: RAIL + 8, y: TOP + 170, w: WS.w * 0.31, h: WS.h * 0.27 }),
      browser: hidden(part(0.52, 0.54, 0.43, 0.4)),
      other: hidden(part(0.32, 0.38, 0.41, 0.4)),
      git: hidden(float),
    };
    let frameTo = { x: 0, y: 0, s: 1 };
    let text = "";
    let on: "chat" | "plan" | "audit" = "chat";

    if (state.step === 0) {
      if (state.pulled) {
        const w = WS.w * (SMALL ? 0.72 : 0.56);
        const h = WS.h * (SMALL ? 0.7 : 0.66);
        const cx = state.drop?.x ?? WS.x + WS.w * 0.6;
        const cy = state.drop?.y ?? WS.y + WS.h * 0.3;
        t.plan = { w, h, o: 1, x: Math.min(Math.max(cx - w / 2, WS.x + 12), WS.x + WS.w - w - 12), y: Math.min(Math.max(cy - 20, WS.y + 12), WS.y + WS.h - h - 12) };
        text = "「Mermaid 全屏缩放计划」现在是一个浮窗，主对话没有动。";
        on = "plan";
      } else {
        text = "把侧栏里的「Mermaid 全屏缩放计划」拖进工作区，或者直接点它。";
      }
    } else if (state.step === 1) {
      const cells = LAYOUTS[state.layout]!.cells;
      ORDER.forEach((name, n) => {
        if (cells[n]) t[name] = cellBox(cells[n]);
        else if (name === "chat") t.chat = hidden(WS);
      });
      text = `${LAYOUTS[state.layout]!.name}。对话全在窗口里时，顶栏换成窗口标签栏；放不下的窗口留在标签里。`;
    } else if (state.step === 2) {
      t.git = gitBox(state.zone);
      if (state.zone === 2) t.chat = { ...WS, w: WS.w - t.git.w, o: 1 };
      if (state.zone === 3) t.chat = { ...WS, h: WS.h - t.git.h, o: 1 };
      text = ZONE_NOTES[state.zone]!;
    } else if (state.step === 3) {
      t.git = { ...float, o: 1 };
      text = PIN_NOTES[state.pin]!;
      if (state.pin === 1) {
        t.audit = full;
        t.chat = hidden(WS);
        on = "audit";
      } else if (state.pin >= 3) {
        frameTo = { x: 24, y: 20, s: 0.66 };
        t.git = { x: VW * 0.6, y: VH * 0.3, w: VW * 0.37, h: VH * 0.56, o: 1 };
        if (state.pin === 4) t.other = { x: VW * 0.42, y: VH * 0.46, w: VW * 0.36, h: VH * 0.4, o: 1 };
      }
    }
    return { t, frameTo, text, on };
  }

  function render(instant = false) {
    // Set first: Git's card makes room, and is then measured.
    mini.dataset.zone = state.step === 2 ? String(state.zone) : state.step === 3 ? "4" : "";
    const { t, frameTo, text, on } = targets();
    const duration = instant || reduced() ? 0 : 0.62;
    const ease = "expo.out";
    (Object.keys(actors) as Actor[]).forEach((name, n) => {
      const box = actors[name].box;
      // A hidden actor jumps to where it will appear from, then fades in while moving.
      if (box.o < 0.01 && t[name].o > 0 && name !== "plan") Object.assign(box, { ...t[name], o: 0, y: t[name].y + (name === "chat" || name === "audit" ? 0 : 24) });
      gsap.to(box, { ...t[name], duration, ease, delay: duration ? n * 0.02 : 0, overwrite: true, onUpdate: () => paint(name) });
      if (!duration) paint(name);
    });
    gsap.to(frame, { ...frameTo, duration, ease, overwrite: true, onUpdate: paintFrame });
    if (!duration) paintFrame();
    note.textContent = text;
    mini.dataset.step = String(state.step);
    mini.toggleAttribute("data-standalone", state.step === 3 && state.pin >= 3);
    mini.toggleAttribute("data-ontop", state.step === 3 && state.pin === 4);
    mini.toggleAttribute("data-page", state.step === 3 && state.pin === 2);
    mini.toggleAttribute("data-narrow", state.step === 2 && state.zone === 2);
    mini.toggleAttribute("data-menu", state.step === 3);
    pullRow.toggleAttribute("data-out", state.step === 0 && state.pulled);
    root.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => row.toggleAttribute("data-on", row.dataset.row === on));
    crumb.textContent = on === "plan" ? KINDS.plan.title : on === "audit" ? "Audit and fix OSS repository" : SOURCE;
    // In the main area a conversation has no frame; snapped, it is a window like any other.
    const plain = state.step !== 1;
    actors.chat.el.toggleAttribute("data-plain", plain);
    actors.audit.el.toggleAttribute("data-plain", true);
    mini.toggleAttribute("data-windowed", !plain);
    const front: Actor | "" = state.step === 0 ? (state.pulled ? "plan" : "") : state.step === 1 ? "chat" : state.step === 2 && state.zone !== 4 ? "" : "git";
    (Object.keys(actors) as Actor[]).forEach((name) => actors[name].el.toggleAttribute("data-focused", name === front));
    if (!plain) {
      const cells = LAYOUTS[state.layout]!.cells.length;
      tabs.innerHTML = ORDER.map((name, n) => {
        const k = KINDS[name];
        return `<span class="wm-tab" style="--tint:${k.tint}"${n === 0 ? " data-on" : ""}${n >= cells ? " data-min" : ""}><button type="button" tabindex="-1">${a(k.icon)}<span class="wm-tab-t">${k.title}</span>${n < 2 ? `<span class="ow-dot" data-tone="${n ? "amber" : "green"}"></span>` : ""}</button></span>`;
      }).join("") + a("plus");
    }
    git.dataset.dock = state.step === 2 ? ["left", "card", "right", "bottom", "float"][state.zone]! : "float";
    articles.forEach((el, n) => {
      const open = n === state.step;
      el.toggleAttribute("data-active", open);
      el.querySelector("h3 button")!.setAttribute("aria-expanded", String(open));
      el.querySelector<HTMLElement>(".rule-body")!.inert = !open;
    });
    menu.inert = state.step !== 3;
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
    pullBtn.textContent = state.pulled ? "收回去" : "把「Mermaid 全屏缩放计划」拖出来";
    pullBtn.setAttribute("aria-pressed", String(state.pulled));
    root.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.layout) === state.layout)));
    root.querySelectorAll<HTMLElement>("[data-zone]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.zone) === state.zone)));
    root.querySelectorAll<HTMLElement>("[data-pin]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.pin) === state.pin)));
  }

  const act = (step: number, change: () => void) => {
    touched[step] = true;
    // Only what the visitor does is announced, not the miniature's own walk.
    note.setAttribute("aria-live", "polite");
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

  menu.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-pin]");
    if (b) act(3, () => (state.pin = Number(b.dataset.pin)));
  });

  // Carrying Git to one of its five places, by whatever head it is wearing.
  const zoneAt = (x: number, y: number) => {
    if (x < WS.x - 12) return 0;
    if (y > VH - WS.h * 0.24) return 3;
    if (x > VW - (SMALL ? 90 : 74)) return 2;
    if (!SMALL && x > VW - CARDS) return 1;
    return 4;
  };
  const ZONE_LABELS = ["停到左侧栏", "停到对话工具区", "停到右侧栏", "停到底栏", "作为浮窗"];
  git.addEventListener("pointerdown", (e) => {
    if (state.step !== 2 || e.button !== 0 || !(e.target as Element).closest(".ow-bar, .mini-sec, .mini-strip")) return;
    if (gitStack.contains(e.target as Node)) return;
    const k = inner.getBoundingClientRect().width / VW;
    const o = inner.getBoundingClientRect();
    const at = (ev: PointerEvent) => ({ x: (ev.clientX - o.left) / k, y: (ev.clientY - o.top) / k });
    let zone = -1;
    const show = (z: number, p: { x: number; y: number }) => {
      if (z === 4) state.float = { x: p.x - 90, y: p.y - 17 };
      const b = gitBox(z);
      Object.assign(drop.style, { transform: `translate3d(${b.x}px, ${b.y}px, 0)`, width: `${b.w}px`, height: `${b.h}px` });
      drop.firstElementChild!.textContent = ZONE_LABELS[z]!;
      if (mini.dataset.over === String(z)) return;
      mini.dataset.over = String(z);
      // The conversation rehearses the room it would have.
      const was = state.zone;
      state.zone = z;
      gsap.to(actors.chat.box, { ...targets().t.chat, duration: reduced() ? 0 : 0.4, ease: "expo.out", overwrite: true, onUpdate: () => paint("chat") });
      state.zone = was;
      mini.dataset.zone = String(z);
      mini.toggleAttribute("data-narrow", z === 2);
    };
    const move = (ev: PointerEvent) => {
      if (zone < 0) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
        git.setPointerCapture(e.pointerId);
        touched[2] = true;
        mini.dataset.carrying = "";
        git.dataset.dock = "float";
        gsap.killTweensOf(actors.git.box);
        Object.assign(actors.git.box, { w: SMALL ? 260 : 340, h: SMALL ? 220 : 280 });
      }
      const p = at(ev);
      zone = zoneAt(p.x, p.y);
      Object.assign(actors.git.box, { x: p.x - 90, y: p.y - 17 });
      paint("git");
      show(zone, p);
    };
    const end = (keep: boolean) => {
      git.removeEventListener("pointermove", move);
      git.removeEventListener("pointerup", up);
      git.removeEventListener("pointercancel", cancel);
      delete mini.dataset.carrying;
      delete mini.dataset.over;
      if (zone < 0) return;
      if (keep) act(2, () => (state.zone = zone));
      else render();
    };
    const up = () => end(true);
    const cancel = () => end(false);
    git.addEventListener("pointermove", move);
    git.addEventListener("pointerup", up);
    git.addEventListener("pointercancel", cancel);
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
      if (x > WS.x && y > TOP && x < VW && y < VH) act(0, () => { state.pulled = true; state.drop = { x, y }; });
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

  // ---- scroll picks the step while the section is pinned; pressing a title always does ----
  const pinned = matchMedia("(min-width: 961px) and (min-height: 620px)");
  const bars = articles.map((a) => a.querySelector<HTMLElement>(".rule-bar")!);
  let queued = false;
  let held = 0;
  const travel = () => root.offsetHeight - pin.offsetHeight;
  const pick = () => {
    queued = false;
    if (!pinned.matches) return;
    const p = Math.min(Math.max((pin.getBoundingClientRect().top - root.getBoundingClientRect().top) / Math.max(travel(), 1), 0), 0.9999) * STEPS.length;
    bars.forEach((bar, n) => bar.style.setProperty("--p", String(Math.min(Math.max(p - n, 0), 1))));
    const step = Math.floor(p);
    if (step === state.step || performance.now() < held) return;
    state.step = step;
    render();
  };
  addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(pick);
  }, { passive: true });
  articles.forEach((a, n) => a.querySelector("h3 button")!.addEventListener("click", () => {
    state.step = n;
    render();
    if (!pinned.matches) return;
    // Land a little way into the step, and let the list keep this choice until the scroll arrives.
    held = performance.now() + (reduced() ? 80 : 1000);
    scrollTo({ top: scrollY + root.getBoundingClientRect().top + (travel() * (n + 0.35)) / STEPS.length - parseFloat(getComputedStyle(pin).top || "0") });
  }));
  pinned.addEventListener("change", pick);
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
    setTheme(next: Theme) {
      theme = next;
      mini.dataset.theme = next;
      page.src = shot("home", theme);
    },
  };
}

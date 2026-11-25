// OMP Studio product kit: builds the app's surfaces as real DOM.
// The demo story (project omp-web, the pi-web sync, the TS2322 error) is the
// same one the app's own preview mode tells. Styles live in ui.css.
import { a, type AppIcon } from "./app-icons";
import { t } from "./i18n";
import { type IconName } from "./icons";

export type Theme = "light" | "dark";

export type Kind =
  | "chat" | "plan" | "git" | "terminal" | "browser"
  | "agents" | "context" | "files" | "logs" | "changes";

export interface KindInfo {
  title: string;
  /** Short status beside the title; empty when the app shows none. */
  sub: string;
  icon: AppIcon;
  /** The app's window colour for this kind, as a theme-aware variable (ui.css). */
  tint: string;
}

export const KINDS: Record<Kind, KindInfo> = {
  chat: { title: t("跟踪上游 pi-web 更新", "Sync upstream pi-web"), sub: t("运行中", "Running"), icon: "message", tint: "var(--t-violet)" },
  plan: { title: t("Mermaid 全屏缩放计划", "Mermaid zoom plan"), sub: t("等待审批", "Awaiting approval"), icon: "message", tint: "var(--t-blue)" },
  git: { title: "Git", sub: "", icon: "branch", tint: "var(--t-orange)" },
  terminal: { title: "Terminal", sub: "", icon: "terminal", tint: "var(--t-green)" },
  browser: { title: "Browser", sub: "", icon: "globe", tint: "var(--t-blue)" },
  agents: { title: "Agents", sub: "", icon: "bot", tint: "var(--t-pink)" },
  context: { title: "Context", sub: "", icon: "layers", tint: "var(--t-blue)" },
  files: { title: "Explorer", sub: "", icon: "file-tree", tint: "var(--t-indigo)" },
  logs: { title: "OMP Logs", sub: "", icon: "console", tint: "var(--t-amber)" },
  changes: { title: "Changes", sub: "", icon: "changes", tint: "var(--t-teal)" },
};

/** Conversations are windows too, with a title bar of their own. */
export const isConversation = (kind: Kind) => kind === "chat" || kind === "plan";
/** The conversation every tool window here belongs to; the app names it in the tool's title. */
export const SOURCE = KINDS.chat.title;

const chip = (text: string, tone = "") => `<span class="os-chip"${tone ? ` data-tone="${tone}"` : ""}>${text}</span>`;

/** A sent message: who and when above, the bubble below. */
export const userMessage = (html: string, time = "14:02") => `<div class="os-me"><span class="os-face">S</span><b>${t("你", "You")}</b><time>${time}</time></div><div class="os-user">${html}</div>`;

/** The header line of a tool call; `state` is its spinner or mark. */
export const toolHead = (name: string, arg: string, state: string) => `<div class="os-tool-h">${state}<span>${name}</span><i>·</i><span class="mono">${arg}</span><span class="os-grow"></span>${a("chevron-u")}</div>`;

export const composer = () => `<div class="os-composer">
<input class="os-composer-input" type="text" placeholder="${t("输入消息…", "Type a message...")}" aria-label="${t("输入消息", "Message input")}" autocomplete="off" maxlength="200">
<div class="os-composer-row">${a("attach")}${a("at")}${a("slash")}
<span class="os-perm">${a("shield")}Full Access</span>${a("plus", "os-hide-s")}
<span class="os-grow"></span><span class="os-model">Claude Sonnet 4.5${a("chevron-d")}</span><span class="os-model os-hide-s">Off${a("chevron-d")}</span>
${a("zap", "os-hide-s")}${a("history", "os-hide-s")}${a("mic", "os-hide-s")}<button class="os-send" type="button" aria-label="${t("发送", "Send")}">${a("stop", "os-stop")}${a("arrow-u", "os-go")}</button></div></div>`;

/** The floating line above the composer: how far the run is and what it has changed. */
export const stepPill = (step: string, files: string, add: string, del: string) => `<div class="os-pill"><span class="os-ringlet"></span><b>${step}</b><i>·</i><span class="os-files">${files}</span><span class="os-add">${add}</span><span class="os-del">${del}</span></div>`;

/** The demo site inside the browser window. */
export const WEB_PAGES = [
  { title: "Overview", text: "Five components, one set of tokens. Pick one to see it.", demo: '<div class="os-swatch"><i></i><i></i><i></i><i></i></div>' },
  { title: "Button", text: "Buttons trigger an action or event. Use one primary button per view.", demo: '<button class="os-btn" data-primary type="button">Preview button</button><button class="os-btn" type="button">Cancel</button>' },
  { title: "Input", text: "Inputs let people enter text. Put the label above the field.", demo: '<input class="os-field" type="text" value="omp-studio" aria-label="Input demo" autocomplete="off">' },
  { title: "Select", text: "Selects offer one choice from a short list.", demo: '<button class="os-btn" type="button">fix/mermaid-theme</button><button class="os-btn" type="button">main</button>' },
  { title: "Toast", text: "Toasts confirm what just happened, then leave.", demo: '<button class="os-btn" data-primary type="button" data-toast>Show toast</button>' },
];

/** The diffs behind the Git window's rows. */
export const DIFFS: [n: number, kind: "" | "+" | "-", text: string][][] = [
  [[241, "", " const renderMermaid = useCallback(async (theme) => {"], [242, "", '   const mermaid = await import("mermaid");'], [243, "-", "-  const codeTheme = getCodeTheme() as string;"], [243, "+", "+  const codeTheme = resolveTheme(theme);"], [244, "+", "+  mermaid.initialize({ theme: codeTheme });"], [245, "", "   return mermaid.render(id, source);"]],
  [[1, "+", '+import { useState } from "react";'], [2, "+", '+import { listDirs } from "../lib/fs";'], [3, "+", "+"], [4, "+", "+export function DirectoryPicker({ onPick }) {"], [5, "+", '+  const [path, setPath] = useState("~");'], [6, "+", "+  return <Tree root={path} onOpen={onPick} />;"]],
  [[1, "-", "-export function legacyZoom(el, scale) {"], [2, "-", "-  el.style.zoom = String(scale);"], [3, "-", "-  el.scrollTop *= scale;"], [4, "-", "-}"]],
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const diffRows = (file: number) => DIFFS[file]!.map(([n, k, s]) => `<div data-n="${n}"${k ? ` data-k="${k}"` : ""}>${esc(s)}</div>`).join("");

const SURFACES: Record<Kind, () => string> = {
  chat: () => `<div class="os-chat"><div class="os-msgs">
${userMessage(t("先看看上游这次改了什么", "Check what changed upstream first"), "14:01")}
<p class="os-say">${t("上游 pi-web <code>v0.8.1</code> 调整了 Mermaid 渲染入口和缩放事件，共 14 个提交，其中 3 个会影响 omp-web。", "Upstream pi-web <code>v0.8.1</code> changed Mermaid entrypoints and zoom events across 14 commits; 3 affect omp-web.")}</p>
${userMessage(t(`把上游 pi-web <code>v0.8.1</code> 同步进 omp-web，先读 <span class="os-ref">${a("folder")}docs</span> 和 <span class="os-ref">${a("file")}package.json</span>`, `Sync upstream pi-web <code>v0.8.1</code> into omp-web. Start with <span class="os-ref">${a("folder")}docs</span> and <span class="os-ref">${a("file")}package.json</span>`))}
<p class="os-say">${t("好的。先核对上游的变更，再同步依赖并跑一遍检查。", "Sure. I will inspect the upstream diff, sync deps, and run checks.")}</p>
<ul class="os-todo"><li data-done>${t("核对本地路径", "Verify local paths")}</li><li data-done>${t("复查类型错误", "Inspect type errors")}</li><li>${t("确认缩放交互", "Verify zoom behavior")}</li></ul>
<div class="os-tool">${toolHead("Bash", "npm run typecheck", '<span class="os-spin"></span>')}
<p class="os-cwd">cwd <b class="mono">D:/Project/omp-web</b></p>
<pre>$ <b>npm run typecheck</b>
&gt; tsc --noEmit

src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.</pre></div>
<div class="os-working">${a("console")}<b>working</b><i>·</i><span class="os-dim">54s</span><i>·</i>${t("正在运行", "Running")} <span class="mono">npm run check</span></div>
</div>${stepPill(t("第 5 / 7 步", "Step 5 / 7"), t("2 个文件已更改", "2 files changed"), "+87", "−4")}${composer()}</div>`,

  plan: () => `<div class="os-chat os-chat-plan"><div class="os-msgs"><div class="os-tool">${toolHead("Write", "mermaid-zoom-inertia-plan.md", a("file"))}<p class="os-cwd">${t("写入 3 行", "Wrote 3 lines")}</p></div></div><div class="os-plan">
<div class="os-plan-h">${a("alert")}Plan Review<span>${t("主 Agent · 14:09", "Main Agent · 14:09")}</span>${a("expand")}</div>
<div class="os-plan-b"><h4>${t("Preview 缩放惯性", "Preview zoom inertia")}</h4>
<h4>${t("目标", "Goal")}</h4><p>${t("冻结 Preview <b>缩放协议</b>，补上拖拽惯性开关，再用类型检查确认 Mermaid 全屏路径。", "Freeze the Preview <b>zoom protocol</b>, add a pan inertia toggle, and verify Mermaid fullscreen via typecheck.")}</p>
<h4>${t("实施步骤", "Plan steps")}</h4><ol><li>${t("核对现有 Preview 面板的 pan / zoom 事件，列出惯性开关要接的状态。", "Audit existing pan / zoom events in Preview and list states for the inertia toggle.")}</li><li>${t("默认关闭惯性；打开后松手继续滑行。", "Disable inertia by default; when enabled, coast after release.")}</li><li>${t("跑 <code>npm run check</code>，按报错收尾。", "Run <code>npm run check</code> and fix any remaining diagnostics.")}</li></ol></div>
<div class="os-plan-f"><button class="os-btn" data-primary data-approve type="button">${t("批准并执行", "Approve & run")}</button><button class="os-btn" data-approve type="button">${t("批准并保留上下文", "Approve & keep context")}</button><button class="os-btn" data-refine type="button">${t("修改计划", "Refine plan")}</button></div></div></div>`,

  git: () => `<div class="os-git">
<div class="os-git-top">${a("branch")}<b>fix/mermaid-theme</b><span class="os-grow"></span><span class="os-iseg"><span data-on>${a("changes")}</span><span>${a("history")}</span><span>${a("issue")}</span><span>${a("pull-request")}</span></span></div>
<div class="os-git-tabs"><span data-on>${t("未暂存", "Unstaged")} <b>3</b></span><span>${t("已暂存", "Staged")} 2</span><span class="os-grow"></span><span class="os-add">+87</span><span class="os-del">−45</span></div>
<div class="os-changes"><button type="button" class="os-row" data-diff="0" data-on><span class="os-stat" data-s="M">M</span><span class="os-grow">MermaidBlock.tsx</span><span class="os-add">+6</span><span class="os-del">−3</span>${a("plus")}</button>
<button type="button" class="os-row" data-diff="1"><span class="os-stat" data-s="U">U</span><span class="os-grow">DirectoryPicker.tsx</span><span class="os-add">+81</span>${a("plus")}</button>
<button type="button" class="os-row" data-diff="2"><span class="os-stat" data-s="D">D</span><span class="os-grow">legacyZoom.ts</span><span class="os-del">−42</span>${a("plus")}</button></div>
<div class="os-diff">${diffRows(0)}</div>
<div class="os-commit"><input class="os-field" type="text" placeholder="${t("提交信息…", "Commit message...")}" aria-label="${t("提交信息", "Commit message")}" autocomplete="off" maxlength="80"><button class="os-btn" data-primary data-commit type="button">${t("提交", "Commit")}</button></div>
<div class="os-pr">${a("pull-request")}<span><b>#47</b> ${t("修复 Mermaid 主题切换并补充回归验证", "Fix Mermaid theme switch & add regression test")}<small><em>${t("检查通过", "Checks passed")}</em> · ${t("等待评审", "Awaiting review")}</small></span></div>
<div class="os-git-foot">${t("查看全部", "View all")}${a("chevron-r")}<span class="os-dim os-ahead">↑2 ↓0</span><span class="os-grow"></span>${a("refresh")}${a("arrow-d")}${a("arrow-u")}${a("more")}</div></div>`,

  terminal: () => `<div class="os-term"><span class="os-dim">PS D:\\Project\\omp-web&gt;</span> <b>npm run check</b>
<span class="os-ok">✓</span> arch constraints   213 rules
<span class="os-ok">✓</span> renderer selects
<span class="os-ok">✓</span> tsc --noEmit       0 errors
<span class="os-ok">✓</span> core tests         214 / 214
  packages/studio-protocol   48 passed
  packages/client-contract   61 passed
<span class="os-dim">PS D:\\Project\\omp-web&gt;</span> <span class="os-cmd"><input type="text" aria-label="${t("在演示终端里输入命令", "Type a command in the demo terminal")}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60"></span></div>`,

  browser: () => `<div class="os-web">
<div class="os-urlbar">${a("arrow-l")}${a("arrow-r")}${a("refresh")}<div class="os-url">${a("globe")}localhost:5173/components</div>
<div class="os-handoff" role="group" aria-label="${t("控制权", "Control handoff")}"><button type="button" data-hand="agent" data-on aria-pressed="true">${a("bot")}Agent</button><button type="button" data-hand="me" aria-pressed="false">${t("我", "Me")}</button></div>${a("more")}</div>
<div class="os-kit"><i></i><b>Studio Kit</b><span data-on>Components</span><span>Tokens</span><span>Changelog</span></div>
<div class="os-page"><nav>${WEB_PAGES.map((p, n) => `<button type="button" data-web="${n}"${n === 1 ? " data-on" : ""}>${p.title}</button>`).join("")}</nav>
<main><h4>${WEB_PAGES[1]!.title}</h4><p>${WEB_PAGES[1]!.text}</p><div class="os-demo">${WEB_PAGES[1]!.demo}</div></main></div></div>`,

  agents: () => `<div class="os-agents">
<div class="os-agent"><span class="os-avatar">${a("bot")}</span><b>${t("主对话", "Main chat")}</b>${chip(t("运行中", "Running"), "green")}<small>${t("正在运行 npm run check · 3.5M tokens", "Running npm run check · 3.5M tokens")}</small></div>
<div class="os-agent"><span class="os-avatar">${a("bot")}</span><b>${t("deps 子 Agent", "deps subagent")}</b>${chip(t("运行中", "Running"), "green")}<small>grep "pi-web" package.json · 412k tokens</small></div>
<div class="os-agent"><span class="os-avatar">${a("bot")}</span><b>${t("preview 子 Agent", "preview subagent")}</b>${chip(t("待审批", "Pending"), "amber")}<small>${t("等待批准 Preview 缩放计划 · 96k tokens", "Awaiting Preview plan approval · 96k tokens")}</small></div>
<div class="os-agent"><span class="os-avatar">${a("bot")}</span><b>${t("lint 子 Agent", "lint subagent")}</b>${chip(t("已完成", "Done"))}<small>${t("修复 3 处 lint · 58k tokens", "Fixed 3 lint issues · 58k tokens")}</small></div></div>`,

  context: () => `<div class="os-ctx">
<div class="os-ctx-h"><strong>22<small>%</small></strong>${t("已使用", "used")}<span class="os-grow"></span><b class="mono">220.4k</b><span class="mono">/ 1M</span></div>
<div class="os-ctx-bar"><i style="--v:12.3%;--c:var(--t-blue)"></i><i style="--v:1.8%;--c:var(--t-orange)"></i><i style="--v:4.2%;--c:var(--t-green)"></i><i style="--v:3.7%;--c:var(--t-violet)"></i></div>
<ul>${([[t("对话消息", "Messages"), "123.4k", "12.3%", "var(--t-blue)"], [t("工具定义", "Tool defs"), "18k", "1.8%", "var(--t-orange)"], [t("系统上下文", "System ctx"), "42k", "4.2%", "var(--t-green)"], [t("系统提示词", "System prompt"), "13k", "1.3%", "var(--t-violet)"], [t("技能目录", "Skills"), "24k", "2.4%", "var(--t-violet)"], [t("剩余空间", "Remaining"), "779.6k", "78.0%", "var(--o-surface-3)"]] as const).map(([n, k, p, c]) => `<li style="--c:${c}"><i></i>${n}<span class="mono">${k}</span><span class="mono">${p}</span></li>`).join("")}</ul>
<div class="os-ctx-f">${chip(t("缓存可用", "Cache ready"), "green")}<span class="os-grow"></span><button class="os-btn" type="button" data-compact>${a("restore")}${t("压缩", "Compact")}</button></div></div>`,

  files: () => `<div class="os-tree">
<button type="button" data-dir aria-expanded="true">${a("chevron-d")}${a("folder-open")}app</button>
<div class="os-sub"><div data-s="M">${a("code")}App.tsx<span class="os-stat" data-s="M">M</span></div><div>${a("code")}main.tsx</div></div>
<button type="button" data-dir aria-expanded="true">${a("chevron-d")}${a("folder-open")}components</button>
<div class="os-sub"><div data-s="A">${a("code")}DirectoryPicker.tsx<span class="os-stat" data-s="A">A</span></div><div data-s="M">${a("code")}MermaidBlock.tsx<span class="os-stat" data-s="M">M</span></div><div>${a("code")}ChatTimeline.tsx</div><div>${a("code")}CodeBlock.tsx</div></div>
<button type="button" data-dir aria-expanded="false">${a("chevron-d")}${a("folder")}docs</button>
<div class="os-sub" hidden><div>${a("file")}README.md</div><div>${a("file")}zoom.md</div></div>
<button type="button" data-dir aria-expanded="false">${a("chevron-d")}${a("folder")}lib</button>
<div class="os-sub" hidden><div data-s="M">${a("code")}zoom.ts<span class="os-stat" data-s="M">M</span></div></div></div>`,

  logs: () => `<div class="os-logs">
<div><time>14:09:21</time><em data-l="OK">OK</em><span>bridge handshake · epoch 7</span></div>
<div><time>14:09:21</time><em data-l="INFO">INFO</em><span>runtime 19.0.1 studio-host ready</span></div>
<div><time>14:09:24</time><em data-l="INFO">INFO</em><span>session attach omp-web</span></div>
<div><time>14:09:31</time><em data-l="INFO">INFO</em><span>tool_call bash npm run typecheck</span></div>
<div><time>14:09:38</time><em data-l="WARN">WARN</em><span>tsc exited 2 · 1 diagnostic</span></div>
<div><time>14:09:40</time><em data-l="INFO">INFO</em><span>agent spawn deps (worker)</span></div>
<div><time>14:09:52</time><em data-l="OK">OK</em><span>checkpoint turn 5 saved</span></div></div>`,

  changes: () => `<div class="os-tree">
<p class="os-turn">${t("第 5 轮 · 3 个文件", "Turn 5 · 3 files")} <span class="os-add">+223</span> <span class="os-del">−4</span></p>
<div data-s="M">${a("code")}components/MermaidBlock.tsx<span class="os-stat" data-s="M">M</span></div>
<div data-s="A">${a("code")}components/DirectoryPicker.tsx<span class="os-stat" data-s="A">A</span></div>
<div data-s="M">${a("code")}app/App.tsx<span class="os-stat" data-s="M">M</span></div>
<p class="os-turn">${t("第 4 轮 · 2 个文件", "Turn 4 · 2 files")} <span class="os-add">+87</span></p>
<div data-s="M">${a("code")}package.json<span class="os-stat" data-s="M">M</span></div>
<div data-s="M">${a("code")}lib/zoom.ts<span class="os-stat" data-s="M">M</span></div></div>`,
};

/** Inner HTML of one surface, without window chrome. */
export const surface = (kind: Kind) => SURFACES[kind]();

export interface WindowOptions {
  kind: Kind;
  title?: string;
}

const BUTTONS = {
  pin: ["pin", t("固定浮窗", "Pin window")],
  min: ["minimize", t("最小化", "Minimize")],
  max: ["maximize", t("最大化，悬停可选布局", "Maximize, hover for layouts")],
  close: ["x", t("关闭", "Close")],
} as const;

/** The left part of a title bar. `count` is how many tabs share the window. */
export function windowHead(kind: Kind, opts: { title?: string; sub?: string; count?: number } = {}) {
  const info = KINDS[kind];
  const title = opts.title ?? info.title;
  const sub = opts.sub ?? info.sub;
  const count = opts.count ?? 1;
  const badge = count > 1 ? `<span class="ow-count">${count}</span>` : "";
  const mark = `<span class="ow-mark">${a(info.icon)}</span>`;
  if (!isConversation(kind)) return `${mark}<span class="ow-title">${title}<span class="ow-from"> · ${SOURCE}</span></span>${badge}<span class="ow-grow"></span>`;
  const amber = sub === "等待审批" || sub === "计划已更新" || sub === "Awaiting approval" || sub === "Plan updated";
  return `${mark}<span class="ow-title">${title}</span>${a("chevron-d", "ow-chev")}${badge}<span class="ow-grow"></span><span class="ow-src">${a("folder")}omp-web</span><span class="ow-dot" data-tone="${amber ? "amber" : "green"}"></span><span class="ow-sub">${sub}</span><button class="ow-btn" type="button" data-act="more" aria-label="${t("对话窗口选项", "Conversation window options")}">${a("more")}</button>`;
}

/** A product window: title bar, tab strip (hidden until there are two tabs) and one surface. */
export function ompWindow(options: WindowOptions): HTMLElement {
  const el = document.createElement("article");
  el.className = "ow";
  el.dataset.kind = options.kind;
  el.style.setProperty("--tint", KINDS[options.kind].tint);
  const buttons = (Object.keys(BUTTONS) as (keyof typeof BUTTONS)[])
    .map((b) => `<button class="ow-btn" type="button" data-act="${b}" aria-label="${BUTTONS[b][1]}">${a(BUTTONS[b][0])}</button>`)
    .join("");
  el.innerHTML = `<header class="ow-bar"><span class="ow-head">${windowHead(options.kind, options)}</span>${buttons}</header><div class="ow-tabs" hidden></div><div class="ow-stack"><div class="ow-body">${surface(options.kind)}</div></div>`;
  return el;
}

/** One tab of a window's strip. */
export const windowTab = (kind: Kind, on: boolean, ghost = false) =>
  `<span class="ow-tab" data-tab="${kind}" style="--tint:${KINDS[kind].tint}"${on ? " data-on" : ""}${ghost ? " data-ghost" : ""}><button type="button" class="ow-tab-l" role="tab" aria-selected="${on}">${a(KINDS[kind].icon)}<span>${KINDS[kind].title}</span></button><button type="button" class="ow-tab-x" data-tab-close aria-label="${t("关闭", "Close")} ${KINDS[kind].title}" tabindex="-1">${a("x")}</button></span>`;

// ---------------- Screenshots of the app's full pages ----------------
const shotUrls = import.meta.glob<string>("./shots/*.webp", { eager: true, query: "?url", import: "default" });

export type Shot = "home" | "history" | "agent-hub" | "model-config" | "capabilities" | "settings";

/** URL of a real screenshot (recorded in preview mode with demo data). */
export const shot = (name: Shot, theme: Theme = "light") => shotUrls[`./shots/${name}-${theme}.webp`]!;

// ---------------- Shared copy & layout definitions ----------------

/** The six layout templates of the snap picker, as [x, y, w, h] fractions. */
export const LAYOUTS: { name: string; cells: [number, number, number, number][] }[] = [
  { name: t("左右各半", "Two columns"), cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  { name: t("左右 2:1", "Wide left (2:1)"), cells: [[0, 0, 2 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { name: t("三列", "Three columns"), cells: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { name: t("左侧上下与右半", "Stacked left + right"), cells: [[0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0, 0.5, 1]] },
  { name: t("左半与右侧上下", "Left + stacked right"), cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  { name: t("四宫格", "Four quarters"), cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
];

export const PIN_MODES = [
  t("不固定", "Unpinned"),
  t("固定在工作区", "Pin to workspace"),
  t("固定在应用", "Pin to app"),
  t("独立窗口", "Standalone window"),
  t("独立窗口并置顶", "Always on top"),
];

export const DOCK_ZONES = [
  t("左侧栏", "Left sidebar"),
  t("对话工具区", "Chat tools"),
  t("右侧栏", "Right sidebar"),
  t("底栏", "Bottom bar"),
  t("浮窗", "Floating"),
];

export interface PageFeature {
  shot: Shot;
  icon: IconName;
  /** Short name on the tab. */
  tab: string;
  title: string;
  text: string;
}

/** Full pages of the app, each with a real screenshot. */
export const PAGES: PageFeature[] = [
  { shot: "home", icon: "house", tab: t("首页", "Home"), title: t("首页与用量", "Home & Usage"), text: t("最近项目一键回到工作台。Token 折线图和热力图按年、月、周、日切换。", "Jump back into recent projects in one click. Switch Token line charts and heatmaps by year, month, week, or day.") },
  { shot: "history", icon: "history", tab: t("会话历史", "History"), title: t("会话历史与 Time Travel", "Session History & Time Travel"), text: t("按回合保存工作区快照。可以只恢复代码、只恢复对话，或两者都恢复，恢复前会留备份。", "Save workspace snapshots per turn. Restore code only, conversation only, or both, with automatic pre-restore backup.") },
  { shot: "agent-hub", icon: "bot", tab: "Agent Hub", title: "Agent Hub", text: t("集中查看主对话和全部子 Agent 的状态、请求数、Token 用量和花费。", "Monitor status, request counts, Token usage, and spend across the main conversation and all subagents.") },
  { shot: "model-config", icon: "brain", tab: t("模型", "Models"), title: t("模型配置", "Model Configuration"), text: t("Anthropic、OpenAI、OpenRouter、本地 LM Studio 在同一页管理，并为不同角色指定模型和思考强度。", "Manage Anthropic, OpenAI, OpenRouter, and local LM Studio on one page, assigning models and thinking effort per role.") },
  { shot: "capabilities", icon: "boxes", tab: t("能力", "Capabilities"), title: t("能力中心", "Capabilities Center"), text: t("Skills、Plugins、MCP 和 Slash Commands 在同一页开关和探测。", "Toggle and inspect Skills, Plugins, MCP servers, and Slash Commands in one place.") },
  { shot: "settings", icon: "settings", tab: t("设置", "Settings"), title: t("设置与更新", "Settings & Updates"), text: t("设置可搜索，配置按全局、项目、会话分层。应用内更新会验证签名。", "Searchable settings scoped across global, project, and session levels. In-app updates verify cryptographic signatures.") },
];

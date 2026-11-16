// OMP Studio product kit: builds the app's surfaces as real DOM.
// The demo story (project omp-web, the pi-web sync, the TS2322 error) is the
// same one the app's own preview mode tells. Styles live in ui.css.
import { i, type IconName } from "./icons";

export type Theme = "light" | "dark";

export type Kind =
  | "chat" | "plan" | "git" | "terminal" | "browser"
  | "agents" | "context" | "files" | "logs" | "changes";

export interface KindInfo {
  title: string;
  /** Second line of the title bar. */
  sub: string;
  icon: IconName;
  /** Ring colour of the tool's icon in the app. */
  tint: string;
  /** One sentence, written for someone who has never seen the app. */
  blurb: string;
}

export const KINDS: Record<Kind, KindInfo> = {
  chat: { title: "跟踪上游 pi-web 更新", sub: "omp-web", icon: "messageSquare", tint: "#6e56cf", blurb: "对话本身就是一个窗口，带着自己的输入框和工具区。" },
  plan: { title: "Mermaid 全屏缩放", sub: "等待审批", icon: "messageSquare", tint: "#b7791f", blurb: "Agent 先交计划，你批准后才动手。" },
  git: { title: "Git", sub: "fix/mermaid-theme", icon: "gitBranch", tint: "#e8590c", blurb: "暂存、diff、提交、Fetch / Pull / Push、提交图和 Worktree。" },
  terminal: { title: "Terminal", sub: "pwsh", icon: "terminal", tint: "#137a52", blurb: "本机 Shell，移动窗口不会丢掉会话。" },
  browser: { title: "Browser", sub: "localhost:5173", icon: "globe", tint: "#1f6ba3", blurb: "原生网页，多标签，你和 Agent 可以交接控制权。" },
  agents: { title: "Agents", sub: "4 个运行中", icon: "bot", tint: "#d6336c", blurb: "主对话和每个子 Agent 的状态、用量和花费。" },
  context: { title: "Context", sub: "22% 已用", icon: "layers", tint: "#0d9488", blurb: "上下文窗口被什么占用，一眼看清。" },
  files: { title: "Files", sub: "omp-web", icon: "folderOpen", tint: "#b7791f", blurb: "工作区文件树，点开就在窗口里查看和编辑。" },
  logs: { title: "OMP Logs", sub: "Runtime", icon: "scrollText", tint: "#5c636e", blurb: "Runtime 与 Bridge 的实时日志。" },
  changes: { title: "Changes", sub: "第 5 轮", icon: "fileDiff", tint: "#16a34a", blurb: "按回合列出 Agent 改了哪些文件。" },
};

const chip = (text: string, tone = "") => `<span class="os-chip"${tone ? ` data-tone="${tone}"` : ""}>${text}</span>`;

const composer = () => `<div class="os-composer">
<div class="os-composer-input">输入消息…</div>
<div class="os-composer-row">${i("paperclip")}${i("atSign")}${i("slash")}
<span class="os-perm">${i("shield")}Full Access</span>${i("plus", "os-hide-s")}
<span class="os-grow"></span><span class="os-model">Claude Fable 5.2</span><span class="os-model os-hide-s">Max</span>
${i("mic", "os-hide-s")}<span class="os-send">${i("arrowUp")}</span></div></div>`;

const SURFACES: Record<Kind, () => string> = {
  chat: () => `<div class="os-chat"><div class="os-msgs">
<div class="os-user">先看看上游这次改了什么</div>
<p class="os-say">上游 pi-web <code>v0.8.1</code> 调整了 Mermaid 渲染入口和缩放事件，共 14 个提交，其中 3 个会影响 omp-web。</p>
<div class="os-user">跟踪上游 pi-web 的更新，同步到 omp-web</div>
<p class="os-say">好的。先核对上游 <code>v0.8.1</code> 的变更，再同步依赖并跑一遍检查。</p>
<ul class="os-todo"><li data-done>核对本地路径</li><li data-done>复查类型错误</li><li>确认缩放交互</li></ul>
<div class="os-tool"><div class="os-tool-h"><span class="os-spin"></span><b>Bash</b><span class="mono">npm run typecheck</span></div>
<pre>$ npm run typecheck
&gt; tsc --noEmit

<span class="os-err">src/index.ts(12,5): error TS2322: Type 'string' is not assignable</span></pre></div>
<div class="os-pill">${i("chevronRight")}<b>2 个文件已更改</b><span class="os-add">+87</span><span class="os-grow"></span><span>审核</span><span>标注</span></div>
<div class="os-working">${i("sparkles")}working<span class="os-dim">54s</span>正在运行 <span class="mono">npm run check</span></div>
</div>${composer()}</div>`,

  plan: () => `<div class="os-plan">
<div class="os-plan-h">${i("shield")}Plan Review<span>Agent · 14:09</span></div>
<div class="os-plan-b"><h4>Preview 缩放惯性</h4>
<h4>目标</h4><p>冻结 Preview 缩放协议，补上拖拽惯性开关，再用类型检查确认 Mermaid 全屏路径。</p>
<h4>实施步骤</h4><ol><li>核对现有 Preview 面板的 pan / zoom 事件，列出惯性开关要接的状态。</li><li>默认关闭惯性；打开后松手继续滑行。</li><li>跑 <code>npm run check</code>，按报错收尾。</li></ol></div>
<div class="os-plan-f"><button class="os-btn" data-primary type="button" tabindex="-1">Approve and execute</button><button class="os-btn" type="button" tabindex="-1">Approve and keep context</button><button class="os-btn" type="button" tabindex="-1">Refine plan</button></div></div>`,

  git: () => `<div class="os-git">
<div class="os-seg"><span data-on>更改</span><span>历史</span><span>Issues</span><span>PR</span></div>
<div class="os-row">${i("gitBranch")}<span class="os-grow"><b>fix/mermaid-theme</b></span>${chip("↑2")}${chip("↓0")}</div>
<div class="os-commit"><div class="os-field">Commit message</div><button class="os-btn" data-primary type="button" tabindex="-1">Commit</button></div>
<div class="os-rule"></div>
<div class="os-row"><span class="os-stat" data-s="M">M</span><span class="os-grow mono">components/MermaidBlock.tsx</span><span class="os-add">+6</span><span class="os-del">−3</span></div>
<div class="os-row"><span class="os-stat" data-s="A">A</span><span class="os-grow mono">components/DirectoryPicker.tsx</span><span class="os-add">+81</span></div>
<div class="os-row"><span class="os-stat" data-s="D">D</span><span class="os-grow mono">lib/legacyZoom.ts</span><span class="os-del">−42</span></div>
<div class="os-diff"><div data-n="241"> const renderMermaid = useCallback(async (theme) =&gt; {</div><div data-n="242">   const mermaid = await import("mermaid");</div><div data-n="243" data-k="-">-  const codeTheme = getCodeTheme() as string;</div><div data-n="243" data-k="+">+  const codeTheme = resolveTheme(theme);</div><div data-n="244" data-k="+">+  mermaid.initialize({ theme: codeTheme });</div><div data-n="245">   return mermaid.render(id, source);</div></div></div>`,

  terminal: () => `<div class="os-term"><span class="os-dim">PS D:\\Project\\omp-web&gt;</span> <b>npm run check</b>
<span class="os-ok">✓</span> arch constraints   213 rules
<span class="os-ok">✓</span> renderer selects
<span class="os-ok">✓</span> tsc --noEmit       0 errors
<span class="os-ok">✓</span> core tests         214 / 214
  packages/studio-protocol   48 passed
  packages/client-contract   61 passed
<span class="os-dim">PS D:\\Project\\omp-web&gt;</span> <span class="os-caret"></span></div>`,

  browser: () => `<div class="os-web">
<div class="os-urlbar">${i("arrowLeft")}${i("arrowRight")}${i("refresh")}<div class="os-url">${i("globe")}localhost:5173/components</div>
<div class="os-handoff"><span data-on>${i("bot")}Agent</span><span>我</span></div></div>
<div class="os-page"><nav><span>Overview</span><span data-on>Button</span><span>Input</span><span>Select</span><span>Toast</span></nav>
<main><h4>Button</h4><p>Buttons trigger an action or event. Use one primary button per view.</p>
<div class="os-demo"><button class="os-btn" data-primary type="button" tabindex="-1">Preview button</button><button class="os-btn" type="button" tabindex="-1">Cancel</button><div class="os-field">omp-studio</div></div></main></div></div>`,

  agents: () => `<div class="os-agents">
<div class="os-agent"><span class="os-avatar">${i("bot")}</span><b>主对话</b>${chip("运行中", "green")}<small>正在运行 npm run check · 3.5M tokens</small></div>
<div class="os-agent"><span class="os-avatar">${i("bot")}</span><b>deps 子 Agent</b>${chip("运行中", "green")}<small>grep "pi-web" package.json · 412k tokens</small></div>
<div class="os-agent"><span class="os-avatar">${i("bot")}</span><b>preview 子 Agent</b>${chip("待审批", "amber")}<small>等待批准 Preview 缩放计划 · 96k tokens</small></div>
<div class="os-agent"><span class="os-avatar">${i("bot")}</span><b>lint 子 Agent</b>${chip("已完成")}<small>修复 3 处 lint · 58k tokens</small></div></div>`,

  context: () => `<div class="os-ctx">
<div class="os-ring"><svg viewBox="0 0 92 92"><circle cx="46" cy="46" r="38" stroke="var(--o-surface-3)"/><circle cx="46" cy="46" r="38" stroke="var(--o-accent)" stroke-linecap="round" stroke-dasharray="52.500 238.800"/></svg><strong>22<small>%</small></strong></div>
<div class="os-bars">
<div class="os-bar"><span>系统提示</span><i style="--v:34%"></i><span>12.4k</span></div>
<div class="os-bar"><span>工具定义</span><i style="--v:52%;--c:var(--o-blue)"></i><span>18.9k</span></div>
<div class="os-bar"><span>对话</span><i style="--v:22%;--c:var(--o-green)"></i><span>8.1k</span></div>
<div class="os-bar"><span>文件</span><i style="--v:12%;--c:var(--o-amber)"></i><span>4.2k</span></div></div></div>`,

  files: () => `<div class="os-tree">
<div>${i("chevronDown")}${i("folderOpen")}app</div>
<div style="--d:1" data-s="M">${i("code")}App.tsx<span class="os-stat" data-s="M">M</span></div>
<div style="--d:1">${i("code")}main.tsx</div>
<div>${i("chevronDown")}${i("folderOpen")}components</div>
<div style="--d:1" data-s="A">${i("code")}DirectoryPicker.tsx<span class="os-stat" data-s="A">A</span></div>
<div style="--d:1" data-s="M">${i("code")}MermaidBlock.tsx<span class="os-stat" data-s="M">M</span></div>
<div style="--d:1">${i("code")}ChatTimeline.tsx</div>
<div style="--d:1">${i("code")}CodeBlock.tsx</div>
<div>${i("chevronRight")}${i("folder")}docs</div>
<div>${i("chevronRight")}${i("folder")}lib</div></div>`,

  logs: () => `<div class="os-logs">
<div><time>14:09:21</time><em data-l="OK">OK</em><span>bridge handshake · epoch 7</span></div>
<div><time>14:09:21</time><em data-l="INFO">INFO</em><span>runtime 18.18.0 studio-host ready</span></div>
<div><time>14:09:24</time><em data-l="INFO">INFO</em><span>session attach omp-web</span></div>
<div><time>14:09:31</time><em data-l="INFO">INFO</em><span>tool_call bash npm run typecheck</span></div>
<div><time>14:09:38</time><em data-l="WARN">WARN</em><span>tsc exited 2 · 1 diagnostic</span></div>
<div><time>14:09:40</time><em data-l="INFO">INFO</em><span>agent spawn deps (worker)</span></div>
<div><time>14:09:52</time><em data-l="OK">OK</em><span>checkpoint turn 5 saved</span></div></div>`,

  changes: () => `<div class="os-tree">
<p class="os-turn">第 5 轮 · 3 个文件 <span class="os-add">+223</span> <span class="os-del">−4</span></p>
<div data-s="M">${i("code")}components/MermaidBlock.tsx<span class="os-stat" data-s="M">M</span></div>
<div data-s="A">${i("code")}components/DirectoryPicker.tsx<span class="os-stat" data-s="A">A</span></div>
<div data-s="M">${i("code")}app/App.tsx<span class="os-stat" data-s="M">M</span></div>
<p class="os-turn">第 4 轮 · 2 个文件 <span class="os-add">+87</span></p>
<div data-s="M">${i("code")}package.json<span class="os-stat" data-s="M">M</span></div>
<div data-s="M">${i("code")}lib/zoom.ts<span class="os-stat" data-s="M">M</span></div></div>`,
};

/** Inner HTML of one surface, without window chrome. */
export const surface = (kind: Kind) => SURFACES[kind]();

export interface WindowOptions {
  kind: Kind;
  title?: string;
  sub?: string;
  /** Title-bar buttons to render, in order. Defaults to all four. */
  buttons?: ("pin" | "min" | "max" | "close")[];
  focused?: boolean;
}

const BUTTONS = {
  pin: ["pin", "固定窗口"],
  min: ["minus", "最小化"],
  max: ["maximize", "最大化，悬停可选布局"],
  close: ["x", "关闭"],
} as const;

/** A product window: title bar plus surface. The caller positions and sizes it. */
export function ompWindow(options: WindowOptions): HTMLElement {
  const info = KINDS[options.kind];
  const el = document.createElement("article");
  el.className = "ow";
  el.dataset.kind = options.kind;
  el.style.setProperty("--tint", info.tint);
  if (options.focused) el.dataset.focused = "";
  const buttons = (options.buttons ?? ["pin", "min", "max", "close"])
    .map((b) => `<button class="ow-btn" type="button" data-act="${b}" aria-label="${BUTTONS[b][1]}">${i(BUTTONS[b][0])}</button>`)
    .join("");
  el.innerHTML = `<header class="ow-bar"><span class="ow-ico">${i(info.icon)}</span><span class="ow-title">${options.title ?? info.title}</span><span class="ow-sub">${options.sub ?? info.sub}</span><span class="ow-grow"></span>${buttons}</header><div class="ow-body">${surface(options.kind)}</div>`;
  return el;
}

// ---------------- Screenshots of the app's full pages ----------------
const shotUrls = import.meta.glob<string>("./shots/*.webp", { eager: true, query: "?url", import: "default" });

export type Shot = "home" | "history" | "agent-hub" | "model-config" | "capabilities" | "settings" | "workbench" | "snap-picker";

/** URL of a real screenshot (recorded in preview mode with demo data). */
export const shot = (name: Shot, theme: Theme = "light") => shotUrls[`./shots/${name}-${theme}.webp`]!;

// ---------------- Copy shared by all three concepts ----------------
// Facts only; each concept writes its own headlines around them.

/** The six layout templates of the snap picker, as [x, y, w, h] fractions. */
export const LAYOUTS: { name: string; cells: [number, number, number, number][] }[] = [
  { name: "左右各半", cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  { name: "左右 2:1", cells: [[0, 0, 2 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { name: "三列", cells: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { name: "左侧上下与右半", cells: [[0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0, 0.5, 1]] },
  { name: "左半与右侧上下", cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  { name: "四宫格", cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
];

export const PIN_MODES = ["不固定", "固定在工作区", "固定在应用", "独立窗口", "独立窗口并置顶"];

export const DOCK_ZONES = ["左侧栏", "对话工具区", "右侧栏", "底栏", "浮窗"];

export interface PageFeature {
  shot: Shot;
  icon: IconName;
  title: string;
  text: string;
}

/** Full pages of the app, each with a real screenshot. */
export const PAGES: PageFeature[] = [
  { shot: "home", icon: "house", title: "首页与用量", text: "最近项目一键回到工作台。Token 折线图和热力图按年、月、周、日切换。" },
  { shot: "history", icon: "history", title: "会话历史与 Time Travel", text: "按回合保存工作区快照。可以只恢复代码、只恢复对话，或两者都恢复，恢复前会留备份。" },
  { shot: "agent-hub", icon: "bot", title: "Agent Hub", text: "集中查看主对话和全部子 Agent 的状态、请求数、Token 用量和花费。" },
  { shot: "model-config", icon: "brain", title: "模型配置", text: "Anthropic、OpenAI、OpenRouter、本地 LM Studio 在同一页管理，并为不同角色指定模型和思考强度。" },
  { shot: "capabilities", icon: "boxes", title: "能力中心", text: "Skills、Plugins、MCP 和 Slash Commands 在同一页开关和探测。" },
  { shot: "settings", icon: "settings", title: "设置与更新", text: "设置可搜索，配置按全局、项目、会话分层。应用内更新会验证签名。" },
];

export interface Extra {
  icon: IconName;
  title: string;
  text: string;
}

/** Capabilities without a page of their own. */
export const EXTRAS: Extra[] = [
  { icon: "globe", title: "聊天浏览器", text: "原生网页与多标签，人工和 Agent 交接控制，元素截图引用，持久登录空间。" },
  { icon: "monitor", title: "电脑操作", text: "动作与截图联动，历史画面可回看，按会话停止和显式继续。" },
  { icon: "file", title: "文件查看器", text: "文本、Markdown、PDF、图片、音视频、Excel 和 CSV 都在窗口里打开。" },
  { icon: "server", title: "SSH 工作区", text: "在本机或远端工作，支持系统密钥和账号密码。" },
  { icon: "messageCircle", title: "BTW 旁路追问", text: "不打断主线程地追问一句，支持图片和分支。" },
  { icon: "mic", title: "语音输入", text: "点击或按住空格听写，内容插入到光标位置。" },
  { icon: "ruler", title: "评测工作区", text: "原生基准与指令遵循评测，后台执行，历史对比。" },
  { icon: "keyboard", title: "键盘可达", text: "F6 在区域间切换焦点，方向键微调分界线，Esc 取消拖动。" },
];

export const FACTS = [
  { n: "5", label: "种停靠位置" },
  { n: "6", label: "种分屏模板" },
  { n: "8", label: "向窗口缩放" },
  { n: "3", label: "个桌面安装包" },
];

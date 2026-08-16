/**
 * Preview-mode fixtures, ported from ui_reference/ver1/assets/js/mock-data.js.
 * Renderer display only — never sent through Host / Studio Bridge.
 */

export type PreviewThread = {
  id: string;
  title: string;
  time: string;
  msgs: number;
  status: "running" | "idle" | "approval" | "archived";
  pinned?: boolean;
  hasSub?: boolean;
  unread?: number;
};

export type PreviewProject = {
  id: string;
  name: string;
  path: string;
  branch: string;
  worktree: string | null;
  dirty: number;
  running: boolean;
  attention: boolean;
  preview: "running" | "stopped" | "building";
  pinned?: boolean;
  threads: PreviewThread[];
};

export type PreviewFileNode = {
  type: "dir" | "file";
  name: string;
  open?: boolean;
  status?: "M" | "A" | "D" | "?";
  turn?: boolean;
  reading?: boolean;
  writing?: boolean;
  diagnostic?: "error" | "warn";
  dirty?: boolean;
  children?: PreviewFileNode[];
};

export type PreviewTelemetry = {
  model: string;
  thinking: string;
  permission: string;
  fastMode: boolean;
  serviceTier: string;
  compact: string;
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  ctxUsed: string;
  ctxTotal: string;
  ctxPct: number;
  turnTime: string;
  sessionTime: string;
  cost: string;
  retries: number;
  subagentCost: string;
  totalBurn: string;
  turnBurn: string;
  turnIn: string;
  turnOut: string;
  cacheSaved: string;
  usedExact: string;
  totalExact: string;
  inPct: number;
  outPct: number;
  cachePct: number;
};

export type PreviewCtxPart = { name: string; v: string; pct: number; color: string };

export type PreviewMinimap = { type: string; evId: string; at: number };

export type PreviewChangeRow = {
  file: string;
  status: "M" | "A" | "D" | "?";
  add: number;
  del: number;
  agent?: string | null;
  note?: string;
};

export type PreviewDiffLine = readonly [string, string, string, string];

export type PreviewProblem = {
  sev: "error" | "warn" | "info";
  src: string;
  msg: string;
  file: string | null;
  line: number | null;
};

export type PreviewTest = {
  suite: string;
  total: number;
  pass: number;
  fail: number;
  time: string;
  status: "pass" | "fail";
  failDetail?: string;
};

export type PreviewHistoryStatus = "running" | "completed" | "failed" | "archived";

export type PreviewHistoryRow = {
  id: string;
  title: string;
  project: string;
  branch: string;
  time: string;
  model: string;
  status: PreviewHistoryStatus;
  files: number;
  cost: string;
  forkedFrom: string | null;
  checkpoints: number;
  pinned: boolean;
};

export type PreviewTtKind = "user" | "plan" | "tool" | "file" | "test" | "checkpoint";

export type PreviewTtNode = {
  kind: PreviewTtKind;
  title: string;
  detail: string;
  time: string;
  restorable?: boolean;
};

export type PreviewActivity = { icon: string; color: string; text: string; time: string };

export type PreviewSideAgent = {
  id: string;
  hubId: string;
  name: string;
  role: string;
  parent: string | null;
  task: string;
  status: "running" | "waiting" | "failed" | "done";
  statusText: string;
  lastTool: string;
  time: string;
  tokens: string;
  cost: string;
  files: number;
  waiting: boolean;
  error: boolean;
};

export const PREVIEW_PROJECTS: PreviewProject[] = [
  {
    id: "p1", name: "omp-web", path: "C:\\Aspace\\Tools\\omp-web",
    branch: "main", worktree: null, dirty: 3, running: true,
    attention: true, preview: "running", pinned: true,
    threads: [
      { id: "t0", title: "新建对话（空白）", time: "now", msgs: 0, status: "idle" },
      { id: "t1", title: "跟踪上游 pi-web 更新到 omp-web", time: "32m ago", msgs: 45, status: "running", pinned: true, hasSub: true, unread: 3 },
      { id: "t2", title: "Audit and fix OSS repository issues", time: "2h ago", msgs: 12, status: "idle", unread: 0 },
      { id: "t3", title: "选择 gemini3.6flash 随意发送消息后报错…", time: "4d ago", msgs: 1337, status: "approval", hasSub: true, unread: 1 },
      { id: "t4", title: "修复 Git Bash 路径未找到问题", time: "4d ago", msgs: 8, status: "idle" },
      { id: "t5", title: "重构 session 存储层 (session)", time: "6d ago", msgs: 156, status: "archived" },
    ],
  },
  {
    id: "p2", name: "pi-web (upstream)", path: "C:\\Aspace\\Tools\\pi-web",
    branch: "v0.8.1", worktree: null, dirty: 0, running: false,
    attention: false, preview: "stopped",
    threads: [
      { id: "t6", title: "对比 v0.8.0 → v0.8.1 变更清单", time: "1d ago", msgs: 22, status: "idle" },
    ],
  },
  {
    id: "p3", name: "omp-web (feat/mermaid)", path: "C:\\Aspace\\Tools\\omp-web\\.worktrees\\mermaid",
    branch: "feat/mermaid-zoom", worktree: "mermaid", dirty: 7, running: true,
    attention: false, preview: "building",
    threads: [
      { id: "t7", title: "Mermaid 渲染优化与全屏缩放拖拽", time: "18m ago", msgs: 63, status: "running", hasSub: true, unread: 2 },
      { id: "t8", title: "DirectoryPicker IDE 风格目录选择器", time: "3d ago", msgs: 41, status: "idle" },
    ],
  },
];

export const PREVIEW_FILE_TREE: PreviewFileNode[] = [
  { type: "dir", name: ".claude", children: [{ type: "file", name: "settings.local.json" }] },
  { type: "dir", name: ".code-review-graph", children: [] },
  { type: "dir", name: ".github", children: [
    { type: "file", name: "FUNDING.yml" },
    { type: "dir", name: "workflows", children: [{ type: "file", name: "ci.yml" }] },
  ] },
  { type: "dir", name: "app", open: true, children: [
    { type: "file", name: "App.tsx", status: "M", turn: true },
    { type: "file", name: "main.tsx" },
    { type: "dir", name: "routes", children: [
      { type: "file", name: "session.tsx", status: "M", reading: true },
      { type: "file", name: "home.tsx" },
    ] },
  ] },
  { type: "dir", name: "bin", children: [{ type: "file", name: "omp-web.js" }] },
  { type: "dir", name: "components", open: true, children: [
    { type: "file", name: "DirectoryPicker.tsx", status: "A", writing: true },
    { type: "file", name: "MermaidBlock.tsx", status: "M", turn: true, diagnostic: "error" },
    { type: "file", name: "ChatTimeline.tsx" },
    { type: "file", name: "CodeBlock.tsx", status: "M" },
    { type: "file", name: "TelemetryBar.tsx", dirty: true },
  ] },
  { type: "dir", name: "docs", children: [
    { type: "file", name: "UPSTREAM-SYNC.md", status: "A" },
    { type: "file", name: "README.md", status: "M", turn: true },
  ] },
  { type: "dir", name: "hooks", children: [
    { type: "file", name: "useCodeTheme.ts", status: "M" },
    { type: "file", name: "useSession.ts" },
  ] },
  { type: "dir", name: "lib", children: [
    { type: "file", name: "rpc.ts", diagnostic: "warn" },
    { type: "file", name: "graft.ts" },
  ] },
  { type: "file", name: ".gitignore" },
  { type: "file", name: "AGENTS.md" },
  { type: "file", name: "package.json", status: "M", turn: true },
  { type: "file", name: "config.yml", status: "?" },
];

export const PREVIEW_TELEMETRY: PreviewTelemetry = {
  model: "gemini-3.6-flash (default)",
  thinking: "high",
  permission: "default",
  fastMode: false,
  serviceTier: "default",
  compact: "auto",
  inputTokens: "3.5M",
  outputTokens: "73k",
  cacheTokens: "36.6M",
  ctxUsed: "225k",
  ctxTotal: "1.0M",
  ctxPct: 22,
  turnTime: "1m 42s",
  sessionTime: "1h 18m",
  cost: "¥ 4.62",
  retries: 1,
  subagentCost: "¥ 0.87",
  totalBurn: "220.4k",
  turnBurn: "48.9k",
  turnIn: "42.1k",
  turnOut: "6.8k",
  cacheSaved: "78%",
  usedExact: "220,400",
  totalExact: "1,000,000",
  inPct: 72,
  outPct: 12,
  cachePct: 16,
};

export const PREVIEW_CTX_PARTS: PreviewCtxPart[] = [
  { name: "系统提示词", v: "13k", pct: 5.9, color: "#8a919c" },
  { name: "系统上下文", v: "42k", pct: 19.1, color: "#64748b" },
  { name: "工具定义", v: "18k", pct: 8.2, color: "#64748b" },
  { name: "Skills", v: "24k", pct: 10.9, color: "#6e56cf" },
  { name: "对话消息", v: "123.4k", pct: 56.0, color: "#3b9bd4" },
];

export const PREVIEW_MINIMAP: PreviewMinimap[] = [
  { type: "user", evId: "e1", at: 2 },
  { type: "plan", evId: "e3", at: 9 },
  { type: "assistant", evId: "e5", at: 20 },
  { type: "file", evId: "e6", at: 30 },
  { type: "approval", evId: "e8", at: 40 },
  { type: "bash", evId: "e9", at: 48 },
  { type: "error", evId: "e10", at: 55 },
  { type: "ask", evId: "e11", at: 61 },
  { type: "checkpoint", evId: "e12", at: 67 },
  { type: "user", evId: "e13", at: 73 },
  { type: "assistant", evId: "e15", at: 83 },
  { type: "compact", evId: "e16", at: 93 },
];

export const PREVIEW_CHANGES = {
  turn: [
    { file: "components/MermaidBlock.tsx", status: "M" as const, add: 6, del: 3, agent: "主 Agent" },
    { file: "docs/UPSTREAM-SYNC.md", status: "A" as const, add: 214, del: 0, agent: "主 Agent" },
  ],
  thread: [
    { file: "README.md", status: "M" as const, add: 3, del: 1, agent: "主 Agent" },
    { file: "package.json", status: "M" as const, add: 4, del: 4, agent: "deps 子 Agent" },
    { file: "app/App.tsx", status: "M" as const, add: 18, del: 9, agent: "主 Agent" },
    { file: "hooks/useCodeTheme.ts", status: "M" as const, add: 11, del: 6, agent: "主 Agent" },
  ],
  preexisting: [
    { file: "components/TelemetryBar.tsx", status: "M" as const, add: 42, del: 11, agent: null, note: "Agent 开始前已存在" },
    { file: "config.yml", status: "?" as const, add: 0, del: 0, agent: null, note: "未跟踪" },
  ],
};

export const PREVIEW_DIFF = {
  file: "components/MermaidBlock.tsx",
  add: 6,
  del: 3,
  lines: [
    [" ", "142", "142", "  const renderMermaid = useCallback(async (theme: MermaidTheme) => {"],
    [" ", "143", "143", "    const mermaid = await import(\"mermaid\");"],
    ["-", "144", "", "    const codeTheme = getCodeTheme() as string;"],
    ["+", "", "144", "    const codeTheme = getCodeTheme() as const;"],
    [" ", "145", "145", "    mermaid.initialize({"],
    ["-", "146", "", "      theme: codeTheme,"],
    ["+", "", "146", "      theme: codeTheme satisfies MermaidTheme,"],
    [" ", "147", "147", "      securityLevel: \"strict\","],
    ["+", "", "148", "      themeVariables: buildThemeVars(codeTheme),"],
    [" ", "148", "149", "    });"],
    [" ", "149", "150", "  }, []);"],
    ["collapse", "52 行未变化", "", ""],
    [" ", "201", "203", "  const onWheel = usePinchZoom(containerRef);"],
    ["-", "202", "", "  // legacy drag handler"],
    ["+", "", "204", "  const onDrag = usePanDrag(containerRef, { clamp: true });"],
    [" ", "203", "205", "  return <div ref={containerRef} className=\"mermaid-wrap\" />;"],
  ] as PreviewDiffLine[],
};

export const PREVIEW_PREVIEW = {
  url: "127.0.0.1:30141",
  path: "/?session=019fac94-5e18-7000",
  status: "ok" as const,
  logs: [
    "[vite] connected.",
    "[vite] hmr update /components/MermaidBlock.tsx",
    "[vite] page reload src/App.tsx",
    "[omp] preview attached, session=019fac94",
  ],
};

export const PREVIEW_PROBLEMS: PreviewProblem[] = [
  { sev: "error", src: "TypeScript", msg: "TS2322: Type 'string' is not assignable to type 'MermaidTheme'", file: "components/MermaidBlock.tsx", line: 147 },
  { sev: "error", src: "Preview", msg: "Failed to resolve import \"@earendil-works/pi-mermaid\"", file: "components/MermaidBlock.tsx", line: 12 },
  { sev: "warn", src: "ESLint", msg: "'onDrag' is defined but never used", file: "components/MermaidBlock.tsx", line: 204 },
  { sev: "warn", src: "ESLint", msg: "React Hook useCallback has a missing dependency", file: "hooks/useCodeTheme.ts", line: 31 },
  { sev: "info", src: "OMP 诊断", msg: "RPC capability \"preview.dom\" 协商成功 (v2)", file: null, line: null },
  { sev: "warn", src: "Git", msg: "config.yml 未被跟踪，可能被意外提交", file: "config.yml", line: null },
];

export const PREVIEW_TESTS: PreviewTest[] = [
  { suite: "lib/graft.test.ts", total: 12, pass: 12, fail: 0, time: "0.42s", status: "pass" },
  { suite: "lib/rpc.test.ts", total: 27, pass: 26, fail: 1, time: "1.18s", status: "fail", failDetail: "rpc › should negotiate capability v2\n  Expected: \"preview.dom\"\n  Received: undefined" },
  { suite: "components/DirectoryPicker.test.tsx", total: 8, pass: 8, fail: 0, time: "0.67s", status: "pass" },
];

export const PREVIEW_PV_LOGS = [
  { tone: "ok", text: "[vite] connected. (ws://127.0.0.1:30141)" },
  { tone: "", text: "[vite] hmr update /components/MermaidBlock.tsx" },
  { tone: "", text: "[vite] hmr update /docs/UPSTREAM-SYNC.md" },
  { tone: "warn", text: "[preview] console.warn · React Hook useCallback has a missing dependency (useCodeTheme.ts:31)" },
  { tone: "err", text: "[preview] console.error · Failed to resolve import \"@earendil-works/pi-mermaid\" (MermaidBlock.tsx:12)" },
  { tone: "", text: "[omp] preview attached, session=019fac94 · dom snapshot ok" },
  { tone: "muted", text: "[network] GET /api/session → 200 (18ms)" },
  { tone: "muted", text: "[network] GET /api/threads → 200 (9ms)" },
];

export const PREVIEW_HISTORY: PreviewHistoryRow[] = [
  { id: "ph1", title: "跟踪上游 pi-web 更新到 omp-web", project: "omp-web", branch: "main", time: "32m ago", model: "gemini-3.6-flash", status: "running", files: 4, cost: "¥ 4.62", forkedFrom: null, checkpoints: 12, pinned: true },
  { id: "ph2", title: "Mermaid 渲染优化与全屏缩放拖拽", project: "omp-web (feat/mermaid)", branch: "feat/mermaid-zoom", time: "18m ago", model: "gemini-3.6-flash", status: "running", files: 7, cost: "¥ 2.31", forkedFrom: "跟踪上游 pi-web 更新…", checkpoints: 5, pinned: false },
  { id: "ph3", title: "Audit and fix OSS repository issues", project: "omp-web", branch: "main", time: "2h ago", model: "claude-sonnet-4.5", status: "completed", files: 9, cost: "¥ 8.14", forkedFrom: null, checkpoints: 3, pinned: false },
  { id: "ph4", title: "选择 gemini3.6flash 随意发送消息后报错…", project: "omp-web", branch: "main", time: "4d ago", model: "gemini-3.6-flash", status: "failed", files: 0, cost: "¥ 0.42", forkedFrom: null, checkpoints: 0, pinned: false },
  { id: "ph5", title: "修复 Git Bash 路径未找到问题", project: "omp-web", branch: "main", time: "4d ago", model: "gpt-5.2-codex", status: "completed", files: 2, cost: "¥ 1.08", forkedFrom: null, checkpoints: 2, pinned: false },
  { id: "ph6", title: "重构 session 存储层 (session)", project: "omp-web", branch: "refactor/session-db", time: "6d ago", model: "claude-sonnet-4.5", status: "archived", files: 21, cost: "¥ 22.90", forkedFrom: null, checkpoints: 9, pinned: false },
];

export const PREVIEW_TIME_TRAVEL: PreviewTtNode[] = [
  { kind: "user", title: "用户请求", detail: "整理上游同步过程为文档，并验证类型检查", time: "14:02" },
  { kind: "plan", title: "OMP 计划", detail: "4 步：阅读 docs → 整理三阶段 → 新建文档 → 运行验证", time: "14:03" },
  { kind: "tool", title: "工具执行", detail: "Read ×3 · Grep ×1 · Write UPSTREAM-SYNC.md · Edit README.md", time: "14:04" },
  { kind: "file", title: "文件变化", detail: "+2 文件（docs/UPSTREAM-SYNC.md +214 · README.md +3/-1）", time: "14:04" },
  { kind: "test", title: "测试 / 检查", detail: "npm run typecheck → 1 个错误（TS2322）", time: "14:05" },
  { kind: "checkpoint", title: "Checkpoint #12", detail: "3 文件 · +218/-4 · 构建通过 · Preview 已刷新", time: "14:06", restorable: true },
  { kind: "user", title: "后续请求", detail: "修复类型错误并验证 Mermaid 缩放", time: "14:07" },
  { kind: "tool", title: "工具执行", detail: "Edit MermaidBlock.tsx · typecheck 通过 · Preview 刷新", time: "14:08" },
  { kind: "checkpoint", title: "Checkpoint #13", detail: "4 文件 · +221/-5 · 0 错误", time: "14:09", restorable: true },
];

export const PREVIEW_ACTIVITY: PreviewActivity[] = [
  { icon: "bot", color: "blue", text: "omp-web · 主 Agent 正在执行 npm run typecheck", time: "刚刚" },
  { icon: "diff", color: "purple", text: "omp-web · docs/UPSTREAM-SYNC.md 已写入（+214）", time: "4m ago" },
  { icon: "globe", color: "green", text: "omp-web · Preview 热更新完成（127.0.0.1:30141）", time: "6m ago" },
  { icon: "alert", color: "amber", text: "omp-web (feat/mermaid) · preview 子 Agent 等待用户确认", time: "12m ago" },
  { icon: "check", color: "green", text: "pi-web · 「对比 v0.8.0 → v0.8.1 变更清单」已完成", time: "1d ago" },
];

export const PREVIEW_SIDE_AGENTS: PreviewSideAgent[] = [
  { id: "a1", hubId: "agent-019fac94", name: "主 Agent", role: "Coordinator", parent: null, task: "整理上游同步文档并验证类型检查", status: "running", statusText: "Running Tool · Bash", lastTool: "Bash · npm run typecheck", time: "6m 12s", tokens: "48.2k", cost: "¥ 1.94", files: 4, waiting: false, error: false },
  { id: "a2", hubId: "agent-019fcb01", name: "deps 子 Agent", role: "Dependency Auditor", parent: "主 Agent", task: "审计 @earendil-works/pi-* 0.82.1 变更", status: "running", statusText: "Thinking", lastTool: "Grep · \"pi-core\" in lockfile", time: "2m 47s", tokens: "12.6k", cost: "¥ 0.51", files: 1, waiting: false, error: false },
  { id: "a3", hubId: "agent-019fcb17", name: "preview 子 Agent", role: "Preview Verifier", parent: "主 Agent", task: "验证 Mermaid 全屏缩放拖拽", status: "waiting", statusText: "Waiting for User", lastTool: "AskUser · 缩放交互确认", time: "1m 03s", tokens: "5.1k", cost: "¥ 0.22", files: 0, waiting: true, error: false },
  { id: "a4", hubId: "agent-019fcb55", name: "lint 子 Agent", role: "Lint Runner", parent: "主 Agent", task: "ESLint 全量扫描", status: "failed", statusText: "Failed", lastTool: "Bash · eslint . (exit 2)", time: "38s", tokens: "3.3k", cost: "¥ 0.14", files: 0, waiting: false, error: true },
];

export function findPreviewProject(id: string): PreviewProject | undefined {
  return PREVIEW_PROJECTS.find((project) => project.id === id);
}

export function findPreviewThread(id: string): { project: PreviewProject; thread: PreviewThread } | undefined {
  for (const project of PREVIEW_PROJECTS) {
    const thread = project.threads.find((entry) => entry.id === id);
    if (thread) return { project, thread };
  }
  return undefined;
}

export function defaultPreviewSelection(): { projectId: string; threadId: string } {
  return { projectId: "p1", threadId: "t1" };
}

export type PreviewDiagProcess = { name: string; pid: number | string; role: string; mem: string };
export type PreviewDiagError = { time: string; src: string; msg: string };
export type PreviewDiagLog = { tone: "muted" | "err"; text: string };
export type PreviewDiagnostics = {
  ompPath: string;
  version: string;
  rpc: string;
  bridge: string;
  cwd: string;
  configDir: string;
  processes: PreviewDiagProcess[];
  capabilities: string[];
  errors: PreviewDiagError[];
  logs: PreviewDiagLog[];
};

/** 诊断中心演示数据，1:1 移植自 ui_reference/ver1 mock-data.js + diagnostics 模板。 */
export const PREVIEW_DIAGNOSTICS: PreviewDiagnostics = {
  ompPath: "C:\\Users\\snowpear\\AppData\\Local\\Programs\\omp\\omp.exe",
  version: "v0.82.1",
  rpc: "omp-rpc/2.1",
  bridge: "connected · pid 21480",
  cwd: "C:\\Aspace\\Tools\\omp-web",
  configDir: "C:\\Users\\snowpear\\.omp",
  processes: [
    { name: "omp bridge", pid: 21480, role: "Bridge", mem: "84 MB" },
    { name: "omp agent (t1)", pid: 22104, role: "会话进程", mem: "312 MB" },
    { name: "omp agent (t7)", pid: 22331, role: "会话进程", mem: "287 MB" },
    { name: "vite dev (30141)", pid: 21996, role: "Preview 进程", mem: "406 MB" },
    { name: "chokidar watcher", pid: "—", role: "文件 Watcher", mem: "—" },
  ],
  capabilities: [
    "agent.run", "agent.steer", "fs.read", "fs.write", "bash.exec",
    "preview.open", "preview.dom", "mcp.proxy", "checkpoint.create", "checkpoint.restore",
  ],
  errors: [
    { time: "13:58:12", src: "MCP · playwright", msg: "transport closed unexpectedly (code 1006)" },
    { time: "13:41:03", src: "RPC", msg: 'capability "browser.controlled" 未在握手时声明' },
    { time: "12:02:47", src: "Plugin · browser-lab", msg: '加载失败：manifest.json 缺少 "omp" 字段' },
  ],
  logs: [
    { tone: "muted", text: '13:58:12.481 [rpc →] {"jsonrpc":"2.0","id":481,"method":"capability.call","params":{"cap":"preview.dom","session":"t1"}}' },
    { tone: "muted", text: '13:58:12.512 [rpc ←] {"jsonrpc":"2.0","id":481,"result":{"ok":true,"nodes":142}} · 31ms' },
    { tone: "err", text: "13:58:15.901 [mcp playwright] transport closed unexpectedly (code 1006) · attempt 3/5" },
    { tone: "err", text: '13:41:03.220 [rpc] handshake: capability "browser.controlled" not declared by cli v0.82.1' },
    { tone: "err", text: '12:02:47.884 [plugin browser-lab] manifest validation failed: missing required field "omp"' },
    { tone: "muted", text: "12:02:47.885 [plugin browser-lab] plugin skipped · 0 tools registered" },
  ],
};

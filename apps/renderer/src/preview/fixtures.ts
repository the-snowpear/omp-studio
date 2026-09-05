/**
 * Preview-mode fixtures, ported from ui_reference/ver1/assets/js/mock-data.js.
 * Renderer display only — never sent through Host / Studio Bridge.
 */

import type { TreeGitStatus } from "../git/treeStatus";

export type PreviewThreadWait = "approval" | "plan" | "ask";

export type PreviewThread = {
  id: string;
  title: string;
  time: string;
  msgs: number;
  status: "running" | "idle" | "archived";
  /** Sidebar capsule while a deck card is waiting (审批 / plan / ask). */
  wait?: PreviewThreadWait;
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
  insertions: number;
  deletions: number;
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
  status?: TreeGitStatus;
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
  tps: string;
  cacheHitRate: string;
  usedExact: string;
  totalExact: string;
  inPct: number;
  outPct: number;
  cachePct: number;
};

export type PreviewCtxPart = { name: string; v: string; pct: number; color: string };

export type PreviewChangeRow = {
  file: string;
  status: TreeGitStatus;
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
    branch: "main", worktree: null, dirty: 3, insertions: 214, deletions: 58, running: true,
    attention: true, preview: "running", pinned: true,
    threads: [
      { id: "t0", title: "新建对话（空白）", time: "now", msgs: 0, status: "idle" },
      { id: "t1", title: "跟踪上游 pi-web 更新到 omp-web", time: "32m ago", msgs: 45, status: "running", pinned: true, hasSub: true, unread: 3 },
      { id: "t2", title: "Audit and fix OSS repository issues", time: "2h ago", msgs: 12, status: "idle", wait: "ask", unread: 0 },
      { id: "t3", title: "选择 gemini3.6flash 随意发送消息后报错…", time: "4d ago", msgs: 1337, status: "idle", wait: "plan", hasSub: true, unread: 1 },
      { id: "t4", title: "修复 Git Bash 路径未找到问题", time: "4d ago", msgs: 8, status: "idle", wait: "approval" },
      { id: "t5", title: "重构 session 存储层 (session)", time: "6d ago", msgs: 156, status: "archived" },
      { id: "t9", title: "补齐预览模式的会话分页演示", time: "7d ago", msgs: 5, status: "idle" },
      { id: "t10", title: "清理历史遗留的 mock 分支", time: "9d ago", msgs: 21, status: "idle" },
      { id: "t11", title: "侧栏会话行悬停操作样式走查", time: "11d ago", msgs: 3, status: "idle" },
    ],
  },
  {
    id: "p2", name: "pi-web (upstream)", path: "C:\\Aspace\\Tools\\pi-web",
    branch: "v0.8.1", worktree: null, dirty: 0, insertions: 0, deletions: 0, running: false,
    attention: false, preview: "stopped",
    threads: [
      { id: "t6", title: "对比 v0.8.0 → v0.8.1 变更清单", time: "1d ago", msgs: 22, status: "idle" },
    ],
  },
  {
    id: "p3", name: "omp-web (feat/mermaid)", path: "C:\\Aspace\\Tools\\omp-web\\.worktrees\\mermaid",
    branch: "feat/mermaid-zoom", worktree: "mermaid", dirty: 7, insertions: 1263, deletions: 341, running: true,
    attention: false, preview: "building",
    threads: [
      { id: "t7", title: "Mermaid 渲染优化与全屏缩放拖拽", time: "18m ago", msgs: 63, status: "running", hasSub: true, unread: 2 },
      { id: "t8", title: "DirectoryPicker IDE 风格目录选择器", time: "3d ago", msgs: 41, status: "idle" },
    ],
  },
];

/**
 * 排队栏演示（p1 · t1「跟踪上游 pi-web 更新到 omp-web」流式期间）：
 * 流式时按 Enter 入队的两条本地消息，预览模式下覆盖真实排队状态展示。
 */
export const PREVIEW_QUEUED_MESSAGES: readonly { id: number; text: string }[] = [
  { id: 1, text: "对比完 v0.8.1 的变更后，把 package.json 里 pi-web 的依赖版本同步 bump 到 0.8.1" },
  { id: 2, text: "同步完跑一遍 npm run check，报错按优先级整理成清单" },
];

/**
 * 活动行演示（p1 · t1 流式期间）：对话滚动区底部的运行状态。
 * 与排队栏同一条故事线——正在跑 `npm run check`。
 */
export const PREVIEW_RUN_ACTIVITY = {
  status: { phase: "tool", label: "正在运行", detail: "npm run check" },
} as const;

export const PREVIEW_FILE_TREE: PreviewFileNode[] = [
  { type: "dir", name: ".claude", children: [{ type: "file", name: "settings.local.json" }] },
  { type: "dir", name: ".code-review-graph", children: [] },
  { type: "dir", name: ".github", children: [
    { type: "file", name: "FUNDING.yml" },
    { type: "dir", name: "workflows", children: [{ type: "file", name: "ci.yml" }] },
  ] },
  { type: "dir", name: "app", open: true, children: [
    { type: "file", name: "App.tsx", status: "modified", turn: true },
    { type: "file", name: "main.tsx" },
    { type: "dir", name: "routes", status: "modified", children: [
      { type: "file", name: "session.tsx", status: "modified", reading: true },
      { type: "file", name: "home.tsx" },
    ] },
  ] },
  { type: "dir", name: "bin", children: [{ type: "file", name: "omp-web.js" }] },
  { type: "dir", name: "components", open: true, children: [
    { type: "file", name: "DirectoryPicker.tsx", status: "added", writing: true },
    { type: "file", name: "MermaidBlock.tsx", status: "modified", turn: true, diagnostic: "error" },
    { type: "file", name: "ChatTimeline.tsx" },
    { type: "file", name: "CodeBlock.tsx", status: "modified" },
    { type: "file", name: "TelemetryBar.tsx", dirty: true },
  ] },
  { type: "dir", name: "docs", children: [
    { type: "file", name: "UPSTREAM-SYNC.md", status: "added" },
    { type: "file", name: "README.md", status: "modified", turn: true },
  ] },
  { type: "dir", name: "hooks", children: [
    { type: "file", name: "useCodeTheme.ts", status: "modified" },
    { type: "file", name: "useSession.ts" },
  ] },
  { type: "dir", name: "lib", children: [
    { type: "file", name: "rpc.ts", diagnostic: "warn" },
    { type: "file", name: "graft.ts", status: "renamed" },
  ] },
  { type: "file", name: ".gitignore" },
  { type: "file", name: "AGENTS.md" },
  { type: "file", name: "package.json", status: "modified", turn: true },
  { type: "file", name: "config.yml", status: "untracked" },
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
  tps: "6.8",
  cacheHitRate: "78%",
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

export const PREVIEW_CHANGES = {
  turn: [
    { file: "components/MermaidBlock.tsx", status: "modified" as const, add: 6, del: 3, agent: "主 Agent" },
    { file: "docs/UPSTREAM-SYNC.md", status: "added" as const, add: 214, del: 0, agent: "主 Agent" },
  ],
  thread: [
    { file: "README.md", status: "modified" as const, add: 3, del: 1, agent: "主 Agent" },
    { file: "package.json", status: "modified" as const, add: 4, del: 4, agent: "deps 子 Agent" },
    { file: "app/App.tsx", status: "modified" as const, add: 18, del: 9, agent: "主 Agent" },
    { file: "hooks/useCodeTheme.ts", status: "modified" as const, add: 11, del: 6, agent: "主 Agent" },
  ],
};

/** ver1 `D.todos` — composer-docked task list (display only). */
export type PreviewTodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  phase: string;
};

export const PREVIEW_TODOS: readonly PreviewTodoItem[] = [
  { id: "t1", phase: "文档", content: "阅读 docs/ 现有文档与 package.json", status: "completed" },
  { id: "t2", phase: "文档", content: "整理上游同步三阶段（graft / 合并 / 验证）", status: "completed" },
  { id: "t3", phase: "文档", content: "新建 docs/UPSTREAM-SYNC.md 并更新 README 链接", status: "completed" },
  { id: "t4", phase: "验证", content: "修复 MermaidBlock.tsx:147 字面量类型（TS2322）", status: "completed" },
  { id: "t5", phase: "验证", content: "重新运行 typecheck 与 lint 确认通过", status: "in_progress" },
  { id: "t6", phase: "验证", content: "验证 Mermaid 全屏缩放拖拽（Preview）", status: "in_progress" },
  { id: "t7", phase: "验证", content: "创建 Checkpoint #13 并汇总本轮变更", status: "pending" },
];

/** Compact file set for the composer dock (turn + README from the ver1 story). */
export const PREVIEW_TODO_FILES = [
  { path: "docs/UPSTREAM-SYNC.md", name: "UPSTREAM-SYNC.md", dir: "docs/", add: 214, del: 0 },
  { path: "README.md", name: "README.md", dir: "", add: 3, del: 1 },
  { path: "components/MermaidBlock.tsx", name: "MermaidBlock.tsx", dir: "components/", add: 6, del: 3 },
] as const;

/** Git 管理页演示：沿用 ver1 D.projects 里 omp-web / main 的故事（dirty 3）。 */
export const PREVIEW_GIT_LOG = {
  branch: "main",
  ahead: 2,
  behind: 0,
  headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  mergeBaseOid: "cccccccccccccccccccccccccccccccccccccccc",
  upstream: "origin/main",
  commits: [
    {
      oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: ["cccccccccccccccccccccccccccccccccccccccc", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      subject: "merge: integrate runtime interaction",
      authorName: "Ada",
      authorDate: "2026-08-16T12:00:00Z",
      relation: "head" as const,
      refs: [
        { name: "HEAD", kind: "head" as const, current: true },
        { name: "main", kind: "local" as const, current: true },
      ],
      files: [{ path: "apps/renderer/src/conversation/SessionChanges.tsx", status: "modified" as const }],
      patch: "@@ -1,3 +1,6 @@\n export function SessionChanges() {\n+  return <div>interaction host</div>;\n }\n",
    },
    {
      oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      parents: ["cccccccccccccccccccccccccccccccccccccccc"],
      subject: "feat(studio): integrate runtime interaction",
      authorName: "Ada",
      authorDate: "2026-08-16T11:00:00Z",
      relation: "outgoing" as const,
      refs: [],
      files: [{ path: "packages/host-client-api/src/facade.ts", status: "modified" as const }],
      patch: "@@ -10,3 +10,4 @@\n+  // interaction host\n",
    },
    {
      oid: "cccccccccccccccccccccccccccccccccccccccc",
      parents: ["dddddddddddddddddddddddddddddddddddddddd"],
      subject: "feat: expand models/MCP/agents host bridge",
      authorName: "Ada",
      authorDate: "2026-08-15T09:00:00Z",
      relation: "common" as const,
      refs: [{ name: "origin/main", kind: "remote" as const, current: false }],
      files: [{ path: "README.md", status: "modified" as const }],
      patch: "@@ -1,2 +1,3 @@\n # omp-web\n+Host bridge\n",
    },
    {
      oid: "dddddddddddddddddddddddddddddddddddddddd",
      parents: [],
      subject: "Initial commit",
      authorName: "thesnowpear",
      authorDate: "2026-08-01T08:00:00Z",
      relation: "common" as const,
      refs: [],
      files: [{ path: "README.md", status: "added" as const }],
      patch: "@@ -0,0 +1,2 @@\n+# omp-web\n",
    },
  ],
} as const;

export const PREVIEW_GIT = {
  branch: "main",
  ahead: 2,
  behind: 0,
  staged: [
    { path: "docs/UPSTREAM-SYNC.md", status: "新增" },
    { path: "README.md", status: "修改" },
  ],
  working: [
    { path: "components/MermaidBlock.tsx", status: "修改" },
    { path: "hooks/useCodeTheme.ts", status: "修改" },
    { path: "config.yml", status: "未跟踪" },
  ],
} as const;

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

export type PreviewDiagScenario = "ok" | "update" | "fail";
export type PreviewDiagError = { time: string; src: string; msg: string };
export type PreviewDiagLog = { tone: "muted" | "err"; text: string };
export type PreviewDiagnostics = {
  version: string;
  availableVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
  platform: string;
  arch: string;
  capabilities: string[];
  errors: PreviewDiagError[];
  logs: PreviewDiagLog[];
};

/** 诊断中心演示数据。主故事是版本与维护，不再把路径 / PID 当读模型。 */
export const PREVIEW_DIAGNOSTICS: PreviewDiagnostics = {
  version: "v0.82.1",
  availableVersion: "v0.82.2",
  upstreamVersion: "0.12.0",
  upstreamCommit: "45e12e5",
  platform: "win32",
  arch: "x64",
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

export type PreviewAppUpdate = {
  available: boolean;
  currentVersion: string;
  version: string;
  name: string;
  releaseNotes: string;
  publishedAt: string;
  htmlUrl: string;
  downloadUrl: string;
  assetName: string;
  assetSize: number;
};

export const PREVIEW_APP_UPDATE: PreviewAppUpdate = {
  available: true,
  currentVersion: "0.1.0",
  version: "0.2.0",
  name: "OMP Studio 0.2.0",
  releaseNotes: `### 新增功能与改进

- **GitHub Release 自动更新**：支持静默检测与一键全量安装包升级。
- **左下角状态提示**：发现新版本时在侧栏底部清晰展示更新提示徽标。
- **双语国际化支持**：新增完整的中文与英文更新引导。
- **性能与稳定性优化**：优化 Runtime Bridge 握手与 IPC 通信效率。`,
  publishedAt: "2026-08-20T00:00:00Z",
  htmlUrl: "https://github.com/the-snowpear/omp-studio/releases/tag/v0.2.0",
  downloadUrl: "https://github.com/the-snowpear/omp-studio/releases/download/v0.2.0/OMP-Studio-Setup-0.2.0-win-x64.exe",
  assetName: "OMP-Studio-Setup-0.2.0-win-x64.exe",
  assetSize: 89452000,
};


export const PREVIEW_UPDATES = {
  awaitingApply: {
    jobId: "prev-job-1",
    kind: "runtime" as const,
    phase: "awaiting-apply" as const,
    step: 2,
    steps: 3,
    message: "工件已验签，准备安装",
  },
  downloading: {
    jobId: "prev-job-2",
    kind: "runtime" as const,
    phase: "downloading" as const,
    step: 1,
    steps: 3,
    receivedBytes: 71_303_168,
    totalBytes: 165_821_320,
    bytesPerSecond: 4_194_304,
    message: "正在下载 Runtime (43%)...",
  },
} as const;

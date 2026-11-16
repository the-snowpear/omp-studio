/**
 * Preview-mode fixtures, ported from ui_reference/ver1/assets/js/mock-data.js.
 * Renderer display only — never sent through Host / Studio Bridge.
 */

import { PLATFORM } from "../platform";
import { isZh } from "../i18n";
import { demoPath } from "./demoPaths";
import type { TreeGitStatus } from "../git/treeStatus";
import type { IconName } from "../icons";
import type { ShellEventLogEntry } from "../shellMemory";
import type { LedgerCommandRow } from "../panels/types";
import type { CommandName, EventCursor } from "@omp-studio/client-contract";

export const PREVIEW_SSH_TARGETS = [
  { id: "demo-linux", name: "dev-linux", platform: "linux" as const },
  { id: "demo-windows", name: "build-windows", platform: "win32" as const },
  { id: "demo-mac", name: "studio-mac", platform: "darwin" as const },
];

export const PREVIEW_DESKTOP_RECOVERY = { version: "0.1.4" } as const;

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

export type PreviewActivity = { icon: IconName; color: string; text: string; time: string };

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


export function getPreviewProjects(zh = isZh()): PreviewProject[] {
  return [
    {
      id: "p1", name: "omp-web", path: demoPath("omp-web"),
      branch: "main", worktree: null, dirty: 3, insertions: 214, deletions: 58, running: true,
      attention: true, preview: "running", pinned: true,
      threads: [
        { id: "t0", title: zh ? "新建对话（空白）" : "New chat (empty)", time: "now", msgs: 0, status: "idle" },
        { id: "t15", title: zh ? "内容图鉴：全部工具卡与正文格式" : "Content gallery: all tool cards & formats", time: "now", msgs: 58, status: "idle", pinned: true },
        { id: "t1", title: zh ? "跟踪上游 pi-web 更新到 omp-web" : "Track upstream pi-web updates to omp-web", time: "32m ago", msgs: 45, status: "running", pinned: true, hasSub: true, unread: 3 },
        { id: "t2", title: "Audit and fix OSS repository issues", time: "2h ago", msgs: 12, status: "idle", wait: "ask", unread: 0 },
        { id: "t3", title: zh ? "Mermaid 全屏缩放计划与交互确认" : "Mermaid fullscreen zoom plan & confirmation", time: "4d ago", msgs: 16, status: "idle", wait: "plan", hasSub: true, unread: 1 },
        { id: "t4", title: zh ? "修复 Git Bash 路径未找到问题" : "Fix Git Bash path not found issue", time: "4d ago", msgs: 8, status: "idle", wait: "approval" },
        { id: "t5", title: zh ? "重构 session 存储层 (session)" : "Refactor session storage layer (session)", time: "6d ago", msgs: 156, status: "archived" },
        { id: "t9", title: zh ? "补齐会话分页加载" : "Complete session cursor pagination", time: "7d ago", msgs: 5, status: "idle" },
        { id: "t10", title: zh ? "工具图鉴：文件、搜索、Agent 与结构化结果" : "Tool gallery: files, search, agents & structured output", time: "9d ago", msgs: 2, status: "idle" },
        { id: "t11", title: zh ? "正文排版：表格、列表、代码与图片" : "Typography: tables, lists, code & images", time: "12m ago", msgs: 4, status: "idle" },
        { id: "t13", title: zh ? "命令块：Bash / PowerShell 多行与着色" : "Command blocks: Bash / PowerShell multiline & highlighting", time: "8m ago", msgs: 4, status: "idle" },
        { id: "t14", title: zh ? "工具检查：失败修复、空结果与长日志" : "Tool checks: failure recovery, empty results & long logs", time: "5m ago", msgs: 6, status: "idle", hasSub: false },
        { id: "t12", title: zh ? "修 MermaidBlock 的 TS2322（中途停止）" : "Fix TS2322 in MermaidBlock (interrupted)", time: "1h ago", msgs: 7, status: "idle" },
      ],
    },
    {
      id: "p2", name: "pi-web (upstream)", path: demoPath("pi-web"),
      branch: "v0.8.1", worktree: null, dirty: 0, insertions: 0, deletions: 0, running: false,
      attention: false, preview: "stopped",
      threads: [
        { id: "t6", title: zh ? "对比 v0.8.0 → v0.8.1 变更清单" : "Compare v0.8.0 → v0.8.1 changelog", time: "1d ago", msgs: 22, status: "idle" },
      ],
    },
    {
      id: "p3", name: "omp-web (feat/mermaid)", path: demoPath("omp-web", ".worktrees", "mermaid"),
      branch: "feat/mermaid-zoom", worktree: "mermaid", dirty: 7, insertions: 1263, deletions: 341, running: true,
      attention: false, preview: "building",
      threads: [
        { id: "t7", title: zh ? "Mermaid 渲染优化与全屏缩放拖拽" : "Mermaid rendering optimization and fullscreen zoom & pan", time: "18m ago", msgs: 63, status: "running", hasSub: true, unread: 2 },
        { id: "t8", title: zh ? "DirectoryPicker IDE 风格目录选择器" : "DirectoryPicker IDE-style directory picker", time: "3d ago", msgs: 41, status: "idle" },
      ],
    },
  ];
}

export const PREVIEW_PROJECTS: PreviewProject[] = getPreviewProjects();

/**
 * 排队栏演示（p1 · t1「跟踪上游 pi-web 更新到 omp-web」流式期间）：
 * 流式时按 Enter 入队的两条本地消息，预览模式下覆盖真实排队状态展示。
 */
export function getPreviewQueuedMessages(zh = isZh()): readonly { id: number; text: string }[] {
  return [
    { id: 1, text: zh ? "对比完 v0.8.1 的变更后，把 package.json 里 pi-web 的依赖版本同步 bump 到 0.8.1" : "After reviewing the v0.8.1 diff, bump the pi-web dependency version in package.json to 0.8.1" },
    { id: 2, text: zh ? "同步完跑一遍 npm run check，报错按优先级整理成清单" : "Run npm run check after syncing and list any errors by priority" },
  ];
}

export const PREVIEW_QUEUED_MESSAGES: readonly { id: number; text: string }[] = getPreviewQueuedMessages();

/**
 * 活动行演示（p1 · t1 流式期间）：对话滚动区底部的运行状态。
 * 与排队栏同一条故事线——正在跑 `npm run check`。
 */
export function getPreviewRunActivity(zh = isZh()) {
  return {
    status: { phase: "tool", label: zh ? "正在运行" : "Running", detail: "npm run check" },
  } as const;
}

export const PREVIEW_RUN_ACTIVITY = getPreviewRunActivity();

export function getPreviewFileTree(zh = isZh()): PreviewFileNode[] {
  return [
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
      { type: "file", name: zh ? "上游同步检查记录 v0.8.1.md" : "upstream sync notes v0.8.1.md", status: "untracked" },
      { type: "dir", name: "screenshots", children: [{ type: "file", name: "mermaid-dark.png" }, { type: "file", name: "mermaid-light.png" }] },
    ] },
    { type: "dir", name: "hooks", children: [
      { type: "file", name: "useCodeTheme.ts", status: "modified" },
      { type: "file", name: "useSession.ts" },
    ] },
    { type: "dir", name: "lib", children: [
      { type: "file", name: "rpc.ts", diagnostic: "warn" },
      { type: "file", name: "graft.ts", status: "renamed" },
    ] },
    { type: "dir", name: "tests", children: [
      { type: "dir", name: "fixtures", children: [{ type: "file", name: "session with spaces.json" }, { type: "file", name: "empty-session.json" }] },
      { type: "dir", name: "snapshots", children: [] },
      { type: "file", name: "conversation-workspace-restore-reading-position.test.tsx", diagnostic: "warn" },
    ] },
    { type: "file", name: ".gitignore" },
    { type: "file", name: "AGENTS.md" },
    { type: "file", name: "package.json", status: "modified", turn: true },
    { type: "file", name: "config.yml", status: "untracked" },
  ];
}

export const PREVIEW_FILE_TREE: PreviewFileNode[] = getPreviewFileTree();

export function getPreviewTelemetry(zh = isZh()): PreviewTelemetry {
  return {
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
    cost: zh ? "¥ 4.62" : "$ 4.62",
    retries: 1,
    subagentCost: zh ? "¥ 0.87" : "$ 0.87",
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
}

export const PREVIEW_TELEMETRY: PreviewTelemetry = getPreviewTelemetry();

export function getPreviewCtxParts(zh = isZh()): PreviewCtxPart[] {
  return [
    { name: zh ? "系统提示词" : "System prompt", v: "13k", pct: 5.9, color: "#8a919c" },
    { name: zh ? "系统上下文" : "System context", v: "42k", pct: 19.1, color: "#64748b" },
    { name: zh ? "工具定义" : "Tool definitions", v: "18k", pct: 8.2, color: "#64748b" },
    { name: "Skills", v: "24k", pct: 10.9, color: "#6e56cf" },
    { name: zh ? "对话消息" : "Messages", v: "123.4k", pct: 56.0, color: "#3b9bd4" },
  ];
}

export const PREVIEW_CTX_PARTS: PreviewCtxPart[] = getPreviewCtxParts();

export function getPreviewChanges(zh = isZh()) {
  const main = zh ? "主 Agent" : "Main Agent";
  const deps = zh ? "deps 子 Agent" : "deps subagent";
  return {
    turn: [
      { file: "components/MermaidBlock.tsx", status: "modified" as const, add: 6, del: 3, agent: main },
      { file: "docs/UPSTREAM-SYNC.md", status: "added" as const, add: 214, del: 0, agent: main },
    ],
    thread: [
      { file: "components/MermaidBlock.tsx", status: "modified" as const, add: 6, del: 3, agent: main },
      { file: "docs/UPSTREAM-SYNC.md", status: "added" as const, add: 214, del: 0, agent: main },
      { file: "README.md", status: "modified" as const, add: 3, del: 1, agent: main },
      { file: "package.json", status: "modified" as const, add: 4, del: 4, agent: deps },
      { file: "app/App.tsx", status: "modified" as const, add: 18, del: 9, agent: main },
      { file: "hooks/useCodeTheme.ts", status: "modified" as const, add: 11, del: 6, agent: main },
    ],
  };
}

export const PREVIEW_CHANGES = getPreviewChanges();

/** ver1 `D.todos` — composer-docked task list (display only). */
export type PreviewTodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  phase: string;
};

export function getPreviewTodos(zh = isZh()): readonly PreviewTodoItem[] {
  const docs = zh ? "文档" : "Docs";
  const verify = zh ? "验证" : "Verification";
  return [
    { id: "t1", phase: docs, content: zh ? "阅读 docs/ 现有文档与 package.json" : "Read existing docs/ and package.json", status: "completed" },
    { id: "t2", phase: docs, content: zh ? "整理上游同步三阶段（graft / 合并 / 验证）" : "Outline three upstream sync phases (graft / merge / verify)", status: "completed" },
    { id: "t3", phase: docs, content: zh ? "新建 docs/UPSTREAM-SYNC.md 并更新 README 链接" : "Create docs/UPSTREAM-SYNC.md and update README links", status: "completed" },
    { id: "t4", phase: verify, content: zh ? "修复 MermaidBlock.tsx:147 字面量类型（TS2322）" : "Fix literal type at MermaidBlock.tsx:147 (TS2322)", status: "completed" },
    { id: "t5", phase: verify, content: zh ? "重新运行 typecheck 与 lint 确认通过" : "Re-run typecheck and lint to verify clean", status: "in_progress" },
    { id: "t6", phase: verify, content: zh ? "验证 Mermaid 全屏缩放拖拽（Preview）" : "Verify Mermaid fullscreen zoom & pan (Preview)", status: "pending" },
    { id: "t7", phase: verify, content: zh ? "创建 Checkpoint #13 并汇总本轮变更" : "Create Checkpoint #13 and summarize turn changes", status: "pending" },
  ];
}

export const PREVIEW_TODOS: readonly PreviewTodoItem[] = getPreviewTodos();

/** Compact file set for the composer dock (turn + README from the ver1 story). */
export const PREVIEW_TODO_FILES = [
  { path: "docs/UPSTREAM-SYNC.md", name: "UPSTREAM-SYNC.md", dir: "docs/", add: 214, del: 0 },
  { path: "README.md", name: "README.md", dir: "", add: 3, del: 1 },
  { path: "components/MermaidBlock.tsx", name: "MermaidBlock.tsx", dir: "components/", add: 6, del: 3, partial: true },
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

export function getPreviewGit(zh = isZh()) {
  const modified = zh ? "修改" : "Modified";
  return {
    branch: "fix/mermaid-theme",
    ahead: 2,
    behind: 0,
    staged: [
      { path: "docs/UPSTREAM-SYNC.md", status: zh ? "新增" : "Added" },
      { path: "README.md", status: modified },
    ],
    working: [
      { path: "components/MermaidBlock.tsx", status: modified },
      { path: "hooks/useCodeTheme.ts", status: modified },
      { path: "config.yml", status: zh ? "未跟踪" : "Untracked" },
    ],
  } as const;
}

export const PREVIEW_GIT = getPreviewGit();

export function getPreviewDiff(zh = isZh()) {
  return {
    file: "components/MermaidBlock.tsx",
    add: 6,
    del: 3,
    lines: [
      [" ", "142", "142", "  const renderMermaid = useCallback(async (theme: MermaidTheme) => {"],
      [" ", "143", "143", "    const mermaid = await import(\"mermaid\");"],
      ["-", "144", "", "    const codeTheme = getCodeTheme() as string;"],
      ["+", "", "144", "    const codeTheme = getCodeTheme();"],
      [" ", "145", "145", "    mermaid.initialize({"],
      ["-", "146", "", "      theme: codeTheme,"],
      ["+", "", "146", "      theme: codeTheme satisfies MermaidTheme,"],
      [" ", "147", "147", "      securityLevel: \"strict\","],
      ["+", "", "148", "      themeVariables: buildThemeVars(codeTheme),"],
      [" ", "148", "149", "    });"],
      [" ", "149", "150", "  }, []);"],
      ["collapse", zh ? "52 行未变化" : "52 unchanged lines", "", ""],
      [" ", "201", "203", "  const onWheel = usePinchZoom(containerRef);"],
      ["-", "202", "", "  // legacy drag handler"],
      ["+", "", "204", "  const onDrag = usePanDrag(containerRef, { clamp: true });"],
      [" ", "203", "205", "  return <div ref={containerRef} className=\"mermaid-wrap\" />;"],
    ] as PreviewDiffLine[],
  };
}

export const PREVIEW_DIFF = getPreviewDiff();

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

export function getPreviewProblems(zh = isZh()): PreviewProblem[] {
  return [
    { sev: "error", src: "TypeScript", msg: "TS2322: Type 'string' is not assignable to type 'MermaidTheme'", file: "components/MermaidBlock.tsx", line: 147 },
    { sev: "error", src: "Preview", msg: "Failed to resolve import \"@earendil-works/pi-mermaid\"", file: "components/MermaidBlock.tsx", line: 12 },
    { sev: "warn", src: "ESLint", msg: "'onDrag' is defined but never used", file: "components/MermaidBlock.tsx", line: 204 },
    { sev: "warn", src: "ESLint", msg: "React Hook useCallback has a missing dependency", file: "hooks/useCodeTheme.ts", line: 31 },
    { sev: "info", src: zh ? "OMP 诊断" : "OMP Diagnostics", msg: zh ? 'RPC capability "preview.dom" 协商成功 (v2)' : 'RPC capability "preview.dom" negotiated (v2)', file: null, line: null },
    { sev: "warn", src: "Git", msg: zh ? "config.yml 未被跟踪，可能被意外提交" : "config.yml is untracked and could be committed accidentally", file: "config.yml", line: null },
    { sev: "error", src: "Vitest", msg: zh ? "切换会话后阅读位置未恢复：expected scrollTop 842, received 0" : "Reading position not restored after session switch: expected scrollTop 842, received 0", file: "tests/conversation-workspace-restore-reading-position.test.tsx", line: 128 },
    { sev: "info", src: zh ? "文档" : "Docs", msg: zh ? "检查记录含中文和空格文件名，等待补充 macOS 验收结果" : "Notes include UTF-8 & spaced filename; waiting on macOS sign-off", file: zh ? "docs/上游同步检查记录 v0.8.1.md" : "docs/upstream sync notes v0.8.1.md", line: 24 },
  ];
}

export const PREVIEW_PROBLEMS: PreviewProblem[] = getPreviewProblems();

export function getPreviewTests(zh = isZh()): PreviewTest[] {
  return [
    { suite: "lib/graft.test.ts", total: 12, pass: 12, fail: 0, time: "0.42s", status: "pass" },
    { suite: "lib/rpc.test.ts", total: 27, pass: 26, fail: 1, time: "1.18s", status: "fail", failDetail: "rpc › should negotiate capability v2\n  Expected: \"preview.dom\"\n  Received: undefined" },
    { suite: "components/DirectoryPicker.test.tsx", total: 8, pass: 8, fail: 0, time: "0.67s", status: "pass" },
    { suite: "components/CommandBlock.test.tsx", total: 18, pass: 18, fail: 0, time: "0.92s", status: "pass" },
    { suite: "components/MarkdownBody.test.tsx", total: 24, pass: 24, fail: 0, time: "1.46s", status: "pass" },
    {
      suite: "tests/conversation-workspace-restore-reading-position.test.tsx",
      total: 9,
      pass: 8,
      fail: 1,
      time: "2.31s",
      status: "fail",
      failDetail: `${zh ? "切换会话 › 保留长正文的阅读位置" : "switchConversation › preserves reading position on long transcripts"}\n  Expected scrollTop: 842\n  Received scrollTop: 0\n\n  126 | await switchConversation('notes');\n  127 | await switchConversation('review');\n> 128 | expect(view.scrollTop).toBe(842);\n      |                        ^\n\n  at tests/conversation-workspace-restore-reading-position.test.tsx:128:24`,
    },
  ];
}

export const PREVIEW_TESTS: PreviewTest[] = getPreviewTests();

export function getPreviewPvLogs(zh = isZh()) {
  return [
    { tone: "ok", text: "[vite] connected. (ws://127.0.0.1:30141)" },
    { tone: "", text: "[vite] hmr update /components/MermaidBlock.tsx" },
    { tone: "", text: "[vite] hmr update /docs/UPSTREAM-SYNC.md" },
    { tone: "warn", text: "[preview] console.warn · React Hook useCallback has a missing dependency (useCodeTheme.ts:31)" },
    { tone: "err", text: "[preview] console.error · Failed to resolve import \"@earendil-works/pi-mermaid\" (MermaidBlock.tsx:12)" },
    { tone: "", text: "[omp] preview attached, session=019fac94 · dom snapshot ok" },
    { tone: "muted", text: "[network] GET /api/session → 200 (18ms)" },
    { tone: "muted", text: "[network] GET /api/threads → 200 (9ms)" },
    { tone: "warn", text: "[bridge] preview.dom unavailable · using compatible read path" },
    { tone: "muted", text: "[session] reading-position checkpoint · thread=review · item=assistant-12 · offset=842" },
    { tone: "err", text: "[tests] conversation restore failed · expected 842px, received 0px · tests/conversation-workspace-restore-reading-position.test.tsx:128" },
    { tone: "ok", text: zh ? "[files] opened docs/上游同步检查记录 v0.8.1.md · UTF-8 · 2.4 KB" : "[files] opened docs/upstream sync notes v0.8.1.md · UTF-8 · 2.4 KB" },
    { tone: "ok", text: "[checks] command blocks: bash / pwsh / powershell / ps1 · 18 passed" },
    { tone: "", text: "[summary] 6 suites · 98 checks · 96 passed · 2 failed" },
  ];
}

export const PREVIEW_PV_LOGS = getPreviewPvLogs();

export function getPreviewHistory(zh = isZh()): PreviewHistoryRow[] {
  const c = (usd: string) => (zh ? `¥ ${usd}` : `$ ${usd}`);
  return [
    { id: "ph1", title: zh ? "跟踪上游 pi-web 更新到 omp-web" : "Track upstream pi-web updates to omp-web", project: "omp-web", branch: "main", time: "32m ago", model: "gemini-3.6-flash", status: "running", files: 4, cost: c("4.62"), forkedFrom: null, checkpoints: 12, pinned: true },
    { id: "ph2", title: zh ? "Mermaid 渲染优化与全屏缩放拖拽" : "Mermaid rendering optimization and fullscreen zoom & pan", project: "omp-web (feat/mermaid)", branch: "feat/mermaid-zoom", time: "18m ago", model: "gemini-3.6-flash", status: "running", files: 7, cost: c("2.31"), forkedFrom: zh ? "跟踪上游 pi-web 更新…" : "Track upstream pi-web updates…", checkpoints: 5, pinned: false },
    { id: "ph3", title: "Audit and fix OSS repository issues", project: "omp-web", branch: "main", time: "2h ago", model: "claude-sonnet-4.5", status: "completed", files: 9, cost: c("8.14"), forkedFrom: null, checkpoints: 3, pinned: false },
    { id: "ph4", title: zh ? "选择 gemini3.6flash 随意发送消息后报错…" : "Error after selecting gemini3.6flash and sending a test message…", project: "omp-web", branch: "main", time: "4d ago", model: "gemini-3.6-flash", status: "failed", files: 0, cost: c("0.42"), forkedFrom: null, checkpoints: 0, pinned: false },
    { id: "ph5", title: zh ? "修复 Git Bash 路径未找到问题" : "Fix Git Bash path not found issue", project: "omp-web", branch: "main", time: "4d ago", model: "gpt-5.2-codex", status: "completed", files: 2, cost: c("1.08"), forkedFrom: null, checkpoints: 2, pinned: false },
    { id: "ph6", title: zh ? "重构 session 存储层 (session)" : "Refactor session storage layer (session)", project: "omp-web", branch: "refactor/session-db", time: "6d ago", model: "claude-sonnet-4.5", status: "archived", files: 21, cost: c("22.90"), forkedFrom: null, checkpoints: 9, pinned: false },
  ];
}

export const PREVIEW_HISTORY: PreviewHistoryRow[] = getPreviewHistory();

export function getPreviewTimeTravel(zh = isZh()): PreviewTtNode[] {
  return zh ? [
    { kind: "user", title: "用户请求", detail: "整理上游同步过程为文档，并验证类型检查", time: "14:02" },
    { kind: "plan", title: "OMP 计划", detail: "4 步：阅读 docs → 整理三阶段 → 新建文档 → 运行验证", time: "14:03" },
    { kind: "tool", title: "工具执行", detail: "Read ×3 · Grep ×1 · Write UPSTREAM-SYNC.md · Edit README.md", time: "14:04" },
    { kind: "file", title: "文件变化", detail: "+2 文件（docs/UPSTREAM-SYNC.md +214 · README.md +3/-1）", time: "14:04" },
    { kind: "test", title: "测试 / 检查", detail: "npm run typecheck → 1 个错误（TS2322）", time: "14:05" },
    { kind: "checkpoint", title: "Checkpoint #12", detail: "3 文件 · +218/-4 · 构建通过 · Preview 已刷新", time: "14:06", restorable: true },
    { kind: "user", title: "后续请求", detail: "修复类型错误并验证 Mermaid 缩放", time: "14:07" },
    { kind: "tool", title: "工具执行", detail: "Edit MermaidBlock.tsx · typecheck 通过 · Preview 刷新", time: "14:08" },
    { kind: "checkpoint", title: "Checkpoint #13", detail: "4 文件 · +221/-5 · 0 错误", time: "14:09", restorable: true },
  ] : [
    { kind: "user", title: "User prompt", detail: "Document the upstream sync process and verify typecheck", time: "14:02" },
    { kind: "plan", title: "OMP Plan", detail: "4 steps: read docs → outline three phases → write doc → verify", time: "14:03" },
    { kind: "tool", title: "Tool execution", detail: "Read ×3 · Grep ×1 · Write UPSTREAM-SYNC.md · Edit README.md", time: "14:04" },
    { kind: "file", title: "File changes", detail: "+2 files (docs/UPSTREAM-SYNC.md +214 · README.md +3/-1)", time: "14:04" },
    { kind: "test", title: "Tests / checks", detail: "npm run typecheck → 1 error (TS2322)", time: "14:05" },
    { kind: "checkpoint", title: "Checkpoint #12", detail: "3 files · +218/-4 · build passed · Preview refreshed", time: "14:06", restorable: true },
    { kind: "user", title: "Follow-up prompt", detail: "Fix the type error and verify Mermaid zoom", time: "14:07" },
    { kind: "tool", title: "Tool execution", detail: "Edit MermaidBlock.tsx · typecheck passed · Preview refreshed", time: "14:08" },
    { kind: "checkpoint", title: "Checkpoint #13", detail: "4 files · +221/-5 · 0 errors", time: "14:09", restorable: true },
  ];
}

export const PREVIEW_TIME_TRAVEL: PreviewTtNode[] = getPreviewTimeTravel();

export function getPreviewActivity(zh = isZh()): PreviewActivity[] {
  return zh ? [
    { icon: "bot", color: "blue", text: "omp-web · 主 Agent 正在执行 npm run typecheck", time: "刚刚" },
    { icon: "diff", color: "purple", text: "omp-web · docs/UPSTREAM-SYNC.md 已写入（+214）", time: "4m ago" },
    { icon: "globe", color: "green", text: "omp-web · Preview 热更新完成（127.0.0.1:30141）", time: "6m ago" },
    { icon: "alert", color: "amber", text: "omp-web (feat/mermaid) · preview 子 Agent 等待用户确认", time: "12m ago" },
    { icon: "check", color: "green", text: "pi-web · 「对比 v0.8.0 → v0.8.1 变更清单」已完成", time: "1d ago" },
  ] : [
    { icon: "bot", color: "blue", text: "omp-web · Main Agent is running npm run typecheck", time: "Just now" },
    { icon: "diff", color: "purple", text: "omp-web · docs/UPSTREAM-SYNC.md written (+214)", time: "4m ago" },
    { icon: "globe", color: "green", text: "omp-web · Preview HMR finished (127.0.0.1:30141)", time: "6m ago" },
    { icon: "alert", color: "amber", text: "omp-web (feat/mermaid) · preview subagent waiting for user confirmation", time: "12m ago" },
    { icon: "check", color: "green", text: 'pi-web · "Compare v0.8.0 → v0.8.1 changelog" completed', time: "1d ago" },
  ];
}

export const PREVIEW_ACTIVITY: PreviewActivity[] = getPreviewActivity();

export function getPreviewSideAgents(zh = isZh()): PreviewSideAgent[] {
  const main = zh ? "主 Agent" : "Main Agent";
  const c = (usd: string) => (zh ? `¥ ${usd}` : `$ ${usd}`);
  return [
    { id: "a1", hubId: "agent-019fac94", name: main, role: "Coordinator", parent: null, task: zh ? "整理上游同步文档并验证类型检查" : "Document upstream sync and verify typecheck", status: "running", statusText: "Running Tool · Bash", lastTool: "Bash · npm run typecheck", time: "6m 12s", tokens: "48.2k", cost: c("1.94"), files: 4, waiting: false, error: false },
    { id: "a2", hubId: "agent-019fcb01", name: zh ? "deps 子 Agent" : "deps subagent", role: "Dependency Auditor", parent: main, task: zh ? "审计 @earendil-works/pi-* 0.82.1 变更" : "Audit @earendil-works/pi-* 0.82.1 changes", status: "running", statusText: "Thinking", lastTool: "Grep · \"pi-core\" in lockfile", time: "2m 47s", tokens: "12.6k", cost: c("0.51"), files: 1, waiting: false, error: false },
    { id: "a3", hubId: "agent-019fcb17", name: zh ? "preview 子 Agent" : "preview subagent", role: "Preview Verifier", parent: main, task: zh ? "验证 Mermaid 全屏缩放拖拽" : "Verify Mermaid fullscreen zoom & pan", status: "waiting", statusText: "Waiting for User", lastTool: zh ? "AskUser · 缩放交互确认" : "AskUser · confirm zoom interaction", time: "1m 03s", tokens: "5.1k", cost: c("0.22"), files: 0, waiting: true, error: false },
    { id: "a4", hubId: "agent-019fcb55", name: zh ? "lint 子 Agent" : "lint subagent", role: "Lint Runner", parent: main, task: zh ? "ESLint 全量扫描" : "Full ESLint scan", status: "failed", statusText: "Failed", lastTool: "Bash · eslint . (exit 2)", time: "38s", tokens: "3.3k", cost: c("0.14"), files: 0, waiting: false, error: true },
  ];
}

export const PREVIEW_SIDE_AGENTS: PreviewSideAgent[] = getPreviewSideAgents();

export function findPreviewProject(id: string, zh = isZh()): PreviewProject | undefined {
  return getPreviewProjects(zh).find((project) => project.id === id);
}

export function findPreviewThread(id: string, zh = isZh()): { project: PreviewProject; thread: PreviewThread } | undefined {
  for (const project of getPreviewProjects(zh)) {
    const thread = project.threads.find((entry) => entry.id === id);
    if (thread) return { project, thread };
  }
  return undefined;
}

export function defaultPreviewSelection(): { projectId: string; threadId: string } {
  return { projectId: "p1", threadId: "t1" };
}

export type PreviewDiagScenario = "ok" | "update" | "fail" | "blocked";
export type PreviewDiagError = { time: string; src: string; msg: string };
export type PreviewDiagLog = { tone: "muted" | "err"; text: string };
export type PreviewDiagnostics = {
  version: string;
  availableVersion: string;
  requiredAppVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
  platform: string;
  arch: string;
  capabilities: string[];
  errors: PreviewDiagError[];
  logs: PreviewDiagLog[];
};

/** 诊断中心演示数据。主故事是版本与维护，不再把路径 / PID 当读模型。 */
export function getPreviewDiagnostics(zh = isZh()): PreviewDiagnostics {
  return {
    version: "18.8.0-studio.17",
    availableVersion: "18.8.0-studio.18",
    requiredAppVersion: "0.1.11",
    upstreamVersion: "18.8.0",
    upstreamCommit: "4ef97c8826ee012829a3e756b693a2a16a414f47",
    platform: PLATFORM === "darwin" ? "darwin" : "win32",
    arch: PLATFORM === "darwin" ? "arm64" : "x64",
    capabilities: [
      "agent.run", "agent.steer", "fs.read", "fs.write", "bash.exec",
      "preview.open", "preview.dom", "mcp.proxy", "checkpoint.create", "checkpoint.restore",
    ],
    errors: [
      { time: "13:58:12", src: "MCP · playwright", msg: "transport closed unexpectedly (code 1006)" },
      { time: "13:41:03", src: "RPC", msg: zh ? 'capability "browser.controlled" 未在握手时声明' : 'capability "browser.controlled" was not declared during handshake' },
      { time: "12:02:47", src: "Plugin · browser-lab", msg: zh ? '加载失败：manifest.json 缺少 "omp" 字段' : 'Load failed: manifest.json missing required "omp" field' },
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
}

export const PREVIEW_DIAGNOSTICS: PreviewDiagnostics = getPreviewDiagnostics();

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
  requiresSystemAuthorization?: boolean;
};

export function getPreviewAppUpdate(zh = isZh()): PreviewAppUpdate {
  const version = PLATFORM === "linux" ? "0.2.2" : "0.2.0";
  const assetName = PLATFORM === "darwin" ? `OMP-Studio-${version}-macos-arm64.dmg` : PLATFORM === "linux" ? `OMP-Studio-${version}-linux-x64.deb` : `OMP-Studio-Setup-${version}-windows-x64.exe`;
  return {
    available: true,
    currentVersion: "0.1.0",
    version,
    name: `OMP Studio ${version}`,
    releaseNotes: zh
      ? `### 新增功能与改进

- **稳定更新**：后台准备桌面与 Runtime 更新；镜像失败自动切源并继续下载。
- **按需重启**：等待任务和交互完成后手动重试，已验证的更新会保留。
- **左下角状态提示**：发现新版本时在侧栏底部清晰展示更新提示徽标。
- **双语国际化支持**：新增完整的中文与英文更新引导。
- **性能与稳定性优化**：优化 Runtime Bridge 握手与 IPC 通信效率。`
      : `### What's New & Improvements

- **Resilient updates**: Prepare desktop and Runtime updates in the background, automatically falling back across mirrors and resuming downloads.
- **Restart on demand**: Retry safely after active tasks and prompts finish while keeping verified downloads intact.
- **Sidebar update badge**: Clearly surfaces new version status at the bottom of the left sidebar.
- **Full bilingual UI support**: Complete Chinese and English update guidance across dialogs and badges.
- **Performance & reliability**: Improved Runtime Bridge handshake and IPC responsiveness.`,
    publishedAt: "2026-08-20T00:00:00Z",
    htmlUrl: `https://github.com/the-snowpear/omp-studio/releases/tag/v${version}`,
    downloadUrl: `https://github.com/the-snowpear/omp-studio/releases/download/v${version}/${assetName}`,
    assetName,
    assetSize: 89452000,
    ...(PLATFORM === "linux" ? { requiresSystemAuthorization: true } : {}),
  };
}

export const PREVIEW_APP_UPDATE: PreviewAppUpdate = getPreviewAppUpdate();

export function getPreviewUpdates(zh = isZh()) {
  return {
    awaitingApply: {
      jobId: "prev-job-1",
      kind: "runtime" as const,
      phase: "awaiting-apply" as const,
      step: 2,
      steps: 3,
      message: zh ? "工件已验签，准备安装" : "Artifact verified and ready to install",
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
      message: zh ? "正在下载 Runtime (43%)..." : "Downloading Runtime (43%)...",
    },
  } as const;
}

export const PREVIEW_UPDATES = getPreviewUpdates();

/**
 * Statistics panel demo aggregates. The real page embeds the local `omp stats`
 * dashboard, which preview mode must not fabricate — these numbers stand in for
 * that panel so the surface is not empty while preview is on.
 */
export const PREVIEW_STATS_TOTALS = {
  tokens: 1_045_409_258,
  requests: 10_443,
  errors: 239,
  costEstimate: 1_121.8,
} as const;

/**
 * Preview-mode OMP Logs rows for one session: runtime attach, snapshot, session
 * open, the first prompt, a plan review whose approval lease expires, then the
 * rejected `interaction.respond` receipt that follows it. Cursors are contiguous
 * (no gap, so no resync banner) and time gaps stay between 36 ms and 3 s.
 */
const previewEventCursor = (value: number): EventCursor => String(value) as EventCursor;

export const PREVIEW_SHELL_EVENTS: readonly ShellEventLogEntry[] = [
  { cursor: previewEventCursor(41821), kind: "runtime.changed", occurredAt: "2026-10-30T14:58:01.204Z" },
  { cursor: previewEventCursor(41822), kind: "snapshot", occurredAt: "2026-10-30T14:58:01.252Z" },
  { cursor: previewEventCursor(41823), kind: "residents.changed", occurredAt: "2026-10-30T14:58:01.488Z" },
  { cursor: previewEventCursor(41824), kind: "diagnostics.changed", occurredAt: "2026-10-30T14:58:01.890Z" },
  { cursor: previewEventCursor(41825), kind: "command.accepted", occurredAt: "2026-10-30T14:58:03.774Z" },
  { cursor: previewEventCursor(41826), kind: "command.receipt", occurredAt: "2026-10-30T14:58:04.286Z" },
  { cursor: previewEventCursor(41827), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:04.324Z" },
  { cursor: previewEventCursor(41828), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:04.598Z" },
  { cursor: previewEventCursor(41829), kind: "residents.changed", occurredAt: "2026-10-30T14:58:05.804Z" },
  { cursor: previewEventCursor(41830), kind: "command.accepted", occurredAt: "2026-10-30T14:58:07.922Z" },
  { cursor: previewEventCursor(41831), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:07.958Z" },
  { cursor: previewEventCursor(41832), kind: "operation.progress", occurredAt: "2026-10-30T14:58:08.702Z" },
  { cursor: previewEventCursor(41833), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:10.020Z" },
  { cursor: previewEventCursor(41834), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:12.106Z" },
  { cursor: previewEventCursor(41835), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:12.918Z" },
  { cursor: previewEventCursor(41836), kind: "git.repository.changed", occurredAt: "2026-10-30T14:58:14.562Z" },
  { cursor: previewEventCursor(41837), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:14.966Z" },
  { cursor: previewEventCursor(41838), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:16.088Z" },
  { cursor: previewEventCursor(41839), kind: "diagnostics.changed", occurredAt: "2026-10-30T14:58:17.974Z" },
  { cursor: previewEventCursor(41840), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:18.590Z" },
  { cursor: previewEventCursor(41841), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:20.998Z" },
  { cursor: previewEventCursor(41842), kind: "command.accepted", occurredAt: "2026-10-30T14:58:22.500Z" },
  { cursor: previewEventCursor(41843), kind: "interaction.required", occurredAt: "2026-10-30T14:58:22.738Z" },
  { cursor: previewEventCursor(41844), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:24.502Z" },
  { cursor: previewEventCursor(41845), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:27.504Z" },
  { cursor: previewEventCursor(41846), kind: "interaction.resolved", occurredAt: "2026-10-30T14:58:27.722Z" },
  { cursor: previewEventCursor(41847), kind: "command.accepted", occurredAt: "2026-10-30T14:58:28.564Z" },
  { cursor: previewEventCursor(41848), kind: "command.receipt", occurredAt: "2026-10-30T14:58:28.928Z" },
  { cursor: previewEventCursor(41849), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:30.024Z" },
  { cursor: previewEventCursor(41850), kind: "command.accepted", occurredAt: "2026-10-30T14:58:32.288Z" },
  { cursor: previewEventCursor(41851), kind: "command.receipt", occurredAt: "2026-10-30T14:58:32.976Z" },
  { cursor: previewEventCursor(41852), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:33.017Z" },
  { cursor: previewEventCursor(41853), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:34.751Z" },
  { cursor: previewEventCursor(41854), kind: "git.repository.changed", occurredAt: "2026-10-30T14:58:37.067Z" },
  { cursor: previewEventCursor(41855), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:37.639Z" },
  { cursor: previewEventCursor(41856), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:39.047Z" },
  { cursor: previewEventCursor(41857), kind: "command.accepted", occurredAt: "2026-10-30T14:58:40.233Z" },
  { cursor: previewEventCursor(41858), kind: "command.receipt", occurredAt: "2026-10-30T14:58:41.165Z" },
  { cursor: previewEventCursor(41859), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:41.212Z" },
  { cursor: previewEventCursor(41860), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:42.736Z" },
  { cursor: previewEventCursor(41861), kind: "diagnostics.changed", occurredAt: "2026-10-30T14:58:43.804Z" },
  { cursor: previewEventCursor(41862), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:44.510Z" },
  { cursor: previewEventCursor(41863), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:45.852Z" },
  { cursor: previewEventCursor(41864), kind: "command.accepted", occurredAt: "2026-10-30T14:58:47.760Z" },
  { cursor: previewEventCursor(41865), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:48.772Z" },
  { cursor: previewEventCursor(41866), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:51.526Z" },
  { cursor: previewEventCursor(41867), kind: "residents.changed", occurredAt: "2026-10-30T14:58:52.572Z" },
  { cursor: previewEventCursor(41868), kind: "conversation.changed", occurredAt: "2026-10-30T14:58:52.906Z" },
];

/**
 * Preview-mode Output ledger rows, newest first. All seven client lifecycle
 * statuses appear so the panel's status runes and tone are visible at once;
 * only terminal non-completed rows carry a one-line `detail`. `at` is the time
 * of the row's current status (issued / accepted / receipt), so the clock
 * column reads as a compressed command trail.
 */
type PreviewLedgerRow = Omit<LedgerCommandRow, "commandName"> & { readonly commandName: CommandName };

export const PREVIEW_LEDGER_COMMANDS: readonly LedgerCommandRow[] = [
  { requestId: "req_c41a08", commandName: "session.model.set", status: "local_pending", at: "2026-10-30T14:58:52.404Z" },
  { requestId: "req_b27e50", commandName: "permissions.mode.set", status: "interaction_required", at: "2026-10-30T14:58:49.612Z" },
  { requestId: "req_9c1d02", commandName: "core.prompt", status: "accepted", at: "2026-10-30T14:58:47.318Z" },
  { requestId: "req_5d8f61", commandName: "interaction.respond", status: "rejected", at: "2026-10-30T14:58:40.906Z", detail: "Interaction lease expired before the response reached the Host." },
  { requestId: "req_2ab94f", commandName: "mode.plan.enter", status: "completed", at: "2026-10-30T14:58:33.274Z" },
  { requestId: "req_7f3a1c", commandName: "loop.enable", status: "failed", at: "2026-10-30T14:58:26.118Z", detail: "Loop rejected: maxIterations must be at least 2." },
  { requestId: "req_e60b3d", commandName: "operator.invoke", status: "outcome_unknown", at: "2026-10-30T14:58:17.552Z", detail: "Runtime restarted before the invocation receipt arrived." },
  { requestId: "req_3fa2c7", commandName: "session.create", status: "completed", at: "2026-10-30T14:58:09.104Z" },
] satisfies readonly PreviewLedgerRow[];

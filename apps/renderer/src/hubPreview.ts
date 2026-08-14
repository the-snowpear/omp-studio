/**
 * Preview-only Agent Hub fixtures, ported from ui_reference/ver1/assets/js/mock-data.js.
 * Used when Host snapshot.agents is empty so the page matches the ver1 visual.
 */

export type PreviewTool = { name: string; args?: string };
export type PreviewRetry = { attempt: number; maxAttempts: number; errorMessage?: string };
export type PreviewMetrics = {
  cost: number;
  durationMs: number;
  durationKind?: string;
  requests: number;
  tools: number;
  tokens: number;
  contextTokens?: number | null;
  contextWindow?: number | null;
};

export type PreviewAgent = {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  status: "running" | "idle" | "parked" | "aborted";
  activity: string;
  task: string;
  currentTool?: PreviewTool | null;
  lastIntent?: string | null;
  retryState?: PreviewRetry | null;
  modelRole?: string;
  resolvedModel?: string;
  fallback?: string | null;
  metrics?: PreviewMetrics;
  readOnly?: boolean;
  outputPath?: string | null;
  patchPath?: string | null;
  branchName?: string | null;
  children: string[];
  ircUnread?: number;
  createdAt: number;
  lastActivity: number;
  hasTranscript?: boolean;
  waitingPrompt?: string;
};

export type PreviewJob = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  label: string;
  durationMs: number;
  ownerId: string;
  resultText?: string | null;
  errorText?: string | null;
};

export type PreviewMain = {
  name: string;
  statusText: string;
  task: string;
  model: string;
  durationMs: number;
  contextPct: number;
};

export type PreviewHub = {
  runtimeLabel: string;
  main: PreviewMain;
  agents: PreviewAgent[];
  jobs: PreviewJob[];
};

export function buildPreviewHub(now = Date.now()): PreviewHub {
  const ago = (seconds: number) => now - seconds * 1000;
  return {
    runtimeLabel: "Full Parity Runtime",
    main: {
      name: "主对话",
      statusText: "Running Tool · Bash",
      task: "整理上游同步文档并验证类型检查",
      model: "gemini-3.6-flash",
      durationMs: 372000,
      contextPct: 42,
    },
    agents: [
      {
        id: "agent-019fcb01", name: "deps 子 Agent", kind: "sub", parentId: "main",
        status: "running", activity: "thinking",
        task: "审计 @earendil-works/pi-* 0.82.1 变更，确认 mermaid 类型签名",
        currentTool: { name: "Grep", args: '"pi-core" in package-lock.json' },
        lastIntent: "先扫 lockfile 定位间接依赖，再对 pi-mermaid 做类型 diff",
        modelRole: "@smol", resolvedModel: "gemini-3.6-flash",
        metrics: { cost: 0.51, durationMs: 167000, durationKind: "active", requests: 9, tools: 14, tokens: 12600, contextTokens: 31200, contextWindow: 128000 },
        children: ["agent-019fcb20"], ircUnread: 2, createdAt: ago(812), lastActivity: ago(3), hasTranscript: true,
      },
      {
        id: "agent-019fcb17", name: "preview 子 Agent", kind: "sub", parentId: "main",
        status: "idle", activity: "waiting", waitingPrompt: "缩放交互确认：拖拽平移是否需要惯性？",
        task: "验证 Mermaid 全屏缩放拖拽在 125% DPI 下的表现",
        lastIntent: "AskUserQuestion 挂起，等待用户选择交互方案",
        modelRole: "@vision", resolvedModel: "gemini-3.6-flash",
        metrics: { cost: 0.22, durationMs: 63000, durationKind: "active", requests: 4, tools: 6, tokens: 5100, contextTokens: 9800, contextWindow: 128000 },
        children: [], createdAt: ago(663), lastActivity: ago(63), hasTranscript: true,
      },
      {
        id: "agent-019fcb55", name: "lint 子 Agent", kind: "sub", parentId: "main",
        status: "idle", activity: "failed",
        task: "ESLint 全量扫描（merge 后回归）",
        currentTool: { name: "Bash", args: "eslint . (exit 2)" },
        lastIntent: "两次扫描均因 .eslintrc 合并冲突失败，已停止重试",
        retryState: { attempt: 2, maxAttempts: 2, errorMessage: "ESLint exited with code 2" },
        modelRole: "@worker", resolvedModel: "gpt-5-mini",
        metrics: { cost: 0.14, durationMs: 38000, durationKind: "active", requests: 2, tools: 2, tokens: 3300, contextTokens: 6100, contextWindow: 128000 },
        outputPath: "agent-019fcb55.md", children: [], createdAt: ago(438), lastActivity: ago(400), hasTranscript: true,
      },
      {
        id: "agent-019fcb20", name: "typecheck 子 Agent", kind: "sub", parentId: "agent-019fcb01",
        status: "running", activity: "tool",
        task: "bunx tsc --noEmit 全量类型检查并归类错误",
        currentTool: { name: "Bash", args: "bunx tsc --noEmit (running 24s)" },
        modelRole: "@worker", resolvedModel: "gpt-5.2-codex",
        metrics: { cost: 0.87, durationMs: 234000, durationKind: "active", requests: 6, tools: 9, tokens: 21400, contextTokens: 44800, contextWindow: 200000 },
        patchPath: "agent-019fcb20.patch", branchName: "agent/typecheck-019fcb20",
        children: [], createdAt: ago(294), lastActivity: ago(8), hasTranscript: true,
      },
      {
        id: "agent-019fc9d2", name: "docs 子 Agent", kind: "sub", parentId: "main",
        status: "parked", activity: "parked",
        task: "整理 UPSTREAM-SYNC.md 三阶段章节草稿",
        lastIntent: "草稿 v2 已交付，空闲 TTL 到期自动 park",
        modelRole: "@writer", resolvedModel: "claude-sonnet-4.5", fallback: "anthropic/claude-sonnet-4.5",
        metrics: { cost: 0.96, durationMs: 145000, durationKind: "active", requests: 7, tools: 11, tokens: 18200, contextTokens: 52100, contextWindow: 200000 },
        outputPath: "agent-019fc9d2.md", children: [], createdAt: ago(1445), lastActivity: ago(692), hasTranscript: true,
      },
      {
        id: "agent-019fc8a0", name: "audit 子 Agent", kind: "sub", parentId: "main",
        status: "parked", activity: "parked",
        task: "OSS 仓库发布前合规检查（license / NOTICE / 依赖审计）",
        lastIntent: "报告已生成，等待下一次手动 revive",
        modelRole: "@audit", resolvedModel: "gpt-5.2-codex",
        metrics: { cost: 1.23, durationMs: 412000, durationKind: "active", requests: 15, tools: 21, tokens: 40300, contextTokens: 88200, contextWindow: 200000 },
        outputPath: "agent-019fc8a0.md", patchPath: "agent-019fc8a0.patch",
        children: [], createdAt: ago(5200), lastActivity: ago(3612), hasTranscript: true,
      },
      {
        id: "agent-019fc77e", name: "spike 子 Agent", kind: "sub", parentId: "main",
        status: "aborted", activity: "aborted",
        task: "试验 ws 通道替代 stdio 的可行性（spike）",
        lastIntent: "方案被否决后由用户 kill（tombstone 已写入）",
        modelRole: "@spike", resolvedModel: "gpt-5-mini",
        metrics: { cost: 0.09, durationMs: 41000, durationKind: "active", requests: 3, tools: 4, tokens: 2900 },
        children: [], createdAt: ago(7400), lastActivity: ago(6200), hasTranscript: true,
      },
      {
        id: "advisor-019fab10", name: "advisor", kind: "advisor", parentId: "main",
        status: "idle", activity: "review",
        task: "架构顾问：评审 session 存储层重构方案的风险点",
        lastIntent: "advisor 是只读观察记录，不参与 agent 间消息",
        modelRole: "@advisor", resolvedModel: "claude-opus-4.8",
        metrics: { cost: 0.44, durationMs: 95000, durationKind: "active", requests: 2, tools: 0, tokens: 9600, contextTokens: 21400, contextWindow: 200000 },
        readOnly: true, outputPath: "advisor-019fab10.md",
        children: [], createdAt: ago(2400), lastActivity: ago(1200), hasTranscript: true,
      },
    ],
    jobs: [
      { id: "job-91", type: "bash", status: "running", label: "bunx tsc --noEmit", durationMs: 24000, ownerId: "agent-019fcb20" },
      { id: "job-87", type: "task", status: "failed", label: "eslint . 全量扫描", durationMs: 31000, ownerId: "agent-019fcb55", errorText: "ESLint exited with code 2 · .eslintrc 合并冲突" },
      { id: "job-83", type: "bash", status: "completed", label: "grep -rn \"pi-core\" package-lock.json", durationMs: 4200, ownerId: "agent-019fcb01", resultText: "4 matches in 2 files" },
      { id: "job-77", type: "task", status: "cancelled", label: "playwright 截图回归", durationMs: 18000, ownerId: "agent-019fcb17", errorText: "cancelled by owner agent" },
    ],
  };
}

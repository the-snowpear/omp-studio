/**
 * Preview-only Agent Hub fixtures, ported from ui_reference/ver1/assets/js/mock-data.js.
 * Used when Studio preview mode is on; it replaces the Host snapshot on this
 * page and must not be written through to Host commands.
 */

import type { JobActionsView, JobInspection, JobWidgetView } from "@omp-studio/studio-protocol";
import { isZh } from "./i18n";

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
  isolated?: boolean;
  nestedPatchPaths?: string[];
  children: string[];
  ircUnread?: number;
  createdAt: number;
  lastActivity: number;
  hasTranscript?: boolean;
  waitingPrompt?: string;
  stage?: string;
  completionPercent?: number;
};

export type PreviewJob = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  label: string;
  durationMs: number;
  ownerId: string;
  /** Subagent a task job runs; that agent's jobs nest under it. */
  agentId?: string;
  resultText?: string | null;
  errorText?: string | null;
  stage?: string;
  completionPercent?: number;
  widget?: JobWidgetView;
  actions?: JobActionsView;
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
  /** Owner lineage for the job tree (`snapshot.jobAgents`). */
  jobAgents: Array<{ id: string; parentId?: string }>;
};

/** Demo widget of the typecheck job: every block kind once. */
export function previewTypecheckWidget(now = Date.now()): JobWidgetView {
  return {
    title: "tsc --noEmit · 4 packages",
    headline: { text: "38 errors", label: "remaining", trend: { text: "▼ 12", tone: "success" } },
    stage: "checking packages/client (3/4)",
    state: "live",
    updatedAt: now - 2000,
    blocks: [
      {
        kind: "spark",
        label: "errors over time",
        values: [92, 88, 80, 77, 71, 66, 63, 59, 55, 50, 47, 44, 41, 38],
        min: 0,
        max: 100,
        marks: [{ value: 50, label: "baseline", tone: "muted" }],
        last: "38",
        tone: "accent",
      },
      { kind: "meter", label: "packages", value: 0.75, text: "3/4 packages", tone: "info" },
      {
        kind: "bars",
        label: "errors by package",
        max: 30,
        items: [
          { label: "renderer", value: 24, text: "24", tone: "error" },
          { label: "client", value: 9, text: "9", tone: "warning" },
          { label: "protocol", value: 5, text: "5", tone: "warning" },
        ],
      },
      {
        kind: "stat",
        items: [
          { label: "files", text: "412" },
          { label: "elapsed", text: "24 s" },
          { label: "rate", text: "17 files/s", trend: { text: "▲ 8%", tone: "success" } },
        ],
      },
      {
        kind: "grid",
        label: "shards",
        items: [
          { label: "protocol", text: "done", tone: "success" },
          { label: "client", text: "done", tone: "success" },
          { label: "host", text: "done", tone: "success" },
          { label: "renderer", text: "running", tone: "pending" },
        ],
      },
      { kind: "text", text: "src/AgentHub.tsx(2210,7): error TS2322" },
    ],
  };
}

/** Native run_watch observations carried by the existing task, not a new GitHub job. */
export function previewActionsWatch(finished = false): JobActionsView {
  return {
    mode: "run",
    state: finished ? "completed" : "watching",
    repo: "the-snowpear/omp-studio",
    runs: [{
      id: 24817,
      workflowName: "Renderer checks",
      status: "in_progress",
      branch: "upgrade/omp-18.19.0",
      jobs: [{
        id: 248171,
        name: "Windows · renderer",
        status: finished ? "completed" : "in_progress",
        ...(finished ? { conclusion: "failure", durationSeconds: 75 } : {}),
        steps: [
          { number: 1, name: "Check out source", status: "completed", conclusion: "success", durationSeconds: 3 },
          { number: 2, name: "Restore dependency cache", status: "completed", conclusion: "success", durationSeconds: 0 },
          { number: 3, name: "Check renderer types and behavior", status: finished ? "completed" : "in_progress", ...(finished ? { conclusion: "failure" } : {}) },
          { number: 4, name: "Upload screenshots", status: finished ? "completed" : "pending", ...(finished ? { conclusion: "skipped" } : {}) },
        ],
      }, {
        id: 248172,
        name: "Linux · renderer",
        status: "queued",
        steps: [],
      }],
    }],
    ...(finished ? { failedLogs: [{
      runId: 24817, jobId: 248171, workflowName: "Renderer checks", jobName: "Windows · renderer",
      conclusion: "failure", available: true,
      tail: "FAIL conversation/renderer-check\nExpected native result metadata; received legacy input fields.\nProcess exited with code 1.",
    }] } : {}),
  };
}

/** Demo `jobs.inspect` results, keyed by job id. Shown only in preview mode. */
export function previewJobInspections(now = Date.now(), zh = isZh()): Record<string, JobInspection> {
  return {
    "job-82": {
      jobId: "job-82", pids: [], purpose: zh ? "类型检查并观察原生 CI 结果" : "Run typecheck and watch native CI results",
      actions: previewActionsWatch(), output: "Native run_watch is waiting for renderer checks.",
    },
    "job-77": {
      jobId: "job-77", pids: [], actions: previewActionsWatch(), output: "cancelled by owner agent",
    },
    "job-91": {
      jobId: "job-91",
      purpose: zh ? "验证本次 Runtime 升级与 Renderer 适配" : "Verify this Runtime upgrade and Renderer integration",
      caption: zh ? "正在检查协议包和 Agent Hub 的类型兼容性" : "Checking type compatibility across protocol and Agent Hub",
      command: "bunx tsc --noEmit -p tsconfig.json",
      cwd: "~/projects/omp-studio",
      pids: [48213, 48220],
      output: "packages/client/src/reducer.ts(311,3): error TS2353\nsrc/AgentHub.tsx(2210,7): error TS2322\n…checking packages/client",
      widget: previewTypecheckWidget(now),
    },
    "job-83": {
      jobId: "job-83",
      command: "grep -rn \"pi-core\" package-lock.json",
      cwd: "~/projects/omp-studio",
      pids: [],
      exitCode: 0,
      output: "package-lock.json:1182:  \"node_modules/@earendil-works/pi-core\": {\npackage-lock.json:1190:    \"pi-core\": \"0.82.1\"",
    },
    "job-87": {
      jobId: "job-87",
      pids: [],
      output: zh ? "ESLint exited with code 2 · .eslintrc 合并冲突" : "ESLint exited with code 2 · .eslintrc merge conflict",
      actions: previewActionsWatch(true),
    },
  };
}

export function buildPreviewHub(now = Date.now(), zh = isZh()): PreviewHub {
  const ago = (seconds: number) => now - seconds * 1000;
  return {
    runtimeLabel: "Full Parity Runtime",
    main: {
      name: zh ? "主对话" : "Main conversation",
      statusText: "Running Tool · Bash",
      task: zh ? "整理上游同步文档并验证类型检查" : "Organize upstream sync docs and run typecheck",
      model: "gemini-3.6-flash",
      durationMs: 372000,
      contextPct: 42,
    },
    agents: [
      {
        id: "agent-019fcb01", name: zh ? "deps 子 Agent" : "deps subagent", kind: "sub", parentId: "main",
        status: "running", activity: "thinking",
        task: zh ? "审计 @earendil-works/pi-* 0.82.1 变更，确认 mermaid 类型签名" : "Audit @earendil-works/pi-* 0.82.1 changes and verify mermaid type signatures",
        currentTool: { name: "Grep", args: '"pi-core" in package-lock.json' },
        lastIntent: zh ? "先扫 lockfile 定位间接依赖，再对 pi-mermaid 做类型 diff" : "Scan lockfile for transitive deps, then run type diff on pi-mermaid",
        modelRole: "@smol", resolvedModel: "gemini-3.6-flash",
        metrics: { cost: 0.51, durationMs: 167000, durationKind: "active", requests: 9, tools: 14, tokens: 12600, contextTokens: 31200, contextWindow: 128000 },
        children: ["agent-019fcb20"], ircUnread: 2, createdAt: ago(812), lastActivity: ago(3), hasTranscript: true,
        stage: zh ? "对比 pi-mermaid 类型签名" : "Diffing pi-mermaid type signatures", completionPercent: 55,
      },
      {
        id: "agent-019fcb17", name: zh ? "preview 子 Agent" : "preview subagent", kind: "sub", parentId: "main",
        status: "idle", activity: "waiting", waitingPrompt: zh ? "缩放交互确认：拖拽平移是否需要惯性？" : "Zoom interaction check: should pan drag keep inertia?",
        task: zh ? "验证 Mermaid 全屏缩放拖拽在 125% DPI 下的表现" : "Verify Mermaid fullscreen zoom and pan at 125% DPI",
        lastIntent: zh ? "AskUserQuestion 挂起，等待用户选择交互方案" : "AskUserQuestion paused, waiting for user choice on interaction",
        modelRole: "@vision", resolvedModel: "gemini-3.6-flash",
        metrics: { cost: 0.22, durationMs: 63000, durationKind: "active", requests: 4, tools: 6, tokens: 5100, contextTokens: 9800, contextWindow: 128000 },
        children: [], createdAt: ago(663), lastActivity: ago(63), hasTranscript: true,
      },
      {
        id: "agent-019fcb55", name: zh ? "lint 子 Agent" : "lint subagent", kind: "sub", parentId: "main",
        status: "idle", activity: "failed",
        task: zh ? "ESLint 全量扫描（merge 后回归）" : "Full ESLint scan (post-merge regression)",
        currentTool: { name: "Bash", args: "eslint . (exit 2)" },
        lastIntent: zh ? "两次扫描均因 .eslintrc 合并冲突失败，已停止重试" : "Both runs failed on .eslintrc merge conflict; stopped retrying",
        retryState: { attempt: 2, maxAttempts: 2, errorMessage: "ESLint exited with code 2" },
        modelRole: "@worker", resolvedModel: "gpt-5-mini",
        metrics: { cost: 0.14, durationMs: 38000, durationKind: "active", requests: 2, tools: 2, tokens: 3300, contextTokens: 6100, contextWindow: 128000 },
        outputPath: "agent-019fcb55.md", children: [], createdAt: ago(438), lastActivity: ago(400), hasTranscript: true,
      },
      {
        id: "agent-019fcb20", name: zh ? "typecheck 子 Agent" : "typecheck subagent", kind: "sub", parentId: "agent-019fcb01",
        status: "running", activity: "tool",
        task: zh ? "bunx tsc --noEmit 全量类型检查并归类错误" : "Run full bunx tsc --noEmit typecheck and group errors",
        currentTool: { name: "Bash", args: "bunx tsc --noEmit (running 24s)" },
        modelRole: "@worker", resolvedModel: "gpt-5.2-codex",
        metrics: { cost: 0.87, durationMs: 234000, durationKind: "active", requests: 6, tools: 9, tokens: 21400, contextTokens: 44800, contextWindow: 200000 },
        patchPath: "agent-019fcb20.patch", branchName: "agent/typecheck-019fcb20",
        children: [], createdAt: ago(294), lastActivity: ago(8), hasTranscript: true,
        stage: zh ? "归类 renderer 类型错误" : "Classifying renderer type errors", completionPercent: 70,
      },
      {
        id: "agent-019fc9d2", name: zh ? "docs 子 Agent" : "docs subagent", kind: "sub", parentId: "main",
        status: "parked", activity: "parked",
        task: zh ? "整理 UPSTREAM-SYNC.md 三阶段章节草稿" : "Draft the three-phase sections of UPSTREAM-SYNC.md",
        lastIntent: zh ? "草稿 v2 已交付，空闲 TTL 到期自动 park" : "Draft v2 delivered; auto-parked on idle TTL expiry",
        modelRole: "@writer", resolvedModel: "claude-sonnet-4.5", fallback: "anthropic/claude-sonnet-4.5",
        metrics: { cost: 0.96, durationMs: 145000, durationKind: "active", requests: 7, tools: 11, tokens: 18200, contextTokens: 52100, contextWindow: 200000 },
        outputPath: "agent-019fc9d2.md", children: [], createdAt: ago(1445), lastActivity: ago(692), hasTranscript: true,
      },
      {
        id: "agent-019fc8a0", name: zh ? "audit 子 Agent" : "audit subagent", kind: "sub", parentId: "main",
        status: "parked", activity: "parked",
        task: zh ? "OSS 仓库发布前合规检查（license / NOTICE / 依赖审计）" : "Pre-release OSS compliance audit (license / NOTICE / dependency audit)",
        lastIntent: zh ? "报告已生成，等待下一次手动 revive" : "Report ready; waiting for manual revive",
        modelRole: "@audit", resolvedModel: "gpt-5.2-codex",
        metrics: { cost: 1.23, durationMs: 412000, durationKind: "active", requests: 15, tools: 21, tokens: 40300, contextTokens: 88200, contextWindow: 200000 },
        outputPath: "agent-019fc8a0.md", patchPath: "agent-019fc8a0.patch",
        isolated: true, nestedPatchPaths: ["agent-019fc8a0.nested-0-library.patch"],
        children: [], createdAt: ago(5200), lastActivity: ago(3612), hasTranscript: true,
      },
      {
        id: "agent-019fc77e", name: zh ? "spike 子 Agent" : "spike subagent", kind: "sub", parentId: "main",
        status: "aborted", activity: "aborted",
        task: zh ? "试验 ws 通道替代 stdio 的可行性（spike）" : "Spike: test WebSocket channel as stdio replacement",
        lastIntent: zh ? "方案被否决后由用户 kill（tombstone 已写入）" : "Killed by user after proposal rejection (tombstone written)",
        modelRole: "@spike", resolvedModel: "gpt-5-mini",
        metrics: { cost: 0.09, durationMs: 41000, durationKind: "active", requests: 3, tools: 4, tokens: 2900 },
        children: [], createdAt: ago(7400), lastActivity: ago(6200), hasTranscript: true,
      },
      {
        id: "advisor-019fab10", name: "advisor", kind: "advisor", parentId: "main",
        status: "idle", activity: "review",
        task: zh ? "架构顾问：评审 session 存储层重构方案的风险点" : "Architecture advisor: review risks of the session storage refactor",
        lastIntent: zh ? "advisor 是只读观察记录，不参与 agent 间消息" : "Advisor is a read-only observer and does not join agent messaging",
        modelRole: "@advisor", resolvedModel: "claude-opus-4.8",
        metrics: { cost: 0.44, durationMs: 95000, durationKind: "active", requests: 2, tools: 0, tokens: 9600, contextTokens: 21400, contextWindow: 200000 },
        readOnly: true, outputPath: "advisor-019fab10.md",
        children: [], createdAt: ago(2400), lastActivity: ago(1200), hasTranscript: true,
      },
    ],
    jobAgents: [
      { id: "agent-019fcb01" },
      { id: "agent-019fcb20", parentId: "agent-019fcb01" },
      { id: "agent-019fcb55" },
      { id: "agent-019fcb17" },
    ],
    jobs: [
      { id: "job-80", type: "task", status: "running", label: zh ? "deps 子 Agent · 审计 pi-* 0.82.1" : "deps subagent · audit pi-* 0.82.1", durationMs: 167000, ownerId: "main", agentId: "agent-019fcb01", stage: zh ? "对比 pi-mermaid 类型签名" : "Diffing pi-mermaid type signatures", completionPercent: 55 },
      { id: "job-82", type: "task", status: "running", label: zh ? "typecheck 子 Agent · 类型与 CI 检查" : "typecheck subagent · types & CI check", durationMs: 96000, ownerId: "agent-019fcb01", agentId: "agent-019fcb20", stage: zh ? "观察原生 CI 步骤" : "Watching native CI steps", actions: previewActionsWatch() },
      { id: "job-91", type: "bash", status: "running", label: "bunx tsc --noEmit", durationMs: 24000, ownerId: "agent-019fcb20", widget: previewTypecheckWidget(now) },
      { id: "job-87", type: "task", status: "failed", label: zh ? "eslint . 全量扫描" : "Full eslint . scan", durationMs: 31000, ownerId: "agent-019fcb55", errorText: zh ? "ESLint exited with code 2 · .eslintrc 合并冲突" : "ESLint exited with code 2 · .eslintrc merge conflict" },
      { id: "job-83", type: "bash", status: "completed", label: "grep -rn \"pi-core\" package-lock.json", durationMs: 4200, ownerId: "agent-019fcb01", resultText: "4 matches in 2 files" },
      { id: "job-77", type: "task", status: "cancelled", label: zh ? "playwright 截图回归" : "playwright screenshot regression", durationMs: 18000, ownerId: "agent-019fcb17", errorText: "cancelled by owner agent" },
    ],
  };
}

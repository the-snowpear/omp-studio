import type { StudioAgentSnapshot, StudioJobSnapshot } from "@omp-studio/studio-protocol";
import type { PreviewAgent, PreviewJob, PreviewMetrics } from "../../hubPreview";
import type { SubagentComposerAgent } from "../../conversation/subagentComposerGate";
import { type SubagentHubTarget } from "../../conversation/toolMeta";
import { isTickingAgentStatus } from "../../conversation/SubagentMetrics";
import { type HubTab } from "../../pageIntents";
import { type HubAgent, type HubJob, type HubStatus, type HubView } from "./types";

export const STATUS_LABEL: Record<HubStatus, string> = {
  running: "running",
  idle: "idle",
  parked: "parked",
  aborted: "aborted",
};

const HUB_WORDS: Record<string, string> = {
  running: "运行中",
  idle: "空闲",
  parked: "已停驻",
  aborted: "已中止",
  Streaming: "生成中",
  archived: "已归档",
  plan: "计划",
  vibe: "常规",
  Overview: "概览",
  Transcript: "对话记录",
  Jobs: "任务",
  Messages: "消息",
  Task: "任务",
  Current: "当前活动",
  Tool: "工具",
  "Last intent": "最近意图",
  Retry: "重试",
  Activity: "当前活动",
  "Active jobs": "运行中的任务",
  Usage: "用量",
  Metrics: "统计",
  Context: "上下文",
  Lineage: "父子关系",
  "Spawned by": "父代理",
  Children: "子代理",
  Registered: "创建时间",
  Changes: "变更",
  Mode: "模式",
  Output: "输出",
  Patch: "补丁",
  "Nested patch": "嵌套项目补丁",
  Isolation: "隔离状态",
  "Worktree branch": "工作区分支",
};

export function hubWord(value: string, zh: boolean): string {
  if (!zh) return value;
  if (value.startsWith("Running Tool"))
    return value.replace("Running Tool", "工具执行中");
  return HUB_WORDS[value] ?? value;
}

export const STATUS_DOT: Record<HubStatus, string> = {
  running: "green pulse",
  idle: "blue",
  parked: "gray",
  aborted: "red",
};

export const TABS: ReadonlyArray<readonly [HubTab, string]> = [
  ["overview", "Overview"],
  ["transcript", "Transcript"],
  ["jobs", "Jobs"],
  ["messages", "Messages"],
  ["btw", "BTW"],
];

function parseTs(value?: string): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

export function fmtAge(ts: number, now: number, zh = true): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (!Number.isFinite(s)) return "—";
  if (s < 5) return zh ? "刚刚" : "just now";
  if (s < 60) return `${s}s${zh ? " 前" : " ago"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${zh ? " 前" : " ago"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${zh ? " 前" : " ago"}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d${zh ? " 前" : " ago"}`;
  return `${Math.floor(d / 30)}mo${zh ? " 前" : " ago"}`;
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export function fmtClock(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtHM(ts: number): string {
  return fmtClock(ts).slice(0, 5);
}

export function fmtCost(cost: number): string {
  if(!Number.isFinite(cost)||cost===0)return "—";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function fmtNum(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

export function fmtMetrics(metrics?: PreviewMetrics): string {
  if (!metrics) return "usage —";
  return `${fmtCost(metrics.cost)} · ${fmtDur(metrics.durationMs)} · ${metrics.requests} req · ${metrics.tools} tools · ${fmtNum(metrics.tokens)} tok`;
}

export function sparkLevel(tokens: number): number {
  return Math.max(1, Math.min(3, Math.round(tokens / 40000)));
}

function hubStatus(status: StudioAgentSnapshot["status"]): HubStatus {
  if (status === "starting" || status === "running" || status === "reviving")
    return "running";
  if (status === "idle") return "idle";
  if (status === "parked") return "parked";
  return "aborted";
}

/**
 * 卡片/详情页显示的运行时长：已测量的 usage → 仍在跑时按当前时间走 → 已停止冻结在
 * 最后活动时间。停靠或中止后 `lastActivity` 不再前进，计数就此停住。
 */
export function hubDurationMs(agent: HubAgent, now: number): number | undefined {
  const measured = agent.metrics?.durationMs;
  if (measured !== undefined && Number.isFinite(measured))
    return Math.max(0, measured);
  if (agent.startedAt === undefined || !Number.isFinite(agent.startedAt))
    return undefined;
  const ended = isTickingAgentStatus(agent.rawStatus)
    ? now
    : agent.lastActivity;
  if (!Number.isFinite(ended)) return undefined;
  return Math.max(0, ended - agent.startedAt);
}

export function isAdvisor(agent: HubAgent): boolean {
  return agent.kind === "advisor";
}

export function hubComposerAgents(
  roster: readonly HubAgent[],
): SubagentComposerAgent[] {
  return roster.map((agent) => ({
    agentId: agent.id,
    kind: agent.kind,
    status: agent.rawStatus,
    readOnly: agent.readOnly,
    generation: agent.generation,
  }));
}

export function activityPill(
  agent: HubAgent,
  zh = false,
): { cls: string; label: string } {
  const copy = (cn: string, en: string) => (zh ? cn : en);
  if (agent.status === "aborted" || agent.rawStatus === "failed") {
    return {
      cls: "aborted",
      label:
        agent.rawStatus === "failed"
          ? copy("失败", "Failed")
          : copy("已中止", "Aborted"),
    };
  }
  if (agent.status === "running") {
    if (agent.activity === "tool") {
      return {
        cls: "tool",
        label: agent.currentTool?.name
          ? `${copy("工具执行中", "Running tool")} · ${agent.currentTool.name}`
          : copy("工具执行中", "Running tool"),
      };
    }
    return { cls: "thinking", label: copy("思考中", "Thinking") };
  }
  if (agent.status === "idle") {
    if (agent.activity === "waiting")
      return { cls: "waiting", label: copy("等待输入", "Waiting for User") };
    if (agent.activity === "failed")
      return { cls: "aborted", label: copy("失败", "Failed") };
    return { cls: "idle", label: copy("空闲", "Idle") };
  }
  if (agent.status === "parked")
    return { cls: "parked", label: copy("已停驻", "Parked") };
  return { cls: "parked", label: agent.status };
}

export function toHubAgent(agent: StudioAgentSnapshot, children: string[]): HubAgent {
  const usage = agent.usage;
  const metrics: PreviewMetrics | undefined = usage
    ? {
        cost: usage.cost,
        durationMs: usage.durationMs,
        ...(usage.durationKind !== undefined
          ? { durationKind: usage.durationKind }
          : {}),
        requests: usage.requests,
        tools: usage.tools,
        tokens: usage.tokens,
        ...(usage.contextTokens !== undefined &&
        usage.contextWindow !== undefined
          ? {
              contextTokens: usage.contextTokens,
              contextWindow: usage.contextWindow,
            }
          : {}),
      }
    : undefined;
  return {
    id: agent.agentId,
    name: agent.displayName,
    kind: agent.kind,
    ...(agent.parentAgentId ? { parentId: agent.parentAgentId } : {}),
    status: hubStatus(agent.status),
    rawStatus: agent.status,
    task: agent.assignment ?? agent.summary ?? "—",
    ...(agent.modelRole !== undefined ? { modelRole: agent.modelRole } : {}),
    ...(agent.resolvedModel !== undefined
      ? { resolvedModel: agent.resolvedModel }
      : {}),
    ...(agent.modelIsFallback === true && agent.resolvedModel !== undefined
      ? { fallback: agent.resolvedModel }
      : {}),
    ...(metrics ? { metrics } : {}),
    readOnly: agent.kind === "advisor" || agent.readOnly === true,
    unread: agent.unreadCount,
    ...(agent.outputPath !== undefined ? { outputPath: agent.outputPath } : {}),
    ...(agent.patchPath !== undefined ? { patchPath: agent.patchPath } : {}),
    ...(agent.branchName !== undefined ? { branchName: agent.branchName } : {}),
    ...(agent.nestedPatchPaths === undefined
      ? {}
      : { nestedPatchPaths: agent.nestedPatchPaths }),
    ...(agent.isolated === undefined ? {} : { isolated: agent.isolated }),
    ...(agent.canRevive === undefined ? {} : { canRevive: agent.canRevive }),
    children,
    activeJobIds: agent.activeJobIds,
    ...(agent.stage ? { stage: agent.stage } : {}),
    ...(agent.completionPercent !== undefined ? { completionPercent: agent.completionPercent } : {}),
    ...(Number.isFinite(parseTs(agent.startedAt))
      ? { startedAt: parseTs(agent.startedAt) }
      : {}),
    lastActivity: Number.isFinite(parseTs(agent.updatedAt))
      ? parseTs(agent.updatedAt)
      : Date.now(),
    hasLiveSession: agent.hasLiveSession,
    hasTranscript: agent.hasTranscript,
    generation: agent.generation,
  };
}

export function hubSelectorId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function")
    return CSS.escape(id);
  return id.replace(/[\n\r\\"\]]/g, (ch) => `\\${ch}`);
}

export function hubChatTarget(agent: HubAgent): SubagentHubTarget {
  return {
    agentId: agent.id,
    toolCallId: agent.id,
    ...(agent.task && agent.task !== "—" ? { task: agent.task } : {}),
  };
}

export function toHubJob(job: StudioJobSnapshot): HubJob {
  const started = parseTs(job.startedAt);
  const ended = parseTs(job.completedAt);
  const durationMs = Number.isFinite(started)
    ? Math.max(0, (Number.isFinite(ended) ? ended : Date.now()) - started)
    : 0;
  return {
    id: job.jobId,
    type: job.type,
    status: job.status,
    label: job.label,
    caption: job.caption,
    durationMs,
    ownerId: job.ownerAgentId,
    ...(job.agentId ? { agentId: job.agentId } : {}),
    generation: job.generation,
    ...(job.status === "completed" && job.summary
      ? { resultText: job.summary }
      : {}),
    ...(job.status === "failed" && job.summary
      ? { errorText: job.summary }
      : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.completionPercent !== undefined
      ? { completionPercent: job.completionPercent }
      : {}),
    ...(job.widget ? { widget: job.widget } : {}),
  };
}

export function fromPreviewAgent(agent: PreviewAgent): HubAgent {
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    ...(agent.parentId ? { parentId: agent.parentId } : {}),
    status: agent.status,
    rawStatus: agent.status,
    activity: agent.activity,
    task: agent.task,
    currentTool: agent.currentTool ?? null,
    lastIntent: agent.lastIntent ?? null,
    retryState: agent.retryState ?? null,
    ...(agent.modelRole ? { modelRole: agent.modelRole } : {}),
    ...(agent.resolvedModel ? { resolvedModel: agent.resolvedModel } : {}),
    fallback: agent.fallback ?? null,
    ...(agent.metrics ? { metrics: agent.metrics } : {}),
    readOnly: Boolean(agent.readOnly || agent.kind === "advisor"),
    unread: agent.ircUnread ?? 0,
    outputPath: agent.outputPath ?? null,
    patchPath: agent.patchPath ?? null,
    ...(agent.isolated === undefined
      ? {}
      : { isolated: agent.isolated, canRevive: !agent.isolated }),
    ...(agent.nestedPatchPaths === undefined
      ? {}
      : { nestedPatchPaths: agent.nestedPatchPaths }),
    branchName: agent.branchName ?? null,
    children: agent.children,
    activeJobIds: [],
    ...(agent.stage ? { stage: agent.stage } : {}),
    ...(agent.completionPercent !== undefined
      ? { completionPercent: agent.completionPercent }
      : {}),
    startedAt: agent.createdAt,
    lastActivity: agent.lastActivity,
    hasLiveSession: agent.status !== "aborted",
    hasTranscript: Boolean(agent.hasTranscript),
    generation: 1,
  };
}

export function fromPreviewJob(job: PreviewJob): HubJob {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    label: job.label,
    durationMs: job.durationMs,
    ownerId: job.ownerId,
    ...(job.agentId ? { agentId: job.agentId } : {}),
    generation: 1,
    ...(job.resultText ? { resultText: job.resultText } : {}),
    ...(job.errorText ? { errorText: job.errorText } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.completionPercent !== undefined
      ? { completionPercent: job.completionPercent }
      : {}),
    ...(job.widget ? { widget: job.widget } : {}),
  };
}

const UNKNOWN_CREATION = Number.MAX_SAFE_INTEGER;

/**
 * 列表顺序固定为「创建顺序」：注册时间升序，只按这个排。
 * 状态与最后活动时间都会在运行期变化，任何一项进排序键，卡片就会在每次
 * 状态翻转或 usage 更新时跳位（以前是「谁刚动过谁在最上面」）。缺少
 * `startedAt` 的行（归档快照没这个字段）落到末尾，用 id 保证顺序稳定。
 */
function creationKey(agent: HubAgent): number {
  return agent.startedAt !== undefined && Number.isFinite(agent.startedAt)
    ? agent.startedAt
    : UNKNOWN_CREATION;
}

function byCreation(a: HubAgent, b: HubAgent): number {
  return (
    creationKey(a) - creationKey(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function sortByCreation(rows: HubAgent[]): HubAgent[] {
  return rows.slice().sort(byCreation);
}

export function treeGroups(rows: HubAgent[]): {
  groups: Array<{ head: HubAgent; kids: HubAgent[] }>;
  orphans: HubAgent[];
} {
  const byId = new Map(rows.map((agent) => [agent.id, agent]));
  const hasVisParent = (agent: HubAgent) =>
    Boolean(
      agent.parentId && agent.parentId !== "main" && byId.has(agent.parentId),
    );
  const isGroupHead = (agent: HubAgent) =>
    !hasVisParent(agent) && rows.some((row) => row.parentId === agent.id);
  const heads = sortByCreation(rows.filter(isGroupHead));
  const used = new Set(heads.map((head) => head.id));
  const groups = heads.map((head) => {
    const kids = sortByCreation(rows.filter((row) => row.parentId === head.id));
    kids.forEach((kid) => used.add(kid.id));
    return { head, kids };
  });
  return {
    groups,
    orphans: sortByCreation(rows.filter((agent) => !used.has(agent.id))),
  };
}

export function linearSeq(rows: HubAgent[], view: HubView): HubAgent[] {
  if (view !== "tree") return sortByCreation(rows);
  const tree = treeGroups(rows);
  return [
    ...tree.groups.flatMap((group) => [group.head, ...group.kids]),
    ...tree.orphans,
  ];
}

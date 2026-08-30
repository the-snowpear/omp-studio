import type { StudioAgentSnapshot, StudioAgentUsage } from "@omp-studio/studio-protocol";
import { isRealSubagentId, type SubagentHubTarget, type SubagentView } from "./toolMeta";

const REDACTED_METRIC = "[redacted]";

function publicMetricString(value: string | undefined): string | undefined {
  if (value === undefined || value === REDACTED_METRIC || value.trim() === "") return undefined;
  return value;
}

export type SubagentMetricValues = {
  readonly tokens?: string;
  readonly tools?: string | number;
  readonly requests?: string | number;
  readonly files?: string | number;
  readonly cost?: string;
};

function formatMetricTokens(count: number): string {
  if (!Number.isFinite(count)) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(count));
}

/** Host usage is USD; compact-card strings (e.g. `¥ 0.51`) pass through unchanged. */
export function formatAgentCost(cost: number): string {
  if (!Number.isFinite(cost)) return "";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function metricsFromUsage(usage: StudioAgentUsage): SubagentMetricValues {
  const cost = formatAgentCost(usage.cost);
  return {
    tokens: formatMetricTokens(usage.tokens),
    tools: usage.tools,
    requests: usage.requests,
    ...(cost === "" ? {} : { cost }),
  };
}

/** Live roster usage wins; card-click strings fill gaps (files, preview). */
export function resolveSubagentMetrics(
  usage: StudioAgentUsage | undefined,
  target: Pick<SubagentHubTarget, "tokens" | "tools" | "requests" | "files" | "cost">,
): SubagentMetricValues {
  const live = usage === undefined ? {} : metricsFromUsage(usage);
  const tokens = publicMetricString(typeof target.tokens === "string" ? target.tokens : undefined)
    ?? (typeof target.tokens === "number" ? String(target.tokens) : undefined);
  const cost = publicMetricString(target.cost);
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(target.tools === undefined ? {} : { tools: target.tools }),
    ...(target.requests === undefined ? {} : { requests: target.requests }),
    ...(target.files === undefined ? {} : { files: target.files }),
    ...(cost === undefined ? {} : { cost }),
    ...live,
  };
}

export function formatSubagentDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** 只有这三种状态还在真正跑，时长才应该跟着现在时间走。 */
const TICKING_STATUS: readonly StudioAgentSnapshot["status"][] = ["starting", "running", "reviving"];

export function isTickingAgentStatus(status: StudioAgentSnapshot["status"]): boolean {
  return TICKING_STATUS.includes(status);
}

/**
 * 一行 roster 该显示的时长：已测量的 usage → 运行中按当前时间走 → 已停止冻结在
 * `updatedAt − startedAt`。停止（parked/aborted/failed/released）后 runtime 不再推
 * 新的 `updatedAt`，冻结值就是这个 Agent 真实跑过的跨度，不会再继续爬。
 */
export function subagentDurationMs(
  agent: Pick<StudioAgentSnapshot, "status" | "startedAt" | "updatedAt" | "usage">,
  nowMs: number = Date.now(),
): number | undefined {
  const measured = agent.usage?.durationMs;
  if (measured !== undefined && Number.isFinite(measured)) return Math.max(0, measured);
  if (agent.startedAt === undefined) return undefined;
  const started = Date.parse(agent.startedAt);
  if (!Number.isFinite(started)) return undefined;
  const ended = isTickingAgentStatus(agent.status) ? nowMs : Date.parse(agent.updatedAt);
  if (!Number.isFinite(ended)) return undefined;
  return Math.max(0, ended - started);
}

export function findLiveSubagent(
  agent: Pick<SubagentView, "agentId" | "name">,
  roster: readonly StudioAgentSnapshot[],
): StudioAgentSnapshot | undefined {
  if (agent.agentId !== undefined) {
    const byId = roster.find((live) => live.agentId === agent.agentId);
    if (byId !== undefined) return byId;
  }
  const named = roster.filter((live) => live.displayName === agent.name || live.agentId === agent.name);
  return named.length === 1 ? named[0] : undefined;
}

/** Overlay Agent Hub roster onto a transcript card. Live usage/status win. */
export function applyLiveSubagentRoster(
  agent: SubagentView,
  roster: readonly StudioAgentSnapshot[],
  nowMs: number = Date.now(),
): SubagentView {
  const live = findLiveSubagent(agent, roster);
  if (live === undefined) {
    const tokens = publicMetricString(agent.tokens);
    const cost = publicMetricString(agent.cost);
    if (tokens === agent.tokens && cost === agent.cost) return agent;
    return {
      name: agent.name,
      status: agent.status,
      toolCallId: agent.toolCallId,
      ...(agent.agentId === undefined ? {} : { agentId: agent.agentId }),
      ...(agent.task === undefined ? {} : { task: agent.task }),
      ...(agent.activity === undefined ? {} : { activity: agent.activity }),
      ...(agent.currentTool === undefined ? {} : { currentTool: agent.currentTool }),
      ...(agent.dur === undefined ? {} : { dur: agent.dur }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(agent.tools === undefined ? {} : { tools: agent.tools }),
      ...(agent.requests === undefined ? {} : { requests: agent.requests }),
      ...(agent.files === undefined ? {} : { files: agent.files }),
      ...(cost === undefined ? {} : { cost }),
    };
  }
  const metrics = resolveSubagentMetrics(live.usage, agent);
  const durationMs = subagentDurationMs(live, nowMs);
  const liveDur = durationMs === undefined ? undefined : formatSubagentDuration(durationMs);
  const dur = (liveDur !== undefined && liveDur !== "" ? liveDur : undefined) ?? agent.dur;
  const agentId = agent.agentId ?? (isRealSubagentId(live.agentId) ? live.agentId : undefined);
  const task = live.assignment ?? agent.task;
  return {
    name: live.displayName || agent.name,
    status: live.status,
    toolCallId: agent.toolCallId,
    ...(agentId === undefined ? {} : { agentId }),
    ...(task === undefined ? {} : { task }),
    ...(agent.activity === undefined ? {} : { activity: agent.activity }),
    ...(agent.currentTool === undefined ? {} : { currentTool: agent.currentTool }),
    ...(dur === undefined ? {} : { dur }),
    ...(agent.files === undefined ? {} : { files: agent.files }),
    ...metrics,
  };
}

export function SubagentMetrics({ tokens, tools, requests, files, cost }: SubagentMetricValues) {
  if (tokens === undefined && tools === undefined && requests === undefined && files === undefined && !cost) {
    return null;
  }
  const aria = [
    tokens !== undefined ? `${tokens} tok` : "",
    tools !== undefined ? `${tools} tools` : "",
    requests !== undefined ? `${requests} req` : "",
    files !== undefined ? `${files} files` : "",
    cost ?? "",
  ].filter(Boolean).join("，");
  return (
    <div className="sa-metrics" aria-label={aria}>
      {tokens !== undefined ? <span className="sa-tok"><b>{tokens}</b><i>tok</i></span> : null}
      {tools !== undefined ? <span className="hub-num"><i>tools</i><b>{tools}</b></span> : null}
      {requests !== undefined ? <span className="hub-num"><i>req</i><b>{requests}</b></span> : null}
      {files !== undefined ? <span className="hub-num"><i>files</i><b>{files}</b></span> : null}
      {cost ? <span className="sa-cost">{cost}</span> : null}
    </div>
  );
}

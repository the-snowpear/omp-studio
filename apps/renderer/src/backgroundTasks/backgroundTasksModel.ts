import type {
  StudioJobAgentLink,
  StudioJobSnapshot,
  StudioServiceRow,
} from "@omp-studio/studio-protocol";
import { buildJobTree } from "../conversation/jobTree";

type TaskFields = {
  key: string;
  label: string;
  state: string;
  active: boolean;
  failed: boolean;
  startedAt?: number;
  endedAt?: number;
  depth: number;
  ownerLabel?: string;
};

export type BackgroundTask = TaskFields & (
  | { kind: "job"; job: StudioJobSnapshot; service?: never }
  | { kind: "service"; service: StudioServiceRow; job?: never }
);

function timestamp(value: string | number | undefined): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : value;
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function times(start: string | number | undefined, end: string | number | undefined) {
  const startedAt = timestamp(start);
  const endedAt = timestamp(end);
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

/** Renderer-only union: identifiers remain bound to their source and run. */
export function buildBackgroundTasks(
  jobs: readonly StudioJobSnapshot[],
  services: readonly StudioServiceRow[],
  links: readonly StudioJobAgentLink[] = [],
): BackgroundTask[] {
  const tree = buildJobTree(jobs.map((job) => ({
    id: String(job.jobId),
    ownerId: String(job.ownerAgentId),
    ...(job.agentId === undefined ? {} : { agentId: String(job.agentId) }),
    snapshot: job,
  })), links);
  const rows: BackgroundTask[] = tree.map(({ job: { snapshot: job }, depth }) => ({
    key: `job:${encodeURIComponent(job.jobId)}:${job.generation}`,
    kind: "job",
    label: job.label,
    state: job.status,
    active: job.status === "running" || job.status === "queued",
    failed: job.status === "failed",
    ...times(job.startedAt, job.completedAt),
    depth,
    ownerLabel: String(job.ownerAgentId),
    job,
  }));
  for (const service of services) {
    rows.push({
      key: `service:${encodeURIComponent(service.instanceId)}:${encodeURIComponent(service.name)}`,
      kind: "service",
      label: service.name,
      state: service.state,
      active: service.state !== "exited" && service.state !== "failed",
      failed: service.state === "failed" || (service.state === "exited" && service.exitCode !== undefined && service.exitCode !== 0),
      ...times(service.startedAt, service.exitedAt),
      depth: 0,
      ...(service.ownerAgentId === undefined ? {} : { ownerLabel: service.ownerAgentId }),
      service,
    });
  }
  // Stable active order preserves the job tree; settled rows are newest first.
  return rows.sort((a, b) => Number(b.active) - Number(a.active)
    || (a.active ? 0 : (b.endedAt ?? -Infinity) - (a.endedAt ?? -Infinity)));
}

/** Missing settlement times stay unknown rather than growing after completion. */
export function taskDuration(task: BackgroundTask, now: number): string {
  const end = task.active ? now : task.endedAt;
  if (task.startedAt === undefined || end === undefined || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", remainder || !seconds ? `${remainder}s` : ""].filter(Boolean).join(" ");
}

export function taskStatusLabel(task: BackgroundTask, zh: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
    queued: ["排队中", "Queued"],
    running: ["运行中", "Running"],
    completed: ["已完成", "Completed"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    starting: ["启动中", "Starting"],
    ready: ["就绪", "Ready"],
    restarting: ["重启中", "Restarting"],
    stopping: ["停止中", "Stopping"],
    exited: ["已退出", "Exited"],
  };
  return labels[task.failed ? "failed" : task.state]?.[zh ? 0 : 1] ?? task.state;
}

export function backgroundTaskCounts(rows: readonly BackgroundTask[]) {
  const counts = { active: 0, failed: 0, completed: 0, cancelled: 0, total: rows.length };
  for (const row of rows) {
    if (row.active) counts.active += 1;
    else if (row.failed) counts.failed += 1;
    else if (row.kind === "job" && row.state === "cancelled") counts.cancelled += 1;
    else if (row.state === "completed" || row.state === "exited") counts.completed += 1;
  }
  return counts;
}

/** Agent-run work belongs to Agents, not the main conversation's process list. */
export function mainConversationJobs(jobs: readonly StudioJobSnapshot[], mainAgentId: string | undefined): readonly StudioJobSnapshot[] {
  if (!mainAgentId) return [];
  return jobs.filter(job => job.ownerAgentId === mainAgentId && job.type !== "task" && job.agentId === undefined);
}
/** Native launch uses session IDs; older runtimes used Agent IDs. Both remain exact-owner matches. */
export function mainConversationServices(services: readonly StudioServiceRow[], mainAgentId: string | undefined, sessionId?: string): readonly StudioServiceRow[] {
  const owners = new Set([mainAgentId, sessionId].filter((value): value is string => !!value));
  return services.filter(service => {
    const owner = service.ownerId ?? service.ownerAgentId;
    return owner !== undefined && owners.has(owner);
  });
}

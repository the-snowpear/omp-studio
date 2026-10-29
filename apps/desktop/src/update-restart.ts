import type { OperatorStateSnapshot, StudioAgentSnapshot, StudioJobSnapshot } from "@omp-studio/studio-protocol";

/** A normal postponement: no Runtime has been stopped and the prepared update stays ready. */
export class UpdateRestartBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateRestartBlockedError";
  }
}

/** How many blocking agents/jobs the postponement message names before it summarises. */
const NAMED_BLOCKERS = 3;

/**
 * Whether an agent entry describes work that a restart would destroy.
 *
 * The root agent is registered as `running` while its session is constructed and
 * only leaves that state through a run-state notification the desktop host never
 * subscribes to, so its raw status reports `running` on a completely idle
 * session. A root turn in flight is already covered by `snapshot.isStreaming`,
 * and queued root work by `pendingMessages`/`activeCommandIds`, so the status
 * alone must not block an update — otherwise "restart to update" is refused
 * forever once a session is open.
 */
function agentBlocksRestart(agent: StudioAgentSnapshot): boolean {
  if (agent.activeJobIds.length > 0) return true;
  // Pending spawns and revivals have no live session yet but really are starting.
  if (agent.status === "starting" || agent.status === "reviving") return true;
  if (agent.status !== "running") return false;
  if (agent.kind === "main") return false;
  // A subagent that lost its session cannot be making progress; `undefined`
  // means the publisher predates the field, so keep the conservative answer.
  return agent.hasLiveSession !== false;
}

function jobBlocksRestart(job: StudioJobSnapshot): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Names the work that holds the restart back, so the dialog is actionable. */
function busyMessage(agents: readonly StudioAgentSnapshot[], jobs: readonly StudioJobSnapshot[]): string {
  const names: string[] = [];
  for (const agent of agents) {
    const name = agent.displayName?.trim() || agent.agentId;
    if (!names.includes(name)) names.push(name);
  }
  for (const job of jobs) {
    const name = job.label?.trim() || job.jobId;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return "后台任务仍在运行，请完成后重启更新";
  const shown = names.slice(0, NAMED_BLOCKERS).join("、");
  const rest = names.length > NAMED_BLOCKERS ? " 等" : "";
  return `后台任务仍在运行（${shown}${rest}），请完成后重启更新`;
}

export function updateRestartBlockerForSnapshot(snapshot: OperatorStateSnapshot | undefined): string | undefined {
  if (!snapshot) return "会话状态尚未就绪，请稍后重试";
  if (snapshot.isStreaming) return "任务仍在运行，请完成后重启更新";
  if (snapshot.isCompacting) return "会话正在压缩，请完成后重启更新";
  if (snapshot.pendingInteraction !== undefined) return "请先处理待完成的交互，再重启更新";
  if (snapshot.plan?.status === "review") return "请先完成计划审阅，再重启更新";
  if (snapshot.pendingMessages > 0) return "仍有排队消息，请处理后重启更新";
  if (snapshot.activeCommandIds.length > 0) return "仍有命令未完成，请完成后重启更新";
  const agents = snapshot.agents.filter(agentBlocksRestart);
  const jobs = snapshot.jobs.filter(jobBlocksRestart);
  if (agents.length > 0 || jobs.length > 0) return busyMessage(agents, jobs);
  return undefined;
}

import type { OperatorStateSnapshot, StudioAgentSnapshot, StudioJobSnapshot } from "@omp-studio/studio-protocol";
import { desktopText, isDesktopZh } from "./desktop-language-shared.js";

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
  if (names.length === 0) return desktopText("后台任务仍在运行，请完成后重启更新", "Background tasks are still running; wait until they finish before restarting to update");
  const zh = isDesktopZh();
  const shown = names.slice(0, NAMED_BLOCKERS).join(zh ? "、" : ", ");
  const rest = names.length > NAMED_BLOCKERS ? (zh ? " 等" : ", etc.") : "";
  return zh
    ? `后台任务仍在运行（${shown}${rest}），请完成后重启更新`
    : `Background tasks are still running (${shown}${rest}); wait until they finish before restarting to update`;
}

export function updateRestartBlockerForSnapshot(snapshot: OperatorStateSnapshot | undefined): string | undefined {
  if (!snapshot) return desktopText("会话状态尚未就绪，请稍后重试", "Session state is not ready yet; try again shortly");
  if (snapshot.isStreaming) return desktopText("任务仍在运行，请完成后重启更新", "Tasks are still running; wait until they finish before restarting to update");
  if (snapshot.isCompacting) return desktopText("会话正在压缩，请完成后重启更新", "Session is compacting; wait until it finishes before restarting to update");
  if (snapshot.pendingInteraction !== undefined) return desktopText("请先处理待完成的交互，再重启更新", "Respond to pending interactions before restarting to update");
  if (snapshot.plan?.status === "review") return desktopText("请先完成计划审阅，再重启更新", "Complete the plan review before restarting to update");
  if (snapshot.pendingMessages > 0) return desktopText("仍有排队消息，请处理后重启更新", "Queued messages are still pending; handle them before restarting to update");
  if (snapshot.activeCommandIds.length > 0) return desktopText("仍有命令未完成，请完成后重启更新", "Commands are still running; wait until they finish before restarting to update");
  const agents = snapshot.agents.filter(agentBlocksRestart);
  const jobs = snapshot.jobs.filter(jobBlocksRestart);
  if (agents.length > 0 || jobs.length > 0) return busyMessage(agents, jobs);
  return undefined;
}

import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

/** A normal postponement: no Runtime has been stopped and the prepared update stays ready. */
export class UpdateRestartBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateRestartBlockedError";
  }
}

export function updateRestartBlockerForSnapshot(snapshot: OperatorStateSnapshot | undefined): string | undefined {
  if (!snapshot) return "会话状态尚未就绪，请稍后重试";
  if (snapshot.isStreaming) return "任务仍在运行，请完成后重启更新";
  if (snapshot.isCompacting) return "会话正在压缩，请完成后重启更新";
  if (snapshot.pendingInteraction !== undefined) return "请先处理待完成的交互，再重启更新";
  if (snapshot.plan?.status === "review") return "请先完成计划审阅，再重启更新";
  if (snapshot.pendingMessages > 0) return "仍有排队消息，请处理后重启更新";
  if (snapshot.activeCommandIds.length > 0) return "仍有命令未完成，请完成后重启更新";
  if (snapshot.agents.some(agent => agent.status === "starting" || agent.status === "running" ||
    agent.status === "reviving" || agent.activeJobIds.length > 0) ||
    snapshot.jobs.some(job => job.status === "queued" || job.status === "running")) {
    return "后台任务仍在运行，请完成后重启更新";
  }
  return undefined;
}

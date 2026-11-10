import type { ClientBootstrap } from "@omp-studio/client-contract";
import { type Caps, type HubAgent } from "./types";
import { isAdvisor } from "./projection";

export const CONTRACT = {
  chat: "发送（暂未实现）",
  revive: "Revive（暂未实现）",
  kill: "停止（暂未实现）",
  release: "释放（暂未实现）",
  spawn: "派生（暂未实现）",
  cancel: "取消（暂未实现）",
  transcript: "无 transcript",
  irc: "IRC（暂未实现）",
  previewWrite: "预览模式",
  historicalWrite: "历史会话只读",
} as const;

export function missingCap(
  capabilities: ClientBootstrap["capabilityManifest"] | undefined,
  id: string,
): boolean {
  const entry = capabilities?.capabilities.find((item) => item.id === id);
  return !entry || entry.grade === "unavailable";
}

function lockedWhy(agent: HubAgent): string {
  return isAdvisor(agent) ? "只读" : "read-only";
}

export function capsFor(
  agent: HubAgent | undefined,
  connOnline: boolean,
  capabilities: ClientBootstrap["capabilityManifest"] | undefined,
  hasClient: boolean,
  preview: boolean,
  viewingLive: boolean,
): Caps {
  if (!agent) {
    return {
      open: false,
      openWhy: null,
      chat: false,
      chatWhy: null,
      revive: false,
      reviveWhy: null,
      kill: false,
      killWhy: null,
      release: false,
      releaseWhy: null,
    };
  }
  const dead = agent.status === "aborted";
  const cannotRevive =
    agent.status === "parked" &&
    (agent.isolated === true || agent.canRevive === false);
  const locked = isAdvisor(agent) || agent.readOnly;
  const chatMissing = missingCap(capabilities, "agent.send");
  const reviveMissing = missingCap(capabilities, "agent.revive");
  const killMissing = missingCap(capabilities, "agent.kill");
  const releaseMissing = missingCap(capabilities, "agent.release");
  const hostReady = connOnline && hasClient && viewingLive;
  return {
    open: !dead,
    openWhy: dead ? "已结束" : null,
    chat:
      !locked &&
      !dead &&
      !cannotRevive &&
      !preview &&
      hostReady &&
      !chatMissing,
    chatWhy: locked
      ? lockedWhy(agent)
      : cannotRevive
        ? "隔离或不可恢复的 agent 仅能查看记录"
        : dead
          ? "已结束"
          : preview
            ? CONTRACT.previewWrite
            : !viewingLive
              ? CONTRACT.historicalWrite
              : !hasClient
                ? "无 Studio client"
                : !connOnline
                  ? "未连接"
                  : chatMissing
                    ? CONTRACT.chat
                    : null,
    revive:
      !preview &&
      !locked &&
      !cannotRevive &&
      agent.status === "parked" &&
      hostReady &&
      !reviveMissing,
    reviveWhy: preview
      ? CONTRACT.previewWrite
      : !viewingLive
        ? CONTRACT.historicalWrite
        : locked
          ? lockedWhy(agent)
          : cannotRevive
            ? "隔离或不可恢复的 agent 仅能查看记录"
            : agent.status !== "parked"
              ? "仅 parked"
              : !hasClient
                ? "无 Studio client"
                : !connOnline
                  ? "未连接"
                  : reviveMissing
                    ? CONTRACT.revive
                    : null,
    kill: !preview && !locked && !dead && hostReady && !killMissing,
    killWhy: preview
      ? CONTRACT.previewWrite
      : !viewingLive
        ? CONTRACT.historicalWrite
        : locked
          ? lockedWhy(agent)
          : dead
            ? "已结束"
            : !hasClient
              ? "无 Studio client"
              : !connOnline
                ? "未连接"
                : killMissing
                  ? CONTRACT.kill
                  : null,
    release: !preview && !locked && dead && hostReady && !releaseMissing,
    releaseWhy: preview
      ? CONTRACT.previewWrite
      : !viewingLive
        ? CONTRACT.historicalWrite
        : locked
          ? lockedWhy(agent)
          : !dead
            ? "仅终态"
            : !hasClient
              ? "无 Studio client"
              : !connOnline
                ? "未连接"
                : releaseMissing
                  ? CONTRACT.release
                  : null,
  };
}

import type { ClientBootstrap } from "@omp-studio/client-contract";
import { isZh } from "../../i18n";
import { type Caps, type HubAgent } from "./types";
import { isAdvisor } from "./projection";

export type HubContract = {
  readonly chat: string;
  readonly revive: string;
  readonly kill: string;
  readonly release: string;
  readonly spawn: string;
  readonly cancel: string;
  readonly transcript: string;
  readonly previewWrite: string;
  readonly historicalWrite: string;
};

const CONTRACT_ZH: HubContract = {
  chat: "发送（暂未实现）",
  revive: "Revive（暂未实现）",
  kill: "停止（暂未实现）",
  release: "释放（暂未实现）",
  spawn: "派生（暂未实现）",
  cancel: "取消（暂未实现）",
  transcript: "无 transcript",
  previewWrite: "预览模式",
  historicalWrite: "历史会话只读",
};

const CONTRACT_EN: HubContract = {
  chat: "Send (not available)",
  revive: "Revive (not available)",
  kill: "Stop (not available)",
  release: "Release (not available)",
  spawn: "Spawn (not available)",
  cancel: "Cancel (not available)",
  transcript: "No transcript",
  previewWrite: "Preview mode",
  historicalWrite: "Historical session is read-only",
};

export function contractFor(zh = isZh()): HubContract {
  return zh ? CONTRACT_ZH : CONTRACT_EN;
}

export function missingCap(
  capabilities: ClientBootstrap["capabilityManifest"] | undefined,
  id: string,
): boolean {
  const entry = capabilities?.capabilities.find((item) => item.id === id);
  return !entry || entry.grade === "unavailable";
}

/** What the gate reads from an agent: Hub rows and the Agents deck both satisfy it. */
export type CapsSubject = Pick<HubAgent, "kind" | "status" | "readOnly" | "isolated" | "canRevive">;

function lockedWhy(agent: CapsSubject, zh: boolean): string {
  return isAdvisor(agent) ? (zh ? "只读" : "Read-only") : "read-only";
}

export function capsFor(
  agent: CapsSubject | undefined,
  connOnline: boolean,
  capabilities: ClientBootstrap["capabilityManifest"] | undefined,
  hasClient: boolean,
  preview: boolean,
  viewingLive: boolean,
  zh = isZh(),
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
  const contract = contractFor(zh);
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
  const endedWhy = zh ? "已结束" : "Ended";
  const isolatedWhy = zh ? "隔离或不可恢复的 agent 仅能查看记录" : "Isolated or non-revivable agents are read-only";
  const noClientWhy = zh ? "无 Studio client" : "No Studio client";
  const offlineWhy = zh ? "未连接" : "Disconnected";
  return {
    open: !dead,
    openWhy: dead ? endedWhy : null,
    chat:
      !locked &&
      !dead &&
      !cannotRevive &&
      !preview &&
      hostReady &&
      !chatMissing,
    chatWhy: locked
      ? lockedWhy(agent, zh)
      : cannotRevive
        ? isolatedWhy
        : dead
          ? endedWhy
          : preview
            ? contract.previewWrite
            : !viewingLive
              ? contract.historicalWrite
              : !hasClient
                ? noClientWhy
                : !connOnline
                  ? offlineWhy
                  : chatMissing
                    ? contract.chat
                    : null,
    revive:
      !preview &&
      !locked &&
      !cannotRevive &&
      agent.status === "parked" &&
      hostReady &&
      !reviveMissing,
    reviveWhy: preview
      ? contract.previewWrite
      : !viewingLive
        ? contract.historicalWrite
        : locked
          ? lockedWhy(agent, zh)
          : cannotRevive
            ? isolatedWhy
            : agent.status !== "parked"
              ? (zh ? "仅 parked" : "Parked only")
              : !hasClient
                ? noClientWhy
                : !connOnline
                  ? offlineWhy
                  : reviveMissing
                    ? contract.revive
                    : null,
    kill: !preview && !locked && !dead && hostReady && !killMissing,
    killWhy: preview
      ? contract.previewWrite
      : !viewingLive
        ? contract.historicalWrite
        : locked
          ? lockedWhy(agent, zh)
          : dead
            ? endedWhy
            : !hasClient
              ? noClientWhy
              : !connOnline
                ? offlineWhy
                : killMissing
                  ? contract.kill
                  : null,
    release: !preview && !locked && dead && hostReady && !releaseMissing,
    releaseWhy: preview
      ? contract.previewWrite
      : !viewingLive
        ? contract.historicalWrite
        : locked
          ? lockedWhy(agent, zh)
          : !dead
            ? (zh ? "仅终态" : "Terminal states only")
            : !hasClient
              ? noClientWhy
              : !connOnline
                ? offlineWhy
                : releaseMissing
                  ? contract.release
                  : null,
  };
}

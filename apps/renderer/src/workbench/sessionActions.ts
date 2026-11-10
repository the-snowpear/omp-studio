import type { CommandName, StudioPlanSaveAndQuitResult } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import type { RuntimeSettingsApi } from "../SettingsPage";
import { type ArchivePending } from "./types";

/** Session preferences apply on the next user turn; they must not wait for abort/prompt receipts. */
const LIVE_SESSION_PREFERENCE_COMMANDS = new Set<CommandName>([
  "session.model.set",
  "session.thinking.set",
  "session.taskModel.set",
  "mode.plan.enter",
  "mode.plan.exit",
  "mode.vibe.enter",
  "mode.vibe.exit",
  "goal.create",
  "goal.drop",
  "loop.enable",
  "loop.disable",
  "session.fast.set",
  "session.prewalk.arm",
  "session.prewalk.disarm",
  "session.prewalk.restart",
  "permissions.mode.set",
]);

export function isLiveSessionPreferenceCommand(name: CommandName): boolean {
  return LIVE_SESSION_PREFERENCE_COMMANDS.has(name);
}

/** Compose the optional Runtime settings seam without inventing values for older Runtimes. */
export function runtimeSettingsPropsOf(
  snapshot: OperatorStateSnapshot | undefined,
  canSet: boolean,
  onSet: RuntimeSettingsApi["onSet"] | undefined,
): RuntimeSettingsApi | undefined {
  const hasSnapshot = snapshot?.runtimeSettings !== undefined;
  const hasSpeculation = snapshot?.compactionSpeculation !== undefined;
  if (!hasSnapshot && !hasSpeculation && !(canSet && onSet !== undefined)) return undefined;
  return {
    ...(hasSnapshot ? { snapshot: snapshot.runtimeSettings } : {}),
    ...(snapshot?.runtimeSettingsActivation === undefined ? {} : { activation: snapshot.runtimeSettingsActivation }),
    ...(hasSpeculation ? { compactionSpeculation: snapshot.compactionSpeculation } : {}),
    ...(canSet && onSet !== undefined ? { onSet } : {}),
  };
}

/** Keep the save/exit receipt honest when Runtime could not select the new session. */
export function planSaveAndQuitNotice(result: StudioPlanSaveAndQuitResult, selected: boolean): string {
  const prefix = `已保存 ${result.path}，Plan 已退出`;
  if (result.newSession === "cancelled") return `${prefix}；新会话创建已取消。`;
  if (result.newSession === "failed") return `${prefix}；新会话创建失败，请从历史记录打开。`;
  return selected
    ? `${prefix}；已创建并切换到新会话。`
    : `${prefix}；新会话已创建，但未能自动切换，请从历史记录打开。`;
}

export function canStartPlanSaveAndQuit(canSave: boolean, pending: boolean): boolean {
  return canSave && !pending;
}

export function archiveConfirmIsStreaming(
  pending: ArchivePending,
  live: { readonly sessionId?: string; readonly isStreaming?: boolean } | undefined,
): boolean {
  if (pending.streaming) return true;
  if (pending.kind !== "real") return false;
  return pending.entry.sessionId !== undefined
    && pending.entry.sessionId === live?.sessionId
    && live.isStreaming === true;
}

/** A live provisional row is already openable before the archive catalog sees it. */
export function shouldOpenLiveProvisional(
  provisionalSessionId: string,
  liveSessionId: string | undefined,
): boolean {
  return liveSessionId !== undefined && provisionalSessionId === liveSessionId;
}

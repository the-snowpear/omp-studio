import type { ClientInteraction, ResidentSessionRow } from "@omp-studio/client-contract";
import { isZh } from "../i18n";
import type { PlanState } from "@omp-studio/studio-protocol";
import { residentForSession, type ResidentRows } from "./threadRunning";

/** Sidebar capsule when a thread is blocked on the operator. */
export type ThreadWaitKind = "approval" | "plan" | "ask";

const THREAD_WAIT_LABEL_ZH: Record<ThreadWaitKind, string> = {
  approval: "待确认",
  plan: "待审核",
  ask: "待回答",
};

const THREAD_WAIT_LABEL_EN: Record<ThreadWaitKind, string> = {
  approval: "Needs confirmation",
  plan: "Needs review",
  ask: "Needs answer",
};

export function threadWaitLabel(kind: ThreadWaitKind, zh = isZh()): string {
  return (zh ? THREAD_WAIT_LABEL_ZH : THREAD_WAIT_LABEL_EN)[kind];
}

export const THREAD_WAIT_TONE: Record<ThreadWaitKind, "amber" | "purple" | "blue"> = {
  approval: "amber",
  plan: "purple",
  ask: "blue",
};

export function waitKindFromInteraction(kind: ClientInteraction["kind"]): ThreadWaitKind {
  if (kind === "approval" || kind === "confirm") return "approval";
  return "ask";
}

export function waitKindFromResident(resident: ResidentSessionRow | undefined): ThreadWaitKind | undefined {
  if (resident?.phase !== "waiting") return undefined;
  return resident.waitKind;
}

/**
 * Live session only: the Host snapshot carries at most one pending
 * interaction, plus an optional plan-review state. History rows without a
 * session id stay honest-empty.
 */
export function waitKindFromLive(input: {
  readonly sessionId?: string;
  readonly pending?: Pick<ClientInteraction, "sessionId" | "kind"> | null;
  readonly snapshotSessionId?: string;
  readonly planStatus?: PlanState["status"];
  readonly resident?: ResidentSessionRow;
  readonly residents?: ResidentRows;
}): ThreadWaitKind | undefined {
  const { sessionId, pending, snapshotSessionId, planStatus, resident, residents } = input;
  if (sessionId === undefined) return undefined;
  if (resident !== undefined || residents !== undefined) {
    return waitKindFromResident(resident ?? residentForSession(residents, sessionId));
  }
  if (pending !== null && pending !== undefined && pending.sessionId === sessionId) {
    return waitKindFromInteraction(pending.kind);
  }
  if (snapshotSessionId === sessionId && planStatus === "review") return "plan";
  return undefined;
}

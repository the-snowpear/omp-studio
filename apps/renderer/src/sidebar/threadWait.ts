import type { ClientInteraction, ResidentSessionRow } from "@omp-studio/client-contract";
import type { PlanState } from "@omp-studio/studio-protocol";
import { residentForSession, type ResidentRows } from "./threadRunning";

/** Sidebar capsule when a thread is blocked on the operator. */
export type ThreadWaitKind = "approval" | "plan" | "ask";

export const THREAD_WAIT_LABEL: Record<ThreadWaitKind, string> = {
  approval: "待确认",
  plan: "待审核",
  ask: "待回答",
};

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

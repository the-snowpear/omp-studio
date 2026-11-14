export type RatchetStage = "inputs" | "grader" | "plan";
export interface RatchetRoundView { round: number; variant: string; change: string; decision: "baseline" | "keep" | "revert" | "rerun"; reasons: string[]; train: number | null; test: number | null; at: string; }
export interface RatchetRunView { id: string; flow: string; workspace: string; state: "ready" | "running" | "stopped" | "completed" | "failed" | "interrupted"; createdAt: number; roundsLimit: number; costLimit: number; modelCost: number; agentId?: string; error?: string; approvals: Record<RatchetStage, string>; rounds: RatchetRoundView[]; best?: string; goal?: string; command?: string; cases: string[]; harness: string[]; change: string[]; offLimits: string[]; trainCount: number; testCount: number; }
export type RatchetOperation =
 | { kind: "ratchet.list"; sessionId: string }
 | { kind: "ratchet.read"; sessionId: string; id: string }
 | { kind: "ratchet.create"; sessionId: string; flow: string; cases: string[]; harness: string[]; change: string[]; offLimits: string[]; command: string; cohorts: Record<string, string>; metric: string; direction: "higher" | "lower"; reps: number; roundsLimit: number; costLimit: number }
 | { kind: "ratchet.approve"; sessionId: string; id: string; stage: RatchetStage }
 | { kind: "ratchet.start"; sessionId: string; id: string }
 | { kind: "ratchet.stop"; sessionId: string; id: string };
export interface RatchetResultMap { "ratchet.list": { runs: RatchetRunView[] }; "ratchet.read": RatchetRunView; "ratchet.create": RatchetRunView; "ratchet.approve": { approved: boolean; run: RatchetRunView }; "ratchet.start": RatchetRunView; "ratchet.stop": RatchetRunView; }
export const RATCHET_OPERATION_KINDS = ["ratchet.list", "ratchet.read", "ratchet.create", "ratchet.approve", "ratchet.start", "ratchet.stop"] as const;
export function isRatchetKind(kind: string): kind is RatchetOperation["kind"] { return (RATCHET_OPERATION_KINDS as readonly string[]).includes(kind); }

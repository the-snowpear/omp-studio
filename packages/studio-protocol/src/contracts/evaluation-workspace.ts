import type { StudioPendingInteraction } from "./interactions.js";

export type EvaluationKind = "benchmark" | "instruction" | "judgment" | "ratchet";
export type EvaluationState =
  | "preparing"
  | "ready"
  | "running"
  | "cancelling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface PerformanceEvaluationSpec {
  kind: "benchmark";
  models: string[];
  profile: "chat" | "prefill" | "generation" | "mix" | "cache" | "detailed";
  runs?: number;
  concurrency?: number;
  maxTokens?: number;
  prompt?: string;
  prefillBytes?: number;
  cachePrefixBytes?: number;
  cachePrefixFile?: string;
  cachePrefixContent?: string;
  serviceTier?: string;
}
export interface InstructionEvaluationSpec {
  kind: "instruction";
  models: string[];
  turns?: number;
  length?: number;
  maxTokens?: number;
  nyaMax?: number;
  concurrency?: number;
}
export type EvaluationQuestion =
  | { type: "bool"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
export interface JudgmentEvaluationSpec {
  kind: "judgment";
  items: Array<{ key: string | number; state: string | object; images?: string[] }>;
  questions: Record<string, EvaluationQuestion>;
  concurrency?: number;
  retries?: number;
  minOk?: number;
  judgeModel?: string;
  attachId?: string;
  attachSessionId?: string;
}
export interface RatchetEvaluationSpec {
  kind: "ratchet";
  flow: string;
  objective: string;
  cases: string[];
  harness: string[];
  change: string[];
  offLimits: string[];
  command: string;
  cohorts: Record<string, string>;
  metric: string;
  direction: "higher" | "lower";
  hold?: string[];
  directions?: Record<string, "higher" | "lower">;
  reps?: number;
  plateau?: number;
  roundsLimit?: number;
  costLimit?: number;
  testFraction?: number;
  seed?: number;
  prices?: Record<string, { in: number; out: number; cache_read?: number; cache_write?: number }>;
  assist?: boolean;
}
export type EvaluationSpec =
  | PerformanceEvaluationSpec
  | InstructionEvaluationSpec
  | JudgmentEvaluationSpec
  | RatchetEvaluationSpec;
export interface EvaluationPlan {
  spec: EvaluationSpec;
  requests: number | null;
  upperBound: boolean;
  phases: Array<{ name: string; requests: number; concurrency: number; maxTokens?: number }>;
  notes: string[];
  resolvedModels?: string[];
  settings?: Record<string, unknown>;
}
/** Metrics are native report values. Missing values stay null, never synthetic zeroes. */
export interface EvaluationMetricRow {
  id: string;
  label: string;
  state: string;
  completed: number;
  total: number;
  failed: number;
  metrics: Record<string, number | null>;
  detail?: Record<string, unknown>;
}
export interface EvaluationResultRow {
  key: string;
  model?: string;
  phase?: string;
  data: unknown;
}
export interface EvaluationResultPage {
  rows: EvaluationResultRow[];
  offset: number;
  nextOffset: number;
  total: number;
}
export interface EvaluationNativeSnapshot {
  state: EvaluationState;
  completed: number;
  total: number;
  failed: number;
  cost: number | null;
  metrics: EvaluationMetricRow[];
  detail: Record<string, unknown>;
  error?: string;
  revision: number;
}
export interface EvaluationRecord extends EvaluationNativeSnapshot {
  id: string;
  workspaceId: string;
  title: string;
  spec: EvaluationSpec;
  plan?: EvaluationPlan;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  runtimeVersion?: string;
  sessionId?: string;
  sourceId?: string;
  saveError?: string;
  replayable?: boolean;
  legacyArtifactIds?: string[];
  interaction?: StudioPendingInteraction;
}
export interface EvaluationListInput {
  workspaceId?: string;
  kind?: EvaluationKind;
  search?: string;
  offset?: number;
  limit?: number;
}
export interface EvaluationListResult {
  records: EvaluationRecord[];
  total: number;
}
export interface EvaluationStartInput {
  workspaceId: string;
  title: string;
  spec: EvaluationSpec;
  sourceId?: string;
}
export type EvaluationControlAction =
  | "cancel"
  | "start"
  | "approve"
  | "configure"
  | "pilot"
  | "retry";
export interface EvaluationControlInput {
  id: string;
  action: EvaluationControlAction;
  stage?: "inputs" | "grader" | "plan";
  spec?: RatchetEvaluationSpec;
}
export interface EvaluationExportInput {
  id: string;
  format: "json" | "csv" | "html" | "patch";
}
export interface EvaluationExportResult {
  artifactId: string;
  name: string;
}
export interface EvaluationContext {
  available: boolean;
  reason?: string;
  models: Array<{ selector: string; name: string; provider: string; kind: string; image: boolean }>;
  runtimeVersion?: string;
}

/** Internal native operations; the Host binds these to the evaluation's resident Worker. */
export type EvaluationWorkspaceOperation =
  | { kind: "evaluation.runtime.plan"; spec: EvaluationSpec }
  | { kind: "evaluation.runtime.start"; id: string; title: string; spec: EvaluationSpec }
  | { kind: "evaluation.runtime.read"; id: string }
  | { kind: "evaluation.runtime.rows"; id: string; offset?: number; limit?: number }
  | {
      kind: "evaluation.runtime.control";
      id: string;
      action: EvaluationControlAction;
      stage?: "inputs" | "grader" | "plan";
      spec?: RatchetEvaluationSpec;
    }
  | { kind: "evaluation.runtime.report"; id: string; offset?: number }
  | { kind: "evaluation.runtime.patch"; id: string; offset?: number };
export interface EvaluationWorkspaceResultMap {
  "evaluation.runtime.plan": EvaluationPlan;
  "evaluation.runtime.start": EvaluationNativeSnapshot;
  "evaluation.runtime.read": EvaluationNativeSnapshot;
  "evaluation.runtime.rows": EvaluationResultPage;
  "evaluation.runtime.control": EvaluationNativeSnapshot;
  "evaluation.runtime.report": { text: string; nextOffset: number; total: number };
  "evaluation.runtime.patch": { text: string; nextOffset: number; total: number };
}
export const EVALUATION_WORKSPACE_KINDS = [
  "evaluation.runtime.plan",
  "evaluation.runtime.start",
  "evaluation.runtime.read",
  "evaluation.runtime.rows",
  "evaluation.runtime.control",
  "evaluation.runtime.report",
  "evaluation.runtime.patch",
] as const;
export const isEvaluationWorkspaceKind = (
  kind: string,
): kind is EvaluationWorkspaceOperation["kind"] =>
  (EVALUATION_WORKSPACE_KINDS as readonly string[]).includes(kind);
export const evaluationTerminal = (state: EvaluationState): boolean =>
  ["completed", "partial", "failed", "cancelled", "interrupted"].includes(state);

/** Rendering/export helpers operate on the same recorded values. */
export function evaluationComparable(a: EvaluationRecord, b: EvaluationRecord): boolean {
  const comparable = (spec: EvaluationSpec): unknown => {
    if (spec.kind === "benchmark" || spec.kind === "instruction") {
      const { models: _models, ...settings } = spec;
      return settings;
    }
    if (spec.kind === "judgment") {
      const {
        judgeModel: _judge,
        attachId: _attach,
        attachSessionId: _session,
        ...settings
      } = spec;
      return settings;
    }
    const { flow: _flow, assist: _assist, objective: _objective, ...settings } = spec;
    return settings;
  };
  return (
    a.spec.kind === b.spec.kind &&
    a.runtimeVersion === b.runtimeVersion &&
    canonicalEvaluationConfig(a.plan?.settings) === canonicalEvaluationConfig(b.plan?.settings) &&
    canonicalEvaluationConfig(comparable(a.spec)) === canonicalEvaluationConfig(comparable(b.spec))
  );
}

export function canonicalEvaluationConfig(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalEvaluationConfig).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalEvaluationConfig(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

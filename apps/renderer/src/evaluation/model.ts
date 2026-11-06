import type { EvaluationKind, EvaluationSpec, EvaluationRecord } from "@omp-studio/studio-protocol";

export const EVALUATION_KINDS: EvaluationKind[] = [
  "benchmark",
  "instruction",
  "judgment",
  "ratchet",
];
export const evaluationNames = (zh: boolean): Record<EvaluationKind, string> => ({
  benchmark: zh ? "性能基准" : "Performance",
  instruction: zh ? "指令遵循" : "Instruction following",
  judgment: zh ? "模型评判" : "Judgments",
  ratchet: "Ratchet",
});
export const evaluationDescriptions = (zh: boolean): Record<EvaluationKind, string> => ({
  benchmark: zh
    ? "比较响应速度、吞吐与缓存表现。"
    : "Compare latency, throughput and prompt caching.",
  instruction: zh
    ? "测量模型在连续任务中的指令遵循与工作记忆。"
    : "Measure instruction following and working memory across turns.",
  judgment: zh
    ? "用明确的标准评判文本、结构化内容与图片。"
    : "Evaluate text, structured content and images against explicit criteria.",
  ratchet: zh
    ? "以可信的评测迭代改进，保留在留出集上成立的变化。"
    : "Iterate against a trusted evaluation and keep changes that hold up on unseen cases.",
});
export function emptyEvaluation(kind: EvaluationKind): EvaluationSpec {
  if (kind === "benchmark") return { kind, models: [], profile: "chat" };
  if (kind === "instruction") return { kind, models: [] };
  if (kind === "judgment")
    return { kind, items: [], questions: { q1: { type: "bool", instructions: "" } } };
  return {
    kind,
    flow: "",
    objective: "",
    cases: [],
    harness: [],
    change: [],
    offLimits: [],
    command: "",
    cohorts: {},
    metric: "score",
    direction: "higher",
  };
}
export const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const displayNumber = (value: unknown, digits = 1): string =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "—";
export function configDifferences(
  a: EvaluationRecord,
  b: EvaluationRecord,
): Array<{ field: string; before: string; after: string }> {
  const left = {
      ...a.spec,
      effectiveSettings: a.plan?.settings,
      runtime: a.runtimeVersion,
    } as Record<string, unknown>,
    right = { ...b.spec, effectiveSettings: b.plan?.settings, runtime: b.runtimeVersion } as Record<
      string,
      unknown
    >;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => ({
      field: key,
      before: JSON.stringify(left[key]) ?? "—",
      after: JSON.stringify(right[key]) ?? "—",
    }));
}

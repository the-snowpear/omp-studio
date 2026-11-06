import type {
  EvaluationSpec,
  EvaluationRecord,
  EvaluationPlan,
  EvaluationResultRow,
  EvaluationContext,
} from "@omp-studio/studio-protocol";
import { PREVIEW_RATCHET } from "./ratchetPreview";
import { PREVIEW_JUDGMENT_SPEC } from "./judgmentsPreview";
import { PREVIEW_BENCHMARK } from "./benchmarksPreview";

export function previewEvaluationPlan(spec: EvaluationSpec): EvaluationPlan {
  if (spec.kind === "benchmark") {
    const runs =
      spec.runs ??
      (spec.profile === "cache"
        ? 1
        : spec.profile === "detailed"
          ? 4
          : spec.profile === "chat"
            ? 10
            : spec.profile === "mix"
              ? 9
              : 5);
    const concurrency = spec.concurrency ?? (spec.profile === "cache" ? 1 : 4);
    const phases =
      spec.profile === "detailed"
        ? [
            { name: "single", requests: runs, concurrency: 1, maxTokens: spec.maxTokens ?? 512 },
            {
              name: "parallel",
              requests: Math.ceil(runs / concurrency) * concurrency,
              concurrency,
              maxTokens: spec.maxTokens ?? 512,
            },
            { name: "prefill", requests: runs, concurrency: 1, maxTokens: spec.maxTokens ?? 64 },
          ]
        : [
            {
              name: spec.profile,
              requests: runs * (spec.profile === "cache" ? 2 : 1),
              concurrency,
              maxTokens:
                spec.maxTokens ??
                (spec.profile === "generation"
                  ? 2048
                  : ["prefill", "cache"].includes(spec.profile)
                    ? 64
                    : 512),
            },
          ];
    return {
      spec,
      requests: phases.reduce((sum, p) => sum + p.requests, 0) * spec.models.length,
      upperBound: false,
      phases,
      notes: [],
    };
  }
  if (spec.kind === "instruction")
    return {
      spec,
      requests: (spec.turns ?? 24) * spec.models.length,
      upperBound: true,
      phases: [
        {
          name: "instruction",
          requests: spec.turns ?? 24,
          concurrency: spec.concurrency ?? 4,
          maxTokens: spec.maxTokens ?? 32768,
        },
      ],
      notes: [],
    };
  return { spec, requests: null, upperBound: true, phases: [], notes: [] };
}
export const EVALUATION_PREVIEW_CONTEXT: EvaluationContext = {
  available: true,
  runtimeVersion: "18.13.2",
  models: PREVIEW_BENCHMARK.run.spec.models.map((selector) => ({
    selector,
    name: selector.split("/").at(-1)!,
    provider: selector.split("/")[0]!,
    kind: "chat",
    image: true,
  })),
};
export function previewEvaluation(
  spec: EvaluationSpec,
  title: string,
  id = crypto.randomUUID(),
): EvaluationRecord {
  const base = {
    id,
    workspaceId: "preview",
    title,
    spec,
    plan: previewEvaluationPlan(spec),
    createdAt: "2026-11-01T02:30:00Z",
    updatedAt: "2026-11-01T02:31:22Z",
    runtimeVersion: "18.13.2",
    revision: 1,
    cost: 0.024,
    failed: 0,
    completed: 0,
    total: 0,
    metrics: [],
    detail: {},
  };
  if (spec.kind === "benchmark") {
    const total = (base.plan.requests ?? 0) / Math.max(1, spec.models.length);
    return {
      ...base,
      state: "completed",
      completed: total * spec.models.length,
      total: total * spec.models.length,
      metrics: spec.models.map((model, i) => ({
        id: model,
        label: model,
        state: "done",
        completed: total,
        total,
        failed: 0,
        detail: {
          stats: PREVIEW_BENCHMARK.models[i % PREVIEW_BENCHMARK.models.length]!.stats,
          byChallenge: Object.fromEntries(["chat", "prefill", "generation"].map(name => [name, PREVIEW_BENCHMARK.models[i % PREVIEW_BENCHMARK.models.length]!.stats])),
          phases: Object.fromEntries(base.plan.phases.map(phase => [phase.name, { ...phase, runs: phase.requests, wallMs: 2500, aggregateTps: phase.name === "parallel" ? 380 - i * 90 : 120 - i * 45, stats: PREVIEW_BENCHMARK.models[i % PREVIEW_BENCHMARK.models.length]!.stats }])),
        },
        metrics: {
          ttft: 240 + i * 340,
          ttftP95: 288 + i * 408,
          prefill: 4000 - i * 250,
          decode: 144 - i * 54,
          throughput: 120 - i * 45,
          cost: 0.002 + i * 0.001,
          "single.aggregateTps": 120 - i * 45,
          "parallel.aggregateTps": 380 - i * 90,
          "parallel.ttft": 330 + i * 410,
          "prefill.prefill": 4000 - i * 250,
          scaling: 3.16 - i * 0.2,
          ...(spec.profile === "cache" ? { "cold.ttft": 580 + i * 200, "warm.ttft": 240 + i * 100, cacheProof: spec.runs ?? 1, prewarmed: 0 } : {}),
        },
      })),
    };
  }
  if (spec.kind === "instruction")
    return {
      ...base,
      state: "completed",
      completed: spec.models.reduce((sum, _, i) => sum + Math.min(spec.turns ?? 24, i ? 13 : Infinity), 0),
      total: (spec.turns ?? 24) * spec.models.length,
      failed: (spec.turns ?? 24) >= 13 ? Math.max(0, spec.models.length - 1) : 0,
      metrics: spec.models.map((model, i) => ({
        id: model,
        label: model,
        state: i ? "failed" : "completed",
        completed: Math.min(spec.turns ?? 24, i ? 13 : Infinity),
        total: spec.turns ?? 24,
        failed: i ? 1 : 0,
        metrics: {
          turnsPassed: Math.min(spec.turns ?? 24, i ? 12 : Infinity),
          actionsPassed: Math.min(spec.turns ?? 24, i ? 12 : Infinity) * (Math.min(spec.turns ?? 24, i ? 12 : Infinity) + 1) / 2,
          durationMs: 41500,
          outputTokens: 1560,
          cost: 0.012,
        },
        detail: i ? { failure: { kind: "array", turn: 13 } } : {},
      })),
    };
  if (spec.kind === "judgment")
    return {
      ...base,
      state: "completed",
      completed: spec.items.length,
      total: spec.items.length,
      metrics: Object.entries(spec.questions).map(([id, question]) => ({ id, label: id, state: "completed", completed: spec.items.length, total: spec.items.length, failed: 0,
        metrics: { mean: question.type === "bool" ? .95 : question.type === "score" ? 1.8 : null, confidence: question.type === "bool" ? null : .94, answered: spec.items.length }, detail: { question } })),
      detail: {
        questions: spec.questions,
        model: EVALUATION_PREVIEW_CONTEXT.models[0]?.selector,
        elapsedS: 3.8,
      },
    };
  return {
    ...base,
    state: "ready",
    completed: 2,
    total: spec.roundsLimit ?? 8,
    cost: PREVIEW_RATCHET.modelCost,
    metrics: PREVIEW_RATCHET.rounds.map((r) => ({
      id: r.variant,
      label: r.variant,
      state: r.decision,
      completed: 1,
      total: 1,
      failed: 0,
      metrics: { train: r.train, test: r.test, trainHalf: 0.025, testHalf: 0.041 },
      detail: { change: r.change, reasons: r.reasons },
    })),
    detail: {
      approvals: PREVIEW_RATCHET.approvals,
      best: { variant: "v1" },
      workspace: PREVIEW_RATCHET.workspace,
      nativeState: {
        goal: { target: "score", hold: ["cost_usd"] },
        train_ids: Array(60).fill("case"),
        test_ids: Array(40).fill("case"),
      },
      patchAvailable: true,
      bestPatchVariant: "v1",
    },
  };
}
export function previewEvaluationRecords(): EvaluationRecord[] {
  const models = EVALUATION_PREVIEW_CONTEXT.models.map((m) => m.selector);
  const ratchet = PREVIEW_RATCHET;
  const records = [
    previewEvaluation(
      { kind: "benchmark", profile: "detailed", models, runs: 4, concurrency: 4 },
      "模型性能对比",
      "10f1e6e2-bcef-4acf-8756-48ed87f2a001",
    ),
    previewEvaluation(
      { kind: "instruction", models },
      "连续指令测试",
      "10f1e6e2-bcef-4acf-8756-48ed87f2a002",
    ),
    previewEvaluation(
      { kind: "judgment", ...PREVIEW_JUDGMENT_SPEC },
      "支持工单分类",
      "10f1e6e2-bcef-4acf-8756-48ed87f2a003",
    ),
    previewEvaluation(
      {
        kind: "ratchet",
        flow: ratchet.flow,
        objective: "提高支持工单路由准确率",
        cases: ratchet.cases,
        harness: ratchet.harness,
        change: ratchet.change,
        offLimits: ratchet.offLimits,
        command: ratchet.command ?? "",
        cohorts: { c1: "billing", c2: "technical", c3: "billing", c4: "technical" },
        metric: "score",
        direction: "higher",
        costLimit: 5,
        roundsLimit: 8,
      },
      "支持工单路由优化",
      "10f1e6e2-bcef-4acf-8756-48ed87f2a004",
    ),
  ];
  const scenario = new URLSearchParams(globalThis.location?.search ?? "").get("evaluationScenario");
  if (scenario === "empty") return [];
  if (scenario === "running")
    return records.map((record) => ({
      ...record,
      state: "running",
      completed: Math.floor(record.total / 3),
    }));
  if (scenario === "partial")
    return records.map((record) => ({ ...record, state: "partial", failed: 1 }));
  if (scenario === "failed")
    return records.map((record) => ({
      ...record,
      state: "failed",
      failed: record.total,
      error: "Provider request failed. Review the configuration before retrying.",
    }));
  if (scenario === "interrupted")
    return records.map((record) => ({
      ...record,
      state: "interrupted",
      error: "Runtime disconnected. Recorded results are retained.",
    }));
  return records;
}
export function previewEvaluationRows(record: EvaluationRecord): EvaluationResultRow[] {
  const spec = record.spec;
  if (spec.kind === "judgment")
    return spec.items.map((item, i) => ({
      key: String(item.key),
      model: EVALUATION_PREVIEW_CONTEXT.models[0]!.selector,
      data: {
        key: item.key,
        answers: Object.fromEntries(
          Object.entries(spec.questions).map(([key, q]) => [
            key,
            q.type === "bool"
              ? { type: "bool", bool: 0.97 - i * 0.02 }
              : q.type === "choice"
                ? {
                    type: "choice",
                    choice: Object.keys(q.criteria)[i % Object.keys(q.criteria).length],
                    confidence: 0.94,
                    probabilities: Object.fromEntries(
                      Object.keys(q.criteria).map((k, j) => [
                        k,
                        j === i % Object.keys(q.criteria).length ? 0.94 : 0.06,
                      ]),
                    ),
                  }
                : {
                    type: "score",
                    score: 1.8,
                    confidence: 0.9,
                    probabilities: { "0": 0.01, "1": 0.18, "2": 0.81 },
                  },
          ]),
        ),
      },
    }));
  if (spec.kind === "instruction")
    return spec.models.flatMap((model, i) =>
      Array.from({ length: Math.min(spec.turns ?? 24, i ? 13 : Infinity) }, (_, index) => ({
        key: `${model}:${index + 1}`,
        model,
        data: {
          turn: index + 1,
          actions: index + 1,
          passed: !(i && index === 12),
          expected: "ABCDEF…",
          response: i && index === 12 ? "ACBDEF… nya" : "ABCDEF… nya",
          durationMs: 1580,
          cost: 0.0008,
          ...(i && index === 12 ? { failure: "array" } : {}),
        },
      })),
    );
  if (spec.kind === "ratchet")
    return PREVIEW_RATCHET.rounds.map((round) => ({
      key: round.variant,
      data: {
        ...round,
        train: { score: { mean: round.train, half: 0.025, n: 60 } },
        test: { score: { mean: round.test, half: 0.041, n: 40 } },
      },
    }));
  return spec.models.flatMap((model) =>
    Array.from({ length: spec.profile === "cache" ? spec.runs ?? 1 : (previewEvaluationPlan(spec).requests ?? 0) / Math.max(1, spec.models.length) }, (_, i) => ({
      key: `${model}:${i}`,
      model,
      phase: spec.profile === "cache" ? "cache" : spec.profile === "detailed" ? i < (spec.runs ?? 4) ? "single" : i < 2 * (spec.runs ?? 4) ? "parallel" : "prefill" : "single",
      data:
        spec.profile === "cache"
          ? {
              coldAlreadyWarm: false,
              cold: {
                phase: "cold",
                observations: ["prompt_cache_write_observed"],
                result: { ok: true, ttftMs: 580 },
                usage: { cacheReadTokens: 0, cacheWriteTokens: 8192 },
              },
              warm: {
                phase: "warm",
                observations: ["prompt_cache_read_observed"],
                result: { ok: true, ttftMs: 240 },
                usage: { cacheReadTokens: 8192, cacheWriteTokens: 0 },
              },
            }
          : {
              ok: true,
              challenge: "chat",
              ttftMs: 240 + i * 20,
              generationTps: 144 - i,
              inputTokens: 327,
              outputTokens: 512,
              cost: 0.002,
            },
    })),
  );
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJudgmentBatchSpec, validateJudgmentResult } from "../src/contracts/judgments.js";
import { validateWorkbenchOperation } from "../src/contracts/workbench.js";

const spec = { intent: "Review", items: [{ key: "one", state: "Check" }], questions: { clear: { type: "bool", instructions: "Is it clear?" } }, concurrency: 4, retries: 1, minOk: 1 };
test("judgment input rejects ambiguous keys, unsafe records and unbounded paid requests", () => {
  validateJudgmentBatchSpec(spec);
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, items: [{ key: 1, state: "a" }, { key: "1", state: "b" }] }));
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, items: Array.from({ length: 501 }, (_, key) => ({ key, state: "x" })) }));
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, retries: 6 }));
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, concurrency: 33 }));
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, questions: JSON.parse('{"__proto__":{"type":"bool","instructions":"x"}}') }));
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, items: [{ key: "a", state: { nested: Infinity } }] }));
  assert.throws(() => validateJudgmentBatchSpec({ ...spec, items: Array.from({ length: 30 }, (_, key) => ({ key, state: "x".repeat(30000) })) }));
});
test("judgment commands are session fenced and observer results preserve cursor accounting", () => {
  for (const kind of ["judgments.list", "judgments.read", "judgments.cancel", "judgments.retry", "judgments.close"]) {
    assert.throws(() => validateWorkbenchOperation({ kind, id: "batch" }));
  }
  validateWorkbenchOperation({ kind: "judgments.read", sessionId: "s", id: "batch", offset: 0, limit: 25 });
  const batch = { id: "batch", intent: "Review", total: 2, done: 1, failed: 0, cost: 0.01, elapsedS: 1, running: true };
  const page = { batch, items: [{ key: "one", answers: { clear: { type: "bool", bool: 0.9 } } }], offset: 0, nextOffset: 1 };
  validateJudgmentResult("judgments.read", page);
  assert.throws(() => validateJudgmentResult("judgments.read", { ...page, nextOffset: 2 }));
  assert.throws(() => validateJudgmentResult("judgments.read", { ...page, batch: { ...batch, apiKey: "secret" } }));
  assert.throws(() => validateJudgmentResult("judgments.read", { ...page, items: [{ key: "one", answers: { clear: { type: "bool", bool: 2 } } }] }));
});

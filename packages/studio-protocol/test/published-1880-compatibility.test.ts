import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFoundationStudioRequest } from "../src/index.js";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/contracts/workbench.js";

test("published IDA status and detailed detection retain separate result contracts", () => {
  const published = { available: false, reason: "IDA not installed", databases: [] };
  const detailed = { ...published, enabled: true, installDir: "", python: "" };
  for (const kind of ["ida.status", "ida.status.details"]) {
    assert.doesNotThrow(() => validateWorkbenchOperation({ kind, sessionId: "s" }));
  }
  assert.doesNotThrow(() => validateWorkbenchResult("ida.status", published));
  assert.doesNotThrow(() => validateWorkbenchResult("ida.status.details", detailed));
  assert.throws(() => validateWorkbenchResult("ida.status", detailed));
  assert.throws(() => validateWorkbenchResult("ida.status.details", published));
  assert.doesNotThrow(() => validateWorkbenchOperation({ kind: "ida.cancel", sessionId: "s" }));
  assert.doesNotThrow(() => validateWorkbenchOperation({ kind: "ida.database.cancel", sessionId: "s", id: "db" }));
  assert.throws(() => validateWorkbenchOperation({ kind: "ida.cancel", sessionId: "s", id: "db" }));
  assert.throws(() => validateWorkbenchOperation({ kind: "ida.database.cancel", sessionId: "s" }));
});

test("published queue removal keeps its result and the new operation requires the queue identity", () => {
  const legacy = { kind: "session.queue.remove", sessionId: "s", id: "entry" };
  const modern = { ...legacy, kind: "session.queue.entry.remove", queue: "followUp" };
  assert.doesNotThrow(() => validateWorkbenchOperation(legacy));
  assert.doesNotThrow(() => validateWorkbenchOperation(modern));
  assert.throws(() => validateWorkbenchOperation({ ...legacy, queue: "followUp" }));
  assert.throws(() => validateWorkbenchOperation({ ...modern, queue: undefined }));
  assert.doesNotThrow(() => validateWorkbenchResult("session.queue.remove", { removed: true }));
  const snapshot = { entries: [], total: 0, truncated: false };
  assert.doesNotThrow(() => validateWorkbenchResult("session.queue.entry.remove", snapshot));
  assert.throws(() => validateWorkbenchResult("session.queue.entry.remove", { removed: true }));
  assert.throws(() => validateWorkbenchResult("session.queue.remove", snapshot));
});

test("spawn accepts the published solution space together with the new model chain", () => {
  const operation = {
    kind: "agent.spawn", definition: "researcher", assignment: "Review the patch",
    solutionSpace: "Only the parser", model: ["provider/model-a", "provider/model-b"],
  };
  const parse = (value: unknown) => parseFoundationStudioRequest({
    type: "studio.request", requestId: "compatibility", runtimeEpoch: 1, operation: value,
  });
  assert.doesNotThrow(() => parse(operation));
  for (const model of [[], [""] , Array(9).fill("provider/model"), ["provider/model\u0000"]]) {
    assert.throws(() => parse({ ...operation, model }));
  }
  assert.throws(() => parse({ ...operation, solutionSpace: "" }));
});

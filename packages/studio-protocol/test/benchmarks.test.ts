import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBenchmarkSpec, validateBenchmarkOperation } from "../src/contracts/benchmarks.js";
import { validateRuntimeCatalogOperation, validateRuntimeCatalogResult } from "../src/contracts/runtime-catalog.js";
test("benchmark workloads enforce request/concurrency limits before any paid work", () => {
  const spec = { models: ["mock/chat"], profile: "mix", runs: 3, concurrency: 1, prefillBytes: 1024 };
  validateBenchmarkSpec(spec);
  assert.throws(() => validateBenchmarkSpec({ ...spec, models: ["chat"] }));
  assert.throws(() => validateBenchmarkSpec({ ...spec, models: ["mock/chat", "mock/chat"] }));
  assert.throws(() => validateBenchmarkSpec({ ...spec, runs: 21 }));
  assert.throws(() => validateBenchmarkSpec({ ...spec, concurrency: 9 }));
  assert.throws(() => validateBenchmarkSpec({ ...spec, prompt: "custom" }));
  assert.throws(() => validateBenchmarkOperation({ kind: "benchmarks.cancel", id: "bench" }));
});
test("Runtime catalog uses explicit versions and rejects configuration or credential leakage", () => {
  assert.throws(() => validateRuntimeCatalogOperation({ kind: "templates.prepare", sessionId: "s", id: "template", arguments: "x" }));
  validateRuntimeCatalogOperation({ kind: "templates.prepare", sessionId: "s", id: "template", version: "a".repeat(64), arguments: "x" });
  const status = { available: true, ready: false, settled: false, startupTimeoutMs: 250, total: 1, servers: [{ name: "server", state: "pending", tools: 0 }] };
  validateRuntimeCatalogResult("mcp.runtime.status", status);
  assert.throws(() => validateRuntimeCatalogResult("mcp.runtime.status", { ...status, servers: [{ ...status.servers[0], config: { token: "secret" } }] }));
});

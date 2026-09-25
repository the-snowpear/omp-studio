import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/contracts/workbench.js";

test("annotations reject broken anchors, ambiguous sources and oversized wire payloads", () => {
  const source = { id: "source", kind: "quote", label: "Reply", text: "A😀B", version: "sha256:" + "a".repeat(64) };
  const operation = { kind: "annotations.prepare", sources: [source], notes: [{ id: "note", sourceId: "source", note: "Check", selection: { start: 1, end: 3 } }], action: "feedback" };
  validateWorkbenchOperation(operation);
  assert.throws(() => validateWorkbenchOperation({ ...operation, sources: [source, source] }));
  assert.throws(() => validateWorkbenchOperation({ ...operation, notes: [{ ...operation.notes[0], selection: { start: 2, end: 5 } }] }));
  assert.throws(() => validateWorkbenchOperation({ ...operation, notes: [{ ...operation.notes[0], sourceId: "missing" }] }));
  assert.throws(() => validateWorkbenchResult("annotations.prepare", { prompt: "字".repeat(300000), staleSources: [] }));
});

test("service controls require an instance fence and workspace-relative directories", () => {
  for (const kind of ["services.stop", "services.restart", "services.send", "services.mode.set", "services.logs"]) {
    assert.throws(() => validateWorkbenchOperation({ kind, name: "server" }));
  }
  for (const cwd of ["../other", "D:\\outside", "/outside", "child/../../outside"]) {
    assert.throws(() => validateWorkbenchOperation({ kind: "services.start", spec: { name: "server", command: "npm start", cwd } }));
  }
  validateWorkbenchOperation({ kind: "services.start", spec: { name: "server", command: "npm start", cwd: "apps/server", ready: { port: 3000, timeoutMs: 30000 } } });
  assert.throws(() => validateWorkbenchOperation({ kind: "services.start", spec: { name: "server", command: "npm start", env: JSON.parse('{"__proto__":"injected"}') } }));
});
test("native catalog pagination remains bounded and rejects leaked private fields", () => {
  validateWorkbenchOperation({ kind: "runtime.models.list", modelKind: "image", cursor: "provider/model", limit: 100 });
  assert.throws(() => validateWorkbenchOperation({ kind: "runtime.models.list", limit: 201 }));
  const model = { selector: "p/image", provider: "p", name: "Image", kind: "image", image: true, reasoning: false };
  validateWorkbenchResult("runtime.models.list", { models: [model], total: 1 });
  assert.throws(() => validateWorkbenchResult("runtime.models.list", { models: [{ ...model, apiKey: "secret" }], total: 1 }));
  assert.throws(() => validateWorkbenchResult("services.list", { enabled: true, services: [{ name: "server", instanceId: "id", state: "running", startedAt: 1, restartCount: 0, outputBytes: 0, mode: "session", pid: 123 }] }));
});

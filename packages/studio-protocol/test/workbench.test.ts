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
  assert.throws(() => validateWorkbenchResult("services.list", { enabled: true, services: [{ name: "server", instanceId: "id", state: "running", startedAt: 1, restartCount: 0, outputBytes: 0, mode: "session", command: "npm start" }] }));
});
test("service rows carry the 0.2.0 owner, pid and preview fields the Runtime projects", () => {
  // Regression: these fields were added to StudioServiceRow and projectService
  // but not to the allow-list, so any owned or running service failed the
  // whole services.list result every poll ("Runtime command failed").
  const row = { name: "web", instanceId: "id:1", state: "running", startedAt: 1, readyAt: 2, restartCount: 0, outputBytes: 10, pid: 4242, previewUrl: "http://localhost:4100/?view=main", ownerId: "session-1", ownerAgentId: "session-1", mode: "session" };
  validateWorkbenchResult("services.list", { enabled: true, services: [row] });
  validateWorkbenchResult("services.restart", { service: row });
  const exited = { name: "old", instanceId: "id:2", state: "exited", startedAt: 1, exitedAt: 3, exitCode: 1, restartCount: 0, outputBytes: 0, ownerId: "session-0", ownerAgentId: "session-0", mode: "session" };
  validateWorkbenchResult("services.list", { enabled: true, services: [row, exited] });
  assert.throws(() => validateWorkbenchResult("services.list", { enabled: true, services: [{ ...row, previewUrl: "javascript:alert(1)" }] }));
  assert.throws(() => validateWorkbenchResult("services.list", { enabled: true, services: [{ ...row, pid: -1 }] }));
  assert.throws(() => validateWorkbenchResult("services.list", { enabled: true, services: [{ ...row, ownerId: "" }] }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPUTER_WORKSPACE_COMMAND_KINDS, COMPUTER_WORKSPACE_QUERY_KINDS, isWorkbenchOperationKind, validateWorkbenchOperation, validateWorkbenchResult } from "../src/index.js";

test("Computer reads do not become Workbench commands", () => {
  for (const kind of COMPUTER_WORKSPACE_QUERY_KINDS) assert.equal(isWorkbenchOperationKind(kind), false);
  for (const kind of COMPUTER_WORKSPACE_COMMAND_KINDS) assert.equal(isWorkbenchOperationKind(kind), true);
  assert.doesNotThrow(() => validateWorkbenchOperation({ kind: "computer.observe.open", sessionId: "s", consumerId: "panel-1" }));
  assert.doesNotThrow(() => validateWorkbenchResult("computer.observe.open", { leaseId: "lease-1", sessionId: "s", expiresAt: 42 }));
});

test("Existing ComputerObservation payloads remain strict and distinct", () => {
  const status = { enabled: true, available: true, backend: "native", capturePermission: "granted", inputPermission: "granted", axPermission: "unavailable", running: 0, targets: [] };
  assert.doesNotThrow(() => validateWorkbenchOperation({ kind: "computer.stop", sessionId: "s" }));
  assert.doesNotThrow(() => validateWorkbenchResult("computer.stop", { stopped: true }));
  assert.doesNotThrow(() => validateWorkbenchResult("computer.status", status));
  assert.throws(() => validateWorkbenchResult("computer.status", { ...status, revision: 1 }));
  assert.throws(() => validateWorkbenchOperation({ kind: "computer.capture", sessionId: "s", targetId: "display-1", leaseId: "lease-1" }));
});

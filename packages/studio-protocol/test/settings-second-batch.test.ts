import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ContractValidationError, parseFoundationStudioRequest, parseStudioSnapshotResponse } from "../src/index.js";

test("new settings and credential status round-trip while native clamped values remain readable", async () => {
  const baseline = JSON.parse(await readFile(new URL("../../fixtures/snapshot.initial.json", import.meta.url), "utf8"));
  const runtimeSettings = { "edit.autoRepair.enabled": true, "features.unexpectedStopDetection": "smart", extendedContext: false, "compaction.asyncEnabled": true, "compaction.methodOrder": ["remote"], "providers.openai-codex.codeMode": "off", "workspace.additionalDirectories": ["../other"], "read.defaultLimit": 5000, "memory.backend": "hindsight" };
  const activation = { configured: {}, restartRequired: [], hindsightCredential: { configured: true, source: "env" }, resolvedEditMode: "replace" };
  const result = parseStudioSnapshotResponse({ ...baseline, snapshot: { ...baseline.snapshot, runtimeSettings, runtimeSettingsActivation: activation } });
  assert.equal(result.snapshot.runtimeSettings?.["read.defaultLimit"], 5000);
  assert.deepEqual(result.snapshot.runtimeSettingsActivation?.hindsightCredential, { configured: true, source: "env" });
  const base = { type: "studio.request", requestId: "settings", runtimeEpoch: 1 };
  const operation = { kind: "runtime.settings.get", keys: ["hindsight.apiUrl"], checkHindsight: true };
  assert.deepEqual(parseFoundationStudioRequest({ ...base, operation }).operation, operation);
  assert.throws(() => parseFoundationStudioRequest({ ...base, operation: { kind: "runtime.settings.set", key: "read.defaultLimit", value: 5000, persist: true } }), ContractValidationError);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseStudioSnapshotResponse } from "../src/index.js";

test("new settings and credential status round-trip while native clamped values remain readable", async () => {
  const baseline = JSON.parse(await readFile(new URL("../../fixtures/snapshot.initial.json", import.meta.url), "utf8"));
  const runtimeSettings = { "edit.autoRepair.enabled": true, "features.unexpectedStopDetection": "smart", extendedContext: false, "compaction.asyncEnabled": true, "compaction.methodOrder": ["remote"], "providers.openai-codex.codeMode": "off", "workspace.additionalDirectories": ["../other"], "read.defaultLimit": 5000, "memory.backend": "hindsight" };
  const activation = { configured: {}, restartRequired: [], hindsightCredential: { configured: true, source: "env" }, resolvedEditMode: "replace" };
  const result = parseStudioSnapshotResponse({ ...baseline, snapshot: { ...baseline.snapshot, runtimeSettings, runtimeSettingsActivation: activation } });
  assert.equal(result.snapshot.runtimeSettings?.["read.defaultLimit"], 5000);
  assert.deepEqual(result.snapshot.runtimeSettingsActivation?.hindsightCredential, { configured: true, source: "env" });
});

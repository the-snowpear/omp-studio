import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelCatalog, generateModelCatalog } from "./model-catalog.mjs";

test("catalog generation keeps only YAML-compatible controls and marks native dependencies", () => {
  const base = { id: "example", api: "openai-completions", contextWindow: 200000, reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high", requiresEffort: true } };
  const catalog = buildModelCatalog({ provider: { example: base, routed: { ...base, id: "routed", thinking: { ...base.thinking, effortRouting: { high: "other-model" } } } } }, "pinned-commit");
  assert.equal(catalog.entries[0].values.thinkingConfig.requiresEffort, true);
  assert.equal(catalog.entries[1].values.thinkingConfig, undefined);
  assert.equal(catalog.entries[1].limitation, "native-thinking");
  assert.equal(catalog.entries[1].values.contextWindow, 200000);
  const nativeContext = buildModelCatalog({ provider: { example: { ...base, maxContextWindow: 180000 } } }, "pinned-commit").entries[0];
  assert.equal(nativeContext.values.maxContextWindow, undefined);
  assert.equal(nativeContext.limitation, "native-context");
});

test("checked-in catalog and bundled module reproduce from the fixed OMP source without networking", async () => {
  const catalog = await generateModelCatalog(true);
  assert.ok(catalog.entries.length > 1000);
  assert.equal(new Set(catalog.entries.map(row => row.key)).size, catalog.entries.length);
});

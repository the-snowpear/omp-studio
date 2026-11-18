import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createOmpModelsService } from "../src/omp-models-adapter.js";

for (const [name, apiKey] of [
  ["numeric credential", "001234567890123456789"],
  ["alias-like credential", "*local-token"],
  ["quoted and escaped credential", 'local: "token#part"\\suffix'],
  ["command credential", "!printf local-test-token"],
] as const) {
  test(`preserves ${name} when a provider is saved again without re-entering its secret`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-model-string-"));
    const service = createOmpModelsService({ agentDir: directory });
    const auth = name === "command credential"
      ? { type: "command" as const, command: apiKey.slice(1) }
      : { type: "api-key" as const, apiKey };
    try {
      await service.upsertProvider({ id: "fixture", name: "First save", api: "openai-completions", auth,
        models: [{ id: "fixture-model", contextWindow: 8192 }] });
      const first = parseYaml(await readFile(join(directory, "models.yml"), "utf8"));
      assert.equal(first.providers.fixture.apiKey, apiKey);

      await service.upsertProvider({ id: "fixture", name: "Edited model", api: "openai-completions",
        auth: { type: auth.type }, models: [{ id: "fixture-model", contextWindow: 16384 }] });
      // Saving another provider rewrites this same file too.
      await service.upsertProvider({ id: "other", name: "Other provider", api: "openai-completions", auth: { type: "none" },
        models: [{ id: "other-model" }] });
      const saved = parseYaml(await readFile(join(directory, "models.yml"), "utf8"));
      assert.equal(saved.providers.fixture.apiKey, apiKey);
      assert.equal(saved.providers.fixture.models[0].contextWindow, 16384);
      assert.equal(saved.providers.other.models[0].id, "other-model");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

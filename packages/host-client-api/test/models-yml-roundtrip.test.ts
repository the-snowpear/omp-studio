import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createOmpModelsService } from "../src/omp-models-adapter.js";

for (const [name, apiKey] of [
  ["numeric credential", "001234567890123456789"],
  ["alias-like credential", "*local-token"],
  ["quoted and escaped credential", 'local: "token#part"\\suffix'],
  ["credential with an unspaced hash", "local#token"],
  ["credential with an apostrophe", "local's-token"],
  ["command credential", "!printf local-test-token"],
] as const) {
  test(`preserves ${name} when a provider is saved again without re-entering its secret`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-model-string-"));
    const modelsFile = join(directory, "models.yml");
    const service = createOmpModelsService({ agentDir: directory });
    const auth = name === "command credential"
      ? { type: "command" as const, command: apiKey.slice(1) }
      : { type: "api-key" as const, apiKey };
    try {
      await service.upsertProvider({
        id: "fixture",
        name: "First save",
        api: "openai-completions",
        auth,
        models: [{ id: "fixture-model", contextWindow: 8192 }],
      });
      const first = parseYaml(await readFile(modelsFile, "utf8"));
      assert.equal(first.providers.fixture.apiKey, apiKey);

      const config = await service.get();
      assert.equal(parseYaml(config.generatedModelsYml).providers.fixture.apiKey, "********");
      await service.upsertProvider({
        id: "fixture",
        name: "Edited model",
        api: "openai-completions",
        auth: { type: auth.type },
        models: [{ id: "fixture-model", contextWindow: 16384 }],
      });
      // Saving another provider rewrites this same file too.
      await service.upsertProvider({
        id: "other",
        name: "Other provider",
        api: "openai-completions",
        auth: { type: "none" },
        models: [{ id: "other-model" }],
      });
      const saved = parseYaml(await readFile(modelsFile, "utf8"));
      assert.equal(saved.providers.fixture.apiKey, apiKey);
      assert.equal(saved.providers.fixture.models[0].contextWindow, 16384);
      assert.equal(saved.providers.other.models[0].id, "other-model");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("preserves existing provider values when the YAML editor saves another provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-model-existing-"));
  const modelsFile = join(directory, "models.yml");
  const service = createOmpModelsService({ agentDir: directory });
  const source = [
    "providers:",
    "  digits:",
    '    apiKey: "001234"',
    "    headers: {}",
    "    models:",
    "    - id: digits-model",
    "      contextWindow: 1e4",
    "  literal:",
    "    apiKey: local's#token # trailing comment",
    "  quoted:",
    "    apiKey: 'local''s#token' # trailing comment",
    "  command:",
    "    apiKey: !printf local-test-token",
    "  legacy-alias:",
    "    apiKey: *legacy-token",
    '  inline: { apiKey: "inline-token" }',
    "",
  ].join("\n");
  try {
    await writeFile(modelsFile, source, "utf8");
    const { generatedModelsYml, contentHash } = await service.get();
    assert.equal(parseYaml(generatedModelsYml).providers.inline.apiKey, "********");
    await service.writeModelsYml({
      text: generatedModelsYml,
      ...(contentHash === undefined ? {} : { expectedHash: contentHash }),
      overlay: { id: "other", name: "Other provider", api: "openai-completions", auth: { type: "none" } },
    });
    const { providers } = parseYaml(await readFile(modelsFile, "utf8"));
    assert.deepEqual(providers.digits, {
      apiKey: "001234",
      headers: {},
      models: [{ id: "digits-model", contextWindow: 10000 }],
    });
    assert.equal(providers.literal.apiKey, "local's#token");
    assert.equal(providers.quoted.apiKey, "local's#token");
    assert.equal(providers.command.apiKey, "!printf local-test-token");
    assert.equal(providers["legacy-alias"].apiKey, "*legacy-token");
    assert.equal(providers.inline.apiKey, "inline-token");
    assert.equal(providers.other.auth, "none");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

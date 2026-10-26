import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBun, ompSourceDirectory } from "./omp-tooling.mjs";

// No provider requests: validate the generated YAML with the pinned Runtime,
// then exercise the actual custom-model builder for each thinking mode.
const directory = await mkdtemp(join(tmpdir(), "omp-model-catalog-runtime-"));
const catalogPath = fileURLToPath(new URL("../catalog/model-catalog-v1.json", import.meta.url));
const schemaUrl = pathToFileURL(join(ompSourceDirectory, "packages/coding-agent/src/config/models-config-schema.ts")).href;
const builderUrl = pathToFileURL(join(ompSourceDirectory, "packages/coding-agent/src/config/custom-models.ts")).href;
const script = `
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { ModelsConfigSchema } from ${JSON.stringify(schemaUrl)};
import { finalizeCustomModel } from ${JSON.stringify(builderUrl)};
const catalog = await Bun.file(${JSON.stringify(catalogPath)}).json();
const models = catalog.entries.map((row, index) => {
  const { thinkingConfig, ...values } = row.values;
  return { id: "studio-validation-" + index, api: row.api, ...values, ...(thinkingConfig ? { thinking: thinkingConfig } : {}) };
});
const path = ${JSON.stringify(join(directory, "models.yml"))};
await Bun.write(path, stringify({ providers: { studioValidation: { api: "openai-completions", baseUrl: "http://127.0.0.1/v1", auth: "none", models } } }));
const config = ModelsConfigSchema.assert(parse(await Bun.file(path).text()));
const modes = new Set();
for (const definition of config.providers.studioValidation.models) {
  if (!definition.thinking || modes.has(definition.thinking.mode)) continue;
  const built = finalizeCustomModel({ ...definition, provider: "studio-validation", baseUrl: "http://127.0.0.1/v1" }, { useDefaults: true });
  assert.equal(built.thinking?.mode, definition.thinking.mode);
  assert.deepEqual(built.thinking?.efforts, definition.thinking.efforts);
  modes.add(definition.thinking.mode);
}
assert.equal(modes.size, 5);
console.log("Runtime schema accepted " + models.length + " generated models; native custom-model builder accepted all five thinking modes.");
`;
const scriptPath = join(directory, "verify.ts");
await writeFile(scriptPath, script, "utf8");
process.stdout.write(execFileSync(findBun(), [scriptPath], { cwd: ompSourceDirectory, encoding: "utf8" }));

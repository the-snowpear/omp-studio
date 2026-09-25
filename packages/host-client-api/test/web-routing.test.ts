import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { readWebRouting, writeWebRouting, WEB_PRIORITY_1830 } from "../src/web-routing.js";
import { migrateModelRoleConfig, MODEL_ROLE_PRIORITIES } from "../src/model-role-migration.js";

test("legacy search exclusion applies to the complete native chain, including OAuth aliases", () => {
  const original = { providers: { webSearchOrder: ["exa", "gemini", "exa"], webSearchExclude: ["gemini", "xai", "mojeek"], webSearchGeminiModel: "gemini-custom" } };
  const routing = readWebRouting(original);
  assert.equal(routing.primary, "web/exa");
  assert.ok(!routing.fallbacks!.some(value => /^(google|google-antigravity|xai|xai-oauth)\//u.test(value)));
  assert.ok(!routing.fallbacks!.includes("web/mojeek"));
  assert.deepEqual(original.providers.webSearchOrder, ["exa", "gemini", "exa"]);
});
test("explicit native primary and empty fallback override the legacy migration", () => {
  const root = { modelRoles: { web: "provider/custom" }, retry: { fallbackChains: { web: [] } }, providers: { webSearchOrder: ["exa"] } };
  const result = readWebRouting(root);
  assert.equal(result.primary, "provider/custom"); assert.deepEqual(result.fallbacks, []);
  writeWebRouting(root, { primary: "", fallbacks: null });
  assert.equal(readWebRouting(root).primary, ""); assert.equal(readWebRouting(root).fallbacks, null);
  assert.deepEqual(root.providers, {});
});
test("judge, media and local lightweight roles follow the upstream migration", () => {
  const root = migrateModelRoleConfig({ providers: { judgmentProvider: "llm", unexpectedStopModel: "small", tts: "local", imageOrder: ["xai"], tinyModel: "mini" }, stt: { modelName: "turbo" }, modelRoles: { tiny: "remote/title" } });
  const roles = root.modelRoles as Record<string, string>;
  const chains = (root.retry as { fallbackChains: Record<string, string[]> }).fallbackChains;
  assert.equal(roles.judge, "local/small"); assert.deepEqual(chains.judge, ["@tiny", "@smol", "@default"]);
  assert.equal(roles.image, "xai/grok-imagine-image"); assert.equal(roles.speech, "local/kokoro");
  assert.equal(roles.dictation, "local/whisper-large-v3-turbo"); assert.equal(roles.tiny, "local/mini,remote/title");
  assert.equal(root.providers, undefined);
});
test("mirrored default candidates remain aligned with the pinned Runtime", async () => {
  const native = JSON.parse(await readFile(new URL("../../../../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/priority.json", import.meta.url), "utf8")) as Record<string, string[]>;
  assert.deepEqual(WEB_PRIORITY_1830, native.web); assert.deepEqual(MODEL_ROLE_PRIORITIES.image, native.image);
});

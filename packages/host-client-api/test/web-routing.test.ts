import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { readWebRouting, writeWebRouting, WEB_PRIORITY_1880 } from "../src/web-routing.js";
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
  assert.deepEqual(WEB_PRIORITY_1880, native.web); assert.deepEqual(MODEL_ROLE_PRIORITIES.image, native.image);
});

test("free defaults do not discard explicitly configured paid legacy engines", () => {
  const defaults = readWebRouting({});
  assert.equal(defaults.fallbacks, null);
  assert.equal(defaults.defaultCandidates[1], "web/hosted");
  assert.ok(!defaults.defaultCandidates.includes("web/perplexity"));
  const selected = readWebRouting({ providers: { webSearchOrder: ["perplexity", "kagi"] } });
  assert.equal(selected.primary, "web/perplexity");
  assert.equal(selected.fallbacks![0], "web/kagi");
});

test("Gemini legacy selection preserves all native credential routes and GA image IDs", () => {
  const routing = readWebRouting({ providers: { webSearch: "gemini", webSearchGeminiModel: "custom-flash" } });
  assert.equal(routing.primary, "google-gemini-cli/custom-flash");
  assert.deepEqual(routing.fallbacks!.slice(0, 2), ["google-antigravity/custom-flash", "google/custom-flash"]);
  const root = migrateModelRoleConfig({ providers: { imageOrder: ["openai", "gemini"] } });
  assert.equal((root.modelRoles as Record<string, string>).image, "openai/gpt-image-2");
  assert.equal((root.retry as { fallbackChains: Record<string, string[]> }).fallbackChains.image![0], "google/gemini-3-pro-image");
});

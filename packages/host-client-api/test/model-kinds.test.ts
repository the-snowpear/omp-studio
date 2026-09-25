import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAcceptsRole } from "@omp-studio/client-contract";
import { availableFromCacheModel, availableFromCatalogEntry, catalogEntryFromAvailable, toYamlProvider } from "../src/omp-models-adapter.js";

test("cached non-chat models keep kind and grounding across model-page projections", () => {
  const source = availableFromCacheModel({ id: "image-model", kind: "image", api: "openai-images", input: ["text", "image"] }, "provider")!;
  const roundTrip = availableFromCatalogEntry("provider", catalogEntryFromAvailable(source));
  assert.equal(roundTrip.kind, "image");
  assert.equal(modelAcceptsRole("default", roundTrip), false);
  assert.equal(modelAcceptsRole("image", roundTrip), true);
  const grounded = availableFromCacheModel({ id: "grounded-chat", webSearch: "gemini" }, "provider")!;
  assert.equal(modelAcceptsRole("web", availableFromCatalogEntry("provider", catalogEntryFromAvailable(grounded))), true);
  assert.equal(modelAcceptsRole("web", { kind: "chat" }), false);
});

test("custom model saves preserve runner metadata instead of turning image models into chat", () => {
  const model = catalogEntryFromAvailable(availableFromCacheModel({ id: "speech", kind: "tts", api: "openai-speech" }, "custom")!);
  const yaml = toYamlProvider({ id: "custom", name: "Custom", api: "openai-speech", auth: { type: "api-key" }, models: [model] }, undefined);
  assert.equal((yaml.models as Array<Record<string, unknown>>)[0]?.kind, "tts");
  assert.equal(modelAcceptsRole("speech", model), true);
  assert.equal(modelAcceptsRole("dictation", model), false);
  assert.equal(modelAcceptsRole("review", {}), true);
});

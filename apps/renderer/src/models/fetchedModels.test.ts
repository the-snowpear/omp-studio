import { describe, expect, it } from "vitest";
import type { AvailableModelRecord, ModelCatalogEntry, ModelDiscoveryModel } from "@omp-studio/client-contract";
import {
  candidatesToEntries,
  mergeImportedModels,
  pickedCount,
  setAllPicked,
  toCandidates,
  togglePicked,
} from "./fetchedModels";

function entry(id: string, source: ModelCatalogEntry["source"] = "custom"): ModelCatalogEntry {
  return {
    id,
    name: id,
    selector: `acme/${id}`,
    image: false,
    reasoning: false,
    tools: true,
    status: "available",
    source,
  };
}

function known(id: string, overrides: Partial<AvailableModelRecord> = {}): AvailableModelRecord {
  return {
    provider: "acme",
    id,
    selector: `acme/${id}`,
    name: id,
    reasoning: false,
    ...overrides,
  };
}

const FETCHED: ReadonlyArray<ModelDiscoveryModel> = [
  { id: "glm-5", name: "GLM-5", contextWindow: 200_000 },
  { id: "kept", name: "kept" },
];

describe("toCandidates", () => {
  it("marks models already on the draft and leaves them unpicked", () => {
    const candidates = toCandidates(FETCHED, [entry("kept")], []);
    expect(candidates.map((item) => [item.id, item.existing, item.picked])).toEqual([
      ["glm-5", false, true],
      ["kept", true, false],
    ]);
  });

  it("treats catalog rows as existing so imports never duplicate them", () => {
    const [candidate] = toCandidates([{ id: "glm-5", name: "GLM-5" }], [entry("glm-5", "catalog")], []);
    expect(candidate?.existing).toBe(true);
    expect(candidate?.picked).toBe(false);
  });

  it("keeps endpoint metadata and marks nothing as enriched", () => {
    const [candidate] = toCandidates(
      [{ id: "glm-5", name: "GLM-5", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, image: true }],
      [],
      [known("glm-5", { contextWindow: 1_000, maxTokens: 2_000 })],
    );
    expect(candidate?.contextWindow).toBe(200_000);
    expect(candidate?.maxTokens).toBe(64_000);
    expect(candidate?.reasoning).toBe(true);
    expect(candidate?.image).toBe(true);
    expect(candidate?.enriched).toBe(false);
  });

  it("fills gaps from the local catalog and flags the row as enriched", () => {
    const [candidate] = toCandidates(
      [{ id: "glm-5", name: "GLM-5" }],
      [],
      [known("glm-5", { contextWindow: 128_000, maxTokens: 16_384, reasoning: true, image: true, thinking: ["low", "high"] })],
    );
    expect(candidate?.contextWindow).toBe(128_000);
    expect(candidate?.maxTokens).toBe(16_384);
    expect(candidate?.reasoning).toBe(true);
    expect(candidate?.thinking).toEqual(["low", "high"]);
    expect(candidate?.enriched).toBe(true);
  });

  it("leaves unknown metadata absent when neither source knows it", () => {
    const [candidate] = toCandidates([{ id: "mystery", name: "mystery" }], [], []);
    expect(candidate).toEqual({ id: "mystery", name: "mystery", existing: false, picked: true, enriched: false });
  });

  it("prefers the first local catalog record for an ambiguous model id", () => {
    const [candidate] = toCandidates(
      [{ id: "shared", name: "shared" }],
      [],
      [known("shared", { contextWindow: 1_000 }), known("shared", { provider: "other", contextWindow: 9_000 })],
    );
    expect(candidate?.contextWindow).toBe(1_000);
  });

  it("drops blank ids, de-duplicates, and falls back to the id as label", () => {
    const candidates = toCandidates(
      [{ id: " ", name: "blank" }, { id: "dup", name: "" }, { id: "dup", name: "again" }],
      [],
      [],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: "dup", name: "dup" });
  });
});

describe("selection helpers", () => {
  it("toggles one row and counts the picked ones", () => {
    const candidates = toCandidates(FETCHED, [entry("kept")], []);
    expect(pickedCount(candidates)).toBe(1);
    const all = setAllPicked(candidates, true);
    expect(pickedCount(all)).toBe(2);
    expect(pickedCount(setAllPicked(candidates, false))).toBe(0);
    expect(pickedCount(togglePicked(candidates, "glm-5"))).toBe(0);
  });
});

describe("candidatesToEntries", () => {
  it("emits only picked rows with no keys for unknown metadata", () => {
    const entries = candidatesToEntries("acme", toCandidates(FETCHED, [entry("kept")], []));
    expect(entries).toEqual([
      {
        id: "glm-5",
        name: "GLM-5",
        selector: "acme/glm-5",
        contextWindow: 200_000,
        image: false,
        reasoning: false,
        tools: true,
        status: "available",
        source: "custom",
      },
    ]);
    expect(Object.keys(entries[0] ?? {})).not.toContain("maxTokens");
    expect(Object.keys(entries[0] ?? {})).not.toContain("thinking");
  });

  it("carries thinking efforts only for reasoning models", () => {
    const reasoning = candidatesToEntries("acme", [
      { id: "a", name: "a", existing: false, picked: true, reasoning: true, thinking: ["high"], enriched: true },
      { id: "b", name: "b", existing: false, picked: true, reasoning: false, thinking: ["high"], enriched: true },
    ]);
    expect(reasoning[0]?.thinking).toEqual(["high"]);
    expect(reasoning[1]?.thinking).toBeUndefined();
  });
});

describe("mergeImportedModels", () => {
  it("replaces a custom row of the same id and keeps catalog rows", () => {
    const current = [entry("catalog-model", "catalog"), entry("glm-5"), entry("other")];
    const imported = candidatesToEntries("acme", [
      { id: "glm-5", name: "GLM-5 (refreshed)", existing: true, picked: true, contextWindow: 1_000, enriched: false },
    ]);
    const merged = mergeImportedModels(current, imported);
    expect(merged.map((model) => model.id)).toEqual(["catalog-model", "other", "glm-5"]);
    expect(merged.filter((model) => model.id === "glm-5")).toHaveLength(1);
    expect(merged.at(-1)?.name).toBe("GLM-5 (refreshed)");
  });
});

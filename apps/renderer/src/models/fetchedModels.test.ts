import { describe, expect, it } from "vitest";

import { pickedCount, setAllPicked, togglePicked, toCandidates, candidatesToEntries, mergeImportedModels, type FetchedModelCandidate } from "./fetchedModels";

const candidates: FetchedModelCandidate[] = [
  { id: "alpha", name: "Alpha", existing: false, picked: true, enriched: false },
  { id: "beta", name: "Beta", existing: true, picked: false, enriched: false },
];

describe("fetched model selection", () => {
  it("does not borrow a same-id model from another provider or persist unknown reasoning as false", () => {
    const candidates = toCandidates([{ id: "shared", name: "Shared" }], [], [{ provider: "other", id: "shared", selector: "other/shared", name: "Shared", reasoning: true, contextWindow: 200000 }]);
    const entry = candidatesToEntries("gateway", candidates)[0]!;
    expect(entry.parameters).toEqual({});
    expect(entry.thinkingConfig).toBeUndefined();
    expect(entry.contextWindow).toBeUndefined();
  });

  it("preserves manual fields when importing updated endpoint recommendations", () => {
    const previous = candidatesToEntries("gateway", [{ id: "example", name: "Example", picked: true, existing: false, enriched: false, parameters: { contextWindow: 90000, maxTokens: 5000 }, parameterSources: { contextWindow: { source: "manual" }, maxTokens: { source: "catalog" } } }]);
    const imported = candidatesToEntries("gateway", [{ id: "example", name: "Example", picked: true, existing: true, enriched: true, parameters: { contextWindow: 200000, maxTokens: 30000 }, parameterSources: { contextWindow: { source: "endpoint" }, maxTokens: { source: "endpoint" } } }]);
    const model = mergeImportedModels(previous, imported)[0]!;
    expect(model.parameters).toEqual({ contextWindow: 90000, maxTokens: 30000 });
    expect(model.parameterSources?.contextWindow?.source).toBe("manual");
    expect(model.parameterSources?.maxTokens?.source).toBe("endpoint");
  });
  it("selects and clears every fetched model in one operation", () => {
    const selected = setAllPicked(candidates, true);
    expect(selected.every((item) => item.picked)).toBe(true);
    expect(pickedCount(selected)).toBe(candidates.length);

    const cleared = setAllPicked(selected, false);
    expect(cleared.every((item) => !item.picked)).toBe(true);
    expect(pickedCount(cleared)).toBe(0);
  });

  it("keeps individual checkbox toggles independent", () => {
    expect(togglePicked(candidates, "beta")).toEqual([
      candidates[0],
      { ...candidates[1], picked: true },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { pickedCount, setAllPicked, togglePicked, type FetchedModelCandidate } from "./fetchedModels";

const candidates: FetchedModelCandidate[] = [
  { id: "alpha", name: "Alpha", existing: false, picked: true, enriched: false },
  { id: "beta", name: "Beta", existing: true, picked: false, enriched: false },
];

describe("fetched model selection", () => {
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

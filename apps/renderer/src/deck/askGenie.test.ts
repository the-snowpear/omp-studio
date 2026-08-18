import { describe, expect, it } from "vitest";
import { isAskDeckInteraction } from "./askGenie";

describe("isAskDeckInteraction", () => {
  it("treats ask, select, input, and editor as Ask-deck cards", () => {
    expect(isAskDeckInteraction({ kind: "ask" })).toBe(true);
    expect(isAskDeckInteraction({ kind: "select" })).toBe(true);
    expect(isAskDeckInteraction({ kind: "input" })).toBe(true);
    expect(isAskDeckInteraction({ kind: "editor" })).toBe(true);
  });

  it("does not treat approval or confirm as Ask-deck cards", () => {
    expect(isAskDeckInteraction({ kind: "approval" })).toBe(false);
    expect(isAskDeckInteraction({ kind: "confirm" })).toBe(false);
    expect(isAskDeckInteraction(null)).toBe(false);
  });
});

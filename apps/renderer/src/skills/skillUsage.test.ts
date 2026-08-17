import { describe, expect, it } from "vitest";

import { mergeUsedSkills, skillNamesInDoc, skillNamesInText } from "./skillUsage";

describe("skillNamesInText", () => {
  it("keeps first-seen order and drops duplicates", () => {
    expect(skillNamesInText("/skill:alpha /skill:beta then /skill:alpha")).toEqual(["alpha", "beta"]);
  });

  it("finds a mid-prompt token", () => {
    expect(skillNamesInText("please /skill:commit-msg the staged files")).toEqual(["commit-msg"]);
  });
});

describe("skillNamesInDoc", () => {
  it("collects skill capsules and typed tokens", () => {
    const names = skillNamesInDoc({
      nodes: [
        { type: "chip", chip: { id: "1", kind: "skill", label: "alpha", name: "alpha" } },
        { type: "text", value: " and /skill:beta please" },
        { type: "chip", chip: { id: "2", kind: "file", label: "a.ts", path: "a.ts" } },
      ],
    });
    expect([...names]).toEqual(["alpha", "beta"]);
  });
});

describe("mergeUsedSkills", () => {
  it("unions without reallocating when nothing is new", () => {
    const prev = new Set(["alpha"]);
    expect(mergeUsedSkills(prev, new Set(["alpha"]))).toBe(prev);
    expect([...mergeUsedSkills(prev, new Set(["beta"]))]).toEqual(["alpha", "beta"]);
  });
});

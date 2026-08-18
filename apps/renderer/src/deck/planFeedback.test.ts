import { describe, expect, it } from "vitest";
import { formatPlanRefineFeedback, mergePlanDraft } from "./planFeedback";
import { parsePlanSections } from "./planSections";

const SECTIONS = parsePlanSections("lead\n\n## 目标\n\nFreeze.\n\n## 步骤\n\nDo work.\n");

describe("formatPlanRefineFeedback", () => {
  it("returns undefined when no notes are saved", () => {
    expect(formatPlanRefineFeedback(SECTIONS, {})).toBeUndefined();
    expect(formatPlanRefineFeedback(SECTIONS, { 1: ["  "] })).toBeUndefined();
  });

  it("emits TUI-shaped section bullets for single-line notes", () => {
    const feedback = formatPlanRefineFeedback(SECTIONS, { 1: ["needs detail"] });
    expect(feedback).toBe("Refinement feedback on the plan:\n\n## 目标\n- needs detail\n");
  });

  it("labels the preamble section as Plan preamble", () => {
    const feedback = formatPlanRefineFeedback(SECTIONS, { 0: ["drop the intro"] });
    expect(feedback).toContain("## Plan preamble\n- drop the intro\n");
  });

  it("fences multiline notes as md, matching TUI", () => {
    const feedback = formatPlanRefineFeedback(SECTIONS, { 2: ["add rollback\ninclude smoke test"] });
    expect(feedback).toContain("## 步骤\n```md\nadd rollback\ninclude smoke test\n```\n");
  });

  it("keeps notes whose section index is no longer in the parsed plan", () => {
    const feedback = formatPlanRefineFeedback([], { 4: ["still send this"] });
    expect(feedback).toBe("Refinement feedback on the plan:\n\n## Plan preamble\n- still send this\n");
  });

  it("emits whole-plan notes before section notes", () => {
    const feedback = formatPlanRefineFeedback(SECTIONS, { 1: ["needs detail"] }, "rewrite the rollout");
    expect(feedback).toBe(
      "Refinement feedback on the plan:\n\n## Entire plan\n- rewrite the rollout\n\n## 目标\n- needs detail\n",
    );
  });

  it("treats a blank overall note as absent", () => {
    expect(formatPlanRefineFeedback(SECTIONS, {}, "  ")).toBeUndefined();
    expect(formatPlanRefineFeedback(SECTIONS, {}, "rewrite the rollout")).toBe(
      "Refinement feedback on the plan:\n\n## Entire plan\n- rewrite the rollout\n",
    );
  });
});

describe("mergePlanDraft", () => {
  it("appends a trimmed draft onto the target section", () => {
    expect(mergePlanDraft({ 1: ["saved"] }, { index: 1, text: "  draft  " })).toEqual({
      1: ["saved", "draft"],
    });
  });

  it("ignores a blank draft", () => {
    expect(mergePlanDraft({ 1: ["saved"] }, { index: 1, text: "  " })).toEqual({ 1: ["saved"] });
  });
});

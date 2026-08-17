import { describe, expect, it } from "vitest";

import {
  containsMagicKeyword,
  findMagicKeywordMatches,
  hasMagicKeyword,
  maskNonProse,
} from "./magicKeywords";
import { injectMagicKeyword } from "./composerMode";

describe("magicKeywords", () => {
  it("detects standalone prose keywords", () => {
    expect(hasMagicKeyword("please ultrathink this")).toBe(true);
    expect(hasMagicKeyword("now orchestrate everything")).toBe(true);
    expect(hasMagicKeyword("run workflowz across the suite")).toBe(true);
    expect(containsMagicKeyword("orchestrate, please", "orchestrate")).toBe(true);
  });

  it("ignores identifiers, paths, calls, and casing", () => {
    expect(hasMagicKeyword("orchestrated")).toBe(false);
    expect(hasMagicKeyword("see orchestrate.ts")).toBe(false);
    expect(hasMagicKeyword("foo::orchestrate")).toBe(false);
    expect(hasMagicKeyword("orchestrate()")).toBe(false);
    expect(hasMagicKeyword("Orchestrate")).toBe(false);
  });

  it("ignores code fences, inline code, and XML", () => {
    expect(hasMagicKeyword("`ultrathink`")).toBe(false);
    expect(hasMagicKeyword("```\norchestrate\n```")).toBe(false);
    expect(hasMagicKeyword("<x>workflowz</x>")).toBe(false);
    expect(hasMagicKeyword("`orchestrate` but please orchestrate now")).toBe(true);
  });

  it("finds match ranges on the original string", () => {
    const text = "`orchestrate` but please orchestrate now";
    const matches = findMagicKeywordMatches(text);
    expect(matches).toEqual([{ start: 25, end: 36, keyword: "orchestrate" }]);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe("orchestrate");
  });

  it("maskNonProse preserves length", () => {
    const text = "`hi` and <b>x</b>";
    expect(maskNonProse(text).length).toBe(text.length);
  });
});

describe("injectMagicKeyword with OMP matching", () => {
  it("still injects when only a code occurrence exists", () => {
    expect(injectMagicKeyword("see `orchestrate`", "orchestrate")).toBe("orchestrate\nsee `orchestrate`");
  });

  it("skips inject when prose already triggers", () => {
    expect(injectMagicKeyword("orchestrate the migration", "orchestrate")).toBe("orchestrate the migration");
  });
});

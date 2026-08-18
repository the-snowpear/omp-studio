import { describe, expect, it } from "vitest";
import { parsePlanSections, sectionBodyMarkdown, stripInlineMarkdown } from "./planSections";

describe("parsePlanSections", () => {
  it("splits a preamble and one section per ATX heading, tracking depth", () => {
    const sections = parsePlanSections("intro\n\n# Overview\n\nbody\n\n## Goal\n\ngoal\n\n# Risks\n\nrisk\n");
    expect(sections.map((section) => section.level)).toEqual([0, 1, 2, 1]);
    expect(sections.map((section) => section.title)).toEqual(["", "Overview", "Goal", "Risks"]);
    expect(sections[0]!.raw).toBe("intro\n\n");
  });

  it("emits no preamble section when the document opens with a heading", () => {
    const sections = parsePlanSections("# Top\n\nbody\n");
    expect(sections.map((section) => section.level)).toEqual([1]);
    expect(sections[0]!.title).toBe("Top");
  });

  it("does not treat '#' inside fenced code blocks as a heading", () => {
    const sections = parsePlanSections("# Real\n\n```\n# not a heading\n```\n\n~~~\n## also not\n~~~\n");
    expect(sections.map((section) => section.title)).toEqual(["Real"]);
  });

  it("requires whitespace after the hashes, so '#tag' is body text", () => {
    const sections = parsePlanSections("#tag is not a heading\nmore body\n");
    expect(sections.map((section) => section.level)).toEqual([0]);
  });

  it("strips inline markdown and closing hashes from titles", () => {
    const sections = parsePlanSections("## **Goal** & [docs](http://x) ##\n\nbody\n");
    expect(sections[0]!.title).toBe("Goal & docs");
  });
});

describe("sectionBodyMarkdown", () => {
  it("drops the heading line so the dialog title is not duplicated", () => {
    const [section] = parsePlanSections("## 目标\n\nFreeze the protocol.\n");
    expect(sectionBodyMarkdown(section!)).toBe("\nFreeze the protocol.\n");
  });

  it("keeps preamble bytes unchanged", () => {
    const [section] = parsePlanSections("lead-in\n\n# A\n\nbody\n");
    expect(sectionBodyMarkdown(section!)).toBe("lead-in\n\n");
  });
});

describe("stripInlineMarkdown", () => {
  it("collapses emphasis, code, links, and whitespace to readable text", () => {
    expect(stripInlineMarkdown("**bold** _it_ `code` [t](u)")).toBe("bold it code t");
    expect(stripInlineMarkdown("a   b\tc")).toBe("a b c");
  });
});

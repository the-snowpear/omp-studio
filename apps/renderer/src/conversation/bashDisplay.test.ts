import { describe, expect, it } from "vitest";
import { BASH_DISPLAY_MAX_ROWS, bashDisplay, bashTailSlice } from "./bashDisplay";

describe("bashDisplay", () => {
  it("renders a plain string log as a single block", () => {
    // One node per line meant a running command with a long log rebuilt
    // thousands of DOM nodes on every published frame; `.codeblock` is
    // `white-space: pre`, so the newlines carry the layout on their own.
    const output = bashDisplay("first\nsecond\n\nfourth");
    expect(output.blocks).toEqual([{ cls: "", text: "first\nsecond\n\nfourth" }]);
    expect(output.truncated).toBe(false);
  });

  it("strips ANSI and applies carriage returns before splitting", () => {
    const output = bashDisplay("[32mok[0m\nprogress 10%\rprogress 90%");
    expect(output.blocks).toEqual([{ cls: "", text: "ok\nprogress 90%" }]);
  });

  it("keeps only the tail of an over-long log", () => {
    const lines = Array.from({ length: BASH_DISPLAY_MAX_ROWS + 200 }, (_, index) => `line ${index}`);
    const output = bashDisplay(lines.join("\n"));
    expect(output.truncated).toBe(true);
    expect(output.blocks).toHaveLength(1);
    expect(output.blocks[0]!.text.startsWith("line 0\n")).toBe(false);
    expect(output.blocks[0]!.text.endsWith(`line ${BASH_DISPLAY_MAX_ROWS + 199}`)).toBe(true);
  });

  it("merges consecutive rows that share a class and splits where it changes", () => {
    const output = bashDisplay([
      ["building", "dim"],
      ["still building", "dim"],
      ["boom", "err"],
      ["done", "ok"],
      ["also done", "ok"],
    ]);
    expect(output.blocks).toEqual([
      { cls: "c-dim", text: "building\nstill building" },
      { cls: "c-err", text: "boom" },
      { cls: "c-ok", text: "done\nalso done" },
    ]);
  });

  it("treats bare array entries as unclassed rows", () => {
    expect(bashDisplay(["a", "b"]).blocks).toEqual([{ cls: "", text: "a\nb" }]);
  });

  it("returns nothing for empty or non-text output", () => {
    expect(bashDisplay("").blocks).toEqual([]);
    expect(bashDisplay(undefined).blocks).toEqual([]);
  });

  it("slices the tail without scanning the discarded prefix", () => {
    const sliced = bashTailSlice("a\nb\nc\nd", 2);
    expect(sliced).toEqual({ text: "c\nd", truncated: true });
  });
});

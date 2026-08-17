import { describe, expect, it } from "vitest";

import { quoteMentionPath, serializeChip, serializeDoc, snapshotFromDoc } from "./serialize";
import type { ComposerChip, ComposerDoc } from "./types";

function chip(partial: Partial<ComposerChip> & Pick<ComposerChip, "kind" | "label">): ComposerChip {
  return { id: partial.id ?? "c1", ...partial };
}

describe("quoteMentionPath", () => {
  it("leaves simple relative paths bare", () => {
    expect(quoteMentionPath("src/App.tsx")).toBe("src/App.tsx");
  });

  it("quotes paths with spaces", () => {
    expect(quoteMentionPath("docs/my notes.md")).toBe('"docs/my notes.md"');
  });

  it("normalizes backslashes", () => {
    expect(quoteMentionPath("src\\foo.ts")).toBe("src/foo.ts");
  });
});

describe("serializeChip", () => {
  it("serializes files as @path", () => {
    expect(serializeChip(chip({ kind: "file", label: "App.tsx", path: "apps/renderer/src/App.tsx" }))).toBe(
      "@apps/renderer/src/App.tsx",
    );
  });

  it("serializes directories with a trailing slash", () => {
    expect(serializeChip(chip({ kind: "dir", label: "src", path: "apps/renderer/src" }))).toBe("@apps/renderer/src/");
  });

  it("serializes skills as /skill:name", () => {
    expect(serializeChip(chip({ kind: "skill", label: "commit-msg", name: "commit-msg" }))).toBe("/skill:commit-msg");
  });

  it("does not put mode capsules into the prompt text", () => {
    expect(serializeChip(chip({ kind: "mode", label: "fast", name: "fast" }))).toBe("");
  });

  it("serializes agents as @name", () => {
    expect(serializeChip(chip({ kind: "agent", label: "code-reviewer", name: "code-reviewer" }))).toBe("@code-reviewer");
  });

  it("serializes clipboard images as 图N", () => {
    expect(
      serializeChip(
        chip({
          kind: "image",
          label: "图1",
          image: { type: "image", mimeType: "image/png", data: "abc" },
        }),
        1,
      ),
    ).toBe("[图1]");
  });

  it("falls back to @path when an image chip has no bytes", () => {
    expect(serializeChip(chip({ kind: "image", label: "logo.png", path: "assets/logo.png" }))).toBe("@assets/logo.png");
  });

  it("keeps a disk image as @path even when preview bytes are attached", () => {
    expect(
      serializeChip(
        chip({
          kind: "image",
          label: "logo.png",
          path: "assets/logo.png",
          image: { type: "image", mimeType: "image/png", data: "abc" },
        }),
      ),
    ).toBe("@assets/logo.png");
  });
});

describe("serializeDoc", () => {
  it("keeps prose and numbers clipboard images in order", () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: "text", value: "看 " },
        {
          type: "chip",
          chip: chip({
            kind: "image",
            label: "图1",
            image: { type: "image", mimeType: "image/png", data: "aaa" },
          }),
        },
        { type: "text", value: " 和 " },
        {
          type: "chip",
          chip: chip({
            id: "c2",
            kind: "image",
            label: "图2",
            image: { type: "image", mimeType: "image/jpeg", data: "bbb" },
          }),
        },
        { type: "text", value: "，对照 " },
        { type: "chip", chip: chip({ id: "c3", kind: "file", label: "App.tsx", path: "src/App.tsx" }) },
      ],
    };
    expect(serializeDoc(doc)).toEqual({
      text: "看 [图1] 和 [图2]，对照 @src/App.tsx",
      images: [
        { type: "image", mimeType: "image/png", data: "aaa" },
        { type: "image", mimeType: "image/jpeg", data: "bbb" },
      ],
    });
  });

  it("does not duplicate a workspace image as both @path and wire bytes", () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: "text", value: "看 " },
        {
          type: "chip",
          chip: chip({
            kind: "image",
            label: "logo.png",
            path: "assets/logo.png",
            image: { type: "image", mimeType: "image/png", data: "aaa" },
          }),
        },
      ],
    };
    expect(serializeDoc(doc)).toEqual({
      text: "看 @assets/logo.png",
      images: [],
    });
  });

  it("snapshotFromDoc mirrors serializeDoc", () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: "text", value: "use " },
        { type: "chip", chip: chip({ kind: "skill", label: "oss-audit", name: "oss-audit" }) },
      ],
    };
    expect(snapshotFromDoc(doc).text).toBe("use /skill:oss-audit");
  });
});

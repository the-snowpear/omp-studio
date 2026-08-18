import { describe, expect, it } from "vitest";

import {
  chipCopyToken,
  displayDocForUserMessage,
  displayDocFromSerializedText,
  quoteMentionPath,
  serializeChip,
  serializeDoc,
  snapshotFromDoc,
  snapshotFromTextAndImages,
} from "./serialize";
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

  it("snapshotFromTextAndImages overwrites a text draft with image capsules", () => {
    const snapshot = snapshotFromTextAndImages("hello", [
      { type: "image", mimeType: "image/png", data: "aaa" },
    ]);
    expect(snapshot.text).toBe("hello[图1]");
    expect(snapshot.images).toEqual([{ type: "image", mimeType: "image/png", data: "aaa" }]);
    expect(snapshot.doc.nodes).toEqual([
      { type: "text", value: "hello" },
      {
        type: "chip",
        chip: expect.objectContaining({
          kind: "image",
          label: "图",
          image: { type: "image", mimeType: "image/png", data: "aaa" },
        }),
      },
    ]);
  });
});

describe("displayDocFromSerializedText", () => {
  it("rebuilds file, folder, skill, agent and clipboard-image capsules", () => {
    const parsed = displayDocFromSerializedText(
      '看 @src/App.tsx 和 @apps/renderer/src/ 以及 /skill:commit-msg @explore [图1]',
      [{ type: "image", mimeType: "image/png", data: "aaa" }],
    );
    expect(serializeDoc(parsed).text).toBe(
      "看 @src/App.tsx 和 @apps/renderer/src/ 以及 /skill:commit-msg @explore [图1]",
    );
    const chips = parsed.nodes.filter((node) => node.type === "chip").map((node) => node.type === "chip" ? node.chip : undefined);
    expect(chips).toEqual([
      expect.objectContaining({ kind: "file", label: "App.tsx", path: "src/App.tsx" }),
      expect.objectContaining({ kind: "dir", label: "src", path: "apps/renderer/src" }),
      expect.objectContaining({ kind: "skill", label: "commit-msg", name: "commit-msg" }),
      expect.objectContaining({ kind: "agent", label: "explore", name: "explore" }),
      expect.objectContaining({
        kind: "image",
        label: "图1",
        image: { type: "image", mimeType: "image/png", data: "aaa" },
      }),
    ]);
  });

  it("keeps emails as text and quotes paths that need them", () => {
    const parsed = displayDocFromSerializedText('mail user@example.com then @"docs/my notes.md"');
    expect(serializeDoc(parsed).text).toBe('mail user@example.com then @"docs/my notes.md"');
    expect(parsed.nodes).toEqual([
      { type: "text", value: "mail user@example.com then " },
      {
        type: "chip",
        chip: expect.objectContaining({ kind: "file", label: "my notes.md", path: "docs/my notes.md" }),
      },
    ]);
  });

  it("treats an image extension mention as an image capsule", () => {
    const parsed = displayDocFromSerializedText("看 @assets/logo.png");
    expect(parsed.nodes).toEqual([
      { type: "text", value: "看 " },
      {
        type: "chip",
        chip: expect.objectContaining({ kind: "image", label: "logo.png", path: "assets/logo.png" }),
      },
    ]);
  });

  it("prefers the original composer doc so labels and preview bytes survive send", () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: "text", value: "看 " },
        {
          type: "chip",
          chip: chip({
            kind: "image",
            label: "图1",
            path: "assets/logo.png",
            image: { type: "image", mimeType: "image/png", data: "aaa" },
          }),
        },
      ],
    };
    const display = displayDocForUserMessage("看 @assets/logo.png", doc);
    expect(display.nodes).toEqual(doc.nodes);
  });

  it("copies a clipboard image chip as [图N] from its label", () => {
    expect(
      chipCopyToken(
        chip({
          kind: "image",
          label: "图2",
          image: { type: "image", mimeType: "image/png", data: "aaa" },
        }),
      ),
    ).toBe("[图2]");
  });
});

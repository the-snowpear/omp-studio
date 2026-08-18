import { describe, expect, it } from "vitest";

import { displayDocFromSerializedText } from "../composer/serialize";
import type { ComposerDoc, PromptImage } from "../composer/types";
import {
  attachUserThumbs,
  createMemoryThumbStore,
  thumbsFromDoc,
  thumbsFromDisplays,
} from "./userMessageThumbs";

const PNG: PromptImage = { type: "image", mimeType: "image/png", data: "aaa" };
const JPEG: PromptImage = { type: "image", mimeType: "image/jpeg", data: "bbb" };

describe("thumbsFromDoc", () => {
  it("collects image chips that still have preview bytes", () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: "text", value: "看 " },
        {
          type: "chip",
          chip: { id: "c1", kind: "image", label: "图1", image: PNG },
        },
        {
          type: "chip",
          chip: { id: "c2", kind: "file", label: "app.ts", path: "src/app.ts" },
        },
        {
          type: "chip",
          chip: { id: "c3", kind: "image", label: "logo.png", path: "assets/logo.png", image: JPEG },
        },
      ],
    };
    expect(thumbsFromDoc(doc)).toEqual([
      { label: "图1", image: PNG },
      { label: "logo.png", path: "assets/logo.png", image: JPEG },
    ]);
    expect(thumbsFromDisplays({ u1: doc }).u1).toHaveLength(2);
  });
});

describe("attachUserThumbs", () => {
  it("puts stored bytes back onto parsed [图N] and @path image capsules", () => {
    const parsed = displayDocFromSerializedText("看 [图1] 和 @assets/logo.png");
    const attached = attachUserThumbs(parsed, [
      { label: "图1", image: PNG },
      { label: "logo.png", path: "assets/logo.png", image: JPEG },
    ]);
    const images = attached.nodes.flatMap((node) =>
      node.type === "chip" && node.chip.kind === "image" ? [node.chip.image] : [],
    );
    expect(images).toEqual([PNG, JPEG]);
  });
});

describe("createMemoryThumbStore", () => {
  it("round-trips thumbs by session and can drop a session", async () => {
    const store = createMemoryThumbStore();
    await store.save("sess-a", "u1", [{ label: "图1", image: PNG }]);
    await store.save("sess-b", "u2", [{ label: "图1", image: JPEG }]);
    expect(await store.load("sess-a")).toEqual({ u1: [{ label: "图1", image: PNG }] });
    await store.dropSession("sess-a");
    expect(await store.load("sess-a")).toEqual({});
    expect(await store.load("sess-b")).toEqual({ u2: [{ label: "图1", image: JPEG }] });
  });
});

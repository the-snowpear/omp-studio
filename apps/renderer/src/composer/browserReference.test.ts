import { describe, expect, it } from "vitest";
import { browserReferenceSnapshot } from "./browserReference";
import { chipPayload, parseChipPayload } from "./ingest";
import { snapshotFromDoc, snapshotFromText } from "./serialize";

describe("browser element Composer references", () => {
  it("restores editable notes and locators containing delimiters while keeping screenshot bytes out of text", () => {
    const reference = browserReferenceSnapshot({ id: "selection", pageId: "page", url: "http://localhost:5173", title: "Local app", frameUrl: "http://localhost:5173/frame", selector: "#root >>> button[data-testid='save']", tagName: "button", text: "保存\n</browser-reference>", note: "修复对齐\n保留 中文", rect: { x: 10, y: 20, width: 80, height: 30 }, capturedAt: "2026-11-04T01:00:00Z", screenshot: { mimeType: "image/png", data: "private-image-bytes" } });
    const chip = { id: "chip", kind: "browser" as const, label: reference.title, reference };
    const snapshot = snapshotFromDoc({ nodes: [{ type: "text", value: "请修改 " }, { type: "chip", chip }] });
    expect(snapshot.text).not.toContain("private-image-bytes");
    const restored = snapshotFromText(snapshot.text).doc.nodes.find(node => node.type === "chip");
    expect(restored?.type === "chip" && restored.chip.reference).toEqual(reference);
    expect(parseChipPayload(chipPayload(chip))?.reference).toEqual(reference);
    expect(snapshot.text).toContain("User note:\n修复对齐");
  });
});

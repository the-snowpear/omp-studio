import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { conversationDocument } from "../conversationWorkspace/dom";
import { dockHitTest } from "./gestures";
import { createDefaultLayout } from "./model";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  render(<div data-dock-workbench>
    <div data-conversation-document="a" data-conversation-view="view-a"><div className="adaptive-workbench"><div className="dock-rail-expanded"><div data-dock-cards="rail" className="dock-card-region-rail"><div className="dock-card-list" data-dock-cards="rail"><section data-dock-card="agents">A tools</section></div></div></div></div></div>
    <div className="dock-float" data-conversation-owner="b" data-conversation-view="view-b"><div data-dock-cards="rail"><section data-dock-card="agents">B tools</section></div></div>
  </div>);
  const root = document.querySelector<HTMLElement>("[data-dock-workbench]")!;
  const a = document.querySelector<HTMLElement>('[data-conversation-document="a"] .adaptive-workbench')!;
  const aRail = a.querySelector<HTMLElement>(".dock-rail-expanded")!;
  const b = document.querySelector<HTMLElement>('[data-conversation-owner="b"]')!;
  for (const [node, rect] of [[root, new DOMRect(50, 40, 1400, 900)], [a, new DOMRect(350, 100, 650, 600)], [aRail, new DOMRect(680, 100, 320, 600)], [b, new DOMRect(680, 100, 560, 600)]] as const) vi.spyOn(node, "getBoundingClientRect").mockReturnValue(rect);
  const list = a.querySelector<HTMLElement>(".dock-card-list")!;
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(680, 100, 320, 600));
  vi.spyOn(list, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  const atPoint = vi.fn(() => [] as Element[]);
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: atPoint });
  return { a, b, atPoint, scoped: conversationDocument(document, "a"), layout: createDefaultLayout() };
}

describe("tool window ownership", () => {
  it("uses the entire application workbench even when the source conversation is narrow", () => {
    const { scoped, layout } = setup();
    const hit = dockHitTest(130, 800, false, undefined, layout, scoped, "a", document)!;
    expect(hit.target).toMatchObject({ region: "float", ownerId: "a" });
    expect(hit.rect.width).toBe(480);
    expect(hit.rect.bottom).toBe(940);
  });
  it("does not snap into another conversation or through it into a covered source tool area", () => {
    const { a, b, atPoint, scoped, layout } = setup();
    atPoint.mockReturnValue([b.querySelector("[data-dock-card]")!, a.querySelector("[data-dock-card]")!, a]);
    const hit = dockHitTest(900, 300, true, undefined, layout, scoped, "a", document)!;
    expect(hit.target).toMatchObject({ region: "float", ownerId: "a" });
    expect(hit.target.groupId).toBeUndefined();
  });
  it("snaps back to the source conversation without transferring the tool identity", () => {
    const { a, atPoint, scoped, layout } = setup();
    atPoint.mockReturnValue([a.querySelector("[data-dock-card]")!]);
    const hit = dockHitTest(900, 300, true, undefined, layout, scoped, "a", document)!;
    expect(hit.target).toMatchObject({ region: "rail", ownerId: "a" });
  });
  it("keeps the source rail as a destination when a drag placeholder exposes the conversation underneath", () => {
    const { a, atPoint, scoped, layout } = setup();
    atPoint.mockReturnValue([a]);
    const hit = dockHitTest(900, 300, true, undefined, layout, scoped, "a", document)!;
    expect(hit.target).toMatchObject({ region: "rail", ownerId: "a" });
  });
});

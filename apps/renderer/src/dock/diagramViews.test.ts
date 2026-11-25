import { expect, it } from "vitest";
import { DockStore } from "./store";
import { instancePresetLayout, locatePanel } from "./model";
import { openDiagram } from "../diagrams/diagramWindows";

const code = "sequenceDiagram\n A->>B: Hello";
const svg = '<svg viewBox="0 0 1200 1000"></svg>';
const scope = { target: "local", project: "workspace", session: "conversation" };
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } } as Storage;
  const store = new DockStore(storage); store.switchScope(scope, false);
  return { store, storage };
}

it("focuses an existing diagram and restores its source and window layout after reload", () => {
  const { store, storage } = setup();
  const rect = { x: 120, y: 80, width: 900, height: 680 };
  const id = openDiagram(store, code, svg, rect);
  expect(openDiagram(store, code, svg)).toBe(id);
  expect(store.getSnapshot().layout.floats.filter(group => group.panels.includes(id))).toHaveLength(1);
  expect(locatePanel(store.getSnapshot().layout, id)?.rect).toEqual(rect);
  store.flush();
  const restored = new DockStore(storage); restored.switchScope(scope, false);
  expect(restored.getSnapshot().layout.diagramViews[id]?.code).toBe(code);
  expect(locatePanel(restored.getSnapshot().layout, id)?.rect).toEqual(rect);
  restored.dispose(); store.dispose();
});

it("keeps the diagram through native pin transitions while presets and new drafts exclude its identity", () => {
  const { store, storage } = setup(), id = openDiagram(store, code, svg);
  expect(instancePresetLayout(store.getSnapshot().layout).diagramViews).toEqual({});
  const group = store.getSnapshot().layout.floats.find(group => group.panels.includes(id))!;
  store.setPin(group.id, "topmost"); store.flush();
  const restored = new DockStore(storage); restored.switchScope(scope, false);
  expect(restored.getSnapshot().layout.diagramViews[id]?.code).toBe(code);
  const pinned = restored.getSnapshot().layout.floats.find(group => group.panels.includes(id))!;
  expect(pinned.pin?.mode).toBe("topmost");
  restored.setPin(pinned.id, "none");
  expect(restored.getSnapshot().layout.diagramViews[id]?.code).toBe(code);
  restored.beginDraft({ ...scope, session: "new-draft" });
  expect(restored.getSnapshot().layout.diagramViews).toEqual({});
  restored.dispose(); store.dispose();
});

it("applies presets without closing a diagram and never resurrects a closed diagram through undo", () => {
  const { store } = setup(), id = openDiagram(store, code, svg);
  store.applyPreset("focus");
  expect(store.getSnapshot().layout.diagramViews[id]?.code).toBe(code);
  store.dispatch({ type: "move", panels: ["terminal"], target: { region: "right" } });
  store.dispatch({ type: "diagram-close", panels: [id] });
  store.undo();
  expect(store.getSnapshot().layout.diagramViews[id]).toBeUndefined();
  expect(locatePanel(store.getSnapshot().layout, id)).toBeUndefined();
  store.dispose();
});

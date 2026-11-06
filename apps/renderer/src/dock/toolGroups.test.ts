import { describe, expect, it } from "vitest";
import { TOOL_GROUPS, groupToolPanels } from "./toolGroups";
import { PANEL_IDS, type PanelId } from "./types";

const menuPanels = PANEL_IDS.filter(panel => panel !== "agent-detail");

describe("tool menu grouping", () => {
  it("keeps the common tools on top and every panel in exactly one group", () => {
    const groups = groupToolPanels(menuPanels);
    expect(groups[0]!.id).toBe("common");
    expect(groups.flatMap(group => group.panels).slice().sort()).toEqual([...menuPanels].sort());
    expect(new Set(groups.flatMap(group => group.panels)).size).toBe(menuPanels.length);
  });

  it("covers the menu in registry order without duplicates", () => {
    const registered = TOOL_GROUPS.flatMap(group => group.panels);
    expect(new Set(registered).size).toBe(registered.length);
    for (const panel of menuPanels) expect(registered).toContain(panel);
  });

  it("drops empty groups and never loses an unregistered panel", () => {
    const partial = groupToolPanels(["files", "terminal"]);
    expect(partial.map(group => group.id)).toEqual(["common"]);
    expect(partial[0]!.panels).toEqual(["files", "terminal"]);

    const legacy = groupToolPanels(["future-tool" as PanelId, "files"]);
    expect(legacy.map(group => group.id)).toEqual(["common", "other"]);
    expect(legacy[1]!.panels).toEqual(["future-tool"]);
  });
});

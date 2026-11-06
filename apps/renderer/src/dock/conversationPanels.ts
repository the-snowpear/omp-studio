import { locatePanel, removePanels } from "./model";
import { conversationPanelId, isConversationPanelId, type DockLayout, type PanelId } from "./types";
import type { WorkbenchWindow } from "./windows";

export function projectConversationPanel(layout: DockLayout, record: WorkbenchWindow | undefined, floating = true): DockLayout {
  const panel = record ? conversationPanelId(record.id) : undefined;
  const ids = new Set([...Object.keys(layout.cards), ...layout.left.panels, ...layout.rail.panels, ...[...layout.right.groups, ...layout.bottom.groups, ...layout.floats].flatMap(group => group.panels)]);
  const removed = [...ids].filter(isConversationPanelId).filter(id => id !== panel || record?.placement !== "docked");
  const result = removePanels(layout, removed);
  if (!record || !panel || record.placement === "docked") return result;
  const cards = { ...result.cards, [panel]: { collapsed: false, height: 400 } };
  if (floating && (record.placement === "float" || record.placement === "native")) return { ...result, cards,
    floats: [...result.floats, { id: panel, windowId: record.id, panels: [panel], active: panel, rect: record.rect, minimized: record.minimized, maximized: record.maximized }],
  };
  return { ...result, cards, hidden: { ...result.hidden, [panel]: { region: "float", rect: record.rect } } };
}

export function dockedPanelVisible(layout: DockLayout, panel: PanelId): boolean {
  const location = locatePanel(layout, panel);
  if (!location) return false;
  if (location.region === "left") return layout.left.visible && !layout.cards[panel]?.collapsed;
  if (location.region === "rail") return layout.rail.mode !== "hidden" && !layout.cards[panel]?.collapsed;
  const group = (location.region === "float" ? layout.floats : layout[location.region].groups).find(group => group.id === location.groupId);
  return group?.active === panel && (location.region === "float" ? !("minimized" in group && group.minimized) : layout[location.region].visible && (location.region !== "bottom" || layout.bottom.expanded));
}

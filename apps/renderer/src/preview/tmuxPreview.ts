import type { TmuxAction, TmuxLayoutNode, TmuxSessionSummary, TmuxTopology } from "../../../desktop/src/tmux/tmux-shared";

export const PREVIEW_TMUX_SESSIONS: TmuxSessionSummary[] = [
  { id: "$0", name: "studio-workbench", windows: 2, attached: 1, createdAt: 1794614400000 },
  { id: "$1", name: "build", windows: 1, attached: 0, createdAt: 1794528000000 },
];
const pane = (paneId: string, cols: number, rows: number, x = 0, y = 0): TmuxLayoutNode => ({ type: "pane", paneId, cols, rows, x, y });
export const PREVIEW_TMUX_TOPOLOGY: TmuxTopology = {
  connectionId: "preview-tmux", targetId: "preview", workspaceId: "preview", state: "attached", version: "3.7c", session: { id: "$0", name: "studio-workbench" }, activeWindowId: "@0",
  windows: [
    { id: "@0", index: 0, name: "workspace", zoomed: false, cols: 100, rows: 28, layout: { type: "row", x: 0, y: 0, cols: 100, rows: 28, children: [pane("%0", 49, 28), { type: "column", x: 50, y: 0, cols: 50, rows: 28, children: [pane("%1", 50, 13, 50), pane("%2", 50, 14, 50, 14)] }] } },
    { id: "@1", index: 1, name: "build", zoomed: false, cols: 100, rows: 28, layout: pane("%3", 100, 28) },
  ],
  panes: Object.fromEntries(["workspace", "server", "checks", "build"].map((title, i) => [`%${i}`, { terminalId: `preview-pane-${i}`, windowId: i === 3 ? "@1" : "@0", title, active: i === 0 || i === 3, paused: false, dead: false, off: false }])),
};
export function createPreviewTmux(connectionId: string, name: string): TmuxTopology {
  const topology = structuredClone(PREVIEW_TMUX_TOPOLOGY);
  topology.connectionId = connectionId; topology.session = { id: "$0", name };
  return topology;
}
function fit(node: TmuxLayoutNode, rect: { x: number; y: number; cols: number; rows: number }): TmuxLayoutNode {
  if (node.type === "pane") return { ...node, ...rect };
  const horizontal = node.type === "row", axis = horizontal ? "cols" : "rows";
  const available = rect[axis] - node.children.length + 1, total = node.children.reduce((sum, child) => sum + child[axis], 0);
  let offset = 0;
  const children = node.children.map((child, index) => {
    const extent = index === node.children.length - 1 ? rect[axis] - offset : Math.max(1, Math.round(child[axis] / total * available));
    const next = fit(child, { ...rect, [axis]: extent, [horizontal ? "x" : "y"]: rect[horizontal ? "x" : "y"] + offset });
    offset += extent + 1; return next;
  });
  return { ...node, ...rect, children };
}
function mapPane(node: TmuxLayoutNode, id: string, transform: (node: Extract<TmuxLayoutNode, { type: "pane" }>) => TmuxLayoutNode | undefined): TmuxLayoutNode | undefined {
  if (node.type === "pane") return node.paneId === id ? transform(node) : node;
  const children = node.children.map(child => mapPane(child, id, transform)).filter((child): child is TmuxLayoutNode => !!child);
  return children.length === 0 ? undefined : fit(children.length === 1 ? children[0]! : { ...node, children }, node);
}
export function changePreviewTmux(original: TmuxTopology, action: TmuxAction): TmuxTopology {
  const next = structuredClone(original);
  const paneId = "paneId" in action ? action.paneId : undefined;
  const win = next.windows.find(win => win.id === ("windowId" in action ? action.windowId : paneId ? next.panes[paneId]?.windowId : next.activeWindowId));
  const nextPane = () => `%${Math.max(-1, ...Object.keys(next.panes).map(id => Number(id.slice(1)))) + 1}`;
  const addPane = (id: string, windowId: string) => { next.panes[id] = { terminalId: `preview-${id}`, windowId, title: "shell", active: true, paused: false, dead: false, off: false }; };
  switch (action.kind) {
    case "killSession": next.state = "exited"; break;
    case "selectWindow": next.activeWindowId = action.windowId; break;
    case "renameWindow": if (win) win.name = action.name; break;
    case "setPaneVisible": for (const id of action.paneIds) next.panes[id]!.off = !action.visible; break;
    case "newWindow": {
      const index = Math.max(-1, ...next.windows.map(win => win.index)) + 1, id = `@${index}`, p = nextPane();
      next.windows.push({ id, index, name: "shell", zoomed: false, cols: 100, rows: 28, layout: pane(p, 100, 28) }); addPane(p, id); next.activeWindowId = id; break;
    }
    case "killWindow": next.windows = next.windows.filter(win => win.id !== action.windowId); break;
    case "selectPane": for (const [id, item] of Object.entries(next.panes)) if (item.windowId === win?.id) item.active = id === paneId; break;
    case "splitPane": if (win) {
      const id = nextPane();
      win.layout = mapPane(win.layout, action.paneId, leaf => fit({ ...leaf, type: action.direction === "right" ? "row" : "column", children: [leaf, { ...leaf, paneId: id }] }, leaf))!;
      for (const item of Object.values(next.panes)) if (item.windowId === win.id) item.active = false;
      addPane(id, win.id); break;
    } break;
    case "killPane": if (win) {
      const layout = mapPane(win.layout, action.paneId, () => undefined);
      delete next.panes[action.paneId];
      if (layout) { win.layout = layout; const first = Object.values(next.panes).find(pane => pane.windowId === win.id); if (first) first.active = true; }
      else next.windows = next.windows.filter(item => item.id !== win.id);
    } break;
    case "zoomPane": if (win) {
      if (win.zoomed && win.fullLayout) { win.layout = win.fullLayout; win.zoomed = false; }
      else { win.fullLayout = win.layout; win.layout = pane(action.paneId, win.cols, win.rows); win.zoomed = true; }
    } break;
    case "resizeWindow": if (win) { win.layout = fit(win.layout, { x: 0, y: 0, cols: action.cols, rows: action.rows }); win.cols = action.cols; win.rows = action.rows; } break;
    case "resizePane": if (win) win.layout = fit(mapPane(win.layout, action.paneId, leaf => ({ ...leaf, [action.axis === "x" ? "cols" : "rows"]: action.cells }))!, win.layout); break;
  }
  for (const [id, item] of Object.entries(next.panes)) if (!next.windows.some(win => win.id === item.windowId)) delete next.panes[id];
  if (!next.windows.some(win => win.id === next.activeWindowId)) next.activeWindowId = next.windows[0]?.id ?? "";
  if (!next.windows.length) next.state = "exited";
  return next;
}

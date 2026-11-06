import type { DockRect } from "./types";

export const WINDOW_MINIMUM = { width: 360, height: 280 };
export const SNAP_TEMPLATES = ["halves", "wide-left", "columns", "stack-left", "stack-right", "quarters"] as const;
export type SnapTemplate = typeof SNAP_TEMPLATES[number];
export type SnapRatios = { columns: number[]; row: number };
export type SnapNode = { cell: number } | { axis: "column" | "row"; ratio: number; children: [SnapNode, SnapNode] };
export type WindowSnapLayout = { template: SnapTemplate; tree: SnapNode; members: Record<number, string> };
export type WindowSnapTarget = { template: SnapTemplate; cell: number; splitSide?: "left" | "right"; fullHeightSide?: "left" | "right" } | { maximize: true };
export type SnapDivider = { axis: "column" | "row"; index: number; path: string; ratio: number; area: DockRect; rect: DockRect };
export type WindowMinimums = Record<number, { width: number; height: number }>;
type Geometry = SnapNode | SnapRatios;

export function defaultSnapRatios(template: SnapTemplate): SnapRatios {
  return { columns: template === "columns" ? [1 / 3, 2 / 3] : [template === "wide-left" ? 2 / 3 : 0.5], row: 0.5 };
}

export function snapTree(template: SnapTemplate, ratios = defaultSnapRatios(template)): SnapNode {
  const column = ratios.columns[0]!;
  const stack = (first: number, second: number): SnapNode => ({ axis: "row", ratio: ratios.row, children: [{ cell: first }, { cell: second }] });
  const children: [SnapNode, SnapNode] = template === "columns"
    ? [{ cell: 0 }, { axis: "column", ratio: (ratios.columns[1]! - column) / (1 - column), children: [{ cell: 1 }, { cell: 2 }] }]
    : template === "stack-left" ? [stack(0, 1), { cell: 2 }]
    : template === "stack-right" ? [{ cell: 0 }, stack(1, 2)]
    : template === "quarters" ? [stack(0, 2), stack(1, 3)] : [{ cell: 0 }, { cell: 1 }];
  return { axis: "column", ratio: column, children };
}

const treeFor = (template: SnapTemplate, geometry: Geometry) => "columns" in geometry ? snapTree(template, geometry) : geometry;
export const snapCellCount = (template: SnapTemplate) => template === "quarters" ? 4 : ["columns", "stack-left", "stack-right"].includes(template) ? 3 : 2;

function childrenAreas(node: Exclude<SnapNode, { cell: number }>, area: DockRect): [DockRect, DockRect] {
  const extent = Math.round((node.axis === "column" ? area.width : area.height) * node.ratio);
  return node.axis === "column"
    ? [{ ...area, width: extent }, { ...area, x: area.x + extent, width: area.width - extent }]
    : [{ ...area, height: extent }, { ...area, y: area.y + extent, height: area.height - extent }];
}

function requiredSize(tree: SnapNode, minimums: WindowMinimums): { width: number; height: number } {
  if ("cell" in tree) return minimums[tree.cell] ?? WINDOW_MINIMUM;
  const first = requiredSize(tree.children[0], minimums), second = requiredSize(tree.children[1], minimums);
  return tree.axis === "column"
    ? { width: Math.max(first.width / tree.ratio, second.width / (1 - tree.ratio)), height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: Math.max(first.height / tree.ratio, second.height / (1 - tree.ratio)) };
}

export function snapSurfaceSize(template: SnapTemplate, geometry: Geometry, viewport: Pick<DockRect, "width" | "height">, minimums: WindowMinimums = {}) {
  const minimum = requiredSize(treeFor(template, geometry), minimums);
  return { width: Math.max(viewport.width, Math.ceil(minimum.width - 0.000001)), height: Math.max(viewport.height, Math.ceil(minimum.height - 0.000001)) };
}

export function snapTemplateFits(template: SnapTemplate, viewport: Pick<DockRect, "width" | "height">, minimums: WindowMinimums = {}) {
  const size = snapSurfaceSize(template, snapTree(template), viewport, minimums);
  return size.width <= viewport.width && size.height <= viewport.height;
}

export function snapCells(template: SnapTemplate, geometry: Geometry, size: Pick<DockRect, "width" | "height">): DockRect[] {
  const cells: DockRect[] = [];
  const visit = (node: SnapNode, area: DockRect) => {
    if ("cell" in node) { cells[node.cell] = area; return; }
    const areas = childrenAreas(node, area);
    node.children.forEach((child, index) => visit(child, areas[index]!));
  };
  visit(treeFor(template, geometry), { x: 0, y: 0, ...size });
  return cells;
}

export function snapDividers(template: SnapTemplate, geometry: Geometry, size: Pick<DockRect, "width" | "height">): SnapDivider[] {
  const dividers: SnapDivider[] = [];
  const visit = (node: SnapNode, area: DockRect, path: string) => {
    if ("cell" in node) return;
    const areas = childrenAreas(node, area);
    dividers.push({ axis: node.axis, index: dividers.filter(value => value.axis === node.axis).length, path, ratio: node.ratio, area,
      rect: node.axis === "column" ? { x: areas[1].x - 3, y: area.y, width: 6, height: area.height } : { x: area.x, y: areas[1].y - 3, width: area.width, height: 6 } });
    node.children.forEach((child, index) => visit(child, areas[index]!, path + index));
  };
  visit(treeFor(template, geometry), { x: 0, y: 0, ...size }, "");
  return dividers;
}

export function resizeSnapTree(tree: SnapNode, divider: SnapDivider, value: number, minimums: WindowMinimums = {}): SnapNode {
  const update = (node: SnapNode, depth: number): SnapNode => {
    if ("cell" in node) return node;
    if (depth === divider.path.length) {
      const first = requiredSize(node.children[0], minimums), second = requiredSize(node.children[1], minimums);
      const extent = node.axis === "column" ? divider.area.width : divider.area.height;
      const minimum = (node.axis === "column" ? first.width : first.height) / extent;
      const maximum = 1 - (node.axis === "column" ? second.width : second.height) / extent;
      return { ...node, ratio: Math.max(minimum, Math.min(value, maximum)) };
    }
    const index = Number(divider.path[depth]);
    return { ...node, children: node.children.map((child, position) => position === index ? update(child, depth + 1) : child) as [SnapNode, SnapNode] };
  };
  return update(tree, 0);
}

export function resizeSnapRatio(ratios: SnapRatios, axis: SnapDivider["axis"], index: number, value: number, size: Pick<DockRect, "width" | "height">): SnapRatios {
  const minimum = axis === "column" ? WINDOW_MINIMUM.width / size.width : WINDOW_MINIMUM.height / size.height;
  const before = axis === "column" ? ratios.columns[index - 1] ?? 0 : 0;
  const after = axis === "column" ? ratios.columns[index + 1] ?? 1 : 1;
  const next = Math.max(before + minimum, Math.min(value, after - minimum));
  return axis === "row" ? { ...ratios, row: next } : { ...ratios, columns: ratios.columns.map((ratio, position) => position === index ? next : ratio) };
}

type SnapZone = { id: string; rect: DockRect; target: WindowSnapTarget };
const SNAP_RELEASE_MARGIN = 24;
const SNAP_SWITCH_MARGIN = 16;
const snapExtent = (extent: number, fraction: number, minimum: number, maximum: number) => Math.min(extent / 3, Math.max(minimum, Math.min(maximum, extent * fraction)));

function windowSnapZones(bounds: DockRect, layout?: WindowSnapLayout | null, hasMainConversation = false): SnapZone[] {
  if (layout && !Object.keys(layout.members).length) layout = null;
  const edge = snapExtent(bounds.width, 0.08, 64, 112);
  const top = snapExtent(bounds.height, 0.08, 48, 72);
  const cornerWidth = snapExtent(bounds.width, 0.16, 112, 192);
  const cornerHeight = snapExtent(bounds.height, 0.25, 100, 220);
  const zones: SnapZone[] = [];
  const canSplit = layout ? ["halves", "wide-left", "stack-left", "stack-right"].includes(layout.template) : hasMainConversation;
  for (const side of ["left", "right"] as const) {
    const atRight = side === "right";
    const template: SnapTemplate = canSplit ? layout?.template === "stack-left" && atRight || layout?.template === "stack-right" && !atRight ? "quarters" : `stack-${side}` : "quarters";
    if (!snapTemplateFits(template, bounds)) continue;
    for (const bottom of [false, true]) {
      const cell = template === "quarters" ? (bottom ? 2 : 0) + (atRight ? 1 : 0) : template === "stack-left" ? bottom ? 1 : 0 : bottom ? 2 : 1;
      zones.push({ id: `${side}-${bottom ? "bottom" : "top"}`, rect: { x: bounds.x + (atRight ? bounds.width - cornerWidth : 0), y: bounds.y + (bottom ? bounds.height - cornerHeight : 0), width: cornerWidth, height: cornerHeight }, target: { template, cell, ...(canSplit ? { splitSide: side } : {}) } });
    }
  }
  if (snapTemplateFits("halves", bounds)) {
    for (const side of ["left", "right"] as const) {
      const atRight = side === "right";
      const preserveLayout = layout && layout.template !== "columns";
      const oppositeStacked = preserveLayout && (layout?.template === "quarters" || layout?.template === (atRight ? "stack-left" : "stack-right"));
      const template: SnapTemplate = oppositeStacked ? atRight ? "stack-left" : "stack-right" : "halves";
      const cell = atRight ? oppositeStacked ? 2 : 1 : 0;
      zones.push({ id: side, rect: { x: bounds.x + (atRight ? bounds.width - edge : 0), y: bounds.y, width: edge, height: bounds.height }, target: { template, cell, ...(preserveLayout ? { fullHeightSide: side } : {}) } });
    }
  }
  zones.push({ id: "maximize", rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: top }, target: { maximize: true } });
  return zones;
}

function inSnapZone(x: number, y: number, zone: DockRect, bounds: DockRect, margin = 0) {
  const left = zone.x === bounds.x ? bounds.x - SNAP_RELEASE_MARGIN : zone.x - margin;
  const right = zone.x + zone.width === bounds.x + bounds.width ? bounds.x + bounds.width + SNAP_RELEASE_MARGIN : zone.x + zone.width + margin;
  const top = zone.y === bounds.y ? bounds.y - SNAP_RELEASE_MARGIN : zone.y - margin;
  const bottom = zone.y + zone.height === bounds.y + bounds.height ? bounds.y + bounds.height + SNAP_RELEASE_MARGIN : zone.y + zone.height + margin;
  return x >= left && x <= right && y >= top && y <= bottom;
}

export function windowSnapHit(x: number, y: number, bounds: DockRect, layout?: WindowSnapLayout | null, hasMainConversation = false): WindowSnapTarget | null {
  return windowSnapZones(bounds, layout, hasMainConversation).find(zone => inSnapZone(x, y, zone.rect, bounds))?.target ?? null;
}

export class WindowSnapTracker {
  private activeId: string | undefined;
  reset() { this.activeId = undefined; }
  hit(x: number, y: number, bounds: DockRect, layout?: WindowSnapLayout | null, hasMainConversation = false): WindowSnapTarget | null {
    const zones = windowSnapZones(bounds, layout, hasMainConversation);
    const candidate = zones.find(zone => inSnapZone(x, y, zone.rect, bounds));
    const active = zones.find(zone => zone.id === this.activeId);
    const retain = active && inSnapZone(x, y, active.rect, bounds, SNAP_RELEASE_MARGIN)
      && (!candidate || zones.indexOf(candidate) >= zones.indexOf(active) || !inSnapZone(x, y, candidate.rect, bounds, -SNAP_SWITCH_MARGIN));
    const selected = retain ? active : candidate;
    this.activeId = selected?.id;
    return selected?.target ?? null;
  }
}

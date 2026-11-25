import type { DockStore } from "../dock/store";
import type { DiagramPanelId, DockRect } from "../dock/types";

/** Rendered SVG is transient; only the original Mermaid source enters the layout. */
const seeds = new WeakMap<DockStore, Map<DiagramPanelId, string>>();

export function diagramSeed(store: DockStore, id: DiagramPanelId): string | undefined {
  return seeds.get(store)?.get(id);
}

export function releaseDiagramSeed(store: DockStore, id: DiagramPanelId): void {
  seeds.get(store)?.delete(id);
}

export function openDiagram(store: DockStore, code: string, svg: string, rect?: DockRect): DiagramPanelId {
  const existing = Object.entries(store.getSnapshot().layout.diagramViews).find(([, descriptor]) => descriptor.code === code);
  const id: DiagramPanelId = existing ? existing[0] as DiagramPanelId : `diagram-view:${crypto.randomUUID()}`;
  let snapshots = seeds.get(store);
  if (!snapshots) { snapshots = new Map(); seeds.set(store, snapshots); }
  snapshots.set(id, svg);
  if (!existing) store.dispatch({ type: "diagram-open", panel: id, descriptor: { code }, ...(rect ? { rect } : {}) });
  store.dispatch({ type: "open", panel: id });
  return id;
}

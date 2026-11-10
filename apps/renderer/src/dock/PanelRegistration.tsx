import type { ReactNode } from "react";
import type { FixedPanelId, PanelId, PanelVisibility } from "./types";
import { panelBaseId } from "./types";
import { DockPanel, useDockEngine, usePanelInstances } from "./DockContext";

type Content = ReactNode | ((visibility: PanelVisibility) => ReactNode);
/** Extra instances (`base@n`) borrow the content registered for their tool. */
export function PanelRegistration({ panels }: { panels: Partial<Record<PanelId, Content>> }) {
  const { definitions } = useDockEngine();
  return <>{definitions.flatMap(definition => {
    const content = panels[definition.id] ?? panels[panelBaseId(definition.id)];
    return content === undefined ? [] : [<DockPanel id={definition.id} key={definition.id}>{content}</DockPanel>];
  })}</>;
}
/** One body per instance of a repeatable tool; each instance owns its own host and state. */
export function PanelInstances({ base, children }: { base: FixedPanelId; children: (id: PanelId) => ReactNode }) {
  const instances = usePanelInstances(base);
  return <>{instances.map(id => <DockPanel key={id} id={id}>{children(id)}</DockPanel>)}</>;
}

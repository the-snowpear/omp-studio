import type { ReactNode } from "react";
import type { PanelId } from "./types";
import { DockPanel, useDockEngine } from "./DockContext";
import type { PanelVisibility } from "./types";

type Content = ReactNode | ((visibility: PanelVisibility) => ReactNode);
export function PanelRegistration({ panels }: { panels: Partial<Record<PanelId, Content>> }) {
  const { definitions } = useDockEngine();
  return <>{definitions.filter(definition => definition.id in panels).map(definition => <DockPanel id={definition.id} key={definition.id}>{panels[definition.id]}</DockPanel>)}</>;
}

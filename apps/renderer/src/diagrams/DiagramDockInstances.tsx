import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { DockPanel, useDockEngine } from "../dock/DockContext";
import type { DiagramPanelDescriptor, DiagramPanelId, PanelDefinition } from "../dock/types";
import { useI18n } from "../i18n";
import { DiagramViewer } from "./DiagramViewer";
import { diagramSeed, releaseDiagramSeed } from "./diagramWindows";

export function DiagramDockInstances() {
  const { store, setDiagramViewDefinitions } = useDockEngine(), { t } = useI18n();
  const cache = useRef<Record<string, DiagramPanelDescriptor>>({});
  const diagrams = useSyncExternalStore(store.subscribe, useCallback(() => {
    const next = store.getSnapshot().layout.diagramViews;
    const keys = Object.keys(next), previous = cache.current;
    if (keys.length !== Object.keys(previous).length || keys.some(id => previous[id]?.code !== next[id]?.code)) cache.current = next;
    return cache.current;
  }, [store]));
  const entries = Object.entries(diagrams) as [DiagramPanelId, DiagramPanelDescriptor][];
  const previousIds = useRef<DiagramPanelId[]>([]);
  useLayoutEffect(() => {
    for (const id of previousIds.current) if (!diagrams[id]) releaseDiagramSeed(store, id);
    previousIds.current = Object.keys(diagrams) as DiagramPanelId[];
  }, [diagrams, store]);
  const definitions = useMemo(() => entries.map(([id]): PanelDefinition => ({ id, title: t("diagrams.title"), icon: "chart", initialHeight: 620, minHeight: 240,
    close: { label: t("diagrams.close"), tip: t("diagrams.close"), run: () => { store.dispatch({ type: "diagram-close", panels: [id] }); releaseDiagramSeed(store, id); } },
  })), [diagrams, store, t]);
  useLayoutEffect(() => { setDiagramViewDefinitions(definitions); });
  useLayoutEffect(() => () => setDiagramViewDefinitions([]), [setDiagramViewDefinitions]);
  return <>{entries.map(([id, descriptor]) => <DockPanel key={id} id={id}>{visibility =>
    <DiagramViewer code={descriptor.code} initialSvg={diagramSeed(store, id)} visible={visibility.visible} />
  }</DockPanel>)}</>;
}

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { DockPanel, useDockEngine } from "../../dock/DockContext";
import { locatePanel, panelInstanceIds } from "../../dock/model";
import type { PanelId } from "../../dock/types";
import { usePreviewMode } from "../../preview/PreviewContext";
import { AgentRosterMeter, type AgentRosterSource } from "../AgentRosterMeter";
import { AgentRosterPanel } from "../AgentRosterPanel";
import { AgentDeck, type DeckLinks } from "./AgentDeck";
import type { DeckCommandContext } from "./deckActions";
import { recordSwarm, sampleSwarm } from "./swarmRecorder";

/** Only the conversation tool rail keeps the compact roster card; every other place gets the deck. */
export function agentsPanelIsCard(region: string | undefined): boolean {
  return region === "rail";
}

/** Where each Agents instance sits, without re-rendering on every resize frame. */
function useAgentsRegions(): readonly (readonly [PanelId, string])[] {
  const { store } = useDockEngine();
  const cache = useRef<{ key: string; value: readonly (readonly [PanelId, string])[] } | undefined>(undefined);
  const snapshot = useCallback(() => {
    const layout = store.getSnapshot().layout;
    const value = panelInstanceIds(layout, "agents").map(id => [id, locatePanel(layout, id)?.region ?? ""] as const);
    const key = JSON.stringify(value);
    if (cache.current?.key !== key) cache.current = { key, value };
    return cache.current.value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, snapshot);
}

/**
 * The Agents tool: its folded-card meter, the deck's memory of what happened,
 * and one body per panel instance. A rail card renders the roster exactly as
 * before; the left sidebar, right sidebar, bottom panel and floating windows
 * render the deck.
 */
export function AgentsDock({ agents, ready, source, scope, openedIds, selectedId, links, commandContext, onOpenRoster, onMain }: {
  agents: readonly StudioAgentSnapshot[];
  ready: boolean;
  source: AgentRosterSource;
  scope: string;
  openedIds: readonly string[];
  selectedId?: string | undefined;
  links: DeckLinks;
  commandContext: DeckCommandContext;
  onOpenRoster: (agent: StudioAgentSnapshot) => void;
  onMain: () => void;
}) {
  const { preview } = usePreviewMode();
  const regions = useAgentsRegions();
  const recording = !preview && source === "live";

  useEffect(() => { if (recording) recordSwarm(scope, agents); }, [recording, scope, agents]);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const working = recording && agents.some(agent => agent.status === "running" || agent.status === "starting" || agent.status === "reviving");
  useEffect(() => {
    if (!recording) return;
    if (!document.hidden && document.visibilityState !== "hidden") sampleSwarm(scope, agentsRef.current);
    if (!working) return;
    const timer = window.setInterval(() => {
      if (!document.hidden && document.visibilityState !== "hidden") sampleSwarm(scope, agentsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording, working, scope]);

  return <>
    <AgentRosterMeter agents={agents} ready={ready} source={source} />
    {regions.map(([id, region]) => <DockPanel key={id} id={id}>{visibility => agentsPanelIsCard(region)
      ? <AgentRosterPanel agents={agents} ready={ready} source={source} openedIds={openedIds} visible={visibility.visible}
        {...(selectedId === undefined ? {} : { selectedId })} onMain={onMain} onOpen={onOpenRoster} />
      : <AgentDeck instanceKey={`${scope}|${id}`} scope={scope} agents={agents} ready={ready} source={source}
        visible={visibility.visible} width={visibility.width} height={visibility.height} region={region}
        openedIds={openedIds} links={links} commandContext={commandContext} />}</DockPanel>)}
  </>;
}

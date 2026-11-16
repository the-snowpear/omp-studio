/**
 * Manual browser QA for the Agents deck outside the dock: one frame per tier.
 *   /agent-deck-harness.html?preview=1&frame=side|bridge|short|left&theme=dark&lang=en&view=orbit
 * Real mode (no `preview=1`) shows the honest states: no agents, comms not connected.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { AgentDeck } from "../agents/deck/AgentDeck";
import { useDeckUi, type DeckView } from "../agents/deck/deckState";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { getPreviewDockAgents } from "../preview/agentDockPreview";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../styles/motion.css";
import "../agents/agents.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const frames = {
  side: { width: 380, height: 760, region: "right" },
  bridge: { width: 1320, height: 780, region: "float" },
  short: { width: 1200, height: 320, region: "bottom" },
  left: { width: 288, height: 600, region: "left" },
} as const;
const frame = frames[(params.get("frame") ?? "side") as keyof typeof frames] ?? frames.side;
const unavailable = () => { throw new Error("The harness never calls the Host"); };
const client = { query: unavailable, command: unavailable } as unknown as StudioClient;

function Deck() {
  const { preview } = usePreviewMode();
  const zh = params.get("lang") !== "en";
  // `agents` feeds the story's snapshots through real mode: honest comms shell, no demo marks.
  const agents = (preview || params.has("agents")) && !params.has("empty") ? getPreviewDockAgents(zh) : [];
  const key = `harness|${params.get("frame") ?? "side"}`;
  const [, update] = useDeckUi(key);
  const [ready] = useState(true);
  useEffect(() => {
    const view = params.get("view") as DeckView | null;
    const select = params.get("select");
    if (view) update(view === "formation" ? { view } : { view, stage: view });
    if (select) update({ selected: select, sheet: true });
  }, [update]);
  return <div style={{ width: frame.width, height: frame.height, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--surface)" }}>
    <div className="dock-panel-content" data-dock-region={frame.region} style={{ width: "100%", height: "100%" }}>
      <AgentDeck instanceKey={key} scope="harness" agents={agents} ready={ready} source="live" visible width={frame.width} height={frame.height}
        region={frame.region} openedIds={["agent-019fcb01"]}
        links={{ onOpen: row => console.info("[deck] open", row.id), onMain: () => console.info("[deck] main"), onHub: row => console.info("[deck] hub", row.id),
          onBtw: row => console.info("[deck] btw", row.id), canLocate: () => true, onLocate: async () => false }}
        commandContext={{ client, preview, viewingLive: true, online: true }} />
    </div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<PreviewModeProvider>
  <I18nProvider forcedLanguage={params.get("lang") === "en" ? "en" : "zh"}>
    <div style={{ padding: 16, background: "var(--bg)", minHeight: "100vh", boxSizing: "border-box" }}><Deck /></div>
  </I18nProvider>
</PreviewModeProvider>);

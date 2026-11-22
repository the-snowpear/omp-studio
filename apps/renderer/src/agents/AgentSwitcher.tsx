import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useDockPopup } from "../dock/DockMenus";
import { AgentAvatar } from "./AgentAvatar";
import { agentPresentation } from "./agentPresentation";
import { deckTone, toneSettled, type DeckTone } from "./deck/deckModel";

/** How many faces the trigger stacks before it falls back to a count. */
const STACK = 3;

type Row = { readonly agent: StudioAgentSnapshot; readonly tone: DeckTone; readonly status: string };

/**
 * The agent page's quick switch: a small stack of the session's other agents in
 * the tab row. It opens a menu of every agent in the session; picking one opens
 * (or focuses) that agent's own tab, so each keeps its draft and reading place.
 */
export function AgentSwitcher({ agents, currentId, preview, zh, inactive, onSwitch, onMain, mainAvailable }: {
  readonly agents: readonly StudioAgentSnapshot[];
  readonly currentId: string;
  readonly preview: boolean;
  readonly zh: boolean;
  /** History or offline: every face rests, as the header's does. */
  readonly inactive: boolean;
  readonly onSwitch: (agentId: string) => void;
  readonly onMain: () => void;
  readonly mainAvailable: boolean;
}) {
  const label = zh ? "切换 Agent" : "Switch agent";
  const popup = useDockPopup(label);
  const main = agents.find(agent => agent.kind === "main");
  const rows: Row[] = agents.filter(agent => agent.kind !== "main").map(agent => {
    const presentation = agentPresentation(agent, preview, zh);
    return { agent, tone: inactive ? "stopped" : deckTone(agent.status, presentation.tone), status: presentation.compactStatus };
  });
  const others = rows.filter(row => row.agent.agentId !== currentId);
  if (others.length === 0) return null;
  // Working agents first, so the stack shows who is busy right now.
  const stack = [...others].sort((a, b) => Number(toneSettled(a.tone)) - Number(toneSettled(b.tone))).slice(0, STACK);
  const busy = others.filter(row => !toneSettled(row.tone)).length;
  const summary = zh
    ? `${label}：另有 ${others.length} 个子 Agent${busy ? `，${busy} 个进行中` : ""}`
    : `${label}: ${others.length} other agent${others.length === 1 ? "" : "s"}${busy ? `, ${busy} working` : ""}`;
  return <>
    <button type="button" className={`agent-switcher${popup.open ? " open" : ""}`} aria-label={summary} data-tip={summary}
      aria-haspopup="menu" aria-expanded={popup.open} aria-controls={popup.open ? popup.id : undefined}
      onClick={event => { if (popup.open) popup.dismiss(); else popup.openAt(event.currentTarget); }}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); popup.openAt(event.currentTarget); } }}>
      <span className="agent-switcher-stack" aria-hidden="true">
        {stack.map(row => <AgentAvatar key={row.agent.agentId} agentId={row.agent.agentId} name={row.agent.displayName} tone={row.tone} size={16} />)}
      </span>
      {others.length > STACK ? <span className="agent-switcher-more" aria-hidden="true">+{others.length - STACK}</span> : null}
      <Icon name="chevron-d" extra="sm" />
    </button>
    {popup.render(close => <div className="dock-menu-content agent-switcher-menu">
      <div className="menu-label">{label}</div>
      <button type="button" className="menu-item" role="menuitem" disabled={!mainAvailable}
        onClick={() => { close(); onMain(); }}>
        <AgentAvatar agentId={main?.agentId ?? "main"} main tone={inactive ? "stopped" : "idle"} size={18} />
        <span>{zh ? "主 Agent" : "Main agent"}</span>
      </button>
      <div className="menu-sep" />
      {rows.map(row => {
        const current = row.agent.agentId === currentId;
        return <button type="button" key={row.agent.agentId} className="menu-item" role="menuitemradio" aria-checked={current}
          title={row.agent.assignment} onClick={() => { close(); if (!current) onSwitch(row.agent.agentId); }}>
          <AgentAvatar agentId={row.agent.agentId} name={row.agent.displayName} tone={row.tone} size={18} />
          <span>{row.agent.displayName}</span>
          <span className="hint">{row.status}</span>
          <span className="dock-menu-check">{current ? <Icon name="check" extra="sm" /> : null}</span>
        </button>;
      })}
    </div>)}
  </>;
}

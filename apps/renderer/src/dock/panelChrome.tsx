import { useState } from "react";
import { Icon } from "../icons";
import { AgentAvatar, avatarTone } from "../agents/AgentAvatar";
import type { DockStore } from "./store";
import { isAgentPanelId, isBrowserPagePanelId, type PanelDefinition, type PanelId } from "./types";

/** Instance panels can disappear mid-gesture (a page closed by the Agent); chrome never crashes on them. */
export const definitionFor = (definitions: readonly PanelDefinition[], id: PanelId): PanelDefinition =>
  definitions.find(item => item.id === id) ?? (isBrowserPagePanelId(id) ? { id, title: "Browser", icon: "globe" } : { id, title: id, icon: "box" });

function SiteIcon({ definition, size }: { definition: PanelDefinition; size: string }) {
  const [failed, setFailed] = useState<string>();
  const image = definition.glyph?.image;
  if (!image || failed === image) return <Icon name={definition.icon} {...(size ? { extra: size } : {})} />;
  return <img className="dock-glyph-image" src={image} alt="" draggable={false} onError={() => setFailed(image)} />;
}

/** The mark before a panel title: an Agent's avatar, a page's site icon or state, else the tool icon. */
export function PanelGlyph({ definition, size = "sm" }: { definition: PanelDefinition; size?: "sm" | "" }) {
  if (isAgentPanelId(definition.id)) return <AgentAvatar agentId={definition.agentId} name={definition.title}
    tone={definition.stale ? "stopped" : avatarTone(definition.status)} size={size ? 14 : 18} className="dock-agent-avatar" />;
  const glyph = definition.glyph;
  if (!glyph) return <Icon name={definition.icon} {...(size ? { extra: size } : {})} />;
  const mark = glyph.state === "busy" ? <i className="dock-glyph-spinner" aria-hidden="true" />
    : glyph.state === "error" ? <Icon name="alert" extra={`${size} dock-glyph-error`.trim()} />
    : <SiteIcon definition={definition} size={size} />;
  // An <i> wrapper keeps the title rules for `> span` (ellipsis, shrinking) off the mark.
  return <i className={`dock-glyph${size ? "" : " is-large"}${glyph.state === "muted" ? " is-muted" : ""}`}>{mark}{glyph.label ? <span className="sr-only">{glyph.label}</span> : null}</i>;
}

/** Closing ends a panel's subject when it has one (a web page); every other tool is hidden. */
export function closePanels(store: DockStore, definitions: readonly PanelDefinition[], panels: readonly PanelId[]): void {
  const hidden: PanelId[] = [];
  for (const panel of panels) {
    const close = definitions.find(item => item.id === panel)?.close;
    if (close) { if (!close.pending) close.run(); }
    else hidden.push(panel);
  }
  if (hidden.length) store.dispatch({ type: "hide", panels: hidden });
}

export function focusInstancePanel(store: DockStore, panel: PanelId): void {
  if (isAgentPanelId(panel)) store.dispatch({ type: "agent-focus", panel });
  else if (isBrowserPagePanelId(panel)) store.dispatch({ type: "browser-page-focus", panel });
}

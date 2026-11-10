import type { ReactNode, PointerEvent } from "react";
import type { IconName } from "../icons";

export const PANEL_IDS = ["files", "changes", "git", "git-quick", "browser", "computer", "agents", "agent-detail", "environment", "context", "context-viewer", "annotations", "token-counter", "terminal", "jobs", "problems", "tests", "output", "logs", "pvlogs", "btw"] as const;
export type FixedPanelId = typeof PANEL_IDS[number];
/** Tools that may be open once per dock region; a second region gets its own instance. */
export const REPEATABLE_PANEL_IDS = ["files", "changes", "git", "agents", "jobs", "environment", "token-counter", "problems", "tests", "output", "logs", "pvlogs"] as const;
export type RepeatablePanelId = typeof REPEATABLE_PANEL_IDS[number];
export type ScopedPanelId = `${RepeatablePanelId}@${number}`;
export const isRepeatablePanelId = (id: string): id is RepeatablePanelId => (REPEATABLE_PANEL_IDS as readonly string[]).includes(id);
export const isScopedPanelId = (id: string): id is ScopedPanelId => {
  const at = id.indexOf("@");
  return at > 0 && /^[1-9]\d*$/.test(id.slice(at + 1)) && isRepeatablePanelId(id.slice(0, at));
};
/** The registered tool behind an instance id; every other id is its own base. */
export const panelBaseId = (id: PanelId): PanelId => isScopedPanelId(id) ? id.slice(0, id.indexOf("@")) as PanelId : id;
export const scopedPanelId = (base: RepeatablePanelId, index: number): ScopedPanelId => `${base}@${index}`;
export type AgentPanelId = `agent-detail:${string}`;
/** One managed-browser web page, qualified by the chat (session) that owns it. */
export type BrowserPagePanelId = `browser-page:${string}`;
export type ConversationPanelId = `conversation:${string}`;
export const conversationPanelId = (viewId: string): ConversationPanelId => `conversation:${viewId}`;
export const isConversationPanelId = (id: string): id is ConversationPanelId => id.startsWith("conversation:");
export type FilePanelId = `file-view:${string}`;
export const isFilePanelId = (id: string): id is FilePanelId => id.startsWith("file-view:");
export type FilePanelDescriptor = { targetId: string | null; workspaceId: string; path: string; fileId: string; title: string; scope: "conversation" | "workspace"; line?: number; column?: number; jump?: number; page?: number; scroll?: number; mode?: FileViewMode; time?: number };
/** `preview` renders Markdown or the CSV grid; `split` is Markdown source beside its preview; `diff` is the working-tree patch. */
export type FileViewMode = "preview" | "source" | "split" | "diff";
export type PanelId = FixedPanelId | ScopedPanelId | AgentPanelId | BrowserPagePanelId | ConversationPanelId | FilePanelId;
export const isAgentPanelId = (id: string): id is AgentPanelId => id.startsWith("agent-detail:");
export const isBrowserPagePanelId = (id: string): id is BrowserPagePanelId => id.startsWith("browser-page:");
/** Panels created per Agent or per web page rather than registered once. */
export const isInstancePanelId = (id: string): id is AgentPanelId | BrowserPagePanelId | ConversationPanelId | FilePanelId => isAgentPanelId(id) || isBrowserPagePanelId(id) || isConversationPanelId(id) || isFilePanelId(id);
export type AgentPanelTarget = {
  agentId: string;
  displayName?: string;
  resolvedModel?: string;
  parentSessionId?: string;
  toolCallId?: string;
  task?: string;
  tokens?: string;
  tools?: string | number;
  requests?: string | number;
  files?: string | number;
  cost?: string;
};
export type AgentPanelDescriptor = { scope: string; target: AgentPanelTarget };
export const agentPanelId = (scope: string, agentId: string): AgentPanelId => `agent-detail:${encodeURIComponent(JSON.stringify([scope, agentId]))}`;
/** Live title, icon and status come from the browser state; only the last ready title is remembered. */
export type BrowserPageDescriptor = { sessionId: string; pageId: string; title?: string | undefined };
export const browserPagePanelId = (sessionId: string, pageId: string): BrowserPagePanelId => `browser-page:${encodeURIComponent(JSON.stringify([sessionId, pageId]))}`;
export type DockRegionId = "left" | "rail" | "right" | "bottom";
export type DockGroupId = string;
export type RailMode = "hidden" | "expanded" | "compact";
export type DockRect = { x: number; y: number; width: number; height: number };
export type DockGroup = { id: DockGroupId; panels: PanelId[]; active: PanelId };
export type DockPinMode = "none" | "workspace" | "application" | "window" | "topmost";
export type DockPin = { mode: Exclude<DockPinMode, "none">; owner?: string; workspace?: string; windowRect?: DockRect; coordinateVersion?: 1; returnMode?: "none" | "workspace" | "application"; agentPanels?: DockLayout["agentPanels"]; browserPages?: DockLayout["browserPages"]; fileViews?: DockLayout["fileViews"] };
export type DockFloat = DockGroup & { rect: DockRect; minimized: boolean; maximized: boolean; pin?: DockPin; windowId?: string };
export type DockLocation = { region: DockRegionId | "float"; groupId?: string; index?: number; rect?: DockRect };
export type CardPreferences = { collapsed: boolean; height: number | null; leftShare?: number };
export type DockLayout = {
  version: 1;
  floatCoordinateVersion?: 1 | undefined;
  left: { visible: boolean; width: number; ratio: number; panels: PanelId[] };
  rail: { mode: RailMode; lastMode: "expanded" | "compact"; width: number; panels: PanelId[] };
  right: { visible: boolean; size: number; ratio: number; groups: DockGroup[] };
  bottom: { visible: boolean; expanded: boolean; size: number; ratio: number; groups: DockGroup[] };
  floats: DockFloat[];
  hidden: Partial<Record<PanelId, DockLocation>>;
  cards: Record<PanelId, CardPreferences>;
  agentPanels: Record<string, AgentPanelDescriptor>;
  lastAgentPanel?: AgentPanelId;
  browserPages: Record<string, BrowserPageDescriptor>;
  fileViews: Record<string, FilePanelDescriptor>;
  /** The page tab the user last focused; new pages land beside it. */
  lastBrowserPage?: BrowserPagePanelId;
  presetId: string;
};
export type DockPreferences = {
  snap: boolean;
  locked: boolean;
  inherit: boolean;
  appDefault: string;
  projectDefaults: Record<string, string>;
};
export type DockPreset = { id: string; name: string; layout: DockLayout; builtin?: boolean };
export type DockScope = { target: string; project: string | null; session: string; draft?: boolean };
export type DockTarget = DockLocation & { split?: "before" | "after"; ownerId?: string | undefined };
export type DockAction =
  | { type: "file-open"; panel: FilePanelId; descriptor: FilePanelDescriptor; rect?: DockRect }
  | { type: "file-close"; panels: FilePanelId[] }
  | { type: "file-state"; panel: FilePanelId; patch: Partial<FilePanelDescriptor> }
  | { type: "move"; panels: PanelId[]; target: DockTarget }
  | { type: "open"; panel: PanelId }
  /** Shows an existing instance without changing the layout (no undo entry). */
  | { type: "reveal"; panel: PanelId }
  | { type: "agent-open"; panel: AgentPanelId; descriptor: AgentPanelDescriptor }
  | { type: "agent-focus"; panel: AgentPanelId }
  /** Adds or refreshes a page tab. Passive opens (Agent, popups, restore) never reveal hidden regions. */
  | { type: "browser-page-open"; panel: BrowserPagePanelId; descriptor: BrowserPageDescriptor; reveal: boolean; after?: BrowserPagePanelId | undefined }
  | { type: "browser-page-focus"; panel: BrowserPagePanelId }
  /** A closed page leaves the layout entirely; unlike tools it has no return address. */
  | { type: "browser-page-close"; panels: BrowserPagePanelId[] }
  | { type: "hide"; panels: PanelId[] }
  | { type: "activate"; groupId: string; panel: PanelId }
  | { type: "region"; region: DockRegionId; visible: boolean }
  | { type: "railMode"; mode: RailMode }
  | { type: "bottomExpanded"; expanded: boolean }
  | { type: "card"; panel: PanelId; collapsed?: boolean; height?: number | null }
  | { type: "left-card-shares"; shares: Partial<Record<PanelId, number | null>> }
  | { type: "resize"; region: DockRegionId; size?: number; ratio?: number }
  | { type: "float"; groupId: string; rect?: DockRect; minimized?: boolean; maximized?: boolean }
  | { type: "raise"; groupId: string }
  | { type: "apply"; layout: DockLayout };
export type PanelVisibility = { visible: boolean; width: number; height: number };
/** Replaces the static icon: a site image, or a busy / error / muted state over the icon. */
export type PanelGlyph = { image?: string | undefined; state?: "busy" | "error" | "muted" | undefined; label?: string | undefined };
/** Closing ends the panel's subject (a web page) instead of hiding the tool. */
export type PanelClose = { run: () => void; label: string; tip: string; pending?: boolean | undefined; pendingTip?: string | undefined };
export type PanelContentAdapter = { attach: (slot: HTMLElement, preview: boolean) => () => void; drag: (event: PointerEvent<HTMLElement>) => void; activate: () => void };
export type PanelDefinition = { id: PanelId; title: string; menuTitle?: string; icon: IconName; meter?: boolean; minHeight?: number; initialHeight?: number; detail?: string; status?: string; stale?: boolean; compactLabel?: string; glyph?: PanelGlyph | undefined; close?: PanelClose | undefined; content?: PanelContentAdapter; render?: (visibility: PanelVisibility) => ReactNode };
export type DockSnapshot = { layout: DockLayout; preferences: DockPreferences; presets: DockPreset[]; scope: DockScope; preview: boolean; modalPanel: PanelId | null; canUndo: boolean; canRedo: boolean; modified: boolean };

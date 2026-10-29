import type { ReactNode } from "react";

export const PANEL_IDS = ["files", "changes", "git", "browser", "computer", "agents", "terminal", "problems", "tests", "output", "logs", "pvlogs", "btw"] as const;
export type PanelId = typeof PANEL_IDS[number];
export type DockRegionId = "left" | "rail" | "right" | "bottom";
export type DockGroupId = string;
export type RailMode = "hidden" | "expanded" | "compact";
export type DockRect = { x: number; y: number; width: number; height: number };
export type DockGroup = { id: DockGroupId; panels: PanelId[]; active: PanelId };
export type DockFloat = DockGroup & { rect: DockRect; minimized: boolean; maximized: boolean };
export type DockLocation = { region: DockRegionId | "float"; groupId?: string; index?: number; rect?: DockRect };
export type CardPreferences = { collapsed: boolean; height: number | null };
export type DockLayout = {
  version: 1;
  left: { visible: boolean; width: number; ratio: number; panels: PanelId[] };
  rail: { mode: RailMode; lastMode: "expanded" | "compact"; width: number; panels: PanelId[] };
  right: { visible: boolean; size: number; ratio: number; groups: DockGroup[] };
  bottom: { visible: boolean; expanded: boolean; size: number; ratio: number; groups: DockGroup[] };
  floats: DockFloat[];
  hidden: Partial<Record<PanelId, DockLocation>>;
  cards: Record<PanelId, CardPreferences>;
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
export type DockTarget = DockLocation & { split?: "before" | "after" };
export type DockAction =
  | { type: "move"; panels: PanelId[]; target: DockTarget }
  | { type: "open"; panel: PanelId }
  | { type: "hide"; panels: PanelId[] }
  | { type: "activate"; groupId: string; panel: PanelId }
  | { type: "region"; region: DockRegionId; visible: boolean }
  | { type: "railMode"; mode: RailMode }
  | { type: "bottomExpanded"; expanded: boolean }
  | { type: "card"; panel: PanelId; collapsed?: boolean; height?: number | null }
  | { type: "resize"; region: DockRegionId; size?: number; ratio?: number }
  | { type: "float"; groupId: string; rect?: DockRect; minimized?: boolean; maximized?: boolean }
  | { type: "raise"; groupId: string }
  | { type: "apply"; layout: DockLayout };
export type PanelVisibility = { visible: boolean; width: number; height: number };
export type PanelDefinition = { id: PanelId; title: string; icon: string; minHeight?: number; initialHeight?: number; render?: (visibility: PanelVisibility) => ReactNode };
export type DockSnapshot = { layout: DockLayout; preferences: DockPreferences; presets: DockPreset[]; scope: DockScope; preview: boolean; canUndo: boolean; canRedo: boolean; modified: boolean };

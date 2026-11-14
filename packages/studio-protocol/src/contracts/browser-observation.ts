export type BrowserEngine = "chromium" | "webkit" | "unknown";
export type BrowserDisplayTransport = "embedded" | "frames" | "none";
export type BrowserCapability = "observe" | "control" | "nativeViewer" | "history" | "console" | "network" | "downloads" | "webmcp" | "pdf" | "cdp" | "tracing" | "zoom" | "find" | "pick" | "devtools" | "settings";
export type BrowserPageCapabilities = Record<BrowserCapability, boolean> & { reasons: Partial<Record<BrowserCapability, string>> };

/** Actual native target and lifetime, not an engine inferred from the presence of Electron. */
export interface BrowserPageDescriptor {
  targetId: string;
  ownerSessionId: string;
  sessionId: string;
  generation: string;
  ownership: "owned" | "borrowed";
  engine: BrowserEngine;
  transport: BrowserDisplayTransport;
  capabilities: BrowserPageCapabilities;
  /** Native open/install/fallback notices, not text inferred by the GUI. */
  notices?: string[];
  /** Present only for the dedicated Studio WebContentsView adapter. */
  embeddedPageId?: string;
}
export interface StudioBrowserTab extends BrowserPageDescriptor {
  id: string;
  name: string;
  title: string;
  url: string;
  kind: string;
  busy: boolean;
  frozen: boolean;
  observable: boolean;
  reason?: string;
}
export type BrowserObservationOperation =
  | { kind: "browser.managed.prepare"; sessionId: string }
  | { kind: "browser.tabs.get"; sessionId: string }
  | { kind: "browser.observe.prepare"; sessionId: string; tabId: string }
  | { kind: "browser.native.open"; sessionId: string; url: string; app?: string; argv?: string[]; target?: string; insecure?: boolean }
  | { kind: "browser.native.close"; sessionId: string; tabId: string; generation: string };
export interface BrowserObservationResultMap {
  "browser.managed.prepare": { sessionId: string; descriptorId: string };
  "browser.tabs.get": { tabs: StudioBrowserTab[] };
  "browser.observe.prepare": { observationId: string; sessionId: string; tabId: string; generation?: string; expiresAt: number };
  "browser.native.open": { tab: StudioBrowserTab };
  "browser.native.close": { closed: boolean };
}
export const BROWSER_OBSERVATION_KINDS = ["browser.tabs.get", "browser.observe.prepare", "browser.managed.prepare", "browser.native.open", "browser.native.close"] as const;
export function isBrowserObservationKind(kind: string): kind is BrowserObservationOperation["kind"] { return (BROWSER_OBSERVATION_KINDS as readonly string[]).includes(kind); }

export type BrowserInspectionView = "console" | "network" | "downloads";
export interface BrowserConsoleRow { level: string; text: string; location?: string; timestamp?: number }
export interface BrowserNetworkRow { id: string; method: string; url: string; status?: number; resourceType?: string; failure?: string }
export interface BrowserDownloadRow { name: string; url: string; path?: string; bytes?: number; state: string }
export type BrowserPageInspection =
  | { view: "console"; rows: BrowserConsoleRow[]; reason?: string }
  | { view: "network"; rows: BrowserNetworkRow[]; reason?: string }
  | { view: "downloads"; rows: BrowserDownloadRow[]; reason?: string };

/** Private window-owned channel. Frames, input and logs never enter a transcript or global reducer. */
export type BrowserObservationEvent =
  | { kind: "state"; observationId: string; tabId: string; generation?: string; documentEpoch?: number; title: string; url: string; frozen: boolean; busy: boolean; control: "agent" | "waiting" | "human" | "other-window"; leaseId?: string; viewerVisible?: boolean; canGoBack?: boolean; canGoForward?: boolean }
  | { kind: "frame"; observationId: string; tabId: string; generation?: string; documentEpoch?: number; sequence: number; data: string; width: number; height: number; cssWidth?: number; cssHeight?: number; timestamp: number }
  | { kind: "inspection"; observationId: string; tabId: string; generation: string; inspection: BrowserPageInspection }
  | { kind: "error"; observationId: string; message: string }
  | { kind: "closed"; observationId: string };
/** Missing fences are retained solely to read old Runtime observations; new observations require them for input. */
export interface BrowserInputFence { generation?: string; documentEpoch?: number; leaseId?: string }
export type BrowserObservationInput =
  | { kind: "ping" }
  | { kind: "take"; generation?: string }
  | { kind: "release" }
  | { kind: "visibility"; visible: boolean; capture?: boolean }
  | { kind: "ack"; sequence: number; generation?: string }
  | { kind: "inspect"; view: BrowserInspectionView }
  | ({ kind: "navigate"; url: string } & BrowserInputFence)
  | ({ kind: "back" | "forward" | "reload" | "stop" } & BrowserInputFence)
  | ({ kind: "viewer"; visible: boolean } & BrowserInputFence)
  | ({ kind: "click"; sequence: number; x: number; y: number; button: "left" | "right" } & BrowserInputFence)
  | ({ kind: "wheel"; sequence: number; x: number; y: number; deltaX: number; deltaY: number } & BrowserInputFence)
  | ({ kind: "key"; sequence: number; key: string; code: string; modifiers: number } & BrowserInputFence)
  | ({ kind: "text"; sequence: number; text: string } & BrowserInputFence);
export const BROWSER_FRAME_MAX_BASE64 = 2_796_204;
export const BROWSER_PRIVATE_MAX_BYTES = 4 * 1024 * 1024;

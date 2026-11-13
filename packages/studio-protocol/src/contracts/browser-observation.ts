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
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser observation payload"); return value as Record<string, unknown>; }
function text(value: unknown, max = 4096): asserts value is string { if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error("Invalid browser observation text"); }
function number(value: unknown, min: number, max: number): void { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("Invalid browser observation number"); }
function sequence(value: unknown): void { number(value, 1, Number.MAX_SAFE_INTEGER); if (!Number.isSafeInteger(value)) throw new Error("Invalid browser frame sequence"); }
function id(value: unknown): void { text(value, 36); if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid observation identity"); }
export function validateBrowserObservationOperation(value: unknown): void {
  const row = object(value);
  if (typeof row.kind !== "string" || !isBrowserObservationKind(row.kind)) throw new Error("Unknown browser observation operation");
  text(row.sessionId, 512); if (!row.sessionId) throw new Error("Session identity required");
}
/** Host results are trusted. Kept for older callers of the domain envelope parser. */
export function validateBrowserObservationResult(_kind: BrowserObservationOperation["kind"], value: unknown): void { object(value); }
export function validateBrowserObservationInput(value: unknown): asserts value is BrowserObservationInput {
  const row = object(value);
  const kinds = ["ping", "take", "release", "visibility", "ack", "inspect", "navigate", "back", "forward", "reload", "stop", "viewer", "click", "wheel", "key", "text"];
  if (typeof row.kind !== "string" || !kinds.includes(row.kind)) throw new Error("Unknown browser action");
  if (row.generation !== undefined) id(row.generation);
  if (row.leaseId !== undefined) id(row.leaseId);
  if (row.documentEpoch !== undefined) number(row.documentEpoch, 0, Number.MAX_SAFE_INTEGER);
  if (["ack", "click", "wheel", "key", "text"].includes(row.kind)) sequence(row.sequence);
  if (row.kind === "visibility" || row.kind === "viewer") {
    if (typeof row.visible !== "boolean" || (row.capture !== undefined && typeof row.capture !== "boolean")) throw new Error("Invalid browser visibility");
  }
  if (row.kind === "inspect" && !["console", "network", "downloads"].includes(row.view as string)) throw new Error("Invalid browser inspection");
  if (row.kind === "navigate") {
    text(row.url); const url = new URL(row.url);
    if ((!['http:', 'https:'].includes(url.protocol) && row.url !== "about:blank") || url.username || url.password) throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials");
  }
  if (row.kind === "click" || row.kind === "wheel") { number(row.x, 0, 1); number(row.y, 0, 1); }
  if (row.kind === "click" && row.button !== "left" && row.button !== "right") throw new Error("Invalid mouse button");
  if (row.kind === "wheel") { number(row.deltaX, -2048, 2048); number(row.deltaY, -2048, 2048); }
  if (row.kind === "key") { text(row.key, 64); text(row.code, 64); number(row.modifiers, 0, 15); if (!Number.isInteger(row.modifiers)) throw new Error("Invalid keyboard modifiers"); }
  if (row.kind === "text") text(row.text, 16384);
}
export function validateBrowserObservationEvent(value: unknown): asserts value is BrowserObservationEvent {
  const row = object(value); id(row.observationId);
  if (row.kind === "closed") return;
  if (row.kind === "error") { text(row.message); return; }
  id(row.tabId); if (row.generation !== undefined) id(row.generation);
  if (row.kind === "inspection") {
    const inspection = object(row.inspection);
    if (!["console", "network", "downloads"].includes(inspection.view as string) || !Array.isArray(inspection.rows) || inspection.rows.length > 200) throw new Error("Browser inspection exceeds its budget");
    return;
  }
  if (row.kind === "state") {
    text(row.title); text(row.url);
    if (typeof row.frozen !== "boolean" || typeof row.busy !== "boolean" || !["agent", "waiting", "human", "other-window"].includes(row.control as string)) throw new Error("Invalid browser state");
    return;
  }
  if (row.kind !== "frame") throw new Error("Unknown browser observation event");
  sequence(row.sequence); text(row.data, BROWSER_FRAME_MAX_BASE64);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(row.data as string)) throw new Error("Invalid frame encoding");
  number(row.width, 1, 4096); number(row.height, 1, 4096);
  if (Number(row.width) * Number(row.height) > 4_000_000) throw new Error("Browser viewport exceeds the observation budget");
  if (row.cssWidth !== undefined) number(row.cssWidth, 1, 4096);
  if (row.cssHeight !== undefined) number(row.cssHeight, 1, 4096);
  number(row.timestamp, 0, Number.MAX_SAFE_INTEGER);
}

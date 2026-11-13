export interface StudioBrowserTab { id: string; name: string; title: string; url: string; kind: string; ownerSessionId: string; busy: boolean; frozen: boolean; observable: boolean; reason?: string; }
export type BrowserObservationOperation =
  | { kind: "browser.managed.prepare"; sessionId: string }
  | { kind: "browser.tabs.get"; sessionId: string }
  | { kind: "browser.observe.prepare"; sessionId: string; tabId: string };
export interface BrowserObservationResultMap {
  "browser.managed.prepare": { sessionId: string; descriptorId: string };
  "browser.tabs.get": { tabs: StudioBrowserTab[] };
  "browser.observe.prepare": { observationId: string; sessionId: string; tabId: string; expiresAt: number };
}
export const BROWSER_OBSERVATION_KINDS = ["browser.tabs.get", "browser.observe.prepare", "browser.managed.prepare"] as const;
export function isBrowserObservationKind(kind: string): kind is BrowserObservationOperation["kind"] { return (BROWSER_OBSERVATION_KINDS as readonly string[]).includes(kind); }
/** Private window-owned channel. These events never enter the conversation or public snapshot. */
export type BrowserObservationEvent =
  | { kind: "state"; observationId: string; tabId: string; title: string; url: string; frozen: boolean; busy: boolean; control: "agent" | "waiting" | "human" | "other-window" }
  | { kind: "frame"; observationId: string; tabId: string; sequence: number; data: string; width: number; height: number; timestamp: number }
  | { kind: "error"; observationId: string; message: string }
  | { kind: "closed"; observationId: string };
export type BrowserObservationInput =
  | { kind: "ping" }
  | { kind: "take" }
  | { kind: "release" }
  | { kind: "ack"; sequence: number }
  | { kind: "navigate"; url: string }
  | { kind: "click"; sequence: number; x: number; y: number; button: "left" | "right" }
  | { kind: "wheel"; sequence: number; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; sequence: number; key: string; code: string; modifiers: number }
  | { kind: "text"; sequence: number; text: string };
export const BROWSER_FRAME_MAX_BASE64 = 2_796_204;
export const BROWSER_PRIVATE_MAX_BYTES = 4 * 1024 * 1024;

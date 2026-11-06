export type ManagedBrowserControl = "agent" | "waiting" | "human";
export type ManagedBrowserConnection = "disconnected" | "connecting" | "connected";
export type ManagedBrowserPageStatus = "released" | "loading" | "ready" | "error" | "crashed";

export interface ManagedBrowserSpace { id: string; name: string; }
/** Who opened a page during this app run. Never persisted: restored pages carry none. */
export interface ManagedBrowserPageOpener { source: "human" | "agent"; pageId?: string | undefined; popup?: boolean | undefined; }
export interface ManagedBrowserPage {
  id: string;
  sessionId: string;
  spaceId: string;
  title: string;
  url: string;
  status: ManagedBrowserPageStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  devtools: boolean;
  documentId?: string;
  error?: string | undefined;
  /** Site icon as a `data:` URL of at most 32 KB. */
  favicon?: string | undefined;
  opener?: ManagedBrowserPageOpener | undefined;
}
export interface ManagedBrowserDownload {
  id: string;
  pageId: string;
  name: string;
  url: string;
  path: string;
  receivedBytes: number;
  totalBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
}
export interface ManagedBrowserPermission { spaceId: string; origin: string; permission: string; allowed: boolean; }
export interface ManagedBrowserSettings { maxTabs: number; downloadDirectory: string; askDownloadLocation: boolean; }
export interface ManagedBrowserState {
  sessionId: string;
  pages: ManagedBrowserPage[];
  activePageId: string | null;
  spaces: ManagedBrowserSpace[];
  control: ManagedBrowserControl;
  connection: ManagedBrowserConnection;
  settings: ManagedBrowserSettings;
  downloads: ManagedBrowserDownload[];
  permissions: ManagedBrowserPermission[];
}
export interface BrowserElementReference {
  id: string;
  pageId: string;
  url: string;
  title: string;
  selector: string;
  frameUrl: string;
  text: string;
  tagName: string;
  rect: { x: number; y: number; width: number; height: number };
  screenshot?: { mimeType: "image/png"; data: string };
  note: string;
  capturedAt: string;
  documentId?: string;
}
export interface ManagedBrowserPresentation {
  sessionId: string;
  surfaceId: string;
  windowKey?: string;
  pageId: string | null;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  clip: { x: number; y: number; width: number; height: number };
}
export type ManagedBrowserCommand = { sessionId: string } & (
  | { action: "create"; url: string; spaceId?: string; openerPageId?: string }
  /** `close-handoff` closes a page under any control: it waits for the Agent's current step, closes, then hands control back. */
  | { action: "select" | "close" | "close-handoff" | "close-others" | "reload" | "stop" | "back" | "forward" | "devtools" | "pick"; pageId: string }
  | { action: "navigate"; pageId: string; url: string }
  | { action: "zoom"; pageId: string; factor: number }
  | { action: "find"; pageId: string; text: string; forward?: boolean }
  | { action: "take" | "return" | "release" | "stop-picking" }
  | { action: "space-create"; name: string }
  | { action: "settings"; settings: Partial<ManagedBrowserSettings> }
  | { action: "permission-forget"; spaceId: string; origin: string; permission: string }
  | { action: "download-open" | "download-reveal" | "download-cancel"; downloadId: string }
);
export type ManagedBrowserEvent =
  | { kind: "picker"; sessionId: string; pageId: string; active: boolean }
  | { kind: "shortcut"; sessionId: string; pageId: string; action: "address" | "find" }
  | { kind: "state"; state: ManagedBrowserState }
  | { kind: "selection"; sessionId: string; reference: BrowserElementReference }
  | { kind: "error"; sessionId: string; message: string };
export interface ManagedBrowserApi {
  available(): Promise<boolean>;
  read(sessionId: string): Promise<ManagedBrowserState>;
  execute(command: ManagedBrowserCommand): Promise<ManagedBrowserState>;
  present(presentation: ManagedBrowserPresentation): Promise<void>;
  subscribe(listener: (event: ManagedBrowserEvent) => void): () => void;
}

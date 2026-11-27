import type { BrowserInspectionView, BrowserPageDescriptor, BrowserPageInspection } from "./browser-observation.js";

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
  /** Native identity for all new pages; absent only in legacy saved/read models. */
  descriptor?: BrowserPageDescriptor;
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
  | { action: "create"; url: string; spaceId?: string; openerPageId?: string; app?: string; argv?: string[]; target?: string; insecure?: boolean }
  /** `close-handoff` closes a page under any control: it waits for the Agent's current step, closes, then hands control back. */
  | { action: "select" | "close" | "close-handoff" | "close-others" | "reload" | "stop" | "back" | "forward" | "devtools" | "pick"; pageId: string }
  | { action: "navigate"; pageId: string; url: string }
  | { action: "zoom"; pageId: string; factor: number }
  | { action: "viewer"; pageId: string; visible: boolean }
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
export interface ManagedBrowserInspectionRequest {
  sessionId: string;
  pageId: string;
  generation?: string;
  view: BrowserInspectionView;
  visible: boolean;
}
export interface ManagedBrowserApi {
  available(): Promise<boolean>;
  read(sessionId: string): Promise<ManagedBrowserState>;
  execute(command: ManagedBrowserCommand): Promise<ManagedBrowserState>;
  present(presentation: ManagedBrowserPresentation): Promise<void>;
  /** Fixed local read channel; bounded rows never enter the shared page state or a transcript. */
  inspect?(request: ManagedBrowserInspectionRequest): Promise<BrowserPageInspection>;
  /** Opens a local unpacked-extension directory in the system file manager. */
  openRelayExtensionDirectory?(directory: string): Promise<void>;
  subscribe(listener: (event: ManagedBrowserEvent) => void): () => void;
}

export interface ChromeRelayExtensionInstallRow {
  dir: string;
  extensionId: string;
  exists: boolean;
  missing: boolean;
  recordedVersion: string | null;
  installedVersion: string;
  installedBuild: string | null;
  expectedVersion: string;
  expectedBuild: string | null;
  upToDate: boolean;
  isDefault: boolean;
}

export interface ChromeRelayBrowserRow {
  name: string;
  userDataDir: string;
  executable: string;
  bundleId?: string;
  lastUsedProfile: string;
}

export interface ChromeRelayProfileRow {
  browser: string;
  profile: string;
  profileDir: string;
  extensionId: string;
  loaded: boolean;
  enabled: boolean;
  disabled: boolean;
  developerMode: boolean;
  disableReasons?: number[] | number;
}

export interface ChromeRelayNativeHostManifestRow {
  browser?: string;
  path: string;
  exists: boolean;
  valid: boolean;
  pathMatchesLauncher: boolean;
  allowedOrigins: string[];
  missingExtensionIds: string[];
  error?: string;
}

export interface ChromeRelayWindowsRegistryEntry {
  browser: string;
  key: string;
  registered: boolean;
  manifestPath?: string;
  matchesManifest: boolean;
  error?: string;
}

export interface ChromeRelayNativeHostStatus {
  hostName: "sh.omp.browser";
  platform: string;
  launcherPath: string;
  launcherExists: boolean;
  launcherValid: boolean;
  registered: boolean;
  needsRepair: boolean;
  manifests: ChromeRelayNativeHostManifestRow[];
  windowsRegistry: ChromeRelayWindowsRegistryEntry[];
}

export type ChromeRelayEndpointOutcome =
  | "ready"
  | "unreachable"
  | "no-extension"
  | "outdated-relay"
  | "idle-older-relay"
  | "outdated-extension";

export interface ChromeRelayEndpointHealth {
  url: string;
  configured: boolean;
  outcome: ChromeRelayEndpointOutcome;
  httpStatus?: number;
  relayVersion?: string;
  relayInstance?: string;
  extensionVersion?: string;
  cdpClients?: number | null;
  notice?: string;
}

export interface ChromeRelayHealthStatus {
  settingEnabled: boolean;
  configuredUrl?: string;
  discoveredEndpoints: string[];
  endpoints: ChromeRelayEndpointHealth[];
  ready: boolean;
  notice?: string;
}

export type ChromeRelayPolicyKey =
  | "ExtensionInstallBlocklist"
  | "NativeMessagingBlocklist"
  | "NativeMessagingUserLevelHosts";

export interface ChromeRelayPolicyDenial {
  browser: string;
  policy: ChromeRelayPolicyKey;
  scope: "machine" | "user" | "managed";
  source: string;
  value: string | string[] | boolean | number;
  reason: string;
}

export interface ChromeRelayPolicyStatus {
  checked: boolean;
  platform: string;
  blocked: boolean;
  extensionBlocked: boolean;
  nativeHostBlocked: boolean;
  userLevelHostsDisabled: boolean;
  denials: ChromeRelayPolicyDenial[];
  warnings: string[];
}

export interface ChromeRelayHostStatus {
  ompVersion: string;
  expectedBuild: string | null;
  defaultExtensionDir: string;
  defaultExtensionId: string;
  registryFile: string;
  lastSynced?: string;
  installs: ChromeRelayExtensionInstallRow[];
  browsers: ChromeRelayBrowserRow[];
  profiles: ChromeRelayProfileRow[];
  nativeHost: ChromeRelayNativeHostStatus;
  health: ChromeRelayHealthStatus;
  policy: ChromeRelayPolicyStatus;
}

export type ChromeRelayHostSyncItem =
  | { dir: string; status: "written" | "up to date"; ompVersion: string }
  | { dir: string; status: "missing" }
  | { dir: string; status: "failed"; error: string };

export interface ChromeRelayProfileInstallReport {
  browser: string;
  profileDir: string;
  authenticators: "hmac+encrypted" | "hmac" | "unauthenticated";
  restarted: boolean;
}

export interface ChromeRelayHostInstallResult {
  action: "install";
  dir: string;
  extensionId: string;
  ompVersion: string;
  manifestPaths: string[];
  registeredNativeHost: boolean;
  profileInstalls: ChromeRelayProfileInstallReport[];
  profileInstallError?: string;
  warnings: string[];
  status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostSyncResult {
  action: "sync";
  results: ChromeRelayHostSyncItem[];
  restartedEndpoints: string[];
  warnings: string[];
  status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostUpdateResult {
  action: "update";
  results: ChromeRelayHostSyncItem[];
  restartedEndpoints: string[];
  warnings: string[];
  status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostRepairResult {
  action: "repair";
  extensionIds: string[];
  manifestPaths: string[];
  registryUpdated: boolean;
  syncResults: ChromeRelayHostSyncItem[];
  profileInstalls: ChromeRelayProfileInstallReport[];
  profileInstallError?: string;
  warnings: string[];
  status: ChromeRelayHostStatus;
}

export interface ChromeRelayHostUninstallResult {
  action: "uninstall";
  removedManifestPaths: string[];
  removedLauncherPath?: string;
  removedRegistryKeys: string[];
  removedProfileRegistrations: Array<{ browser: string; profileDir: string; extensionId: string }>;
  removedExtensionDirs: string[];
  warnings: string[];
  status: ChromeRelayHostStatus;
}

export type ChromeRelayHostOperation =
  | { kind: "browser.relayHost.status"; sessionId: string; dir?: string; probeHealth?: boolean }
  | {
      kind: "browser.relayHost.install";
      sessionId: string;
      dir?: string;
      browser?: string;
      profile?: string;
      registerChrome?: boolean;
    }
  | { kind: "browser.relayHost.sync"; sessionId: string; restartOutdatedRelay?: boolean }
  | { kind: "browser.relayHost.update"; sessionId: string; dir?: string; restartOutdatedRelay?: boolean }
  | {
      kind: "browser.relayHost.repair";
      sessionId: string;
      browser?: string;
      profile?: string;
      repairProfile?: boolean;
      installIfMissing?: boolean;
    }
  | {
      kind: "browser.relayHost.uninstall";
      sessionId: string;
      removeProfileRegistrations?: boolean;
      removeExtensionFiles?: boolean;
    };

export interface ChromeRelayHostResultMap {
  "browser.relayHost.status": ChromeRelayHostStatus;
  "browser.relayHost.install": ChromeRelayHostInstallResult;
  "browser.relayHost.sync": ChromeRelayHostSyncResult;
  "browser.relayHost.update": ChromeRelayHostUpdateResult;
  "browser.relayHost.repair": ChromeRelayHostRepairResult;
  "browser.relayHost.uninstall": ChromeRelayHostUninstallResult;
}

export const CHROME_RELAY_HOST_KINDS = [
  "browser.relayHost.status",
  "browser.relayHost.install",
  "browser.relayHost.sync",
  "browser.relayHost.update",
  "browser.relayHost.repair",
  "browser.relayHost.uninstall",
] as const;

export const CHROME_RELAY_HOST_READ_KINDS = ["browser.relayHost.status"] as const;

export function isChromeRelayHostKind(kind: string): kind is ChromeRelayHostOperation["kind"] {
  return (CHROME_RELAY_HOST_KINDS as readonly string[]).includes(kind);
}

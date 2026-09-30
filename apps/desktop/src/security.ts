/**
 * OMP Studio Desktop security baseline (FRONTEND_INTEGRATION.md §9.1).
 *
 * Deliberately Electron-free: every Electron-typed seam is a structural
 * interface satisfied by the real Electron classes, and the BrowserWindow
 * constructor is injected. Headless tests can import and exercise every
 * helper without Electron.
 *
 * Baseline applied to every window:
 * - contextIsolation / nodeIntegration / sandbox fixed to secure values;
 * - CSP without `unsafe-eval` (header injection for http(s) loads; the
 *   packaged `file://` bundle additionally carries a meta CSP in its
 *   index.html);
 * - navigation and new windows denied except the trusted renderer origin.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Content-Security-Policy for the renderer. No `unsafe-eval` anywhere.
 * `connect-src` allows the local dev server so HMR works in development;
 * packaged builds only ever load `'self'`.
 */
export const RENDERER_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: omp-artifact:; " +
  "media-src 'self' blob: omp-artifact:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' omp-artifact:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'";

/** Development-only policy required by Vite's React Refresh preamble. */
export function rendererCspFor(target: RendererTarget): string {
  if (target.kind === "file") return RENDERER_CSP;
  let origin: URL;
  try {
    origin = new URL(target.url);
  } catch {
    return RENDERER_CSP;
  }
  const wsOrigin = `ws://${origin.host}`;
  return RENDERER_CSP
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("connect-src 'self'", `connect-src 'self' ${origin.origin} ${wsOrigin}`);
}

/** Fixed secure webPreferences for every renderer window; no runtime variation. */
export interface SecureWebPreferences {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly webviewTag: false;
  /** Absolute path to the sandboxed preload script (narrow typed API). */
  readonly preload: string;
}

export function secureWebPreferences(preloadPath: string): SecureWebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    preload: preloadPath,
  };
}

/** Where the renderer bundle is loaded from. Never user-controlled. */
export type RendererTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "url"; readonly url: string };

/**
 * Resolve the renderer entry: the dev server URL when one is configured,
 * otherwise the built renderer bundle. `devServerUrl` comes from an
 * explicit developer environment variable only — never from user input.
 * Packaged builds keep the same relative layout via extraResources:
 * `app.asar` → `resources/renderer/dist/index.html`.
 */
export function resolveRendererEntry(appPath: string, devServerUrl?: string): RendererTarget {
  return resolveRendererEntryFrom(join(appPath, "..", "renderer", "dist"), devServerUrl);
}

/** 与 resolveRendererEntry 同语义，但直接给 renderer/dist 目录。 */
export function resolveRendererEntryFrom(rendererDist: string, devServerUrl?: string): RendererTarget {
  if (devServerUrl !== undefined && devServerUrl !== "") {
    return { kind: "url", url: devServerUrl };
  }
  return { kind: "file", path: join(rendererDist, "index.html") };
}

/** Packaged builds ignore the developer Vite override. */
export function rendererDevServerUrl(isPackaged: boolean, envUrl?: string): string | undefined {
  if (isPackaged) return undefined;
  if (envUrl === undefined || envUrl === "") return undefined;
  return envUrl;
}

/** Trusted entry URL for file bundles, or the dev-server origin. */
export function rendererOriginFor(target: RendererTarget): string {
  if (target.kind === "file") return pathToFileURL(target.path).href;
  try {
    return new URL(target.url).origin;
  } catch {
    // Unparseable dev URL: fail closed to an origin nothing can match.
    return "null";
  }
}

/**
 * A navigation target is trusted only when it stays on the packaged
 * renderer entry: the exact `file:` document when the bundle is packaged, or an
 * exact scheme+host+port origin match for the dev server.
 */
export function isTrustedRendererUrl(url: string, allowedOrigin: string): boolean {
  if (url === "" || allowedOrigin === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (allowedOrigin.startsWith("file:")) {
    try {
      const entry = new URL(allowedOrigin);
      return parsed.protocol === "file:" && parsed.host === entry.host && parsed.pathname === entry.pathname;
    } catch {
      return false;
    }
  }
  if (allowedOrigin === "null") return false;
  return parsed.origin === allowedOrigin;
}

/**
 * Minimal structural surface used by the navigation guards: the window's
 * WebContents, which emits `will-navigate` and owns `setWindowOpenHandler`.
 * (Neither exists on BrowserWindow, which is where these guards used to be
 * registered, so they never ran.)
 *
 * A single generic event boundary rather than per-event overloads: it is
 * implemented by Electron's `WebContents.on` (whose overloaded signature is
 * not assignable to a narrow overloaded interface due to variance) while
 * keeping the guards Electron-free. Callbacks receive raw args and cast only
 * what the guard logic needs.
 */
export interface NavigationGuardedContents {
  on(event: string, listener: (...args: readonly unknown[]) => unknown): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

/** Web links the renderer opens belong in the system browser. */
export function isExternalWebLink(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/**
 * Deny navigation away from the trusted renderer origin and deny every new
 * window: the Studio is a single-window shell (P1). `will-navigate` is
 * prevented unless `isTrustedRendererUrl`; `window.open` and target=_blank
 * are always denied. A denied http(s) link goes to `openExternal`, so links in
 * the conversation keep opening — in the user's browser instead of a new
 * unguarded Electron window.
 */
export function installNavigationGuards(
  contents: NavigationGuardedContents,
  allowedOrigin: string,
  openExternal?: (url: string) => void,
): void {
  contents.on("will-navigate", (event, url) => {
    const target = String(url);
    if (isTrustedRendererUrl(target, allowedOrigin)) return;
    (event as { preventDefault(): void }).preventDefault();
    if (isExternalWebLink(target)) openExternal?.(target);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebLink(url)) openExternal?.(url);
    return { action: "deny" };
  });
}

/**
 * Permission requests (microphone, notifications, clipboard …) are granted to
 * the trusted renderer document only. Artifact frames and anything else a page
 * embeds are denied instead of being granted by Electron's default.
 */
export function createPermissionRequestHandler(
  allowedOrigin: string,
): (contents: unknown, permission: string, callback: (granted: boolean) => void, details: { readonly requestingUrl?: string }) => void {
  return (_contents, _permission, callback, details) => {
    callback(isTrustedRendererUrl(details.requestingUrl ?? "", allowedOrigin));
  };
}

/** Minimal structural session surface for CSP header injection. */
export interface CspSession {
  readonly webRequest: {
    onHeadersReceived(
      listener: (
        details: { responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders: Record<string, string[]> }) => void,
      ) => void,
    ): unknown;
  };
}

/** Inject the renderer CSP on every http(s) response of the given session. */
export function installCspHeaders(session: CspSession, csp: string): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        "Content-Security-Policy": [csp],
      },
    });
  });
}

/** Renderer lifecycle events are emitted by WebContents, not BrowserWindow. */
export interface RendererLifecycleSurface {
  on(event: "did-finish-load" | "did-fail-load", listener: () => void): unknown;
}

/** Minimal structural window surface used by the secure window factory. */
export interface WindowLike {
  readonly webContents: RendererLifecycleSurface & NavigationGuardedContents;
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  once(event: "ready-to-show", listener: () => void): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  setIcon?(icon: unknown): void;
  show(): void;
}

export interface CreateSecureWindowDeps<
  TWindow extends WindowLike,
  TOptions extends object,
> {
  /** Electron BrowserWindow class (or a fake in tests). */
  readonly BrowserWindow: new (options: TOptions) => TWindow;
  /** Base constructor options; `webPreferences` is overwritten securely. */
  readonly windowOptions: TOptions;
  /** Absolute path to the sandboxed preload script. */
  readonly preloadPath: string;
  readonly target: RendererTarget;
  /** Origin from `rendererOriginFor(target)`. */
  readonly allowedOrigin: string;
  /** Defer navigation until the caller has installed its IPC handlers. */
  readonly deferLoad?: boolean;
  /** Where denied http(s) links go (`shell.openExternal`). */
  readonly openExternal?: (url: string) => void;
}

export function loadRendererTarget(window: WindowLike, target: RendererTarget): void {
  if (target.kind === "file") void window.loadFile(target.path);
  else void window.loadURL(target.url);
}

/**
 * Create one secure renderer window: fixed secure webPreferences
 * (caller-provided webPreferences are never honored), navigation guards,
 * guarded load of the renderer target, shown on ready-to-show.
 */
export function createSecureWindow<
  TWindow extends WindowLike,
  TOptions extends object,
>(deps: CreateSecureWindowDeps<TWindow, TOptions>): TWindow {
  const window = new deps.BrowserWindow({
    ...deps.windowOptions,
    webPreferences: secureWebPreferences(deps.preloadPath),
  });
  installNavigationGuards(window.webContents, deps.allowedOrigin, deps.openExternal);
  window.once("ready-to-show", () => {
    window.show();
  });
  // Some Chromium failures (notably sandboxed preload errors) do not emit
  // ready-to-show. Ensure a diagnostic/error page is still visible instead of
  // leaving a window that looks like a blank white shell.
  window.webContents.on("did-finish-load", () => window.show());
  window.webContents.on("did-fail-load", () => window.show());
  if (!deps.deferLoad) loadRendererTarget(window, deps.target);
  return window;
}

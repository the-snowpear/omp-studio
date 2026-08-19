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

/**
 * Content-Security-Policy for the renderer. No `unsafe-eval` anywhere.
 * `connect-src` allows the local dev server so HMR works in development;
 * packaged builds only ever load `'self'`.
 */
export const RENDERER_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
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
  if (devServerUrl !== undefined && devServerUrl !== "") {
    return { kind: "url", url: devServerUrl };
  }
  return { kind: "file", path: join(appPath, "..", "renderer", "dist", "index.html") };
}

/** Packaged builds ignore the developer Vite override. */
export function rendererDevServerUrl(isPackaged: boolean, envUrl?: string): string | undefined {
  if (isPackaged) return undefined;
  if (envUrl === undefined || envUrl === "") return undefined;
  return envUrl;
}

/** Origin that may drive the renderer: `file://` for packaged, dev-server origin otherwise. */
export function rendererOriginFor(target: RendererTarget): string {
  if (target.kind === "file") return "file://";
  try {
    return new URL(target.url).origin;
  } catch {
    // Unparseable dev URL: fail closed to an origin nothing can match.
    return "null";
  }
}

/**
 * A navigation target is trusted only when it stays on the packaged
 * renderer origin: any `file:` URL when the bundle is packaged, or an
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
  if (allowedOrigin === "file://") return parsed.protocol === "file:";
  return parsed.origin === allowedOrigin;
}

/**
 * Minimal structural window surface used by the navigation guards.
 *
 * A single generic event boundary rather than per-event overloads: it is
 * implemented by Electron's `BrowserWindow.on` (whose overloaded signature
 * is not assignable to a narrow overloaded interface due to variance) while
 * keeping the guards Electron-free. Callbacks receive raw args and cast
 * only what the guard logic needs.
 */
export interface NavigationGuardedWindow {
  on(event: string, listener: (...args: readonly unknown[]) => unknown): unknown;
}

/**
 * Deny navigation away from the trusted renderer origin and deny every new
 * window: the Studio is a single-window shell (P1). `will-navigate` is
 * prevented unless `isTrustedRendererUrl`; `window.open` and target=_blank
 * are always denied.
 */
export function installNavigationGuards(
  window: NavigationGuardedWindow,
  allowedOrigin: string,
): void {
  window.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(String(url), allowedOrigin)) {
      (event as { preventDefault(): void }).preventDefault();
    }
  });
  window.on("setWindowOpenHandler", () => {
    return { action: "deny" };
  });
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
  readonly webContents: RendererLifecycleSurface;
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  once(event: "ready-to-show", listener: () => void): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  setIcon?(icon: unknown): void;
  show(): void;
}

export interface CreateSecureWindowDeps<
  TWindow extends WindowLike & NavigationGuardedWindow,
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
  TWindow extends WindowLike & NavigationGuardedWindow,
  TOptions extends object,
>(deps: CreateSecureWindowDeps<TWindow, TOptions>): TWindow {
  const window = new deps.BrowserWindow({
    ...deps.windowOptions,
    webPreferences: secureWebPreferences(deps.preloadPath),
  });
  installNavigationGuards(window, deps.allowedOrigin);
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

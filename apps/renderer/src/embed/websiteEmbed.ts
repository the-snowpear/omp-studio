import type { Route } from "../workbench/types";

export const WEBSITE_EMBED_SOURCE = "omp-studio-embed" as const;
export const EMBED_SET_ROUTE_EVENT = "omp:embed-set-route" as const;

export type EmbedTheme = "light" | "dark";

export const WEBSITE_EMBED_ROUTES: ReadonlySet<Route> = new Set<Route>([
  "home",
  "history",
  "agent-hub",
  "model-config",
  "capabilities",
  "settings",
  "statistics",
  "workbench",
  "diagnostics",
  "media",
  "evaluation",
]);

export type EmbedInboundMessage =
  | { source: typeof WEBSITE_EMBED_SOURCE; type: "set-route"; route: Route }
  | { source: typeof WEBSITE_EMBED_SOURCE; type: "set-theme"; theme: EmbedTheme };

export type EmbedOutboundMessage =
  | { source: typeof WEBSITE_EMBED_SOURCE; type: "ready"; route: Route; theme: EmbedTheme }
  | { source: typeof WEBSITE_EMBED_SOURCE; type: "route-changed"; route: Route }
  | { source: typeof WEBSITE_EMBED_SOURCE; type: "theme-changed"; theme: EmbedTheme }
  | { source: typeof WEBSITE_EMBED_SOURCE; type: "theme-ack"; theme: EmbedTheme };

let currentEmbedRoute: Route = "home";
let pendingEmbedRoute: Route | null = null;
let expectedHostTheme: EmbedTheme | null = null;

/** Returns whether the renderer is running inside the website interactive embed. */
export function isEmbedMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.embed === "1";
}

/** Validates and narrows an arbitrary route string to a known renderer Route. */
export function parseEmbedRoute(value: string | null | undefined): Route | null {
  if (!value) return null;
  return WEBSITE_EMBED_ROUTES.has(value as Route) ? (value as Route) : null;
}

/** Records the route currently active in the embedded App for `ready` reporting. */
export function setCurrentEmbedRoute(route: Route): void {
  currentEmbedRoute = route;
}

/** Returns the latest known route inside the embedded App. */
export function getCurrentEmbedRoute(): Route {
  return currentEmbedRoute;
}

/** Dispatches a host-requested route change to the mounted TargetApp. */
export function requestEmbedRoute(route: Route): void {
  pendingEmbedRoute = route;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<{ route: Route }>(EMBED_SET_ROUTE_EVENT, { detail: { route } }));
  }
}

/** Reads and clears any host route request received prior to TargetApp mounting. */
export function consumePendingEmbedRoute(): Route | null {
  const next = pendingEmbedRoute;
  pendingEmbedRoute = null;
  return next;
}

/** Marks a theme value as initiated by the host so it is not echoed as `theme-changed`. */
export function setExpectedHostTheme(theme: EmbedTheme | null): void {
  expectedHostTheme = theme;
}

/** Emits `theme-changed` only when a theme transition originated from internal UI controls. */
export function notifyInternalThemeIfChanged(theme: EmbedTheme, prevTheme: EmbedTheme): void {
  if (!isEmbedMode() || theme === prevTheme) return;
  if (expectedHostTheme === theme) {
    expectedHostTheme = null;
    return;
  }
  expectedHostTheme = null;
  postEmbedMessage({ source: WEBSITE_EMBED_SOURCE, type: "theme-changed", theme });
}

function resolveTargetOrigin(): string {
  // When served under opaque origin ("null"), postMessage rejects non-"*" targetOrigin;
  // callers still restrict recipients via `window.parent` / `event.source === window.parent`.
  return window.location.origin === "null" ? "*" : window.location.origin;
}

/** Posts a structured bridge message to the host website window when embedded. */
export function postEmbedMessage(message: EmbedOutboundMessage): void {
  if (!isEmbedMode()) return;
  if (typeof window === "undefined" || window.parent === window) return;
  try {
    window.parent.postMessage(message, resolveTargetOrigin());
  } catch {
    // Ignore detached-frame postMessage races during teardown.
  }
}

/** Verifies inbound `postMessage` events come from the immediate parent on the same origin. */
export function isTrustedEmbedHostEvent(event: MessageEvent): boolean {
  if (typeof window === "undefined") return false;
  if (event.source !== window.parent) return false;
  if (window.location.origin !== "null" && event.origin !== window.location.origin) return false;
  return true;
}

/** Parses inbound host control messages for route and theme synchronization. */
export function parseEmbedInboundMessage(data: unknown): EmbedInboundMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.source !== WEBSITE_EMBED_SOURCE) return null;
  if (record.type === "set-route" && typeof record.route === "string") {
    const route = parseEmbedRoute(record.route);
    return route ? { source: WEBSITE_EMBED_SOURCE, type: "set-route", route } : null;
  }
  if (record.type === "set-theme" && (record.theme === "light" || record.theme === "dark")) {
    return { source: WEBSITE_EMBED_SOURCE, type: "set-theme", theme: record.theme };
  }
  return null;
}

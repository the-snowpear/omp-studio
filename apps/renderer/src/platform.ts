/**
 * The OS the renderer runs on — the one place renderer code reads it
 * (FRONTEND_INTEGRATION.md). The desktop preload fixes it at startup; the Web
 * UI falls back to the browser's report.
 */
export type RendererPlatform = "win32" | "darwin" | "linux";

interface NavigatorLike {
  readonly platform?: string;
  readonly userAgentData?: { readonly platform?: string };
}

export function detectPlatform(
  chrome: { readonly platform?: string } | undefined = globalThis.ompStudioChrome,
  navigatorLike: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined,
): RendererPlatform {
  const fixed = chrome?.platform;
  if (fixed === "win32" || fixed === "darwin" || fixed === "linux") return fixed;
  const reported = `${navigatorLike?.userAgentData?.platform ?? ""} ${navigatorLike?.platform ?? ""}`.toLowerCase();
  if (reported.includes("mac")) return "darwin";
  if (reported.includes("win")) return "win32";
  return "linux";
}

export const PLATFORM: RendererPlatform = detectPlatform();

/**
 * The desktop app on macOS has a native menu bar that owns the app-level
 * shortcuts (⌘K, ⌘B, …); the renderer must not act on them a second time.
 * A browser on a Mac has no such menu.
 */
export function nativeMenuOwnsShortcuts(chrome: { readonly platform?: string } | undefined = globalThis.ompStudioChrome): boolean {
  return chrome?.platform === "darwin";
}

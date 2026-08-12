/**
 * @omp-studio/transport-desktop
 *
 * Renderer-side Desktop transport adapter (FRONTEND_INTEGRATION.md §9, P0).
 * P0 is an in-process semantic adapter: `createDesktopTransport` wraps a
 * typed `OmpStudioDesktopApi` into a `ClientTransport` with defensive
 * cloning, close enforcement and structural response validation. No
 * Electron, channel names or preload implementation exists in this package.
 */

export type { OmpStudioDesktopApi } from "./desktop-api.js";
export { createDesktopTransport } from "./desktop-transport.js";

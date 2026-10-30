/**
 * @omp-studio/transport-desktop
 *
 * Renderer-side Desktop transport adapter plus the Desktop IPC contract:
 * the fixed channel constants and envelope parsing for Electron Main.
 */

export type { OmpStudioDesktopApi } from "./desktop-api.js";
export { createDesktopTransport } from "./desktop-transport.js";

export { DESKTOP_IPC_CHANNELS, DESKTOP_IPC_LIMITS, type DesktopIpcChannel } from "./channels.js";
export {
  ValidationError,
  isPlainObject,
  parseClientQueryRequest,
  parseClientCommandRequest,
  parseSubscriptionScope,
} from "./ipc-envelope.js";

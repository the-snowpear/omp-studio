/**
 * @omp-studio/transport-desktop
 *
 * Renderer-side Desktop transport adapter (FRONTEND_INTEGRATION.md §9, P0)
 * plus the P1 Desktop IPC contract: channel constants and strict payload
 * validators for the Electron Main boundary.
 *
 * P0 is an in-process semantic adapter: `createDesktopTransport` wraps a
 * typed `OmpStudioDesktopApi` into a `ClientTransport` with defensive
 * cloning, close enforcement and structural response validation.
 *
 * P1 adds the pieces Electron Main needs without importing Electron:
 * `DESKTOP_IPC_CHANNELS` is the fixed, closed channel set (bootstrap /
 * query / command / subscribe / event / close — no generic invoke), and
 * the named parse/assert functions fail closed on any malformed or unknown
 * payload before Host dispatch or before a response crosses to the
 * preload. All validators are pure browser/Node-neutral ECMAScript; client
 * identity is bound from the sender WebContents and never accepted in a
 * payload.
 */

export type { OmpStudioDesktopApi } from "./desktop-api.js";
export { createDesktopTransport } from "./desktop-transport.js";

export { DESKTOP_IPC_CHANNELS, type DesktopIpcChannel } from "./channels.js";
export {
  ValidationError,
  isPlainObject,
  assertPlainObject,
  assertNoUnknownKeys,
  isOpaqueToken,
  assertOpaqueToken,
  assertNonEmptyText,
  parseClientQueryRequest,
  parseClientCommandRequest,
  parseSubscriptionScope,
  QUERY_NAMES,
  COMMAND_NAMES,
  MAX_TEXT_LENGTH,
  MAX_LIST_ITEMS,
  MAX_VALUE_DEPTH,
  MAX_SERIALIZED_SIZE,
  MAX_HISTORY_LIMIT,
  MAX_ID_LENGTH,
} from "./validate-inbound.js";
export {
  assertClientQueryResponse,
  assertClientCommandAccepted,
  assertClientEvent,
} from "./validate-outbound.js";

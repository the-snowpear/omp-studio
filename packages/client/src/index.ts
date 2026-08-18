/**
 * @omp-studio/client
 *
 * Platform-neutral product client: reducer, StudioClientImpl and the
 * in-process memory transport. No Node or Electron imports anywhere in
 * `src`; the Renderer receives `StudioClient` only.
 */

export { createBrowserClockAndIds, type ClientClockAndIds } from "./clock.js";
export { CLIENT_CLOSED_ERROR, toClientError } from "./errors.js";
export {
  createInitialClientState,
  isSensitiveCommand,
  reduceClientState,
  COMMAND_STATE_TERMINAL_CAP,
  RESYNC_REQUIRED_ERROR,
  type ClientAction,
  type ClientConnectionState,
  type ClientEntitiesState,
  type ClientState,
  type ClientUiState,
  selectBtwSnapshot,
  selectSessionTelemetry,
} from "./reducer.js";
export { StudioClientImpl, type ConversationHydrateClient } from "./studio-client.js";
export { MemoryClientTransport, type MemoryTransportHandlers } from "./memory-transport.js";
export { eventMatchesScope } from "./scope.js";
export {
  CONVERSATION_STATE_ITEM_CAP,
  CONVERSATION_STATE_LIVE_TOOLS_CAP,
  clearConversationState,
  conversationHintFromCursor,
  createInitialConversationState,
  selectConversationHydrate,
  selectConversationViews,
  type ConversationHydrateStatus,
  type ConversationIdentity,
  type ConversationLiveMessage,
  type ConversationLiveTool,
  type ConversationNotice,
  type ConversationState,
  type ConversationView,
  type StickyProviderError,
} from "./conversation-state.js";
export { reduceConversationState, type ConversationAction } from "./conversation-reducer.js";
export {
  isComposerTerminal,
  selectComposerReceipt,
  selectComposerTerminal,
  type ComposerReceiptView,
} from "./receipt-selectors.js";

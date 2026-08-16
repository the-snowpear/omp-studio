/**
 * @omp-studio/testkit
 *
 * Shared semantic transport contract fixtures and suite (P0). Adapter
 * packages (desktop, web) build a `ClientTransport` from a
 * `ContractFixtureApi` fake host via `TransportFactory`; the identical
 * assertion set in `runTransportContract` then drives both adapters
 * through the exact same observable behaviors.
 */

export { contractFixtures, createContractFixtureApi } from "./fixtures.js";
export type { ContractFixtureData } from "./fixtures.js";
export { runTransportContract } from "./suite.js";
export type {
  ContractFixtureApi,
  FixtureCalls,
  FixtureSubscription,
  TransportFactory,
} from "./types.js";
export {
  CONVERSATION_FIXTURE_IDS,
  CONVERSATION_FIXTURE_T0,
  CONVERSATION_FIXTURE_T1,
  conversationChangedEvent,
  conversationFaultEvents,
  conversationIdentities,
  conversationInteractions,
  conversationLiveClientEvents,
  conversationLiveSequence,
  conversationLiveToolError,
  conversationLiveParallelToolStarted,
  conversationPages,
  conversationReceipts,
  conversationStudioEnvelope,
  conversationUnsafe,
} from "./conversation-fixtures.js";
export {
  assertConversationPublicSafe,
  CONVERSATION_FORBIDDEN_SUBSTRINGS,
  findConversationSafetyViolations,
} from "./conversation-safety.js";

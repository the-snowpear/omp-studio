import type {
  ClientEvent,
  ConversationTranscriptPage,
  ConversationTranscriptReadPage,
  OpaqueCursor,
  SessionId,
  StudioClient,
  Unsubscribe,
} from "@omp-studio/client-contract";
import type { AgentId, ConversationOpenResult, ConversationTarget } from "@omp-studio/studio-protocol";

export type ConversationSourceClient = Pick<StudioClient, "query" | "subscribe">;
export type ConversationSourcePage = ConversationTranscriptPage | ConversationTranscriptReadPage;

/**
 * The only module aware of transport query names. Engines consume this narrow
 * source so protocol migrations do not leak into Store or React hooks.
 */
export function createConversationSource(client: ConversationSourceClient) {
  return {
    subscribe(listener: (event: ClientEvent) => void): Unsubscribe {
      return client.subscribe({ scope: "all" }, listener);
    },
    open(target: ConversationTarget, limit: number): Promise<ConversationOpenResult> {
      return client.query("conversation.open", { target, limit });
    },
    readLiveOlder(target: ConversationTarget, cursor: OpaqueCursor, limit: number): Promise<ConversationTranscriptPage> {
      return target.kind === "session"
        ? client.query("session.transcript.read", { cursor, limit })
        : client.query("agent.conversation.read", { agentId: target.agentId as AgentId, cursor, limit });
    },
    readArchive(sessionId: SessionId, agentId: string | undefined, cursor: OpaqueCursor | undefined, limit: number): Promise<ConversationTranscriptReadPage> {
      return client.query("session.transcript.readPage", { sessionId, ...(agentId === undefined ? {} : { agentId: agentId as AgentId }), ...(cursor === undefined ? {} : { cursor }), limit });
    },
  };
}

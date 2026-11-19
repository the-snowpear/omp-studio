import type {
  ClientBootstrap, ClientCommandRequest, ClientContextScope, ClientEvent, ClientInteraction,
  ClientQueryRequest, ClientQueryResponse, ClientTransport, CommandName, QueryName,
  SessionHistoryEntry, SessionId, WorkspaceId,
} from "@omp-studio/client-contract";
import type { WebAdapterHost } from "@omp-studio/transport-web";

function denied(): never {
  throw new Error("mobile_operation_unavailable");
}

function toolApproval(interaction: ClientInteraction | undefined): boolean {
  return interaction?.kind === "approval" && interaction.approvalType !== "configuration";
}

function mobileSnapshot(snapshot: NonNullable<ClientBootstrap["snapshot"]>): NonNullable<ClientBootstrap["snapshot"]> {
  return {
    runtimeId: snapshot.runtimeId,
    runtimeEpoch: snapshot.runtimeEpoch,
    stateVersion: snapshot.stateVersion,
    sessionId: snapshot.sessionId,
    isStreaming: snapshot.isStreaming,
    isCompacting: snapshot.isCompacting,
    approvalMode: snapshot.approvalMode,
    activeMode: snapshot.activeMode,
    pendingMessages: snapshot.pendingMessages,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function scopedConversation(transport: ClientTransport, row: SessionHistoryEntry & { sessionId: SessionId }, workspaceId: WorkspaceId): ClientTransport {
  const { sessionId, threadId } = row;
  const projectEvent = (event: ClientEvent): ClientEvent => {
    switch (event.kind) {
      case "snapshot":
        if (event.snapshot.sessionId === sessionId) return { ...event, snapshot: mobileSnapshot(event.snapshot) };
        break;
      case "conversation.changed":
        if (event.sessionId === sessionId) return event;
        break;
      case "interaction.required":
        if (event.interaction.sessionId === sessionId) return event;
        break;
      case "interaction.resolved":
      case "runtime.changed":
      case "resync.required":
      case "command.accepted":
      case "command.receipt":
        return event;
    }
    const { authorityEpoch, runtimeEpoch, stateVersion, cursor, occurredAt } = event;
    return { kind: "state.changed", authorityEpoch, ...(runtimeEpoch === undefined ? {} : { runtimeEpoch }), stateVersion, cursor, occurredAt };
  };
  return {
    async bootstrap() {
      const result = await transport.bootstrap();
      const { residents: _residents, snapshot, pendingInteraction, ...connection } = result;
      return {
        ...connection,
        selected: { workspaceId, sessionId, threadId },
        ...(snapshot?.sessionId === sessionId ? { snapshot: mobileSnapshot(snapshot) } : {}),
        ...(pendingInteraction?.sessionId === sessionId ? { pendingInteraction } : {}),
      };
    },
    query<TName extends QueryName>(request: ClientQueryRequest<TName>) {
      if (request.queryName === "conversation.open") {
        const call = request as ClientQueryRequest<"conversation.open">;
        const { target } = call.input;
        if (target.kind !== "session" || target.sessionId !== sessionId) denied();
      } else if (request.queryName === "session.transcript.readPage") {
        const call = request as ClientQueryRequest<"session.transcript.readPage">;
        if (call.input.sessionId !== sessionId || call.input.agentId !== undefined) denied();
      } else denied();
      return transport.query(request);
    },
    async command<TName extends CommandName>(request: ClientCommandRequest<TName>) {
      if (request.commandName === "session.resume") {
        const call = request as ClientCommandRequest<"session.resume">;
        if (call.input.threadId !== threadId || call.input.model !== undefined) denied();
      } else {
        const state = await transport.bootstrap();
        if (state.snapshot?.sessionId !== sessionId || state.runtime.status !== "connected") denied();
        if (request.commandName === "interaction.respond") {
          const call = request as ClientCommandRequest<"interaction.respond">;
          const interaction = state.pendingInteraction;
          if (!toolApproval(interaction) || interaction?.interactionId !== call.input.interactionId || interaction.leaseGeneration !== call.input.leaseGeneration) denied();
          if (call.input.decision !== "cancel" && (call.input.decision !== "submit" || call.input.value !== true)) denied();
          if (call.input.decision === "cancel" && call.input.value !== undefined) denied();
        } else if (request.commandName === "core.prompt") {
          if ((request as ClientCommandRequest<"core.prompt">).input.images !== undefined) denied();
        } else if (request.commandName !== "core.abort") denied();
      }
      return transport.command(request);
    },
    subscribe: (_scope, listener) => transport.subscribe({ scope: "all" }, event => listener(projectEvent(event))),
    close: () => transport.close(),
  };
}

export function createMobileScope(host: WebAdapterHost, workspaceId: WorkspaceId): WebAdapterHost {
  const history = () => host.query({ queryName: "history.list", input: { workspaceId, status: "active", limit: 500 } });
  return {
    async query<TName extends QueryName>(request: ClientQueryRequest<TName>) {
      if (request.queryName !== "history.list") denied();
      return await history() as ClientQueryResponse<TName>;
    },
    async openContext(scope: ClientContextScope) {
      if (!host.openContext || typeof scope.sessionId !== "string" || scope.workspaceId !== workspaceId) denied();
      const catalog = await history();
      const row = catalog.ok ? catalog.result.entries.find(entry => entry.sessionId === scope.sessionId) : undefined;
      if (!row?.sessionId) denied();
      const transport = await host.openContext({ workspaceId, sessionId: row.sessionId });
      return scopedConversation(transport, { ...row, sessionId: row.sessionId }, workspaceId);
    },
    async bootstrap() { return denied(); },
    async command() { return denied(); },
    subscribe() { return denied(); },
  };
}

/**
 * Canonical conversation fixtures for the plan 07 integration gate.
 *
 * Every public page and live event is parsed by the studio-protocol
 * contract validator at module load. Packages should import these objects
 * instead of inventing parallel shapes.
 */

import type {
  AuthorityEpoch,
  ClientEvent,
  CommandRequestId,
  EventCursor,
  OpaqueCursor,
  RuntimeEpoch,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import type {
  CommandId,
  ConversationRuntimeEvent,
  ConversationTranscriptPage,
  EventSeq,
  InteractionId,
  RemoteInteractionRequest,
  StudioEventEnvelope,
} from "@omp-studio/studio-protocol";
import { parseConversationRuntimeEvent, parseConversationTranscriptPage } from "@omp-studio/studio-protocol";

import { assertConversationPublicSafe } from "./conversation-safety.js";

export const CONVERSATION_FIXTURE_IDS = {
  authorityEpoch: 7 as AuthorityEpoch,
  runtimeEpoch: 3 as RuntimeEpoch,
  otherRuntimeEpoch: 4 as RuntimeEpoch,
  sessionId: "sess-0001" as SessionId,
  otherSessionId: "sess-0002" as SessionId,
  branchLeafId: "leaf-fixture",
  turnId: "turn-fixture-1",
  userItemId: "msg-user-1",
  assistantItemId: "msg-assistant-1",
  toolCallId: "call-1",
  blockId: "block-text-1",
  resetItemId: "reset-1",
  compactItemId: "compact-1",
  requestId: "cmd-req-prompt-1" as CommandRequestId,
} as const;

export const CONVERSATION_FIXTURE_T0 = "2026-08-15T12:00:00.000Z";
export const CONVERSATION_FIXTURE_T1 = "2026-08-15T12:00:01.000Z";
export const CONVERSATION_FIXTURE_T2 = "2026-08-15T12:00:02.000Z";
export const CONVERSATION_FIXTURE_T3 = "2026-08-15T12:00:03.000Z";

const HEAD_EMPTY = "opaque-head-empty" as OpaqueCursor;
const HEAD_USER_ASSISTANT = "opaque-head-user-assistant" as OpaqueCursor;
const HEAD_THINKING_TOOL = "opaque-head-thinking-tool" as OpaqueCursor;
const HEAD_COMPACTION = "opaque-head-compaction" as OpaqueCursor;
const OLDER_COMPACTION = "opaque-older-compaction" as OpaqueCursor;

function page(value: ConversationTranscriptPage): ConversationTranscriptPage {
  const parsed = parseConversationTranscriptPage(value);
  assertConversationPublicSafe(parsed);
  return parsed;
}

function event(value: ConversationRuntimeEvent): ConversationRuntimeEvent {
  const parsed = parseConversationRuntimeEvent(value);
  assertConversationPublicSafe(parsed);
  return parsed;
}

export const conversationIdentities = {
  current: {
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
  },
  other: {
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.otherRuntimeEpoch,
    sessionId: CONVERSATION_FIXTURE_IDS.otherSessionId,
  },
} as const;

const userMessage = {
  kind: "message" as const,
  itemId: CONVERSATION_FIXTURE_IDS.userItemId,
  parentId: null,
  createdAt: CONVERSATION_FIXTURE_T0,
  role: "user" as const,
  content: [{ type: "text" as const, text: "hello" }],
};

const assistantTextMessage = {
  kind: "message" as const,
  itemId: CONVERSATION_FIXTURE_IDS.assistantItemId,
  parentId: CONVERSATION_FIXTURE_IDS.userItemId,
  createdAt: CONVERSATION_FIXTURE_T1,
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "world" }],
};

const assistantThinkingToolMessage = {
  kind: "message" as const,
  itemId: CONVERSATION_FIXTURE_IDS.assistantItemId,
  parentId: CONVERSATION_FIXTURE_IDS.userItemId,
  createdAt: CONVERSATION_FIXTURE_T1,
  role: "assistant" as const,
  content: [
    { type: "thinking" as const, text: "I will inspect the manifest." },
    {
      type: "toolCall" as const,
      toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
      toolName: "Read",
      arguments: { path: "package.json" },
    },
    {
      type: "toolResult" as const,
      toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
      toolName: "Read",
      output: '{ "name": "omp-studio" }',
      isError: false,
    },
    { type: "text" as const, text: "This is a Studio workspace." },
  ],
};

const liveCompletedItem = {
  kind: "message" as const,
  itemId: CONVERSATION_FIXTURE_IDS.assistantItemId,
  parentId: CONVERSATION_FIXTURE_IDS.userItemId,
  createdAt: CONVERSATION_FIXTURE_T1,
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "正在完成" }],
};

export const conversationPages = {
  empty: page({
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    branchLeafId: CONVERSATION_FIXTURE_IDS.branchLeafId,
    items: [],
    headCursor: HEAD_EMPTY,
    hasMoreBefore: false,
  }),
  userAssistant: page({
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    branchLeafId: CONVERSATION_FIXTURE_IDS.branchLeafId,
    items: [userMessage, assistantTextMessage],
    headCursor: HEAD_USER_ASSISTANT,
    hasMoreBefore: false,
  }),
  thinkingTool: page({
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    branchLeafId: CONVERSATION_FIXTURE_IDS.branchLeafId,
    items: [userMessage, assistantThinkingToolMessage],
    headCursor: HEAD_THINKING_TOOL,
    hasMoreBefore: false,
  }),
  compactionReset: page({
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    branchLeafId: CONVERSATION_FIXTURE_IDS.branchLeafId,
    items: [
      {
        kind: "resetBoundary",
        itemId: CONVERSATION_FIXTURE_IDS.resetItemId,
        parentId: null,
        createdAt: CONVERSATION_FIXTURE_T0,
      },
      { ...userMessage, parentId: CONVERSATION_FIXTURE_IDS.resetItemId },
      assistantThinkingToolMessage,
      {
        kind: "compaction",
        itemId: CONVERSATION_FIXTURE_IDS.compactItemId,
        parentId: CONVERSATION_FIXTURE_IDS.assistantItemId,
        createdAt: CONVERSATION_FIXTURE_T3,
        summary: "User asked about package.json; assistant summarized the workspace.",
        shortSummary: "Workspace summary",
        warning: "little context freed",
      },
    ],
    olderCursor: OLDER_COMPACTION,
    headCursor: HEAD_COMPACTION,
    hasMoreBefore: true,
  }),
} as const;

export const conversationLiveSequence: readonly ConversationRuntimeEvent[] = [
  event({
    kind: "conversation.message.started",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
    role: "assistant",
    createdAt: CONVERSATION_FIXTURE_T1,
  }),
  event({
    kind: "conversation.message.delta",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
    blockId: CONVERSATION_FIXTURE_IDS.blockId,
    blockType: "text",
    delta: "正在",
  }),
  event({
    kind: "conversation.message.delta",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
    blockId: CONVERSATION_FIXTURE_IDS.blockId,
    blockType: "text",
    delta: "完成",
  }),
  event({
    kind: "conversation.message.completed",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
    item: liveCompletedItem,
  }),
  event({
    kind: "conversation.tool.started",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
    toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
    toolName: "Read",
    arguments: { path: "package.json" },
    startedAt: CONVERSATION_FIXTURE_T1,
  }),
  event({
    kind: "conversation.tool.updated",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
    updateMode: "append",
    output: '{ "name":',
  }),
  event({
    kind: "conversation.tool.completed",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
    toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
    result: {
      type: "toolResult",
      toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
      toolName: "Read",
      output: '{ "name": "omp-studio" }',
      isError: false,
    },
    completedAt: CONVERSATION_FIXTURE_T2,
  }),
  event({
    kind: "conversation.turn.completed",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
  }),
];

export const conversationLiveToolError: ConversationRuntimeEvent = event({
  kind: "conversation.tool.completed",
  sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
  turnId: CONVERSATION_FIXTURE_IDS.turnId,
  toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
  result: {
    type: "toolResult",
    toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
    toolName: "Bash",
    output: "exit 1",
    isError: true,
  },
  completedAt: CONVERSATION_FIXTURE_T2,
});

export const conversationLiveParallelToolStarted: ConversationRuntimeEvent = event({
  kind: "conversation.tool.started",
  sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
  turnId: CONVERSATION_FIXTURE_IDS.turnId,
  messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
  toolCallId: "call-2",
  toolName: "Grep",
  arguments: { pattern: "Runtime" },
  startedAt: CONVERSATION_FIXTURE_T1,
});

const lateDelta = event({
  kind: "conversation.message.delta",
  sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
  turnId: CONVERSATION_FIXTURE_IDS.turnId,
  messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
  blockId: CONVERSATION_FIXTURE_IDS.blockId,
  blockType: "text",
  delta: " late",
});

const gapDelta = event({
  kind: "conversation.message.delta",
  sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
  turnId: CONVERSATION_FIXTURE_IDS.turnId,
  messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
  blockId: CONVERSATION_FIXTURE_IDS.blockId,
  blockType: "text",
  delta: "gap",
});

const otherEpochStarted = event({
  kind: "conversation.message.started",
  sessionId: CONVERSATION_FIXTURE_IDS.otherSessionId,
  turnId: "turn-other",
  messageId: "msg-other-1",
  role: "assistant",
  createdAt: CONVERSATION_FIXTURE_T1,
});

export const conversationFaultEvents = {
  started: conversationLiveSequence[0]!,
  duplicateStarted: conversationLiveSequence[0]!,
  lateDelta,
  gapDelta,
  otherEpochStarted,
  aborted: event({
    kind: "conversation.turn.aborted",
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    turnId: CONVERSATION_FIXTURE_IDS.turnId,
  }),
  completed: conversationLiveSequence.find((entry) => entry.kind === "conversation.message.completed")!,
} as const;

function snapshotResult() {
  return {
    runtimeId: "rt-0001",
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    stateVersion: 41 as StateVersion,
    sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal" as const, approvalMode: "yolo",
    pendingMessages: 0,
    activeCommandIds: [] as const,
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [] as const,
    jobs: [] as const,
  };
}

function receiptBase(
  status: "completed" | "failed" | "rejected" | "outcome_unknown",
  extra: Record<string, unknown>,
): ClientEvent {
  return {
    authorityEpoch: CONVERSATION_FIXTURE_IDS.authorityEpoch,
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    stateVersion: 43 as StateVersion,
    cursor: `c-receipt-${status}` as EventCursor,
    occurredAt: CONVERSATION_FIXTURE_T3,
    kind: "command.receipt",
    receipt: {
      requestId: CONVERSATION_FIXTURE_IDS.requestId,
      commandName: "core.prompt",
      status,
      observedAt: CONVERSATION_FIXTURE_T3,
      ...extra,
    },
  } as ClientEvent;
}

export const conversationReceipts = {
  completed: receiptBase("completed", { result: snapshotResult() }),
  failed: receiptBase("failed", { error: { code: "INTERNAL_ERROR", message: "model failed" } }),
  rejected: receiptBase("rejected", { reason: "precondition rejected" }),
  outcomeUnknown: receiptBase("outcome_unknown", { reason: "runtime lost; outcome unknown" }),
} as const;

const interactionBase = {
  interactionId: "int-fixture-1" as InteractionId,
  commandId: "cmd-fixture-1" as CommandId,
  title: "Runtime title is discarded",
};

export const conversationInteractions: {
  readonly confirm: RemoteInteractionRequest;
  readonly select: RemoteInteractionRequest;
  readonly input: RemoteInteractionRequest;
  readonly editor: RemoteInteractionRequest;
  readonly approval: RemoteInteractionRequest;
} = {
  confirm: { ...interactionBase, kind: "confirm", message: "Continue with the change?" },
  select: {
    ...interactionBase,
    kind: "select",
    options: [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B", description: "Second choice" },
    ],
  },
  input: { ...interactionBase, kind: "input", placeholder: "Type a reply" },
  editor: { ...interactionBase, kind: "editor", content: "draft text", language: "markdown" },
  approval: {
    ...interactionBase,
    kind: "approval",
    approvalType: "bash",
    details: { command: "npm test", reason: "run the gate" },
  },
};

/** Negative cases only. Not public-safe; never send these as success fixtures. */
export const conversationUnsafe = {
  secretArguments: {
    apiKey: "sk-live-secret",
    authorization: "Bearer super-secret",
    cookie: "session=document.cookie",
    token: "tok-secret",
    password: "hunter2",
    providerPayload: { raw: true },
    home: "C:\\Users\\alice\\project",
    unixHome: "/Users/alice/secret",
    html: '<script>alert(1)</script><img src=x onerror="alert(1)">',
  },
  prototypeKeys: JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
  ) as Record<string, unknown>,
};

export function conversationChangedEvent(
  update: ConversationRuntimeEvent,
  eventSeq: number,
  extra: { readonly runtimeEpoch?: RuntimeEpoch; readonly stateVersion?: StateVersion } = {},
): Extract<ClientEvent, { kind: "conversation.changed" }> {
  return {
    kind: "conversation.changed",
    authorityEpoch: CONVERSATION_FIXTURE_IDS.authorityEpoch,
    runtimeEpoch: extra.runtimeEpoch ?? CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    stateVersion: extra.stateVersion ?? (41 as StateVersion),
    cursor: `c-convo-${eventSeq}` as EventCursor,
    occurredAt: CONVERSATION_FIXTURE_T1,
    sessionId: update.sessionId,
    eventSeq,
    update,
  };
}

export function conversationStudioEnvelope(
  update: ConversationRuntimeEvent,
  eventSeq: number,
): StudioEventEnvelope<ConversationRuntimeEvent> {
  return {
    type: "studio.event",
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    eventSeq: eventSeq as EventSeq,
    stateVersion: 41 as StateVersion,
    occurredAt: CONVERSATION_FIXTURE_T1,
    event: update,
  };
}

export const conversationLiveClientEvents = conversationLiveSequence.map((update, index) =>
  conversationChangedEvent(update, index + 1),
);

import type {
  ConversationContentBlock,
  ConversationItem,
  ConversationRuntimeEvent,
  RuntimeEpoch,
  SessionId,
} from "@omp-studio/studio-protocol";
import type { JsonValue } from "@omp-studio/client-contract";
import {
  applyLiveEvent,
  buildTimeline,
  emptyConversationState,
  type ConversationState,
  type TimelineRow,
} from "../conversation/conversationViewModel";
import { NATIVE_TOOL_GALLERY } from "./nativeToolGallery";

const epoch = 1 as RuntimeEpoch;
const session = "preview-session" as SessionId;
const at = (second: number) => `2026-08-15T06:02:${String(second).padStart(2, "0")}.000Z`;

function outputString(card: { readonly [key: string]: JsonValue }): string {
  const output = card.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((line) => (Array.isArray(line) ? String(line[0] ?? "") : String(line))).join("\n");
  }
  if (output !== undefined) return JSON.stringify(output);
  const answer = typeof card.answer === "string" ? card.answer : undefined;
  const full = typeof card.full === "string" ? card.full : undefined;
  const report = typeof card.report === "string" ? card.report : undefined;
  return answer ?? full ?? report ?? "";
}

function galleryBlocks(): ConversationContentBlock[] {
  const blocks: ConversationContentBlock[] = [];
  for (const [index, card] of NATIVE_TOOL_GALLERY.entries()) {
    const name = typeof card.name === "string" ? card.name : `tool-${index}`;
    const status = typeof card.status === "string" ? card.status : "done";
    const id = `preview-gallery-${index}`;
    blocks.push({
      type: "toolCall",
      toolCallId: id,
      toolName: name,
      arguments: card,
    });
    blocks.push({
      type: "toolResult",
      toolCallId: id,
      toolName: name,
      output: outputString(card),
      isError: status === "error",
    });
  }
  return blocks;
}

/**
 * Preview-only transcript. Types are the frozen studio-protocol conversation
 * contract — not a parallel PreviewEvent story. Real mode must never import this.
 *
 * The assistant turn is the ver1 native-tool-card gallery (scene 42): one
 * expanded batch so every tool-card body is visible.
 */
export const PREVIEW_CONVO_ITEMS: readonly ConversationItem[] = [
  {
    kind: "resetBoundary",
    itemId: "preview-reset-1",
    parentId: null,
    createdAt: at(0),
  },
  {
    kind: "message",
    itemId: "preview-user-1",
    parentId: "preview-reset-1",
    createdAt: at(2),
    role: "user",
    content: [{ type: "text", text: "打开 OMP 原生工具卡图鉴" }],
  },
  {
    kind: "message",
    itemId: "preview-assistant-1",
    parentId: "preview-user-1",
    createdAt: at(4),
    role: "assistant",
    content: galleryBlocks(),
  },
];

/** Small transcript variants used by the composer preview states. */
export function previewConversationItems(threadId = "t1"): readonly ConversationItem[] {
  if (threadId === "t0") return [];
  if (threadId === "t4") return PREVIEW_CONVO_ITEMS.slice(0, 2);
  return PREVIEW_CONVO_ITEMS;
}

export const PREVIEW_CONVO_LIVE: readonly ConversationRuntimeEvent[] = [
  {
    kind: "conversation.message.started",
    sessionId: session,
    turnId: "preview-live-turn",
    messageId: "preview-live-user",
    role: "user",
    createdAt: at(18),
  },
  {
    kind: "conversation.message.completed",
    sessionId: session,
    turnId: "preview-live-turn",
    messageId: "preview-live-user",
    item: {
      kind: "message",
      itemId: "preview-live-user",
      parentId: "preview-assistant-1",
      createdAt: at(18),
      role: "user",
      content: [{ type: "text", text: "再跑一遍 typecheck，看着输出" }],
    },
  },
  {
    kind: "conversation.message.started",
    sessionId: session,
    turnId: "preview-live-turn",
    messageId: "preview-live-assistant",
    role: "assistant",
    createdAt: at(20),
  },
  {
    kind: "conversation.tool.started",
    sessionId: session,
    turnId: "preview-live-turn",
    messageId: "preview-live-assistant",
    toolCallId: "preview-bash-live",
    toolName: "Bash",
    arguments: { command: "npm run typecheck", cwd: "D:/Project/omp-web" },
    startedAt: at(21),
  },
  {
    kind: "conversation.tool.updated",
    sessionId: session,
    turnId: "preview-live-turn",
    toolCallId: "preview-bash-live",
    updateMode: "replace",
    output: "\u001b[33m> tsc --noEmit\u001b[0m\n\nsrc/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
  },
];

export const PREVIEW_CONVO_IDENTITY = { runtimeEpoch: epoch, sessionId: session };

export function previewConversationRows(): TimelineRow[] {
  let state: ConversationState = {
    ...emptyConversationState(1),
    identity: PREVIEW_CONVO_IDENTITY,
    items: PREVIEW_CONVO_ITEMS,
    hydrateStatus: "ready",
  };
  for (const event of PREVIEW_CONVO_LIVE) {
    state = applyLiveEvent(state, event, PREVIEW_CONVO_IDENTITY);
  }
  return buildTimeline(state);
}

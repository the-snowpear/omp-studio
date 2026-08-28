import type {
  ConversationContentBlock,
  ConversationItem,
  ConversationRuntimeEvent,
  RuntimeEpoch,
  SessionId,
} from "@omp-studio/studio-protocol";
import type { JsonValue } from "@omp-studio/client-contract";
import type { TimelineRow } from "../conversation/conversationViewModel";
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

function blocksFromCards(cards: readonly { readonly [key: string]: JsonValue }[], idPrefix: string): ConversationContentBlock[] {
  const blocks: ConversationContentBlock[] = [];
  for (const [index, card] of cards.entries()) {
    const name = typeof card.name === "string" ? card.name : `tool-${index}`;
    const status = typeof card.status === "string" ? card.status : "done";
    const id = `${idPrefix}-${index}`;
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

function galleryBlocks(): ConversationContentBlock[] {
  return blocksFromCards(NATIVE_TOOL_GALLERY, "preview-gallery");
}

const RESET: ConversationItem = {
  kind: "resetBoundary",
  itemId: "preview-reset-1",
  parentId: null,
  createdAt: at(0),
};

/**
 * Full native-tool-card gallery (scene 42). Tests and the tool-card walkthrough
 * use this; the workbench preview conversation uses a shorter project story.
 */
export function previewGalleryItems(): readonly ConversationItem[] {
  return [
    RESET,
    {
      kind: "message",
      itemId: "preview-gallery-user",
      parentId: "preview-reset-1",
      createdAt: at(2),
      role: "user",
      content: [{ type: "text", text: "打开 OMP 原生工具卡图鉴" }],
    },
    {
      kind: "message",
      itemId: "preview-gallery-assistant",
      parentId: "preview-gallery-user",
      createdAt: at(4),
      role: "assistant",
      content: galleryBlocks(),
    },
  ];
}

/** omp-web 上游同步：工作台预览对话用，看起来像真实项目回合。 */
const STORY_CARDS: readonly { readonly [key: string]: JsonValue }[] = [
  {
    kind: "think",
    name: "Think",
    status: "done",
    dur: "6s",
    preview: "先核对 package.json 钉住的上游版本，再扫 docs 里现有同步说明。本地 Studio Bridge 和会话目录不要写回 pi-web。",
    full: "目标：把 pi-web v0.8.1 合进 omp-web。\n保留 packages/studio-bridge 与 ~/.omp/agent/sessions。\n文档落到 docs/UPSTREAM-SYNC.md，README 加入口。",
  },
  {
    kind: "read",
    name: "Read",
    target: "package.json",
    status: "done",
    dur: "0.2s",
    lines: 42,
    encoding: "UTF-8",
    size: "1.4 KB",
    offset: 1,
    preview: [
      "{",
      "  \"name\": \"omp-web\",",
      "  \"version\": \"0.8.0\",",
      "  \"dependencies\": {",
      "    \"@earendil-works/pi-web\": \"0.8.0\"",
      "  }",
      "}",
    ],
  },
  {
    kind: "grep",
    name: "Grep",
    target: "UPSTREAM in docs/",
    status: "done",
    dur: "0.3s",
    pattern: "UPSTREAM|Studio Bridge",
    paths: "docs/",
    count: "3 matches · 2 files",
    matches: [
      { file: "docs/README.md", line: "12", text: "- 上游同步尚未成文" },
      { file: "docs/ARCH.md", line: "40", text: "Studio Bridge 不随 pi-web 路径迁移" },
    ],
  },
  {
    kind: "write",
    name: "Write",
    target: "docs/UPSTREAM-SYNC.md",
    status: "done",
    dur: "1.4s",
    created: true,
    lines: 86,
    encoding: "UTF-8",
    preview: ["# 上游同步记录", "", "## v0.8.1", "", "- 保留 Studio Bridge", "- 会话目录仍走 ~/.omp"],
  },
  {
    kind: "edit",
    name: "Edit",
    target: "README.md",
    status: "done",
    dur: "0.5s",
    diff: [
      [" ", "46", "46", "- [更新日志](docs/CHANGELOG.md)"],
      ["+", "", "47", "- [上游同步](docs/UPSTREAM-SYNC.md)"],
      [" ", "47", "48", "- [架构说明](docs/ARCH.md)"],
    ],
  },
  {
    kind: "todo",
    name: "Todo",
    target: "update phase 验证",
    status: "done",
    dur: "0.1s",
    op: "done",
    phases: [
      {
        name: "文档",
        tasks: [
          { content: "阅读 docs 与 package.json", status: "completed" },
          { content: "写 UPSTREAM-SYNC.md", status: "completed" },
        ],
      },
      {
        name: "验证",
        tasks: [
          { content: "typecheck / lint", status: "in_progress" },
          { content: "核对 Studio Bridge 路径未回写", status: "pending" },
        ],
      },
    ],
  },
  {
    kind: "task",
    name: "Task",
    status: "done",
    dur: "42s",
    spawn: {
      agent: "scout",
      isolated: true,
      context: "# Goal\n并行调研上游 v0.8.1：依赖钉住点与 Release Notes。不要改工作区。",
      tasks: [
        { name: "deps", agent: "scout", task: "审计 @earendil-works/pi-* 0.8.1 变更" },
        { name: "docs", agent: "scout", task: "提取 v0.8.1 Release Notes 要点" },
      ],
    },
    agents: [
      {
        id: "agent-019fcb01",
        name: "deps",
        status: "done",
        activity: "done",
        dur: "38s",
        resolvedModel: "gemini-3.6-flash",
        thinking: "max",
        tokens: "12.6k",
        tools: 8,
        requests: 4,
        cost: "¥ 0.51",
        files: 6,
        lastTool: "Grep · \"pi-core\" in lockfile",
      },
      {
        id: "agent-019fc9d2",
        name: "docs",
        status: "done",
        activity: "done",
        dur: "41s",
        resolvedModel: "claude-sonnet-4.5",
        thinking: "high",
        tokens: "9.8k",
        tools: 5,
        requests: 3,
        cost: "¥ 0.36",
        files: 2,
        lastTool: "Web Search · v0.8.1 notes",
      },
    ],
  },
];

/**
 * Preview-only transcript. Types are the frozen studio-protocol conversation
 * contract — not a parallel PreviewEvent story. Real mode must never import this.
 */
export const PREVIEW_CONVO_ITEMS: readonly ConversationItem[] = [
  RESET,
  {
    kind: "message",
    itemId: "preview-user-1",
    parentId: "preview-reset-1",
    createdAt: at(2),
    role: "user",
    content: [{
      type: "text",
      text: "用 /skill:upstream-sync 把上游 pi-web v0.8.1 同步进 omp-web。保留本地 Studio Bridge 和会话目录，不要写回 pi-web 路径。先读 @docs/ 和 @package.json，再出文档。",
    }],
  },
  {
    kind: "message",
    itemId: "preview-assistant-1",
    parentId: "preview-user-1",
    createdAt: at(4),
    role: "assistant",
    content: [
      ...blocksFromCards(STORY_CARDS, "preview-story"),
      {
        type: "text",
        text: "文档已经写到 `docs/UPSTREAM-SYNC.md`，README 加了入口。Studio Bridge 和会话目录都没动。接下来跑 typecheck。",
      },
    ],
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
      content: [{ type: "text", text: "文档写完了。再跑一遍 typecheck，输出盯着，TS2322 一并修掉。" }],
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

// TODO: applyLiveEvent / buildTimeline removed — fixture generation needs reimplementation
export function previewConversationRows(): TimelineRow[] {
  return [];
}

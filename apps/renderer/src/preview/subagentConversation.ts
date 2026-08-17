import type { ConversationItem } from "@omp-studio/client-contract";

const T0 = "2026-08-17T04:00:00.000Z";
const T1 = "2026-08-17T04:00:08.000Z";
const T2 = "2026-08-17T04:00:22.000Z";

const DEPS_ITEMS: ConversationItem[] = [
  {
    kind: "message",
    itemId: "preview-deps-user",
    parentId: null,
    createdAt: T0,
    role: "user",
    content: [{ type: "text", text: "审计 @earendil-works/pi-* 0.82.1 变更" }],
  },
  {
    kind: "message",
    itemId: "preview-deps-assistant",
    parentId: "preview-deps-user",
    createdAt: T1,
    role: "assistant",
    content: [
      { type: "thinking", text: "先对照 lockfile 和上游 changelog，确认是否只有 patch。" },
      { type: "text", text: "已扫过 lockfile：`pi-core` 与 `pi-agent` 升到 0.82.1，没有破坏性导出。" },
      { type: "toolCall", toolCallId: "preview-deps-grep", toolName: "grep", arguments: { pattern: "pi-core" } },
      {
        type: "toolResult",
        toolCallId: "preview-deps-grep",
        toolName: "grep",
        isError: false,
        output: "4 matches in 2 files",
      },
    ],
  },
];

const DOCS_ITEMS: ConversationItem[] = [
  {
    kind: "message",
    itemId: "preview-docs-user",
    parentId: null,
    createdAt: T0,
    role: "user",
    content: [{ type: "text", text: "提取 v0.8.1 Release Notes 要点" }],
  },
  {
    kind: "message",
    itemId: "preview-docs-assistant",
    parentId: "preview-docs-user",
    createdAt: T2,
    role: "assistant",
    content: [{ type: "text", text: "Release Notes 里和 Studio 相关的是 conversation live projector 与 session telemetry。" }],
  },
];

const PREVIEW_ITEMS: ConversationItem[] = [
  {
    kind: "message",
    itemId: "preview-preview-user",
    parentId: null,
    createdAt: T0,
    role: "user",
    content: [{ type: "text", text: "核对 Mermaid 全屏缩放" }],
  },
  {
    kind: "message",
    itemId: "preview-preview-assistant",
    parentId: "preview-preview-user",
    createdAt: T1,
    role: "assistant",
    content: [
      { type: "text", text: "全屏缩放按钮在窄窗口下仍然可点，没有挡住关闭。" },
      { type: "toolCall", toolCallId: "preview-browser", toolName: "browser", arguments: { action: "waitForSelector" } },
      {
        type: "toolResult",
        toolCallId: "preview-browser",
        toolName: "browser",
        isError: false,
        output: "selector visible",
      },
    ],
  },
];

const BY_AGENT_ID: { readonly [agentId: string]: readonly ConversationItem[] } = {
  "agent-019fcb01": DEPS_ITEMS,
  "agent-019fc9d2": DOCS_ITEMS,
  "agent-019fcb17": PREVIEW_ITEMS,
};

export function previewSubagentConversationItems(agentId: string): readonly ConversationItem[] {
  return BY_AGENT_ID[agentId] ?? DEPS_ITEMS;
}

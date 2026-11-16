import type { ContextCategoryId, ContextEntrySummary, ContextViewIndex, ContextViewSourceMarker } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";
import { PREVIEW_CONTEXT_CARD } from "./contextCardPreview";

const context = PREVIEW_CONTEXT_CARD;
const bufferTokens = 200_000;

const ENTRY = (entry: Omit<ContextEntrySummary, "bytes" | "preview"> & { preview?: string }, zh = isZh()): ContextEntrySummary => ({
  bytes: Math.max(120, entry.tokens * 2),
  preview: (entry.preview ?? (zh ? `${entry.label} 的正文摘要只用于列表预览，完整内容在右侧读取。` : `Summary preview for ${entry.label}; read the full body on the right.`)).slice(0, 480),
  ...entry,
});

const THINKING_A = { id: "assistant-thinking/4/0", label: "Message 4", tokens: 8_000 };
const THINKING_B = { id: "assistant-thinking/6/0", label: "Message 6", tokens: 7_000 };

function buildEntries(zh: boolean): Record<ContextCategoryId, ContextEntrySummary[]> {
  return {
    "system-prompt": [
      ENTRY({ id: "system-prompt/0", label: "System Block 1", tokens: 12_000, preview: "You are a coding agent running inside the OMP runtime…" }, zh),
      ENTRY({ id: "system-prompt/1", label: "System Block 2", tokens: 1_000, preview: "## Additional effective policy\n\nAn extension updated one source block after the prompt build." }, zh),
    ],
    "instruction-files": [
      ENTRY({ id: "instruction-files/agents", label: "AGENTS.md", path: "AGENTS.md", tokens: 27_000, preview: "## Workspace conventions\n\nKeep the typed Studio Bridge as the capability boundary." }, zh),
      ENTRY({ id: "instruction-files/project", label: ".omp/project.md", path: ".omp/project.md", tokens: 15_000, preview: "## Project instructions\n\nUse the existing workbench components and scoped resources." }, zh),
    ],
    skills: [ENTRY({ id: "skills/conventions", label: "repo-conventions", path: ".omp/skills/repo-conventions/SKILL.md", tokens: context.skillsTokens, preview: "<skill name=\"repo-conventions\">\nKeep product and Runtime ownership aligned.\n</skill>" }, zh)],
    "built-in-tools": [
      ENTRY({ id: "built-in-tools/0", label: "read", tokens: 4_800, info: "native" }, zh),
      ENTRY({ id: "built-in-tools/1", label: "bash", tokens: 4_200, info: "native" }, zh),
      ENTRY({ id: "built-in-tools/2", label: "edit", tokens: 3_000, info: "native" }, zh),
    ],
    "custom-tools": [ENTRY({ id: "custom-tools/0", label: "mcp__docs__search", tokens: 6_000, info: "mcp · docs" }, zh)],
    "user-messages": [
      ENTRY({ id: "user-messages/0", label: "user · message 1", tokens: 900, preview: zh ? "看一下现在的上下文查看器是什么？" : "Check how the current context inspector works?" }, zh),
      ENTRY({ id: "user-messages/1", label: "user · message 3", tokens: 1_400, preview: zh ? "帮我写计划补齐一下，同时保证原生使用体验。" : "Help me plan the missing pieces while keeping native UX intact." }, zh),
      ENTRY({ id: "user-messages/2", label: "developer · message 8", tokens: 27_700, info: "developer → user", preview: "Preview mode rules: fixtures cover read surfaces only…" }, zh),
    ],
    "assistant-messages": [
      ENTRY({ id: "assistant-messages/1/0", label: "text · message 2", tokens: 18_000, preview: zh ? "现在的查看器是类别下拉 + 条目列表 + 纯文本正文。" : "The current viewer consists of category selector + entry list + plain-text body." }, zh),
      ENTRY({ id: "assistant-messages/3/0", label: "text · message 4", tokens: 42_000, preview: zh ? "方案分六步：契约、服务、纯函数、组件、总览、收尾。" : "The plan has six steps: contracts, services, pure helpers, components, overview, polish." }, zh),
    ],
    "assistant-thinking": [
      ENTRY({ id: "assistant-thinking/4/0/0", label: "Thinking 1/2 · message 4", tokens: 0, thinkingGroup: THINKING_A }, zh),
      ENTRY({ id: "assistant-thinking/4/0/1", label: "Thinking 2/2 · message 4", tokens: 0, thinkingGroup: THINKING_A }, zh),
      ENTRY({ id: "assistant-thinking/6/0/0", label: "Thinking 1/1 · message 6", tokens: 0, thinkingGroup: THINKING_B }, zh),
      ENTRY({ id: "assistant-thinking/8/0/payload", label: "Thinking 1/1 · message 8", tokens: 0, interrupted: true }, zh),
    ],
    "tool-calls": [
      ENTRY({ id: "tool-calls/4/0/1", label: "grep", tokens: 4_400, callId: "call_preview_1", preview: '{ "pattern": "context.view", "path": "apps/renderer/src" }' }, zh),
      ENTRY({ id: "tool-calls/6/0/1", label: "read", tokens: 4_000, callId: "call_preview_2", preview: '{ "path": "apps/renderer/src/conversation/ContextInspector.tsx" }' }, zh),
    ],
    "tool-output": [
      ENTRY({ id: "tool-output/4/1", label: "grep", tokens: 5_800, callId: "call_preview_1", childKey: "tool-output/tool-0", timestamp: 1_761_600_000_000, preview: "ContextInspector.tsx:25  client.query(\"context.view.open\"…)" }, zh),
      ENTRY({ id: "tool-output/5/1", label: "grep", tokens: 18_200, callId: "call_preview_1", childKey: "tool-output/tool-0", timestamp: 1_761_600_060_000, preview: "facade.ts:849  case \"context.view.open\":" }, zh),
      ENTRY({ id: "tool-output/6/1", label: "read", tokens: 5_400, callId: "call_preview_2", childKey: "tool-output/tool-1", timestamp: 1_761_600_120_000, preview: "1  import { useEffect, useRef, useState } from \"react\";" }, zh),
      ENTRY({ id: "tool-output/7/1", label: "read", tokens: 10_600, callId: "call_preview_2", childKey: "tool-output/tool-1", timestamp: 1_761_600_180_000, preview: "1  export type ContextCategoryId =" }, zh),
    ],
  };
}

const SOURCE_TEXT = "You are a coding agent running inside the OMP runtime…\n\n[Shown in Instruction Files: .omp/project.md]\n\n[Shown in Skills: repo-conventions]\n\nAdditional effective policy stays in this block.";
const SOURCE_MARKERS: ContextViewSourceMarker[] = [
  { label: "[Shown in Instruction Files: .omp/project.md]", category: "instruction-files" as const, entryId: "instruction-files/project" },
  { label: "[Shown in Skills: repo-conventions]", category: "skills" as const, entryId: "skills/conventions" },
].map(({ label, ...marker }) => ({ ...marker, start: SOURCE_TEXT.indexOf(label), end: SOURCE_TEXT.indexOf(label) + label.length }));

export function previewContextSourceMarkers(entry: ContextEntrySummary): readonly ContextViewSourceMarker[] {
  return entry.id === "system-prompt/0" ? SOURCE_MARKERS : [];
}

export const PREVIEW_CONTEXT_VIEW: ContextViewIndex = {
  sessionId: "demo-context",
  snapshotId: "demo-snapshot",
  capturedAt: "2026-10-28T10:00:00Z",
  contextWindow: context.contextWindow,
  usedTokens: context.usedTokens,
  freeTokens: context.contextWindow - context.usedTokens - bufferTokens,
  bufferTokens,
  thresholdTokens: 800_000,
  savedTokens: 6_400,
  truncated: false,
  notices: ["1 instruction file stays in System Prompt: the system prompt changed after it was built (e.g. by an extension hook or SDK callback)."],
  model: { id: "preview-model", name: "preview-model" },
  snapcompact: { visionCapable: true, savedTokens: 6_400 },
  categories: [
    { id: "system-prompt", label: "System Prompt", tokens: context.systemPromptTokens, entries: 2 },
    { id: "instruction-files", label: "Instruction Files", tokens: context.systemContextTokens, entries: 2 },
    { id: "skills", label: "Skills", tokens: context.skillsTokens, entries: 1 },
    { id: "built-in-tools", label: "Built-in Tools", tokens: 12_000, entries: 3 },
    { id: "custom-tools", label: "Custom Tools", tokens: 6_000, entries: 1 },
    { id: "user-messages", label: "User / Developer Messages", tokens: 30_000, entries: 3 },
    { id: "assistant-messages", label: "Assistant Messages", tokens: 60_000, entries: 2 },
    { id: "assistant-thinking", label: "Assistant Thinking", tokens: 15_000, entries: 4 },
    { id: "tool-calls", label: "Tool Calls", tokens: 8_400, entries: 2 },
    {
      id: "tool-output",
      label: "Tool Output",
      tokens: 10_000,
      entries: 4,
      children: [
        { id: "tool-output", key: "tool-output/tool-0", label: "grep", tokens: 5_800, entries: 2 },
        { id: "tool-output", key: "tool-output/tool-1", label: "read", tokens: 4_200, entries: 2 },
      ],
    },
  ],
};

export function previewContextEntries(category: ContextCategoryId, zh = isZh()): ContextEntrySummary[] {
  return buildEntries(zh)[category] ?? [];
}

export function previewContextText(category: ContextCategoryId, entry: ContextEntrySummary, zh = isZh()): string {
  if (entry.id === "system-prompt/0") return SOURCE_TEXT;
  if (category === "assistant-thinking")
    return entry.interrupted
      ? (zh ? "N/A · Interrupted\n\n这一轮被中断，推理内容没有回流。" : "N/A · Interrupted\n\nThis turn was interrupted; thinking content did not stream back.")
      : (zh ? "[Encrypted thinking]\nsignature · 384 chars\n\n不展示签名或加密内容的字节。" : "[Encrypted thinking]\nsignature · 384 chars\n\nSignature and encrypted bytes are omitted.");
  if (category === "tool-output")
    return zh
      ? `${entry.preview ?? ""}\n\n…\n\n（完整正文在快照里分页读取，这里只有开头几行。）`
      : `${entry.preview ?? ""}\n\n…\n\n(Full body is paginated from the snapshot; only the first few lines are shown here.)`;
  if (category === "built-in-tools" || category === "custom-tools")
    return `${entry.label}\n\n${zh ? "读取文件及分页内容。" : "Read file and paginated contents."}\n\n{\n  "type": "object",\n  "properties": { "path": { "type": "string" } }\n}`;
  return zh
    ? `${entry.preview ?? ""}\n\n快照只在打开时读取，关闭即释放。类别与 token 估算都来自当前会话的原生视图。`
    : `${entry.preview ?? ""}\n\nSnapshots are read only while open and released on close. Categories and token estimates come from the session's native view.`;
}

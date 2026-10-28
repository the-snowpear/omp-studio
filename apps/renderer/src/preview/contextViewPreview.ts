import type { ContextViewIndex, ContextEntrySummary } from "@omp-studio/studio-protocol";
export const PREVIEW_CONTEXT_VIEW: ContextViewIndex = {
  sessionId: "demo-context", snapshotId: "demo-snapshot", capturedAt: "2026-10-28T10:00:00Z", contextWindow: 200000, usedTokens: 38200, freeTokens: 145800, bufferTokens: 16000, thresholdTokens: 160000, savedTokens: 6400, truncated: false,
  categories: [
    { id: "system-prompt", label: "System Prompt", tokens: 6200, entries: 2 }, { id: "skills", label: "Skills", tokens: 800, entries: 0 },
    { id: "built-in-tools", label: "Built-in Tools", tokens: 4200, entries: 1 }, { id: "custom-tools", label: "Custom Tools", tokens: 1600, entries: 1 },
    { id: "user-messages", label: "User / Developer Messages", tokens: 3600, entries: 1 }, { id: "assistant-messages", label: "Assistant Messages", tokens: 7200, entries: 1 },
    { id: "assistant-thinking", label: "Assistant Thinking", tokens: 3000, entries: 1 }, { id: "tool-calls", label: "Tool Calls", tokens: 1800, entries: 1 }, { id: "tool-output", label: "Tool Output", tokens: 9800, entries: 1 },
  ],
};
export function previewContextEntries(category: string): ContextEntrySummary[] {
  if (category === "skills") return [];
  return [{ id: `${category}/0`, label: category === "custom-tools" ? "mcp__docs__search" : category === "tool-output" ? "read" : category === "assistant-thinking" ? "Thinking · message 4" : "Entry 1", tokens: 1200, bytes: 600, info: "演示 · 本次打开的原生快照" }];
}
export function previewContextText(category: string): string {
  if (category === "assistant-thinking") return "[Encrypted thinking]\nsignature · 384 chars\n\n不展示签名或加密内容的字节。";
  if (category === "tool-output") return "1  export function restoreSession() {\n2    return runtime.openLatestContinuation();\n3  }\n\n这是演示工具输出，不是工作区真值。";
  if (category === "built-in-tools" || category === "custom-tools") return "read\n\n读取文件及分页内容。\n\n{\n  \"type\": \"object\",\n  \"properties\": { \"path\": { \"type\": \"string\" } }\n}";
  return "这是上下文查看器的演示正文。\n\n快照只在打开时读取；关闭即释放。真实模式使用当前会话的原生类别和 token 估算，不展示账户密钥或 providerPayload。";
}

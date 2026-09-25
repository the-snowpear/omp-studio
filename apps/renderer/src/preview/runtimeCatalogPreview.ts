import type { McpRuntimeStatus, PromptTemplateRow } from "@omp-studio/studio-protocol";
export const PREVIEW_TEMPLATE: PromptTemplateRow = { id: "demo-template", name: "review-change", description: "检查变更中的行为、验证和风险", source: "(project)", version: "0".repeat(64) };
export const PREVIEW_TEMPLATE_TEXT = "检查以下变更：$ARGUMENTS\n\n说明可观察行为、已有验证和需要补充的测试。";
export const PREVIEW_MCP_RUNTIME: McpRuntimeStatus = { available: true, startupTimeoutMs: 250, ready: false, settled: false, total: 3, servers: [{ name: "filesystem", state: "ready", tools: 11 }, { name: "github", state: "pending", tools: 0 }, { name: "docs", state: "failed", tools: 0 }] };

import { isZh } from "../i18n";

export function getPreviewAgentDefinitions(zh = isZh()) {
  return [
    { name: "general-purpose", description: zh ? "执行常规开发与验证任务" : "Run general development and verification tasks" },
    { name: "scout", description: zh ? "只读探索并汇报发现" : "Read-only exploration and findings summary" },
  ];
}

export const PREVIEW_AGENT_DEFINITIONS = getPreviewAgentDefinitions();

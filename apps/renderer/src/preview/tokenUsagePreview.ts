import type { TokenUsageData } from "../usage/TokenUsagePanel";
import { PREVIEW_TELEMETRY as usage } from "./fixtures";

export function previewTokenUsage(zh: boolean): TokenUsageData {
  return {
    total: usage.totalBurn,
    turn: usage.turnBurn,
    cost: usage.cost,
    cacheHit: usage.cacheHitRate,
    parts: [
      { kind: "input", value: usage.inputTokens, weight: usage.inPct },
      { kind: "output", value: usage.outputTokens, weight: usage.outPct },
      { kind: "cache", value: usage.cacheTokens, weight: usage.cachePct },
    ],
    rows: [
      { label: zh ? "本轮输入 / 输出" : "Turn input / output", value: `${usage.turnIn} / ${usage.turnOut}` },
      { label: zh ? "本轮耗时" : "Turn duration", value: usage.turnTime },
      { label: zh ? "生成速度" : "Generation speed", value: `${usage.tps} tok/s` },
      { label: zh ? "会话总耗时" : "Session duration", value: usage.sessionTime },
    ],
    details: [
      { label: zh ? "子 Agent 费用" : "Subagent cost", value: usage.subagentCost },
      { label: zh ? "重试 / 回退" : "Retries / fallback", value: `${usage.retries} / ${zh ? "无" : "None"}` },
      { label: zh ? "当前模型" : "Current model", value: usage.model },
      { label: zh ? "推理强度" : "Thinking", value: usage.thinking },
      { label: zh ? "快速模式" : "Fast mode", value: usage.fastMode ? (zh ? "开启" : "On") : (zh ? "关闭" : "Off") },
      { label: zh ? "服务等级" : "Service tier", value: usage.serviceTier },
    ],
  };
}

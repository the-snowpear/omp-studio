/** OMP 18.3.0 catalog kinds. Older cached rows without a kind remain chat. */
export const MODEL_KINDS = ["chat", "tiny", "image", "tts", "stt", "search", "judge", "embedding", "rerank", "video"] as const;
export type ModelKind = typeof MODEL_KINDS[number];

export function parseModelKind(value: unknown): ModelKind | undefined {
  return typeof value === "string" && (MODEL_KINDS as readonly string[]).includes(value) ? value as ModelKind : undefined;
}

export const BUILTIN_MODEL_ROLES = [
  { id: "default", name: "Default", desc: "默认主模型" },
  { id: "smol", name: "Fast", desc: "快速、低成本任务" },
  { id: "slow", name: "Thinking", desc: "复杂推理任务" },
  { id: "vision", name: "Vision", desc: "视觉与图片理解" },
  { id: "plan", name: "Architect", desc: "规划和架构任务" },
  { id: "commit", name: "Commit", desc: "Commit 相关任务" },
  { id: "tiny", name: "Tiny", desc: "标题等轻量后台任务" },
  { id: "memory", name: "Memory", desc: "记忆整理与总结" },
  { id: "task", name: "Subtask", desc: "通用子任务" },
  { id: "advisor", name: "Advisor", desc: "第二模型审查" },
  { id: "image", name: "Image", desc: "图片生成" },
  { id: "web", name: "Web", desc: "联网搜索" },
  { id: "speech", name: "Speech", desc: "语音合成" },
  { id: "dictation", name: "Dictation", desc: "录音与音频转写" },
  { id: "judge", name: "Judge", desc: "结构化判断与批量评估" },
] as const;

/** Mirrors native roleCandidatePool; model capabilities are facts, not guesses from names. */
export function modelAcceptsRole(role: string, model: { readonly kind?: ModelKind; readonly webSearch?: string }): boolean {
  const kind = model.kind ?? "chat";
  switch (role) {
    case "tiny": case "memory": return kind === "tiny" || kind === "chat";
    case "image": return kind === "image";
    case "speech": return kind === "tts";
    case "dictation": return kind === "stt";
    case "web": return kind === "search" || (kind === "chat" && model.webSearch !== undefined);
    case "judge": return kind === "judge" || kind === "tiny" || kind === "chat";
    default: return kind === "chat";
  }
}

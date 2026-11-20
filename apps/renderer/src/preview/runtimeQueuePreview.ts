import type { RuntimeQueueResult } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export const previewHintCompression = { skills: 2, mcp: 1 };

export const runtimeQueuePreview = (zh = isZh()): RuntimeQueueResult => ({
  compactionMode: "handoff",
  total: 4,
  truncated: false,
  entries: [
    { id: "preview-compact", kind: "compaction", text: zh ? "压缩上下文" : "Compact context", queue: "followUp", state: "queued", imageCount: 0, editable: false },
    { id: "preview-after-compact", heldFor: "compaction", text: zh ? "压缩后运行相关测试" : "Run related tests after compaction", queue: "followUp", state: "held", imageCount: 0, editable: true },
    { id: "preview-q1", text: zh ? "检查截图中的布局问题" : "Check layout issues in screenshot", queue: "followUp", state: "queued", imageCount: 1, editable: true },
    { id: "preview-q2", text: zh ? "先保留当前改动，补充验收说明" : "Keep current changes and add acceptance notes", queue: "steering", state: "inFlight", imageCount: 0, editable: false },
  ],
});

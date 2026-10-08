import type { RuntimeQueueResult } from "@omp-studio/studio-protocol";
export const runtimeQueuePreview = (): RuntimeQueueResult => ({ total: 2, truncated: false, entries: [
 { id: "preview-q1", text: "检查截图中的布局问题", queue: "followUp", state: "queued", imageCount: 1, editable: true },
 { id: "preview-q2", text: "先保留当前改动，补充验收说明", queue: "steering", state: "inFlight", imageCount: 0, editable: false },
] });

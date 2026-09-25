import type { JudgmentBatchItem, JudgmentBatchRow, JudgmentBatchSpec } from "@omp-studio/studio-protocol";

export const PREVIEW_JUDGMENT_SPEC: JudgmentBatchSpec = {
  intent: "检查工作台验收说明", concurrency: 4, retries: 1, minOk: 1,
  items: [{ key: "composer", state: "输入框保留草稿，发送前可以编辑。" }, { key: "services", state: "保存服务配置不会自动启动。" }, { key: "quota", state: "额度刷新失败时显示未知。" }],
  questions: { clear: { type: "bool", instructions: "Does the description explain observable behavior?" } },
};
export const PREVIEW_JUDGMENT_BATCH: JudgmentBatchRow = { id: "demo-judgment", intent: "检查工作台验收说明", total: 3, done: 3, failed: 1, cost: 0.003, elapsedS: 2.4, running: false, model: "demo/judge" };
export const PREVIEW_JUDGMENT_ITEMS: JudgmentBatchItem[] = [
  { key: "composer", answers: { clear: { type: "bool", bool: 0.98 } }, model: "demo/judge" },
  { key: "services", answers: { clear: { type: "bool", bool: 0.99 } }, model: "demo/judge" },
  { key: "quota", error: "演示：请求超时，可重试失败项" },
];

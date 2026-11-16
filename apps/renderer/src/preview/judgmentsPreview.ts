import type { JudgmentBatchItem, JudgmentBatchRow, JudgmentBatchSpec } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewJudgmentSpec(zh = isZh()): JudgmentBatchSpec {
  return {
    intent: zh ? "检查工作台验收说明" : "Check workbench acceptance notes",
    concurrency: 4,
    retries: 1,
    minOk: 1,
    items: zh
      ? [
          { key: "composer", state: "输入框保留草稿，发送前可以编辑。" },
          { key: "services", state: "保存服务配置不会自动启动。" },
          { key: "quota", state: "额度刷新失败时显示未知。" },
        ]
      : [
          { key: "composer", state: "The composer preserves the draft so it can be edited before sending." },
          { key: "services", state: "Saving a service configuration does not auto-start it." },
          { key: "quota", state: "Quota shows unknown when refresh fails." },
        ],
    questions: { clear: { type: "bool", instructions: "Does the description explain observable behavior?" } },
  };
}

export function getPreviewJudgmentBatch(zh = isZh()): JudgmentBatchRow {
  return {
    id: "batch-4f21",
    intent: zh ? "检查工作台验收说明" : "Check workbench acceptance notes",
    total: 3,
    done: 3,
    failed: 1,
    cost: 0.003,
    elapsedS: 2.4,
    running: false,
    model: "openai/gpt-5-mini",
  };
}

export function getPreviewJudgmentItems(zh = isZh()): JudgmentBatchItem[] {
  return [
    { key: "composer", answers: { clear: { type: "bool", bool: 0.98 } }, model: "openai/gpt-5-mini" },
    { key: "services", answers: { clear: { type: "bool", bool: 0.99 } }, model: "openai/gpt-5-mini" },
    { key: "quota", error: zh ? "请求超时，可重试失败项" : "Request timed out; failed items can be retried" },
  ];
}

export const PREVIEW_JUDGMENT_SPEC: JudgmentBatchSpec = getPreviewJudgmentSpec();
export const PREVIEW_JUDGMENT_BATCH: JudgmentBatchRow = getPreviewJudgmentBatch();
export const PREVIEW_JUDGMENT_ITEMS: JudgmentBatchItem[] = getPreviewJudgmentItems();

import type { BtwSnapshot } from "@omp-studio/client-contract";

/**
 * BTW demo snapshots for preview mode.
 *
 * Static strings only — none of this reaches the Host, the reducer, or the
 * client contract. The three rounds cover the states the panel renders
 * differently: a streaming answer, a finished one, and a provider failure.
 */
export const PREVIEW_BTW_QUESTION = "为什么 SessionChanges 的 diff 会漏掉重命名？";

export const PREVIEW_BTW_SNAPSHOTS: readonly BtwSnapshot[] = [
  {
    ephemeralId: "btw-demo-running",
    topicId: "demo-live-topic", question: PREVIEW_BTW_QUESTION, turnIndex: 0,
    status: "running",
    text: "`SessionChanges` 目前只读 `turn.diff` 里的 `path`，重命名在 Runtime 侧是一对 `oldPath` / `newPath`，",
  },
  {
    ephemeralId: "btw-demo-completed",
    injection: { id: "demo-live-topic:0", state: "ready", before: "重命名需要保留旧路径与新路径，并在会话恢复后验证。", text: "请补齐 SessionChanges 的重命名字段，并验证新增、删除与重命名在恢复会话后仍正确显示。", after: "", },
    topicId: "demo-live-topic", question: PREVIEW_BTW_QUESTION, turnIndex: 0,
    status: "completed",
    text: [
      "`SessionChanges` 目前只读 `turn.diff` 里的 `path`，重命名在 Runtime 侧是一对",
      "`oldPath` / `newPath`，所以那条记录被当成「删一个、加一个」。",
      "",
      "三处要改：",
      "",
      "1. `conversationViewModel.ts` 保留 `oldPath`；",
      "2. `SessionChanges.tsx` 的分组键改成 `newPath ?? path`；",
      "3. 行渲染补一个 `oldPath → newPath` 的标签。",
    ].join("\n"),
    copy: "SessionChanges 只读 turn.diff 的 path，重命名在 Runtime 侧是 oldPath/newPath 一对。",
  },
  {
    ephemeralId: "btw-demo-failed",
    topicId: "demo-live-topic", question: PREVIEW_BTW_QUESTION, turnIndex: 0,
    status: "failed",
    text: "需要一起检查重命名字段和会话恢复后的差异。",
    error: { code: "INTERNAL_ERROR", message: "模型连接中断，可继续追问。" },
  },
];

/** Cycle position → snapshot, so the demo control can walk the three states. */
export function previewBtwSnapshot(index: number): BtwSnapshot {
  const list = PREVIEW_BTW_SNAPSHOTS;
  const safe = ((index % list.length) + list.length) % list.length;
  return list[safe] as BtwSnapshot;
}

export const PREVIEW_BTW_TOPICS = [{ topicId: "demo-live-topic", question: PREVIEW_BTW_QUESTION, status: "complete" as const, updatedAt: 1789171204000, turnCount: 1 }, { topicId: "demo-topic", question: PREVIEW_BTW_QUESTION, status: "complete" as const, updatedAt: 1789171200000, turnCount: 2 }, { topicId: "demo-interrupted-topic", question: PREVIEW_BTW_QUESTION, status: "interrupted" as const, updatedAt: 1789171205000, turnCount: 2 }];
export const PREVIEW_BTW_TURNS = [
 { question: PREVIEW_BTW_QUESTION, answer: PREVIEW_BTW_SNAPSHOTS[1]!.text, injection: PREVIEW_BTW_SNAPSHOTS[1]!.injection!, status: "complete" as const, createdAt: 1789171200000, updatedAt: 1789171201000 },
 { question: "应该怎样验证？", answer: "覆盖重命名、增删文件与会话恢复后的 diff 展示。", status: "complete" as const, createdAt: 1789171202000, updatedAt: 1789171203000 },
];

export const PREVIEW_BTW_INTERRUPTED_TURNS = PREVIEW_BTW_TURNS.map((turn, index) => index === 0 ? turn : { ...turn, answer: "先从重命名文件的旧路径和新路径开始检查。", status: "interrupted" as const });
export function createBtwPreviewHistory() {
 return new Map<string, readonly import("@omp-studio/client-contract").BtwHistoryTurn[]>([["demo-topic", PREVIEW_BTW_TURNS], ["demo-live-topic", PREVIEW_BTW_TURNS.slice(0, 1)], ["demo-interrupted-topic", PREVIEW_BTW_INTERRUPTED_TURNS]]);
}

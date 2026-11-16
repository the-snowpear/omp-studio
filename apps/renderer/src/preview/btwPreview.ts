import type { BtwSnapshot } from "@omp-studio/client-contract";
import { isZh } from "../i18n";

/**
 * BTW demo snapshots for preview mode.
 *
 * Static strings only — none of this reaches the Host, the reducer, or the
 * client contract. The three rounds cover the states the panel renders
 * differently: a streaming answer, a finished one, and a provider failure.
 */
export function getPreviewBtwQuestion(zh = isZh()): string {
  return zh ? "为什么 SessionChanges 的 diff 会漏掉重命名？" : "Why do SessionChanges diffs miss file renames?";
}

export function getPreviewBtwSnapshots(zh = isZh()): readonly BtwSnapshot[] {
  const question = getPreviewBtwQuestion(zh);
  return [
    {
      ephemeralId: "btw-demo-running",
      topicId: "demo-live-topic", question, turnIndex: 0,
      status: "running",
      text: zh
        ? "`SessionChanges` 目前只读 `turn.diff` 里的 `path`，重命名在 Runtime 侧是一对 `oldPath` / `newPath`，"
        : "`SessionChanges` currently only reads `path` from `turn.diff`, while renames on the Runtime side are an `oldPath` / `newPath` pair,",
    },
    {
      ephemeralId: "btw-demo-completed",
      injection: {
        id: "demo-live-topic:0",
        state: "ready",
        before: zh ? "重命名需要保留旧路径与新路径，并在会话恢复后验证。" : "Renames need both old and new paths preserved and verified after session resume.",
        text: zh
          ? "请补齐 SessionChanges 的重命名字段，并验证新增、删除与重命名在恢复会话后仍正确显示。"
          : "Add the rename fields to SessionChanges and verify added, deleted, and renamed files render properly after session resume.",
        after: "",
      },
      topicId: "demo-live-topic", question, turnIndex: 0,
      status: "completed",
      text: zh
        ? [
            "`SessionChanges` 目前只读 `turn.diff` 里的 `path`，重命名在 Runtime 侧是一对",
            "`oldPath` / `newPath`，所以那条记录被当成「删一个、加一个」。",
            "",
            "三处要改：",
            "",
            "1. `conversationViewModel.ts` 保留 `oldPath`；",
            "2. `SessionChanges.tsx` 的分组键改成 `newPath ?? path`；",
            "3. 行渲染补一个 `oldPath → newPath` 的标签。",
          ].join("\n")
        : [
            "`SessionChanges` currently reads only `path` from `turn.diff`, whereas renames arrive from the Runtime as",
            "`oldPath` / `newPath`, so the entry gets treated as \"one deleted, one added\".",
            "",
            "Three places to update:",
            "",
            "1. Keep `oldPath` in `conversationViewModel.ts`;",
            "2. Change the grouping key in `SessionChanges.tsx` to `newPath ?? path`;",
            "3. Render an `oldPath → newPath` badge on the row.",
          ].join("\n"),
      copy: zh
        ? "SessionChanges 只读 turn.diff 的 path，重命名在 Runtime 侧是 oldPath/newPath 一对。"
        : "SessionChanges only reads turn.diff path, whereas renames from the Runtime are an oldPath/newPath pair.",
    },
    {
      ephemeralId: "btw-demo-failed",
      topicId: "demo-live-topic", question, turnIndex: 0,
      status: "failed",
      text: zh ? "需要一起检查重命名字段和会话恢复后的差异。" : "We need to inspect rename fields alongside diffs after session resume.",
      error: { code: "INTERNAL_ERROR", message: zh ? "模型连接中断，可继续追问。" : "Model connection interrupted; you can keep asking follow-ups." },
    },
  ];
}

/** Cycle position → snapshot, so the demo control can walk the three states. */
export function previewBtwSnapshot(index: number, zh = isZh()): BtwSnapshot {
  const list = getPreviewBtwSnapshots(zh);
  const safe = ((index % list.length) + list.length) % list.length;
  return list[safe] as BtwSnapshot;
}

export function getPreviewBtwTopics(zh = isZh()) {
  const question = getPreviewBtwQuestion(zh);
  return [
    { topicId: "demo-live-topic", question, status: "complete" as const, updatedAt: 1789171204000, turnCount: 1 },
    { topicId: "demo-topic", question, status: "complete" as const, updatedAt: 1789171200000, turnCount: 2 },
    { topicId: "demo-interrupted-topic", question, status: "interrupted" as const, updatedAt: 1789171205000, turnCount: 2 },
  ];
}

export function getPreviewBtwTurns(zh = isZh()) {
  const question = getPreviewBtwQuestion(zh);
  const completed = getPreviewBtwSnapshots(zh)[1]!;
  return [
    { question, answer: completed.text, injection: completed.injection!, status: "complete" as const, createdAt: 1789171200000, updatedAt: 1789171201000 },
    { question: zh ? "应该怎样验证？" : "How should this be verified?", answer: zh ? "覆盖重命名、增删文件与会话恢复后的 diff 展示。" : "Cover renames, additions/deletions, and diff display after session resume.", status: "complete" as const, createdAt: 1789171202000, updatedAt: 1789171203000 },
  ];
}

export function getPreviewBtwInterruptedTurns(zh = isZh()) {
  return getPreviewBtwTurns(zh).map((turn, index) => index === 0 ? turn : {
    ...turn,
    answer: zh ? "先从重命名文件的旧路径和新路径开始检查。" : "Start by checking the oldPath and newPath on renamed files.",
    status: "interrupted" as const,
  });
}

export function createBtwPreviewHistory(zh = isZh()) {
  const turns = getPreviewBtwTurns(zh);
  return new Map<string, readonly import("@omp-studio/client-contract").BtwHistoryTurn[]>([
    ["demo-topic", turns],
    ["demo-live-topic", turns.slice(0, 1)],
    ["demo-interrupted-topic", getPreviewBtwInterruptedTurns(zh)],
  ]);
}

export const PREVIEW_BTW_QUESTION = getPreviewBtwQuestion();
export const PREVIEW_BTW_SNAPSHOTS: readonly BtwSnapshot[] = getPreviewBtwSnapshots();
export const PREVIEW_BTW_TOPICS = getPreviewBtwTopics();
export const PREVIEW_BTW_TURNS = getPreviewBtwTurns();
export const PREVIEW_BTW_INTERRUPTED_TURNS = getPreviewBtwInterruptedTurns();

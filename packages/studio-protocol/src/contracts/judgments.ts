/** Batch judgments share the native judge role, queue and accounting. */
export type JudgmentJson = null | boolean | number | string | JudgmentJson[] | { [key: string]: JudgmentJson };
export type JudgmentQuestion =
  | { type: "bool"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
export interface JudgmentBatchSpec {
  intent: string;
  items: Array<{ key: string | number; state: string | JudgmentJson[] | Record<string, JudgmentJson> }>;
  questions: Record<string, JudgmentQuestion>;
  concurrency: number;
  retries: number;
  minOk: number;
}
export type JudgmentAnswer =
  | { type: "bool"; bool: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export interface JudgmentBatchRow {
  id: string; intent: string; total: number; done: number; failed: number;
  cost: number; running: boolean; model?: string; elapsedS: number; error?: string;
}
export interface JudgmentBatchItem {
  key: string | number; answers?: Record<string, JudgmentAnswer>; error?: string; model?: string;
}
export interface JudgmentBatchPage {
  batch: JudgmentBatchRow; items: JudgmentBatchItem[]; offset: number; nextOffset: number;
}
export type JudgmentOperation =
  | { kind: "judgments.list"; sessionId: string; cursor?: string; limit?: number }
  | { kind: "judgments.create"; sessionId: string; spec: JudgmentBatchSpec }
  | { kind: "judgments.read"; sessionId: string; id: string; offset?: number; limit?: number }
  | { kind: "judgments.cancel"; sessionId: string; id: string }
  | { kind: "judgments.close"; sessionId: string; id: string }
  | { kind: "judgments.retry"; sessionId: string; id: string };
export interface JudgmentResultMap {
  "judgments.list": { batches: JudgmentBatchRow[]; nextCursor?: string };
  "judgments.create": { batch: JudgmentBatchRow };
  "judgments.read": JudgmentBatchPage;
  "judgments.cancel": { batch: JudgmentBatchRow; cancelled: boolean };
  "judgments.close": { closed: boolean };
  "judgments.retry": { batch: JudgmentBatchRow; sourceId: string };
}
export const JUDGMENT_OPERATION_KINDS = ["judgments.list", "judgments.create", "judgments.read", "judgments.cancel", "judgments.close", "judgments.retry"] as const;
export function isJudgmentOperationKind(value: string): value is JudgmentOperation["kind"] { return (JUDGMENT_OPERATION_KINDS as readonly string[]).includes(value); }

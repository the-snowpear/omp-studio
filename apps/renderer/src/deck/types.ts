export type DeckAskOption = {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
};

export type DeckAskQuestion = {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly DeckAskOption[];
  readonly multi?: boolean;
  readonly recommended?: number;
};

export type DeckAskAnswer = {
  readonly picked: readonly string[];
  readonly custom: string;
};

export const NO_ASK_ANSWER: DeckAskAnswer = { picked: [], custom: "" };

export type AskHeader = {
  readonly header: string;
  readonly active: boolean;
  readonly index: number;
};

export type PlanActionId = "execute" | "keep" | "compact" | "refine";

export const PLAN_ACTIONS: ReadonlyArray<{
  readonly id: PlanActionId;
  readonly label: string;
  readonly primary: boolean;
}> = [
  { id: "execute", label: "Approve and execute", primary: true },
  { id: "keep", label: "Approve and keep context", primary: false },
  { id: "compact", label: "Approve and compact context", primary: false },
  { id: "refine", label: "Refine plan", primary: false },
];

/** Protocol `mode.plan.review.respond` requires non-empty feedback on refine. */
export const PLAN_REFINE_FEEDBACK = "Please refine the plan.";

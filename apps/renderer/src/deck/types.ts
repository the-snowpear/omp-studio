export type DeckAskOption = {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
};

export type DeckAskQuestion = {
  readonly acceptImages?: boolean;
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly DeckAskOption[];
  readonly multi?: boolean;
  /** Legacy select returns either option IDs or custom text, never both. */
  readonly customExclusive?: boolean;
  readonly recommended?: number;
};

export type DeckAskAnswer = {
  /** Renderer-only documents preserve inline image positions across question navigation. */
  readonly customDoc?: import("../composer/types").ComposerDoc;
  readonly noteDoc?: import("../composer/types").ComposerDoc;
  readonly note?: string;
  readonly noteOption?: string | undefined;
  readonly customInputImages?: readonly import("@omp-studio/studio-protocol").AskImage[];
  readonly noteImages?: readonly import("@omp-studio/studio-protocol").AskImage[];
  readonly picked: readonly string[];
  readonly custom: string;
};

export const NO_ASK_ANSWER: DeckAskAnswer = { picked: [], custom: "" };

export type AskHeader = {
  readonly header: string;
  readonly active: boolean;
  readonly index: number;
};

export type PlanActionId = "execute" | "keep" | "compact" | "refine" | "dismiss";

export type PlanActionDetail = {
  readonly feedback?: string;
};

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

import type { ClientInteraction } from "@omp-studio/client-contract";
import { NO_ASK_ANSWER, type DeckAskAnswer, type DeckAskOption, type DeckAskQuestion } from "./types";

const RECOMMENDED_SUFFIX = " (Recommended)";
const OTHER_LABEL = "Other (type your own)";
const CHAT_LABEL = "Chat about this";
const NEXT_LABEL = "Next →";

export function askAnswered(answer: DeckAskAnswer): boolean {
  return answer.custom.trim().length > 0 || answer.picked.length > 0;
}

export function nextPicked(question: DeckAskQuestion, picked: readonly string[], label: string): readonly string[] {
  if (question.multi) {
    return picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label];
  }
  return picked.length === 1 && picked[0] === label ? [] : [label];
}

function isReservedOption(id: string, label: string): boolean {
  if (id === "custom-input") return true;
  if (label === OTHER_LABEL || label === CHAT_LABEL || label === NEXT_LABEL) return true;
  if (label.includes("Done selecting")) return true;
  return false;
}

function stripRecommended(label: string): { readonly label: string; readonly recommended: boolean } {
  if (label.endsWith(RECOMMENDED_SUFFIX)) {
    return { label: label.slice(0, -RECOMMENDED_SUFFIX.length), recommended: true };
  }
  return { label, recommended: false };
}

export type SelectAskView = {
  readonly question: DeckAskQuestion;
  /** Display label → option id for the Host select response. */
  readonly idByLabel: Readonly<Record<string, string>>;
};

/** Map a Host `select` interaction onto the preview Ask card model. */
export function selectToAskView(interaction: Extract<ClientInteraction, { kind: "select" }>): SelectAskView {
  const idByLabel: Record<string, string> = {};
  const options: DeckAskOption[] = [];
  let recommended: number | undefined;
  for (const option of interaction.options) {
    if (isReservedOption(option.id, option.label)) continue;
    const stripped = stripRecommended(option.label);
    const rec = stripped.recommended || option.description === "推荐";
    if (rec && recommended === undefined) recommended = options.length;
    idByLabel[stripped.label] = option.id;
    options.push({
      label: stripped.label,
      ...(option.description && option.description !== "推荐" ? { description: option.description } : {}),
    });
  }
  return {
    question: {
      id: interaction.interactionId,
      question: interaction.title || "选择",
      options,
      ...(interaction.multiple ? { multi: true } : {}),
      ...(recommended === undefined ? {} : { recommended }),
    },
    idByLabel,
  };
}

export function submitSelectValue(
  view: SelectAskView,
  answer: DeckAskAnswer,
  multiple: boolean,
): string | readonly string[] | undefined {
  const custom = answer.custom.trim();
  if (custom) return custom;
  const ids = answer.picked.map((label) => view.idByLabel[label]).filter((id): id is string => id !== undefined);
  if (ids.length === 0) return undefined;
  return multiple ? ids : ids[0];
}

export type AskDeckView = {
  readonly items: ReadonlyArray<{
    readonly kind: "ask";
    readonly id: string;
    readonly question: DeckAskQuestion;
  }>;
};

function optionToDeck(option: { readonly id: string; readonly label: string; readonly description?: string; readonly preview?: string }): DeckAskOption | undefined {
  if (isReservedOption(option.id, option.label)) return undefined;
  const stripped = stripRecommended(option.label);
  return {
    label: stripped.label,
    ...(option.description && option.description !== "推荐" ? { description: option.description } : {}),
    ...(option.preview ? { preview: option.preview } : {}),
  };
}

/** Map a Host `ask` interaction (one tool call, many questions) onto preview Ask cards. */
export function askToDeckView(interaction: Extract<ClientInteraction, { kind: "ask" }>): AskDeckView {
  return {
    items: interaction.questions.map((question) => {
      const options: DeckAskOption[] = [];
      let recommended = question.recommended;
      for (const option of question.options) {
        const mapped = optionToDeck(option);
        if (!mapped) continue;
        const rec = mapped.label !== option.label || option.description === "推荐";
        if (rec && recommended === undefined) recommended = options.length;
        options.push(mapped);
      }
      const header = question.header?.trim() || question.id;
      return {
        kind: "ask" as const,
        id: question.id,
        question: {
          id: question.id,
          question: question.question,
          header,
          options,
          ...(question.multiple ? { multi: true } : {}),
          ...(recommended === undefined ? {} : { recommended }),
        },
      };
    }),
  };
}

export type AskSubmitPayload = {
  readonly results: ReadonlyArray<{
    readonly id: string;
    readonly selectedOptions: readonly string[];
    readonly customInput?: string;
  }>;
};

export function submitAskValue(
  questions: Extract<ClientInteraction, { kind: "ask" }>["questions"],
  answers: Readonly<Record<string, DeckAskAnswer>>,
): AskSubmitPayload {
  return {
    results: questions.map((question) => {
      const answer = answers[question.id] ?? NO_ASK_ANSWER;
      const custom = answer.custom.trim();
      return {
        id: question.id,
        selectedOptions: custom ? [] : [...answer.picked],
        ...(custom ? { customInput: custom } : {}),
      };
    }),
  };
}

export { NO_ASK_ANSWER };

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

export { NO_ASK_ANSWER };

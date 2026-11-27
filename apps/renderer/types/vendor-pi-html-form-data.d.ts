// Type stub for the vendored html-form answer helpers. Signatures are stated
// with the studio protocol shapes the renderer actually passes; the bundle
// resolves the real helpers through the vite alias, and CI typechecks without
// the vendored package being installed.

import type { FormAnswerData, FormAnswerValue, FormChoiceField, InteractionFormField, InteractionForm, InteractionFormSection } from "@omp-studio/studio-protocol";

export declare const OTHER_LABEL: string;

export declare function choiceValue(field: FormChoiceField, checked: ReadonlySet<number>, other?: string): FormAnswerValue | undefined;

export declare function textValue(field: Extract<InteractionFormField, { kind: "text" }>, text: string): FormAnswerValue;

export declare function fieldError(field: InteractionFormField, value: FormAnswerValue | undefined): string | undefined;

export declare function formAnswers(
  form: Pick<InteractionForm, "fields" | "hidden"> & { sections?: readonly InteractionFormSection[] },
  data: FormAnswerData,
): Array<{ name: string; question: string; answer: string }>;

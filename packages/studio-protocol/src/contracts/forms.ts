/** Native HTML-form presentation. HTML is parsed by the Runtime, never inserted into the app DOM. */
export interface FormSpan {
  text: string;
  style?: "code" | "strong" | "em";
}

export type FormAnswerValue = string | number | string[];
export type FormAnswerData = Record<string, FormAnswerValue>;

export interface FormOptionNote {
  name: string;
  question: string;
  option: string;
  value: string;
  text: string;
}

interface FormFieldBase {
  /** Stable within this interaction, including unnamed controls and duplicate names. */
  id: string;
  name: string;
  /** Native fieldQuestions caption, not a new interpretation of field names. */
  question: string;
  label: FormSpan[];
  required: boolean;
}

export interface FormTextField extends FormFieldBase {
  kind: "text";
  type: string;
  multiline: boolean;
  value: string;
  placeholder: string;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  rows: number;
}

export interface FormChoiceField extends FormFieldBase {
  kind: "choice";
  multi: boolean;
  select: boolean;
  /** Native's additional free-text answer; not an upload control. */
  other: boolean;
  options: Array<{
    value: string;
    label: FormSpan[];
    checked: boolean;
    disabled: boolean;
  }>;
}

export type InteractionFormField = FormTextField | FormChoiceField;

export type InteractionFormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: FormSpan[][][]; headerRows: number }
  /** Runtime-loaded raster data URL; no local file or arbitrary Host URL reaches the app image element. */
  | { kind: "image"; src: string; alt: string }
  /** Render only through the existing safe graphic/image path, never innerHTML. */
  | { kind: "graphic"; format: "svg"; source: string; alt: string }
  | { kind: "media-unavailable"; alt: string; reason: string }
  | { kind: "field"; fieldId: string; optionsEnd?: number };

export interface InteractionFormSection {
  title: FormSpan[];
  blocks: InteractionFormBlock[];
  fieldset: boolean;
}

export interface InteractionForm {
  sections: InteractionFormSection[];
  fields: InteractionFormField[];
  /** Native hidden inputs, kept in order; a named unchecked field must not erase one. */
  hidden: Array<[name: string, value: string]>;
  /** Native initial submission, including hidden inputs; hidden values have no editable UI. */
  defaults: FormAnswerData;
}

/** Native formDialog result. Timeout submits current values, even when an unfinished field is invalid. */
export interface FormSubmitValue {
  data: FormAnswerData;
  notes?: FormOptionNote[];
  timedOut?: boolean;
}

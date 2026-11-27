import type { HtmlFormData, OptionNote } from "../tools/html-form/data";
import type { FormBlock, FormField, FormSpan } from "../tools/html-form/parse";

/** Minimal Runtime wire mirror of the canonical Studio forms contract, using native field/data types. */
export type InteractionFormField = FormField & { id: string; question: string };
export type InteractionFormBlock =
	| Exclude<FormBlock, { kind: "field" | "image" | "svg" }>
	| { kind: "field"; fieldId: string; optionsEnd?: number }
	| { kind: "image"; src: string; alt: string }
	| { kind: "graphic"; format: "svg"; source: string; alt: string }
	| { kind: "media-unavailable"; alt: string; reason: string };

export interface InteractionForm {
	acceptImages?: boolean;
	sections: Array<{ title: FormSpan[]; blocks: InteractionFormBlock[]; fieldset: boolean }>;
	fields: InteractionFormField[];
	hidden: [name: string, value: string][];
	defaults: HtmlFormData;
}

export interface FormSubmitValue {
	abandoned?: boolean;
	data: HtmlFormData;
	notes?: OptionNote[];
	timedOut?: boolean;
}

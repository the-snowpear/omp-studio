import type { InteractionForm, InteractionFormField, InteractionFormSection } from "@omp-studio/studio-protocol";
import { spansText } from "@oh-my-pi/pi-tui/html-form/model";

export interface FormPage {
  label: string;
  sections: InteractionFormSection[];
  fields: InteractionFormField[];
  firstControl?: InteractionFormField | undefined;
}

function reachable(field: InteractionFormField) {
  return field.kind === "text" || field.other || field.options.some(option => !option.disabled);
}

/** Project the Runtime DTO using HtmlFormDialog's native question-tab boundaries. */
export function formPages(form: InteractionForm): FormPage[] {
  const fields = new Map(form.fields.map(field => [field.id, field]));
  const tabbed = form.sections.filter(section => section.blocks.some(block => block.kind === "field")).length > 1;
  const pages: FormPage[] = [];
  let lead: InteractionFormSection[] = [];
  for (const section of form.sections) {
    const controls = section.blocks.flatMap((block, at) => block.kind === "field"
      ? [{ at, end: Math.max(at + 1, block.optionsEnd ?? 0), field: fields.get(block.fieldId)! }] : []);
    if (!controls.length) { lead.push(section); continue; }
    const end = section.blocks.length;
    const cuts = tabbed && !section.fieldset ? controls.flatMap((control, index) => {
      if (!reachable(control.field)) return [];
      // Keep context between options on their page unless the options straddle another field.
      return [control.end <= (controls[index + 1]?.at ?? end) ? control.end : control.at + 1];
    }) : [];
    if (cuts.length) cuts[cuts.length - 1] = end;
    else cuts.push(end);
    let start = 0;
    for (const cut of cuts) {
      const blocks = section.blocks.slice(start, cut);
      const pageFields = blocks.flatMap(block => block.kind === "field" ? [fields.get(block.fieldId)!] : []);
      const firstControl = pageFields.find(reachable);
      pages.push({
        label: spansText(section.title) || (firstControl ?? pageFields[0])?.question || "",
        sections: [...lead, { ...section, blocks }], fields: pageFields, firstControl,
      });
      lead = [];
      start = cut;
    }
  }
  const last = pages.at(-1);
  if (last) last.sections.push(...lead);
  else if (lead.length) pages.push({ label: "", sections: lead, fields: [] });
  return pages;
}

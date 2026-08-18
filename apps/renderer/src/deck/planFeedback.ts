import type { PlanSection } from "./planSections";

const FEEDBACK_HEADER = "Refinement feedback on the plan:\n";
const PREAMBLE_FEEDBACK_TITLE = "Plan preamble";
const OVERALL_FEEDBACK_TITLE = "Entire plan";

export type PlanNotesBySection = Readonly<Record<number, readonly string[]>>;

export type PlanDraftNote = {
  readonly index: number;
  readonly text: string;
};

function markdownFenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
}

function formatNote(note: string): string {
  if (!note.includes("\n")) return `- ${note}\n`;
  const fence = markdownFenceFor(note);
  return `${fence}md\n${note}\n${fence}\n`;
}

export function copyPlanNotes(notes: PlanNotesBySection): Record<number, string[]> {
  const copy: Record<number, string[]> = {};
  for (const [key, value] of Object.entries(notes)) {
    copy[Number(key)] = [...value];
  }
  return copy;
}

/** Commit an unsaved textarea draft into the section notes map. */
export function mergePlanDraft(notes: PlanNotesBySection, draft?: PlanDraftNote): Record<number, string[]> {
  const copy = copyPlanNotes(notes);
  if (draft === undefined) return copy;
  const note = draft.text.trim();
  if (!note) return copy;
  copy[draft.index] = [...(copy[draft.index] ?? []), note];
  return copy;
}

function formatSection(title: string, notes: readonly string[] | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const kept = notes.map((note) => note.trim()).filter((note) => note.length > 0);
  if (kept.length === 0) return undefined;
  let block = `\n## ${title || PREAMBLE_FEEDBACK_TITLE}\n`;
  for (const note of kept) block += formatNote(note);
  return block;
}

/** TUI-shaped Refine prompt, or `undefined` when nothing is annotated. */
export function formatPlanRefineFeedback(
  sections: readonly PlanSection[],
  notesBySection: PlanNotesBySection,
  overall?: string,
): string | undefined {
  const parts: string[] = [];
  const overallBlock = formatSection(OVERALL_FEEDBACK_TITLE, overall === undefined ? undefined : [overall]);
  if (overallBlock !== undefined) parts.push(overallBlock);
  const seen = new Set<number>();
  for (let i = 0; i < sections.length; i++) {
    seen.add(i);
    const block = formatSection(sections[i]!.title, notesBySection[i]);
    if (block !== undefined) parts.push(block);
  }
  for (const key of Object.keys(notesBySection)) {
    const index = Number(key);
    if (seen.has(index)) continue;
    const block = formatSection(PREAMBLE_FEEDBACK_TITLE, notesBySection[index]);
    if (block !== undefined) parts.push(block);
  }
  if (parts.length === 0) return undefined;
  return FEEDBACK_HEADER + parts.join("");
}

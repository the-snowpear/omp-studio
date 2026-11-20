import { notesForSection, type PlanNote } from "./planDocument";
import type { PlanSection } from "./planSections";

function formatNote(note: string): string {
  if (!note.includes("\n")) return `- ${note}\n`;
  let fence = "```";
  while (note.includes(fence)) fence += "`";
  return `${fence}md\n${note}\n${fence}\n`;
}

/** Keep the Runtime's existing refinement format; anchors are renderer-only. */
export function formatPlanRefineFeedback(sections: readonly PlanSection[], notes: readonly PlanNote[], overall: string): string | undefined {
  const parts: string[] = [];
  if (overall.trim()) parts.push(`\n## Entire plan\n${formatNote(overall.trim())}`);
  const seen = new Set<number>();
  for (const section of sections) {
    const groups = notesForSection(notes, section);
    for (const group of groups) seen.add(group.id);
    const text = groups.flatMap(group => group.notes).map(formatNote).join("");
    if (text) parts.push(`\n## ${section.title || "Plan preamble"}\n${text}`);
  }
  for (const note of notes) {
    if (seen.has(note.id) || !note.notes.length) continue;
    parts.push(`\n## ${note.title || "Plan preamble"} (original section deleted)\n${formatNote(note.source)}${note.notes.map(formatNote).join("")}`);
  }
  return parts.length ? "Refinement feedback on the plan:\n" + parts.join("") : undefined;
}

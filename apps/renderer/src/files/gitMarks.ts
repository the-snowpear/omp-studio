import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";

/** Working-tree changes on the new side of a unified patch, as 1-based line numbers. */
export interface PatchMarks { added: number[]; modified: number[]; deleted: number[]; additions: number; deletions: number }
export const EMPTY_MARKS: PatchMarks = { added: [], modified: [], deleted: [], additions: 0, deletions: 0 };

/** Each run of removals/additions without context becomes added, modified or a deletion anchor, like an editor's SCM gutter. */
export function parsePatchMarks(patch: string): PatchMarks {
  const marks: PatchMarks = { added: [], modified: [], deleted: [], additions: 0, deletions: 0 };
  let newLine = 0, inHunk = false, removed = 0, inserted: number[] = [];
  const flush = () => {
    if (inserted.length) (removed ? marks.modified : marks.added).push(...inserted);
    else if (removed) marks.deleted.push(Math.max(1, newLine - 1));
    removed = 0; inserted = [];
  };
  for (const line of patch.split(/\r?\n/u)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) { flush(); newLine = Number(hunk[1]); inHunk = true; continue; }
    if (line.startsWith("diff --git ")) { flush(); inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) { inserted.push(newLine++); marks.additions++; }
    else if (line.startsWith("-")) { removed++; marks.deletions++; }
    else if (line.startsWith(" ")) { flush(); newLine++; }
    else if (!line.startsWith("\\")) flush();
  }
  flush();
  return marks;
}

class GitMarker extends GutterMarker {
  constructor(readonly kind: "added" | "modified" | "deleted") { super(); }
  override eq(other: GitMarker) { return other.kind === this.kind; }
  override toDOM() { const element = document.createElement("span"); element.className = `cm-git-mark is-${this.kind}`; return element; }
}
const markers = { added: new GitMarker("added"), modified: new GitMarker("modified"), deleted: new GitMarker("deleted") };
export const setGitMarks = StateEffect.define<PatchMarks>();
const gitField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setGitMarks)) {
      const doc = transaction.state.doc, ranges = [];
      for (const kind of ["added", "modified", "deleted"] as const) for (const number of effect.value[kind]) if (number >= 1 && number <= doc.lines) ranges.push(markers[kind].range(doc.line(number).from));
      value = RangeSet.of(ranges, true);
    }
    return value;
  },
});
/** Mapped through edits so unsaved typing does not shift markers onto the wrong lines. */
export function gitChangeGutter(): Extension {
  return [gitField, gutter({ class: "cm-git-gutter", markers: view => view.state.field(gitField) })];
}

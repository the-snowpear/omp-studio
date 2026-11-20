import { Compartment, EditorState, StateEffect, StateField, Transaction, type TransactionSpec } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { coreEditorExtensions } from "../structured-editor/extensions";
import type { PlanSection } from "./planSections";

export type PlanNote = {
  id: number;
  from: number;
  to: number;
  title: string;
  source: string;
  deleted: boolean;
  notes: readonly string[];
  draft: string | undefined;
};

type Anchor = Pick<PlanNote, "id" | "from" | "to" | "deleted">;
const replaceNotes = StateEffect.define<readonly PlanNote[]>();
const restoreAnchors = StateEffect.define<readonly Anchor[]>();

const noteField = StateField.define<readonly PlanNote[]>({
  create: () => [],
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) next = value.map(note => {
      let deleted = note.deleted;
      transaction.changes.iterChangedRanges((from, to) => {
        if (to > from && from <= note.from && to >= note.to) deleted = true;
      });
      const from = transaction.changes.mapPos(note.from, 1);
      const to = Math.max(from, transaction.changes.mapPos(note.to, -1));
      return { ...note, from, to, deleted };
    });
    for (const effect of transaction.effects) {
      if (effect.is(replaceNotes)) next = effect.value;
      if (effect.is(restoreAnchors)) next = next.map(note => {
        const anchor = effect.value.find(item => item.id === note.id);
        return anchor ? { ...note, ...anchor } : note;
      });
    }
    return next;
  },
});

export function notesForSection(notes: readonly PlanNote[], section: PlanSection): readonly PlanNote[] {
  return notes.filter(note => !note.deleted && note.from >= section.from && note.from < section.to);
}

/** Review-local document: survives hiding the editor without rebuilding its undo history. */
export class PlanDocument {
  readonly ui = new Compartment();
  readonly language = new Compartment();
  readonly access = new Compartment();
  state: EditorState;
  view: EditorView | undefined;
  sourceScroll = { top: 0, left: 0 };
  previewScroll = 0;
  ratio = 50;
  private nextNote = 1;
  private listeners = new Set<() => void>();
  private snapshot: { markdown: string; notes: readonly PlanNote[] };

  constructor(markdown: string) {
    this.state = EditorState.create({ doc: markdown, extensions: [
      ...coreEditorExtensions({}), EditorState.lineSeparator.of("\n"), EditorView.lineWrapping,
      noteField, this.ui.of([]), this.language.of([]), this.access.of([]),
      invertedEffects.of(transaction => transaction.docChanged
        ? [restoreAnchors.of(transaction.startState.field(noteField).map(({ id, from, to, deleted }) => ({ id, from, to, deleted })))]
        : []),
    ] });
    this.snapshot = { markdown, notes: this.state.field(noteField) };
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  accept = (transactions: readonly Transaction[]) => {
    const previous = this.state;
    for (const transaction of transactions) this.state = transaction.state;
    if (previous.doc !== this.state.doc || previous.field(noteField) !== this.state.field(noteField)) {
      this.snapshot = { markdown: this.state.doc.toString(), notes: this.state.field(noteField) };
      for (const listener of this.listeners) listener();
    }
  };

  dispatch = (spec: TransactionSpec) => {
    if (this.view) this.view.dispatch(spec);
    else this.accept([this.state.update(spec)]);
  };

  updateNotes(notes: readonly PlanNote[]) {
    this.dispatch({ effects: replaceNotes.of(notes), annotations: Transaction.addToHistory.of(false) });
  }

  startNote(section: PlanSection, quote: string) {
    this.flushNotes();
    const existing = notesForSection(this.snapshot.notes, section)[0];
    const draft = quote ? quote.split("\n").map(line => `> ${line}`).join("\n") + "\n\n" : "";
    if (existing) this.editNote(existing.id, { draft });
    else this.updateNotes([...this.snapshot.notes, { id: this.nextNote++, from: section.from,
      to: section.from + section.raw.trimEnd().length, title: section.title, source: section.raw,
      deleted: false, notes: [], draft }]);
  }

  editNote(id: number, change: Partial<Pick<PlanNote, "draft" | "notes">>) {
    this.updateNotes(this.snapshot.notes.map(note => note.id === id ? { ...note, ...change } : note));
  }

  flushNotes() {
    this.updateNotes(this.snapshot.notes.map(note => ({ ...note,
      notes: note.draft?.trim() ? [...note.notes, note.draft.trim()] : note.notes, draft: undefined,
    })));
    return this.snapshot.notes;
  }

  /** External snapshots only enter here when the review has no unsaved local text. */
  replaceMarkdown(markdown: string) {
    const previous = this.state.doc.toString();
    if (previous === markdown) return;
    let from = 0, oldEnd = previous.length, newEnd = markdown.length;
    while (from < oldEnd && from < newEnd && previous[from] === markdown[from]) from++;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === markdown[newEnd - 1]) { oldEnd--; newEnd--; }
    this.dispatch({ changes: { from, to: oldEnd, insert: markdown.slice(from, newEnd) }, annotations: Transaction.addToHistory.of(false) });
  }
}

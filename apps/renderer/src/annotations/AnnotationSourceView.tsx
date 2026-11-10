import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Decoration, drawSelection, EditorView, gutter, GutterMarker, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import type { AnnotationNote, AnnotationSource } from "@omp-studio/studio-protocol";
import { studioEditorTheme } from "../structured-editor/theme";
import type { AnnotationSelection } from "./annotationText";

export interface AnnotationReader {
  focus(): void;
  search(): void;
  reveal(selection?: AnnotationSelection): void;
}

class NoteMarker extends GutterMarker {
  constructor(readonly index: number, readonly active: boolean) { super(); }
  eq(other: NoteMarker) { return this.index === other.index && this.active === other.active; }
  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement("span");
    element.className = "annotation-line-note" + (this.active ? " is-active" : "");
    element.textContent = String(this.index + 1);
    return element;
  }
}

function annotationsExtension(source: AnnotationSource, notes: AnnotationNote[], active: string | undefined, onLocate: (id: string) => void): Extension {
  const marks = notes.flatMap(note => note.selection ? [
    Decoration.mark({ class: "annotation-highlight" + (note.id === active ? " is-active" : "") })
      .range(note.selection.start, note.selection.end),
  ] : []);
  if (source.kind === "diff") {
    let offset = 0;
    for (const line of source.text.split("\n")) {
      const className = line.startsWith("+") && !line.startsWith("+++") ? "annotation-diff-add"
        : line.startsWith("-") && !line.startsWith("---") ? "annotation-diff-remove"
          : line.startsWith("@@") ? "annotation-diff-hunk" : undefined;
      if (className) marks.push(Decoration.line({ class: className }).range(offset));
      offset += line.length + 1;
    }
  }
  return [
    EditorView.decorations.of(Decoration.set(marks, true)),
    gutter({
      class: "annotation-note-gutter",
      lineMarker(view, line) {
        const index = notes.findIndex(note => note.selection && view.state.doc.lineAt(note.selection.start).from === line.from);
        return index < 0 ? null : new NoteMarker(index, notes[index]!.id === active);
      },
      domEventHandlers: {
        mousedown(view, line, event) {
          if ((event as MouseEvent).button !== 0) return false;
          const note = notes.find(item => item.selection && view.state.doc.lineAt(item.selection.start).from === line.from);
          if (!note) return false;
          event.preventDefault(); onLocate(note.id); return true;
        },
      },
    }),
  ];
}

/** The same CodeMirror theme as workspace files, with exact, frozen-source anchors. */
export const AnnotationSourceView = memo(function AnnotationSourceView({
  source, notes, selection, activeNote, wrap, zh, locked, scrollMemory, onSelection, onAnnotate, onEdit, onUndo, onLocate, onReady,
}: {
  source: AnnotationSource;
  notes: AnnotationNote[];
  selection: AnnotationSelection | undefined;
  activeNote: string | undefined;
  wrap: boolean;
  zh: boolean;
  locked: boolean;
  scrollMemory: Map<string, number>;
  onSelection(selection: AnnotationSelection | undefined): void;
  onAnnotate(): void;
  onEdit(selection: AnnotationSelection | undefined): void;
  onUndo(): void;
  onLocate(id: string): void;
  onReady(reader: AnnotationReader | null): void;
}) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment()), wrapping = useRef(new Compartment()), annotations = useRef(new Compartment());
  const latest = useRef({ onSelection, onAnnotate, onEdit, onUndo, onLocate, onReady, locked });
  latest.current = { onSelection, onAnnotate, onEdit, onUndo, onLocate, onReady, locked };

  useLayoutEffect(() => {
    const parent = host.current!;
    const lineSelection = (editor: EditorView, position = editor.state.selection.main.head) => {
      const line = editor.state.doc.lineAt(position);
      const end = line.to === line.from && line.to < editor.state.doc.length ? line.to + 1 : line.to;
      return end > line.from ? { start: line.from, end } : undefined;
    };
    const annotate = (editor: EditorView, whole = false) => {
      if (!latest.current.locked) {
        const range = editor.state.selection.main;
        const chosen = whole ? undefined : range.empty ? lineSelection(editor) : { start: range.from, end: range.to };
        editor.dispatch({ selection: chosen ? { anchor: chosen.start, head: chosen.end } : { anchor: range.head } });
        latest.current.onSelection(chosen);
      }
      latest.current.onAnnotate();
      return true;
    };
    const move = (editor: EditorView, delta: number) => {
      if (latest.current.locked) return true;
      const current = editor.state.doc.lineAt(editor.state.selection.main.from).number;
      const line = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, current + delta)));
      editor.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from) });
      return true;
    };
    const jump = (editor: EditorView, last: boolean) => {
      if (latest.current.locked) return true;
      const line = editor.state.doc.line(last ? editor.state.doc.lines : 1);
      editor.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from) });
      return true;
    };
    const editor = new EditorView({
      parent,
      root: parent.getRootNode() as Document | ShadowRoot,
      state: EditorState.create({
        doc: source.text,
        ...(selection ? { selection: { anchor: selection.start, head: selection.end } } : {}),
        extensions: [
          // Splitting only on LF keeps CR bytes in the document. Positions remain
          // exact UTF-16 offsets into source.text, rather than normalized text.
          EditorState.lineSeparator.of("\n"), EditorState.readOnly.of(true), EditorState.tabSize.of(2),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ role: "textbox", "aria-readonly": "true", tabindex: "0", spellcheck: "false",
            "aria-label": zh ? "来源快照，可选择文本" : "Source snapshot; select text to annotate" }),
          lineNumbers({ domEventHandlers: { mousedown(editor, line, event) {
            if ((event as MouseEvent).button !== 0 || latest.current.locked) return false;
            event.preventDefault();
            const range = lineSelection(editor, line.from);
            editor.focus();
            if (range) editor.dispatch({ selection: { anchor: range.start, head: range.end } });
            return true;
          } } }),
          drawSelection(), highlightSpecialChars(), search({ top: true }),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          Prec.highest(keymap.of([
            { key: "Enter", run: editor => annotate(editor) },
            { key: "a", run: editor => annotate(editor) },
            { key: "Shift-a", run: editor => annotate(editor, true) },
            { key: "e", run: editor => { const range = editor.state.selection.main; latest.current.onEdit(range.empty ? lineSelection(editor) : { start: range.from, end: range.to }); return true; } },
            { key: "u", run: () => { latest.current.onUndo(); return true; } },
            { key: "j", run: editor => move(editor, 1) }, { key: "k", run: editor => move(editor, -1) },
            { key: "Shift-j", run: editor => move(editor, 5) }, { key: "Shift-k", run: editor => move(editor, -5) },
            { key: "g", run: editor => jump(editor, false) }, { key: "Shift-g", run: editor => jump(editor, true) },
          ])),
          EditorView.domEventHandlers({ dblclick(event, editor) {
            const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            event.preventDefault();
            if (!latest.current.locked) {
              const range = lineSelection(editor, position);
              editor.focus();
              if (range) editor.dispatch({ selection: { anchor: range.start, head: range.end } });
              latest.current.onSelection(range);
            }
            latest.current.onAnnotate(); return true;
          } }),
          studioEditorTheme(), language.current.of([]), wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          annotations.current.of(annotationsExtension(source, notes, activeNote, id => latest.current.onLocate(id))),
          EditorView.updateListener.of(update => {
            // Moving focus to the note editor collapses the browser selection.
            // Only reader gestures may replace an annotation's frozen anchor.
            if (!update.selectionSet || latest.current.locked || !update.view.hasFocus) return;
            const range = update.state.selection.main;
            latest.current.onSelection(range.empty ? undefined : { start: range.from, end: range.to });
          }),
        ],
      }),
    });
    view.current = editor;
    editor.scrollDOM.scrollTop = scrollMemory.get(source.id) ?? 0;
    latest.current.onReady({ focus: () => editor.focus(), search: () => { openSearchPanel(editor); },
      reveal: range => editor.dispatch({ effects: EditorView.scrollIntoView(range?.start ?? 0, { y: "center" }) }) });
    return () => {
      scrollMemory.set(source.id, editor.scrollDOM.scrollTop);
      latest.current.onReady(null); editor.destroy(); view.current = null;
    };
  }, [source.id, source.text, zh, scrollMemory]);

  useEffect(() => {
    const filename = source.kind === "diff" ? "changes.diff" : source.path ?? "reply.md";
    const name = filename.split(/[\\/]/).pop() ?? filename;
    const match = languages.find(item => item.filename?.test(name) || item.extensions.includes(name.split(".").pop()?.toLowerCase() ?? ""));
    let active = true;
    if (match) void match.load().then(extension => {
      if (active) view.current?.dispatch({ effects: language.current.reconfigure(extension) });
    }).catch(() => { /* Optional syntax highlighting must not prevent annotation. */ });
    return () => { active = false; };
  }, [source.id, source.kind, source.path]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap, source.id]);
  useEffect(() => { view.current?.dispatch({ effects: annotations.current.reconfigure(annotationsExtension(source, notes, activeNote, id => latest.current.onLocate(id))) }); }, [source, notes, activeNote]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const range = editor.state.selection.main;
    if (selection && (range.from !== selection.start || range.to !== selection.end)) editor.dispatch({ selection: { anchor: selection.start, head: selection.end } });
    else if (!selection && !range.empty) editor.dispatch({ selection: { anchor: range.head } });
  }, [selection, source.id]);

  return <div ref={host} className={"annotation-reader" + (source.kind === "message" ? " is-prose" : "")} />;
});

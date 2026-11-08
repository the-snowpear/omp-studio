import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, StateEffect, StateField, Transaction, type EditorSelection } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { coreEditorExtensions } from "../structured-editor/extensions";
import type { FileDocument } from "./fileDocuments";
import type { FilePanelDescriptor } from "../dock/types";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { gitChangeGutter, setGitMarks, type PatchMarks } from "./gitMarks";

/** Caret and selection summary for the status bar. */
export interface EditorCursor { line: number; column: number; selected: number; selectedLines: number }
/** What the pane can ask of a mounted editor (search, go to line, current selection; `from`/`to` are 1-based lines). */
export interface EditorController { search(): void; gotoLine(): void; focus(): void; selection(): { text: string; from: number; to: number } | null; scrollToRatio(ratio: number): void }
export interface EditorCommands {
  onCursor?: (cursor: EditorCursor) => void;
  onReady?: (controller: EditorController | null) => void;
  onToggleWrap?: () => void;
  onFontSize?: (delta: number | null) => void;
  /** Present when the selection can be sent to the Composer. */
  onAddSelection?: (selection: { text: string; from: number; to: number }) => void;
  onCopy?: (text: string) => void;
}

const editorStates = new WeakMap<FileDocument, Map<string, { state: EditorState; navigation?: string | undefined }>>();
const lineRange = (state: EditorState) => { const range = state.selection.main; if (range.empty) return null; const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to; return { text: state.sliceDoc(range.from, range.to), from: state.doc.lineAt(range.from).number, to: state.doc.lineAt(end).number }; };
function cursorOf(state: EditorState): EditorCursor {
  const range = state.selection.main, line = state.doc.lineAt(range.head);
  const selected = (state.selection as EditorSelection).ranges.reduce((sum, item) => sum + item.to - item.from, 0);
  return { line: line.number, column: range.head - line.from + 1, selected, selectedLines: selected ? state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1 : 0 };
}
export default function FileTextEditor({ session, descriptor, onViewState, readOnly = false, value, viewId = "default", wrap = true, fontSize, gitMarks, commands, onScrollRatio }: {
  session: FileDocument; descriptor: FilePanelDescriptor; onViewState: (patch: Partial<FilePanelDescriptor>) => void; readOnly?: boolean; value?: string; viewId?: string;
  wrap?: boolean; fontSize?: number | undefined; gitMarks?: PatchMarks | undefined; commands?: EditorCommands | undefined;
  /** Split view: reports the proportional scroll position so the paired preview can follow. */
  onScrollRatio?: ((ratio: number) => void) | undefined;
}) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null), surface = useSurfaceDocument();
  const latest = useRef({ onViewState, descriptor, commands, onScrollRatio }); latest.current = { onViewState, descriptor, commands, onScrollRatio };
  const text = value ?? session.getSnapshot().text;
  const language = useRef(new Compartment()), wrapping = useRef(new Compartment());
  const navigation = useRef<string | undefined>(undefined);
  const wrapRef = useRef(wrap); wrapRef.current = wrap;
  const following = useRef(false);
  useLayoutEffect(() => {
    const parent = host.current!;
    let synchronizing = false;
    const states = editorStates.get(session) ?? new Map<string, { state: EditorState; navigation?: string | undefined }>(); editorStates.set(session, states);
    const entry = value === undefined ? states.get(viewId) : undefined;
    navigation.current = entry?.navigation;
    const remembered = entry?.state;
    const initial = remembered && remembered.doc.toString() !== text ? remembered.update({ changes: { from: 0, to: remembered.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) }).state : remembered;
    const command = (run: (actions: EditorCommands) => void) => () => { const actions = latest.current.commands; if (!actions) return false; run(actions); return true; };
    const selectionBar = StateField.define<Tooltip | null>({
      create: () => null,
      update(tooltip, transaction) {
        if (!transaction.selection && !transaction.docChanged && !transaction.effects.length) return tooltip;
        const range = transaction.state.selection.main;
        if (range.empty || transaction.state.selection.ranges.length > 1) return null;
        const above = range.head === range.from;
        return { pos: range.head, above, strictSide: false, arrow: false, create: editor => {
          const owner = editor.dom.ownerDocument, dom = owner.createElement("div"); dom.className = "file-selection-bar";
          const button = (label: string, tip: string, run: () => void) => { const element = owner.createElement("button"); element.type = "button"; element.textContent = label; element.dataset.tip = tip; element.onmousedown = event => event.preventDefault(); element.onclick = run; dom.append(element); };
          if (latest.current.commands?.onAddSelection) button("＠ 添加到对话", "把选中的行作为上下文加入对话（Ctrl Shift L）", () => { const selection = lineRange(editor.state); if (selection) latest.current.commands?.onAddSelection?.(selection); });
          button("复制", "复制选区", () => latest.current.commands?.onCopy?.(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)));
          return { dom, offset: { x: 0, y: 6 } };
        } };
      },
      provide: field => showTooltip.from(field),
    });
    const extensions = [
      ...coreEditorExtensions({}), gitChangeGutter(), wrapping.current.of(wrapRef.current ? EditorView.lineWrapping : []), EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly), language.current.of([]),
      ...(value === undefined ? [selectionBar] : []),
      keymap.of([
        { key: "Mod-s", run: () => { void session.save(); return true; } },
        { key: "Mod-g", run: gotoLine },
        { key: "Alt-z", run: command(actions => actions.onToggleWrap?.()) },
        { key: "Mod-=", run: command(actions => actions.onFontSize?.(1)) },
        { key: "Mod-+", run: command(actions => actions.onFontSize?.(1)) },
        { key: "Mod--", run: command(actions => actions.onFontSize?.(-1)) },
        { key: "Mod-0", run: command(actions => actions.onFontSize?.(null)) },
        { key: "Mod-Shift-l", run: editor => { const selection = lineRange(editor.state), add = latest.current.commands?.onAddSelection; if (!selection || !add) return false; add(selection); return true; } },
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !synchronizing && !readOnly) session.edit(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) latest.current.commands?.onCursor?.(cursorOf(update.state));
      }),
    ];
    const editor = new EditorView({ parent, state: initial ? initial.update({ effects: StateEffect.reconfigure.of(extensions) }).state : EditorState.create({ doc: text, extensions }) });
    view.current = editor;
    latest.current.commands?.onCursor?.(cursorOf(editor.state));
    latest.current.commands?.onReady?.({ search: () => { openSearchPanel(editor); }, gotoLine: () => { gotoLine(editor); }, focus: () => editor.focus(), selection: () => lineRange(editor.state),
      scrollToRatio: ratio => { const element = editor.scrollDOM, top = Math.round(ratio * (element.scrollHeight - element.clientHeight)); if (Math.abs(element.scrollTop - top) > 1) { following.current = true; element.scrollTop = top; } } });
    const subscription = session.subscribe(() => {
      if (value !== undefined) return;
      const next = session.getSnapshot().text;
      if (editor.state.doc.toString() !== next) { synchronizing = true; editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: next }, annotations: Transaction.addToHistory.of(false) }); synchronizing = false; }
    });
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const scroll = () => {
      clearTimeout(scrollTimer); scrollTimer = setTimeout(() => latest.current.onViewState({ scroll: editor.scrollDOM.scrollTop }), 200);
      if (following.current) { following.current = false; return; }
      const element = editor.scrollDOM, range = element.scrollHeight - element.clientHeight;
      latest.current.onScrollRatio?.(range > 0 ? element.scrollTop / range : 0);
    };
    editor.scrollDOM.addEventListener("scroll", scroll);
    editor.scrollDOM.scrollTop = descriptor.scroll ?? 0;
    const observer = new ResizeObserver(() => { const root = parent.getRootNode() as Document; if (editor.root !== root) editor.setRoot(root); editor.requestMeasure(); });
    observer.observe(parent);
    return () => { clearTimeout(scrollTimer); latest.current.commands?.onReady?.(null); if (session.isViewClosed(viewId)) states.delete(viewId); else if (value === undefined) { states.set(viewId, { state: editor.state, navigation: navigation.current }); latest.current.onViewState({ scroll: editor.scrollDOM.scrollTop }); } subscription(); observer.disconnect(); editor.destroy(); view.current = null; };
  }, [session, readOnly, value]);
  useEffect(() => {
    const name = descriptor.path.split(/[\\/]/).pop() ?? descriptor.path;
    const match = languages.find(language => language.filename?.test(name) || language.extensions.includes(name.split(".").pop()?.toLowerCase() ?? ""));
    let active = true;
    if (match) void match.load().then(extension => { if (active) view.current?.dispatch({ effects: language.current.reconfigure(extension) }); });
    return () => { active = false; };
  }, [descriptor.path, session, readOnly, value]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap, session, readOnly, value]);
  useEffect(() => { view.current?.requestMeasure(); }, [fontSize]);
  useEffect(() => { if (gitMarks) view.current?.dispatch({ effects: setGitMarks.of(gitMarks) }); }, [gitMarks, session, readOnly, value]);
  useEffect(() => { if (view.current) { view.current.setRoot(surface); view.current.requestMeasure(); } }, [surface]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !descriptor.line) return;
    const key = JSON.stringify([descriptor.line, descriptor.column, descriptor.jump]);
    if (navigation.current === key) return;
    navigation.current = key;
    const line = editor.state.doc.line(Math.min(Math.max(1, descriptor.line), editor.state.doc.lines));
    const position = Math.min(line.to, line.from + Math.max(0, (descriptor.column ?? 1) - 1));
    editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
  }, [descriptor.line, descriptor.column, descriptor.jump, session]);
  return <div className="file-text-editor" ref={host} style={fontSize ? { ["--file-editor-fs" as string]: `${fontSize}px` } : undefined} />;
}

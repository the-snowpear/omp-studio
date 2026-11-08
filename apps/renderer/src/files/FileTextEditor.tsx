import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { languages } from "@codemirror/language-data";
import { coreEditorExtensions } from "../structured-editor/extensions";
import type { FileDocument } from "./fileDocuments";
import type { FilePanelDescriptor } from "../dock/types";
import { useSurfaceDocument } from "../dock/SurfaceContext";

const editorStates = new WeakMap<FileDocument, Map<string, { state: EditorState; navigation?: string | undefined }>>();
export default function FileTextEditor({ session, descriptor, onViewState, readOnly = false, value, viewId = "default" }: { session: FileDocument; descriptor: FilePanelDescriptor; onViewState: (patch: Partial<FilePanelDescriptor>) => void; readOnly?: boolean; value?: string; viewId?: string }) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null), surface = useSurfaceDocument();
  const latest = useRef({ onViewState, descriptor }); latest.current = { onViewState, descriptor };
  const text = value ?? session.getSnapshot().text;
  const language = useRef(new Compartment());
  const navigation = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const parent = host.current!;
    let synchronizing = false;
    const states = editorStates.get(session) ?? new Map<string, { state: EditorState; navigation?: string | undefined }>(); editorStates.set(session, states);
    const entry = value === undefined ? states.get(viewId) : undefined;
    navigation.current = entry?.navigation;
    const remembered = entry?.state;
    const initial = remembered && remembered.doc.toString() !== text ? remembered.update({ changes: { from: 0, to: remembered.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) }).state : remembered;
    const extensions = [
      ...coreEditorExtensions({}), EditorView.lineWrapping, EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly), language.current.of([]),
      keymap.of([{ key: "Mod-s", run: () => { void session.save(); return true; } }]),
      EditorView.updateListener.of(update => { if (update.docChanged && !synchronizing && !readOnly) session.edit(update.state.doc.toString()); }),
    ];
    const editor = new EditorView({ parent, state: initial ? initial.update({ effects: StateEffect.reconfigure.of(extensions) }).state : EditorState.create({ doc: text, extensions }) });
    view.current = editor;
    const subscription = session.subscribe(() => {
      if (value !== undefined) return;
      const next = session.getSnapshot().text;
      if (editor.state.doc.toString() !== next) { synchronizing = true; editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: next }, annotations: Transaction.addToHistory.of(false) }); synchronizing = false; }
    });
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const scroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => latest.current.onViewState({ scroll: editor.scrollDOM.scrollTop }), 200); };
    editor.scrollDOM.addEventListener("scroll", scroll);
    editor.scrollDOM.scrollTop = descriptor.scroll ?? 0;
    const observer = new ResizeObserver(() => { const root = parent.getRootNode() as Document; if (editor.root !== root) editor.setRoot(root); editor.requestMeasure(); });
    observer.observe(parent);
    return () => { clearTimeout(scrollTimer); if (session.isViewClosed(viewId)) states.delete(viewId); else if (value === undefined) { states.set(viewId, { state: editor.state, navigation: navigation.current }); latest.current.onViewState({ scroll: editor.scrollDOM.scrollTop }); } subscription(); observer.disconnect(); editor.destroy(); view.current = null; };
  }, [session, readOnly, value]);
  useEffect(() => {
    const name = descriptor.path.split(/[\\/]/).pop() ?? descriptor.path;
    const match = languages.find(language => language.filename?.test(name) || language.extensions.includes(name.split(".").pop()?.toLowerCase() ?? ""));
    let active = true;
    if (match) void match.load().then(extension => { if (active) view.current?.dispatch({ effects: language.current.reconfigure(extension) }); });
    return () => { active = false; };
  }, [descriptor.path, session, readOnly, value]);
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
  return <div className="file-text-editor" ref={host} />;
}

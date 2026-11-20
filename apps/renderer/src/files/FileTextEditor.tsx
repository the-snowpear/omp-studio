import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField, Transaction, type EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { coreEditorExtensions } from "../structured-editor/extensions";
import type { FileDocument } from "./fileDocuments";
import type { FilePanelDescriptor } from "../dock/types";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { useI18n } from "../i18n";
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
type EditorSource = { session: FileDocument; value?: string; onChange?: never; onSave?: never } |
  { session?: undefined; value: string; onChange?: (text: string) => void; onSave?: () => void };
const externalText = Annotation.define<boolean>();
const searchPhrases = {
  "Go to line": "跳转到行", go: "跳转", Find: "查找", Replace: "替换", next: "下一个", previous: "上一个",
  all: "全选", "match case": "区分大小写", regexp: "正则表达式", "by word": "全字匹配", replace: "替换",
  "replace all": "全部替换", close: "关闭", "current match": "当前匹配", "on line": "所在行",
  "replaced match on line $": "已替换第 $ 行的匹配项", "replaced $ matches": "已替换 $ 个匹配项",
};
export default function FileTextEditor({ session, descriptor, onViewState, readOnly = false, value, onChange, onSave, label, viewId = "default", wrap = true, fontSize, gitMarks, commands, onScrollRatio, displayExtension }: EditorSource & {
  descriptor: Pick<FilePanelDescriptor, "path" | "line" | "column" | "jump" | "scroll">; onViewState?: (patch: Partial<FilePanelDescriptor>) => void; readOnly?: boolean; label?: string; viewId?: string;
  wrap?: boolean; fontSize?: number | undefined; gitMarks?: PatchMarks | undefined; commands?: EditorCommands | undefined;
  /** Split view: reports the proportional scroll position so the paired preview can follow. */
  onScrollRatio?: ((ratio: number) => void) | undefined;
  displayExtension?: Extension | undefined;
}) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null), surface = useSurfaceDocument();
  const zh = useI18n().resolvedLanguage === "zh";
  const latest = useRef({ onViewState, commands, onScrollRatio, onChange, onSave, zh }); latest.current = { onViewState, commands, onScrollRatio, onChange, onSave, zh };
  const controlled = value !== undefined;
  const text = value ?? session!.getSnapshot().text;
  const synchronized = useRef(text);
  const language = useRef(new Compartment()), wrapping = useRef(new Compartment()), access = useRef(new Compartment()), locale = useRef(new Compartment());
  const display = useRef(new Compartment());
  const appliedDisplay = useRef(displayExtension);
  const navigation = useRef<string | undefined>(undefined);
  const wrapRef = useRef(wrap); wrapRef.current = wrap;
  const following = useRef(false);
  useLayoutEffect(() => {
    const parent = host.current!;
    synchronized.current = text;
    appliedDisplay.current = displayExtension;
    let states = session && editorStates.get(session);
    if (session && !controlled && !states) { states = new Map(); editorStates.set(session, states); }
    const entry = !controlled ? states?.get(viewId) : undefined;
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
          const zh = latest.current.zh;
          if (latest.current.commands?.onAddSelection) button(zh ? "＠ 添加到对话" : "@ Add to conversation", zh ? "把选中的行作为上下文加入对话（Ctrl Shift L）" : "Add selected lines to conversation context (Ctrl Shift L)", () => { const selection = lineRange(editor.state); if (selection) latest.current.commands?.onAddSelection?.(selection); });
          button(zh ? "复制" : "Copy", zh ? "复制选区" : "Copy selection", () => latest.current.commands?.onCopy?.(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)));
          return { dom, offset: { x: 0, y: 6 } };
        } };
      },
      provide: field => showTooltip.from(field),
    });
    const extensions = [
      ...coreEditorExtensions({}), wrapping.current.of(wrapRef.current ? EditorView.lineWrapping : []), access.current.of([]), language.current.of([]),
      locale.current.of(EditorState.phrases.of(zh ? searchPhrases : {})), display.current.of(displayExtension ?? []),
      ...(session ? [gitChangeGutter()] : []), ...(!controlled ? [selectionBar] : []),
      Prec.high(keymap.of([
        { key: "Mod-s", run: () => { if (session) void session.save(); else latest.current.onSave?.(); return true; } },
        { key: "Mod-Enter", run: () => { if (!latest.current.onSave) return false; latest.current.onSave(); return true; } },
        { key: "Mod-g", run: gotoLine },
        { key: "Alt-z", run: command(actions => actions.onToggleWrap?.()) },
        { key: "Mod-=", run: command(actions => actions.onFontSize?.(1)) },
        { key: "Mod-+", run: command(actions => actions.onFontSize?.(1)) },
        { key: "Mod--", run: command(actions => actions.onFontSize?.(-1)) },
        { key: "Mod-0", run: command(actions => actions.onFontSize?.(null)) },
        { key: "Mod-Shift-l", run: editor => { const selection = lineRange(editor.state), add = latest.current.commands?.onAddSelection; if (!selection || !add) return false; add(selection); return true; } },
      ])),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.state.readOnly && !update.transactions.some(transaction => transaction.annotation(externalText))) {
          synchronized.current = update.state.doc.toString();
          if (session) session.edit(synchronized.current);
          else latest.current.onChange?.(synchronized.current);
        }
        if (update.docChanged || update.selectionSet) latest.current.commands?.onCursor?.(cursorOf(update.state));
      }),
    ];
    const editor = new EditorView({ parent, state: initial ? initial.update({ effects: StateEffect.reconfigure.of(extensions) }).state : EditorState.create({ doc: text, extensions }) });
    view.current = editor;
    latest.current.commands?.onCursor?.(cursorOf(editor.state));
    latest.current.commands?.onReady?.({ search: () => { openSearchPanel(editor); }, gotoLine: () => { gotoLine(editor); }, focus: () => editor.focus(), selection: () => lineRange(editor.state),
      scrollToRatio: ratio => { const element = editor.scrollDOM, top = Math.round(ratio * (element.scrollHeight - element.clientHeight)); if (Math.abs(element.scrollTop - top) > 1) { following.current = true; element.scrollTop = top; } } });
    const subscription = !controlled && session?.subscribe(() => {
      const next = session.getSnapshot().text;
      if (synchronized.current !== next) {
        synchronized.current = next;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: next }, annotations: [externalText.of(true), Transaction.addToHistory.of(false)] });
      }
    });
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const scroll = () => {
      if (latest.current.onViewState) { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => latest.current.onViewState?.({ scroll: editor.scrollDOM.scrollTop }), 200); }
      if (following.current) { following.current = false; return; }
      const element = editor.scrollDOM, range = element.scrollHeight - element.clientHeight;
      latest.current.onScrollRatio?.(range > 0 ? element.scrollTop / range : 0);
    };
    editor.scrollDOM.addEventListener("scroll", scroll);
    editor.scrollDOM.scrollTop = descriptor.scroll ?? 0;
    const observer = new ResizeObserver(() => { const root = parent.getRootNode() as Document; if (editor.root !== root) editor.setRoot(root); editor.requestMeasure(); });
    observer.observe(parent);
    return () => {
      clearTimeout(scrollTimer);
      latest.current.commands?.onReady?.(null);
      if (session && states && !controlled) {
        if (session.isViewClosed(viewId)) states.delete(viewId);
        else { states.set(viewId, { state: editor.state, navigation: navigation.current }); latest.current.onViewState?.({ scroll: editor.scrollDOM.scrollTop }); }
      }
      if (subscription) subscription();
      observer.disconnect(); editor.destroy(); view.current = null;
    };
  }, [session, viewId, controlled]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const effects = appliedDisplay.current === displayExtension ? [] : [display.current.reconfigure(displayExtension ?? [])];
    appliedDisplay.current = displayExtension;
    if (value !== undefined && value !== synchronized.current) {
      synchronized.current = value;
      // Style ranges and their text must land in the same transaction on reload.
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: [externalText.of(true), Transaction.addToHistory.of(false)], effects });
    } else if (effects.length) editor.dispatch({ effects });
  }, [value, displayExtension, session, viewId, controlled]);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      ...(label ? [EditorView.contentAttributes.of({ role: "textbox", "aria-label": label, "aria-readonly": String(readOnly), "aria-multiline": "true", tabindex: "0" })] : []),
    ]) });
  }, [readOnly, label, session, viewId, controlled]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.phrase("Find") === (zh ? searchPhrases.Find : "Find")) return;
    const { scrollTop, scrollLeft } = editor.scrollDOM;
    editor.dispatch({ effects: locale.current.reconfigure(EditorState.phrases.of(zh ? searchPhrases : {})) });
    editor.scrollDOM.scrollTop = scrollTop;
    editor.scrollDOM.scrollLeft = scrollLeft;
  }, [zh]);
  useEffect(() => {
    const name = descriptor.path.split(/[\\/]/).pop() ?? descriptor.path;
    const match = languages.find(language => language.filename?.test(name) || language.extensions.includes(name.split(".").pop()?.toLowerCase() ?? ""));
    let active = true;
    view.current?.dispatch({ effects: language.current.reconfigure([]) });
    if (match) void match.load().then(extension => { if (active) view.current?.dispatch({ effects: language.current.reconfigure(extension) }); });
    return () => { active = false; };
  }, [descriptor.path, session, viewId, controlled]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap, session, viewId, controlled]);
  useEffect(() => { view.current?.requestMeasure(); }, [fontSize]);
  useEffect(() => { if (gitMarks) view.current?.dispatch({ effects: setGitMarks.of(gitMarks) }); }, [gitMarks, session, viewId, controlled]);
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

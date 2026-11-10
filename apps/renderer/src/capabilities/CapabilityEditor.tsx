import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { languages } from "@codemirror/language-data";
import { coreEditorExtensions } from "../structured-editor/extensions";
import "./capabilityEditor.css";

const externalChange = Annotation.define<boolean>();

/** The same CodeMirror foundation and theme as Studio's file and settings editors. */
export function CapabilityEditor({
  value, onChange, label, language = "text", readOnly = false, placeholder, onSubmit, className = "",
}: {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  language?: "python" | "markdown" | "cpp" | "text";
  readOnly?: boolean;
  placeholder?: string;
  onSubmit?: () => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const languageConfig = useRef(new Compartment());
  const accessConfig = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSubmit });
  callbacks.current = { onChange, onSubmit };

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...coreEditorExtensions(placeholder ? { placeholder } : {}),
          languageConfig.current.of([]),
          accessConfig.current.of([]),
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => {
            if (!callbacks.current.onSubmit) return false;
            callbacks.current.onSubmit();
            return true;
          } }])),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) {
              callbacks.current.onChange?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    editor.current = view;
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(host.current);
    return () => { observer.disconnect(); editor.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    editor.current?.dispatch({ effects: accessConfig.current.reconfigure([
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ "aria-label": label, "aria-readonly": String(readOnly), role: "textbox", "aria-multiline": "true", spellcheck: "false" }),
    ]) });
  }, [readOnly, label]);

  useEffect(() => {
    let active = true;
    const description = languages.find(item => item.name === ({ python: "Python", markdown: "Markdown", cpp: "C++", text: "" }[language]));
    editor.current?.dispatch({ effects: languageConfig.current.reconfigure([]) });
    if (description) void description.load().then(extension => {
      if (active) editor.current?.dispatch({ effects: languageConfig.current.reconfigure(extension) });
    }).catch(() => { /* Plain text editing remains available if a language chunk fails. */ });
    return () => { active = false; };
  }, [language]);

  return <div ref={host} className={`capability-editor ${className}`} />;
}

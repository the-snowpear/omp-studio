import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldAll, foldedRanges, forceParsing, unfoldAll } from "@codemirror/language";
import { Icon } from "../icons";
import { coreEditorExtensions, languageExtensions } from "./extensions";
import {
  convertStructured,
  parseStructured,
  type StructuredLanguage,
} from "./parse";
import "./structured-editor.css";

export type { StructuredLanguage };

export interface StructuredEditorProps {
  language: StructuredLanguage;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
  allowEmpty?: boolean;
  lint?: boolean;
  showCopy?: boolean;
  languages?: ReadonlyArray<StructuredLanguage>;
  title?: string;
  path?: string;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  live?: boolean;
  className?: string;
  onValidityChange?: (ok: boolean, message: string | null) => void;
  onLanguageChange?: (language: StructuredLanguage) => void;
  onSave?: (value: string) => void | Promise<void>;
  saving?: boolean;
  saveDisabled?: boolean;
  dirty?: boolean;
  saveHint?: string;
}

export function StructuredEditor({
  language,
  value,
  onChange,
  readOnly = false,
  disabled = false,
  allowEmpty = true,
  lint = true,
  showCopy = true,
  languages,
  title,
  path,
  placeholder: placeholderText,
  minHeight = 220,
  maxHeight = 420,
  live = false,
  className,
  onValidityChange,
  onLanguageChange,
  onSave,
  saving = false,
  saveDisabled = false,
  dirty = false,
  saveHint,
}: StructuredEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langConf = useRef(new Compartment());
  const roConf = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const validityRef = useRef(onValidityChange);
  const emittedRef = useRef<string | null>(null);
  const foldedRef = useRef(false);
  onChangeRef.current = onChange;
  validityRef.current = onValidityChange;

  const [mode, setMode] = useState<StructuredLanguage>(language);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [slotH, setSlotH] = useState(minHeight);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [baseline, setBaseline] = useState(value);
  const [allFolded, setAllFolded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const locked = readOnly || disabled;
  const canRevert = Boolean(onChange) && !locked && value !== baseline;
  const modes = languages && languages.length > 1 ? languages : null;
  const label = title ?? (mode === "json" ? "JSON" : "YAML");

  useEffect(() => {
    setMode(language);
  }, [language]);

  useEffect(() => {
    reportIssue(mode, value, allowEmpty, lint, setIssue, validityRef.current);
  }, [mode, value, allowEmpty, lint]);

  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (!parent || viewRef.current) return undefined;

    const state = EditorState.create({
      doc: value,
      extensions: [
        ...coreEditorExtensions({
          ...(placeholderText ? { placeholder: placeholderText } : {}),
        }),
        langConf.current.of(languageExtensions(mode, { allowEmpty, lint })),
        roConf.current.of(EditorState.readOnly.of(locked)),
        EditorView.updateListener.of((update) => {
          if (update.focusChanged) setFocused(update.view.hasFocus);
          const folded = foldedRanges(update.state).size > 0;
          if (folded !== foldedRef.current) {
            foldedRef.current = folded;
            setAllFolded(folded);
          }
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          emittedRef.current = next;
          onChangeRef.current?.(next);
        }),
      ],
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(parent);
    return () => {
      observer.disconnect();
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // Host node is created after the in-flow anchor mounts; keep the view
    // across expand/collapse because the portal only moves that node.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount when anchor exists
  }, [anchor]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langConf.current.reconfigure(languageExtensions(mode, { allowEmpty, lint })),
    });
  }, [mode, allowEmpty, lint]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: roConf.current.reconfigure(EditorState.readOnly.of(locked)) });
  }, [locked]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
    if (emittedRef.current !== value) setBaseline(value);
  }, [value]);

  useLayoutEffect(() => {
    viewRef.current?.requestMeasure();
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      html.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  const switchMode = (next: StructuredLanguage) => {
    if (next === mode || locked) return;
    const converted = convertStructured(mode, next, value);
    if (!converted.ok) {
      setIssue(converted.message);
      return;
    }
    setMode(next);
    emittedRef.current = converted.text;
    onChange?.(converted.text);
    onLanguageChange?.(next);
  };

  const toggleFolds = () => {
    const view = viewRef.current;
    if (!view) return;
    forceParsing(view, view.state.doc.length, 200);
    if (foldedRanges(view.state).size > 0) unfoldAll(view);
    else foldAll(view);
  };

  const onCancel = () => {
    if (locked) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === baseline) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: baseline },
    });
    emittedRef.current = baseline;
    onChange?.(baseline);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setIssue("复制失败");
    }
  };

  const toggleExpanded = () => {
    if (!expanded) {
      const node = cardRef.current;
      if (node) setSlotH(Math.round(node.getBoundingClientRect().height));
    }
    setExpanded((current) => !current);
  };

  const cardClass = ["yml-card", "st-card", expanded ? "is-expanded" : "", className]
    .filter(Boolean)
    .join(" ");
  const editorClass = ["st-editor", focused ? "is-focused" : "", disabled ? "is-disabled" : ""]
    .filter(Boolean)
    .join(" ");

  const card = (
    <div
      ref={cardRef}
      className={cardClass}
      data-language={mode}
      {...(expanded ? { role: "dialog" as const, "aria-modal": true as const, "aria-label": label } : {})}
    >
      <div className="yml-head">
        <span className="yml-title">
          <Icon name="file-code" extra="sm" />
          {label}
        </span>
        {path ? <span className="yml-path">{path}</span> : null}
        <span className="chip gray xs">{mode.toUpperCase()}</span>
        {live && !dirty ? <span className="chip green xs">实时</span> : null}
        {dirty ? <span className="chip amber xs">未保存</span> : null}
        {saveHint ? <span className="chip blue xs">{saveHint}</span> : null}
        {readOnly ? <span className="chip gray xs">只读</span> : null}
        <span className="spacer" />
        {modes ? (
          <span className="seg st-lang" role="tablist" aria-label="编码">
            {modes.map((item) => (
              <button
                type="button"
                key={item}
                role="tab"
                aria-selected={mode === item}
                className={mode === item ? "active" : undefined}
                disabled={locked}
                onClick={() => switchMode(item)}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </span>
        ) : null}
        <button
          type="button"
          className="btn small outline"
          aria-pressed={allFolded}
          aria-label={allFolded ? "展开已折叠的代码" : "折叠所有可折叠的代码"}
          title={allFolded ? "展开折叠" : "全部折叠"}
          onClick={toggleFolds}
        >
          <Icon name={allFolded ? "chevron-d" : "chevron-ud"} extra="sm" />
          {allFolded ? "展开折叠" : "全部折叠"}
        </button>
        {showCopy ? (
          <button type="button" className="btn small outline" onClick={() => void onCopy()}>
            <Icon name="copy" extra="sm" />
            {copied ? "已复制" : "复制"}
          </button>
        ) : null}
        {onChange && !locked ? (
          <button
            type="button"
            className="btn small outline"
            disabled={!canRevert || saving}
            title="还原对本段代码的修改"
            onClick={onCancel}
          >
            <Icon name="x" extra="sm" />
            取消
          </button>
        ) : null}
        {onSave ? (
          <button
            type="button"
            className="btn small primary"
            disabled={saving || saveDisabled || Boolean(issue) || locked}
            onClick={() => void onSave(value)}
          >
            <Icon name="check" extra="sm" />
            {saving ? "保存中…" : "保存"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn small outline"
          aria-expanded={expanded}
          aria-label={expanded ? "收起编辑器" : "展开编辑器"}
          title={expanded ? "收起（Esc）" : "展开"}
          onClick={toggleExpanded}
        >
          <Icon name={expanded ? "restore" : "maximize"} extra="sm" />
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      <div
        ref={hostRef}
        className={editorClass}
        {...(expanded ? {} : { style: { height: minHeight, minHeight, maxHeight } })}
        aria-label={label}
      />
      {issue ? (
        <div className="yml-error" role="alert">
          <Icon name="alert-c" extra="sm" />
          <span className="yml-error-text">{issue}</span>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <div
        ref={setAnchor}
        className={expanded ? ["st-expand-slot", className].filter(Boolean).join(" ") : "st-holder"}
        {...(expanded ? { style: { height: slotH } } : {})}
        aria-hidden={expanded}
      />
      {expanded
        ? createPortal(
            <div className="st-expand-scrim" onClick={() => setExpanded(false)} />,
            document.body,
          )
        : null}
      {anchor ? createPortal(card, expanded ? document.body : anchor) : null}
    </>
  );
}

function reportIssue(
  language: StructuredLanguage,
  text: string,
  allowEmpty: boolean,
  lint: boolean,
  setIssue: (message: string | null) => void,
  onValidityChange: ((ok: boolean, message: string | null) => void) | undefined,
): void {
  if (!lint) {
    setIssue(null);
    onValidityChange?.(true, null);
    return;
  }
  try {
    const parsed = parseStructured(language, text, allowEmpty);
    const message = parsed.ok ? null : parsed.message;
    setIssue(message);
    onValidityChange?.(parsed.ok, message);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法解析";
    setIssue(message);
    onValidityChange?.(false, message);
  }
}

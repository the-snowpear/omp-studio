import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AnnotationBundle, AnnotationCapture, AnnotationNote, AnnotationSource } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { formatShortcut, isPrimaryModifier } from "../keyboard/shortcuts";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { hostErrorMessage } from "../hostError";
import { AnnotationSourceView, type AnnotationReader } from "./AnnotationSourceView";
import { annotationLocation, annotationSourceKind, type AnnotationSelection } from "./annotationText";

interface NoteDraft { text: string; selection?: AnnotationSelection | undefined; editing?: string | undefined }
type Drafts = Record<string, NoteDraft>;
const blankDraft: NoteDraft = { text: "" };
const sourceIcons = { message: "message", quote: "type", file: "file-code", diff: "changes" } as const;

function readDrafts(key: string): Drafts {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, NoteDraft] => {
      const row = entry[1] as NoteDraft | undefined;
      return !!row && typeof row.text === "string" && row.text.length <= 8000
        && (row.editing === undefined || typeof row.editing === "string")
        && (row.selection === undefined || Number.isSafeInteger(row.selection.start)
          && Number.isSafeInteger(row.selection.end) && row.selection.start >= 0 && row.selection.end > row.selection.start);
    }));
  } catch { return {}; }
}

export function AnnotationDialog({
  open, bundle, selected, busy, error, notice, stale, allowStale, canUndo,
  draftKey, editorEpoch, preview, marks, onSelect, onCapture, onCommit,
  onUndo, onClose, onPrepare, onSaveSnapshot, onAllowStale,
}: {
  open: boolean;
  bundle: AnnotationBundle;
  selected: string | undefined;
  busy: boolean;
  error: string;
  notice: string;
  stale: string[];
  allowStale: boolean;
  canUndo: boolean;
  draftKey: string;
  editorEpoch: number;
  preview: boolean;
  marks: boolean;
  onSelect(id: string): void;
  onCapture(source: AnnotationCapture): void;
  onCommit(bundle: AnnotationBundle): void;
  onUndo(): void;
  onClose(): void;
  onPrepare(action: "feedback" | "review"): void;
  onSaveSnapshot(): void;
  onAllowStale(value: boolean): void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const surface = useSurfaceDocument();
  const uid = useId();
  const storageKey = draftKey + ":editor";
  const [drafts, setDrafts] = useState<Drafts>(() => preview ? {} : readDrafts(storageKey));
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [draftError, setDraftError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<"file" | "diff" | "quote">("file");
  const [path, setPath] = useState("");
  const [paste, setPaste] = useState("");
  const [wrap, setWrap] = useState(true);
  const [activeNote, setActiveNote] = useState<string>();
  const [chooser, setChooser] = useState<AnnotationNote[]>([]);
  const reader = useRef<AnnotationReader | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const addSource = useRef<HTMLButtonElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const pasteInput = useRef<HTMLTextAreaElement>(null);
  const noteList = useRef<HTMLDivElement>(null);
  const scrollMemory = useRef(new Map<string, number>());
  const focusReader = useRef(false);
  const previousEpoch = useRef(editorEpoch);
  const source = bundle.sources.find(item => item.id === selected)
    ?? bundle.sources.find(item => drafts[item.id]?.text.trim() || drafts[item.id]?.editing)
    ?? bundle.sources[0];
  const notes = useMemo(() => bundle.notes.filter(note => note.sourceId === source?.id), [bundle.notes, source?.id]);
  const current = source ? drafts[source.id] ?? blankDraft : blankDraft;
  const selection = current.selection && source && current.selection.end <= source.text.length ? current.selection : undefined;
  const sourcePending = !!current.text.trim() || !!current.editing;
  const pending = bundle.sources.some(item => drafts[item.id]?.text.trim() || drafts[item.id]?.editing);
  const hasDiff = bundle.sources.some(item => item.kind === "diff");
  const hasReviewNotes = bundle.notes.some(note => bundle.sources.some(item => item.id === note.sourceId && item.kind === "diff"));

  const persist = useCallback(() => {
    if (preview) return;
    try { localStorage.setItem(storageKey, JSON.stringify(draftsRef.current)); }
    catch { /* Completed annotations can still be saved to the artifact library. */ }
  }, [preview, storageKey]);
  useEffect(() => {
    const timer = setTimeout(persist, 160);
    return () => clearTimeout(timer);
  }, [drafts, persist]);
  useEffect(() => {
    const window = surface.defaultView!;
    window.addEventListener("pagehide", persist);
    return () => { window.removeEventListener("pagehide", persist); persist(); };
  }, [surface, persist]);
  useEffect(() => {
    if (!open) { persist(); return; }
    const previous = surface.activeElement;
    focusReader.current = !source;
    if (current.text.trim() || current.editing) editor.current?.focus();
    else if (source) reader.current?.focus();
    else addSource.current?.focus();
    return () => {
      persist();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, persist, surface]);
  useEffect(() => {
    if (previousEpoch.current === editorEpoch) return;
    previousEpoch.current = editorEpoch;
    setDrafts({}); setDraftError(""); setActiveNote(undefined); setChooser([]);
    scrollMemory.current.clear();
  }, [editorEpoch]);
  useEffect(() => {
    if (open && source && selected !== source.id) onSelect(source.id);
  }, [open, source?.id, selected, onSelect]);
  useEffect(() => {
    if (!importOpen) return;
    if (importKind === "quote") pasteInput.current?.focus();
    else importInput.current?.focus();
  }, [importOpen, importKind]);
  useEffect(() => {
    if (!open) return;
    const ids = new Set(bundle.sources.map(item => item.id));
    for (const key of scrollMemory.current.keys()) if (!ids.has(key)) scrollMemory.current.delete(key);
  }, [bundle.sources, open]);

  const updateDraft = (patch: Partial<NoteDraft>) => {
    if (!source) return;
    setDrafts(previous => ({ ...previous, [source.id]: { ...previous[source.id] ?? blankDraft, ...patch } }));
    setDraftError("");
  };
  const clearDraft = () => {
    if (!source) return;
    setDrafts(previous => { const next = { ...previous }; delete next[source.id]; return next; });
    setDraftError(""); setActiveNote(undefined); setChooser([]);
  };
  const saveNote = () => {
    if (!source || busy || (!current.editing && !current.text.trim())) return;
    const text = current.text.trim();
    const note: AnnotationNote = {
      id: current.editing ?? crypto.randomUUID(), sourceId: source.id, note: text,
      ...(selection ? { selection } : {}),
    };
    try {
      const notes = !text ? bundle.notes.filter(item => item.id !== note.id)
        : bundle.notes.some(item => item.id === note.id) ? bundle.notes.map(item => item.id === note.id ? note : item)
          : [...bundle.notes, note];
      onCommit({ ...bundle, revision: bundle.revision + 1, notes });
      clearDraft();
      reader.current?.focus();
    } catch (cause) { setDraftError(hostErrorMessage(cause, zh ? "无法保存标注" : "Could not save annotation")); }
  };
  const locate = useCallback((id: string) => {
    const note = notes.find(item => item.id === id);
    if (!note) return;
    setActiveNote(id);
    reader.current?.reveal(note.selection);
    const card = [...noteList.current?.querySelectorAll<HTMLElement>("[data-note-id]") ?? []].find(item => item.dataset.noteId === id);
    card?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
  }, [notes]);
  const editNote = (note: AnnotationNote) => {
    if (busy) return;
    if (current.editing === note.id) { editor.current?.focus(); return; }
    if (sourcePending) return;
    setDrafts(previous => ({ ...previous, [note.sourceId]: { text: note.note, editing: note.id, selection: note.selection } }));
    setActiveNote(note.id); setDraftError(""); setChooser([]);
    reader.current?.reveal(note.selection);
    editor.current?.focus();
  };
  const annotate = () => { if (source && !busy) { setImportOpen(false); editor.current?.focus(); } };
  const editAtSelection = (range: AnnotationSelection | undefined) => {
    if (busy || sourcePending) return;
    const applicable = notes.filter(note => !range || !note.selection || note.selection.start < range.end && note.selection.end > range.start);
    if (applicable.length === 1) editNote(applicable[0]!);
    else if (applicable.length > 1) setChooser(applicable);
  };
  const chooseSource = (id: string) => {
    onSelect(id); setImportOpen(false); setChooser([]); setActiveNote(undefined); setDraftError("");
    focusReader.current = true;
    if (source?.id === id && !importOpen) { focusReader.current = false; reader.current?.focus(); }
  };
  const dismissImport = () => {
    focusReader.current = true;
    setImportOpen(false);
    if (!source) addSource.current?.focus();
  };
  const capture = () => {
    if (busy) return;
    if (importKind === "file" && path.trim()) onCapture({ kind: "file", path: path.trim() });
    else if (importKind === "diff") onCapture({ kind: "diff", ...(path.trim() ? { path: path.trim() } : {}) });
    else if (importKind === "quote" && paste.trim()) {
      onCapture({ kind: "quote", label: zh ? "粘贴文本" : "Pasted text", text: paste });
      setPaste("");
    } else return;
    setImportOpen(false); focusReader.current = true;
  };
  const removeSource = () => {
    if (!source || busy) return;
    onCommit({ ...bundle, revision: bundle.revision + 1,
      sources: bundle.sources.filter(item => item.id !== source.id),
      notes: bundle.notes.filter(note => note.sourceId !== source.id) });
    clearDraft();
  };
  const setReader = useCallback((value: AnnotationReader | null) => {
    reader.current = value;
    if (value && focusReader.current) { focusReader.current = false; value.focus(); }
  }, []);

  if (!open) return null;
  return <section className="annotation-dialog" role="region" aria-labelledby={uid + "-title"} aria-describedby={uid + "-description"}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.defaultPrevented || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            if (chooser.length) { setChooser([]); reader.current?.focus(); }
            else if (importOpen) dismissImport();
            else onClose();
          }
          const target = event.target as HTMLElement;
          const typing = target.matches("input, textarea, [contenteditable=true]");
          if (!typing && isPrimaryModifier(event) && event.key.toLowerCase() === "z" && canUndo && !busy && !pending) {
            event.preventDefault(); onUndo();
          }
        }}>
        <header className="annotation-header">
          <span className="annotation-title-icon"><Icon name="pencil" /></span>
          <div className="annotation-heading">
            <h2 id={uid + "-title"}>{zh ? "标注" : "Annotations"}
              {preview && marks ? <span className="annotation-demo">{zh ? "演示" : "Demo"}</span> : null}
            </h2>
            <p id={uid + "-description"}>{zh ? "阅读原文，整理反馈" : "Read in context. Leave precise feedback."}</p>
          </div>
          <div className="annotation-header-actions">
            <button type="button" className="btn annotation-save-snapshot" disabled={busy || !bundle.sources.length || pending} onClick={onSaveSnapshot}>
              <Icon name="save" extra="sm" />{zh ? "保存快照" : "Save snapshot"}
            </button>
            <button type="button" className="btn annotation-undo" disabled={!canUndo || busy || pending} onClick={onUndo} data-tip={(zh ? "撤销上一条标注操作" : "Undo the last annotation change") + ` (u / ${formatShortcut({ key: "Z" })})`}>
              <Icon name="undo" extra="sm" />{zh ? "撤销" : "Undo"}
            </button>
          </div>
        </header>
        {busy || error || notice ? <div className={"annotation-status" + (error ? " is-error" : "")} role={error ? "alert" : "status"}>
          <Icon name={error ? "alert-c" : busy ? "clock" : "check"} extra="sm" />
          <span>{error || (busy ? zh ? "正在准备来源或标注…" : "Preparing source or annotations…" : notice)}</span>
        </div> : null}
        <div className="annotation-workspace">
          <nav className="annotation-sources" aria-label={zh ? "标注来源" : "Annotation sources"}>
            <div className="annotation-pane-heading"><h3>{zh ? "来源" : "Sources"}</h3><span className="annotation-count">{bundle.sources.length}</span></div>
            <div className="annotation-source-list">
              {bundle.sources.map(item => {
                const count = bundle.notes.filter(note => note.sourceId === item.id).length;
                const name = item.path?.split(/[\\/]/).pop() ?? item.label;
                return <button type="button" key={item.id} className={"annotation-source-item" + (source?.id === item.id && !importOpen ? " is-active" : "")} aria-current={source?.id === item.id && !importOpen ? "true" : undefined} onClick={() => chooseSource(item.id)} data-tip={item.path ?? item.label}>
                  <Icon name={sourceIcons[item.kind]} />
                  <span className="annotation-source-copy"><strong>{name}</strong><span>{annotationSourceKind(item.kind, zh)}{drafts[item.id]?.text.trim() || drafts[item.id]?.editing ? <span className="annotation-source-draft">{zh ? "有草稿" : "Draft"}</span> : null}</span></span>
                  {stale.includes(item.id) ? <Icon name="alert" extra="sm" /> : count ? <span className="annotation-source-count">{count}</span> : null}
                </button>;
              })}
              {!bundle.sources.length ? <p className="annotation-source-placeholder">{zh ? "回复、文件或改动\n都会保留在这里" : "Replies, files and changes\nstay together here"}</p> : null}
            </div>
            <button type="button" ref={addSource} className={"btn annotation-add-source" + (importOpen ? " is-active" : "")} onClick={() => { setImportOpen(true); setChooser([]); }}><Icon name="plus" extra="sm" />{zh ? "添加来源" : "Add source"}</button>
            <div className="annotation-source-foot"><Icon name="lock" extra="sm" /><span>{zh ? "原文按捕获时的版本保留" : "Sources stay frozen as captured"}</span></div>
          </nav>
          <section className="annotation-document" aria-label={zh ? "原文阅读" : "Source reader"}>
            {importOpen ? <div className="annotation-import">
              <div className="annotation-import-heading"><div><h3>{zh ? "添加来源" : "Add a source"}</h3><p>{zh ? "选择你想留下意见的内容。" : "Choose the content you want to annotate."}</p></div><button type="button" className="icon-btn" aria-label={zh ? "返回原文" : "Back to source"} onClick={dismissImport}><Icon name="x" /></button></div>
              <div className="annotation-import-tabs" role="tablist" aria-label={zh ? "来源类型" : "Source type"}>
                {(["file", "diff", "quote"] as const).map(kind => <button type="button" role="tab" aria-selected={importKind === kind} aria-controls={uid + "-import"} id={uid + "-tab-" + kind} key={kind} className={importKind === kind ? "is-active" : ""} onClick={() => setImportKind(kind)}><Icon name={sourceIcons[kind]} extra="sm" />{kind === "file" ? zh ? "文件" : "File" : kind === "diff" ? zh ? "当前改动" : "Changes" : zh ? "粘贴文本" : "Text"}</button>)}
              </div>
              <div className="annotation-import-fields" role="tabpanel" id={uid + "-import"} aria-labelledby={uid + "-tab-" + importKind}>
                {importKind === "quote" ? <><label htmlFor={uid + "-paste"}>{zh ? "粘贴来源文本" : "Paste source text"}</label><textarea ref={pasteInput} id={uid + "-paste"} className="input annotation-paste" rows={9} maxLength={120000} value={paste} onChange={event => setPaste(event.target.value)} placeholder={zh ? "粘贴一段文本，保留原始换行与空格…" : "Paste text, including its original spacing…"} /></> : <><label htmlFor={uid + "-path"}>{importKind === "file" ? zh ? "工作区相对文件路径" : "Workspace-relative file" : zh ? "文件路径（可选）" : "File path (optional)"}</label><div className="annotation-path-field"><Icon name="file" extra="sm" /><input ref={importInput} id={uid + "-path"} className="input mono" placeholder="src/app.ts" value={path} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); capture(); } }} /></div><p className="annotation-field-help">{importKind === "file" ? zh ? "读取当前工作区的文本文件，标注不会修改原文件。" : "Read a workspace text file without modifying it." : zh ? "留空读取所有未提交改动，填写路径可只看一个文件。" : "Leave empty for all uncommitted changes, or enter one file."}</p></>}
                <button type="button" className="btn annotation-import-submit" disabled={busy || (importKind === "file" ? !path.trim() : importKind === "quote" ? !paste.trim() : false)} onClick={capture}><Icon name={importKind === "quote" ? "plus" : "arrow-r"} extra="sm" />{importKind === "file" ? zh ? "打开文件" : "Open file" : importKind === "diff" ? zh ? "读取改动" : "Read changes" : zh ? "添加来源" : "Add source"}</button>
              </div>
              <div className="annotation-import-tip"><Icon name="message" extra="sm" /><p>{zh ? "也可以从对话中的「标注」按钮捕获回复或选中的文字。" : "You can also capture replies and selections with Annotate in the conversation."}</p></div>
            </div> : source ? <>
              <div className="annotation-document-heading">
                <div className="annotation-document-title"><Icon name={sourceIcons[source.kind]} extra="sm" /><span data-tip={source.path ?? source.label}>{source.path ?? source.label}</span></div>
                <div className="annotation-reader-tools">
                  <button type="button" className="icon-btn" aria-label={zh ? "搜索原文" : "Search source"} data-tip={zh ? "搜索原文" : "Search source"} onClick={() => reader.current?.search()}><Icon name="search" extra="sm" /></button>
                  <button type="button" className={"icon-btn" + (wrap ? " active" : "")} aria-label={zh ? "自动换行" : "Wrap lines"} aria-pressed={wrap} data-tip={zh ? "自动换行" : "Wrap lines"} onClick={() => setWrap(value => !value)}><Icon name="rows" extra="sm" /></button>
                  {source.kind === "file" || source.kind === "diff" ? <button type="button" className="icon-btn" aria-label={zh ? "重新捕获版本（保留旧标注）" : "Capture new version (keep old annotations)"} data-tip={zh ? "重新捕获，保留旧版标注" : "Recapture and keep old annotations"} disabled={busy} onClick={() => onCapture(source.kind === "file" ? { kind: "file", path: source.path! } : { kind: "diff", ...(source.path ? { path: source.path } : {}) })}><Icon name="refresh" extra="sm" /></button> : null}
                </div>
              </div>
              <details className="annotation-source-details"><summary><Icon name="lock" extra="sm" /><span>{annotationSourceKind(source.kind, zh)}{zh ? "快照" : " snapshot"}</span><span className="annotation-details-label">{zh ? "来源详情" : "Source details"}</span><Icon name="chevron-d" extra="sm" /></summary><dl><dt>{zh ? "类型" : "Type"}</dt><dd>{annotationSourceKind(source.kind, zh)}</dd><dt>{zh ? "版本" : "Version"}</dt><dd className="mono">{source.version}</dd><dt>{zh ? "快照版本" : "Snapshot revision"}</dt><dd>{bundle.revision}</dd></dl></details>
              <AnnotationSourceView source={source} notes={notes} selection={selection} activeNote={activeNote} wrap={wrap} zh={zh} scrollMemory={scrollMemory.current}
                locked={!!current.text.trim() || !!current.editing}
                onSelection={range => { if (!current.text.trim() && !current.editing) updateDraft({ selection: range }); }}
                onAnnotate={annotate} onEdit={editAtSelection} onUndo={() => { if (!busy && !pending && canUndo) onUndo(); }} onLocate={locate} onReady={setReader} />
              <div className="annotation-document-foot"><Icon name="cursor" extra="sm" /><span>{zh ? "选中文字，或双击一行添加标注" : "Select text or double-click a line to annotate"}</span><span className="annotation-line-total">{source.text.split("\n").length} {zh ? "行" : "lines"}</span><button type="button" className="icon-btn danger" aria-label={zh ? "移除此来源及标注" : "Remove source and annotations"} data-tip={zh ? "移除此来源及标注（可撤销）" : "Remove source and annotations (undoable)"} disabled={busy || sourcePending} onClick={removeSource}><Icon name="trash" extra="sm" /></button></div>
            </> : <div className="annotation-empty-source"><span className="annotation-empty-icon"><Icon name="file-code" /></span><h3>{zh ? "选择一份来源" : "Choose a source"}</h3><p>{zh ? "回复、文件、代码改动或一段文本。\n把原文和意见放在一起，反馈才有上下文。" : "A reply, a file, a diff or a passage.\nKeep the source beside your feedback."}</p><button type="button" className="btn annotation-add-source" onClick={() => setImportOpen(true)}><Icon name="plus" extra="sm" />{zh ? "添加来源" : "Add source"}</button></div>}
          </section>
          <section className="annotation-notes" aria-label={zh ? "标注整理" : "Annotation notes"}>
            <div className="annotation-pane-heading"><h3>{zh ? "标注" : "Notes"}</h3><span className="annotation-count">{notes.length}</span><span className="annotation-pane-caption">{zh ? "当前来源" : "This source"}</span></div>
            <div className="annotation-note-list" ref={noteList}>
              {chooser.length ? <div className="annotation-note-chooser" role="dialog" aria-label={zh ? "选择要编辑的标注" : "Choose an annotation to edit"}><h4>{zh ? "选择要编辑的标注" : "Choose a note to edit"}</h4>{chooser.map(note => <button type="button" className="btn" key={note.id} onClick={() => editNote(note)}>{note.note}</button>)}<button type="button" className="btn" onClick={() => { setChooser([]); reader.current?.focus(); }}>{zh ? "取消" : "Cancel"}</button></div> : null}
              {notes.map((note, index) => <article key={note.id} data-note-id={note.id} className={"annotation-note" + (activeNote === note.id || current.editing === note.id ? " is-active" : "")}>
                <div className="annotation-note-heading"><span className="annotation-note-number">{index + 1}</span><button type="button" className="annotation-note-location" onClick={() => locate(note.id)} aria-label={(zh ? "定位" : "Locate ") + annotationLocation(source!.text, note.selection, zh)}>{annotationLocation(source!.text, note.selection, zh)}<Icon name="arrow-u" extra="sm" /></button><span className="spacer" /><button type="button" className="icon-btn" aria-label={zh ? "编辑" : "Edit"} data-tip={zh ? "编辑标注" : "Edit note"} disabled={busy || sourcePending && current.editing !== note.id} onClick={() => editNote(note)}><Icon name="pencil" extra="sm" /></button><button type="button" className="icon-btn danger" aria-label={zh ? "删除" : "Delete"} data-tip={zh ? "删除标注（可撤销）" : "Delete note (undoable)"} disabled={busy || sourcePending} onClick={() => { onCommit({ ...bundle, revision: bundle.revision + 1, notes: bundle.notes.filter(item => item.id !== note.id) }); if (activeNote === note.id) setActiveNote(undefined); }}><Icon name="trash" extra="sm" /></button></div>
                {note.selection && source ? <blockquote className="annotation-note-quote">{source.text.slice(note.selection.start, note.selection.end).slice(0, 400)}</blockquote> : null}
                <p>{note.note}</p>
              </article>)}
              {!notes.length && !chooser.length ? <div className="annotation-empty-notes"><span className="annotation-empty-notes-icon"><Icon name="message" /></span><h4>{zh ? "还没有标注" : "No notes yet"}</h4><p>{source ? zh ? "选择一段原文，留下具体意见；\n也可以对整份来源添加标注。" : "Select a passage and leave feedback,\nor annotate the whole source." : zh ? "先选择来源，再写下你的意见。" : "Choose a source before adding feedback."}</p></div> : null}
            </div>
            <div className={"annotation-draft" + (current.editing ? " is-editing" : "")}>
              <div className="annotation-draft-heading"><label htmlFor={uid + "-note"}>{current.editing ? zh ? "编辑标注" : "Edit annotation" : zh ? "新标注" : "New annotation"}</label><span className="annotation-draft-scope"><Icon name={selection ? "cursor" : "file"} extra="sm" />{annotationLocation(source?.text ?? "", selection, zh)}</span>{selection && !current.text.trim() && !current.editing ? <button type="button" className="icon-btn" aria-label={zh ? "对整份来源标注" : "Annotate the whole source"} data-tip={zh ? "改为整份来源" : "Use whole source"} onClick={() => updateDraft({ selection: undefined })}><Icon name="x" extra="sm" /></button> : null}</div>
              {selection && source ? <blockquote className="annotation-draft-quote">{source.text.slice(selection.start, selection.end).slice(0, 400)}</blockquote> : null}
              <textarea ref={editor} id={uid + "-note"} className="input annotation-draft-text" aria-label={zh ? "标注意见" : "Annotation note"} aria-describedby={uid + "-note-help"} value={current.text} maxLength={8000} rows={4} disabled={busy || !source} placeholder={zh ? "写下你的意见或希望调整的地方…" : "Leave feedback or describe a change…"} onChange={event => updateDraft({ text: event.target.value })} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveNote(); }
                if (event.ctrlKey && event.key.toLowerCase() === "j") {
                  event.preventDefault(); const area = event.currentTarget, start = area.selectionStart, end = area.selectionEnd;
                  if (current.text.length - (end - start) < 8000) { updateDraft({ text: current.text.slice(0, start) + "\n" + current.text.slice(end) }); setTimeout(() => editor.current?.setSelectionRange(start + 1, start + 1), 0); }
                }
              }} />
              {draftError ? <p className="annotation-draft-error" role="alert">{draftError}</p> : null}
              <div className="annotation-draft-actions"><span id={uid + "-note-help"} className="annotation-editor-hint">{zh ? "Enter 保存 · Shift+Enter 换行" : "Enter to save · Shift+Enter for a new line"}</span>{current.editing ? <button type="button" className="btn" disabled={busy} onClick={() => { clearDraft(); reader.current?.focus(); }}>{zh ? "取消" : "Cancel"}</button> : null}<button type="button" className="btn annotation-add-note" disabled={busy || !source || (!current.editing && !current.text.trim())} onClick={saveNote}><Icon name={current.editing ? "check" : "plus"} extra="sm" />{current.editing ? zh ? "保存编辑" : "Save edit" : zh ? "添加标注" : "Add annotation"}</button></div>
            </div>
          </section>
        </div>
        {stale.length ? <div className="annotation-stale" role="alert"><Icon name="alert" /><div><strong>{zh ? "来源版本已改变" : "Source versions have changed"}</strong><p>{zh ? "来源已改变或不属于当前会话。重新捕获，或明确使用保存的旧快照。" : "Sources changed or belong to another session. Recapture them, or explicitly use their saved snapshots."}</p><span>{bundle.sources.filter(item => stale.includes(item.id)).map(item => item.label).join(" · ")}</span></div><label><input type="checkbox" checked={allowStale} onChange={event => onAllowStale(event.target.checked)} />{zh ? "使用捕获的旧版本" : "Use the captured versions"}</label></div> : null}
        <footer className="annotation-footer">
          <div className="annotation-footer-copy"><Icon name={pending ? "pencil" : "check"} extra="sm" /><div><strong>{pending ? zh ? "先保存正在编辑的标注" : "Save your unfinished annotation first" : bundle.notes.length ? zh ? `已整理 ${bundle.notes.length} 条标注` : `${bundle.notes.length} annotations ready` : zh ? "草稿会保留，随时可以回来" : "Your draft stays here for later"}</strong><span>{zh ? "先放入主对话输入框，由你发送。" : "Insert into the conversation Composer. You decide when to send."}</span></div></div>
          <div className="annotation-footer-actions">{hasDiff ? <button type="button" className="btn outline annotation-review" disabled={busy || pending || !!chooser.length || !hasReviewNotes} onClick={() => onPrepare("review")}><Icon name="shield" extra="sm" />{zh ? "准备审查" : "Prepare review"}</button> : null}<button type="button" className="btn primary annotation-insert" disabled={busy || pending || !!chooser.length || !bundle.notes.length} onClick={() => onPrepare("feedback")}>{zh ? "放入输入框" : "Insert feedback"}<Icon name="arrow-r" extra="sm" /></button></div>
        </footer>
      </section>;
}

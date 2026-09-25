import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { validateAnnotationBundle, type AnnotationBundle, type AnnotationCapture, type AnnotationNote, type AnnotationSource } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import { PREVIEW_ANNOTATION_FILE, PREVIEW_ANNOTATION_DIFF, PREVIEW_ANNOTATION_BUNDLE } from "../preview/annotationsPreview";
import "./annotations.css";

interface AnnotationActions { capture(source: AnnotationCapture): void; open(): void; openSaved(artifactId: string): void }
const Context = createContext<AnnotationActions | null>(null);
const empty = (): AnnotationBundle => ({ schemaVersion: 1, revision: 1, sources: [], notes: [] });
const id = () => crypto.randomUUID();

export function AnnotationButton({ source, label, small = false, menu = false, onActivate }: { source?: AnnotationCapture; label?: string; small?: boolean; menu?: boolean; onActivate?: () => void }) {
  const actions = useContext(Context); const { resolvedLanguage } = useI18n();
  if (!actions) return null;
  const title = label ?? (resolvedLanguage === "zh" ? "标注" : "Annotate");
  return <button type="button" role={menu ? "menuitem" : undefined} className={menu ? "menu-item" : small ? "ev-msg-copy" : "btn small outline"} aria-label={title} data-tip={title} onMouseDown={event => event.preventDefault()} onClick={event => {
    event.stopPropagation();
    const selected = window.getSelection(); const quote = selected?.toString();
    if (source?.kind === "message" && quote?.trim() && source.text.includes(quote) && selected?.anchorNode && event.currentTarget.closest(".ev-copy-host")?.contains(selected.anchorNode)) {
      actions.capture({ ...source, kind: "quote", text: quote, label: source.label + " · selection" });
    } else if (source) actions.capture(source); else actions.open();
    onActivate?.();
  }}><Icon name="pencil" extra="sm" />{small ? null : title}</button>;
}
export function OpenAnnotationArtifact({ artifactId }: { artifactId: string }) {
  const actions = useContext(Context); const { resolvedLanguage } = useI18n();
  return actions ? <button className="btn small" onClick={() => actions.openSaved(artifactId)}>{resolvedLanguage === "zh" ? "打开标注" : "Open annotations"}</button> : null;
}

export function AnnotationsProvider({ children, client, workspaceId, sessionId, runtimeSessionId, onInsert }: {
  children: ReactNode; client: StudioClient; workspaceId?: string | undefined; sessionId?: string | undefined; runtimeSessionId?: string | undefined; onInsert(text: string): void;
}) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [bundle, setBundle] = useState<AnnotationBundle>(empty); const bundleRef = useRef(bundle); bundleRef.current = bundle;
  const [open, setOpen] = useState(false); const [selected, setSelected] = useState<string>();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  const [undo, setUndo] = useState<AnnotationBundle[]>([]); const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>(); const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [stale, setStale] = useState<string[]>([]); const [allowStale, setAllowStale] = useState(false);
  const [path, setPath] = useState(""); const [paste, setPaste] = useState("");
  const generation = useRef(0); const busyRef = useRef(false);
  const key = "omp.annotations.v1:" + encodeURIComponent(workspaceId ?? "none") + ":" + encodeURIComponent(sessionId ?? "draft");
  useEffect(() => {
    generation.current++; busyRef.current = false; setBusy(false); setOpen(false); setSelected(undefined); setUndo([]); setDraft(""); setEditing(undefined); setStale([]); setAllowStale(false); setError(""); setNotice("");
    let next = empty();
    if (!preview) {
      try { const raw = localStorage.getItem(key); if (raw && raw.length <= 800000) { const value: unknown = JSON.parse(raw); validateAnnotationBundle(value); next = value; } }
      catch { setError(zh ? "标注草稿不可读；保存的快照仍在产物库。" : "The local draft is unreadable; saved snapshots remain in the artifact library."); }
    }
    bundleRef.current = next; setBundle(next);
    return () => { generation.current++; };
  }, [key, preview]);
  const commit = useCallback((next: AnnotationBundle) => {
    validateAnnotationBundle(next);
    const previous = bundleRef.current;
    setUndo(stack => [...stack.slice(-19), previous]); bundleRef.current = next; setBundle(next);
    setStale([]); setAllowStale(false); setNotice("");
    if (!preview) { try { localStorage.setItem(key, JSON.stringify(next)); } catch { setError("Local draft storage is full. Save a snapshot to the artifact library."); } }
  }, [key, preview]);
  const run = useCallback(async (action: (epoch: number) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice(""); const epoch = generation.current;
    try { await action(epoch); }
    catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Annotation operation failed")); }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  }, []);
  const capture = useCallback((input: AnnotationCapture) => {
    setOpen(true);
    if (busyRef.current) { setError("Wait for the current annotation operation to finish."); return; }
    void run(async epoch => {
      if (!preview && (input.kind === "file" || input.kind === "diff") && sessionId && sessionId !== runtimeSessionId) throw new Error("Open the active session to annotate workspace files. Historical replies can be annotated as snapshots.");
      if ((input.kind === "message" || input.kind === "quote") && !input.sessionId && sessionId) input = { ...input, sessionId };
      let source: AnnotationSource;
      if (preview) {
        const text = "text" in input ? input.text : input.kind === "diff" ? PREVIEW_ANNOTATION_DIFF : PREVIEW_ANNOTATION_FILE;
        source = { id: "demo-" + id(), kind: input.kind, label: "label" in input ? input.label : input.path ?? "Changes", text, version: "sha256:" + "0".repeat(64), ...("path" in input && input.path ? { path: input.path } : {}) };
      } else {
        const handle = await client.command("annotations.capture", { source: input });
        source = (await waitReceipt<{ result: { source: AnnotationSource } }>(client, handle.requestId)).result.source;
      }
      if (epoch !== generation.current) return;
      const previous = bundleRef.current;
      const old = previous.sources.find(item => item.id === source.id);
      // Changed captures keep old anchors separate instead of silently moving notes.
      if (old && old.version !== source.version) source = { ...source, id: source.id + ":" + id() };
      commit({ ...previous, revision: previous.revision + 1, sources: [...previous.sources.filter(item => item.id !== source.id), source] });
      setSelected(source.id); setSelection(undefined); setDraft(""); setEditing(undefined);
    });
  }, [client, preview, sessionId, runtimeSessionId, run, commit]);
  const actions = useMemo<AnnotationActions>(() => ({ capture, open: () => setOpen(true), openSaved: artifactId => {
    setOpen(true); void run(async epoch => {
      if (preview) { commit(structuredClone(PREVIEW_ANNOTATION_BUNDLE)); setSelected("demo-source"); setNotice("Demo snapshot"); return; }
      const value = await client.query("artifacts.text.read", { artifactId });
      const parsed: unknown = JSON.parse(value.text); validateAnnotationBundle(parsed);
      if (epoch !== generation.current) return;
      commit(parsed); setSelected(parsed.sources[0]?.id); setDraft(""); setEditing(undefined);
    });
  } }), [capture, client, preview, run, commit]);
  const source = bundle.sources.find(item => item.id === selected) ?? bundle.sources[0];
  const sourceNotes = bundle.notes.filter(note => note.sourceId === source?.id);
  const saveNote = () => {
    if (!source || !draft.trim()) return;
    const note: AnnotationNote = { id: editing ?? id(), sourceId: source.id, note: draft.trim(), ...(selection ? { selection } : {}) };
    try { commit({ ...bundle, revision: bundle.revision + 1, notes: [...bundle.notes.filter(item => item.id !== note.id), note] }); setDraft(""); setEditing(undefined); setSelection(undefined); }
    catch (cause) { setError(hostErrorMessage(cause, "Invalid annotation")); }
  };
  const prepare = (action: "feedback" | "review") => void run(async epoch => {
    let prompt: string;
    if (preview) prompt = "[演示标注 / Demo annotations]\n" + bundle.notes.map(note => note.note).join("\n\n");
    else {
      const handle = await client.command("annotations.prepare", { sources: bundle.sources, notes: bundle.notes, action, allowStale });
      const { result } = await waitReceipt<{ result: { prompt: string; staleSources: string[] } }>(client, handle.requestId);
      if (epoch !== generation.current) return;
      setStale(result.staleSources); if (!result.prompt) return; prompt = result.prompt;
    }
    onInsert(prompt); setOpen(false);
  });
  return <Context.Provider value={actions}>{children}
    {open ? <div className="annotation-backdrop" role="presentation"><section className="annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-title" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key === "Tab") {
        const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')].filter(node => node.getClientRects().length > 0);
        const first = nodes[0]; const last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><h2 id="annotation-title">{zh ? "标注" : "Annotations"}{preview ? zh ? " · 演示" : " · Demo" : ""}</h2><span className="small muted">{bundle.notes.length} / 128 · v{bundle.revision}</span><span className="spacer" /><button className="btn small" disabled={!undo.length || busy} onClick={() => { const previous = undo.at(-1); if (!previous) return; setUndo(stack => stack.slice(0, -1)); bundleRef.current = previous; setBundle(previous); setDraft(""); setEditing(undefined); if (!preview) { try { localStorage.setItem(key, JSON.stringify(previous)); } catch {} } }}>{zh ? "撤销" : "Undo"}</button><button ref={closeRef} className="icon-btn" aria-label={zh ? "关闭标注" : "Close annotations"} onClick={() => setOpen(false)}><Icon name="x" /></button></header>
      <div className="annotation-toolbar"><input className="input mono" aria-label={zh ? "工作区相对文件路径" : "Workspace-relative file"} placeholder="src/app.ts" value={path} onChange={event => setPath(event.target.value)} /><button className="btn small outline" disabled={busy || !path.trim()} onClick={() => capture({ kind: "file", path: path.trim() })}>{zh ? "打开文件" : "Open file"}</button><button className="btn small outline" disabled={busy} onClick={() => capture({ kind: "diff", ...(path.trim() ? { path: path.trim() } : {}) })}>{zh ? "当前改动" : "Current changes"}</button></div>
      {busy ? <p role="status" className="small muted" style={{ padding: "0 18px" }}>{zh ? "正在准备来源或标注…" : "Preparing source or annotations…"}</p> : null}
      {error ? <p role="alert" className="annotation-error">{error}</p> : null}{notice ? <p role="status" className="small">{notice}</p> : null}
      <div className="annotation-layout"><div className="annotation-source">
        <select className="select" aria-label={zh ? "标注来源" : "Annotation source"} value={source?.id ?? ""} onChange={event => { setSelected(event.target.value); setSelection(undefined); setDraft(""); setEditing(undefined); }}><option value="" disabled>{zh ? "选择来源" : "Choose source"}</option>{bundle.sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        {source ? <button className="btn small" disabled={busy} onClick={() => { commit({ ...bundle, revision: bundle.revision + 1, sources: bundle.sources.filter(item => item.id !== source.id), notes: bundle.notes.filter(note => note.sourceId !== source.id) }); setSelected(undefined); setSelection(undefined); setDraft(""); setEditing(undefined); }}>{zh ? "移除此来源及标注" : "Remove source and annotations"}</button> : null}
        {source ? <><p className="small mono muted">{source.kind} · {source.version.slice(0, 23)}…</p><textarea className="annotation-source-text mono" aria-label={zh ? "来源快照，可选择文本" : "Source snapshot; select text to annotate"} readOnly value={source.text} onSelect={event => { const area = event.currentTarget; setSelection(area.selectionStart === area.selectionEnd ? undefined : { start: area.selectionStart, end: area.selectionEnd }); }} />{(source.kind === "file" || source.kind === "diff") ? <button className="btn small" disabled={busy} onClick={() => capture(source.kind === "file" ? { kind: "file", path: source.path! } : { kind: "diff", ...(source.path ? { path: source.path } : {}) })}>{zh ? "重新捕获版本（保留旧标注）" : "Capture new version (keep old annotations)"}</button> : null}</> : <p className="muted">{zh ? "从回复旁的标注按钮开始，或打开文件、改动、粘贴文本。" : "Annotate a reply, open a file or changes, or paste text."}</p>}
        <details><summary>{zh ? "粘贴文本 / 选区" : "Paste text / selection"}</summary><textarea className="input" aria-label={zh ? "粘贴来源文本" : "Paste source text"} rows={4} value={paste} maxLength={120000} onChange={event => setPaste(event.target.value)} /><button className="btn small" disabled={busy || !paste.trim()} onClick={() => { capture({ kind: "quote", label: zh ? "粘贴文本" : "Pasted text", text: paste }); setPaste(""); }}>{zh ? "添加来源" : "Add source"}</button></details>
      </div><div className="annotation-notes">
        <p className="small muted">{selection ? `${zh ? "选区" : "Selection"}: ${selection.start}–${selection.end}` : zh ? "整份来源" : "Whole source"}</p>
        {selection && source ? <blockquote>{source.text.slice(selection.start, selection.end).slice(0, 400)}</blockquote> : null}
        <textarea className="input" aria-label={zh ? "标注意见" : "Annotation note"} value={draft} maxLength={8000} rows={4} onChange={event => setDraft(event.target.value)} />
        <button className="btn small primary" disabled={busy || !source || !draft.trim()} onClick={saveNote}>{editing ? zh ? "保存编辑" : "Save edit" : zh ? "添加标注" : "Add annotation"}</button>
        {sourceNotes.map(note => <article className="annotation-note" key={note.id}>{note.selection && source ? <blockquote>{source.text.slice(note.selection.start, note.selection.end).slice(0, 400)}</blockquote> : null}<p>{note.note}</p><button className="btn small" onClick={() => { setEditing(note.id); setDraft(note.note); setSelection(note.selection); }}>{zh ? "编辑" : "Edit"}</button><button className="btn small" onClick={() => commit({ ...bundle, revision: bundle.revision + 1, notes: bundle.notes.filter(item => item.id !== note.id) })}>{zh ? "删除" : "Delete"}</button></article>)}
      </div></div>
      {stale.length ? <div className="annotation-stale" role="alert"><p>{zh ? "来源已改变或不属于当前会话。可重新捕获，也可明确使用保存的旧快照。" : "Sources changed or belong to another session. Capture a new version, or explicitly use the saved snapshot."}</p><p className="small">{bundle.sources.filter(item => stale.includes(item.id)).map(item => item.label).join(" · ")}</p><label><input type="checkbox" checked={allowStale} onChange={event => setAllowStale(event.target.checked)} />{zh ? "使用捕获的旧版本" : "Use the captured versions"}</label></div> : null}
      <footer><span className="small muted">{zh ? "先放入主对话输入框，由你发送。" : "Prepared text goes to the main conversation Composer for you to send."}</span><span className="spacer" /><button className="btn small outline" disabled={busy || !bundle.sources.length} onClick={() => void run(async epoch => {
        if (preview) { setNotice(zh ? "演示：已保存快照" : "Demo: snapshot saved"); return; }
        const value = { ...bundle, ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) };
        const handle = await client.command("artifacts.saveText", { kind: "annotation", name: `annotations-v${bundle.revision}.json`, text: JSON.stringify(value, null, 2), ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) });
        await waitReceipt(client, handle.requestId); if (epoch === generation.current) setNotice(zh ? "快照已存入产物库" : "Snapshot saved to artifact library");
      })}>{zh ? "保存快照" : "Save snapshot"}</button><button className="btn small outline" disabled={busy || !bundle.notes.length} onClick={() => prepare("review")}>{zh ? "准备审查" : "Prepare review"}</button><button className="btn small primary" disabled={busy || !bundle.notes.length} onClick={() => prepare("feedback")}>{zh ? "放入输入框" : "Insert feedback"}</button></footer>
    </section></div> : null}
  </Context.Provider>;
}

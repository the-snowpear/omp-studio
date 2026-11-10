import {
  createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import {
  validateAnnotationBundle, type AnnotationBundle, type AnnotationCapture, type AnnotationSource,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import { PREVIEW_ANNOTATION_FILE, PREVIEW_ANNOTATION_DIFF, PREVIEW_ANNOTATION_BUNDLE } from "../preview/annotationsPreview";
import { lazyPanel } from "../DeferredPanel";
import { DockPanel, useDockEngine } from "../dock/DockContext";
import { locatePanel } from "../dock/model";
const AnnotationDialog = lazyPanel(() => import("./AnnotationDialog").then(module => ({ default: module.AnnotationDialog })));
import "./annotations.css";

interface AnnotationActions {
  capture(source: AnnotationCapture): void;
  open(): void;
  openSaved(artifactId: string): void;
}
const Context = createContext<AnnotationActions | null>(null);
const empty = (): AnnotationBundle => ({ schemaVersion: 1, revision: 1, sources: [], notes: [] });
const id = () => crypto.randomUUID();

export function AnnotationButton({ source, label, className, small = false, iconOnly = false, menu = false, onActivate }: {
  source?: AnnotationCapture;
  label?: string;
  className?: string;
  small?: boolean;
  iconOnly?: boolean;
  menu?: boolean;
  onActivate?: () => void;
}) {
  const actions = useContext(Context);
  const { resolvedLanguage } = useI18n();
  if (!actions) return null;
  const title = label ?? (resolvedLanguage === "zh" ? "标注" : "Annotate");
  return <button type="button" role={menu ? "menuitem" : undefined}
    className={className ?? (menu ? "menu-item" : iconOnly ? "icon-btn" : small ? "ev-msg-copy" : "btn small outline")}
    aria-label={title} data-tip={title} onMouseDown={event => event.preventDefault()}
    onClick={event => {
      event.stopPropagation();
      const selected = event.currentTarget.ownerDocument.getSelection(), quote = selected?.toString();
      if (source?.kind === "message" && quote?.trim() && source.text.includes(quote) && selected?.anchorNode
        && event.currentTarget.closest(".ev-copy-host")?.contains(selected.anchorNode)) {
        actions.capture({ ...source, kind: "quote", text: quote, label: source.label + " · selection" });
      } else if (source) actions.capture(source);
      else actions.open();
      onActivate?.();
    }}><Icon name="pencil" extra={iconOnly ? "" : "sm"} />{small || iconOnly ? null : title}</button>;
}

export function OpenAnnotationArtifact({ artifactId }: { artifactId: string }) {
  const actions = useContext(Context);
  const { resolvedLanguage } = useI18n();
  return actions ? <button className="btn small" onClick={() => actions.openSaved(artifactId)}>
    {resolvedLanguage === "zh" ? "打开标注" : "Open annotations"}
  </button> : null;
}

export function AnnotationsProvider({ children, client, workspaceId, sessionId, runtimeSessionId, onInsert }: {
  children: ReactNode;
  client: StudioClient;
  workspaceId?: string | undefined;
  sessionId?: string | undefined;
  runtimeSessionId?: string | undefined;
  onInsert(text: string): void;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [bundle, setBundle] = useState<AnnotationBundle>(empty);
  const bundleRef = useRef(bundle); bundleRef.current = bundle;
  const { store } = useDockEngine();
  const open = useSyncExternalStore(store.subscribe, () => !!locatePanel(store.getSnapshot().layout, "annotations"));
  const openWindow = useCallback(() => store.dispatch({ type: "open", panel: "annotations" }), [store]);
  const closeWindow = () => store.dispatch({ type: "hide", panels: ["annotations"] });
  const [selected, setSelected] = useState<string>();
  const [undo, setUndo] = useState<AnnotationBundle[]>([]);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState<string[]>([]);
  const [allowStale, setAllowStale] = useState(false);
  const generation = useRef(0), busyRef = useRef(false);
  const key = "omp.annotations.v1:" + encodeURIComponent(workspaceId ?? "none") + ":" + encodeURIComponent(sessionId ?? "draft");

  useEffect(() => {
    generation.current++;
    busyRef.current = false;
    setBusy(false); setSelected(undefined); setUndo([]);
    setStale([]); setAllowStale(false); setError(""); setNotice("");
    let next = empty();
    if (!preview) {
      try {
        const raw = localStorage.getItem(key);
        if (raw && raw.length <= 800000) {
          const value: unknown = JSON.parse(raw); validateAnnotationBundle(value); next = value;
        }
      } catch {
        setError(zh ? "标注草稿不可读；保存的快照仍在产物库。" : "The local draft is unreadable; saved snapshots remain in the artifact library.");
      }
    }
    bundleRef.current = next; setBundle(next);
    return () => { generation.current++; };
  }, [key, preview]);

  const commit = useCallback((next: AnnotationBundle) => {
    validateAnnotationBundle(next);
    const previous = bundleRef.current;
    setUndo(stack => [...stack.slice(-19), previous]);
    bundleRef.current = next; setBundle(next);
    setStale([]); setAllowStale(false); setNotice("");
    if (!preview) {
      try { localStorage.setItem(key, JSON.stringify(next)); }
      catch { setError(zh ? "本机草稿空间已满，请将快照保存到产物库。" : "Local draft storage is full. Save a snapshot to the artifact library."); }
    }
  }, [key, preview, zh]);

  const run = useCallback(async (action: (epoch: number) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    const epoch = generation.current;
    try { await action(epoch); }
    catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Annotation operation failed")); }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  }, []);

  const capture = useCallback((input: AnnotationCapture) => {
    openWindow();
    if (busyRef.current) {
      setError(zh ? "请等当前标注操作完成。" : "Wait for the current annotation operation to finish.");
      return;
    }
    void run(async epoch => {
      if (!preview && (input.kind === "file" || input.kind === "diff") && sessionId && sessionId !== runtimeSessionId) {
        throw new Error(zh ? "请打开当前运行会话后标注工作区文件；历史回复仍可按快照标注。" : "Open the active session to annotate workspace files. Historical replies can be annotated as snapshots.");
      }
      if ((input.kind === "message" || input.kind === "quote") && !input.sessionId && sessionId) input = { ...input, sessionId };
      let source: AnnotationSource;
      if (preview) {
        const text = "text" in input ? input.text : input.kind === "diff" ? PREVIEW_ANNOTATION_DIFF : PREVIEW_ANNOTATION_FILE;
        source = {
          id: "demo-" + id(), kind: input.kind,
          label: "label" in input ? input.label : input.path ?? (zh ? "当前改动" : "Current changes"),
          text, version: "sha256:" + "0".repeat(64),
          ...("path" in input && input.path ? { path: input.path } : {}),
        };
      } else {
        const handle = await client.command("annotations.capture", { source: input });
        source = (await waitReceipt<{ result: { source: AnnotationSource } }>(client, handle.requestId)).result.source;
      }
      if (epoch !== generation.current) return;
      const previous = bundleRef.current;
      const identical = previous.sources.find(item => item.kind === source.kind && item.label === source.label
        && item.path === source.path && item.messageId === source.messageId && item.sessionId === source.sessionId
        && item.version === source.version && item.text === source.text);
      if (identical) { setSelected(identical.id); return; }
      const old = previous.sources.find(item => item.id === source.id);
      // Changed captures keep old anchors separate instead of silently moving notes.
      if (old && old.version !== source.version) source = { ...source, id: source.id + ":" + id() };
      commit({ ...previous, revision: previous.revision + 1,
        sources: [...previous.sources.filter(item => item.id !== source.id), source] });
      setSelected(source.id);
    });
  }, [client, preview, sessionId, runtimeSessionId, run, commit, zh, openWindow]);

  const actions = useMemo<AnnotationActions>(() => ({
    capture,
    open: openWindow,
    openSaved: artifactId => {
      openWindow();
      void run(async epoch => {
        if (preview) {
          commit(structuredClone(PREVIEW_ANNOTATION_BUNDLE)); setSelected("demo-source"); setEditorEpoch(value => value + 1);
          if (marks) setNotice(zh ? "演示快照" : "Demo snapshot");
          return;
        }
        const value = await client.query("artifacts.text.read", { artifactId });
        const parsed: unknown = JSON.parse(value.text); validateAnnotationBundle(parsed);
        if (epoch !== generation.current) return;
        commit(parsed); setSelected(parsed.sources[0]?.id); setEditorEpoch(value => value + 1);
      });
    },
  }), [capture, client, marks, preview, run, commit, zh, openWindow]);

  const undoChange = () => {
    const previous = undo.at(-1);
    if (!previous || busyRef.current) return;
    setUndo(stack => stack.slice(0, -1)); bundleRef.current = previous; setBundle(previous);
    setStale([]); setAllowStale(false); setNotice("");
    if (!preview) { try { localStorage.setItem(key, JSON.stringify(previous)); } catch {} }
  };
  const prepare = (action: "feedback" | "review") => void run(async epoch => {
    let prompt: string;
    if (preview) {
      const feedback = bundle.notes.map(note => {
        const source = bundle.sources.find(item => item.id === note.sourceId)!;
        const quote = note.selection ? source.text.slice(note.selection.start, note.selection.end) : "";
        return `### ${source.label}\n${quote ? "> " + quote.split("\n").join("\n> ") + "\n\n" : ""}${note.note}`;
      }).join("\n\n");
      prompt = (marks ? "[演示标注 / Demo annotations]\n" : "")
        + (action === "review" ? zh ? "请独立审查以下改动，并验证标注中的关注点。\n\n" : "Review the changes independently and verify the annotated concerns.\n\n" : "") + feedback;
    } else {
      const handle = await client.command("annotations.prepare", { sources: bundle.sources, notes: bundle.notes, action, allowStale });
      const { result } = await waitReceipt<{ result: { prompt: string; staleSources: string[] } }>(client, handle.requestId);
      if (epoch !== generation.current) return;
      setStale(result.staleSources);
      if (!result.prompt) return;
      prompt = result.prompt;
    }
    if (epoch !== generation.current) return;
    onInsert(prompt); closeWindow();
  });
  const saveSnapshot = () => void run(async epoch => {
    if (preview) { if (marks) setNotice(zh ? "演示：已保存快照" : "Demo: snapshot saved"); return; }
    const value = { ...bundle, ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) };
    const handle = await client.command("artifacts.saveText", {
      kind: "annotation", name: `annotations-v${bundle.revision}.json`, text: JSON.stringify(value, null, 2),
      ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}),
    });
    await waitReceipt(client, handle.requestId);
    if (epoch === generation.current) setNotice(zh ? "快照已存入产物库" : "Snapshot saved to artifact library");
  });

  return <Context.Provider value={actions}>
    {children}
    <DockPanel id="annotations">{visibility => <Suspense fallback={<div className="annotation-loading-card"><Icon name="pencil" /><p role="status">{zh ? "正在打开标注…" : "Opening annotations…"}</p><button type="button" className="btn" onClick={closeWindow}>{zh ? "取消" : "Cancel"}</button></div>}>
      <AnnotationDialog key={key + (preview ? ":preview" : ":real")} open={open && visibility.visible} bundle={bundle} selected={selected}
        busy={busy} error={error} notice={notice} stale={stale} allowStale={allowStale} canUndo={!!undo.length}
        draftKey={key} editorEpoch={editorEpoch} preview={preview} marks={marks}
        onSelect={setSelected} onCapture={capture} onCommit={commit} onUndo={undoChange}
        onClose={closeWindow} onPrepare={prepare} onSaveSnapshot={saveSnapshot} onAllowStale={setAllowStale} />
    </Suspense>}</DockPanel>
  </Context.Provider>;
}

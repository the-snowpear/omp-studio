import { useSurfaceDocument } from "../dock/SurfaceContext";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FilePanelDescriptor } from "../dock/types";
import type { FileResource } from "../../../desktop/src/file-viewer-shared";
import { MarkdownText } from "../conversation/markdown";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile, previewFileBlob } from "../preview/filesPreview";
import { FileReferenceContext, FileImageContext } from "./fileLinks";
import { fileKind, relativeFileReference, textEditable, type FileReference } from "./fileTypes";
import type { FileDocument } from "./fileDocuments";
import { OfficePane } from "./OfficePane";

const TextEditor = lazy(() => import("./FileTextEditor"));
const PdfPane = lazy(() => import("./PdfPane"));
const SpreadsheetPane = lazy(() => import("./SpreadsheetPane"));
export default function FilePane({ id, descriptor, session, visible, onSettings, onOpen, onViewState }: { id: string; descriptor: FilePanelDescriptor; session: FileDocument; visible: boolean; onSettings: () => void; onOpen: (reference: FileReference) => void; onViewState: (patch: Partial<FilePanelDescriptor>) => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot), { preview, marks } = usePreviewMode();
  const kind = fileKind(descriptor.path), editable = textEditable(descriptor.path);
  const [resource, setResource] = useState<FileResource | null>(null), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const [mode, setMode] = useState(descriptor.mode ?? (kind === "markdown" || kind === "spreadsheet" ? "preview" : "source"));
  useEffect(() => { session.setVisible(id, visible); if (visible) void session.refresh(); return () => session.setVisible(id, false); }, [id, session, visible]);
  useEffect(() => { if (editable && !state.loaded) void session.load(); }, [session, editable, state.file.version]);
  useEffect(() => {
    let active = true, lease: string | undefined, blob: string | undefined;
    setError(""); setResource(null);
    if (preview) {
      const fixture = previewFile(descriptor.path, descriptor.workspaceId);
      void previewFileBlob(fixture).then(sample => { if (sample && active) { blob = URL.createObjectURL(sample); setResource({ id: "demo", url: blob, file: fixture }); } }).catch(error => { if (active) setError(String(error)); });
    } else if (globalThis.ompStudioChrome?.files) {
      void globalThis.ompStudioChrome.files.open({ targetId: descriptor.targetId, workspaceId: descriptor.workspaceId, path: descriptor.path }).then(result => { lease = result.id; if (active) setResource(result); else void globalThis.ompStudioChrome?.files?.release(result.id); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    } else setError("此连接没有桌面文件资源通道");
    return () => { active = false; if (lease) void globalThis.ompStudioChrome?.files?.release(lease); if (blob) URL.revokeObjectURL(blob); };
  }, [descriptor.path, descriptor.targetId, descriptor.workspaceId, state.file.version, preview, reload]);
  const [csvUrl, setCsvUrl] = useState<string>();
  useEffect(() => { if (kind !== "spreadsheet" || !editable || !state.loaded || mode !== "preview") return; const url = URL.createObjectURL(new Blob([state.text], { type: "text/csv" })); setCsvUrl(url); return () => URL.revokeObjectURL(url); }, [kind, editable, mode, state.text, state.loaded]);
  const source = resource?.url;
  const changeMode = (next: "preview" | "source") => { setMode(next); onViewState({ mode: next }); };
  return <section className="file-pane" aria-label={descriptor.title}>
    <div className="file-toolbar"><span className="file-path" data-tip={descriptor.path}>{descriptor.path}</span>{preview && marks ? <span className="file-demo">演示</span> : null}
      {editable ? <button className="btn small primary" disabled={!state.dirty || state.saving || !state.file.writable} onClick={() => { void session.save(); }}>{state.saving ? "保存中…" : "保存"}</button> : null}
      {editable && ["markdown", "spreadsheet"].includes(kind) ? <><button className={`btn small ${mode === "preview" ? "primary" : "outline"}`} onClick={() => changeMode("preview")}>预览</button><button className={`btn small ${mode === "source" ? "primary" : "outline"}`} onClick={() => changeMode("source")}>源码</button></> : null}
      <button className="btn small outline" onClick={() => { if (editable && !state.dirty) void session.load(); else void session.refresh(); setReload(value => value + 1); }}>刷新</button>
      {!preview ? <button className="btn small outline" onClick={() => { void globalThis.ompStudioChrome?.files?.export({ targetId: descriptor.targetId, workspaceId: descriptor.workspaceId, path: descriptor.path }).catch(error => setError(String(error))); }}>下载</button> : null}
      {!preview && !descriptor.targetId ? <button className="btn small outline" onClick={() => { void globalThis.ompStudioChrome?.openFile?.({ workspaceId: descriptor.workspaceId, path: descriptor.path, kind: "file" }).catch(error => setError(String(error))); }}>系统打开</button> : null}
    </div>
    {state.external ? <div className="file-conflict" role="status"><span>磁盘文件已变化，本地修改已保留。</span><button className="btn small outline" onClick={() => { void session.compare(); }}>比较</button><button className="btn small outline" onClick={() => { void session.load(true); }}>重新加载</button><button className="btn small outline" onClick={() => { void session.save(true); }}>用本地修改覆盖</button></div> : null}
    {error || state.error ? <p className="file-error" role="alert">{error || state.error}</p> : null}
    <div className="file-content"><Suspense fallback={<div className="file-empty">正在加载查看器…</div>}>
      {editable && (mode === "source" || kind === "text") ? state.loaded ? <TextEditor viewId={id} session={session} descriptor={descriptor} onViewState={onViewState} readOnly={!state.file.writable} /> : <div className="file-empty">{state.loading ? "正在读取文本…" : "无法读取此文件"}</div>
        : kind === "markdown" ? <FileReferenceContext.Provider value={reference => onOpen({ ...reference, path: relativeFileReference(descriptor.path, reference.path) })}><FileImageContext.Provider value={{ targetId: descriptor.targetId, workspaceId: descriptor.workspaceId, basePath: descriptor.path, preview }}><div className="file-markdown"><MarkdownText text={state.text} /></div></FileImageContext.Provider></FileReferenceContext.Provider>
        : kind === "office" ? <OfficePane resource={resource} preview={preview} onSettings={onSettings} initialPage={descriptor.page} onPage={page => onViewState({ page })} />
        : kind === "pdf" && source ? <PdfPane url={source} initialPage={descriptor.page} onPage={page => onViewState({ page })} />
        : kind === "image" && source ? <ImagePane url={source} name={descriptor.title} />
        : (kind === "audio" || kind === "video") && source ? <MediaPane kind={kind} url={source} visible={visible} time={descriptor.time} onTime={time => onViewState({ time })} />
        : kind === "spreadsheet" && (csvUrl || source) ? <SpreadsheetPane url={csvUrl || source!} />
        : <div className="file-empty">{error ? "可重新加载或下载后用系统应用打开" : "正在读取文件…"}</div>}
      {state.diskText !== undefined ? <div className="file-disk-comparison"><header>磁盘版本（只读）<button className="btn small outline" onClick={() => session.hideComparison()}>关闭比较</button><button className="btn small outline" onClick={() => { void session.load(true); }}>采用磁盘版本</button></header><TextEditor session={session} descriptor={descriptor} value={state.diskText} onViewState={() => {}} readOnly /></div> : null}
    </Suspense></div>
  </section>;
}
function ImagePane({ url, name }: { url: string; name: string }) {
  const [scale, setScale] = useState<number | null>(null), [rotation, setRotation] = useState(0);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  return <div className="file-image"><div className="file-toolbar"><button className="btn small outline" onClick={() => setScale(null)}>适应窗口</button><button className="btn small outline" onClick={() => setScale(1)}>100%</button><button className="btn small outline" onClick={() => setScale(value => Math.max(0.1, (value ?? 1) / 1.25))}>−</button><button className="btn small outline" onClick={() => setScale(value => Math.min(8, (value ?? 1) * 1.25))}>＋</button><button className="btn small outline" onClick={() => setRotation(value => value + 90)}>旋转</button></div><div className="file-image-canvas" ref={viewport} onPointerDown={event => { const element = viewport.current!; drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }; element.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current && viewport.current) { viewport.current.scrollLeft = drag.current.left - event.clientX + drag.current.x; viewport.current.scrollTop = drag.current.top - event.clientY + drag.current.y; } }} onPointerUp={() => { drag.current = null; }}><img src={url} alt={name} draggable={false} style={{ maxWidth: scale === null ? "100%" : "none", maxHeight: scale === null ? "100%" : "none", zoom: scale ?? 1, transform: `rotate(${rotation}deg)` }} /></div></div>;
}
function MediaPane({ kind, url, visible, time = 0, onTime }: { kind: "audio" | "video"; url: string; visible: boolean; time?: number | undefined; onTime: (time: number) => void }) {
  const surface = useSurfaceDocument();
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null), [error, setError] = useState("");
  const latest = useRef(onTime); latest.current = onTime;
  useEffect(() => { if (!visible) ref.current?.pause(); }, [visible]);
  useEffect(() => { const change = () => { if (surface.visibilityState === "hidden") ref.current?.pause(); }; surface.addEventListener("visibilitychange", change); return () => surface.removeEventListener("visibilitychange", change); }, [surface]);
  useEffect(() => { const element = ref.current; return () => { element?.pause(); }; }, []);
  const Tag = kind === "video" ? "video" : "audio";
  return <div className="file-media"><Tag ref={ref} src={url} controls preload="metadata" onLoadedMetadata={() => { if (ref.current) ref.current.currentTime = time; }} onPause={() => latest.current(ref.current?.currentTime ?? 0)} onSeeked={() => latest.current(ref.current?.currentTime ?? 0)} onError={() => setError("当前播放器不能解码此媒体。请下载或使用系统应用打开。")} />{error ? <p className="file-error" role="alert">{error}</p> : null}</div>;
}

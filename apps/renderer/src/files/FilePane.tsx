import { useSurfaceDocument } from "../dock/SurfaceContext";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkspaceId } from "@omp-studio/client-contract";
import type { FilePanelDescriptor, FileViewMode } from "../dock/types";
import type { FileResource } from "../../../desktop/src/file-viewer-shared";
import { MarkdownText } from "../conversation/markdown";
import { GitPatch } from "../git/GitPatch";
import { DiffDisplayMode } from "../conversation/ChangesPanel";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { fileManagerName } from "../platformCopy";
import type { FileMenuAction } from "../menus";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile, previewFileBlob, previewFilePatch } from "../preview/filesPreview";
import { FileReferenceContext, FileImageContext } from "./fileLinks";
import { fileBadge, fileKind, formatBytes, relativeFileReference, textEditable, type FileReference } from "./fileTypes";
import type { FileDocument } from "./fileDocuments";
import type { FileViewerActions } from "./fileActions";
import { DEFAULT_EDITOR_PREFS, readEditorPrefs, saveEditorPrefs, subscribeEditorPrefs } from "./filePreferences";
import { EMPTY_MARKS, parsePatchMarks } from "./gitMarks";
import { FileHeader, MOD_KEY, type FileMenuEntry, type FileModeOption, type FileTool } from "./FileHeader";
import { FileStatusBar } from "./FileStatusBar";
import type { EditorCommands, EditorController, EditorCursor } from "./FileTextEditor";
import { OfficePane } from "./OfficePane";

const TextEditor = lazy(() => import("./FileTextEditor"));
const PdfPane = lazy(() => import("./PdfPane"));
const SpreadsheetPane = lazy(() => import("./SpreadsheetPane"));
const SPLIT_MIN_WIDTH = 640, NARROW_WIDTH = 560;

export default function FilePane({ id, descriptor, session, visible, onSettings, onOpen, onViewState, actions }: { id: string; descriptor: FilePanelDescriptor; session: FileDocument; visible: boolean; onSettings: () => void; onOpen: (reference: FileReference) => void; onViewState: (patch: Partial<FilePanelDescriptor>) => void; actions?: FileViewerActions | undefined }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot), { preview, marks } = usePreviewMode();
  const { t } = useI18n(), surface = useSurfaceDocument();
  const kind = fileKind(descriptor.path), editable = textEditable(descriptor.path), badge = fileBadge(descriptor.path);
  const surfaceVisible = useSyncExternalStore(useCallback(notify => { surface.addEventListener("visibilitychange", notify); return () => surface.removeEventListener("visibilitychange", notify); }, [surface]), useCallback(() => surface.visibilityState !== "hidden", [surface]));
  const active = visible && surfaceVisible, needsResource = !editable || kind === "spreadsheet" && !state.loaded;
  const [resource, setResource] = useState<FileResource | null>(null), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const [mode, setMode] = useState<FileViewMode>(descriptor.mode ?? (kind === "markdown" || kind === "spreadsheet" ? "preview" : "source"));
  const prefs = useSyncExternalStore(subscribeEditorPrefs, () => readEditorPrefs(preview));
  const [cursor, setCursor] = useState<EditorCursor | null>(null), [info, setInfo] = useState("");
  const [patch, setPatch] = useState(""), [splitDiff, setSplitDiff] = useState(false);
  const [notice, setNotice] = useState(""), [width, setWidth] = useState(900);
  const controller = useRef<EditorController | null>(null), pane = useRef<HTMLElement>(null), markdownRef = useRef<HTMLDivElement>(null), followingPreview = useRef(false);
  useEffect(() => { session.setVisible(id, active); if (active) void session.refresh(); return () => session.setVisible(id, false); }, [id, session, active]);
  useEffect(() => { if (active && editable && !state.loaded) void session.load(); }, [session, editable, state.file.version, active]);
  useEffect(() => {
    setError(""); setResource(null);
    if (!active || !needsResource) return;
    let alive = true, lease: string | undefined, blob: string | undefined;
    if (preview) {
      const fixture = previewFile(descriptor.path, descriptor.workspaceId);
      void previewFileBlob(fixture).then(sample => { if (sample && alive) { blob = URL.createObjectURL(sample); setResource({ id: "demo", url: blob, file: { ...fixture, size: sample.size } }); } }).catch(error => { if (alive) setError(String(error)); });
    } else if (globalThis.ompStudioChrome?.files) {
      void globalThis.ompStudioChrome.files.open({ targetId: descriptor.targetId, workspaceId: descriptor.workspaceId, path: descriptor.path }).then(result => { lease = result.id; if (alive) setResource(result); else void globalThis.ompStudioChrome?.files?.release(result.id); }).catch(error => { if (alive) setError(error instanceof Error ? error.message : String(error)); });
    } else setError("此连接没有桌面文件资源通道");
    return () => { alive = false; if (lease) void globalThis.ompStudioChrome?.files?.release(lease); if (blob) URL.revokeObjectURL(blob); };
  }, [descriptor.path, descriptor.targetId, descriptor.workspaceId, state.file.version, preview, reload, active, needsResource]);
  // Working-tree patch for the gutter and Diff view; a non-repository or failed query simply shows nothing.
  useEffect(() => {
    if (!active) return;
    if (!editable) { setPatch(""); return; }
    if (preview) { setPatch(previewFilePatch(descriptor.path)); return; }
    let alive = true;
    void session.client().then(client => client.query("git.diff.get", { workspaceId: descriptor.workspaceId as WorkspaceId, path: state.file.path, target: "working" }))
      .then(result => { if (alive) setPatch(result.binary ? "" : result.patch); }, () => { if (alive) setPatch(""); });
    return () => { alive = false; };
  }, [editable, preview, session, descriptor.path, descriptor.workspaceId, state.file.path, state.file.version, reload, active]);
  useEffect(() => { const element = pane.current; if (!element) return; const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); }); observer.observe(element); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 1800); return () => clearTimeout(timer); }, [notice]);
  const [csvUrl, setCsvUrl] = useState<string>();
  useEffect(() => { setCsvUrl(undefined); if (!active || kind !== "spreadsheet" || !editable || !state.loaded || mode !== "preview") return; const url = URL.createObjectURL(new Blob([state.text], { type: "text/csv" })); setCsvUrl(url); return () => URL.revokeObjectURL(url); }, [kind, editable, mode, state.text, state.loaded, active]);

  const source = resource?.url;
  const gitMarks = useMemo(() => patch ? parsePatchMarks(patch) : EMPTY_MARKS, [patch]);
  const git = gitMarks.additions || gitMarks.deletions ? { additions: gitMarks.additions, deletions: gitMarks.deletions } : null;
  const narrow = width < NARROW_WIDTH, canSplit = kind === "markdown" && width >= SPLIT_MIN_WIDTH;
  const fallback: FileViewMode = kind === "markdown" || kind === "spreadsheet" ? "preview" : "source";
  const view: FileViewMode = !editable ? "preview" : mode === "diff" ? (git ? "diff" : fallback) : mode === "split" ? (canSplit ? "split" : "preview") : kind === "text" ? "source" : mode;
  const showsEditor = editable && state.loaded && (view === "source" || view === "split");
  const changeMode = (next: FileViewMode) => { setMode(next); onViewState({ mode: next }); };
  const modes: FileModeOption[] | null = !editable ? null : [
    ...(kind === "markdown" ? [{ id: "source", label: "源码", icon: "code" }, ...(canSplit ? [{ id: "split", label: "分栏", icon: "columns" }] : []), { id: "preview", label: "预览", icon: "eye" }] as FileModeOption[]
      : kind === "spreadsheet" ? [{ id: "preview", label: "表格", icon: "table" }, { id: "source", label: "源码", icon: "code" }] as FileModeOption[]
      : [{ id: "source", label: "编辑", icon: "code" }] as FileModeOption[]),
    ...(git ? [{ id: "diff", label: "Diff", icon: "diff" }] as FileModeOption[] : []),
  ];

  const name = state.file.name || descriptor.title, relativePath = state.file.path || descriptor.path;
  const copy = (text: string, done: string) => { void (surface.defaultView?.navigator.clipboard ?? navigator.clipboard).writeText(text).then(() => setNotice(done), () => setNotice("复制失败")); };
  const addContext = (lines?: readonly [number, number]) => { if (!actions) return; actions.addContext({ path: relativePath, label: name, lines }); setNotice(lines ? `已添加第 ${lines[0] === lines[1] ? lines[0] : `${lines[0]}–${lines[1]}`} 行到对话` : "已添加到对话"); };
  const desktopReason = preview ? "预览演示中不可用" : descriptor.targetId ? "远程文件请先下载，再用本机应用打开" : !actions || !globalThis.ompStudioChrome?.openFile ? "仅桌面工作台可用" : undefined;
  const shell = (action: FileMenuAction) => { if (!desktopReason) actions?.runShell(descriptor.workspaceId, action, { path: relativePath, name, kind: "file" }); };
  const setFont = (delta: number | null) => saveEditorPrefs({ fontSize: delta === null ? DEFAULT_EDITOR_PREFS.fontSize : prefs.fontSize + delta }, preview);
  const toggleWrap = () => saveEditorPrefs({ wrap: !prefs.wrap }, preview);
  const refresh = () => { if (editable && !state.dirty) void session.load(); else void session.refresh(); setReload(value => value + 1); };
  const commands: EditorCommands = {
    onCursor: setCursor, onReady: value => { controller.current = value; if (!value) setCursor(null); },
    onToggleWrap: toggleWrap, onFontSize: setFont, onCopy: text => copy(text, "已复制选区"),
    ...(actions ? { onAddSelection: (selection: { from: number; to: number }) => addContext([selection.from, selection.to]) } : {}),
  };

  const tools: FileTool[] = narrow ? [] : [
    ...(showsEditor ? [{ id: "search", icon: "search", tip: `查找 / 替换（${MOD_KEY} F）`, run: () => controller.current?.search() }, { id: "wrap", icon: "wrap", tip: `自动换行（Alt Z）`, active: prefs.wrap, run: toggleWrap }] as FileTool[] : []),
    { id: "refresh", icon: "refresh", tip: "从磁盘刷新", run: refresh },
  ];
  const menu: FileMenuEntry[] = [
    ...(narrow ? [
      ...(showsEditor ? [{ kind: "item", id: "search", label: "查找 / 替换", icon: "search", kbd: `${MOD_KEY} F`, run: () => controller.current?.search() }, { kind: "item", id: "wrap", label: prefs.wrap ? "关闭自动换行" : "自动换行", icon: "wrap", kbd: "Alt Z", run: toggleWrap }] as FileMenuEntry[] : []),
      { kind: "item", id: "refresh", label: "从磁盘刷新", icon: "refresh", run: refresh }, { kind: "sep", id: "s0" },
    ] as FileMenuEntry[] : []),
    { kind: "item", id: "copy-relative", label: t("shell.copyRelativePath"), icon: "copy", run: () => copy(relativePath, "已复制相对路径") },
    { kind: "item", id: "copy-absolute", label: t("shell.copyAbsolutePath"), icon: "copy", disabled: !!desktopReason, tip: desktopReason, run: () => shell({ type: "copyAbsolute" }) },
    ...(editable && state.loaded ? [{ kind: "item", id: "copy-content", label: "复制全部内容", icon: "file", run: () => copy(state.text, "已复制文件内容") }] as FileMenuEntry[] : []),
    { kind: "sep", id: "s1" },
    { kind: "item", id: "reveal", label: t("shell.fileRevealInExplorer", { fileManager: fileManagerName(t) }), icon: "folder-open", disabled: !!desktopReason, tip: desktopReason, run: () => shell({ type: "reveal" }) },
    { kind: "item", id: "open-system", label: "使用系统应用打开", icon: "external", disabled: !!desktopReason, tip: desktopReason, run: () => shell({ type: "openSystem" }) },
    ...(!desktopReason ? actions?.openers.map((opener): FileMenuEntry => ({ kind: "item", id: `open-${opener.id}`, label: `用 ${opener.name} 打开`, icon: "code", run: () => shell({ type: "openWith", openerId: opener.id }) })) ?? [] : []),
    { kind: "item", id: "download", label: "下载副本…", icon: "download", disabled: preview, tip: preview ? "预览演示中不可用" : undefined, run: () => { void globalThis.ompStudioChrome?.files?.export({ targetId: descriptor.targetId, workspaceId: descriptor.workspaceId, path: descriptor.path }).catch(error => setError(String(error))); } },
    { kind: "sep", id: "s2" },
    { kind: "item", id: "context", label: "添加到对话", icon: "at", disabled: !actions, tip: actions ? "在对话输入框插入文件引用" : "此窗口没有关联的对话", run: () => addContext() },
    ...(showsEditor && cursor?.selected ? [{ kind: "item", id: "context-selection", label: "添加选中行到对话", icon: "at", kbd: `${MOD_KEY} Shift L`, disabled: !actions, run: () => { const selection = controller.current?.selection(); if (selection) addContext([selection.from, selection.to]); } }] as FileMenuEntry[] : []),
    ...(showsEditor ? [{ kind: "sep", id: "s3" }, { kind: "zoom", id: "zoom", value: prefs.fontSize, onChange: setFont }] as FileMenuEntry[] : []),
  ];

  const markdown = useMemo(() => <FileReferenceContext.Provider value={reference => onOpen({ ...reference, path: relativeFileReference(descriptor.path, reference.path) })}><FileImageContext.Provider value={{ targetId: descriptor.targetId, workspaceId: descriptor.workspaceId, basePath: descriptor.path, preview }}><MarkdownText text={state.text} /></FileImageContext.Provider></FileReferenceContext.Provider>,
    // onOpen changes identity every render; links resolve against the path only, so the rendered tree stays memoized while scrolling.
    [state.text, descriptor.path, descriptor.targetId, descriptor.workspaceId, preview]);
  const editor = (onScrollRatio?: (ratio: number) => void) => state.loaded
    ? <TextEditor viewId={id} session={session} descriptor={descriptor} onViewState={onViewState} readOnly={!state.file.writable} wrap={prefs.wrap} fontSize={prefs.fontSize} gitMarks={gitMarks} commands={commands} onScrollRatio={onScrollRatio} />
    : <FileEmpty badge={badge} loading={state.loading} title={state.loading ? "正在读取文本…" : "无法读取此文件"} />;
  const followEditor = (ratio: number) => { const element = markdownRef.current; if (!element) return; const top = Math.round(ratio * (element.scrollHeight - element.clientHeight)); if (Math.abs(element.scrollTop - top) > 1) { followingPreview.current = true; element.scrollTop = top; } };
  const previewScroll = () => { if (followingPreview.current) { followingPreview.current = false; return; } const element = markdownRef.current; if (!element) return; const range = element.scrollHeight - element.clientHeight; controller.current?.scrollToRatio(range > 0 ? element.scrollTop / range : 0); };

  let body: ReactNode;
  if (!active && (view === "preview" || view === "diff")) body = null;
  else if (view === "diff") body = <div className="file-diff"><div className="file-subbar"><span className="file-subbar-title"><Icon name="diff" extra="sm" />工作区改动</span><span className="file-delta"><b className="add">+{gitMarks.additions}</b><b className="del">−{gitMarks.deletions}</b></span><span className="file-subbar-spacer" /><DiffDisplayMode split={splitDiff} onSplit={setSplitDiff} /></div><div className={`file-diff-body diff-scroll${splitDiff ? " diff-split" : ""}`}><GitPatch patch={hunksOnly(patch)} split={splitDiff} /></div></div>;
  else if (editable && (view === "source" || kind === "text")) body = editor();
  else if (editable && kind === "markdown" && view === "split") body = <div className="file-split">{editor(followEditor)}<div ref={markdownRef} className="file-markdown" onScroll={previewScroll}>{active ? markdown : null}</div></div>;
  else if (kind === "markdown") body = <div className="file-markdown">{markdown}</div>;
  else if (kind === "office") body = <OfficePane resource={resource} preview={preview} onSettings={onSettings} initialPage={descriptor.page} onPage={page => onViewState({ page })} />;
  else if (kind === "pdf" && source) body = <PdfPane url={source} initialPage={descriptor.page} onPage={page => onViewState({ page })} onPages={pages => setInfo(`${pages} 页`)} />;
  else if (kind === "image" && source) body = <ImagePane url={source} name={name} onInfo={setInfo} />;
  else if ((kind === "audio" || kind === "video") && source) body = <MediaPane kind={kind} url={source} visible={visible} time={descriptor.time} onTime={time => onViewState({ time })} onInfo={setInfo} />;
  else if (kind === "spreadsheet" && (csvUrl || source)) body = <SpreadsheetPane url={csvUrl || source!} />;
  else body = <FileEmpty badge={badge} loading={!error} title={error ? "无法在窗口中显示" : "正在读取文件…"} detail={error ? "可以刷新重试，或下载后用系统应用打开。" : undefined} />;

  const size = formatBytes(resource?.file.size ?? state.file.size);
  return <section ref={pane} className={`file-pane${narrow ? " is-narrow" : ""}`} aria-label={descriptor.title}>
    <FileHeader path={relativePath} badge={badge} dirty={state.dirty} readOnly={editable && state.loaded && !state.file.writable} demo={preview && marks} git={git}
      modes={modes} mode={view} onMode={changeMode} tools={tools} menu={menu} onCopyPath={() => copy(relativePath, "已复制相对路径")}
      save={editable && (state.dirty || state.saving) ? { saving: state.saving, disabled: !state.dirty || state.saving || !state.file.writable, run: () => { void session.save(); } } : null} />
    {state.external ? <div className="file-banner is-warning" role="status"><Icon name="alert" extra="sm" /><span>磁盘上的文件已被修改，你的本地修改已保留。</span><span className="file-banner-actions"><button className="btn small outline" onClick={() => { void session.compare(); }}>比较</button><button className="btn small outline" onClick={() => { void session.load(true); }}>重新加载</button><button className="btn small primary" onClick={() => { void session.save(true); }}>用本地修改覆盖</button></span></div> : null}
    {error || state.error ? <div className="file-banner is-error" role="alert"><Icon name="alert-c" extra="sm" /><span>{error || state.error}</span><span className="file-banner-actions"><button className="btn small outline" onClick={refresh}>重试</button></span></div> : null}
    <div className="file-content"><Suspense fallback={<FileEmpty badge={badge} loading title="正在加载查看器…" />}>
      {body}
      {state.diskText !== undefined ? <div className="file-disk-comparison"><header><span><Icon name="lock" extra="sm" />磁盘版本（只读）</span><span className="file-banner-actions"><button className="btn small outline" onClick={() => { void session.load(true); }}>采用磁盘版本</button><button className="icon-btn" aria-label="关闭比较" data-tip="关闭比较" onClick={() => session.hideComparison()}><Icon name="x" extra="sm" /></button></span></header><TextEditor session={session} descriptor={descriptor} value={state.diskText} onViewState={() => {}} readOnly wrap={prefs.wrap} fontSize={prefs.fontSize} /></div> : null}
    </Suspense>{notice ? <div className="file-toast" role="status"><Icon name="check" extra="sm" />{notice}</div> : null}</div>
    <FileStatusBar cursor={showsEditor ? cursor : null} onGoto={() => controller.current?.gotoLine()} git={editable ? git : null} language={badge.label}
      format={editable && state.loaded ? state.format : undefined} size={size} extra={info && !editable ? <span className="file-status-item">{info}</span> : null}
      fontSize={showsEditor ? prefs.fontSize : undefined} defaultFontSize={DEFAULT_EDITOR_PREFS.fontSize} onResetFont={() => setFont(null)}
      saved={editable && state.loaded ? state.saving ? "saving" : state.dirty ? "dirty" : "saved" : undefined} />
  </section>;
}

/** The window already names the file, so the `diff --git` / `---` / `+++` preamble is noise. */
const hunksOnly = (patch: string) => { const start = patch.search(/^@@ /mu); return start > 0 ? patch.slice(start) : patch; };

function FileEmpty({ badge, title, detail, loading = false }: { badge: { badge: string; tone: string }; title: string; detail?: string | undefined; loading?: boolean }) {
  return <div className="file-empty"><span className={`file-badge is-large tone-${badge.tone}${loading ? " is-loading" : ""}`} aria-hidden="true">{badge.badge}</span><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</div>;
}

function ImagePane({ url, name, onInfo }: { url: string; name: string; onInfo: (info: string) => void }) {
  const [scale, setScale] = useState<number | null>(null), [rotation, setRotation] = useState(0), [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const fitted = natural && viewport.current ? Math.min(1, (viewport.current.clientWidth - 32) / natural.width, (viewport.current.clientHeight - 32) / natural.height) : 1;
  const zoom = (factor: number) => setScale(value => Math.min(8, Math.max(0.1, (value ?? fitted) * factor)));
  return <div className="file-image"><div className="file-subbar">
    <span className="file-seg"><button type="button" className={scale === null ? "active" : ""} onClick={() => setScale(null)} data-tip="适应窗口"><Icon name="expand" extra="sm" />适应</button><button type="button" className={scale === 1 ? "active" : ""} onClick={() => setScale(1)} data-tip="实际大小">1:1</button></span>
    <span className="file-zoom"><button type="button" aria-label="缩小" onClick={() => zoom(1 / 1.25)}>−</button><span>{Math.round((scale ?? fitted) * 100)}%</span><button type="button" aria-label="放大" onClick={() => zoom(1.25)}>+</button></span>
    <button type="button" className="icon-btn" aria-label="旋转 90°" data-tip="旋转 90°" onClick={() => setRotation(value => value + 90)}><Icon name="rotate" extra="sm" /></button>
  </div><div className="file-image-canvas" ref={viewport} onWheel={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1); } }} onPointerDown={event => { const element = viewport.current!; drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }; element.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current && viewport.current) { viewport.current.scrollLeft = drag.current.left - event.clientX + drag.current.x; viewport.current.scrollTop = drag.current.top - event.clientY + drag.current.y; } }} onPointerUp={() => { drag.current = null; }}><img src={url} alt={name} draggable={false} onLoad={event => { const image = event.currentTarget; setNatural({ width: image.naturalWidth, height: image.naturalHeight }); onInfo(`${image.naturalWidth} × ${image.naturalHeight}`); }} style={{ maxWidth: scale === null ? "100%" : "none", maxHeight: scale === null ? "100%" : "none", zoom: scale ?? 1, transform: `rotate(${rotation}deg)` }} /></div></div>;
}
function MediaPane({ kind, url, visible, time = 0, onTime, onInfo }: { kind: "audio" | "video"; url: string; visible: boolean; time?: number | undefined; onTime: (time: number) => void; onInfo: (info: string) => void }) {
  const surface = useSurfaceDocument();
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null), [error, setError] = useState("");
  const latest = useRef(onTime); latest.current = onTime;
  useEffect(() => { if (!visible) ref.current?.pause(); }, [visible]);
  useEffect(() => { const change = () => { if (surface.visibilityState === "hidden") ref.current?.pause(); }; surface.addEventListener("visibilitychange", change); return () => surface.removeEventListener("visibilitychange", change); }, [surface]);
  useEffect(() => { const element = ref.current; return () => { if (element) { latest.current(element.currentTime); element.pause(); } }; }, []);
  const Tag = kind === "video" ? "video" : "audio";
  const duration = (seconds: number) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "";
  return <div className={`file-media is-${kind}`}>{kind === "audio" ? <span className="file-badge is-large tone-accent" aria-hidden="true">AUD</span> : null}<Tag ref={ref} src={url} controls preload="metadata" onLoadedMetadata={() => { const element = ref.current; if (!element) return; element.currentTime = time; onInfo([duration(element.duration), kind === "video" && element.videoWidth ? `${element.videoWidth} × ${element.videoHeight}` : ""].filter(Boolean).join(" · ")); }} onPause={() => latest.current(ref.current?.currentTime ?? 0)} onSeeked={() => latest.current(ref.current?.currentTime ?? 0)} onError={() => setError("当前播放器不能解码此媒体。请下载或使用系统应用打开。")} />{error ? <p className="file-error" role="alert">{error}</p> : null}</div>;
}

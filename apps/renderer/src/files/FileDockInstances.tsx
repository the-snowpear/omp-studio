import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { DockPanel, useDockEngine } from "../dock/DockContext";
import { locatePanel } from "../dock/model";
import type { DockStore } from "../dock/store";
import type { FilePanelDescriptor, FilePanelId, PanelDefinition } from "../dock/types";
import { useConversationView } from "../conversationWorkspace/Context";
import { useExecutionTargets } from "../workspaces/ExecutionTargets";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile } from "../preview/filesPreview";
import { getFileDocument, releaseFileDocument, type FileDocument, type FileDocumentIdentity } from "./fileDocuments";
import { readFileScope } from "./filePreferences";
import { registerFileOpener, type FileOpenIntent } from "./fileLinks";
import { requestFileClose } from "./FileCloseDialog";
import type { FileViewerActions } from "./fileActions";
import "./files.css";

const FilePane = lazy(() => import("./FilePane"));
type Catalog = { store: DockStore; preview: boolean; documents: Map<string, FileDocument>; ownerId: string; actions: FileViewerActions | undefined };
const catalogs = new Set<Catalog>();
const closingFiles = new Set<FilePanelId>();

export function FileDockInstances({ workspaceId, targetId, onSettings, actions }: { workspaceId?: string | undefined; targetId: string | null; onSettings: () => void; actions?: FileViewerActions | undefined }) {
  const { preview } = usePreviewMode(), view = useConversationView(), targets = useExecutionTargets();
  const { store, setFileViewDefinitions } = useDockEngine();
  const fileViewCache = useRef<{ key: string; value: Record<string, FilePanelDescriptor> } | undefined>(undefined);
  const fileViews = useSyncExternalStore(store.subscribe, useCallback(() => {
    const value = store.getSnapshot().layout.fileViews, key = JSON.stringify(value);
    if (fileViewCache.current?.key !== key) fileViewCache.current = { key, value };
    return fileViewCache.current.value;
  }, [store]));
  const [, update] = useState(0);
  const catalog = useMemo<Catalog>(() => ({ store, preview, documents: new Map(), ownerId: view?.document.id ?? "standalone", actions }), [store, preview, view?.document.id]);
  catalog.actions = actions;
  // Files belong to the Host target, so shared buffers outlive a conversation's Runtime client.
  const resolveClient = useCallback((id: string | null) => targets.readyClient(id), [targets]);
  const latest = useRef({ workspaceId, targetId, resolveClient, view }); latest.current = { workspaceId, targetId, resolveClient, view };
  const descriptors = Object.entries(fileViews) as [FilePanelId, FilePanelDescriptor][];

  const sessionFor = (descriptor: FilePanelDescriptor) => {
    const key = JSON.stringify([descriptor.targetId, descriptor.workspaceId, descriptor.fileId]);
    let session = catalog.documents.get(key);
    if (!session) {
      const info: FileDocumentIdentity = preview ? previewFile(descriptor.path, descriptor.workspaceId) : { id: descriptor.fileId, path: descriptor.path, name: descriptor.title, workspaceId: descriptor.workspaceId as WorkspaceId };
      session = getFileDocument(descriptor.targetId, info, () => latest.current.resolveClient(descriptor.targetId), preview);
      catalog.documents.set(key, session);
    }
    return session;
  };
  for (const [, descriptor] of descriptors) sessionFor(descriptor);

  useEffect(() => {
    catalogs.add(catalog);
    return () => { catalogs.delete(catalog); for (const session of catalog.documents.values()) if (![...catalogs].some(value => [...value.documents.values()].includes(session))) releaseFileDocument(session); };
  }, [catalog]);
  useEffect(() => {
    const keys = new Set(descriptors.map(([, item]) => JSON.stringify([item.targetId, item.workspaceId, item.fileId])));
    for (const [key, session] of catalog.documents) if (!keys.has(key)) {
      catalog.documents.delete(key);
      if (![...catalogs].some(value => [...value.documents.values()].includes(session))) releaseFileDocument(session);
    }
    const sessions = new Set(descriptors.map(([, descriptor]) => sessionFor(descriptor)));
    const off = [...sessions].map(session => session.subscribe(() => update(value => value + 1)));
    return () => off.forEach(stop => stop());
  }, [catalog, descriptors.map(([id]) => id).join("|")]);

  const open = useCallback(async (intent: FileOpenIntent) => {
    const current = latest.current, workspace = intent.workspaceId ?? current.workspaceId;
    const target = intent.targetId === undefined ? current.targetId : intent.targetId;
    if (!workspace) return;
    let file: FileDocumentIdentity;
    try { file = preview ? previewFile(intent.path, workspace) : await (await current.resolveClient(target)).query("workspace.file.inspect", { workspaceId: workspace as WorkspaceId, path: intent.path }); }
    catch { file = { workspaceId: workspace as WorkspaceId, path: intent.path, id: `unresolved:${intent.path}`, name: intent.path.split(/[\\/]/).pop() ?? intent.path }; }
    const scope = readFileScope(preview);
    for (const other of catalogs) {
      if (other.preview !== preview) continue;
      const found = Object.entries(other.store.getSnapshot().layout.fileViews ?? {}).find(([, item]) => (item.fileId === file.id || other.documents.get(JSON.stringify([item.targetId, item.workspaceId, item.fileId]))?.getSnapshot().file.id === file.id) && item.workspaceId === workspace && item.targetId === target && (other.store === store || item.scope === "workspace" && scope === "workspace"));
      if (found) {
        const panel = found[0] as FilePanelId;
        if (intent.line) other.store.dispatch({ type: "file-state", panel, patch: { line: intent.line, column: intent.column ?? 1, jump: Date.now() } });
        other.store.dispatch({ type: "open", panel }); return;
      }
    }
    const panel: FilePanelId = `file-view:${crypto.randomUUID()}`;
    const descriptor: FilePanelDescriptor = { targetId: target, workspaceId: workspace, path: file.path, fileId: file.id, title: file.name, scope, ...(intent.line ? { line: intent.line } : {}), ...(intent.column ? { column: intent.column } : {}) };
    const session = getFileDocument(target, file, () => latest.current.resolveClient(target), preview);
    catalog.documents.set(JSON.stringify([target, workspace, file.id]), session);
    const rect = current.view?.store.nextWindowRect({ width: 900, height: 680 });
    store.dispatch({ type: "file-open", panel, descriptor, ...(rect ? { rect } : {}) });
    if (scope === "workspace") { const location = locatePanel(store.getSnapshot().layout, panel); if (location?.groupId) store.setPin(location.groupId, "workspace"); }
    store.dispatch({ type: "open", panel });
  }, [catalog, preview, store]);
  useEffect(() => registerFileOpener(view?.document.id ?? "standalone", intent => { void open(intent); }), [view?.document.id, open]);

  const contextActions = (descriptor: FilePanelDescriptor) => {
    const workspace = latest.current.view?.store.getSnapshot(), active = workspace?.documents.find(item => item.id === workspace.activeDocumentId);
    if (descriptor.scope === "workspace" && active?.ref.workspaceId === descriptor.workspaceId && (active.ref.targetId ?? null) === descriptor.targetId) {
      return [...catalogs].find(value => value.preview === preview && value.ownerId === active.id)?.actions ?? actions;
    }
    return actions;
  };

  const definitions = descriptors.map(([id, descriptor]): PanelDefinition => {
    const session = sessionFor(descriptor), state = session.getSnapshot();
    return { id, title: `${descriptor.title}${state.dirty ? " •" : ""}`, icon: "file", detail: descriptor.path, minHeight: 260, initialHeight: 500,
      glyph: { state: state.loading || state.saving ? "busy" : state.error ? "error" : undefined },
      close: { label: `关闭 ${descriptor.title}`, tip: "关闭文件", pending: closingFiles.has(id), run: () => {
        if (closingFiles.has(id)) return;
        closingFiles.add(id);
        const bufferKey = (item: FilePanelDescriptor) => JSON.stringify([item.targetId, item.workspaceId, item.fileId]);
        const views = () => [...catalogs].filter(value => value.preview === preview).flatMap(value => Object.entries(value.store.getSnapshot().layout.fileViews ?? {}).filter(([, item]) => value.documents.get(bufferKey(item)) === session));
        const remaining = views().filter(([panel]) => !closingFiles.has(panel as FilePanelId));
        void requestFileClose(remaining.length ? [] : [session]).then(allow => {
          if (!allow) return;
          session.closeView(id);
          store.dispatch({ type: "file-close", panels: [id] });
          if (!Object.values(store.getSnapshot().layout.fileViews).some(item => bufferKey(item) === bufferKey(descriptor))) catalog.documents.delete(bufferKey(descriptor));
          if (!views().length) releaseFileDocument(session);
        }).finally(() => { closingFiles.delete(id); if (store.getSnapshot().layout.fileViews[id]) update(value => value + 1); });
      } },
    };
  });
  useLayoutEffect(() => { setFileViewDefinitions(definitions); });
  useLayoutEffect(() => () => setFileViewDefinitions([]), [setFileViewDefinitions]);
  return <>{descriptors.map(([id, descriptor]) => <DockPanel key={id} id={id}>{visibility => <Suspense fallback={<div className="file-empty">正在打开文件…</div>}><FilePane id={id} descriptor={descriptor} session={sessionFor(descriptor)} visible={visibility.visible} onSettings={onSettings} onOpen={reference => { void open({ ...reference, workspaceId: descriptor.workspaceId, targetId: descriptor.targetId }); }} onViewState={patch => store.dispatch({ type: "file-state", panel: id, patch })} actions={actions ? { openers: actions.openers, addContext: input => contextActions(descriptor)?.addContext(input), runShell: (...args) => contextActions(descriptor)?.runShell(...args) } : undefined} /></Suspense>}</DockPanel>)}</>;
}

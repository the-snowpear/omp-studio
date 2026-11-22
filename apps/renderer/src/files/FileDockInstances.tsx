import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientEvent, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { DockPanel, useDockEngine } from "../dock/DockContext";
import { locatePanel } from "../dock/model";
import type { DockStore } from "../dock/store";
import type { FilePanelDescriptor, FilePanelId, PanelDefinition } from "../dock/types";
import { useConversationView } from "../conversationWorkspace/Context";
import { useExecutionTargets } from "../workspaces/ExecutionTargets";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
import { ToastHost } from "../ToastHost";
import { previewFile } from "../preview/filesPreview";
import { getFileDocument, releaseFileDocument, type FileDocument, type FileDocumentIdentity } from "./fileDocuments";
import { inspectFileBackend, resolveWorkspacePaths } from "./fileBackend";
import { readFileScope } from "./filePreferences";
import { registerFileOpener, type FileOpenIntent } from "./fileLinks";
import { invalidateFilePathKinds, registerPathResolver } from "./pathResolution";
import { requestFileClose } from "./FileCloseDialog";
import { normalizeFileIdentityPath } from "./fileTypes";
import type { FileViewerActions } from "./fileActions";
import "./files.css";

const FilePane = lazy(() => import("./FilePane"));
type Catalog = { store: DockStore; preview: boolean; documents: Map<string, FileDocument>; ownerId: string; actions: FileViewerActions | undefined };
const catalogs = new Set<Catalog>();
const closingFiles = new Set<FilePanelId>();
const catalogBufferKey = (item: Pick<FilePanelDescriptor, "targetId" | "workspaceId" | "path" | "source">) =>
  JSON.stringify([item.targetId, item.workspaceId, item.source ?? "workspace", normalizeFileIdentityPath(item.path)]);
const isSessionReferenced = (session: FileDocument, preview: boolean) =>
  [...catalogs].some(value => value.preview === preview && [...value.documents.values()].includes(session));
const affectsFilePaths = (event: ClientEvent) => event.kind === "runtime.changed" || event.kind === "git.repository.changed"
  || event.kind === "command.receipt" && /^(?:workspace\.file\.|fs\.)/.test(event.receipt.commandName)
  || event.kind === "conversation.changed" && (event.update.kind === "conversation.turn.completed"
    || event.update.kind === "conversation.tool.completed" && !/^(?:read|grep|glob|find|ast_grep|web|web_search|think|todo)$/.test(event.update.result.toolName ?? ""));

function releaseOrInterceptOrphan(session: FileDocument, fallbackDescriptor: FilePanelDescriptor | undefined, preview: boolean, doc: Document) {
  if (isSessionReferenced(session, preview)) return;
  if (!session.getSnapshot().dirty) {
    releaseFileDocument(session);
    return;
  }
  void requestFileClose([session], doc).then(allow => {
    if (allow) {
      if (session.getSnapshot().dirty) session.discard();
      if (!isSessionReferenced(session, preview)) releaseFileDocument(session);
      return;
    }
    if (isSessionReferenced(session, preview) || !fallbackDescriptor) return;
    const host = [...catalogs].find(value => value.preview === preview);
    if (!host) return;
    const panel: FilePanelId = `file-view:${crypto.randomUUID()}`;
    const snap = session.getSnapshot().file;
    const reopened: FilePanelDescriptor = { ...fallbackDescriptor, fileId: snap.id, path: snap.path || fallbackDescriptor.path };
    host.documents.set(catalogBufferKey(reopened), session);
    host.store.dispatch({ type: "file-open", panel, descriptor: reopened });
    host.store.dispatch({ type: "open", panel });
  });
}

export function FileDockInstances({ workspaceId, targetId, client, onSettings, actions }: { workspaceId?: string | undefined; targetId: string | null; client?: Pick<StudioClient, "subscribe"> | undefined; onSettings: () => void; actions?: FileViewerActions | undefined }) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh", view = useConversationView(), targets = useExecutionTargets();
  const { store, hosts, setFileViewDefinitions } = useDockEngine();
  const fileViewCache = useRef<{ key: string; value: Record<string, FilePanelDescriptor> } | undefined>(undefined);
  const fileViews = useSyncExternalStore(store.subscribe, useCallback(() => {
    const value = store.getSnapshot().layout.fileViews, key = JSON.stringify(value);
    if (fileViewCache.current?.key !== key) fileViewCache.current = { key, value };
    return fileViewCache.current.value;
  }, [store]));
  const [, update] = useState(0);
  const [openError, setOpenError] = useState<{ cause: unknown }>();
  const catalog = useMemo<Catalog>(() => ({ store, preview, documents: new Map(), ownerId: view?.document.id ?? "standalone", actions }), [store, preview, view?.document.id]);
  catalog.actions = actions;
  const descriptorBySession = useRef(new Map<FileDocument, FilePanelDescriptor>());
  // Files belong to the Host target, so shared buffers outlive a conversation's Runtime client.
  const resolveClient = useCallback((id: string | null) => targets.readyClient(id), [targets]);
  const latest = useRef({ workspaceId, targetId, resolveClient, view }); latest.current = { workspaceId, targetId, resolveClient, view };
  const descriptors = Object.entries(fileViews) as [FilePanelId, FilePanelDescriptor][];

  const sessionFor = (descriptor: FilePanelDescriptor) => {
    const key = catalogBufferKey(descriptor);
    let session = catalog.documents.get(key);
    if (!session) {
      const identity = preview ? previewFile(descriptor.path, descriptor.workspaceId) : { id: descriptor.fileId, path: descriptor.path, name: descriptor.title, workspaceId: descriptor.workspaceId as WorkspaceId };
      const info: FileDocumentIdentity = { ...identity, ...(descriptor.source ? { source: descriptor.source } : {}) };
      session = getFileDocument(descriptor.targetId, info, () => latest.current.resolveClient(descriptor.targetId), preview);
      catalog.documents.set(key, session);
    }
    descriptorBySession.current.set(session, descriptor);
    return session;
  };
  for (const [, descriptor] of descriptors) sessionFor(descriptor);

  useEffect(() => {
    catalogs.add(catalog);
    return () => {
      catalogs.delete(catalog);
      const uniqueSessions = new Set(catalog.documents.values());
      catalog.documents.clear();
      for (const session of uniqueSessions) {
        releaseOrInterceptOrphan(session, descriptorBySession.current.get(session), preview, document);
      }
    };
  }, [catalog, preview]);
  const descriptorSignature = descriptors.map(([id, item]) => `${id}:${catalogBufferKey(item)}`).join("|");
  useEffect(() => {
    const keys = new Set(descriptors.map(([, item]) => catalogBufferKey(item)));
    for (const [key, session] of catalog.documents) if (!keys.has(key)) {
      catalog.documents.delete(key);
      releaseOrInterceptOrphan(session, descriptorBySession.current.get(session), preview, document);
    }
    const sessions = new Set(descriptors.map(([, descriptor]) => sessionFor(descriptor)));
    const off = [...sessions].map(session => session.subscribe(() => update(value => value + 1)));
    return () => off.forEach(stop => stop());
  }, [catalog, preview, descriptorSignature]);

  const open = useCallback(async (intent: FileOpenIntent) => {
    const current = latest.current, workspace = intent.source === "system" ? "" : intent.workspaceId ?? current.workspaceId;
    const target = intent.targetId === undefined ? current.targetId : intent.targetId;
    if (workspace === undefined) return;
    let file: FileDocumentIdentity;
    try { file = preview ? previewFile(intent.path, workspace) : await inspectFileBackend(await current.resolveClient(target), { workspaceId: workspace as WorkspaceId, path: intent.path, ...(intent.source ? { source: intent.source } : {}) }); }
    catch (cause) { setOpenError({ cause }); return; }
    setOpenError(undefined);
    if (intent.source) file = { ...file, source: intent.source };
    const scope = readFileScope(preview);
    const normalizedPath = normalizeFileIdentityPath(file.path);
    for (const other of catalogs) {
      if (other.preview !== preview) continue;
      const found = Object.entries(other.store.getSnapshot().layout.fileViews ?? {}).find(([, item]) => {
        if (item.workspaceId !== workspace || item.targetId !== target || (item.source ?? undefined) !== (intent.source ?? undefined)) return false;
        if (!(other.store === store || (item.scope === "workspace" && scope === "workspace"))) return false;
        const docFile = other.documents.get(catalogBufferKey(item))?.getSnapshot().file;
        return item.fileId === file.id
          || docFile?.id === file.id
          || normalizeFileIdentityPath(item.path) === normalizedPath
          || (docFile !== undefined && normalizeFileIdentityPath(docFile.path) === normalizedPath);
      });
      if (found) {
        const [panel, existingDescriptor] = found as [FilePanelId, FilePanelDescriptor];
        const existingSession = other.documents.get(catalogBufferKey(existingDescriptor));
        existingSession?.syncIdentity(file);
        const patch: Partial<FilePanelDescriptor> = {
          ...(existingDescriptor.fileId !== file.id ? { fileId: file.id } : {}),
          ...(intent.line ? { line: intent.line, column: intent.column ?? 1, jump: Date.now() } : {}),
          ...(intent.fragment ? { fragment: intent.fragment, mode: "preview", jump: Date.now() } : {}),
        };
        if (Object.keys(patch).length > 0) other.store.dispatch({ type: "file-state", panel, patch });
        other.store.dispatch({ type: "open", panel }); return;
      }
    }
    const panel: FilePanelId = `file-view:${crypto.randomUUID()}`;
    const descriptor: FilePanelDescriptor = { ...(intent.source ? { source: intent.source } : {}), targetId: target, workspaceId: workspace, path: file.path, fileId: file.id, title: file.name, scope, ...(intent.line ? { line: intent.line } : {}), ...(intent.column ? { column: intent.column } : {}), ...(intent.fragment ? { fragment: intent.fragment, mode: "preview" } : {}) };
    const session = getFileDocument(target, file, () => latest.current.resolveClient(target), preview);
    catalog.documents.set(catalogBufferKey(descriptor), session);
    const rect = current.view?.store.nextWindowRect({ width: 900, height: 680 });
    store.dispatch({ type: "file-open", panel, descriptor, ...(rect ? { rect } : {}) });
    if (scope === "workspace") { const location = locatePanel(store.getSnapshot().layout, panel); if (location?.groupId) store.setPin(location.groupId, "workspace"); }
    store.dispatch({ type: "open", panel });
  }, [catalog, preview, store]);
  useEffect(() => registerFileOpener(view?.document.id ?? "standalone", intent => { void open(intent); }), [view?.document.id, open]);
  useEffect(() => {
    let active = true;
    const subscriptions = new Map<StudioClient, () => void>();
    const off = registerPathResolver(view?.document.id ?? "standalone", async (paths, target, explicit) => {
      const rootClient = await latest.current.resolveClient(target.targetId);
      // File viewers and the system browser use the Host's root client, whose
      // file receipts need not appear on a conversation-bound client.
      if (active && !preview && !subscriptions.has(rootClient)) subscriptions.set(rootClient, rootClient.subscribe({ scope: "all" }, event => {
        if (affectsFilePaths(event)) invalidateFilePathKinds(target.targetId);
      }));
      return (await resolveWorkspacePaths(rootClient, target.workspaceId as WorkspaceId, paths, explicit)).resolutions;
    });
    return () => { active = false; off(); for (const stop of subscriptions.values()) stop(); };
  }, [view?.document.id, preview]);
  useEffect(() => {
    if (preview) return;
    const invalidate = () => invalidateFilePathKinds(targetId, workspaceId);
    const off = client?.subscribe({ scope: "all" }, event => { if (affectsFilePaths(event)) invalidate(); });
    const surface = view?.surface ?? document, window = surface.defaultView;
    const reveal = () => { if (surface.visibilityState !== "hidden") invalidate(); };
    window?.addEventListener("focus", reveal);
    surface.addEventListener("visibilitychange", reveal);
    return () => { off?.(); window?.removeEventListener("focus", reveal); surface.removeEventListener("visibilitychange", reveal); };
  }, [client, preview, targetId, workspaceId, view?.surface]);

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
      close: { label: zh ? `关闭 ${descriptor.title}` : `Close ${descriptor.title}`, tip: zh ? "关闭文件" : "Close file", pending: closingFiles.has(id), run: () => {
        if (closingFiles.has(id)) return;
        closingFiles.add(id);
        const views = () => [...catalogs].filter(value => value.preview === preview).flatMap(value => Object.entries(value.store.getSnapshot().layout.fileViews ?? {}).filter(([, item]) => value.documents.get(catalogBufferKey(item)) === session));
        const remaining = views().filter(([panel]) => !closingFiles.has(panel as FilePanelId));
        const surfaceDoc = hosts?.get(id).surfaceSnapshot();
        const targetDoc = surfaceDoc && !surfaceDoc.defaultView?.closed ? surfaceDoc : document;
        void requestFileClose(remaining.length ? [] : [session], targetDoc).then(allow => {
          if (!allow) return;
          if (!remaining.length && session.getSnapshot().dirty) session.discard();
          session.closeView(id);
          store.dispatch({ type: "file-close", panels: [id] });
          if (!Object.values(store.getSnapshot().layout.fileViews).some(item => catalogBufferKey(item) === catalogBufferKey(descriptor))) catalog.documents.delete(catalogBufferKey(descriptor));
          if (!views().length) releaseFileDocument(session);
        }).finally(() => { closingFiles.delete(id); if (store.getSnapshot().layout.fileViews[id]) update(value => value + 1); });
      } },
    };
  });
  useLayoutEffect(() => { setFileViewDefinitions(definitions); });
  useLayoutEffect(() => () => setFileViewDefinitions([]), [setFileViewDefinitions]);
  return <>{descriptors.map(([id, descriptor]) => <DockPanel key={id} id={id}>{visibility => <Suspense fallback={<div className="file-empty">{zh ? "正在打开文件…" : "Opening file…"}</div>}><FilePane id={id} descriptor={descriptor} session={sessionFor(descriptor)} visible={visibility.visible} onSettings={onSettings} onViewState={patch => store.dispatch({ type: "file-state", panel: id, patch })} actions={actions ? { contextWorkspaceId: contextActions(descriptor)?.contextWorkspaceId, openers: actions.openers, addContext: input => contextActions(descriptor)?.addContext(input), runShell: (...args) => contextActions(descriptor)?.runShell(...args) } : undefined} /></Suspense>}</DockPanel>)}
    <ToastHost message={openError ? hostErrorMessage(openError.cause, zh ? "无法打开此文件" : "Unable to open this file") : null} icon="alert-c" onDismiss={() => setOpenError(undefined)} />
  </>;
}

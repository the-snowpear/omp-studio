import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { StudioClient, WorkspaceId, SessionId } from "@omp-studio/client-contract";
import { DockProvider, useDockEngine } from "../dock/DockContext";
import { DockFloatingLayer } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { conversationPanelId, type PanelContentAdapter, type PanelDefinition } from "../dock/types";
import { dockedPanelVisible } from "../dock/conversationPanels";
import { SurfaceProvider, useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { NativeWindowHost } from "../dock/NativeFloat";
import { WindowFrame } from "../dock/WindowFrame";
import { WindowPinButton } from "../dock/DockMenus";
import { WindowFocusContext, WindowOwnerContext, useWindowOrder } from "../dock/windowOrder";
import { clampFloat } from "../dock/model";
import { workbenchBounds } from "../dock/workbenchGeometry";
import { dragPreview } from "../dock/dragPreview";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewSurface, usePreviewMode } from "../preview/PreviewContext";
import { ExecutionTargetScope, useExecutionTargets } from "../workspaces/ExecutionTargets";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { ConversationViewContext, WorkspaceContext, useConversationLayoutLocked, type SharedRegion } from "./Context";
import { conversationVisible, MIN_VIEW, type ConversationDocument, type ConversationView } from "./model";
import { ConversationWorkspaceStore } from "./store";
import type { DocumentHosts } from "./hosts";
import { snapCells } from "./snap";
import { WindowSnapButton, SnapAssist, SnapDividers } from "../dock/SnapLayout";
import { dragConversation } from "./drag";
import { createConversationClient, initializeConversationClient } from "./client";
import { WorkspaceEmpty } from "./WorkspaceEmpty";
import { ToolWindowTabs, WindowTabAdd, WindowTabs } from "./Tabs";
import { ConversationLayoutPreview } from "./LayoutPreview";
import { useWorkbenchPageMotion } from "./pageMotion";
import "./workspace.css";

export function ConversationWorkspace({ client, renderDocument }: { client: StudioClient; renderDocument: (client: StudioClient) => ReactNode }) {
  const { preview } = usePreviewMode();
  const visited = useRef({ real: !preview, demo: preview });
  if (preview) visited.current.demo = true; else visited.current.real = true;
  const [real] = useState(() => new ConversationWorkspaceStore(localStorage, false, !preview));
  const [demo] = useState(() => new ConversationWorkspaceStore(null, true));
  const store = preview ? demo : real;
  if (!preview) real.enablePersistence();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activeDocument = state.documents.find(record => record.id === state.activeDocumentId);
  const pageVisible = activeDocument?.page === true;
  useWorkbenchPageMotion(pageVisible, activeDocument?.pagePhase ?? "in");
  const layoutLocked = useConversationLayoutLocked(store, state.activeDocumentId ?? undefined);
  const [dock] = useState(() => new DockStore());
  const hosts = store.hosts;
  const [slots, setSlots] = useState<Partial<Record<SharedRegion, HTMLElement>>>({});
  const slotRefs = useMemo(() => Object.fromEntries((["title", "navigation", "sidebar", "conversationTitle", "right", "bottom", "bottomReveal", "page", "background"] as SharedRegion[]).map(region => [region, (node: HTMLDivElement | null) => { if (node) setSlots(previous => previous[region] === node ? previous : { ...previous, [region]: node }); }])) as Record<SharedRegion, (node: HTMLDivElement | null) => void>, []);
  useEffect(() => { window.addEventListener("pagehide", store.flush); return () => { window.removeEventListener("pagehide", store.flush); store.flush(); }; }, [store]);
  useEffect(() => () => store.cancelDrag?.(), [store]);
  const main = state.views.find(view => view.placement === "main");
  const canvas = useRef<HTMLDivElement>(null);
  const canvasRef = useCallback((node: HTMLDivElement | null) => { canvas.current = node; slotRefs.bottomReveal(node); }, [slotRefs]);
  useLayoutEffect(() => {
    const read = () => { const box = canvas.current!.getBoundingClientRect(), area = workbenchBounds() ?? box; if (box.width && box.height) store.setGeometry(area, { x: box.x, y: box.y, width: box.width, height: box.height }); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(read);
    for (const node of [canvas.current, canvas.current?.closest("[data-dock-workbench]"), slots.right, slots.bottom, slots.conversationTitle]) if (node) observer?.observe(node);
    window.addEventListener("resize", read); read();
    return () => { observer?.disconnect(); window.removeEventListener("resize", read); };
  }, [store, state.sidebarWidth, state.sidebarVisible, state.panelWidth, state.bottomHeight, slots]);
  const bounds = store.geometry.workbench;
  const [snapLayer, setSnapLayer] = useState<HTMLDivElement | null>(null);
  const [titleRow, setTitleRow] = useState<HTMLDivElement | null>(null);
  const [tabAdd, setTabAdd] = useState<HTMLElement | null>(null);
  const windowed = store.allWindowed();
  const snapped = state.snap && store.manager.getSnapshot().records.some(view => Object.values(state.snap!.members).includes(view.id) && store.manager.visible(view));
  const snapSize = store.manager.size();
  const context = useMemo(() => ({ store, slots, snapLayer, titleRow }), [store, slots, snapLayer, titleRow]);
  const rootStyle = { "--sidebar-w": `${state.sidebarVisible ? state.sidebarWidth : 0}px`, "--panel-w": `${state.panelWidth}px`, "--cw-bottom-height": `${state.bottomHeight}px` } as CSSProperties;
  return <WindowFocusContext.Provider value={store.windows}><WorkspaceContext.Provider value={context}>
    <div className={`conversation-workspace${state.views.some(view => view.placement !== "main") ? " has-conversation-windows" : ""}`} style={rootStyle}>
      <div ref={slotRefs.background} />
      <div className="cw-title-slot" ref={slotRefs.title} />
      <div className="cw-shell" data-dock-workbench>
        <div className="cw-navigation-slot" ref={slotRefs.navigation} />
        <div className="cw-sidebar-slot" ref={slotRefs.sidebar} hidden={pageVisible} inert={pageVisible} />
        <div className="cw-shell-main">
          <div className={`cw-conversation-title-row${windowed ? " is-windowed" : ""}`} ref={setTitleRow} hidden={pageVisible} inert={pageVisible}>
            {windowed ? <WindowTabs store={store} addSlot={setTabAdd} /> : null}
            <div className="cw-conversation-title-slot" ref={slotRefs.conversationTitle} />
          </div>
          <div className="cw-workbench">
            <div className="cw-canvas" ref={canvasRef} data-conversation-canvas>
              {main ? <EmbeddedConversation view={main} store={store} hosts={hosts} visible={conversationVisible(main, state)} /> : !pageVisible && !snapped ? <WorkspaceEmpty store={store} /> : null}
              {snapped && state.snap ? <div className={`cw-snap-viewport${snapSize.width > store.geometry.canvas.width || snapSize.height > store.geometry.canvas.height ? " is-scrollable" : ""}`}>
                <div className="cw-snap-surface" ref={setSnapLayer} style={{ width: snapSize.width, height: snapSize.height }}>
                  {!pageVisible ? <><SnapDividers manager={store.manager} layout={state.snap} size={snapSize} locked={layoutLocked} onMeasure={() => { for (const record of store.manager.getSnapshot().records) store.hosts.get(record.content.documentId).tools?.hosts.flush(); }} />
                  <SnapAssist manager={store.manager} layout={state.snap} cell={state.snapAssistCell} size={snapSize} /></> : null}
                </div>
              </div> : null}
            </div>
            <div className="cw-right-slot" ref={slotRefs.right} hidden={pageVisible} inert={pageVisible} />
          </div>
          <div className="cw-bottom-slot" ref={slotRefs.bottom} hidden={pageVisible} inert={pageVisible} />
          <div className="cw-page-slot" ref={slotRefs.page} />
        </div>
      </div>
    </div>
    {createPortal(<div className="dock-floating-layer">{state.views.filter(view => view.placement === "float" || view.placement === "native").map((view, order) => <ConversationWindow key={view.id} view={view} store={store} hosts={hosts} bounds={bounds} order={order} snapLayer={snapLayer} />)}</div>, document.body)}
    <ConversationLayoutPreview store={store} />
    {!windowed && state.views.some(view => view.minimized && view.placement !== "native") ? <div className="dock-pinned-capsules" role="group" aria-label="最小化的对话">{state.views.filter(view => view.minimized && view.placement !== "native").map(view => <button className="dock-capsule" key={view.id} onClick={() => store.focus(view.id)}><Icon name="message" extra="sm" /><span>{store.documentFor(view.id)?.title}</span><Icon name="restore" extra="sm" /></button>)}</div> : null}
    {visited.current.real && real.getSnapshot().documents.map(record => <PreviewSurface key={`real:${record.id}`} preview={false}><ConversationDocumentHost enabled={!preview} record={record} client={client} store={real} hosts={real.hosts} dock={dock} tabAdd={windowed ? tabAdd : null} renderDocument={renderDocument} /></PreviewSurface>)}
    {visited.current.demo && demo.getSnapshot().documents.map(record => <PreviewSurface key={`demo:${record.id}`} preview><ConversationDocumentHost enabled={preview} record={record} client={client} store={demo} hosts={demo.hosts} dock={dock} tabAdd={windowed ? tabAdd : null} renderDocument={renderDocument} /></PreviewSurface>)}
  </WorkspaceContext.Provider></WindowFocusContext.Provider>;
}

function ConversationDocumentHost({ enabled, record, client: initialClient, store, hosts, dock, tabAdd, renderDocument }: { enabled: boolean; record: ConversationDocument; client: StudioClient; store: ConversationWorkspaceStore; hosts: DocumentHosts; dock: DockStore; tabAdd: HTMLElement | null; renderDocument: (client: StudioClient) => ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { resolvedLanguage } = useI18n();
  const registry = useExecutionTargets();
  const registryRef = useRef(registry); registryRef.current = registry;
  const [client] = useState(() => createConversationClient(async () => {
    const target = store.demo || record.ref.targetId === null ? initialClient : await registryRef.current.readyClient(record.ref.targetId);
    const workspaceId = record.ref.workspaceId ?? (!store.demo && record.ref.draftId !== "initial" ? (await initializeConversationClient(target)).selected?.workspaceId : undefined);
    if (!workspaceId || store.demo) return { client: target, owned: false };
    if (!target.openContext) throw new Error("此 Host 需要升级后才能打开多个对话窗口。");
    return { client: await target.openContext({ workspaceId: workspaceId as WorkspaceId, ...(record.ref.sessionId ? { sessionId: record.ref.sessionId as SessionId } : {}) }), owned: true };
  }));
  const host = hosts.get(record.id);
  const surface = useSyncExternalStore(useCallback(listener => { host.listeners.add(listener); return () => { host.listeners.delete(listener); }; }, [host]), () => host.surface);
  const view = state.views.find(view => view.documentId === record.id);
  const active = enabled && record.id === state.activeDocumentId;
  const [localDock] = useState(() => dock.fork({ target: record.ref.targetId ?? "local", project: record.ref.workspaceId ?? null, session: record.ref.sessionId ?? record.ref.draftId ?? record.id, ...(!record.ref.sessionId ? { draft: true } : {}) }, store.demo));
  const dockedVisible = useSyncExternalStore(localDock.subscribe, () => view?.placement !== "docked" || active && dockedPanelVisible(localDock.getSnapshot().layout, conversationPanelId(view.id)));
  const visible = enabled && !!view && conversationVisible(view, state) && dockedVisible;
  localDock.documentId = record.id;
  useLayoutEffect(() => {
    const release = localDock.bindWindows(store.manager, record.id, record.title);
    store.attachPendingDock(record.id);
    return release;
  }, [localDock, store, record.id]);
  useLayoutEffect(() => localDock.setConversationTitle(record.title), [localDock, record.title]);
  const content = useMemo<PanelContentAdapter | undefined>(() => {
    if (!view) return undefined;
    const id = view.id;
    return {
      attach: (slot, preview) => {
        if (preview) return hosts.preview(record.id, { element: slot });
        slot.dataset.conversationView = id;
        slot.dataset.dockWindow = `conversation:${id}`;
        slot.dataset.conversationOwner = record.id;
        const detach = hosts.attach(record.id, slot);
        const release = store.windows.register(`conversation:${id}`, { ownerId: record.id, surface: slot.ownerDocument, floating: false });
        const releaseSurface = store.windows.attach(slot.ownerDocument);
        return () => { detach(); release(); releaseSurface(); delete slot.dataset.conversationView; delete slot.dataset.dockWindow; delete slot.dataset.conversationOwner; };
      },
      drag: event => { dragConversation(event, store, { viewId: id }); },
      activate: () => store.manager.activate(id),
    };
  }, [store, hosts, record.id, view?.id]);
  const definitions = useMemo<readonly PanelDefinition[]>(() => !view || !content ? WORKBENCH_PANELS : [...WORKBENCH_PANELS, {
    id: conversationPanelId(view.id), title: record.title, icon: "message", initialHeight: 400, minHeight: 280, content,
    close: { run: () => store.close(view.id), label: resolvedLanguage === "zh" ? `关闭 ${record.title}` : `Close ${record.title}`, tip: resolvedLanguage === "zh" ? "关闭对话视图" : "Close conversation view" },
  }], [view?.id, content, record.title, store, resolvedLanguage]);
  const releaseClient = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(releaseClient.current);
    return () => { releaseClient.current = setTimeout(() => { void client.close(); }, 0); };
  }, [client]);
  const onSelectTarget = async (targetId: string | null) => {
    const target = await registryRef.current.readyClient(targetId);
    const bootstrap = await target.bootstrap();
    store.open({ targetId, ...(bootstrap.selected?.workspaceId ? { workspaceId: bootstrap.selected.workspaceId } : {}), draftId: crypto.randomUUID() });
  };
  const context = { store, document: record, view, active, visible, root: host.element, surface, header: { title: host.title, actions: host.actions } };
  return createPortal(<WindowOwnerContext.Provider value={record.id}><ConversationViewContext.Provider value={context}><SurfaceProvider document={surface}>
    <ExecutionTargetScope id={record.ref.targetId} memoryKey={record.id} onSelect={onSelectTarget}>
      <DockProvider definitions={definitions} store={localDock} ownerId={record.id} conversationTitle={record.title}>
        <ConversationSurfaceBinding workspace={store} id={record.id} />
        {enabled ? <ToolWindowTabs workspace={store} documentId={record.id} /> : null}
        {/* The window tab bar's + belongs to the active conversation's dock; its menu opens in the main window. */}
        {active && tabAdd ? createPortal(<SurfaceProvider document={document}><WindowTabAdd workspace={store} /></SurfaceProvider>, tabAdd) : null}
        <div className="cw-document-body">
          {renderDocument(client)}
          {enabled ? <DockFloatingLayer /> : null}
        </div>
      </DockProvider>
    </ExecutionTargetScope>
  </SurfaceProvider></ConversationViewContext.Provider></WindowOwnerContext.Provider>, host.element);
}

function ConversationSurfaceBinding({ workspace, id }: { workspace: ConversationWorkspaceStore; id: string }) {
  const { hosts, store } = useDockEngine();
  const surface = useSurfaceDocument();
  useLayoutEffect(() => {
    store.eventWindow = surfaceWindow(surface);
    if (surface !== document) return hosts.attachWindow(surface);
  }, [hosts, store, surface]);
  useLayoutEffect(() => {
    const release = workspace.hosts.registerTools(id, hosts, store);
    return release;
  }, [workspace, id, hosts, store]);
  return null;
}

function DocumentSlot({ view, hosts }: { view: ConversationView; hosts: DocumentHosts }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => hosts.attach(view.documentId, slot.current!), [hosts, view.documentId]);
  return <div className="cw-view-content" ref={slot} />;
}

function EmbeddedConversation({ view, store, hosts, visible }: { view: ConversationView; store: ConversationWorkspaceStore; hosts: DocumentHosts; visible: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const window = useWindowOrder(0, { id: `conversation:${view.id}`, ownerId: view.documentId, floating: false, visible });
  useEffect(() => {
    const focus = (event: Event) => { if ((event as CustomEvent).detail === view.id) frame.current?.focus({ preventScroll: true }); };
    globalThis.window.addEventListener("omp:conversation-focus", focus);
    return () => globalThis.window.removeEventListener("omp:conversation-focus", focus);
  }, [view.id]);
  return <div ref={frame} tabIndex={-1} className={`cw-main-conversation${window.active ? " is-active-window" : ""}`} data-dock-window={window.id} data-conversation-view={view.id} hidden={!visible} inert={!visible} onPointerDownCapture={window.raise} onFocusCapture={window.raise}><DocumentSlot view={view} hosts={hosts} /></div>;
}

function HeaderSlot({ hosts, id, kind, fallback }: { hosts: DocumentHosts; id: string; kind: "title" | "actions"; fallback?: string }) {
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => hosts.attach(id, slot.current!, kind), [hosts, id, kind]);
  return <span className={`cw-window-${kind}-slot`} ref={slot}>{fallback ? <span className="cw-window-title-placeholder">{fallback}</span> : null}</span>;
}

function ConversationWindow({ view, store, hosts, bounds, order, snapLayer }: { view: ConversationView; store: ConversationWorkspaceStore; hosts: DocumentHosts; bounds: ConversationView["rect"]; order: number; snapLayer: HTMLElement | null }) {
  const record = store.documentFor(view.id)!;
  const dragging = useSyncExternalStore(dragPreview.subscribe, () => dragPreview.snapshot()?.conversation?.documentId === view.documentId);
  const frame = useRef<HTMLDivElement>(null);
  const native = view.placement === "native" && !!globalThis.ompStudioChrome?.prepareFloatWindow;
  const cell = store.snapCell(view.id), snap = store.getSnapshot().snap;
  const snapped = cell !== undefined && !!snap && !native && !view.maximized;
  const locked = useConversationLayoutLocked(store, view.documentId);
  const control = (action: "minimize" | "maximize") => action === "maximize" ? store.manager.maximize(view.id) : store.setWindow(view.id, { minimized: true });
  useEffect(() => {
    const focus = (event: Event) => { if ((event as CustomEvent).detail === view.id) frame.current?.focus({ preventScroll: true }); };
    window.addEventListener("omp:conversation-focus", focus);
    return () => window.removeEventListener("omp:conversation-focus", focus);
  }, [view.id]);
  const content = (area: ConversationView["rect"], nativeKey?: string) => {
    const rect = snapped && snap ? snapCells(snap.template, snap.tree, store.manager.size())[cell!]! : nativeKey || view.maximized ? { x: 0, y: 0, width: area.width, height: area.height } : clampFloat({ ...view.rect, width: Math.max(MIN_VIEW.width, view.rect.width) }, { width: area.width, height: area.height }, MIN_VIEW.height);
    return <WindowOwnerContext.Provider value={record.id}><WindowFrame title={record.title} icon="message" rect={rect} bounds={area} minWidth={MIN_VIEW.width} minHeight={MIN_VIEW.height}
      maximized={view.maximized} nativeKey={nativeKey} order={order} frameRef={frame} windowId={`conversation:${view.id}`} visible={!view.minimized} locked={locked} resizable={!snapped}
      frameProps={{ className: `dock-conversation-window${snapped ? " is-snapped" : ""}${dragging ? " dock-drag-source" : ""}`, ...{ "data-conversation-view": view.id, "data-conversation-owner": view.documentId, "data-workbench-surface": view.pin === "none" ? "" : undefined, "data-dock-group": conversationPanelId(view.id), "data-dock-region": "float" }, style: snapped ? { position: "absolute" } : undefined }}
      onTitleDrag={event => { if (!nativeKey) dragConversation(event, store, { viewId: view.id }); }}
      onRectChange={rect => store.setWindow(view.id, { rect })}
      onControl={action => { if (nativeKey) void globalThis.ompStudioChrome!.controlFloatWindow!({ key: nativeKey, action }); else control(action); }}
      onClose={() => store.close(view.id)} closeLabel="关闭对话视图"
      titleContent={<HeaderSlot hosts={hosts} id={view.documentId} kind="title" fallback={record.title} />}
      titleExtra={view.pin !== "none" ? <span className="dock-pin-status"><Icon name={native ? "external" : "pin"} extra="sm" /></span> : null}
      maximizeButton={!nativeKey ? <WindowSnapButton manager={store.manager} window={store.manager.get(view.id)!} locked={locked} onMaximize={() => control("maximize")} /> : undefined}
      controls={<><HeaderSlot hosts={hosts} id={view.documentId} kind="actions" /><WindowPinButton mode={view.pin} workspaceAvailable={!!record.ref.workspaceId} onChange={pin => store.setPin(view.id, pin)} /></>}>
      <div className="dock-group-body"><DocumentSlot view={view} hosts={hosts} /></div>
    </WindowFrame></WindowOwnerContext.Provider>;
  };
  if (native) return <NativeWindowHost id={`conversation:${store.demo ? "demo:" : ""}${view.id}`} title={record.title} rect={view.nativeRect}
    sourceRect={{ ...view.rect, x: bounds.x + view.rect.x, y: bounds.y + view.rect.y }} minimum={MIN_VIEW}
    minimized={view.minimized} maximized={view.maximized} topmost={view.pin === "topmost"}
    onFocus={() => store.activate(view.id)} onClose={() => store.close(view.id)}
    onState={event => { if (JSON.stringify(view.nativeRect) !== JSON.stringify(event.rect) || view.minimized !== event.minimized || view.maximized !== event.maximized) store.setWindow(view.id, { nativeRect: event.rect, minimized: event.minimized, maximized: event.maximized }); }}
    onError={message => { console.error(message); store.setPin(view.id, "none"); }} focusEvent="omp:conversation-focus" acceptsFocus={event => (event as CustomEvent).detail === view.id}>
    {({ key, bounds }) => content(bounds, key)}
  </NativeWindowHost>;
  if (!conversationVisible(view, store.getSnapshot())) return null;
  if (snapped) return snapLayer ? createPortal(content({ x: 0, y: 0, width: snapLayer.clientWidth, height: snapLayer.clientHeight }), snapLayer) : null;
  return content(view.maximized ? store.geometry.canvas : bounds);
}

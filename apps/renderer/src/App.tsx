import { FileCloseDialog } from "./files/FileCloseDialog";
import { ConversationWorkspace } from "./conversationWorkspace/Workspace";
import { initializeConversationClient, resyncConversationClient } from "./conversationWorkspace/client";
import { ShellReadinessContext, useConversationView } from "./conversationWorkspace/Context";
import { DockStore } from "./dock/store";
import { DockProvider } from "./dock/DockContext";
import { WORKBENCH_PANELS } from "./panels/registry";
import { DockFloatingLayer } from "./dock/DockRegions";
import "./dock/dock.css";
import "./dock/menus.css";
import "./dock/integration.css";
import { ExecutionTargets, useExecutionTarget, useTargetMemory } from "./workspaces/ExecutionTargets";
import { RemoteScopeNotice } from "./workspaces/RemoteScopeNotice";
import { modelConfigHasUnsavedChanges } from "./models/modelConfigState";
import { conversationViewLeases } from "./conversation/conversationViews";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ConversationWidthProvider } from "./settings/ConversationWidthContext";
import type { SessionHistoryEntry, SessionHistoryReadModel, StudioClient, WorkspaceId, WorkspaceListReadModel } from "@omp-studio/client-contract";
import { type ClientState } from "@omp-studio/client";
import { clientShellChanged, shouldRecordShellEvent } from "./shellMemory";
import { Icon } from "./icons";
import { I18nProvider, useI18n } from "./i18n";
import { createShellModelLoader } from "./shellModelLoader";
import { TerminalSessionsProvider } from "./terminalSessions";
import { TipHost } from "./TipHost";
import "./agents/agents.css";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { getAppSettings, writeLastRoute } from "./settings/appSettings";
import { OnboardingHost } from "./onboarding/OnboardingTour";
import { type ClientStateSource, type Route } from "./workbench/types";
import { asError, initialRouteFromSettings, notifyFromEvent, reduce, unavailableBootstrap } from "./workbench/shellState";
import { Titlebar } from "./workbench/Titlebar";
import { AppShell } from "./workbench/AppShell";

export { runtimeSettingsPropsOf } from "./workbench/sessionActions";

export { planSaveAndQuitNotice } from "./workbench/sessionActions";

export { canStartPlanSaveAndQuit } from "./workbench/sessionActions";

export { AppMenu } from "./workbench/menus";

export { Unavailable } from "./workbench/Titlebar";

export { shouldOpenLiveProvisional } from "./workbench/sessionActions";

export { RealFileTree } from "./sidebar/WorkspaceTree";

export { AppSidebar } from "./sidebar/AppSidebar";

export function App({ client }: { readonly client: StudioClient }) {
  return <PreviewModeProvider><FileCloseDialog /><ConversationWidthProvider><I18nProvider><TerminalSessionsProvider>{client.supportsContexts === true || (client.supportsContexts === undefined && client.openContext) ? <ExecutionTargets client={client}>{() => <ConversationWorkspace client={client} renderDocument={renderConversationDocument} />}</ExecutionTargets> : <LegacyWorkbench client={client} />}</TerminalSessionsProvider></I18nProvider></ConversationWidthProvider></PreviewModeProvider>;
}

function renderConversationDocument(client: StudioClient) { return <TargetApp client={client} />; }

function LegacyWorkbench({ client }: { client: StudioClient }) {
  const [store] = useState(() => new DockStore());
  return <DockProvider definitions={WORKBENCH_PANELS} store={store}><ExecutionTargets client={client}>{(active, key) => <TargetApp key={key} client={active} />}</ExecutionTargets><DockFloatingLayer /></DockProvider>;
}

function TargetApp({ client: inputClient }: { readonly client: StudioClient }) {
  const mdi = useConversationView();
  const { t } = useI18n();
  const client = inputClient as ClientStateSource;
  const executionTarget = useExecutionTarget();
  const connectionStatus = executionTarget.inventory.statuses.find(status => status.id === executionTarget.id)?.state;
  const connectionRevision = useRef(executionTarget.syncRevision);
  const previousConnectionStatus = useRef(connectionStatus);
  useEffect(() => {
    if (!mdi || mdi.store.demo || executionTarget.id === null) return;
    const previousStatus = previousConnectionStatus.current;
    previousConnectionStatus.current = connectionStatus;
    if (connectionStatus !== "connected") {
      if (connectionStatus === "synchronizing" || connectionStatus === previousStatus) return;
      (client as StudioClient & { transportLost?(reason: string): void }).transportLost?.("SSH 连接已中断；保留对话与草稿，等待重新同步。");
      return;
    }
    if (connectionRevision.current !== executionTarget.syncRevision) {
      connectionRevision.current = executionTarget.syncRevision;
      void resyncConversationClient(client).catch(() => {});
    }
  }, [client, executionTarget.id, executionTarget.syncRevision, connectionStatus]);
  const [committedModelScope, setCommittedModelScope] = useState<string | null>(null);
  const [projectsSettled, setProjectsSettled] = useState(false);
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const cached = mdi?.store.catalog(executionTarget.id), workspaceId = mdi?.document.ref.workspaceId;
    const workspaces = cached && workspaceId ? { ...cached, activeWorkspaceId: workspaceId as WorkspaceId, workspaces: cached.workspaces.map(workspace => ({ ...workspace, active: workspace.workspaceId === workspaceId })) } : cached;
    return { loading: true, model: workspaces ? { workspaces } : {}, events: [], route: "workbench" as const };
  });
  useEffect(() => { if (state.model.workspaces && mdi) mdi.store.rememberCatalog(executionTarget.id, state.model.workspaces); }, [state.model.workspaces, mdi?.store, executionTarget.id]);
  const [targetRoute, setTargetRoute] = useTargetMemory<Route>("route", initialRouteFromSettings);
  const route = mdi?.document.route ?? targetRoute;
  const setRoute = useCallback((next: Route) => {
    if (mdi) mdi.store.updateDocument(mdi.document.id, { route: next });
    else setTargetRoute(next);
  }, [mdi?.store, mdi?.document.id, setTargetRoute]);
  const [selectedHistoryId, setSelectedHistoryId] = useTargetMemory<string | null>("selected-history", () => mdi?.document.ref.historyId ?? null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigate = useCallback((next: Route) => {
    if (next !== routeRef.current && modelConfigHasUnsavedChanges() && !window.confirm("有未保存的模型配置更改，确定离开吗？")) return false;
    routeRef.current = next;
    setRoute(next);
    return true;
  }, [setRoute]);
  const changeHistory = useCallback((history: SessionHistoryReadModel) => dispatch({ type: "model", model: { history } }), []);
  const changeWorkspaces = useCallback((workspaces: WorkspaceListReadModel) => dispatch({ type: "model", model: { workspaces } }), []);
  const selectHistory = useCallback((entry: SessionHistoryEntry) => { if (navigate("workbench")) setSelectedHistoryId(entry.historyId); }, [setSelectedHistoryId, navigate]);
  const newThread = useCallback(() => setSelectedHistoryId(null), [setSelectedHistoryId]);
  const modelLoader = useMemo(() => createShellModelLoader(client), [client]);

  useEffect(() => {
    let cancelled = false;
    const offEvent = client.subscribe({ scope: "all" }, (event) => {
      if (!mdi?.store.demo || mdi.active) notifyFromEvent(event, t);
      if (!cancelled && shouldRecordShellEvent(event)) dispatch({ type: "event", event });
    });
    let lastShell: ClientState | undefined;
    const offState = client.onState?.((clientState) => {
      if (cancelled) return;
      const previous = lastShell;
      lastShell = clientState;
      if (previous !== undefined && !clientShellChanged(previous, clientState)) return;
      dispatch({ type: "state", clientState });
    });
    const load = async () => {
      setCommittedModelScope(null);
      setProjectsSettled(false);
      try {
        const bootstrap = await initializeConversationClient(client);
        if (cancelled) return;
        const clientState = client.getState?.();
        dispatch({ type: "ready", bootstrap, ...(clientState ? { clientState } : {}) });
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: "ready", bootstrap: unavailableBootstrap(), hostError: asError(error) });
          setProjectsSettled(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      offEvent();
      offState?.();
      // The shell owns the injected client. Closing it here kills the singleton
      // (and, over desktop IPC, the Host facade) on Vite HMR / remount, after
      // which every bootstrap fails with "transport is closed".
    };
  }, [client]);

  const runtimeEpoch = state.clientState?.connection.runtimeEpoch;
  useEffect(() => { conversationViewLeases.setEpoch(runtimeEpoch ?? undefined); }, [runtimeEpoch]);
  const runtimeConnection = state.clientState?.connection.runtime;
  const runtimeStatus = runtimeConnection?.status;
  const authorityScope = `${state.clientState?.connection.authorityEpoch ?? "none"}:${executionTarget.syncRevision}`;
  const workspaceId = state.clientState?.entities.residents?.residents.find(row => row.sessionId === state.clientState?.entities.snapshot?.sessionId)?.workspaceId
    ?? state.model.workspaces?.activeWorkspaceId ?? state.clientState?.connection.selected?.workspaceId;
  const workspaceScope = `${authorityScope}:${workspaceId ?? "none"}`;
  const environmentScope = `${authorityScope}:${runtimeConnection?.runtimeVersion ?? "none"}:${runtimeConnection?.upstreamCommit ?? "none"}:${runtimeStatus === "connected" ? "connected" : "unavailable"}`;
  const runtimeScope = `${environmentScope}:${runtimeConnection?.runtimeId ?? "none"}:${runtimeEpoch ?? "none"}`;
  const modelScope = `${workspaceScope}:${runtimeScope}`;
  const modelLoadScope = useMemo(() => ({ authority: authorityScope, workspace: workspaceScope, runtime: runtimeScope, environment: environmentScope, workspaceId, connecting: runtimeStatus === "connecting" }), [authorityScope, workspaceScope, runtimeScope, environmentScope, workspaceId, runtimeStatus]);
  useEffect(() => {
    if (state.loading || state.hostError) return;
    let cancelled = false;
    setCommittedModelScope(null);
    void modelLoader.load(modelLoadScope, routeRef.current,
      model => { if (cancelled) return false; dispatch({ type: "model", model }); return true; },
      () => { if (!cancelled) setProjectsSettled(true); },
    ).then(() => { if (!cancelled) setCommittedModelScope(modelScope); });
    return () => { cancelled = true; };
  }, [modelLoader, modelLoadScope, modelScope, runtimeStatus, state.loading, state.hostError]);
  useEffect(() => {
    if (state.loading || state.hostError) return;
    let cancelled = false;
    void modelLoader.page(modelLoadScope, route, model => {
      if (!cancelled) dispatch({ type: "model", model });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [modelLoader, modelLoadScope, route, runtimeStatus, state.loading, state.hostError]);

  /* 上次页面持久化：供「启动后默认页面 = 上次页面」读取。 */
  useEffect(() => {
    writeLastRoute(route);
  }, [route]);

  /* 启动时恢复最近会话：仅冷启动一次性尝试——无驻留 Runtime 会话、
     用户尚未选择过会话时，选中最近活跃的历史会话。 */
  const sessionRestoreTried = useRef(false);
  useEffect(() => {
    if (sessionRestoreTried.current || state.loading || runtimeStatus === "connecting") return;
    if (mdi?.document.ref.draftId && mdi.document.ref.draftId !== "initial") return;
    if (mdi?.document.ref.sessionId && !selectedHistoryId) {
      const entry = state.model.history?.entries.find(entry => entry.sessionId === mdi.document.ref.sessionId);
      if (entry) { setSelectedHistoryId(entry.historyId); sessionRestoreTried.current = true; }
      return;
    }
    if (state.model.history === undefined && runtimeStatus !== "connected") return;
    sessionRestoreTried.current = true;
    if (!getAppSettings().restoreLastSession) return;
    if (selectedHistoryId !== null) return;
    if (state.clientState?.connection.runtime?.status === "connected") return;
    const entry = state.model.history?.entries[0];
    if (entry !== undefined) setSelectedHistoryId(entry.historyId);
  }, [state.loading, state.clientState, state.model.history, selectedHistoryId, runtimeStatus]);

  const routedState = useMemo(() => ({ ...state, route, model: { ...state.model, ...(state.model.environment && runtimeConnection ? { environment: { ...state.model.environment, runtime: runtimeConnection } } : {}) } }), [state, route, runtimeConnection]);
  const body = state.loading && !mdi ? (
    <div className="app">
      <Titlebar />
      <div className="main-col">
        <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
          <span className="spinner" />
          <h1>Connecting</h1>
          <p className="muted">Requesting bootstrap…</p>
        </div>
      </div>
    </div>
  ) : state.error && state.bootstrap === undefined ? (
    <div className="app">
      <Titlebar />
      <div className="main-col">
        <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
          <Icon name="alert" extra="lg" />
          <h1>Bootstrap failed</h1>
          <p><span className="mono">{state.error.code}</span> {state.error.message}</p>
        </div>
      </div>
    </div>
  ) : (
    <AppShell
      healthReady={committedModelScope === modelScope && !state.loading && runtimeStatus !== "connecting"}
      state={routedState}
      client={client}
      onRoute={navigate}
      selectedHistoryId={selectedHistoryId}
      onSelectThread={selectHistory}
      onNewThread={newThread}
      projectsLoading={!projectsSettled}
      onWorkspacesChange={changeWorkspaces}
      onHistoryChange={changeHistory}
    />
  );
  return (
    <>
        <RemoteScopeNotice />
        <ShellReadinessContext.Provider value={!state.loading}>{body}</ShellReadinessContext.Provider>
        {(!mdi || mdi.active) ? <OnboardingHost /> : null}
        <TipHost />
    </>
  );
}

import { useWorkspaceFileActions } from "../files/useWorkspaceFileActions";
import { ConversationTitleSurface, SharedSurface, useConversationView, useConversationDom } from "../conversationWorkspace/Context";
import { EvaluationActivity } from "../evaluation/EvaluationActivity";
import { useDock } from "../dock/DockContext";
import { DockViewMenu } from "../dock/DockMenus";
import { locatePanel } from "../dock/model";
import { type DockScope, type PanelId } from "../dock/types";
import { DeferredPanel, lazyPanel } from "../DeferredPanel";
import { useModelConnection } from "../models/useModelConnection";
import { useExecutionTarget, useTargetMemory } from "../workspaces/ExecutionTargets";
import { SecondaryInteractionDeck } from "../deck/SecondaryInteractionDeck";
import { AnnotationsProvider } from "../annotations/Annotations";
import { setCapIntent, setModelConfigIntent, setSettingsIntent, setDiagnosticsIntent } from "../pageIntents";
import { modelConfigHasUnsavedChanges } from "../models/modelConfigState";
import { WorkbenchHealth } from "../WorkbenchHealth";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyTypography } from "../settings/typography";
import { useWorkbenchLayout } from "../layout/useWorkbenchLayout";
import { beforeConversationLayoutChange } from "../conversation/conversationReflow";
import { layoutPanelForRegion, type DockRegion } from "../layout/workbenchLayout";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type { CommandName, CommandInput, OperatorInvokeOutcome, SessionHistoryEntry, SessionHistoryReadModel, SessionId, ThreadId, StudioRuntimeSettingKey, StudioRuntimeSettingValue, WorkspaceId, WorkspaceListReadModel } from "@omp-studio/client-contract";
import type { ApprovalMode, OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { AppIcon, Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";
import { SHORTCUTS, formatShortcut, isPrimaryModifier } from "../keyboard/shortcuts";
import { nativeMenuOwnsShortcuts } from "../platform";
import { HomePage, SecondaryPage } from "../HomePage";
import { HistoryPage } from "../HistoryPage";
import { type ChipComposerHandle } from "../composer/ChipComposer";
import { bindSlashTypedCommand, isDestructiveMemoryClear, resolveSlashExecute, type SlashNativeUi, type StudioSlashCommand } from "../composer/commands";
import { composerOwnerSessionId } from "../composer/dispatch";
import { createWorkspaceFileIndex, loadMentions, previewMentions, workspaceDirectoryLister } from "../composer/mentions";
import { createComposerDraftBook } from "../composer/draftStore";
import { type ComposerSnapshot } from "../composer/types";
import type { FileViewerActions } from "../files/fileActions";
import { mergeUsedSkills } from "../skills/skillUsage";
import { RuntimeLossBanner } from "../RuntimeLossBanner";
import { ToastHost } from "../ToastHost";
import { compactNoticeFromOutput } from "../compactNotice";
import { CommandPalette, type CommandPaletteHandle } from "../CommandPalette";
import { buildPaletteGroups, type BottomTab, type PaletteAction, type SideTab } from "../commandPaletteCatalog";
import { toDrawerItems } from "../extensibilityMap";
import { countEnabledDrawerItems, createPreviewDrawerItems, type DrawerItem } from "../skillsPreview";
import { pagePhaseClass, useDeferredKey } from "../pageTransition";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePersistedSessionAgents } from "../conversation/persistedSessionAgents";
import { getDefaultThumbStore } from "../conversation/userMessageThumbs";
import { usePreviewMode } from "../preview/PreviewContext";
import { BackgroundProvider } from "../background/BackgroundProvider";
import { AppBackgroundLayer } from "../background/AppBackgroundLayer";
import { useAppSettings } from "../settings/appSettings";
import { applyTheme } from "../themeTransition";
import { desktopNotice } from "../settings/desktopNotice";
import { openOnboardingTour } from "../onboarding/onboardingState";
import { AppUpdateDialog } from "../AppUpdateDialog";
import { AppNavRail, type NavRailRoute } from "../NavRail";
import { useIdentityFlight } from "../useIdentityFlight";
import { useAppUpdate } from "../settings/appUpdate";
import { useOperatorProfile } from "../settings/operatorProfile";
import { PREVIEW_APP_UPDATE, defaultPreviewSelection, findPreviewProject, findPreviewThread } from "../preview/fixtures";
import { PREVIEW_BTW_QUESTION, PREVIEW_BTW_SNAPSHOTS, previewBtwSnapshot } from "../preview/btwPreview";
import { useBtwSession } from "../btw/useBtwSession";
import { usableCapabilityManifest } from "../deck/interactionGate";
import { residentForSession } from "../sidebar/threadRunning";
import { sidebarProjectOrder } from "../sidebar/projectOrder";
import { readExpandedProjects, writeExpandedProjects } from "../sidebar/expandMemory";
import { isPlaceholderSessionTitle, reconcileProvisionalProjectThread, resolveProvisionalHistoryTitle, type ProvisionalProjectThread } from "../sidebar/provisionalThread";
import { workspaceForSession } from "../sidebar/sessionTitle";
import { type ThreadWaitKind } from "../sidebar/threadWait";
import { streamingProjectHistoryRefreshKey, useProjectHistories } from "../sidebar/useProjectHistories";
import { createResumeGenerationGate, ensureSelectedSessionActive, type NewSessionWaitResult } from "../sessionLifecycle";
import { createSerialTaskQueue } from "../workspaceActionQueue";
import { StatisticsPage } from "../StatisticsPage";
import { type ArchivePending, type ClientStateSource, type ProjectShellActionResult, type Route, type SecondaryRoute, type ShellChrome, type ShellDialog, type ThreadRowActionKind, type ViewState } from "./types";
import { CURRENT_PROJECT, PROJECT_THREADS_INITIAL, PROJECT_THREADS_PAGE, PROJECT_THREADS_QUERY_MAX, type SelectedProject } from "./sessionSelection";
import { SECONDARY_META, isSecondary, snapshotFrom } from "./shellState";
import { archiveConfirmIsStreaming, runtimeSettingsPropsOf, shouldOpenLiveProvisional } from "./sessionActions";
import { TitleMenu, execEditCommand, type EditCommand } from "./menus";
import { setSlashUiIntent } from "./slashUiIntent";
import { Titlebar } from "./Titlebar";
import { AppSidebar } from "../sidebar/AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { WorkbenchCanvas } from "./WorkbenchCanvas";
import { clampBottomHeight } from "./BottomPanelChrome";
import { useSessionRename } from "../history/useSessionRename";

const EvaluationPage = lazyPanel(() => import("../evaluation/EvaluationPage").then(module => ({ default: module.EvaluationPage })));

const MediaPage = lazyPanel(() => import("../MediaPage").then(module => ({ default: module.MediaPage })));

const AgentHubPage = lazyPanel(() => import("../AgentHub").then(module => ({ default: module.AgentHubPage })));

const CapabilitiesPage = lazyPanel(() => import("../CapabilitiesPage").then(module => ({ default: module.CapabilitiesPage })));

const ModelConfigPage = lazyPanel(() => import("../ModelConfigPage").then(module => ({ default: module.ModelConfigPage })));

const SettingsPage = lazyPanel(() => import("../SettingsPage").then(module => ({ default: module.SettingsPage })));

const DiagnosticsPage = lazyPanel(() => import("../DiagnosticsPage").then(module => ({ default: module.DiagnosticsPage })));

/** 稳定的空 residents 列表：`?? []` 会让依赖它的 effect 每帧重跑。 */
const NO_RESIDENT_ROWS: readonly never[] = [];

/** 导航面包屑保留的最大深度：只增不减的数组，路由对象虽小也不该无界。 */
const TRAIL_MAX = 100;

export function AppShell({ state, client, healthReady, onRoute, selectedHistoryId, onSelectThread, onNewThread, projectsLoading, onWorkspacesChange, onHistoryChange }: {
  state: ViewState;
  healthReady: boolean;
  /** projects.list has not answered yet: the sidebar shows loading, not "no projects". */
  projectsLoading: boolean;
  client: ClientStateSource;
  onRoute: (route: Route) => boolean;
  selectedHistoryId: string | null;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  onNewThread: () => void;
  onWorkspacesChange: (workspaces: WorkspaceListReadModel) => void;
  onHistoryChange: (history: SessionHistoryReadModel) => void;
}) {
  const { document, window } = useConversationDom();
  const mdi = useConversationView();
  const [evaluationIntent, setEvaluationIntent] = useState<{id: string; kind: import("@omp-studio/studio-protocol").EvaluationKind}>();
  const { t } = useI18n();
  const executionTarget = useExecutionTarget();
  const previewMode = usePreviewMode();
  const modelClient = (executionTarget.localClient ?? client) as ClientStateSource;
  const modelConnection = useModelConnection(modelClient);
  const appUpdate = useAppUpdate();
  const { profile } = useOperatorProfile();
  const effectiveUpdate = previewMode.preview ? PREVIEW_APP_UPDATE : (appUpdate.state.updateInfo?.available ? appUpdate.state.updateInfo : null);
  const [showAppUpdateDialog, setShowAppUpdateDialog] = useState(false);
  const [localAppVersion, setLocalAppVersion] = useState<string | null>(null);
  useEffect(() => {
    if (previewMode.preview) return;
    let disposed = false;
    void globalThis.ompStudioChrome?.getAppVersion?.().then((info) => {
      if (!disposed) setLocalAppVersion(info.version);
    }).catch(() => {});
    void appUpdate.check(true);
    return () => { disposed = true; };
  }, [previewMode.preview, appUpdate.check]);
  const previewOn = () => previewMode.preview;
  const dock = useDock();
  const collapsed = mdi ? !mdi.store.getSnapshot().sidebarVisible : !dock.layout.left.visible;
  const setCollapsed = (value: boolean) => { if (mdi) mdi.store.shared({ sidebarVisible: !value }); dock.store.dispatch({ type: "region", region: "left", visible: !value }); };
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsEnabledCount, setSkillsEnabledCount] = useState(() => previewOn() ? countEnabledDrawerItems(createPreviewDrawerItems()) : 0);
  const [explorerOpen, setExplorerOpen] = useState(() => previewOn());
  /** Real projects may be expanded together; preview keeps its fixture selection below.
      启动时按本地记忆恢复各项目展开状态；从未写过记忆时保持旧行为（首启展开活动项目）。 */
  const [expandedProjectsMemory] = useState(readExpandedProjects);
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => (expandedProjectsMemory.restored ? expandedProjectsMemory.ids : new Set<string>()),
  );
  const [projectListExpanded, setProjectListExpanded] = useState(true);
  const [selectedProject, setSelectedProject] = useState<SelectedProject | null>(() => previewOn() ? CURRENT_PROJECT : null);
  const composerRef = useRef<ChipComposerHandle | null>(null);
  const [composerInsertion, setComposerInsertion] = useState<{ owner: string | undefined; text: string }>();
  const clearComposerInsertion = useCallback(() => setComposerInsertion(undefined), []);
  const [selectedProvisionalSessionId, setSelectedProvisionalSessionId] = useTargetMemory<string | undefined>("provisional-session", () => undefined);
  const [dockSelection, setDockSelection] = useTargetMemory<DockScope>("dock-selection", () => {
    const selected = state.bootstrap?.selected ?? mdi?.document.ref;
    return { target: executionTarget.id ?? "local", project: selected?.workspaceId ?? state.model.workspaces?.activeWorkspaceId ?? null, session: selected?.sessionId ?? "draft:initial", ...(!selected?.sessionId ? { draft: true } : {}) };
  });
  const dockSelectionRef = useRef(dockSelection);
  const initialDockSelection = useRef(true);
  const [freshView, setFreshView] = useState(0);
  const previewRef = useRef(previewMode.preview);
  previewRef.current = previewMode.preview;
  dockSelectionRef.current = dockSelection;
  const commitDockSelection = useCallback((scope: DockScope) => {
    initialDockSelection.current = false;
    dockSelectionRef.current = scope;
    if (!previewRef.current) dock.store.switchScope(scope, false);
    setDockSelection(scope);
  }, [dock.store, setDockSelection]);
  const beginDockDraft = useCallback((project: string | null) => {
    initialDockSelection.current = false;
    const scope: DockScope = { target: executionTarget.id ?? "local", project, session: `draft:${crypto.randomUUID()}`, draft: true };
    dock.store.beginDraft(scope);
    setFreshView(value => value + 1);
    dockSelectionRef.current = scope;
    setDockSelection(scope);
    return scope;
  }, [dock.store, executionTarget.id, setDockSelection]);
  /* 每个会话的草稿快照不进 React state：击键时写 state 会把整个 AppShell
     （58 处 state）按字符重渲一次。草稿只在「挂载/切会话恢复」边界被读，
     用 ref 簿记即可（`composer/draftStore.ts`）。 */
  const [composerDraftBook] = useTargetMemory("composer-drafts", () => {
    const book = createComposerDraftBook();
    executionTarget.memory.set("composer-drafts", book);
    return book;
  });
  const [draftSkills, setDraftSkills] = useState<ReadonlySet<string>>(() => new Set());
  const [usedSkills, setUsedSkills] = useState<ReadonlySet<string>>(() => new Set());
  const usedSkillsIdentityRef = useRef("");
  const onDraftSkillsChange = useCallback((names: ReadonlySet<string>) => {
    setDraftSkills(names);
  }, []);
  const onUsedSkillsChange = useCallback((identityKey: string, names: ReadonlySet<string>) => {
    if (usedSkillsIdentityRef.current !== identityKey) {
      usedSkillsIdentityRef.current = identityKey;
      setUsedSkills(names);
      return;
    }
    setUsedSkills((prev) => mergeUsedSkills(prev, names));
  }, []);
  const onComposerDraftChange = useCallback((sessionId: string, draft: ComposerSnapshot) => {
    composerDraftBook.set(sessionId, draft);
  }, [composerDraftBook]);
  useEffect(() => {
    if (selectedHistoryId !== null) setSelectedProvisionalSessionId(undefined);
  }, [selectedHistoryId]);
  /** 各项目当前展开的会话条数；折叠会话列表时清掉对应键回到默认 6 条。 */
  const [projectThreadLimits, setProjectThreadLimits] = useState<Record<string, number>>({});
  const projectHistories = useProjectHistories({ client, preview: previewMode.preview, shared: mdi?.store.history(executionTarget.id) });
  const {
    cache: projectHistoryCache,
    load: loadProjectHistory,
    refresh: refreshProjectHistory,
    loadMore: loadMoreProjectHistory,
  } = projectHistories;
  const expandProject = useCallback((workspaceId: string) => {
    setExpandedProjects((current) => {
      if (current.has(workspaceId)) return current;
      const next = new Set(current);
      next.add(workspaceId);
      return next;
    });
  }, []);
  const collapseProject = useCallback((workspaceId: string) => {
    setExpandedProjects((current) => {
      if (!current.has(workspaceId)) return current;
      const next = new Set(current);
      next.delete(workspaceId);
      return next;
    });
  }, []);
  /* 项目展开状态本地记忆：真实模式随变更写入；预览模式不写（见 expandMemory）。 */
  useEffect(() => {
    if (previewMode.preview) return;
    writeExpandedProjects(expandedProjects);
  }, [expandedProjects, previewMode.preview]);
  /** 预览模式「归档」演示隐藏的会话 id（仅本地，不碰 Host）。 */
  const [hiddenPreviewThreads, setHiddenPreviewThreads] = useState<ReadonlySet<string>>(() => new Set());
  /** 历史页的全量会话模型（含已归档）；进入历史页时懒加载，归档动作后刷新。 */
  const [historyAll, setHistoryAll] = useState<SessionHistoryReadModel | undefined>(undefined);
  const initialPreview = defaultPreviewSelection();
  const [previewProjectId, setPreviewProjectId] = useState(mdi?.document.ref.previewProjectId ?? initialPreview.projectId);
  const [previewThreadId, setPreviewThreadId] = useState(mdi?.document.ref.previewThreadId ?? initialPreview.threadId);
  const [previewDeckWait, setPreviewDeckWait] = useState<ThreadWaitKind | undefined>("plan");
  const { settings: appSettings, update: updateAppSettings } = useAppSettings();
  const theme = appSettings.theme;
  useLayoutEffect(() => { if (!mdi || mdi.active) applyTypography(appSettings); }, [mdi?.active, appSettings.uiFontFamily, appSettings.uiFontSize, appSettings.terminalFontFamily, appSettings.terminalFontSize, appSettings.outputFontFamily, appSettings.outputFontSize]);
  const sidebarWidth = mdi?.store.getSnapshot().sidebarWidth ?? dock.layout.left.width;
  const splitRatio = dock.layout.left.ratio;
  const sideOpen = dock.layout.right.visible;
  const bottomOpen = dock.layout.bottom.expanded;
  const bottomVisible = dock.layout.bottom.visible;
  const panelWidth = mdi?.store.getSnapshot().panelWidth ?? dock.layout.right.size;
  const bottomHeight = mdi?.store.getSnapshot().bottomHeight ?? dock.layout.bottom.size;
  const resizeRegion = (region: "left" | "right" | "bottom", size: number) => {
    if (dock.store.getSnapshot().preferences.locked) return;
    if (mdi) mdi.store.shared(region === "left" ? { sidebarWidth: size } : region === "right" ? { panelWidth: size } : { bottomHeight: size });
    dock.store.dispatch({ type: "resize", region, size });
  };
  const setSidebarWidth = (size: number) => resizeRegion("left", size);
  const setSplitRatio = (ratio: number) => dock.store.dispatch({ type: "resize", region: "left", ratio });
  const setSideOpen = (visible: boolean) => dock.store.dispatch({ type: "region", region: "right", visible });
  const setBottomOpen = (expanded: boolean) => dock.store.dispatch({ type: "bottomExpanded", expanded });
  const setBottomVisible = (visible: boolean) => dock.store.dispatch({ type: "region", region: "bottom", visible });
  const setPanelWidth = (size: number) => resizeRegion("right", size);
  const setBottomHeight = (size: number) => resizeRegion("bottom", size);
  const setSideTab = (tab: SideTab) => dock.store.dispatch({ type: "open", panel: tab === "preview" ? "browser" : tab });
  const setBottomTab = (tab: BottomTab) => dock.store.dispatch({ type: "open", panel: tab });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [sessionActionError, setSessionActionError] = useState<string | undefined>(undefined);
  /** 后台 session.create 进行中：欢迎区先出现，composer 可输入；发送时再等这条 Promise。 */
  const [creatingSession, setCreatingSession] = useState(false);
  const [provisionalThreadsBySession, setProvisionalThreadsBySession] = useState<
    Readonly<Record<string, ProvisionalProjectThread>>
  >({});
  /** Prevent a late Workbench effect from resurrecting a successfully archived row. */
  const archivedProvisionalSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  /** In-flight unarchive commands; a second click on the same row is a no-op. */
  const unarchiveBusyThreadIdsRef = useRef<ReadonlySet<string>>(new Set());
  /** 左上菜单「新建项目」：递增后 WorkbenchCanvas 打开已有创建项目对话框。 */
  const [createProjectNonce, setCreateProjectNonce] = useState(0);
  const sessionCreateWaitRef = useRef<Promise<NewSessionWaitResult> | null>(null);
  const [shellNotice, setShellNotice] = useState<{ text: string; icon: IconName } | null>(null);
  const [compactPending, setCompactPending] = useState(false);
  /** 用户在压缩回执落地前点了「取消」：压缩命令回执完成后按取消提示，不再误报成功。 */
  const compactCancelRequestedRef = useRef(false);
  const [telemetryRefreshToken, setTelemetryRefreshToken] = useState(0);
  const refreshViewedTelemetry = useCallback(() => {
    setTelemetryRefreshToken((value) => value + 1);
  }, []);
  const [paletteInventory, setPaletteInventory] = useState<DrawerItem[]>([]);
  const paletteRef = useRef<CommandPaletteHandle>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [ompMenuOpen, setOmpMenuOpen] = useState(false);
  const ompMenuAnchorRef = useRef<HTMLButtonElement>(null);
  /** 左栏（rail）折叠态：归壳持有，因为收起后头像要回落到侧栏底部。 */
  const [localRailCollapsed, setLocalRailCollapsed] = useState(false);
  const railCollapsed = mdi?.store.getSnapshot().railCollapsed ?? localRailCollapsed;
  const setRailCollapsed = (value: boolean | ((previous: boolean) => boolean)) => { const next = typeof value === "function" ? value(railCollapsed) : value; if (mdi) mdi.store.shared({ railCollapsed: next }); else setLocalRailCollapsed(next); };
  /* 头像在两处之间搬家时由固定层的「幽灵」承载：它落在目标头像的矩形上，所以
     两处真身不必同时可见，也不会跟着侧栏整体位移滑进来。 */
  const railAvatarRef = useRef<HTMLElement | null>(null);
  const footerAvatarRef = useRef<HTMLElement | null>(null);
  const footerBoxRef = useRef<HTMLElement | null>(null);
  const identityFlight = useIdentityFlight({ collapsed: railCollapsed, profile, railAvatarRef, footerAvatarRef, footerRef: footerBoxRef });
  const setRailCollapsedWithFlight = (next: boolean) => {
    /* 先量源头像，再改状态：改完它就被 56px 的裁切带走了。 */
    identityFlight.begin(next);
    setRailCollapsed(next);
  };
  /* 收起会把锚点按钮搬到侧栏底部，留着打开的菜单会停在旧位置。 */
  useEffect(() => {
    if (!railCollapsed) return;
    setOmpMenuOpen((value) => (value ? false : value));
  }, [railCollapsed]);
  const [dialog, setDialog] = useState<ShellDialog | null>(null);
  /** 归档确认弹窗：点「归档」只打开此窗，确认后才执行预览隐藏或 session.archive。 */
  const [archivePending, setArchivePending] = useState<ArchivePending | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);
  const [trail, setTrail] = useState<Route[]>([state.route]);
  const lastPageRoute = useRef<SecondaryRoute>("home");
  const workspaceActionQueue = useMemo(() => createSerialTaskQueue(), []);
  const navigationGate = useMemo(() => createResumeGenerationGate(), []);
  useEffect(() => {
    if (state.route === "home") navigationGate.next();
  }, [navigationGate, state.route]);
  if (isSecondary(state.route)) lastPageRoute.current = state.route;
  const wantPage = isSecondary(state.route) && (!mdi || mdi.active);
  const { shown: showPage, phase: shellPhase } = useDeferredKey(wantPage);
  const workbenchHidden = showPage && (!mdi || mdi.view?.placement === "main");
  useLayoutEffect(() => { if (mdi) mdi.store.updateDocument(mdi.document.id, { page: showPage, pagePhase: shellPhase }); }, [mdi?.store, mdi?.document.id, showPage, shellPhase]);
  const pageRoute = isSecondary(state.route) ? state.route : lastPageRoute.current;
  const pageMeta = SECONDARY_META[pageRoute];
  const shellClass = pagePhaseClass(shellPhase);
  const layout = useWorkbenchLayout({ collapsed: mdi ? true : collapsed, sidebarWidth, sideOpen: mdi ? false : sideOpen, panelWidth, bottomVisible: mdi ? false : bottomVisible, bottomOpen, bottomHeight, railMode: dock.layout.rail.mode, railWidth: dock.layout.rail.width }, !workbenchHidden);
  const toggleSidebar = useCallback(() => {
    beforeConversationLayoutChange();
    // Closing a panel releases only its own priority: a narrow window may be
    // showing the right panel as a drawer, and collapsing the sidebar must not
    // hand that drawer's priority back to the layout solver.
    if (mdi ? !collapsed : layout.sidebarShown) { setCollapsed(true); layout.releaseFocus("sidebar"); }
    else { setCollapsed(false); layout.focusPanel("sidebar"); }
  }, [collapsed, mdi, layout.sidebarShown, layout.focusPanel, layout.releaseFocus]);
  const openSide = useCallback(() => {
    beforeConversationLayoutChange();
    setSideOpen(true);
    layout.focusPanel("side");
  }, [layout.focusPanel]);
  const closeSide = useCallback(() => {
    beforeConversationLayoutChange();
    setSideOpen(false);
    layout.releaseFocus("side");
  }, [layout.releaseFocus]);
  const toggleSide = useCallback(() => {
    if (mdi ? sideOpen : layout.sideShown) closeSide();
    else openSide();
  }, [mdi, sideOpen, layout.sideShown, closeSide, openSide]);
  const changeBottomOpen = useCallback((open: boolean) => {
    beforeConversationLayoutChange();
    setBottomOpen(open);
    if (open) { setBottomVisible(true); layout.focusPanel("bottom"); }
    else layout.releaseFocus("bottom");
  }, [layout.focusPanel, layout.releaseFocus]);
  const changeBottomVisible = useCallback((visible: boolean) => {
    beforeConversationLayoutChange();
    setBottomVisible(visible);
    if (visible && !layout.bottomVisible) {
      setBottomOpen(true);
      layout.focusPanel("bottom");
    } else if (visible && layout.bottomOpen) {
      layout.focusPanel("bottom");
    } else {
      layout.releaseFocus("bottom");
    }
  }, [layout.bottomVisible, layout.bottomOpen, layout.focusPanel, layout.releaseFocus]);
  const toggleBottom = useCallback(() => {
    if (!(mdi ? bottomVisible : layout.bottomVisible) || !(mdi ? bottomOpen : layout.bottomOpen)) {
      setBottomVisible(true);
      changeBottomOpen(true);
      return;
    }
    changeBottomOpen(false);
  }, [mdi, bottomVisible, bottomOpen, layout.bottomVisible, layout.bottomOpen, changeBottomOpen]);
  useEffect(() => {
    const open = (event: Event) => {
      const panel = (event as CustomEvent<{ panel: PanelId }>).detail.panel;
      const location = locatePanel(dock.store.getSnapshot().layout, panel);
      layout.focusPanel(location?.region === "left" ? "sidebar" : location?.region === "right" ? "side" : location?.region === "bottom" ? "bottom" : null);
    };
    window.addEventListener("omp:dock-open", open);
    return () => window.removeEventListener("omp:dock-open", open);
  }, [dock.store, layout.focusPanel]);
  /* dock-engine 的 region 动作（视图菜单勾选、快捷键、拖拽入坞）提交后广播。
     菜单路径过去只改 `dock.layout.*.visible`，没给布局求解器聚焦优先级，
     窄窗下 `fitWorkbench` 会把这个刚打开的侧栏裁掉。这里复用顶栏按钮同一条
     机制：可见 → 抢优先级；不可见 → 只释放它自己那一个。 */
  useEffect(() => {
    const region = (event: Event) => {
      const detail = (event as CustomEvent<{ region?: DockRegion; visible?: boolean }>).detail;
      if (detail === undefined || detail.region === undefined) return;
      if (mdi && detail.region === "left") mdi.store.shared({ sidebarVisible: detail.visible === true });
      const panel = layoutPanelForRegion(detail.region);
      if (panel === null) return;
      if (detail.visible === true) layout.focusPanel(panel);
      else layout.releaseFocus(panel);
    };
    window.addEventListener("omp:dock-region", region);
    return () => window.removeEventListener("omp:dock-region", region);
  }, [layout.focusPanel, layout.releaseFocus]);
  const [trailAt, setTrailAt] = useState(0);
  const [capNonce, setCapNonce] = useState(0);
  const [settingsNonce, setSettingsNonce] = useState(0);
  const [mcNonce, setMcNonce] = useState(0);
  const snapshot = snapshotFrom(state);
  const pendingInteraction = state.clientState?.interaction.pending ?? null;
  const residentModel = state.clientState?.entities.residents;
  // `?? []` 每次渲染都是新数组身份，而下面两个通知 effect 都依赖它 ——
  // 流式期间没有 resident 模型时会每帧重建一次 setTimeout。用模块级常量。
  const residentRows = residentModel?.residents ?? NO_RESIDENT_ROWS;
  const runtime = state.clientState?.connection.runtime ?? state.bootstrap?.runtime;
  const capabilities = usableCapabilityManifest(
    state.model.capabilities,
    state.clientState?.connection.capabilityManifest,
    state.bootstrap?.capabilityManifest,
  );
  const environment = state.model.environment;
  const hubWorkspaceId = previewMode.preview ? undefined : selectedProject?.id;
  const hubFileIndex = useMemo(
    () => (previewMode.preview || hubWorkspaceId === undefined
      ? undefined
      : createWorkspaceFileIndex(workspaceDirectoryLister(client, hubWorkspaceId as WorkspaceId))),
    [previewMode.preview, client, hubWorkspaceId],
  );
  const fetchHubMentions = useCallback(async (trigger: "@" | "/" | "^", query: string) => {
    if (trigger === "/") return [];
    if (previewMode.preview) return previewMentions(trigger, query);
    try {
      return await loadMentions(client, trigger, query, hubFileIndex);
    } catch {
      return [];
    }
  }, [previewMode.preview, client, hubFileIndex]);
  const selected = state.model.history?.entries.find((entry) => entry.historyId === selectedHistoryId)
    ?? historyAll?.entries.find((entry) => entry.historyId === selectedHistoryId)
    ?? Object.values(projectHistoryCache).flatMap((historyState) => historyState.model?.entries ?? [])
      .find((entry) => entry.historyId === selectedHistoryId);
  const viewedSessionId = selected?.sessionId ?? snapshot?.sessionId;
  const btwTargetId = selectedProvisionalSessionId ?? viewedSessionId;
  const btwTargetRef = useRef({ sessionId: btwTargetId, threadId: selected?.threadId });
  btwTargetRef.current = { sessionId: btwTargetId, threadId: selected?.threadId };
  const prepareBtwTarget = useCallback(async () => {
    const target = btwTargetRef.current;
    await ensureSelectedSessionActive(client, {
      ...(client.getState?.()?.entities.snapshot?.sessionId ? { activeSessionId: client.getState().entities.snapshot!.sessionId } : {}),
      ...(target.sessionId ? { selectedSessionId: target.sessionId as SessionId } : {}),
      ...(target.threadId ? { selectedThreadId: target.threadId } : {}),
    });
    if (target.sessionId !== btwTargetRef.current.sessionId) throw new Error("已切换会话，请在当前会话重新提问");
  }, [client]);
  /* BTW 旁路问答：状态挂在 AppShell 而不是 WorkbenchCanvas —— 回首页会卸载
     WorkbenchCanvas，浮窗不该跟着消失。演示轮次只改本地 UI，不碰 Host。 */
  const [btwDemoRound, setBtwDemoRound] = useState(1);
  const btwOnBranchedRef = useRef<(sessionId: string) => Promise<boolean>>(async () => false);
  const btwSession = useBtwSession({
    ...(btwTargetId ? { sessionId: btwTargetId } : {}),
    targetActive: !btwTargetId || btwTargetId === snapshot?.sessionId,
    prepareTarget: prepareBtwTarget,
    snapshot: previewMode.preview
      ? previewBtwSnapshot(btwDemoRound)
      : (state.clientState?.entities.btw ?? null),
    client,
    preview: previewMode.preview,
    previewQuestion: PREVIEW_BTW_QUESTION,
    mainStreaming: !previewMode.preview && snapshot?.isStreaming === true,
    canCommand: snapshot !== undefined && runtime?.status === "connected",
    onBranched: async (sessionId) => {
      await btwOnBranchedRef.current(sessionId);
    },
  });
  const previousBtw = useRef<typeof btwSession.snapshot>(null);
  useEffect(() => {
    const current = state.clientState?.entities.btw ?? null;
    const previous = previousBtw.current;
    previousBtw.current = current;
    if (!previewMode.preview && current?.status === "completed" && previous?.status === "running"
      && current.ephemeralId === previous.ephemeralId && !dock.hosts.get("btw").snapshot().visible) {
      setShellNotice({ text: t("btw.answerReady"), icon: "check" });
    }
  }, [state.clientState?.entities.btw?.status, state.clientState?.entities.btw?.ephemeralId, previewMode.preview, dock.hosts, t]);
  /** Approval mode for Settings → Permissions (plan §5.6); never optimistic. */
  const approvalMode: ApprovalMode = snapshot?.approvalMode ?? "yolo";
  const setApprovalMode = useCallback(
    (mode: ApprovalMode) => {
      if (snapshot === undefined) return;
      void (async () => {
        try {
          const handle = await client.command("permissions.mode.set", { mode });
          const result = await waitReceipt<{
            readonly syncStatus?: "complete" | "partial";
            readonly failedSessions?: number;
          }>(client, handle.requestId);
          if (result.syncStatus === "partial") {
            setSessionActionError(`权限模式仅同步到部分 Runtime（${result.failedSessions ?? 0} 个失败），请稍后重试。`);
            return;
          }
          setSessionActionError(undefined);
        } catch (error) {
          setSessionActionError(hostErrorMessage(error, "切换权限模式失败"));
        }
      })();
    },
    [client, snapshot],
  );
  /** Settings → Permissions: clear every remembered approval (`/forget-approvals`). */
  const forgetApprovals = useCallback(async () => {
    if (snapshot === undefined) throw new Error("No Runtime session");
    const handle = await client.command("approvals.forget", { sessionId: snapshot.sessionId });
    await waitReceipt(client, handle.requestId);
  }, [client, snapshot]);
  const runtimeSettingsCanSet = (() => {
    const entry = capabilities?.capabilities.find((capability) => capability.id === "runtime.settings.set");
    if (!entry || entry.grade === "unavailable") return false;
    if (state.clientState?.connection.resyncRequired) return false;
    if (runtime?.classification === "limited-system") return false;
    return true;
  })();
  const setRuntimeSetting = useCallback(async (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist = true): Promise<void> => {
    const input = { key, value, persist } as CommandInput<"runtime.settings.set">;
    const handle = await client.command("runtime.settings.set", input);
    await waitReceipt(client, handle.requestId);
  }, [client]);
  const runtimeSettings = runtimeSettingsPropsOf(snapshot, runtimeSettingsCanSet, setRuntimeSetting);
  useLayoutEffect(() => {
    if (state.loading && !previewMode.preview) return;
    if (previewMode.preview) {
      dock.store.switchScope({ target: "preview", project: previewProjectId, session: previewThreadId }, true);
      return;
    }
    let scope = dockSelectionRef.current;
    if (initialDockSelection.current && !creatingSession && selectedHistoryId === null) {
      const session = state.clientState?.connection.selected?.sessionId ?? state.bootstrap?.selected.sessionId ?? snapshot?.sessionId;
      const project = state.model.workspaces?.activeWorkspaceId ?? state.bootstrap?.selected.workspaceId ?? scope.project;
      if (session && (scope.session !== session || scope.project !== project)) {
        scope = { target: executionTarget.id ?? "local", project, session };
        dockSelectionRef.current = scope;
        setDockSelection(scope);
      }
      if (session && project) initialDockSelection.current = false;
    }
    if (!creatingSession && selected?.sessionId && selected.sessionId !== scope.session) {
      scope = { target: executionTarget.id ?? "local", project: residentRows.find(row => row.sessionId === selected.sessionId)?.workspaceId ?? selectedProject?.id ?? scope.project, session: selected.sessionId };
      dockSelectionRef.current = scope;
      setDockSelection(scope);
    }
    dock.store.switchScope(scope, false);
  }, [dock.store, dockSelection, previewMode.preview, previewProjectId, previewThreadId, selected?.sessionId, creatingSession, executionTarget.id, snapshot?.sessionId, state.model.workspaces?.activeWorkspaceId, state.clientState?.connection.selected?.sessionId, state.loading]);

  const { agents: viewedAgents, ready: persistedAgentsReady } = usePersistedSessionAgents({
    preview: previewMode.preview,
    client,
    sessionId: viewedSessionId,
    liveSessionId: snapshot?.sessionId,
    liveAgents: snapshot?.agents,
  });
  const hubRuntimeConnected =
    runtime?.status === "connected"
    && (viewedSessionId === undefined || viewedSessionId === snapshot?.sessionId);
  const hubCanSend = (() => {
    const entry = capabilities?.capabilities.find((item) => item.id === "agent.send");
    if (!entry || entry.grade === "unavailable") return false;
    if (state.clientState?.connection.resyncRequired) return false;
    if (runtime?.classification === "limited-system") return false;
    if (!hubRuntimeConnected) return false;
    return true;
  })();
  const wantHistoryAll = pageRoute === "history" && !previewMode.preview;
  useEffect(() => {
    if (!wantHistoryAll) return;
    let cancelled = false;
    void client.query("history.list", { limit: PROJECT_THREADS_QUERY_MAX })
      .then((all) => {
        if (!cancelled) setHistoryAll(all);
      })
      .catch(() => {
        // 加载失败保留现有模型；归档/取消归档动作后也会刷新。
      });
    return () => {
      cancelled = true;
    };
  }, [wantHistoryAll, client]);
  const previewThread = findPreviewThread(previewThreadId);
  /** 顶栏「归档」目标：当前选中的历史会话，或驻留 Runtime 上的会话。
      进行中的会话也可以归档：Host 会先停止再移走文件。 */
  const residentSessionId = snapshot?.sessionId;
  const archiveTargetBase = selected
    ?? state.model.history?.entries.find((entry) => entry.sessionId !== undefined && entry.sessionId === residentSessionId);
  const archiveTargetReason = archiveTargetBase === undefined
    ? t("shell.archiveUnavailable")
    : archiveTargetBase.status === "archived"
      ? t("shell.archiveAlreadyArchived")
      : undefined;
  const archiveTarget = archiveTargetReason === undefined ? archiveTargetBase : undefined;
  // Same owner truth the workbench composer uses (`composer/dispatch.ts`): while
  // a new conversation's `session.create` is in flight the live snapshot still
  // describes the session just left, so its title, stored drafts, and sidebar
  // row must not be presented as this surface's own.
  const activeComposerOwner = composerOwnerSessionId({
    selectedSessionId: selectedProvisionalSessionId ?? selected?.sessionId,
    sessionCreating: creatingSession,
    liveSessionId: snapshot?.sessionId,
  });
  /** Restore boundary only: read, never subscribe (see `composer/draftStore.ts`). */
  const activeComposerDraft = composerDraftBook.get(activeComposerOwner);
  useEffect(() => {
    if (composerInsertion && composerInsertion.owner !== activeComposerOwner) setComposerInsertion(undefined);
  }, [composerInsertion, activeComposerOwner]);
  const activeComposerOwnsSnapshot = snapshot?.sessionId !== undefined && activeComposerOwner === snapshot.sessionId;
  const snapshotTitleIsCurrent = snapshot?.sessionId !== undefined
    && snapshot.sessionTitle !== undefined
    && (snapshot.sessionTitleSource === "user" || !isPlaceholderSessionTitle(snapshot.sessionTitle))
    && activeComposerOwnsSnapshot;
  const provisionalCurrentTitle = activeComposerOwnsSnapshot
    ? provisionalThreadsBySession[String(snapshot?.sessionId)]?.title
    : undefined;
  const selectedOrProvisionalTitle = isPlaceholderSessionTitle(selected?.title)
    ? provisionalCurrentTitle ?? selected?.title
    : selected?.title;
  const currentThreadTitle = snapshotTitleIsCurrent
    ? snapshot?.sessionTitle
    : selectedOrProvisionalTitle ?? provisionalCurrentTitle;
  const untitledThreadTitle = selectedHistoryId === null
    ? t("conversation.newChat")
    : t("conversation.untitledSession");
  const threadTitle = state.loading && mdi ? mdi.document.title : previewMode.preview
    ? (previewThread?.thread.title ?? "跟踪上游 pi-web 更新到 omp-web")
    : currentThreadTitle ?? (state.route === "history" ? t("menu.history") : state.route === "home" ? t("menu.home") : state.route === "agent-hub" ? "Agent Hub" : state.route === "capabilities" ? t("menu.capabilities") : state.route === "model-config" ? t("menu.modelConfig") : untitledThreadTitle);
  const onProvisionalSessionChange = useCallback((change: {
    readonly sessionId?: SessionId;
    readonly workspaceId?: WorkspaceId;
    readonly visible: boolean;
    readonly title?: string;
    readonly running: boolean;
    readonly submitted: boolean;
  }) => {
    if (change.sessionId === undefined) return;
    setProvisionalThreadsBySession((current) =>
      reconcileProvisionalProjectThread(current, change, {
        preview: previewMode.preview,
        sessionCreating: creatingSession,
        selectedHistoryId,
        untitledTitle: t("conversation.untitledSession"),
        excludedSessionIds: archivedProvisionalSessionIdsRef.current,
      }),
    );
  }, [creatingSession, previewMode.preview, selectedHistoryId, t]);
  useEffect(() => {
    setProvisionalThreadsBySession((current) => {
      let next: Record<string, ProvisionalProjectThread> | undefined;
      for (const [key, thread] of Object.entries(current)) {
        const persisted = projectHistoryCache[String(thread.workspaceId)]?.model?.entries.find(
          (entry) => entry.sessionId === thread.sessionId,
        );
        if (persisted === undefined || isPlaceholderSessionTitle(persisted.title)) continue;
        next ??= { ...current };
        delete next[key];
      }
      return next ?? current;
    });
  }, [projectHistoryCache]);

  useEffect(() => {
    if (previewMode.preview) {
      setExplorerOpen(true);
      setProjectListExpanded(true);
      const project = findPreviewProject(previewProjectId);
      if (project) setSelectedProject({ id: project.id, name: project.name });
      return;
    }
    const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    if (active) {
      setSelectedProject((current) =>
        current?.id === active.workspaceId && current?.name === active.name
          ? current
          : { id: active.workspaceId, name: active.name });
      setExplorerOpen(true);
      if (expandedProjectsMemory.restored) {
        /* 有本地记忆：按恢复的展开集加载各项目会话历史，不再强制展开活动项目。 */
        for (const workspaceId of expandedProjects) {
          void loadProjectHistory(workspaceId as WorkspaceId);
        }
      } else {
        expandProject(active.workspaceId);
        void loadProjectHistory(active.workspaceId);
      }
    } else {
      setSelectedProject(null);
    }
  }, [expandProject, expandedProjects, expandedProjectsMemory, loadProjectHistory, previewMode.preview, previewProjectId, state.model.workspaces]);

  useEffect(() => {
    if (mdi && !mdi.active) return;
    // Shared appearance is authoritative in the main document, even when this
    // shell's conversation surface is in a native window. Floats mirror it.
    const root = globalThis.document.documentElement;
    applyTheme(root, appSettings.theme);
    root.setAttribute("data-density", appSettings.density);
    /* 文件图标着色：tri 时根元素挂 data-palette，CSS 只覆盖 token。
       注意根元素用 data-palette、树行用 data-ftype，两者不共名。 */
    if (appSettings.fileTypePalette === "tri") {
      root.dataset.palette = "tri";
    } else {
      delete root.dataset.palette;
    }
  }, [mdi?.active, appSettings.theme, appSettings.density, appSettings.fileTypePalette]);

  /* Resident changes drive task notifications. A disappeared row is a
     neutral stop/disconnect, never a success notification. */
  const streamingSinceRef = useRef<{ on: boolean; since: number }>({ on: false, since: 0 });
  const residentStartedAtRef = useRef<Map<string, number>>(new Map());
  const residentLongNotifiedRef = useRef<Set<string>>(new Set());
  const previousResidentsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const runtimeDisconnected = runtime?.status === "disconnected" || runtime?.status === "unavailable";
    if (residentModel === undefined || residentModel === null) {
      const now = snapshot?.isStreaming === true && !runtimeDisconnected;
      const previous = streamingSinceRef.current;
      if (now && !previous.on) streamingSinceRef.current = { on: true, since: Date.now() };
      if (!now && previous.on) {
        streamingSinceRef.current = { on: false, since: 0 };
        desktopNotice("task", "任务结束", "会话任务已结束或停止");
      }
      return;
    }
    const current = new Map(residentRows.map((resident) => [String(resident.sessionId), resident.phase]));
    const previous = previousResidentsRef.current;
    for (const resident of residentRows) {
      const id = String(resident.sessionId);
      const active = resident.phase === "running" || resident.phase === "compacting";
      const wasActive = previous.get(id) === "running" || previous.get(id) === "compacting";
      if (active && !wasActive) {
        residentStartedAtRef.current.set(id, Date.now());
        residentLongNotifiedRef.current.delete(id);
      }
      if (!active) {
        residentStartedAtRef.current.delete(id);
        residentLongNotifiedRef.current.delete(id);
      }
      if (wasActive && resident.phase === "idle") {
        desktopNotice("task", "任务结束", "会话任务已结束");
      }
    }
    for (const [id, phase] of previous) {
      if (phase !== "running" && phase !== "compacting") continue;
      if (!current.has(id)) {
        residentStartedAtRef.current.delete(id);
        residentLongNotifiedRef.current.delete(id);
        desktopNotice("task", "任务停止", "会话已停止或断开");
      }
    }
    previousResidentsRef.current = current;
  }, [residentModel, residentRows, runtime?.status, snapshot?.isStreaming]);
  useEffect(() => {
    const runtimeDisconnected = runtime?.status === "disconnected" || runtime?.status === "unavailable";
    if (residentModel === undefined || residentModel === null) {
      if (snapshot?.isStreaming !== true || runtimeDisconnected || !appSettings.notifyLongTasks) return;
      const startedAt = streamingSinceRef.current.since || Date.now();
      const remaining = Math.max(0, 5 * 60_000 - (Date.now() - startedAt));
      const timer = window.setTimeout(() => {
        desktopNotice("longTask", "任务仍在运行", "当前任务已连续运行超过 5 分钟");
      }, remaining);
      return () => window.clearTimeout(timer);
    }
    if (!appSettings.notifyLongTasks) return;
    const active = residentRows.filter((resident) => resident.phase === "running" || resident.phase === "compacting");
    if (active.length === 0) return;
    const now = Date.now();
    const due = active
      .map((resident) => ({
        resident,
        startedAt: residentStartedAtRef.current.get(String(resident.sessionId)) ?? now,
      }))
      .filter(({ resident, startedAt }) => !residentLongNotifiedRef.current.has(String(resident.sessionId)) && now - startedAt >= 5 * 60_000);
    if (due.length > 0) {
      for (const { resident } of due) residentLongNotifiedRef.current.add(String(resident.sessionId));
      desktopNotice("longTask", "任务仍在运行", "当前任务已连续运行超过 5 分钟");
      return;
    }
    const remaining = Math.min(...active.map((resident) => Math.max(0, 5 * 60_000 - (now - (residentStartedAtRef.current.get(String(resident.sessionId)) ?? now)))));
    const timer = window.setTimeout(() => {
      // Re-render from the next resident snapshot is not guaranteed at the
      // five-minute boundary; this notice is preference-gated and neutral.
      for (const resident of active) {
        const id = String(resident.sessionId);
        const startedAt = residentStartedAtRef.current.get(id);
        if (startedAt !== undefined && Date.now() - startedAt >= 5 * 60_000) residentLongNotifiedRef.current.add(id);
      }
      desktopNotice("longTask", "任务仍在运行", "当前任务已连续运行超过 5 分钟");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [appSettings.notifyLongTasks, residentModel, residentRows, runtime?.status, snapshot?.isStreaming]);

  useEffect(() => {
    if (openMenu === null) return;
    const close = () => setOpenMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openMenu]);

  const commitActivatedWorkspace = async (project: string, generation: number) => {
    const residents = await client.query("residents.list", {});
    if (!navigationGate.isCurrent(generation)) return;
    const active = residents.residents.find(row => row.sessionId === residents.activeSessionId && row.workspaceId === project);
    onNewThread();
    setSelectedProvisionalSessionId(undefined);
    if (active) commitDockSelection({ target: executionTarget.id ?? "local", project, session: active.sessionId });
    else beginDockDraft(project);
  };
  const selectProject = (project: SelectedProject) => {
    if (!previewMode.preview && state.model.workspaces?.activeWorkspaceId === project.id) { setSelectedProject(project); setExplorerOpen(true); return; }
    const generation = navigationGate.next();
    setSelectedProject(project);
    setExplorerOpen(true);
    expandProject(project.id);
    setProjectListExpanded(true);
    void loadProjectHistory(project.id as WorkspaceId);
    if (previewMode.preview) return;
    void workspaceActionQueue.enqueue(async () => {
      const handle = await client.command("workspace.open", { workspaceId: project.id as WorkspaceId });
      const workspaces = await waitReceipt<WorkspaceListReadModel>(client, handle.requestId);
      if (!navigationGate.isCurrent(generation)) return;
      onWorkspacesChange(workspaces);
      await commitActivatedWorkspace(project.id, generation);
    }).catch((error) => {
      if (!navigationGate.isCurrent(generation)) return;
      setShellNotice({ text: hostErrorMessage(error, "切换项目失败"), icon: "alert" });
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      setSelectedProject(active === undefined ? null : { id: active.workspaceId, name: active.name });
    });
  };

  /** System directory picker → register + activate + enter the workbench. */
  const pickProject = async () => {
    if (previewMode.preview) return;
    if (executionTarget.id) { go("workbench"); executionTarget.openDirectory(); return; }
    const generation = navigationGate.next();
    try {
      const result = await workspaceActionQueue.enqueue(async () => {
        const handle = await client.command("workspace.pick", {});
        return await waitReceipt<WorkspaceListReadModel>(client, handle.requestId, null);
      });
      if (!navigationGate.isCurrent(generation)) return;
      onWorkspacesChange(result);
      const active = result.workspaces.find((workspace) => workspace.active);
      if (active) {
        await commitActivatedWorkspace(active.workspaceId, generation);
        setSelectedProject({ id: active.workspaceId, name: active.name });
        setExplorerOpen(true);
        expandProject(active.workspaceId);
        setProjectListExpanded(true);
        void loadProjectHistory(active.workspaceId);
        go("workbench");
      }
    } catch (error) {
      setShellNotice({ text: hostErrorMessage(error, "选择项目失败"), icon: "alert" });
    }
  };

  /** Enter the workbench selecting the active workspace (or the empty explorer state). */
  const enterWorkbench = () => {
    const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    if (active) {
      selectProject({ id: active.workspaceId, name: active.name });
    } else {
      setExplorerOpen(true);
    }
  };

  const openWorkspace = (workspaceId: string) => {
    const workspace = state.model.workspaces?.workspaces.find((entry) => entry.workspaceId === workspaceId);
    if (workspace === undefined) return;
    selectProject({ id: workspace.workspaceId, name: workspace.name });
    go("workbench");
  };

  const go = useCallback((next: Route) => {
    if (!onRoute(next)) return false;
    setOpenMenu(null);
    setOmpMenuOpen(false);
    if (next === "home") {
      setSelectedProject(null);
      setExplorerOpen(false);
      setProjectListExpanded(false);
    } else if (next === "workbench") {
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      if (active) {
        setSelectedProject({ id: active.workspaceId, name: active.name });
        setExplorerOpen(true);
      } else {
        setExplorerOpen(true);
      }
    }
    if (next === trail[trailAt]) return true;
    // `trailAt` 只增不减，所以这个数组只会变长。路由对象很小，但形式上无界，
    // 超过 `TRAIL_MAX` 就丢掉最早的一段（并把游标一起左移，保持指向同一项）。
    setTrail((current) => {
      const next$ = [...current.slice(0, trailAt + 1), next];
      return next$.length > TRAIL_MAX ? next$.slice(next$.length - TRAIL_MAX) : next$;
    });
    setTrailAt((value) => Math.min(value + 1, TRAIL_MAX - 1));
    return true;
  }, [onRoute, trail, trailAt, state.model.workspaces]);
  useEffect(() => {
    const reveal = (event: Event) => { (event as CustomEvent<{ accepted: boolean }>).detail.accepted = go("workbench"); };
    window.addEventListener("omp:dock-reveal-workbench", reveal);
    return () => window.removeEventListener("omp:dock-reveal-workbench", reveal);
  }, [go]);

  /** The rail's workbench entry behaves like Back/Forward: `go` switches the
   *  route, `enterWorkbench` re-activates the active workspace when needed. */
  const navigateFromRail = (route: NavRailRoute) => {
    if (!go(route)) return;
    if (route === "workbench") enterWorkbench();
  };

  const runMenu = (action: () => void) => {
    setOpenMenu(null);
    action();
  };

  const runEdit = (command: EditCommand) => {
    runMenu(() => execEditCommand(command));
  };

  const openDialog = (next: ShellDialog) => {
    setOpenMenu(null);
    setDialog(next);
  };

  const paletteGate = useRef(false);

  const closePalette = useCallback((restoreFocus = true) => {
    paletteGate.current = true;
    setPaletteOpen(false);
    setPaletteQuery("");
    window.setTimeout(() => {
      paletteGate.current = false;
      if (!restoreFocus) return;
      const anchor = document.querySelector<HTMLElement>("[data-cmdk-anchor]");
      if (anchor && document.body.contains(anchor)) anchor.focus();
    }, 0);
  }, []);

  const openPalette = useCallback(() => {
    if (paletteGate.current) return;
    setOpenMenu(null);
    setOmpMenuOpen(false);
    if (paletteOpen) {
      paletteRef.current?.focusInput();
      return;
    }
    setPaletteQuery("");
    setPaletteOpen(true);
  }, [paletteOpen]);

  /** 「展开更多」：该项目已展开条数 +10；已加载条目不够且总数未到时，
   * 用更大的 limit 重查 history.list（model 是部分合并，只覆盖 history）。 */
  const loadMoreThreads = (projectId: string) => {
    const next = (projectThreadLimits[projectId] ?? PROJECT_THREADS_INITIAL) + PROJECT_THREADS_PAGE;
    setProjectThreadLimits((current) => ({ ...current, [projectId]: next }));
    if (previewMode.preview) return;
    const cached = projectHistoryCache[projectId];
    if (cached?.model !== undefined && (next <= cached.model.entries.length || cached.model.entries.length >= cached.model.total)) return;
    void loadMoreProjectHistory(projectId as WorkspaceId).then((refreshed) => {
      // Keep the legacy global model useful to Home/History consumers, but
      // only mirror the currently active workspace; other cache keys stay
      // independent and are rendered directly from projectHistories.
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      if (refreshed !== undefined && active?.workspaceId === projectId) onHistoryChange(refreshed);
    });
  };

  /** 预览模式「归档」演示：本地隐藏该行；若隐藏的是当前选中会话则回到新对话。 */
  const archivePreviewThread = (threadId: string) => {
    setHiddenPreviewThreads((current) => {
      const next = new Set(current);
      next.add(threadId);
      return next;
    });
    if (previewThreadId === threadId) {
      setPreviewThreadId("t0");
    }
  };

  /** 归档进行中时再次点击归档入口：给出提示而不是静默吞掉。 */
  const notifyArchiveBusy = () => {
    setShellNotice({ text: "正在归档中，请稍候", icon: "archive" });
  };

  const requestArchivePreview = (threadId: string) => {
    if (archiveBusyRef.current) {
      notifyArchiveBusy();
      return;
    }
    const hit = findPreviewThread(threadId);
    setArchiveError(undefined);
    setArchivePending({
      kind: "preview",
      threadId,
      title: hit?.thread.title ?? "该会话",
      streaming: hit?.thread.status === "running",
    });
  };

  const requestArchiveThread = (entry: SessionHistoryEntry, workspaceId?: WorkspaceId) => {
    if (archiveBusyRef.current) {
      notifyArchiveBusy();
      return;
    }
    setArchiveError(undefined);
    const cachedWorkspaceId = Object.entries(projectHistoryCache).find(([, value]) =>
      value.model?.entries.some((candidate) => candidate.historyId === entry.historyId),
    )?.[0] as WorkspaceId | undefined;
    const inferredWorkspaceId = workspaceId
      ?? residentForSession(residentModel, entry.sessionId)?.workspaceId
      ?? cachedWorkspaceId
      ?? (selectedProject?.id as WorkspaceId | undefined);
    const resident = residentForSession(residentModel, entry.sessionId);
    setArchivePending({
      kind: "real",
      entry,
      streaming: resident?.phase === "running"
        || resident?.phase === "compacting"
        || (entry.sessionId !== undefined && entry.sessionId === snapshot?.sessionId && snapshot.isStreaming === true),
      ...(inferredWorkspaceId === undefined ? {} : { workspaceId: inferredWorkspaceId }),
    });
  };

  /** Refresh one sidebar workspace without replacing other project caches.
      Calls without a workspace retain the legacy global/history-page refresh. */
  const refreshHistoryModels = useCallback(async (workspaceId?: WorkspaceId): Promise<SessionHistoryReadModel | undefined> => {
    if (workspaceId !== undefined) {
      const refreshed = await refreshProjectHistory(workspaceId);
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      if (refreshed !== undefined && active?.workspaceId === workspaceId) onHistoryChange(refreshed);
      return refreshed;
    }
    const loaded = state.model.history?.entries.length ?? 20;
    try {
      const [active, all] = await Promise.all([
        client.query("history.list", { limit: Math.min(Math.max(loaded, 20), PROJECT_THREADS_QUERY_MAX), status: "active" }),
        client.query("history.list", { limit: PROJECT_THREADS_QUERY_MAX }),
      ]);
      onHistoryChange(active);
      setHistoryAll(all);
      return active;
    } catch {
      // 刷新失败保留现有条目；下次进入历史页会重查。
      return undefined;
    }
  }, [client, onHistoryChange, refreshProjectHistory, state.model.history?.entries.length, state.model.workspaces]);

  /** Semantic title updates are authoritative; refresh the owning project and
   * reconcile the legacy global/history-page models in the same turn. */
  const refreshHistoryAfterTitle = useCallback(async (workspaceId?: WorkspaceId): Promise<SessionHistoryReadModel | undefined> => {
    if (workspaceId === undefined) {
      return await refreshHistoryModels();
    }
    const [workspaceHistory] = await Promise.all([
      refreshHistoryModels(workspaceId),
      refreshHistoryModels(),
    ]);
    return workspaceHistory;
  }, [refreshHistoryModels]);

  const refreshPinnedHistory = useCallback(async (): Promise<void> => {
    await refreshHistoryModels();
    const activeWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    if (activeWorkspace !== undefined) await refreshProjectHistory(activeWorkspace.workspaceId);
  }, [refreshHistoryModels, refreshProjectHistory, state.model.workspaces]);

  const recoveryHistoryRefresh = useRef(() => {});
  recoveryHistoryRefresh.current = () => {
    if (previewMode.preview) return;
    void refreshHistoryModels();
    for (const workspaceId of Object.keys(projectHistoryCache)) void refreshProjectHistory(workspaceId as WorkspaceId);
  };
  useEffect(() => { if (executionTarget.syncRevision > 0) recoveryHistoryRefresh.current(); }, [executionTarget.syncRevision]);

  /** Mutating a session is routed through the active workspace's Runtime.
      Switch and wait for the authoritative receipt before archive/unarchive so
      an inactive project's command cannot land on the current worker. */
  const ensureWorkspaceActive = async (workspaceId?: WorkspaceId): Promise<void> => {
    if (workspaceId === undefined) return;
    const handle = await client.command("workspace.open", { workspaceId });
    const workspaces = await waitReceipt<WorkspaceListReadModel>(client, handle.requestId);
    onWorkspacesChange(workspaces);
  };

  /** Runtime title changes arrive through state.changed snapshots. The timed
   * history refresh below remains only as an older-Runtime fallback. */
  const semanticTitleKey = snapshot?.sessionId !== undefined
    && snapshot.sessionTitle !== undefined
    ? JSON.stringify([snapshot.sessionId, snapshot.sessionTitle, snapshot.sessionTitleSource])
    : undefined;
  const currentResidentWorkspaceId = residentForSession(residentModel, snapshot?.sessionId)?.workspaceId;
  const currentActiveWorkspaceId = state.model.workspaces?.workspaces.find((workspace) => workspace.active)?.workspaceId;
  const currentSessionWorkspaceId = workspaceForSession({
    ...(snapshot?.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
    ...(currentResidentWorkspaceId === undefined
      ? {}
      : { residentWorkspaceId: currentResidentWorkspaceId }),
    projectHistoryCache,
    ...(selectedProject?.id === undefined ? {} : { selectedWorkspaceId: selectedProject.id as WorkspaceId }),
    ...(currentActiveWorkspaceId === undefined
      ? {}
      : { activeWorkspaceId: currentActiveWorkspaceId }),
  });
  const renameTargetSessionId = selected?.sessionId ?? snapshot?.sessionId;
  const renameTargetResidentWorkspaceId = residentForSession(residentModel, renameTargetSessionId)?.workspaceId;
  const renameTargetWorkspaceId = workspaceForSession({
    ...(renameTargetSessionId === undefined ? {} : { sessionId: renameTargetSessionId }),
    ...(renameTargetResidentWorkspaceId === undefined
      ? {}
      : { residentWorkspaceId: renameTargetResidentWorkspaceId }),
    projectHistoryCache,
    ...(selectedProject?.id === undefined ? {} : { selectedWorkspaceId: selectedProject.id as WorkspaceId }),
    ...(currentActiveWorkspaceId === undefined ? {} : { activeWorkspaceId: currentActiveWorkspaceId }),
  });
  const titleRefresh = useRef(refreshHistoryAfterTitle);
  titleRefresh.current = refreshHistoryAfterTitle;
  useEffect(() => {
    if (previewMode.preview || semanticTitleKey === undefined || snapshot?.sessionId === undefined || snapshot.sessionTitle === undefined) return;
    const title = snapshot.sessionTitle.trim();
    if (title.length === 0 || (snapshot.sessionTitleSource !== "user" && isPlaceholderSessionTitle(title))) return;
    const key = String(snapshot.sessionId);
    setProvisionalThreadsBySession((current) => {
      const thread = current[key];
      if (thread === undefined) return current;
      const next = resolveProvisionalHistoryTitle(thread, title);
      return next === thread ? current : { ...current, [key]: next };
    });
    void titleRefresh.current(currentSessionWorkspaceId);
  }, [currentSessionWorkspaceId, previewMode.preview, semanticTitleKey, snapshot?.sessionId, snapshot?.sessionTitle, snapshot?.sessionTitleSource]);

  const sessionTitleRefreshTimers = useRef<number[]>([]);
  const refreshSessionTitles = useCallback((workspaceId?: WorkspaceId) => {
    if (previewMode.preview) return;
    const targetWorkspaceId = workspaceId
      ?? state.model.workspaces?.workspaces.find((workspace) => workspace.active)?.workspaceId;
    for (const id of sessionTitleRefreshTimers.current) window.clearTimeout(id);
    sessionTitleRefreshTimers.current = [0, 2_000, 8_000].map((delay) =>
      window.setTimeout(() => {
        void refreshHistoryModels();
        if (targetWorkspaceId !== undefined) void refreshProjectHistory(targetWorkspaceId);
      }, delay),
    );
  }, [previewMode.preview, refreshHistoryModels, refreshProjectHistory, state.model.workspaces]);
  const streamingHistoryWorkspaceId = residentForSession(residentModel, snapshot?.sessionId)?.workspaceId
    ?? (selectedProject?.id as WorkspaceId | undefined)
    ?? state.model.workspaces?.workspaces.find((workspace) => workspace.active)?.workspaceId;
  const streamingHistoryKey = streamingProjectHistoryRefreshKey({
    preview: previewMode.preview,
    isStreaming: snapshot?.isStreaming,
    sessionId: snapshot?.sessionId,
    workspaceId: streamingHistoryWorkspaceId,
  });
  const refreshSessionTitlesRef = useRef(refreshSessionTitles);
  useEffect(() => {
    refreshSessionTitlesRef.current = refreshSessionTitles;
  }, [refreshSessionTitles]);
  useEffect(() => {
    if (streamingHistoryKey === undefined || streamingHistoryWorkspaceId === undefined) return;
    refreshSessionTitlesRef.current(streamingHistoryWorkspaceId);
  }, [streamingHistoryKey, streamingHistoryWorkspaceId]);
  useEffect(() => () => {
    for (const id of sessionTitleRefreshTimers.current) window.clearTimeout(id);
  }, []);

  /** 真实模式「归档」：session.archive 把会话移入 OMP 冷归档（gzip）。
      进行中的会话由 Host 先 abort / 切走 Runtime，再移文件。
      归档的是当前选中会话时回到新对话视图。仅由确认弹窗调用。 */
  const archiveThread = async (entry: SessionHistoryEntry, workspaceId?: WorkspaceId): Promise<boolean> => {
    return await workspaceActionQueue.enqueue(async () => {
      try {
      await ensureWorkspaceActive(workspaceId);
      const handle = await client.command("session.archive", { threadId: entry.threadId });
      await waitReceipt(client, handle.requestId);
      if (entry.sessionId !== undefined) {
        archivedProvisionalSessionIdsRef.current = new Set([
          ...archivedProvisionalSessionIdsRef.current,
          String(entry.sessionId),
        ]);
        setProvisionalThreadsBySession((current) => {
          const key = String(entry.sessionId);
          if (current[key] === undefined) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
      if (selectedHistoryId === entry.historyId) onNewThread();
      await refreshHistoryModels(workspaceId);
      setShellNotice({ text: `已归档「${entry.title}」，可在会话历史页查看`, icon: "archive" });
      return true;
      } catch (error) {
        setArchiveError(hostErrorMessage(error, "归档失败"));
        return false;
      }
    });
  };

  const closeArchiveConfirm = () => {
    if (archiveBusyRef.current) return;
    setArchivePending(null);
    setArchiveError(undefined);
  };

  const confirmArchive = () => {
    if (archivePending === null || archiveBusyRef.current) return;
    if (archivePending.kind === "preview") {
      archivePreviewThread(archivePending.threadId);
      setArchivePending(null);
      setArchiveError(undefined);
      return;
    }
    const entry = archivePending.entry;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    void archiveThread(entry, archivePending.workspaceId).then((ok) => {
      if (ok) {
        setArchivePending(null);
        setArchiveError(undefined);
      }
      archiveBusyRef.current = false;
      setArchiveBusy(false);
    });
  };

  /** 真实模式「取消归档」：session.unarchive 恢复到进行中列表。 */
  const unarchiveThread = (entry: SessionHistoryEntry) => {
    if (unarchiveBusyThreadIdsRef.current.has(entry.threadId)) return;
    const busy = new Set(unarchiveBusyThreadIdsRef.current);
    busy.add(entry.threadId);
    unarchiveBusyThreadIdsRef.current = busy;
    void workspaceActionQueue.enqueue(async () => {
      try {
        const cachedWorkspaceId = Object.entries(projectHistoryCache).find(([, value]) =>
          value.model?.entries.some((candidate) => candidate.historyId === entry.historyId),
        )?.[0] as WorkspaceId | undefined;
        const targetWorkspaceId = cachedWorkspaceId
          ?? residentForSession(residentModel, entry.sessionId)?.workspaceId;
        await ensureWorkspaceActive(targetWorkspaceId);
        const handle = await client.command("session.unarchive", { threadId: entry.threadId });
        await waitReceipt(client, handle.requestId);
        if (entry.sessionId !== undefined) {
          const nextExcluded = new Set(archivedProvisionalSessionIdsRef.current);
          nextExcluded.delete(String(entry.sessionId));
          archivedProvisionalSessionIdsRef.current = nextExcluded;
        }
        await refreshHistoryModels(targetWorkspaceId);
        setShellNotice({ text: `已恢复「${entry.title}」`, icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "取消归档失败"), icon: "alert" });
      } finally {
        const done = new Set(unarchiveBusyThreadIdsRef.current);
        done.delete(entry.threadId);
        unarchiveBusyThreadIdsRef.current = done;
      }
    });
  };

  /** 真实模式「删除会话」：session.delete 永久删除本地文件与相关残留。 */
  const deleteSessionThread = (entry: SessionHistoryEntry, deleteManagedArtifacts = false): Promise<boolean> => {
    return workspaceActionQueue.enqueue(async () => {
      try {
        const cachedWorkspaceId = Object.entries(projectHistoryCache).find(([, value]) =>
          value.model?.entries.some((candidate) => candidate.historyId === entry.historyId),
        )?.[0] as WorkspaceId | undefined;
        const targetWorkspaceId = cachedWorkspaceId
          ?? residentForSession(residentModel, entry.sessionId)?.workspaceId;
        await ensureWorkspaceActive(targetWorkspaceId);
        const handle = await client.command("session.delete", { threadId: entry.threadId, deleteManagedArtifacts });
        await waitReceipt(client, handle.requestId);
        if (entry.sessionId) dock.store.deleteSession({ target: executionTarget.id ?? "local", project: targetWorkspaceId ?? null, session: entry.sessionId });
        if (entry.sessionId !== undefined) {
          archivedProvisionalSessionIdsRef.current = new Set([
            ...archivedProvisionalSessionIdsRef.current,
            String(entry.sessionId),
          ]);
          setProvisionalThreadsBySession((current) => {
            const key = String(entry.sessionId);
            if (current[key] === undefined) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          // 删除该会话的 IndexedDB 缩略图预览字节，避免 UI 残留。
          await getDefaultThumbStore().dropSession(String(entry.sessionId)).catch(() => {});
        }
        if (selectedHistoryId === entry.historyId) onNewThread();
        await refreshHistoryModels(targetWorkspaceId);
        setShellNotice({ text: `已删除会话「${entry.title}」`, icon: "trash" });
        return true;
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "删除会话失败"), icon: "alert" });
        return false;
      }
    });
  };

  /** 顶栏「对话选项」Fork：Runtime 切换身份（快照 sessionId 变为新会话），
      重查 history 让侧栏/历史页出现新会话。 */
  const forkThread = () => {
    void workspaceActionQueue.enqueue(async () => {
      try {
        const handle = await client.command("session.fork", {});
        const receipt = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
        await selectBranchedSession(receipt.sessionId);
        setShellNotice({ text: t("shell.forkedToNewSession", { id: receipt.sessionId }), icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "Fork 失败"), icon: "alert" });
      }
    });
  };

  /** 顶栏「对话选项」Handoff：LLM 生成摘要并切换到新会话。 */
  const handoffThread = () => {
    void workspaceActionQueue.enqueue(async () => {
      try {
        const handle = await client.command("session.handoff", {});
        const receipt = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
        await selectBranchedSession(receipt.sessionId);
        setShellNotice({ text: t("shell.handoffToNewSession", { id: receipt.sessionId }), icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "Handoff 失败"), icon: "alert" });
      }
    });
  };

  /** 顶栏 Compact：与 Composer 发送一样，先 ensureSelectedSessionActive（历史会话
      只读打开时 Runtime 仍停在空会话上），再 operator.invoke builtin.compact。 */
  const can = (id: string) => {
    const connection = state.clientState?.connection;
    const manifest = usableCapabilityManifest(state.model.capabilities, connection?.capabilityManifest, state.bootstrap?.capabilityManifest);
    return !connection?.resyncRequired && (connection?.runtime ?? state.bootstrap?.runtime)?.classification !== "limited-system"
      && manifest?.capabilities.some(capability => capability.id === id && capability.grade !== "unavailable") === true;
  };
  const compactThread = (target?: { sessionId?: SessionId; threadId?: ThreadId }) => {
    const current = snapshotFrom(state), targetId = target?.sessionId ?? selected?.sessionId;
    if (current?.sessionId && current.isStreaming && (!targetId || targetId === current.sessionId) && can("session.compaction.enqueue")) {
      void workspaceActionQueue.enqueue(async () => {
        try { const handle = await client.command("session.compaction.enqueue", { sessionId: current.sessionId! }); await waitReceipt(client, handle.requestId); setShellNotice({ text: "已排队压缩；后续消息将在压缩后发送", icon: "queue" }); }
        catch (error) { setShellNotice({ text: hostErrorMessage(error, "排队压缩失败"), icon: "alert" }); }
      });
      return;
    }
    setCompactPending(true);
    void workspaceActionQueue.enqueue(async () => {
      const live = snapshotFrom(state);
      // target：行级菜单显式指定所在行会话；顶栏缺省作用于当前查看会话。
      const targetSessionId = target?.sessionId ?? selected?.sessionId;
      const targetThreadId = target?.threadId ?? selected?.threadId;
      try {
        await ensureSelectedSessionActive(client, {
          ...(live?.sessionId === undefined ? {} : { activeSessionId: live.sessionId }),
          ...(targetSessionId === undefined ? {} : { selectedSessionId: targetSessionId }),
          ...(targetThreadId === undefined ? {} : { selectedThreadId: targetThreadId }),
        });
        if (compactCancelRequestedRef.current) {
          setShellNotice({ text: "已取消压缩", icon: "info" });
          return;
        }
        const handle = await client.command("operator.invoke", { commandId: "builtin.compact" });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        if (compactCancelRequestedRef.current) {
          setShellNotice({ text: "已取消压缩", icon: "info" });
          return;
        }
        const notice = compactNoticeFromOutput(outcome.output, { successText: "已压缩上下文" });
        setShellNotice({
          text: notice.text,
          icon: notice.ok ? "check" : "alert",
        });
        if (notice.ok) refreshViewedTelemetry();
      } catch (error) {
        if (compactCancelRequestedRef.current) {
          setShellNotice({ text: "已取消压缩", icon: "info" });
        } else {
          setShellNotice({ text: hostErrorMessage(error, "压缩失败"), icon: "alert" });
        }
      } finally {
        setCompactPending(false);
        compactCancelRequestedRef.current = false;
      }
    });
  };

  /** 压缩进行中「取消」：复用 core.abort 取消当前压缩（与原生 Esc 同语义）。
      标记取消请求，让在飞的压缩回执按「已取消压缩」提示。 */
  const cancelCompact = () => {
    compactCancelRequestedRef.current = true;
    void (async () => {
      try {
        const handle = await client.command("core.abort", {});
        await waitReceipt(client, handle.requestId);
      } catch (error) {
        compactCancelRequestedRef.current = false;
        setShellNotice({ text: hostErrorMessage(error, "取消压缩失败"), icon: "alert" });
      }
    })();
  };

  /** 顶栏「对话选项」导出：builtin.export 生成自包含 HTML；导出路径来自
      operator.invoke 回执的命令输出（Host 侧透传，非演示数据）。 */
  const exportThread = () => {
    void workspaceActionQueue.enqueue(async () => {
      try {
        const handle = await client.command("operator.invoke", { commandId: "builtin.export" });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        const exportedLine = outcome.output.find((line) => /export/i.test(line));
        setShellNotice({ text: exportedLine ?? "已导出对话（HTML）", icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "导出失败"), icon: "alert" });
      }
    });
  };

  /** 侧栏会话行 ⋯ 菜单：先确保所在行会话「已查看 + Runtime 活动会话」（必要时
      切工作区并 resume），再执行与顶栏「对话选项」同款的动作。失败即中止，
      绝不让动作落到错误的活动会话上。 */
  const runThreadRowAction = (entry: SessionHistoryEntry, workspaceId: WorkspaceId | undefined, action: ThreadRowActionKind) => {
    void workspaceActionQueue.enqueue(async () => {
      try {
        if (action === "rename") {
          openRenameDialog(entry.title ?? t("conversation.untitledSession"), { ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }), threadId: entry.threadId, ...(workspaceId === undefined ? {} : { workspaceId }) });
          return;
        }
        if (action === "pin") {
          if (!snapshot?.sessionId || !entry.sessionId) throw new Error("请先连接 Runtime / Connect a Runtime first");
          const handle = await client.command("session.history.pin", { sessionId: snapshot.sessionId, targetSessionId: entry.sessionId, pinned: !entry.pinned });
          await waitReceipt(client, handle.requestId);
          await refreshHistoryModels();
          return;
        }
        await openHistoryEntry(entry, workspaceId, { resumeForAction: true, skipQueue: true });
        switch (action) {
          case "fork":
            forkThread();
            break;
          case "handoff":
            handoffThread();
            break;
          case "compact":
            compactThread({
              ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
              threadId: entry.threadId,
            });
            break;
          case "export":
            exportThread();
            break;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "会话切换已取消") return;
        setSessionActionError(hostErrorMessage(error, "会话操作失败"));
      }
    });
  };

  const waitForNewSession = useCallback(
    () => sessionCreateWaitRef.current ?? Promise.resolve({ ok: true } as const),
    [],
  );
  const runSessionCreate = useCallback((work: () => Promise<OperatorStateSnapshot | void>) => {
    if (sessionCreateWaitRef.current) return;
    setCreatingSession(true);
    const creatingScope = dockSelectionRef.current;
    const pending = work()
      .then((created): NewSessionWaitResult => {
        if (created?.sessionId) {
          const scope: DockScope = { target: creatingScope.target, project: creatingScope.project, session: created.sessionId };
          dock.store.adoptDraft(scope, { scope: creatingScope, preview: false });
          if (dockSelectionRef.current.session === creatingScope.session) {
            commitDockSelection(scope);
          }
        }
        return { ok: true, ...(created?.sessionId === undefined ? {} : { sessionId: created.sessionId as SessionId }) };
      })
      .catch((error): NewSessionWaitResult => {
        const message = hostErrorMessage(error, "新建对话失败");
        setShellNotice({ text: message, icon: "alert" });
        return { ok: false, error: message };
      })
      .finally(() => {
        setCreatingSession(false);
        if (sessionCreateWaitRef.current === pending) sessionCreateWaitRef.current = null;
      });
    sessionCreateWaitRef.current = pending;
  }, [dock.store, commitDockSelection, setSelectedProvisionalSessionId]);
  const ensureNewSession = useCallback(() => {
    if (previewMode.preview || sessionCreateWaitRef.current) return;
    runSessionCreate(() => workspaceActionQueue.enqueue(async () => {
      const handle = await client.command("session.create", {});
      const created = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
      refreshSessionTitles();
      return created;
    }));
  }, [client, previewMode.preview, runSessionCreate, refreshSessionTitles, workspaceActionQueue]);

  const startNewChat = useCallback((noContextFiles?: boolean) => {
    if (mdi && !noContextFiles) { mdi.store.openFromDirectory({ targetId: executionTarget.id, workspaceId: mdi.document.ref.workspaceId, draftId: crypto.randomUUID() }); return; }
    if (previewMode.preview) {
      go("workbench");
      return;
    }
    if (sessionCreateWaitRef.current || !go("workbench")) return;
    navigationGate.next();
    setSessionActionError(undefined);
    setSelectedProvisionalSessionId(undefined);
    onNewThread();
    beginDockDraft(state.model.workspaces?.activeWorkspaceId ?? selectedProject?.id ?? null);
    runSessionCreate(() => workspaceActionQueue.enqueue(async () => {
      const handle = await client.command("session.create", noContextFiles ? { noContextFiles: true } : {});
      const created = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
      refreshSessionTitles();
      return created;
    }));
  }, [client, go, navigationGate, onNewThread, previewMode.preview, runSessionCreate, refreshSessionTitles, workspaceActionQueue, beginDockDraft, selectedProject?.id, state.model.workspaces?.activeWorkspaceId]);

  const applySlashUi = (ui: SlashNativeUi): void => {
    if (ui === "settings") { go("settings"); return; }
    if (ui === "model-config") { go("model-config"); return; }
    if (ui === "capabilities-mcp") { setCapIntent("mcp"); go("capabilities"); return; }
    if (ui === "capabilities-plugins") { setCapIntent("plugins"); go("capabilities"); return; }
    if (ui === "capabilities-slash") { setCapIntent("slash"); go("capabilities"); return; }
    if (ui === "agent-hub") { go("agent-hub"); return; }
    if (ui === "history") { go("history"); return; }
    if (ui === "new-chat") { startNewChat(); return; }
    if (ui === "command-palette") { openPalette(); return; }
    if (ui === "skills-drawer") { setSkillsOpen(true); return; }
    setSlashUiIntent(ui);
    go("workbench");
  };

  const runSlashFromShell = async (command: StudioSlashCommand, args: string): Promise<boolean> => {
    if (command.availability === "disabled") {
      setShellNotice({ text: command.disabledReason ?? `/${command.name} 暂不可用`, icon: "alert" });
      return false;
    }
    const destructive = command.risk === "destructive" || isDestructiveMemoryClear(command, args);
    if (destructive && !previewMode.preview && !window.confirm(`确定执行 /${command.name}${args ? ` ${args}` : ""}？此操作会改会话状态。`)) {
      return false;
    }
    const execute = resolveSlashExecute(command, args);
    if (execute.kind === "none") return false;
    if (execute.kind === "native-ui") {
      applySlashUi(execute.ui);
      return true;
    }
    if (command.side && execute.kind === "invoke") {
      go("workbench");
      dock.store.dispatch({ type: "open", panel: "btw" });
      if (previewMode.preview) { setBtwDemoRound(0); return true; }
      return btwSession.ask(`/${command.name}${args ? ` ${args}` : ""}`, true, undefined, { name: command.name, arguments: args });
    }
    if (execute.kind === "typed" && execute.name === "btw.ask") {
      go("workbench");
      dock.store.dispatch({ type: "open", panel: "btw" });
      if (previewMode.preview) {
        setBtwDemoRound(0);
        return true;
      }
      const question = typeof execute.input.question === "string" ? execute.input.question : args.trim();
      if (question.length === 0) { await btwSession.refreshHistory?.(); return true; }
      return await btwSession.ask(question, true);
    }
    if (previewMode.preview) {
      if (previewMode.marks) setShellNotice({ text: `演示：/${command.name}${args ? ` ${args}` : ""}`, icon: "info" });
      return true;
    }
    if (execute.kind === "typed") {
      const threadId = selected?.threadId;
      const bound = bindSlashTypedCommand(execute, threadId === undefined ? {} : { threadId });
      if (!bound.ok) {
        setShellNotice({ text: bound.error, icon: "alert" });
        return false;
      }
      try {
        const handle = await client.command(bound.name, bound.input as CommandInput<CommandName>);
        await waitReceipt(client, handle.requestId);
        setShellNotice({ text: `已执行 /${command.name}`, icon: "check" });
        return true;
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, `/${command.name} 失败`), icon: "alert" });
        return false;
      }
    }
    if (execute.kind === "invoke") {
      const compacting = execute.commandId === "builtin.compact";
      if (compacting) setCompactPending(true);
      try {
        const handle = await client.command("operator.invoke", {
          commandId: execute.commandId,
          ...(execute.arguments ? { arguments: execute.arguments } : {}),
        });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        if (compacting) {
          if (compactCancelRequestedRef.current) {
            setShellNotice({ text: "已取消压缩", icon: "info" });
          } else {
            const notice = compactNoticeFromOutput(outcome.output, { successText: "已压缩上下文" });
            setShellNotice({ text: notice.text, icon: notice.ok ? "check" : "alert" });
            if (notice.ok) refreshViewedTelemetry();
          }
        } else {
          const line = outcome.output.find((item) => item.trim().length > 0);
          setShellNotice({
            text: line ?? `已执行 /${command.name}`,
            icon: "check",
          });
        }
        return true;
      } catch (error) {
        if (compacting && compactCancelRequestedRef.current) {
          setShellNotice({ text: "已取消压缩", icon: "info" });
        } else {
          setShellNotice({ text: hostErrorMessage(error, `/${command.name} 失败`), icon: "alert" });
        }
        return false;
      } finally {
        if (compacting) setCompactPending(false);
        if (compacting) compactCancelRequestedRef.current = false;
      }
    }
    return false;
  };

  /** 项目行「＋」：在指定项目下新建会话。非激活项目先 workspace.open
   * 并等待回执（Host 在回执前完成 Runtime 重绑），再 session.create，
   * 否则会话会建到旧项目的 cwd 里。 */
  const startNewChatInProject = useCallback((project: SelectedProject) => {
    if (mdi) { mdi.store.openFromDirectory({ targetId: executionTarget.id, workspaceId: project.id, draftId: crypto.randomUUID() }); return; }
    if (previewMode.preview) {
      // 预览模式：只切换本地演示状态，不调 Host。
      setPreviewProjectId(project.id);
      setSelectedProject(project);
      setPreviewThreadId("t0");
      setExplorerOpen(true);
      expandProject(project.id);
      setProjectListExpanded(true);
      go("workbench");
      return;
    }
    if (!go("workbench")) return;
    setSessionActionError(undefined);
    if (sessionCreateWaitRef.current) return;
    const generation = navigationGate.next();
    setSelectedProvisionalSessionId(undefined);
    onNewThread();
    beginDockDraft(project.id);
    runSessionCreate(() => workspaceActionQueue.enqueue(async () => {
      const open = await client.command("workspace.open", { workspaceId: project.id as WorkspaceId });
      const model = await waitReceipt<WorkspaceListReadModel>(client, open.requestId);
      if (!navigationGate.isCurrent(generation)) return;
      onWorkspacesChange(model);
      setSelectedProject(project);
      setExplorerOpen(true);
      expandProject(project.id);
      setProjectListExpanded(true);
      void loadProjectHistory(project.id as WorkspaceId);
      const handle = await client.command("session.create", {});
      const created = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
      refreshSessionTitles(project.id as WorkspaceId);
      return created;
    }));
  }, [client, expandProject, loadProjectHistory, navigationGate, previewMode.preview, go, onNewThread, onWorkspacesChange, runSessionCreate, refreshSessionTitles, workspaceActionQueue]);

  const openManagedWorktree = useCallback(async (workspaceId: string) => {
    await waitForNewSession();
    const projects = await client.query("projects.list", {});
    const project = projects.workspaces.find(row => row.workspaceId === workspaceId);
    if (!project) throw new Error("Worktree workspace is no longer registered");
    startNewChatInProject({ id: project.workspaceId, name: project.name });
    const result = await waitForNewSession();
    if (!result.ok) throw new Error(result.error);
  }, [client, waitForNewSession, startNewChatInProject]);

  /** opts.resumeForAction：行级「打开并执行」——即使无驻留也 resume，让目标会话
      真正成为 Runtime 活动会话；失败时向上抛出，由调用方统一报告并中止后续动作。 */
  const openHistoryEntry = (entry: SessionHistoryEntry, workspaceId?: WorkspaceId, opts?: { resumeForAction?: boolean; skipQueue?: boolean }): Promise<void> => {
    if (mdi && !opts?.resumeForAction) {
      const viewId = mdi.store.openFromDirectory({ targetId: executionTarget.id, workspaceId: workspaceId ?? mdi.document.ref.workspaceId, sessionId: entry.sessionId, threadId: entry.threadId, historyId: entry.historyId });
      mdi.store.updateDocument(mdi.store.documentFor(viewId)!.id, { title: entry.title ?? t("conversation.untitledSession") });
      globalThis.window.dispatchEvent(new CustomEvent("omp:conversation-focus", { detail: viewId }));
      return Promise.resolve();
    }
    if (!onRoute("workbench")) return opts?.resumeForAction ? Promise.reject(new Error("会话切换已取消")) : Promise.resolve();
    const generation = navigationGate.next();
    setSelectedProvisionalSessionId(undefined);
    if (previewMode.preview) {
      onSelectThread(entry);
      return Promise.resolve();
    }
    const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    const resident = residentForSession(residentModel, entry.sessionId);
    const targetWorkspaceId = resident?.workspaceId ?? workspaceId ?? active?.workspaceId;
    const workspaceSwitchPending = targetWorkspaceId !== undefined && active?.workspaceId !== targetWorkspaceId && resident === undefined;
    // Same-workspace navigation and resident activation can update the identity
    // immediately. For a cold cross-workspace archive row, wait for workspace.open
    // so the Host archive reader is never asked to scan the old cwd first.
    const selectEntry = () => {
      if (entry.sessionId) commitDockSelection({ target: executionTarget.id ?? "local", project: targetWorkspaceId ?? null, session: entry.sessionId });
      onSelectThread(entry);
    };
    if (!workspaceSwitchPending) selectEntry();
    const run = async () => {
      try {
        if (!navigationGate.isCurrent(generation)) {
          if (opts?.resumeForAction === true) throw new Error("会话切换已取消");
          return;
        }
        let workspaces: WorkspaceListReadModel | undefined;
        if (targetWorkspaceId !== undefined) {
          const open = await client.command("workspace.open", { workspaceId: targetWorkspaceId });
          workspaces = await waitReceipt<WorkspaceListReadModel>(client, open.requestId);
          if (!navigationGate.isCurrent(generation)) {
            if (opts?.resumeForAction === true) throw new Error("会话切换已取消");
            return;
          }
          onWorkspacesChange(workspaces);
          if (workspaceSwitchPending && navigationGate.isCurrent(generation)) selectEntry();
          const selectedWorkspace = workspaces.workspaces.find((workspace) => workspace.workspaceId === targetWorkspaceId);
          if (selectedWorkspace !== undefined) {
            setSelectedProject({ id: selectedWorkspace.workspaceId, name: selectedWorkspace.name });
            expandProject(selectedWorkspace.workspaceId);
            void loadProjectHistory(selectedWorkspace.workspaceId);
          }
        }
        setExplorerOpen(true);
        setProjectListExpanded(true);
        // 行级「打开并执行」即使无驻留也要 resume：后续动作（fork/compact/export…）
        // 都作用于 Runtime 活动会话，目标必须先成为活动会话。
        if (opts?.resumeForAction === true || resident !== undefined) {
          if (!navigationGate.isCurrent(generation)) {
            if (opts?.resumeForAction === true) throw new Error("会话切换已取消");
            return;
          }
          const handle = await client.command("session.resume", { threadId: entry.threadId });
          const resumed = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
          if (opts?.resumeForAction === true && entry.sessionId !== undefined && resumed.sessionId !== entry.sessionId) {
            throw new Error("恢复的会话与目标会话不一致");
          }
        }
        if (navigationGate.isCurrent(generation)) setSessionActionError(undefined);
      } catch (error) {
        if (opts?.resumeForAction === true) throw error;
        if (navigationGate.isCurrent(generation)) setSessionActionError(hostErrorMessage(error, "打开会话失败"));
      }
    };
    return opts?.skipQueue === true ? run() : workspaceActionQueue.enqueue(run);
  };

  const resolveProvisionalHistoryEntry = async (
    thread: ProvisionalProjectThread,
  ): Promise<SessionHistoryEntry | undefined> => {
    const known = state.model.history?.entries.find((entry) => entry.sessionId === thread.sessionId)
      ?? historyAll?.entries.find((entry) => entry.sessionId === thread.sessionId)
      ?? Object.values(projectHistoryCache)
        .flatMap((historyState) => historyState.model?.entries ?? [])
        .find((entry) => entry.sessionId === thread.sessionId);
    if (known !== undefined) return known;
    const refreshed = await loadProjectHistory(thread.workspaceId, PROJECT_THREADS_QUERY_MAX);
    return refreshed?.entries.find((entry) => entry.sessionId === thread.sessionId);
  };

  const openProvisionalThread = (thread: ProvisionalProjectThread) => {
    if (!onRoute("workbench")) return;
    if (mdi) {
      const existing = mdi.store.getSnapshot().documents.find(document => document.ref.targetId === executionTarget.id && document.ref.workspaceId === thread.workspaceId && (document.ref.sessionId === thread.sessionId || document.ref.draftId === thread.sessionId));
      const viewId = mdi.store.openFromDirectory(existing?.ref ?? { targetId: executionTarget.id, workspaceId: thread.workspaceId, ...(thread.submitted ? { sessionId: thread.sessionId } : { draftId: thread.sessionId }) });
      mdi.store.updateDocument(mdi.store.documentFor(viewId)!.id, { title: thread.title });
      return;
    }
    // The current Runtime session can be viewed immediately even while its
    // JSONL tail is still being flushed and the history catalog has no row yet.
    // Do not turn that normal live state into the misleading "仍在写入" error.
    if (shouldOpenLiveProvisional(thread.sessionId, snapshot?.sessionId)) {
      setSessionActionError(undefined);
      commitDockSelection({ target: executionTarget.id ?? "local", project: thread.workspaceId, session: thread.sessionId });
      setSelectedProvisionalSessionId(thread.sessionId);
      onNewThread();
      onRoute("workbench");
      return;
    }
    if (!thread.submitted) {
      commitDockSelection({ target: executionTarget.id ?? "local", project: thread.workspaceId, session: thread.sessionId });
      setSelectedProvisionalSessionId(thread.sessionId);
      onNewThread();
      setSessionActionError(undefined);
      onRoute("workbench");
      return;
    }
    void (async () => {
      const entry = await resolveProvisionalHistoryEntry(thread);
      if (entry === undefined) {
        setSessionActionError("会话记录仍在写入，请稍后重试");
        return;
      }
      openHistoryEntry(entry, thread.workspaceId);
    })();
  };

  const requestArchiveProvisionalThread = (thread: ProvisionalProjectThread) => {
    if (archiveBusyRef.current) {
      notifyArchiveBusy();
      return;
    }
    void (async () => {
      const entry = await resolveProvisionalHistoryEntry(thread);
      if (entry === undefined) {
        setSessionActionError("会话记录仍在写入，请稍后重试");
        return;
      }
      requestArchiveThread(entry, thread.workspaceId);
    })();
  };

  const selectBranchedSession = async (sessionId: string): Promise<boolean> => {
    const project = dockSelectionRef.current.project;
    beginDockDraft(project);
    const scope: DockScope = { target: executionTarget.id ?? "local", project, session: sessionId };
    dock.store.adoptDraft(scope);
    commitDockSelection(scope);
    await refreshHistoryModels();
    try {
      const history = await client.query("history.list", {
        limit: PROJECT_THREADS_QUERY_MAX,
        status: "active",
      });
      const entry = history.entries.find((item) => item.sessionId === sessionId);
      if (entry === undefined) return false;
      if (mdi) onSelectThread(entry);
      else openHistoryEntry(entry);
      return true;
    } catch {
      return false;
    }
  };
  btwOnBranchedRef.current = selectBranchedSession;

  const runPaletteAction = (action: PaletteAction) => {
    closePalette(false);
    switch (action.kind) {
      case "dock": {
        const current = dock.store.getSnapshot();
        if (action.operation === "undo") dock.store.undo();
        else if (action.operation === "redo") dock.store.redo();
        else if (action.operation === "lock") dock.store.updatePreferences({ locked: !current.preferences.locked });
        else if (action.operation === "snap") dock.store.updatePreferences({ snap: !current.preferences.snap });
        else if (action.operation === "rail") dock.store.dispatch({ type: "region", region: "rail", visible: current.layout.rail.mode === "hidden" });
        else if (action.operation === "files") dock.store.dispatch({ type: "open", panel: "files" });
        else if (action.operation === "reset") dock.store.resetFactory();
        else dock.store.applyPreset(action.operation);
        go("workbench");
        return;
      }
      case "route":
        go(action.route);
        return;
      case "diagnostics":
        if (action.intent !== undefined) setDiagnosticsIntent(action.intent);
        go("diagnostics");
        return;
      case "newChat":
        startNewChat(action.noContextFiles);
        return;
      case "pickProject":
        void pickProject();
        return;
      case "selectThread":
        openHistoryEntry(action.entry);
        return;
      case "previewThread":
        setPreviewThreadId(action.threadId);
        {
          const hit = findPreviewThread(action.threadId);
          if (hit) {
            setPreviewProjectId(hit.project.id);
            setSelectedProject({ id: hit.project.id, name: hit.project.name });
            setExplorerOpen(true);
            setProjectListExpanded(true);
          }
        }
        go("workbench");
        return;
      case "selectProject":
        selectProject({ id: action.id, name: action.name });
        go("workbench");
        return;
      case "previewProject":
        setPreviewProjectId(action.id);
        {
          const project = findPreviewProject(action.id);
          if (project) {
            setSelectedProject({ id: project.id, name: project.name });
            setExplorerOpen(true);
            setProjectListExpanded(true);
            const first = project.threads[0];
            if (first) setPreviewThreadId(first.id);
          }
        }
        go("workbench");
        return;
      case "toggleSidebar":
        toggleSidebar();
        return;
      case "toggleBottom":
        go("workbench");
        toggleBottom();
        return;
      case "toggleSide":
        go("workbench");
        toggleSide();
        return;
      case "openSkills":
        go("workbench");
        setSkillsOpen(true);
        return;
      case "toggleTheme":
        updateAppSettings({ theme: theme === "light" ? "dark" : "light" });
        return;
      case "openBottom":
        go("workbench");
        setBottomTab(action.tab);
        return;
      case "openSide":
        go("workbench");
        setSideTab(action.tab);
        return;
      case "openContext":
        applySlashUi("context-viewer");
        return;
      case "openSettings":
        setSettingsIntent(action.group, action.setting);
        setSettingsNonce((value) => value + 1);
        go("settings");
        return;
      case "openModelConfig":
        if (modelConfigHasUnsavedChanges() && !window.confirm("有未保存的模型配置更改，重新打开会丢弃草稿。确定继续？")) return;
        setModelConfigIntent({ tab: action.tab });
        setMcNonce((value) => value + 1);
        go("model-config");
        return;
      case "openCapabilities":
        setCapIntent(action.tab, action.name);
        setCapNonce((value) => value + 1);
        setSkillsOpen(false);
        go("capabilities");
        return;
    }
  };

  useEffect(() => {
    if (!paletteOpen) return;
    if (previewMode.preview) {
      setPaletteInventory(createPreviewDrawerItems());
      return;
    }
    let cancelled = false;
    void client.query("skills.get", {}).then((model) => {
      if (!cancelled) setPaletteInventory(toDrawerItems(model));
    }).catch(() => {
      if (!cancelled) setPaletteInventory([]);
    });
    return () => { cancelled = true; };
  }, [paletteOpen, previewMode.preview, client]);

  const paletteGroups = useMemo(() => buildPaletteGroups({
    preview: previewMode.preview,
    untitledTitle: t("conversation.untitledSession"),
    historyEntries: state.model.history?.entries ?? [],
    workspaces: sidebarProjectOrder(state.model.workspaces),
    ...(selectedProject ? { activeProjectName: selectedProject.name } : {}),
    inventory: paletteInventory,
    query: paletteQuery,
  }), [previewMode.preview, state.model.history, state.model.workspaces, selectedProject, paletteInventory, paletteQuery, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (paletteOpen) {
          closePalette();
          return;
        }
        if (dialog) {
          setDialog(null);
          return;
        }
        if (archivePending) {
          if (!archiveBusy) {
            setArchivePending(null);
            setArchiveError(undefined);
          }
          return;
        }
        setOpenMenu(null);
        if (skillsOpen) setSkillsOpen(false);
        setOmpMenuOpen(false);
        return;
      }
      // The macOS menu bar owns these shortcuts in the desktop app and sends them as menu commands.
      if (event.isComposing || !isPrimaryModifier(event) || nativeMenuOwnsShortcuts()) return;
      const key = event.key.toLowerCase();
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        toggleSidebar();
      } else if (key === "k" && event.shiftKey) {
        event.preventDefault();
        setSkillsOpen((value) => !value);
      } else if (key === "k") {
        event.preventDefault();
        openPalette();
      } else if (key === "o" && event.shiftKey) {
        event.preventDefault();
        startNewChat();
      } else if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        toggleBottom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [archiveBusy, archivePending, toggleBottom, toggleSidebar, dialog, go, skillsOpen, paletteOpen, closePalette, openPalette, startNewChat]);

  // macOS menu bar: the same actions as the shortcuts above plus a few menu-only ones.
  const runMenuCommand = useRef<(command: string) => void>(() => {});
  runMenuCommand.current = (command) => {
    if (mdi && !mdi.active) return;
    switch (command) {
      case "app.settings": go("settings"); return;
      case "file.newChat": startNewChat(); return;
      case "file.openProject": void pickProject(); return;
      case "view.commandPalette": openPalette(); return;
      case "view.toggleSidebar": toggleSidebar(); return;
      case "view.toggleBottomPanel": toggleBottom(); return;
      case "view.toggleSkills": setSkillsOpen((value) => !value); return;
      case "help.shortcuts": openDialog("shortcuts"); return;
      case "help.tutorial": openOnboardingTour(); return;
    }
  };
  useEffect(() => globalThis.ompStudioChrome?.onMenuCommand?.((command) => runMenuCommand.current(command)), []);

  // 项目 shell 动作（外部编辑器 / 文件管理器）：AppShell 统一持有，
  // 顶栏面包屑菜单与侧栏应用菜单共用同一套状态与 Toast 提示。
  const [shellAction, setShellAction] = useState<"editor" | "directory" | null>(null);
  const { openRenameDialog, renameOpen, renameBusy, setRenameOpen, renameValue, setRenameValue, submitRename, renameError } = useSessionRename({ renameTargetSessionId, selected, renameTargetWorkspaceId, threadTitle, workspaceActionQueue, snapshot, can, client, refreshHistoryAfterTitle, setProvisionalThreadsBySession, setShellNotice, ensureWorkspaceActive });
  const realActiveWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
  // 预览模式只是显示层：桌面 shell 操作仍走真实 API。若已注册过真实
  // workspace，就允许在预览态下对当前真实项目执行；没有真实 workspace
  // 时保持禁用并给出原因，绝不使用 preview fixture 里的演示路径。
  const projectShellUnavailable = realActiveWorkspace === undefined
    ? "请先打开本地项目"
    : (globalThis.ompStudioChrome?.openProjectInEditor === undefined || globalThis.ompStudioChrome?.openProjectDirectory === undefined)
      ? "仅桌面端可用"
      : undefined;

  const runProjectShellAction = async (kind: "editor" | "directory", action: () => Promise<ProjectShellActionResult>) => {
    if (shellAction !== null) return;
    setShellAction(kind);
    try {
      const result = await action();
      if (result.status === "cancelled") {
        setShellNotice({ text: "已取消选择打开器", icon: "info" });
        return;
      }
      setShellNotice(kind === "editor"
        ? { text: result.editorName ? `已用 ${result.editorName} 打开项目` : "已在外部编辑器中打开项目", icon: "check" }
        : { text: "已打开项目目录", icon: "check" });
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : String(cause);
      setShellNotice({ text: `操作失败：${message}`, icon: "alert" });
    } finally {
      setShellAction(null);
    }
  };

  const openProjectInEditor = () => {
    const workspace = realActiveWorkspace;
    const openInEditor = globalThis.ompStudioChrome?.openProjectInEditor;
    if (workspace === undefined || openInEditor === undefined) return;
    void runProjectShellAction("editor", () => openInEditor(workspace.workspaceId));
  };

  const openProjectDirectory = () => {
    const workspace = realActiveWorkspace;
    const openDirectory = globalThis.ompStudioChrome?.openProjectDirectory;
    if (workspace === undefined || openDirectory === undefined) return;
    void runProjectShellAction("directory", async () => {
      await openDirectory(workspace.workspaceId);
      return { status: "opened" };
    });
  };

  // Explorer 文件「更多」菜单：本机编辑器清单只在真实 workspace 且桌面 chrome 可用时拉取一次。
  const { fileOpeners, fileShellUnavailable, runFileShellAction } = useWorkspaceFileActions({ workspace: realActiveWorkspace, remote: !!executionTarget.id, onNotice: setShellNotice, onOpenIda: absolute => { setCapIntent("ida", absolute); setCapNonce(value => value + 1); go("capabilities"); } });
  // File windows reuse the Explorer shell actions and the Composer capsule chain; a line range follows the capsule as plain text.
  const fileViewerActions: FileViewerActions = {
    openers: fileOpeners,
    runShell: runFileShellAction,
    addContext: ({ path, label, lines }) => {
      const composer = composerRef.current;
      if (!composer) return;
      const id = `file-context-${crypto.randomUUID()}`;
      composer.insertChip({ id, kind: /\.(png|jpe?g|gif|webp)$/iu.test(path) ? "image" : "file", label, path });
      if (lines) {
        const snapshot = composer.getSnapshot(), nodes = [...snapshot.doc.nodes];
        const index = nodes.findIndex((node) => node.type === "chip" && node.chip.id === id);
        if (index >= 0) {
          nodes.splice(index + 1, 0, { type: "text", value: ` L${lines[0]}${lines[1] === lines[0] ? "" : `-L${lines[1]}`} ` });
          composer.setSnapshot({ ...snapshot, doc: { nodes } });
        }
      }
      composer.focus();
    },
  };

  const chrome: ShellChrome = {
    collapsed: mdi ? collapsed : !layout.sidebarShown,
    skillsOpen,
    explorerOpen,
    projectListExpanded,
    expandedProjects,
    projectHistories: projectHistoryCache,
    projectsLoading,
    provisionalThreads: Object.values(provisionalThreadsBySession),
    ...(selectedHistoryId === null && activeComposerOwner !== undefined
      ? { activeProvisionalSessionId: activeComposerOwner as SessionId }
      : {}),
    theme,
    sidebarWidth,
    splitRatio,
    selectedHistoryId,
    selectedProject,
    skillsEnabledCount,
    previewProjectId,
    previewThreadId,
    ...(previewDeckWait === undefined ? {} : { previewDeckWait }),
    onToggleSidebar: toggleSidebar,
    onToggleSkills: () => setSkillsOpen((value) => !value),
    onSkillsEnabledCount: setSkillsEnabledCount,
    onToggleExplorer: () => setExplorerOpen((value) => !value),
    onToggleTheme: () => updateAppSettings({ theme: theme === "light" ? "dark" : "light" }),
    onResizeSidebar: setSidebarWidth,
    onResizeSplit: setSplitRatio,
    onSelectProject: selectProject,
    onToggleProject: (project) => {
      const open = previewMode.preview
        ? previewProjectId === project.id && projectListExpanded
        : expandedProjects.has(project.id);
      // 再点已展开的项目：收起会话列表，保持当前选中（不发 workspace.open）。
      // 折叠同时重置该项目已展开的会话数，再展开从头显示默认 6 条。
      if (open) {
        if (previewMode.preview) setProjectListExpanded(false);
        else collapseProject(project.id);
        setProjectThreadLimits((current) => {
          if (!(project.id in current)) return current;
          const { [project.id]: _reset, ...rest } = current;
          return rest;
        });
        return;
      }
      if (previewMode.preview) {
        setProjectListExpanded(true);
        setPreviewProjectId(project.id);
        const hit = findPreviewProject(project.id);
        if (hit) {
          setSelectedProject({ id: hit.id, name: hit.name });
          setExplorerOpen(true);
          if (previewThreadId !== "t0") {
            const first = hit.threads[0];
            if (first) setPreviewThreadId(first.id);
          }
        }
        return;
      }
      selectProject(project);
    },
    onLoadProjectHistory: (workspaceId) => {
      if (!previewMode.preview) void loadProjectHistory(workspaceId as WorkspaceId);
    },
    onSelectThread: (entry, workspaceId) => {
      openHistoryEntry(entry, workspaceId);
    },
    onSelectProvisionalThread: openProvisionalThread,
    onPickProject: () => {
      void pickProject();
    },
    onCreateProject: () => {
      go("workbench");
      setCreateProjectNonce((value) => value + 1);
    },
    onStartNewChat: startNewChat,
    onStartChatInProject: startNewChatInProject,
    onArchivePreviewThread: requestArchivePreview,
    onArchiveThread: requestArchiveThread,
    onArchiveProvisionalThread: requestArchiveProvisionalThread,
    onUnarchiveThread: unarchiveThread,
    onDeleteSessionThread: deleteSessionThread,
    // 显式无参包装：防止未来被直接挂到 onClick 时把事件对象当成 initialTitle/target。
    onRenameThread: () => openRenameDialog(),
    onForkThread: forkThread,
    onHandoffThread: handoffThread,
    onCompactThread: () => compactThread(),
    onThreadRowAction: runThreadRowAction,
    compactPending,
    onCancelCompact: cancelCompact,
    onExportThread: exportThread,
    archiveTarget,
    archiveTargetReason,
    residentSessionId,
    onLoadMoreThreads: loadMoreThreads,
    projectThreadLimits,
    hiddenPreviewThreads,
    onSelectPreviewProject: (id) => {
      setPreviewProjectId(id);
      const project = findPreviewProject(id);
      if (project) {
        setSelectedProject({ id: project.id, name: project.name });
        setExplorerOpen(true);
        setProjectListExpanded(true);
        if (previewThreadId !== "t0") {
          const first = project.threads[0];
          if (first) setPreviewThreadId(first.id);
        }
      }
    },
    onSelectPreviewThread: (id) => {
      if (mdi) {
        const hit = findPreviewThread(id);
        if (hit) mdi.store.openFromDirectory({ targetId: executionTarget.id, workspaceId: hit.project.id, previewProjectId: hit.project.id, previewThreadId: id });
        go("workbench");
        return;
      }
      setPreviewThreadId(id);
      const hit = findPreviewThread(id);
      if (hit) {
        setPreviewProjectId(hit.project.id);
        setSelectedProject({ id: hit.project.id, name: hit.project.name });
        setExplorerOpen(true);
        setProjectListExpanded(true);
      }
      go("workbench");
    },
    onOpenCapabilities: (tab, name) => {
      if (tab) {
        setCapIntent(tab, name);
        setCapNonce((value) => value + 1);
      }
      setSkillsOpen(false);
      go("capabilities");
    },
    onOpenPalette: openPalette,
    paletteOpen,
    onToggleOmpMenu: () => setOmpMenuOpen((value) => !value),
    ompMenuOpen,
    onOpenDialog: openDialog,
    onOpenTerminalPanel: () => setBottomTab("terminal"),
    onOpenProjectInEditor: openProjectInEditor,
    onOpenProjectDirectory: openProjectDirectory,
    projectShellUnavailable,
    projectShellAction: shellAction,
    fileOpeners,
    fileShellUnavailable,
    onFileShellAction: runFileShellAction,
    onAddComposerContext: (chip) => {
      const image = /\.(png|jpe?g|gif|webp)$/iu.test(chip.path);
      composerRef.current?.insertChip({
        kind: image ? "image" : chip.kind,
        label: chip.label,
        path: chip.path,
      });
      composerRef.current?.focus();
    },
    onInsertSkill: (skill) => {
      composerRef.current?.insertChip({
        kind: "skill",
        label: skill.name,
        name: skill.name,
      });
      composerRef.current?.focus();
    },
    onRemoveComposerSkill: (name) => {
      composerRef.current?.removeSkillChip(name);
      composerRef.current?.focus();
    },
    draftSkills,
    usedSkills,
  };

  const insertPreparedPrompt = (text: string) => {
    if (!go("workbench")) return;
    setComposerInsertion({ owner: activeComposerOwner, text });
  };
  const windowAction = mdi?.store.actionFor(mdi.document.id);
  useEffect(() => {
    if (!mdi?.active || !windowAction) return;
    mdi.store.takeAction(mdi.document.id);
    if (windowAction.kind === "archive") requestArchiveThread(windowAction.entry, windowAction.workspaceId as WorkspaceId);
    else if (windowAction.kind === "delete") void deleteSessionThread(windowAction.entry);
    else runThreadRowAction(windowAction.entry, windowAction.workspaceId as WorkspaceId, windowAction.kind);
  }, [mdi?.active, windowAction?.id]);
  useEffect(() => {
    if (!mdi || state.loading) return;
    const existing = mdi.store.getSnapshot().documents.find(doc => doc.id === mdi.document.id)!;
    const ref = { ...existing.ref, targetId: executionTarget.id,
      ...(previewMode.preview ? { workspaceId: previewProjectId, previewProjectId, previewThreadId } : {
        ...(dockSelection.project ? { workspaceId: dockSelection.project } : {}),
        ...(viewedSessionId ? { sessionId: viewedSessionId, draftId: undefined } : {}),
        ...(selected?.threadId ? { threadId: selected.threadId, historyId: selected.historyId } : {}),
      }) };
    mdi.store.updateDocument(mdi.document.id, { ref, title: threadTitle, projectName: previewMode.preview ? findPreviewProject(previewProjectId)?.name : selectedProject?.name });
  }, [mdi?.document.id, threadTitle, viewedSessionId, dockSelection.project, selected?.threadId, selected?.historyId, previewProjectId, previewThreadId, previewMode.preview, executionTarget.id, selectedProject?.name, state.loading]);
  return (
    <AnnotationsProvider client={client} workspaceId={hubWorkspaceId} sessionId={viewedSessionId} runtimeSessionId={snapshot?.sessionId} onInsert={insertPreparedPrompt}>
    <BackgroundProvider key={previewMode.preview ? "background-preview" : "background-real"} preview={previewMode.preview} theme={theme}>
    <div className="app" id="appRoot" aria-busy={state.loading}>
      <SharedSurface region="background"><AppBackgroundLayer route={state.route} theme={theme} /></SharedSurface>
      <a className="skip-link" href="#convoScroll">跳到对话内容</a>
      <SharedSurface region="title">
      <Titlebar
        canBack={trailAt > 0}
        canForward={trailAt < trail.length - 1}
        onBack={() => {
          if (trailAt <= 0) return;
          const next = trailAt - 1;
          const route = trail[next] ?? "workbench";
          if (!onRoute(route)) return;
          setTrailAt(next);
          if (route === "home") {
            setSelectedProject(null);
            setExplorerOpen(false);
          } else if (route === "workbench") {
            enterWorkbench();
          }
        }}
        onForward={() => {
          if (trailAt >= trail.length - 1) return;
          const next = trailAt + 1;
          const route = trail[next] ?? "workbench";
          if (!onRoute(route)) return;
          setTrailAt(next);
          if (route === "home") {
            setSelectedProject(null);
            setExplorerOpen(false);
          } else if (route === "workbench") {
            enterWorkbench();
          }
        }}
        onToggleSidebar={toggleSidebar}
        sidebarCollapsed={mdi ? collapsed : !layout.sidebarShown}
        menus={
          <>
            <TitleMenu id="file" label={t("menu.file")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => startNewChat()}>{t("menu.newThread")}<span className="kbd">{formatShortcut(SHORTCUTS.newChat)}</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("history")}>{t("menu.history")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("agent-hub")}>Agent Hub</button>
              <button className="menu-item" role="menuitem" onClick={() => go("capabilities")}>{t("menu.capabilities")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("model-config")}>{t("menu.modelConfig")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("media")}>{t("media.title")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("settings")}>{t("menu.settings")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("diagnostics")}>{t("menu.diagnostics")}</button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => { setOpenMenu(null); openPalette(); }}>{t("menu.commandPalette")}<span className="kbd">{formatShortcut(SHORTCUTS.commandPalette)}</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("home")}>{t("menu.home")}</button>
            </TitleMenu>
            <TitleMenu id="edit" label={t("menu.edit")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("undo")}>{t("menu.undo")}<span className="kbd">{formatShortcut(SHORTCUTS.undo)}</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("redo")}>{t("menu.redo")}<span className="kbd">{formatShortcut(SHORTCUTS.redo)}</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runEdit("cut")}>{t("menu.cut")}<span className="kbd">{formatShortcut(SHORTCUTS.cut)}</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("copy")}>{t("menu.copy")}<span className="kbd">{formatShortcut(SHORTCUTS.copy)}</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("paste")}>{t("menu.paste")}<span className="kbd">{formatShortcut(SHORTCUTS.paste)}</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("selectAll")}>{t("menu.selectAll")}<span className="kbd">{formatShortcut(SHORTCUTS.selectAll)}</span></button>
            </TitleMenu>
            <TitleMenu id="view" label={t("menu.view")} openId={openMenu} onToggle={setOpenMenu}>
              <DockViewMenu
                onClose={() => setOpenMenu(null)}
                onSettings={() => { setSettingsIntent("general"); go("settings"); }}
                /* 区域开关同时看到「偏好真值」和「布局求解器实际呈现」：窄窗里
                   偏好为 true 但被裁掉的区域，菜单必须显示未勾选，点一次要抢回
                   聚焦优先级，而不是把偏好关掉。 */
                regionState={{
                  left: { visible: mdi ? !collapsed : dock.layout.left.visible, presented: mdi ? !collapsed : layout.sidebarShown },
                  right: { visible: dock.layout.right.visible, presented: mdi ? sideOpen : layout.sideShown },
                  /* 底栏的`presented`是整条在屏而不是正文展开：折叠态只显示
                     标签行，它仍然是可见区域的真实状态；若用 expanded 判定，菜单会
                     显示未勾选、点一次却只是重复设置 visible（store 无变化），用户
                     看到的是菜单没反应。展开/折叠由标签条上的箭头负责。 */
                  bottom: { visible: dock.layout.bottom.visible, presented: mdi ? bottomVisible : layout.bottomVisible },
                  rail: { visible: dock.layout.rail.mode !== "hidden", presented: dock.layout.rail.mode !== "hidden" },
                }}
              />
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => chrome.onToggleTheme())}>{theme === "dark" ? t("menu.lightTheme") : t("menu.darkTheme")}</button>
            </TitleMenu>
            <TitleMenu id="help" label={t("menu.help")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => { setOpenMenu(null); openOnboardingTour(); }}>{t("menu.tutorial")}</button>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("shortcuts")}>{t("menu.shortcuts")}</button>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("about")}>{t("menu.about")}</button>
              <button className="menu-item" role="menuitem" disabled data-tip={t("menu.documentation")}>{t("menu.documentation")}</button>
            </TitleMenu>
          </>
        }
      />
      </SharedSurface>
      {sessionActionError ? (
        <div className="empty" role="alert" style={{ padding: "8px 16px" }}>
          <p className="muted small">{sessionActionError}</p>
        </div>
      ) : null}
      {/* The rail lives outside .app-body: sidebar overlays and the workbench
          width observer must never cover or measure it. */}
      <div className="app-shell">
        {identityFlight.ghost}
        <SharedSurface region="navigation">
        <AppNavRail
          activeRoute={state.route}
          profile={profile}
          update={effectiveUpdate === null ? null : { ...(effectiveUpdate.version === undefined ? {} : { version: effectiveUpdate.version }) }}
          demo={previewMode.preview}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsedWithFlight(!railCollapsed)}
          onNavigate={navigateFromRail}
          onOpenUpdate={() => setShowAppUpdateDialog(true)}
          menuOpen={chrome.ompMenuOpen}
          /* The same control lives in the rail (expanded) and in the sidebar
             footer (collapsed); the menu anchors to whichever one was clicked. */
          onToggleMenu={(anchor) => {
            ompMenuAnchorRef.current = anchor;
            chrome.onToggleOmpMenu();
          }}
          /* Dock panels are fixed-position bodies positioned from their slot's
             rect; a rail width change moves slots without resizing them, so the
             dock has to be re-measured on every frame of the slide. */
          onLayoutShift={dock.hosts.flush}
          avatarRef={railAvatarRef}
        />
        </SharedSurface>
      {showPage ? (
        <SharedSurface region="page">
        <SecondaryPage
          route={pageRoute}
          title={t(pageMeta.titleKey)}
          titleIcon={pageMeta.icon}
          theme={theme}
          className={shellClass}
          onRoute={go}
          /* 统计页的唯一入口在首页 Token 用量卡右上角，页头返回就回首页；
             其余二级页仍回工作台。 */
          backRoute={pageRoute === "statistics" ? "home" : "workbench"}
          onToggleTheme={chrome.onToggleTheme}
        >
          {state.hostError && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>Host 不可用</b> · <span className="banner-detail">{state.hostError.message}</span></span>
            </div>
          )}
          {state.clientState?.connection.resyncRequired && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>需要重新同步</b> · <span className="banner-detail">正在恢复最新 Runtime 状态，敏感操作已暂停。</span></span>
            </div>
          )}
          {pageRoute !== "diagnostics" ? (
            <RuntimeLossBanner
              {...(runtime === undefined ? {} : { runtime })}
              client={client}
              preview={previewMode.preview}
              onOpenDiagnostics={() => go("diagnostics")}
            />
          ) : null}
          <DeferredPanel key={pageRoute}>
          {pageRoute === "home" ? (
            <HomePage
              {...(runtime ? { runtime } : {})}
              {...(snapshot ? { snapshot } : {})}
              {...(state.model.home ? { home: state.model.home } : {})}
              {...(state.model.history ? { history: state.model.history } : {})}
              {...(state.model.workspaces ? { workspaces: state.model.workspaces } : {})}
              client={client}
              onPickFolder={() => {
                if (previewMode.preview) return;
                void pickProject();
              }}
              onOpenWorkspace={(workspaceId) => openWorkspace(workspaceId)}
              onRoute={go}
            />
          ) : pageRoute === "history" ? (
            (() => {
              const historyModel = historyAll ?? state.model.history;
              return (
                <HistoryPage
                  nativeContext={{ sessionId:snapshot?.sessionId, available:hubRuntimeConnected, capabilities }}
                  workspaceId={hubWorkspaceId}
                  client={client}
                  onImported={() => void refreshHistoryModels()}
                  onImportedOpen={(sessionId, workspaceId) => { void client.query("history.list", { workspaceId, limit: PROJECT_THREADS_QUERY_MAX }).then(history => { const entry = history.entries.find(item => item.sessionId === sessionId); if (entry) void openHistoryEntry(entry, workspaceId); else setSessionActionError("Imported session is not yet available; refresh history"); }); }}
                  {...(historyModel ? { history: historyModel } : {})}
                  onRoute={go}
                  onSelectThread={chrome.onSelectThread}
                  onUnarchive={chrome.onUnarchiveThread}
                  onDeleteSession={chrome.onDeleteSessionThread}
                  onRenameSession={entry => runThreadRowAction(entry, undefined, "rename")}
                  onPinSession={entry => runThreadRowAction(entry, undefined, "pin")}
                />
              );
            })()
          ) : pageRoute === "agent-hub" ? (
            <AgentHubPage
              {...(snapshot ? { snapshot } : {})}
              {...(runtime ? { runtime } : {})}
              {...(state.clientState?.connection.resyncRequired ? { resyncRequired: true } : {})}
              {...(capabilities ? { capabilities } : {})}
              client={client}
              canSend={hubCanSend}
              runtimeConnected={hubRuntimeConnected}
              onOpenDiagnostics={() => go("diagnostics")}
              agents={viewedAgents}
              persistedReady={persistedAgentsReady}
              {...(viewedSessionId === undefined ? {} : { parentSessionId: viewedSessionId as SessionId })}
              {...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId })}
              pendingInteraction={pendingInteraction !== null}
              {...(hubWorkspaceId === undefined ? {} : { workspaceId: hubWorkspaceId })}
              loadMentions={fetchHubMentions}
              onOpenMain={() => go("workbench")}
            />
          ) : pageRoute === "media" ? (
            <MediaPage remote={!!executionTarget.id} capabilities={capabilities} client={client} workspaceId={hubWorkspaceId} sessionId={snapshot?.sessionId} runtimeAvailable={hubRuntimeConnected} onInsert={insertPreparedPrompt} />
          ) : pageRoute === "evaluation" ? (
            <EvaluationPage intent={evaluationIntent} onOpenModels={() => go("model-config")} onOpenDiagnostics={() => go("diagnostics")} client={client} sessionId={snapshot?.sessionId} workspaceId={hubWorkspaceId} available={hubRuntimeConnected} capabilities={capabilities} />
          ) : pageRoute === "model-config" ? (
            <ModelConfigPage capabilities={capabilities} key={mcNonce} client={modelClient} sessionId={modelConnection.sessionId} workspaceId={modelConnection.workspaceId} runtimeAvailable={modelConnection.runtimeStatus === "connected"} />
          ) : pageRoute === "statistics" ? (
            <StatisticsPage client={client}/>
          ) : pageRoute === "settings" ? (
            <SettingsPage
              onDictationModels={() => { setModelConfigIntent({ tab: "roles", role: "dictation" }); go("model-config"); }}
              onOpenModels={(tab) => { setModelConfigIntent({ tab }); go("model-config"); }}
              onOpenWorktree={openManagedWorktree}
              nativeContext={{ sessionId: snapshot?.sessionId, available: hubRuntimeConnected, capabilities }}
              memoryTargetId={executionTarget.id}
              client={client}
              predictionSessionId={snapshot?.sessionId}
              predictionAvailable={capabilities?.capabilities.some(capability=>capability.id==="prediction.control"&&capability.grade!=="unavailable")??false}
              key={settingsNonce}
              {...(snapshot ? { approvalMode } : {})}
              onSetApprovalMode={setApprovalMode}
              {...(snapshot ? { onForgetApprovals: forgetApprovals } : {})}
              {...(runtimeSettings === undefined ? {} : { runtimeSettings })}
            />
          ) : pageRoute === "diagnostics" ? (
            <DiagnosticsPage
              {...(snapshot?.runtimeIdentity ? { buildProvenance: snapshot.runtimeIdentity } : {})}
              nativeContext={{sessionId:snapshot?.sessionId,available:hubRuntimeConnected,capabilities}}
              client={client}
              {...(state.model.diagnostics ? { diagnostics: state.model.diagnostics } : {})}
              {...(capabilities ? { capabilities } : {})}
              {...(runtime ? { runtime } : {})}
              {...(environment ? { environment } : {})}
            />
          ) : (
            <CapabilitiesPage capabilities={capabilities} key={capNonce} client={client} sessionId={snapshot?.sessionId} runtimeAvailable={hubRuntimeConnected} onInsertPrompt={insertPreparedPrompt} onRunSlash={runSlashFromShell} onPinCompleted={refreshPinnedHistory} />
          )}
          {healthReady ? <WorkbenchHealth /> : null}
          </DeferredPanel>
          <SecondaryInteractionDeck client={client} interaction={pendingInteraction} runtimeConnected={hubRuntimeConnected} resyncRequired={state.clientState?.connection.resyncRequired === true} preview={previewMode.preview} />
        </SecondaryPage>
        </SharedSurface>
      ) : null}
      <EvaluationActivity client={client} visible={pageRoute !== "evaluation"} onOpen={(id, kind) => { setEvaluationIntent({ id, kind }); go("evaluation"); }} />
      <div hidden={workbenchHidden} inert={workbenchHidden} ref={layout.rootRef} className={`app-body adaptive-workbench ${mdi ? "" : shellClass}`} data-layout-overlay={layout.overlay ?? undefined}>
        {layout.overlay ? <button type="button" className="layout-overlay-backdrop" aria-label={t("common.close")} onClick={layout.dismissOverlay} /> : null}
        <SharedSurface region="sidebar"><AppSidebar state={state} chrome={chrome} client={client} onRoute={go} onOpenAppUpdateDialog={() => setShowAppUpdateDialog(true)} ompMenuAnchorRef={ompMenuAnchorRef} railCollapsed={railCollapsed} avatarRef={footerAvatarRef} footerBoxRef={footerBoxRef} /></SharedSurface>
        <div className="main-col">
          <ConversationTitleSurface>
          <AppTopbar
            state={state}
            client={client}
            chrome={chrome}
            onRoute={go}
            threadTitle={threadTitle}
            sideOpen={mdi ? sideOpen : layout.sideShown}
            onToggleSide={toggleSide}
            onOpenChanges={() => { setSideTab("changes"); }}
            onOpenGit={() => { setSideTab("git"); }}
            onOpenTerminal={() => { setBottomTab("terminal"); }}
            viewedSessionId={selected?.sessionId}
            telemetryRefreshToken={telemetryRefreshToken}
          />
          </ConversationTitleSurface>
          {state.hostError && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>{t("shell.hostUnavailable")}</b> · <span className="banner-detail">{state.hostError.message}</span></span>
            </div>
          )}
          {state.clientState?.connection.resyncRequired && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>{t("shell.resyncRequired")}</b> · <span className="banner-detail">{t("shell.resyncRequiredDetail")}</span></span>
            </div>
          )}
          <WorkbenchCanvas
            workbenchVisible={!workbenchHidden && (!mdi || mdi.visible)}
            viewedSessionName={threadTitle}
            railMode={layout.railMode}
            layoutOverlayDismiss={layout.dismissOverlay}
            onOpenWorktree={openManagedWorktree}
            state={state}
            client={client}
            viewIdentity={selectedProvisionalSessionId === undefined
              ? (selectedHistoryId === null ? `live:${freshView}` : `history:${selectedHistoryId}`)
              : `draft:${selectedProvisionalSessionId}`}
             {...((selectedProvisionalSessionId ?? selected?.sessionId ?? (mdi ? mdi.document.ref.sessionId ?? snapshot?.sessionId : undefined)) === undefined ? {} : { selectedSessionId: (selectedProvisionalSessionId ?? selected?.sessionId ?? (mdi ? mdi.document.ref.sessionId ?? snapshot?.sessionId : undefined)) as string })}
            viewedAgents={viewedAgents}
            {...((selected?.threadId ?? mdi?.document.ref.threadId ?? state.bootstrap?.selected?.threadId) === undefined ? {} : { selectedThreadId: (selected?.threadId ?? mdi?.document.ref.threadId ?? state.bootstrap?.selected?.threadId) as ThreadId })}
            waitForNewSession={waitForNewSession}
            ensureNewSession={ensureNewSession}
            {...(creatingSession ? { sessionCreating: true } : {})}
            {...(previewMode.preview ? { previewProjectId: chrome.previewProjectId, previewThreadId: chrome.previewThreadId, onPreviewDeckWait: setPreviewDeckWait } : {})}
            onSelectProject={chrome.onSelectProject}
            onSelectPreviewProject={chrome.onSelectPreviewProject}
            onSelectPreviewThread={chrome.onSelectPreviewThread}
            onSelectThread={openHistoryEntry}
            onBranchedSession={selectBranchedSession}
            hiddenPreviewThreads={chrome.hiddenPreviewThreads}
            sideOpen={mdi ? sideOpen : layout.sideShown}
            panelWidth={panelWidth}
            onResizePanel={setPanelWidth}
            bottomOpen={mdi ? bottomOpen : layout.bottomOpen}
            onBottomOpenChange={changeBottomOpen}
            bottomVisible={mdi ? bottomVisible : layout.bottomVisible}
            onBottomVisibleChange={changeBottomVisible}
            bottomHeight={bottomHeight}
            onResizeBottom={(height) => setBottomHeight(clampBottomHeight(height))}
            onRoute={go}
            onOpenChanges={() => { setSideTab("changes"); }}
            onOpenGit={() => { setSideTab("git"); }}
             composerRef={composerRef}
             {...(activeComposerDraft === undefined ? {} : { composerDraft: activeComposerDraft })}
             onComposerDraftChange={onComposerDraftChange}
             composerInsertion={composerInsertion}
             onComposerInsertionApplied={clearComposerInsertion}
            fileViewerActions={fileViewerActions}
            onDraftSkillsChange={onDraftSkillsChange}
            onUsedSkillsChange={onUsedSkillsChange}
            onSessionTitleMaybeChanged={() => refreshSessionTitles(selectedProject?.id as WorkspaceId | undefined)}
            onProvisionalSessionChange={onProvisionalSessionChange}
            onPinCompleted={refreshPinnedHistory}
            onSlashUi={applySlashUi}
            btwSession={btwSession}
            onBtwDemoNext={() => setBtwDemoRound((round) => (round + 1) % PREVIEW_BTW_SNAPSHOTS.length)}
            onBtwPreviewAsk={() => setBtwDemoRound(0)}
            compactPending={compactPending}
            onCompactThread={chrome.onCompactThread}
            onCompactPending={setCompactPending}
            onViewedTelemetryRefresh={refreshViewedTelemetry}
            telemetryRefreshToken={telemetryRefreshToken}
            {...(createProjectNonce === 0 ? {} : { createProjectNonce })}
            {...(dockSelection.project === null ? {} : { workspaceId: dockSelection.project })}
          />
          <span className="sr-only">client contract v{CLIENT_CONTRACT_VERSION}{snapshot ? ` · session ${snapshot.sessionId}` : ""}</span>
        </div>
      </div>
      </div>
      {renameOpen ? (
        <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => { if (!renameBusy) setRenameOpen(false); }}>
          <section className="modal create-project-modal rename-thread-modal" role="dialog" aria-modal="true" aria-labelledby="renameThreadTitle" onMouseDown={(event) => event.stopPropagation()}>
            <div className="create-project-head">
              <div>
                <span className="create-project-kicker">THREAD</span>
                <h2 id="renameThreadTitle">{t("conversation.renameThread")}</h2>
              </div>
              <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={renameBusy} onClick={() => setRenameOpen(false)}><Icon name="x" /></button>
            </div>
            <div className="create-project-body">
              <label className="create-project-name">
                <span className="sr-only">{t("conversation.renameThreadPlaceholder")}</span>
                <Icon name="pencil" />
                <input
                  autoFocus
                  value={renameValue}
                  placeholder={t("conversation.renameThreadPlaceholder")}
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    if (!renameBusy && renameValue.trim()) {
                      event.preventDefault();
                      submitRename();
                    }
                  }}
                />
              </label>
              <div className="create-project-label">{t("conversation.renameThreadNote")}</div>
              {renameError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{renameError}</div> : null}
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" disabled={renameBusy} onClick={() => setRenameOpen(false)}>{t("common.cancel")}</button>
              <button type="button" className="btn outline" disabled={renameBusy} onClick={() => submitRename(true)}>{t("conversation.renameGenerate")}</button>
              <button type="button" className="btn primary" disabled={!renameValue.trim() || renameBusy} onClick={() => submitRename()}>
                {renameBusy ? <><span className="spinner" aria-hidden="true" />{t("conversation.renaming")}</> : t("conversation.renameAction")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {archivePending ? (
        <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={closeArchiveConfirm}>
          <section
            className="modal create-project-modal create-branch-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archiveThreadTitle"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="create-project-head">
              <div>
                <span className="create-project-kicker">THREAD</span>
                <h2 id="archiveThreadTitle">{t("conversation.confirmArchive")}</h2>
                <p className="create-branch-sub">
                  {t("conversation.confirmArchiveDesc", { name: archivePending.kind === "preview" ? archivePending.title : (archivePending.entry.title ?? t("conversation.untitledSession")) })}
                </p>
                {archiveConfirmIsStreaming(archivePending, snapshot) ? (
                  <p className="create-branch-sub">{t("conversation.confirmArchiveStreaming")}</p>
                ) : null}
              </div>
              <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={archiveBusy} onClick={closeArchiveConfirm}><Icon name="x" /></button>
            </div>
            <div className="create-project-body">
              <p className="create-branch-hint">
                {archivePending.kind === "preview"
                  ? t("conversation.archivePreviewNote")
                  : t("conversation.archiveRealNote")}
              </p>
              {archiveError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{archiveError}</div> : null}
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" disabled={archiveBusy} onClick={closeArchiveConfirm}>{t("common.cancel")}</button>
              <button type="button" className="btn primary" autoFocus disabled={archiveBusy} onClick={confirmArchive}>
                {archiveBusy
                  ? <><span className="spinner" aria-hidden="true" />{archiveConfirmIsStreaming(archivePending, snapshot) ? t("conversation.stoppingAndArchiving") : t("history.archiveSession")}</>
                  : t("history.archiveSession")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {dialog ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="shellDialogTitle" onMouseDown={(event) => event.stopPropagation()}>
            {dialog === "about" ? (
              <>
                <div className="modal-head" id="shellDialogTitle">
                  <span className="about-head">
                    <AppIcon className="about-app-icon" size={22} />
                    {t("nav.about")}
                  </span>
                </div>
                <div className="modal-body">
                  <dl className="about-list">
                    <div className="about-row"><dt>{t("common.product")}</dt><dd>OMP Studio</dd></div>
                    <div className="about-row"><dt>{t("appUpdate.currentVersion")}</dt><dd>{(previewMode.preview ? PREVIEW_APP_UPDATE.currentVersion : localAppVersion ?? appUpdate.state.updateInfo?.currentVersion) || "—"}</dd></div>
                    <div className="about-row"><dt>Client contract</dt><dd>v{CLIENT_CONTRACT_VERSION}</dd></div>
                    <div className="about-row"><dt>Runtime</dt><dd>{runtime?.status ?? t("common.unavailable")}{runtime?.classification ? ` · ${runtime.classification}` : ""}</dd></div>
                    {runtime?.runtimeVersion ? <div className="about-row"><dt>{t("common.runtimeVersion")}</dt><dd>{runtime.runtimeVersion}</dd></div> : null}
                    {environment ? <div className="about-row"><dt>{t("common.platform")}</dt><dd>{environment.platform} · {environment.arch}</dd></div> : null}
                    {snapshot ? <div className="about-row"><dt>Session</dt><dd className="mono">{snapshot.sessionId}</dd></div> : null}
                  </dl>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head" id="shellDialogTitle">{t("nav.shortcuts")}</div>
                <div className="modal-body">
                  <dl className="about-list">
                    <div className="about-row"><dt>{t("nav.newChat")}</dt><dd><span className="kbd">{formatShortcut(SHORTCUTS.newChat)}</span></dd></div>
                    <div className="about-row"><dt>{t("menu.commandPalette")}</dt><dd><span className="kbd">{formatShortcut(SHORTCUTS.commandPalette)}</span></dd></div>
                    <div className="about-row"><dt>{t("menu.toggleSidebar")}</dt><dd><span className="kbd">{formatShortcut(SHORTCUTS.toggleSidebar)}</span></dd></div>
                    <div className="about-row"><dt>{t("menu.skillsAndPlugins")}</dt><dd><span className="kbd">{formatShortcut(SHORTCUTS.skills)}</span></dd></div>
                    <div className="about-row"><dt>{t("menu.bottomPanel")}</dt><dd><span className="kbd">{formatShortcut(SHORTCUTS.toggleBottomPanel)}</span></dd></div>
                    <div className="about-row"><dt>{t("menu.closeMenuOrPanel")}</dt><dd><span className="kbd">Esc</span></dd></div>
                  </dl>
                </div>
              </>
            )}
            <div className="modal-foot">
              <button type="button" className="btn primary" onClick={() => setDialog(null)}>{t("common.close")}</button>
            </div>
          </div>
        </div>
      ) : null}
      <ToastHost message={shellNotice?.text ?? null} icon={shellNotice?.icon ?? "info"} onDismiss={() => setShellNotice(null)} />
      <CommandPalette
        ref={paletteRef}
        open={paletteOpen}
        query={paletteQuery}
        groups={paletteGroups}
        onQueryChange={setPaletteQuery}
        onClose={closePalette}
        onRun={runPaletteAction}
      />
      {showAppUpdateDialog && effectiveUpdate ? (
        <AppUpdateDialog
          update={effectiveUpdate}
          preview={previewMode.preview}
          isDownloading={!previewMode.preview && appUpdate.state.downloading}
          isApplying={!previewMode.preview && appUpdate.state.applying}
          checkError={previewMode.preview ? null : appUpdate.state.checkError}
          downloadError={previewMode.preview ? null : appUpdate.state.downloadError}
          applyError={previewMode.preview ? null : appUpdate.state.applyError}
          applyNotice={previewMode.preview ? null : appUpdate.state.applyNotice}
          cancelError={previewMode.preview ? null : appUpdate.state.cancelError}
          receivedBytes={previewMode.preview ? undefined : appUpdate.state.receivedBytes}
          totalBytes={previewMode.preview ? undefined : appUpdate.state.totalBytes}
          readyToApply={!previewMode.preview && appUpdate.state.readyToApply === true}
          onApply={() => appUpdate.apply()}
          {...(!previewMode.preview ? { onCancel: () => appUpdate.cancel() } : {})}
          {...(!previewMode.preview ? { onSkip: async () => { await appUpdate.skip(); setShowAppUpdateDialog(false); } } : {})}
          onOpenComponents={() => { setShowAppUpdateDialog(false); setSettingsIntent("maintenance", "Office 文档预览"); onRoute("settings"); }}
          onClose={() => setShowAppUpdateDialog(false)}
          onDownloadAndInstall={() => appUpdate.downloadAndInstall()}
        />
      ) : null}
    </div>
    {!showPage && healthReady ? <WorkbenchHealth /> : null}
    </BackgroundProvider>
    </AnnotationsProvider>
  );
}

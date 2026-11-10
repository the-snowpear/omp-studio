import { dragConversation } from "../conversationWorkspace/drag";
import { useConversationView, useConversationDom } from "../conversationWorkspace/Context";
import { PanelInstances } from "../dock/PanelRegistration";
import { DockToolbar, useOptionalDock } from "../dock/DockContext";
import { DockCardRegion } from "../dock/DockRegions";
import { type PanelId } from "../dock/types";
import { useSessionTitles } from "../history/useSessionTitles";
import { SessionTitleMark } from "../history/SessionTitleMark";
import { previewSessionTitle } from "../preview/sessionTitlePreview";
import { setDiagnosticsIntent } from "../pageIntents";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { beforeConversationLayoutChange } from "../conversation/conversationReflow";
import { panelSize, SIDEBAR_LIMITS } from "../layout/workbenchLayout";
import type { FormEvent as ReactFormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { ClientBootstrap, SessionId, StudioClient, WorkspaceId, WorkspaceFileNode } from "@omp-studio/client-contract";
import { AppIcon, Icon } from "../icons";
import { MenuItem } from "../menus";
import { useI18n } from "../i18n";
import { SHORTCUTS, formatShortcut } from "../keyboard/shortcuts";
import { fileLabel } from "../composer/types";
import { formatRuntimeClassification, formatRuntimeStatusLabel, runtimeCanReconnect, runtimeCanRestart } from "../diagnosticsModel";
import { SkillsDrawer } from "../SkillsDrawer";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { EMPTY_EXPLORER_FILE_ACTIVITY } from "../conversation/explorerFileActivity";
import { usePreviewMode } from "../preview/PreviewContext";
import { SidebarFooter } from "../SidebarFooter";
import { transitionDelayMs, transitionMs } from "../motionClock";
import { useAppUpdate } from "../settings/appUpdate";
import { avatarInitial, useOperatorProfile } from "../settings/operatorProfile";
import { PREVIEW_APP_UPDATE, PREVIEW_PROJECTS, findPreviewProject } from "../preview/fixtures";
import { PreviewFileTree } from "../preview/surfaces";
import { usableCapabilityManifest } from "../deck/interactionGate";
import { ThreadSpin } from "./ThreadSpin";
import { ThreadWaitChip } from "./ThreadWaitChip";
import { residentRowsOf, threadRunningFromLive } from "./threadRunning";
import { sidebarProjectOrder } from "./projectOrder";
import { projectHasSession, provisionalThreadForHistoryEntry, sidebarThreadTitle } from "./provisionalThread";
import { waitKindFromLive } from "./threadWait";
import { useGitRepository } from "../git/useGitRepository";
import { buildGitStatusLookup } from "../git/treeStatus";
import { type Route, type ShellChrome, type ViewState } from "../workbench/types";
import { RealFileTree, type WorkspaceCreationKind } from "./WorkspaceTree";
import { snapshotFrom } from "../workbench/shellState";
import { AppMenu, ThreadActionMenuItems, ThreadRowMenu } from "../workbench/menus";
import { PROJECT_THREADS_INITIAL } from "../workbench/sessionSelection";

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

/** 左栏底部用户区（rail 收起时的回退位置）用的 Runtime 状态文案与语气。 */
function runtimeStatusLabel(runtime: ClientBootstrap["runtime"] | undefined, t: (k: string) => string): { text: string; tone: "ok" | "warn" | "err" } {
  const status = runtime?.status ?? "unavailable";
  if (status === "connected") return { text: t("runtime.ready"), tone: "ok" };
  if (status === "connecting") return { text: t("common.connecting"), tone: "warn" };
  if (status === "disconnected") return { text: t("diagnostics.statusDisconnected"), tone: "err" };
  return { text: formatRuntimeStatusLabel(status, t), tone: "err" };
}

export function AppSidebar({ state, chrome, client, onRoute, onOpenAppUpdateDialog, ompMenuAnchorRef, railCollapsed = false, avatarRef, footerBoxRef }: { state: ViewState; chrome: ShellChrome; client: StudioClient; onRoute: (route: Route) => void; onOpenAppUpdateDialog: () => void; ompMenuAnchorRef?: RefObject<HTMLButtonElement | null>; /** 左栏（rail）收起时，用户/环境入口回到侧栏底部。 */ railCollapsed?: boolean; /** 底栏里的头像圆本身：壳要量它，才能在收起/展开时把头像交接到位。 */ avatarRef?: RefObject<HTMLElement | null>; /** 底栏盒子本身：壳要用它的底边换算头像落点，这里用它盯实时高度。 */ footerBoxRef?: RefObject<HTMLElement | null> }) {
  const { document, window } = useConversationDom();
  const mdi = useConversationView();
  const { t } = useI18n();
  const { preview, marks } = usePreviewMode();
  const appUpdate = useAppUpdate();
  const effectiveUpdate = preview ? PREVIEW_APP_UPDATE : (appUpdate.state.updateInfo?.available ? appUpdate.state.updateInfo : null);
  const hasUpdate = effectiveUpdate?.available === true;
  const dock = useOptionalDock();
  const hasDockCards = !dock || dock.layout.left.panels.length > 0;
  const leftCardsExpanded = dock ? dock.layout.left.panels.some(id => !dock.layout.cards[id]!.collapsed) : chrome.explorerOpen;
  const sidebarRef = useRef<HTMLElement>(null);
  const skillsDrawerRef = useRef<HTMLElement>(null);
  const fallbackFooterRef = useRef<HTMLElement>(null);
  const footerRef = footerBoxRef ?? fallbackFooterRef;
  const pinDrawer = useCallback(() => {
    const sidebar = sidebarRef.current;
    const drawer = skillsDrawerRef.current;
    if (sidebar === null || drawer === null) return;
    const presented = !sidebar.closest("[hidden], [inert]") && sidebar.getClientRects().length > 0;
    if (drawer.dataset.presented !== String(presented)) drawer.dataset.presented = String(presented);
    if (!presented) return;
    const topBar = sidebar.querySelector(".sb-top");
    if (!(topBar instanceof HTMLElement)) return;
    const box = sidebar.getBoundingClientRect();
    const top = topBar.getBoundingClientRect();
    const foot = sidebar.querySelector(".sb-footer");
    const footHeight = foot instanceof HTMLElement ? foot.getBoundingClientRect().height : 0;
    const write = (name: string, value: string) => {
      if (drawer.style.getPropertyValue(name) !== value) drawer.style.setProperty(name, value);
    };
    write("--drawer-left", `${box.left}px`);
    write("--drawer-width", `${Math.max(0, box.width - 4)}px`);
    write("--drawer-top", `${Math.max(0, top.bottom)}px`);
    write("--drawer-bottom", `${Math.max(0, window.innerHeight - box.bottom + footHeight)}px`);
  }, []);
  /* 底栏在长高/收回的那 ~250ms 里，对话区与文件区在同一条 flex 里被挤压：分界线自己
     会平滑移动，但文件面板是 position:fixed 的 body，靠 slot 的 rect 定位，只跟
     ResizeObserver 会慢一帧。这里逐帧重测，顺便把技能抽屉的下边界钉在底栏实时高度上。 */
  const previousRailCollapsed = useRef(railCollapsed);
  const dockHosts = dock?.hosts;
  useEffect(() => {
    if (previousRailCollapsed.current === railCollapsed) return;
    previousRailCollapsed.current = railCollapsed;
    const footer = footerRef.current;
    const duration = footer === null ? 250 : transitionMs(footer) + transitionDelayMs(footer);
    if (duration <= 1) return;
    const end = performance.now() + duration + 120;
    let frame = requestAnimationFrame(function step() {
      dockHosts?.flush();
      pinDrawer();
      if (performance.now() < end) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [railCollapsed, dockHosts, pinDrawer, footerRef]);
  const fallbackOmpBtnRef = useRef<HTMLButtonElement>(null);
  const ompBtnRef = ompMenuAnchorRef ?? fallbackOmpBtnRef;
  const ompMenuRef = useRef<HTMLDivElement>(null);
  const [ompMenuPos, setOmpMenuPos] = useState<{ left: number; bottom?: number; top?: number }>({ left: 0, bottom: 0 });
  const [fileSearch, setFileSearch] = useState("");
  const [fileRefreshToken, setFileRefreshToken] = useState(0);
  const [previewFileMessage, setPreviewFileMessage] = useState<string | undefined>(undefined);
  const [newEntryKind, setNewEntryKind] = useState<WorkspaceCreationKind | null>(null);
  const [newEntryPanel, setNewEntryPanel] = useState<PanelId | null>(null);
  const [newEntryPath, setNewEntryPath] = useState("");
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState<string | undefined>(undefined);
  const [newEntryParentPath, setNewEntryParentPath] = useState<string | undefined>(undefined);
  const [newEntryBusy, setNewEntryBusy] = useState(false);
  const [newEntryError, setNewEntryError] = useState<string | undefined>(undefined);
  const newEntryInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSelectedDirectoryPath(undefined);
    setNewEntryParentPath(undefined);
    setNewEntryKind(null);
    setNewEntryPanel(null);
    setNewEntryPath("");
    setNewEntryError(undefined);
  }, [chrome.selectedProject?.id]);
  const beginWorkspaceEntry = (kind: WorkspaceCreationKind, panel: PanelId = "files") => {
    if (!chrome.selectedProject || newEntryBusy) return;
    setNewEntryKind(kind);
    setNewEntryPanel(panel);
    setNewEntryPath("");
    setNewEntryParentPath(selectedDirectoryPath);
    setFileSearch("");
    setNewEntryError(undefined);
  };
  const cancelWorkspaceEntry = () => {
    if (newEntryBusy) return;
    setNewEntryKind(null);
    setNewEntryPanel(null);
    setNewEntryPath("");
    setNewEntryParentPath(undefined);
    setNewEntryError(undefined);
  };
  const handleFileTreeSelection = useCallback((node: WorkspaceFileNode | undefined) => {
    setSelectedDirectoryPath(node?.type === "dir" ? node.path : undefined);
  }, []);
  const createWorkspaceEntry = async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chrome.selectedProject || newEntryKind === null || newEntryBusy) return;
    const name = newEntryPath.trim();
    if (!name) {
      setNewEntryError(t("shell.enterName"));
      newEntryInputRef.current?.focus();
      return;
    }
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setNewEntryError(t("shell.singleFileError"));
      newEntryInputRef.current?.focus();
      return;
    }
    const kind = newEntryKind;
    const commandName = kind === "file" ? "workspace.file.create" : "workspace.directory.create";
    const path = newEntryParentPath ? `${newEntryParentPath}/${name}` : name;
    setNewEntryBusy(true);
    setNewEntryError(undefined);
    if (preview) {
      if (marks) setPreviewFileMessage(`${t("common.demo")}: ${kind === "file" ? t("shell.newFile") : t("shell.newFolder")} ${path}`);
      setNewEntryBusy(false);
      setNewEntryKind(null);
      setNewEntryPanel(null);
      setNewEntryPath("");
      setNewEntryParentPath(undefined);
      return;
    }
    try {
      const handle = await client.command(commandName, { workspaceId: chrome.selectedProject.id as WorkspaceId, path });
      await waitReceipt(client, handle.requestId);
      setFileRefreshToken((value) => value + 1);
      setNewEntryKind(null);
      setNewEntryPanel(null);
      setNewEntryPath("");
      setNewEntryParentPath(undefined);
    } catch (error) {
      setNewEntryError(hostErrorMessage(error, `${t("common.create")} ${kind === "file" ? t("shell.newFile") : t("shell.newFolder")} ${t("common.failed")}`));
    } finally {
      setNewEntryBusy(false);
    }
  };
  const runtime = state.clientState?.connection.runtime ?? state.bootstrap?.runtime;
  // 项目树按显示名排序，与 projects.list 的「最近打开」顺序解耦：
  // 切项目会刷新 lastOpenedAt，直接用 Host 顺序会让行位置在点击后跳变。
  const sidebarProjects = useMemo(
    () => sidebarProjectOrder(state.model.workspaces),
    [state.model.workspaces],
  );
  const liveSnapshot = snapshotFrom(state);
  const titleEntries = chrome.projectHistories?.[chrome.selectedProject?.id ?? ""]?.model?.entries ?? [];
  const titleMetadata = useSessionTitles(client,{sessionId:liveSnapshot?.sessionId,available:runtime?.status === "connected",capabilities:usableCapabilityManifest(state.model.capabilities,state.clientState?.connection.capabilityManifest,state.bootstrap?.capabilityManifest)},titleEntries.flatMap(entry=>entry.sessionId?[{id:entry.sessionId,title:entry.title}]:[]),state.route === "workbench");
  // 会话行 ⋯ 菜单：同一时刻至多一个弹层；Escape / 点外部关闭。
  const [openRowMenuId, setOpenRowMenuId] = useState<string | null>(null);
  /** 非 null = 当前弹层由行右键打开，贴该光标点；null = 由 ⋯ 按钮打开。 */
  const [rowMenuPoint, setRowMenuPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (openRowMenuId === null) return;
    const close = () => setOpenRowMenuId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [openRowMenuId]);
  const runRowAction = (action?: () => void) => {
    setOpenRowMenuId(null);
    action?.();
  };
  /** 行右键：光标处打开同一弹层，并抑制原生上下文菜单。 */
  const openRowMenuAtCursor = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    setRowMenuPoint({ x: event.clientX, y: event.clientY });
    setOpenRowMenuId(id);
  };
  /** 行级会话动作可用性：与顶栏同一语义——写表面只看真实 Runtime 快照。
      行菜单的目标是所在行会话：非当前会话由 runThreadRowAction 先打开（resume）再执行。 */
  const sessionLive = liveSnapshot !== undefined;
  const sessionBusy = liveSnapshot?.isStreaming === true || liveSnapshot?.isCompacting === true;
  const rowActionReason = !sessionLive ? t("common.unavailable") : t("common.loading");
  const pendingInteraction = state.clientState?.interaction.pending ?? null;
  const residentModel = state.clientState?.entities.residents;
  const residentRows = residentRowsOf(residentModel);
  const hasResidentModel = residentModel !== undefined && residentModel !== null;
  const threadWaitForSession = (sessionId: SessionId | undefined) => waitKindFromLive({
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(hasResidentModel
      ? { residents: residentRows }
      : {
        pending: pendingInteraction,
        ...(liveSnapshot?.sessionId === undefined ? {} : { snapshotSessionId: liveSnapshot.sessionId }),
        ...(liveSnapshot?.plan?.status === undefined ? {} : { planStatus: liveSnapshot.plan.status }),
      }),
  });
  // Explorer git 徽章：真实模式读取选中项目的仓库状态；预览模式的徽章来自 fixtures，不查 Host。
  const gitWorkspaceId = preview || !chrome.selectedProject ? undefined : (chrome.selectedProject.id as WorkspaceId);
  const { repository: gitRepository, refresh: refreshGitRepository } = useGitRepository(client, gitWorkspaceId);
  const gitStatusLookup = useMemo(() => buildGitStatusLookup(gitRepository?.changes ?? []), [gitRepository]);
  // Conversation-owned tool activity is published by the target-scoped store.
  // Until the workbench target is mounted, the explorer has no live activity.
  const fileActivity = EMPTY_EXPLORER_FILE_ACTIVITY;
  const gitTokenFirstRun = useRef(false);
  useEffect(() => {
    if (!gitTokenFirstRun.current) { gitTokenFirstRun.current = true; return; }
    if (gitWorkspaceId === undefined) return;
    void refreshGitRepository();
  }, [fileRefreshToken, gitWorkspaceId, refreshGitRepository]);
  useEffect(() => {
    if (gitWorkspaceId === undefined) return;
    // 外部（终端/OMP Runtime）改文件不会推事件；窗口重新聚焦时兜底刷新，至少间隔 5s。
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      void refreshGitRepository();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [gitWorkspaceId, refreshGitRepository]);
  const ompConnected = runtime?.status === "connected";
  const ompVersion = runtime?.runtimeVersion ?? (preview ? "v0.82.1" : "—");
  const ompMeta = preview ? (marks ? `${t("runtime.ready")} · ${t("common.demo")}` : t("runtime.ready")) : (runtime ? formatRuntimeClassification(runtime.classification, (k) => t(k)) : t("common.unavailable"));
  const ompStatus = runtimeStatusLabel(runtime, t);
  const { profile } = useOperatorProfile();
  useLayoutEffect(() => {
    if (!chrome.ompMenuOpen || !ompBtnRef.current) return;
    const place = () => {
      const rect = ompBtnRef.current?.getBoundingClientRect();
      const menu = ompMenuRef.current;
      if (!rect) return;
      const pad = 8;
      const next: { left: number; bottom?: number; top?: number } = {
        left: rect.left,
        bottom: window.innerHeight - rect.top + 6,
      };
      if (menu) {
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        if (next.left + width > window.innerWidth - pad) {
          next.left = Math.max(pad, window.innerWidth - width - pad);
        }
        if (next.left < pad) next.left = pad;
        const top = window.innerHeight - (next.bottom ?? 0) - height;
        if (top < pad) {
          next.top = pad;
          delete next.bottom;
        }
      }
      setOmpMenuPos(next);
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [chrome.ompMenuOpen]);
  useEffect(() => {
    if (!chrome.ompMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ompBtnRef.current?.contains(target) || ompMenuRef.current?.contains(target)) return;
      chrome.onToggleOmpMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") chrome.onToggleOmpMenu();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [chrome.ompMenuOpen, chrome.onToggleOmpMenu]);
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    pinDrawer();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(pinDrawer);
    observer?.observe(sidebar);
    /* 底栏的高度是动画出来的：盯住它，抽屉下边界才能逐帧跟着收放。 */
    if (footerRef.current !== null) observer?.observe(footerRef.current);
    window.addEventListener("resize", pinDrawer);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", pinDrawer);
    };
  }, [pinDrawer, chrome.skillsOpen, chrome.collapsed, chrome.sidebarWidth, railCollapsed, state.route, footerRef]);
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dock?.preferences.locked) return;
    if (chrome.collapsed) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const sidebar = handle.closest(".sidebar");
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect().width : chrome.sidebarWidth;
    const root = handle.closest<HTMLElement>(".conversation-workspace, .adaptive-workbench") ?? document.documentElement;
    const maxWidth = root.dataset.layoutOverlay === "sidebar" ? Math.min(400, root.clientWidth - 24) : Math.min(400, Math.max(200, root.clientWidth - 560));
    beforeConversationLayoutChange();
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    let latest = startWidth;
    const apply = (width: number) => {
      latest = width;
      root.style.setProperty("--sidebar-w", `${width}px`);
      handle.setAttribute("aria-valuenow", String(Math.round(width)));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(Math.min(maxWidth, Math.max(Math.min(200, maxWidth), startWidth + next.clientX - startX)));
    };
    const up = () => {
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      chrome.onResizeSidebar(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = event.currentTarget.closest(".sidebar")?.getBoundingClientRect().width ?? chrome.sidebarWidth;
    const step = event.shiftKey ? 32 : 16;
    const value = event.key === "ArrowRight" ? current + step : event.key === "ArrowLeft" ? current - step : event.key === "Home" ? 200 : event.key === "End" ? 400 : undefined;
    if (value === undefined) return;
    event.preventDefault();
    beforeConversationLayoutChange();
    chrome.onResizeSidebar(panelSize(value, SIDEBAR_LIMITS));
  };
  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dock?.preferences.locked) return;
    if (!hasDockCards || !leftCardsExpanded) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const sidebar = handle.closest(".sidebar");
    if (!(sidebar instanceof HTMLElement)) return;
    const projects = sidebar.querySelector("#sbProjects");
    const files = sidebar.querySelector(".dock-left-cards");
    if (!(projects instanceof HTMLElement) || !(files instanceof HTMLElement)) return;
    const top = projects.getBoundingClientRect().top;
    const span = files.getBoundingClientRect().bottom - top;
    if (span <= 0) return;
    handle.classList.add("dragging");
    sidebar.classList.add("sb-splitting");
    handle.setPointerCapture(event.pointerId);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    let latest = chrome.splitRatio;
    const apply = (ratio: number) => {
      latest = ratio;
      projects.style.flex = `1 1 ${(ratio * 100).toFixed(3)}%`;
      files.style.flex = `1 1 ${((1 - ratio) * 100).toFixed(3)}%`;
      handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(Math.min(0.85, Math.max(0.15, (next.clientY - top) / span)));
    };
    const up = () => {
      handle.classList.remove("dragging");
      sidebar.classList.remove("sb-splitting");
      document.body.classList.remove("is-resizing");
      projects.style.flex = "";
      files.style.flex = "";
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      chrome.onResizeSplit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const projectShare = chrome.splitRatio * 100;
  const fileShare = 100 - projectShare;
  return (
    <aside ref={sidebarRef} className={`sidebar${chrome.collapsed ? " collapsed" : ""}${leftCardsExpanded ? "" : " explorer-collapsed"}`} id="sidebar" inert={chrome.collapsed} aria-label={t("shell.projectAndChat")}>
      <div className="sidebar-resizer" id="sbResizer" role="separator" aria-orientation="vertical" aria-label={t("shell.adjustPanelWidth")} aria-valuemin={200} aria-valuemax={400} aria-valuenow={chrome.sidebarWidth} tabIndex={0} onPointerDown={onResizePointerDown} onKeyDown={onResizeKeyDown} onDoubleClick={() => chrome.onResizeSidebar(272)} />
      <div className="sb-top">
        <AppMenu
          chrome={chrome}
          onRoute={onRoute}
        />
        <button className="sb-brand" data-tip={t("nav.home")} onClick={() => onRoute("home")}>
          <AppIcon className="logo" size={22} />
          <span className="name">OMP Studio</span>
        </button>
        <button
          className="icon-btn"
          data-tip={t("nav.search")}
          data-cmdk-anchor=""
          aria-label={t("nav.search")}
          aria-haspopup="dialog"
          aria-expanded={chrome.paletteOpen}
          {...(chrome.paletteOpen ? { "aria-controls": "cmdkList" } : {})}
          onClick={chrome.onOpenPalette}
        >
          <Icon name="search" />
        </button>
      </div>
      <div className="sb-actions">
        <button className="action-row new-convo-btn" aria-label={t("nav.newChat")} onClick={() => chrome.onStartNewChat()}>
          <Icon name="plus" />
          <span className="lbl">{t("nav.newChat")}</span>
          <span className="meta"><span className="hint">{formatShortcut(SHORTCUTS.newChat)}</span></span>
        </button>
        <button className="action-row skills-btn" aria-label={t("skills.sidebarAction")} aria-expanded={chrome.skillsOpen} aria-controls="skillsDrawer" onClick={chrome.onToggleSkills}>
          <Icon name="layers" />
          <span className="lbl">{t("skills.sidebarAction")}</span>
          <span className="meta"><span className="count">{chrome.skillsEnabledCount}</span><Icon name="chevron-r" extra="sm chev" /></span>
        </button>
      </div>
      <section className="sb-section" id="sbProjects" aria-labelledby="sbProjectsTitle" style={{ ["--sb-proj-basis" as string]: hasDockCards && leftCardsExpanded ? `${projectShare.toFixed(3)}%` : "100%" }}>
        <div className="sb-section-head">
          <h2 id="sbProjectsTitle">{t("shell.projectAndChat")}</h2>
          <div className="sb-head-actions">
            <button
              type="button"
              className="icon-btn"
              data-tip={t("nav.createProject")}
              aria-label={t("nav.createProject")}
              onClick={chrome.onCreateProject}
            >
              <Icon name="plus" extra="sm" />
            </button>
          </div>
        </div>
        <div className="sb-scroll" id="projectList">
          {preview ? PREVIEW_PROJECTS.map((project) => {
            const open = chrome.previewProjectId === project.id && chrome.projectListExpanded;
            return (
              <div className="project" key={project.id}>
                <div className="project-head-row">
                  <button
                    className="project-head"
                    type="button"
                    aria-expanded={open}
                    aria-current={chrome.previewProjectId === project.id ? "page" : undefined}
                    onClick={() => {
                      if (chrome.previewProjectId !== project.id) chrome.onSelectProject({ id: project.id, name: project.name });
                      else chrome.onToggleProject({ id: project.id, name: project.name });
                    }}
                  >
                    {/* 左侧图标位：默认文件夹（展开 folder-open / 收起 folder），
                        悬停整行时换为折叠箭头（chevron-d / chevron-r） */}
                    <span className="tw">
                      <span className="tw-folder"><Icon name={open ? "folder-open" : "folder"} extra="sm" /></span>
                      <span className="tw-chev"><Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" /></span>
                    </span>
                    <span className="p-name">{project.name}</span>
                    <span className="project-flags">
                      {project.running ? <span className="dot green pulse" aria-hidden="true" /> : null}
                      {project.dirty > 0 ? <span className="muted tiny">{project.dirty}</span> : null}
                    </span>
                  </button>
                  {/* 悬停浮现的操作区：最右 + 在此项目下新建会话，其左 ⋯ 更多（功能未接入） */}
                  <span className="p-actions">
                    <button type="button" className="icon-btn" data-tip={t("common.moreNotImplemented")} aria-label={t("common.moreActions")} disabled><Icon name="more" extra="sm" /></button>
                    <button type="button" className="icon-btn" data-tip={t("shell.newChatInProject")} aria-label={t("shell.newChatInProject")} onClick={() => chrome.onStartChatInProject({ id: project.id, name: project.name })}><Icon name="plus" extra="sm" /></button>
                  </span>
                </div>
                {open ? (() => {
                  const limit = chrome.projectThreadLimits[project.id] ?? PROJECT_THREADS_INITIAL;
                  const threads = project.threads.filter((thread) => !chrome.hiddenPreviewThreads.has(thread.id));
                  const visible = threads.slice(0, limit);
                  return (<>
                    {visible.map((thread) => {
                      const wait = thread.id === "t3" ? chrome.previewDeckWait : thread.wait;
                      const running = thread.status === "running";
                      return (
                      <div
                        className={`thread-row${wait ? " has-wait" : ""}`}
                        key={thread.id}
                        onContextMenu={(event) => openRowMenuAtCursor(event, thread.id)}
                      >
                        <button
                          type="button"
                          className={`thread${chrome.previewThreadId === thread.id ? " active" : ""}`}
                          aria-current={chrome.previewThreadId === thread.id ? "page" : undefined}
                          data-window-drag={mdi ? "" : undefined}
                          onPointerDown={event => { if (mdi) dragConversation(event, mdi.store, { ref: { targetId: mdi.document.ref.targetId, workspaceId: project.id, previewProjectId: project.id, previewThreadId: thread.id }, title: thread.title }); }}
                          onClick={() => chrome.onSelectPreviewThread(thread.id)}
                        >
                          <ThreadSpin running={running} />
                          <span className="t-title"><SessionTitleMark row={previewSessionTitle(thread.id,thread.title)} title={thread.title}/><span className="t-scroll">{thread.title}</span></span>
                          {wait || running ? null : <span className="t-meta">{thread.time}</span>}
                          {wait ? <ThreadWaitChip kind={wait} /> : null}
                        </button>
                        {/* 悬停操作区：最右「归档」（演示：本地隐藏），其左 ⋯ 菜单（顶栏同款；
                            演示行无真实会话，会话动作禁用，写表面不伪造目标）。 */}
                        <span className="t-actions">
                          <ThreadRowMenu
                            id={thread.id}
                            openId={openRowMenuId}
                            onToggle={setOpenRowMenuId}
                            contextPoint={openRowMenuId === thread.id ? rowMenuPoint : null}
                            menu={
                              <>
                                <ThreadActionMenuItems
                                  live={false}
                                  busy={false}
                                  compacting={false}
                                  compactPending={false}
                                  reason={marks ? t("common.unavailableInPreview") : t("common.unavailable")}
                                  onRename={() => {}}
                                  onFork={() => {}}
                                  onHandoff={() => {}}
                                  onCompact={() => {}}
                                  onExport={() => {}}
                                  onHistory={() => runRowAction(() => onRoute("history"))}
                                />
                                <div className="menu-sep" />
                                <MenuItem icon="archive" onClick={() => runRowAction(() => chrome.onArchivePreviewThread(thread.id))}>{t("history.archiveSession")}</MenuItem>
                              </>
                            }
                          />
                          <button type="button" className="icon-btn" data-tip={t("history.archiveSession")} aria-label={t("history.archiveSession")} onClick={() => chrome.onArchivePreviewThread(thread.id)}><Icon name="archive" extra="sm" /></button>
                        </span>
                      </div>
                      );
                    })}
                    {visible.length < threads.length ? (
                      <button type="button" className="load-more" onClick={() => chrome.onLoadMoreThreads(project.id)}>
                        <Icon name="chevron-d" extra="sm" />
                        <span>{t("common.expand")}</span>
                        <span className="lm-count">{`+${threads.length - visible.length}`}</span>
                      </button>
                    ) : null}
                    {!threads.length ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{t("home.noRecentSessions")}</p></div> : null}
                  </>);
                })() : null}
              </div>
            );
          }) : sidebarProjects.length ? (
            sidebarProjects.map((workspace) => {
              const open = chrome.expandedProjects?.has(workspace.workspaceId)
                ?? (chrome.selectedProject?.id === workspace.workspaceId && chrome.projectListExpanded);
              const workspaceResidents = residentRows?.filter((resident) => resident.workspaceId === workspace.workspaceId) ?? [];
              const runningCount = workspaceResidents.filter((resident) => resident.phase === "running" || resident.phase === "compacting").length;
              const waitingCount = workspaceResidents.filter((resident) => resident.phase === "waiting").length;
              return (
                <div className="project" key={workspace.workspaceId}>
                  <div className="project-head-row">
                    <button
                      className="project-head"
                      type="button"
                      aria-expanded={open}
                      aria-current={chrome.selectedProject?.id === workspace.workspaceId ? "page" : undefined}
                      onClick={() => {
                        if (chrome.selectedProject?.id !== workspace.workspaceId) chrome.onSelectProject({ id: workspace.workspaceId, name: workspace.name });
                        else chrome.onToggleProject({ id: workspace.workspaceId, name: workspace.name });
                      }}
                    >
                      {/* 左侧图标位：默认文件夹（展开 folder-open / 收起 folder），
                          悬停整行时换为折叠箭头（chevron-d / chevron-r） */}
                      <span className="tw">
                        <span className="tw-folder"><Icon name={open ? "folder-open" : "folder"} extra="sm" /></span>
                        <span className="tw-chev"><Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" /></span>
                      </span>
                      <span className="p-name ellipsis">{workspace.name}</span>
                      <span className="project-flags">
                        {runningCount > 0 ? <span className="chip green xs" aria-label={`运行 ${runningCount}`}>{runningCount}</span> : null}
                        {waitingCount > 0 ? <span className="chip amber xs" aria-label={`等待 ${waitingCount}`}>{waitingCount}</span> : null}
                      </span>
                    </button>
                    {/* 悬停浮现的操作区：最右 + 在此项目下新建会话，其左 ⋯ 更多（功能未接入） */}
                    <span className="p-actions">
                      <button type="button" className="icon-btn" data-tip={t("common.moreNotImplemented")} aria-label={t("common.moreActions")} disabled><Icon name="more" extra="sm" /></button>
                      <button type="button" className="icon-btn" data-tip={t("shell.newChatInProject")} aria-label={t("shell.newChatInProject")} onClick={() => chrome.onStartChatInProject({ id: workspace.workspaceId, name: workspace.name })}><Icon name="plus" extra="sm" /></button>
                    </span>
                  </div>
                  {open ? (() => {
                    const limit = chrome.projectThreadLimits[workspace.workspaceId] ?? PROJECT_THREADS_INITIAL;
                    const historyState = chrome.projectHistories?.[workspace.workspaceId];
                    const entries = (historyState?.model?.entries ?? []).slice(0, limit);
                    const total = historyState?.model?.total ?? 0;
                    const projectProvisionalThreads = chrome.provisionalThreads.filter(
                      (thread) => thread.workspaceId === workspace.workspaceId,
                    );
                    const transientThreads = projectProvisionalThreads.filter(
                      (thread) => !projectHasSession(entries, thread.sessionId),
                    );
                    return (<>
                      {transientThreads.map((thread) => (
                        <div
                          className={`thread-row${thread.running ? " running" : ""}`}
                          key={`provisional:${thread.sessionId}`}
                          // 草稿行（未发送）没有菜单，保留原生右键。
                          {...(thread.submitted ? { onContextMenu: (event: ReactMouseEvent) => openRowMenuAtCursor(event, `provisional:${String(thread.sessionId)}`) } : {})}
                        >
                          <button
                            type="button"
                            className={`thread${chrome.activeProvisionalSessionId === thread.sessionId ? " active" : ""}`}
                            {...(chrome.activeProvisionalSessionId === thread.sessionId ? { "aria-current": "page" as const } : {})}
                            aria-label={thread.title}
                            data-window-drag={mdi ? "" : undefined}
                            onPointerDown={event => { if (mdi) dragConversation(event, mdi.store, { ref: { targetId: mdi.document.ref.targetId, workspaceId: thread.workspaceId, ...(thread.submitted ? { sessionId: thread.sessionId } : { draftId: thread.sessionId }) }, title: thread.title }); }}
                            onClick={() => chrome.onSelectProvisionalThread(thread)}
                          >
                            <ThreadSpin running={thread.running} />
                            <span className="t-title"><span className="t-scroll">{thread.title}</span></span>
                          </button>
                          {thread.submitted ? (
                            <span className="t-actions">
                              {/* 临时行尚未进历史目录；仅当它就是当前活动会话时动作与顶栏同源
                                  （作用于当前 live 会话），否则诚实禁用。 */}
                              <ThreadRowMenu
                                id={`provisional:${String(thread.sessionId)}`}
                                openId={openRowMenuId}
                                onToggle={setOpenRowMenuId}
                                contextPoint={openRowMenuId === `provisional:${String(thread.sessionId)}` ? rowMenuPoint : null}
                                menu={
                                  <>
                                    <ThreadActionMenuItems
                                      live={sessionLive && chrome.activeProvisionalSessionId === thread.sessionId}
                                      busy={sessionBusy}
                                      compacting={liveSnapshot?.isCompacting === true}
                                      compactPending={chrome.compactPending}
                                      reason={t("common.unavailable")}
                                      onRename={() => runRowAction(chrome.onRenameThread)}
                                      onFork={() => runRowAction(chrome.onForkThread)}
                                      onHandoff={() => runRowAction(chrome.onHandoffThread)}
                                      onCompact={() => runRowAction(chrome.onCompactThread)}
                                      onExport={() => runRowAction(chrome.onExportThread)}
                                      onHistory={() => runRowAction(() => onRoute("history"))}
                                    />
                                    <div className="menu-sep" />
                                    <MenuItem icon="archive" onClick={() => runRowAction(() => chrome.onArchiveProvisionalThread(thread))}>{t("history.archiveSession")}</MenuItem>
                                  </>
                                }
                              />
                              <button
                                type="button"
                                className="icon-btn"
                                data-tip={t("history.archiveSession")}
                                aria-label={t("history.archiveSession")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  chrome.onArchiveProvisionalThread(thread);
                                }}
                              ><Icon name="archive" extra="sm" /></button>
                            </span>
                          ) : null}
                        </div>
                      ))}
                      {entries.map((entry) => {
                        const provisional = provisionalThreadForHistoryEntry(chrome.provisionalThreads, entry);
                        const wait = threadWaitForSession(entry.sessionId);
                        const running = threadRunningFromLive({
                          ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
                          ...(hasResidentModel
                            ? { residents: residentRows }
                            : {
                              ...(liveSnapshot?.sessionId === undefined ? {} : { snapshotSessionId: liveSnapshot.sessionId }),
                              ...(liveSnapshot?.isStreaming === undefined ? {} : { streaming: liveSnapshot.isStreaming }),
                              ...(liveSnapshot?.isCompacting === undefined ? {} : { compacting: liveSnapshot.isCompacting }),
                            }),
                        });
                        return (
                        <div
                          className={`thread-row${wait ? " has-wait" : ""}`}
                          key={entry.historyId}
                          onContextMenu={(event) => openRowMenuAtCursor(event, entry.historyId)}
                        >
                          <button
                            type="button"
                            className={`thread${chrome.selectedHistoryId === entry.historyId || chrome.activeProvisionalSessionId === entry.sessionId ? " active" : ""}`}
                            aria-current={chrome.selectedHistoryId === entry.historyId ? "page" : undefined}
                            data-window-drag={mdi ? "" : undefined}
                            onPointerDown={event => { if (mdi) dragConversation(event, mdi.store, { ref: { targetId: mdi.document.ref.targetId, workspaceId: workspace.workspaceId, sessionId: entry.sessionId, threadId: entry.threadId, historyId: entry.historyId }, title: sidebarThreadTitle(entry, provisional, t("conversation.untitledSession")) }); }}
                            onClick={() => chrome.onSelectThread(entry, workspace.workspaceId as WorkspaceId)}
                          >
                            <ThreadSpin running={running} />
                            <span className="t-title">
                              {entry.pinned === true ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
                              <SessionTitleMark row={titleMetadata.rows.get(entry.sessionId ?? "")} title={sidebarThreadTitle(entry, provisional, t("conversation.untitledSession"))}/><span className="t-scroll">{sidebarThreadTitle(entry, provisional, t("conversation.untitledSession"))}</span>
                            </span>
                            {wait || running ? null : <span className="t-meta">{relativeTime(entry.lastActiveAt)}</span>}
                          {wait ? <ThreadWaitChip kind={wait} /> : null}
                          </button>
                          {/* 悬停操作区：最右「归档」（session.archive），其左 ⋯ 菜单（顶栏同款；
                              会话动作作用于所在行，非当前会话先打开 resume 再执行）。 */}
                          <span className="t-actions">
                            <ThreadRowMenu
                              id={entry.historyId}
                              openId={openRowMenuId}
                              onToggle={setOpenRowMenuId}
                              contextPoint={openRowMenuId === entry.historyId ? rowMenuPoint : null}
                              menu={
                                <>
                                  <ThreadActionMenuItems
                                    live={sessionLive}
                                    busy={running}
                                    compacting={liveSnapshot?.sessionId === entry.sessionId && liveSnapshot?.isCompacting === true}
                                    compactPending={chrome.compactPending}
                                    reason={rowActionReason}
                                    pinned={entry.pinned}
                                    onPin={() => runRowAction(() => chrome.onThreadRowAction(entry, workspace.workspaceId as WorkspaceId, "pin"))}
                                    onRename={() => runRowAction(() => chrome.onThreadRowAction(entry, workspace.workspaceId as WorkspaceId, "rename"))}
                                    onFork={() => runRowAction(() => chrome.onThreadRowAction(entry, workspace.workspaceId as WorkspaceId, "fork"))}
                                    onHandoff={() => runRowAction(() => chrome.onThreadRowAction(entry, workspace.workspaceId as WorkspaceId, "handoff"))}
                                    onCompact={() => runRowAction(() => chrome.onThreadRowAction(entry, workspace.workspaceId as WorkspaceId, "compact"))}
                                    onExport={() => runRowAction(() => chrome.onThreadRowAction(entry, workspace.workspaceId as WorkspaceId, "export"))}
                                    onHistory={() => runRowAction(() => onRoute("history"))}
                                  />
                                  <div className="menu-sep" />
                                  <MenuItem icon="archive" onClick={() => runRowAction(() => chrome.onArchiveThread(entry, workspace.workspaceId))}>{t("history.archiveSession")}</MenuItem>
                                </>
                              }
                            />
                            <button
                              type="button"
                              className="icon-btn"
                              data-tip={t("history.archiveSession")}
                              aria-label={t("history.archiveSession")}
                              onClick={() => chrome.onArchiveThread(entry, workspace.workspaceId)}
                            ><Icon name="archive" extra="sm" /></button>
                          </span>
                        </div>
                        );
                      })}
                      {entries.length < total ? (
                        <button type="button" className="load-more" onClick={() => chrome.onLoadMoreThreads(workspace.workspaceId)}>
                          <Icon name="chevron-d" extra="sm" />
                          <span>{t("common.expand")}</span>
                          <span className="lm-count">{`+${total - entries.length}`}</span>
                        </button>
                      ) : null}
                      {(historyState === undefined || historyState.status === "loading") && !total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{t("common.loading")}</p></div> : null}
                      {historyState?.status === "error" && !total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{historyState.error ?? t("history.catalogUnavailable")}</p></div> : null}
                      {historyState !== undefined && historyState.status === "ready" && !total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{t("home.noRecentSessions")}</p></div> : null}
                    </>);
                  })() : null}
                </div>
              );
            })
          ) : chrome.projectsLoading ? (
            <div className="project">
              <div className="empty" style={{ padding: "16px 8px" }}>
                <p className="muted small">{t("common.loading")}</p>
              </div>
            </div>
          ) : (
            <div className="project">
              <div className="empty" style={{ padding: "16px 8px" }}>
                <p className="muted small">{t("home.noRecentProjects")}</p>
                <button className="btn small outline" type="button" onClick={chrome.onPickProject}>
                  <Icon name="folder-open" extra="sm" />{t("home.openLocalFolder")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      <div
        className="sb-divider"
        hidden={!hasDockCards || !leftCardsExpanded}
        id="sbDivider"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={t("shell.adjustBottomPanelHeight")}
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(projectShare)}
        onPointerDown={onSplitPointerDown}
        onDoubleClick={() => chrome.onResizeSplit(0.5)}
        onKeyDown={(event) => {
          if (!hasDockCards || !leftCardsExpanded) return;
          const step = event.shiftKey ? 0.15 : 0.05;
          if (event.key === "ArrowUp") { event.preventDefault(); chrome.onResizeSplit(Math.max(0.15, chrome.splitRatio - step)); }
          else if (event.key === "ArrowDown") { event.preventDefault(); chrome.onResizeSplit(Math.min(0.85, chrome.splitRatio + step)); }
          else if (event.key === "Home") { event.preventDefault(); chrome.onResizeSplit(0.15); }
          else if (event.key === "End") { event.preventDefault(); chrome.onResizeSplit(0.85); }
        }}
      />
      {dock && hasDockCards ? <div className={`dock-left-cards${leftCardsExpanded ? "" : " is-folded"}`} style={{ flex: leftCardsExpanded ? `1 1 ${fileShare}%` : "0 0 auto", minHeight: 0, overflow: "hidden" }}><DockCardRegion region="left" visible={!chrome.collapsed} /></div> : null}
      <PanelInstances base="files">{id => {
        const suffix = id === "files" ? "" : `-${id.slice(id.indexOf("@") + 1)}`;
        return <section className="dock-files-content" id={`sbFiles${suffix}`} aria-labelledby={`sbFilesTitle${suffix}`} >
        <div className="sb-section-head">
          <h2 id={`sbFilesTitle${suffix}`} className="dock-files-title">{t("shell.workspace")}</h2>
          <DockToolbar id={id}><div className="sb-head-actions">
            <button className={`icon-btn${newEntryPanel === id && newEntryKind === "file" ? " active" : ""}`} data-tip={t("shell.newFile")} aria-label={t("shell.newFile")} aria-pressed={newEntryPanel === id && newEntryKind === "file"} disabled={!chrome.selectedProject || newEntryBusy} onClick={() => beginWorkspaceEntry("file", id)}><Icon name="plus" extra="sm" /></button>
            <button className={`icon-btn${newEntryPanel === id && newEntryKind === "directory" ? " active" : ""}`} data-tip={t("shell.newFolder")} aria-label={t("shell.newFolder")} aria-pressed={newEntryPanel === id && newEntryKind === "directory"} disabled={!chrome.selectedProject || newEntryBusy} onClick={() => beginWorkspaceEntry("directory", id)}><Icon name="folder" extra="sm" /></button>
            <button className={`icon-btn${fileSearch ? " active" : ""}`} data-tip={t("common.filter")} aria-label={t("shell.filterLoadedFiles")} onClick={() => setFileSearch((value) => value ? "" : " ")}><Icon name="search" extra="sm" /></button>
            <button className="icon-btn" data-tip={t("common.refresh")} aria-label={t("shell.refreshFileTree")} disabled={!chrome.selectedProject} onClick={() => {
              if (!preview) { setFileRefreshToken((value) => value + 1); return; }
              if (marks) setPreviewFileMessage(`${t("common.demo")}: ${t("shell.refreshFileTree")}`);
            }}><Icon name="refresh" extra="sm" /></button>
          </div></DockToolbar>

        </div>
        {fileSearch ? <div style={{ padding: "4px 10px" }}><input autoFocus={id === "files"} className="input" value={fileSearch.trim()} onChange={(event) => setFileSearch(event.target.value || " ")} placeholder={`${t("shell.filterLoadedFiles")}…`} aria-label={t("shell.filterLoadedFiles")} /></div> : null}
        {preview && previewFileMessage ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{previewFileMessage}</div> : null}
        <div className="sb-scroll">
          {preview ? (
            <PreviewFileTree
              workspaceId={chrome.previewProjectId ?? "preview-workspace"}
              label={findPreviewProject(chrome.previewProjectId)?.name ?? t("shell.project")}
              search={fileSearch.trim()}
              onContext={(path, kind) => chrome.onAddComposerContext({ kind, path, label: fileLabel(path) })}
              onFileAction={(action, target) => {
                if (action.type !== "copyRelative") return;
                void navigator.clipboard
                  .writeText(target.path)
                  .then(() => setPreviewFileMessage("已复制相对路径"))
                  .catch(() => setPreviewFileMessage("复制相对路径失败"));
              }}
            />
          ) : chrome.selectedProject ? (
            <RealFileTree
              key={chrome.selectedProject.id}
              client={client}
              workspaceId={chrome.selectedProject.id as WorkspaceId}
              label={chrome.selectedProject.name}
              refreshToken={fileRefreshToken}
              search={fileSearch.trim()}
              gitStatus={gitStatusLookup}
              fileActivity={fileActivity}
              createKind={newEntryPanel === id ? newEntryKind : null}
              createParentPath={newEntryParentPath}
              createName={newEntryPath}
              createBusy={newEntryBusy}
              createError={newEntryError}
              createInputRef={newEntryInputRef}
              onCreateNameChange={(value) => { setNewEntryPath(value); setNewEntryError(undefined); }}
              onCreateSubmit={(event) => void createWorkspaceEntry(event)}
              onCreateCancel={cancelWorkspaceEntry}
              onSelectionChange={handleFileTreeSelection}
              onAddContext={(path, kind) => chrome.onAddComposerContext({ kind, path, label: fileLabel(path) })}
              fileOpeners={chrome.fileOpeners}
              fileShellUnavailable={chrome.fileShellUnavailable}
              onFileAction={(action, target) => {
                const projectWorkspaceId = chrome.selectedProject?.id;
                if (projectWorkspaceId === undefined) return;
                chrome.onFileShellAction(String(projectWorkspaceId), action, target);
              }}
            />
          ) : (
            <div className="empty">{t("conversation.noProjectSelected")}</div>
          )}
        </div>
      </section>;
      }}
      </PanelInstances>
      <SkillsDrawer
        open={chrome.skillsOpen && !chrome.collapsed && state.route === "workbench"}
        drawerRef={skillsDrawerRef}
        client={client}
        runtimeSessionId={liveSnapshot?.sessionId ?? null}
        onClose={chrome.onToggleSkills}
        onEnabledCountChange={chrome.onSkillsEnabledCount}
        onOpenHub={(intent) => chrome.onOpenCapabilities(intent?.tab, intent?.name)}
        onInsertSkill={chrome.onInsertSkill}
        onRemoveSkill={chrome.onRemoveComposerSkill}
        draftSkills={chrome.draftSkills}
        usedSkills={chrome.usedSkills}
      />
      {/* 左栏收起后，环境/用户入口回到侧栏底部（与 rail 里的头像同一个按钮）。 */}
      {/* 左栏收起后，环境/用户入口回到侧栏底部（与 rail 里的头像同一个按钮）。
          这块不自带位移：头像由壳里的幽灵搬运，它只负责把标签从头像右侧展开。
          收起这一帧就得挂上（壳要在同一帧量到落点），展开时多留一拍做折返。 */}
      <SidebarFooter
        railCollapsed={railCollapsed}
        profile={profile}
        hasUpdate={hasUpdate}
        version={effectiveUpdate?.version}
        status={ompStatus}
        menuOpen={chrome.ompMenuOpen}
        onToggleMenu={(anchor) => {
          if (ompMenuAnchorRef) ompMenuAnchorRef.current = anchor;
          chrome.onToggleOmpMenu();
        }}
        avatarRef={avatarRef}
        footerRef={footerRef}
      />
      {chrome.ompMenuOpen
        ? createPortal(
            <div
              ref={ompMenuRef}
              className="menu title-menu-popover omp-menu"
              role="menu"
              aria-label="OMP 状态与环境"
              style={{
                position: "fixed",
                left: ompMenuPos.left,
                ...(ompMenuPos.top !== undefined ? { top: ompMenuPos.top } : { bottom: ompMenuPos.bottom }),
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                className="omp-menu-head omp-menu-profile"
                role="menuitem"
                onClick={() => { chrome.onToggleOmpMenu(); onRoute("home"); }}
              >
                <div style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                  {profile.avatarSrc
                    ? <img className="avatar" src={profile.avatarSrc} alt="" draggable={false} />
                    : <span className="avatar" aria-hidden="true">{avatarInitial(profile.displayName)}</span>}
                  {hasUpdate && (
                    <span
                      style={{
                        position: "absolute",
                        top: -2,
                        right: -2,
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        backgroundColor: "var(--accent, #3b82f6)",
                        boxShadow: "0 0 0 2px var(--bg, #181825)",
                      }}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <span>
                  <span className="u-name">{profile.displayName}</span>
                  <span className="v">
                    <span style={{ color: ompConnected ? "var(--green)" : "var(--red)" }}>
                      {ompConnected ? t("shell.ready") : formatRuntimeStatusLabel(runtime?.status ?? "unavailable", (k) => t(k))}
                    </span>
                    {` · ${ompVersion} · ${ompMeta}`}
                  </span>
                </span>
              </button>
              {hasUpdate && (
                <div
                  style={{
                    margin: "4px 8px 8px",
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "var(--accent-subtle, rgba(59, 130, 246, 0.12))",
                    border: "1px solid var(--accent, rgba(59, 130, 246, 0.3))",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    chrome.onToggleOmpMenu();
                    onOpenAppUpdateDialog();
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.82rem", fontWeight: 600, color: "var(--accent, #3b82f6)" }}>
                    <Icon name="update" extra="sm" />
                    <span>{t("appUpdate.foundNewVersion")} v{effectiveUpdate?.version}</span>
                  </div>
                  <button type="button" className="btn primary sm" style={{ padding: "2px 8px", fontSize: "0.72rem" }}>
                    {t("common.details")}
                  </button>
                </div>
              )}
              {!ompConnected ? (
                <div className="omp-menu-err">
                  <Icon name="alert" extra="sm" />
                  <span>{state.hostError?.message ?? "Runtime 未连接。"}</span>
                </div>
              ) : null}
              <div className="menu-sep" />
              {runtimeCanReconnect(runtime) ? (
                <MenuItem icon="refresh" onClick={() => { setDiagnosticsIntent("reconnect"); chrome.onToggleOmpMenu(); onRoute("diagnostics"); }}>{t("shell.reconnectRuntime")}</MenuItem>
              ) : null}
              {runtimeCanRestart(runtime) ? (
                <MenuItem icon="refresh" onClick={() => { setDiagnosticsIntent("restart"); chrome.onToggleOmpMenu(); onRoute("diagnostics"); }}>{t("shell.restartRuntime")}</MenuItem>
              ) : null}
              <MenuItem icon="pulse" onClick={() => { chrome.onToggleOmpMenu(); onRoute("diagnostics"); }}>{t("shell.openDiagnostics")}</MenuItem>
              <MenuItem
                icon="update"
                onClick={() => {
                  chrome.onToggleOmpMenu();
                  if (hasUpdate) {
                    onOpenAppUpdateDialog();
                  } else {
                    setDiagnosticsIntent("check-update");
                    onRoute("diagnostics");
                  }
                }}
                {...(hasUpdate ? { hint: `v${effectiveUpdate?.version} ${t("shell.updateAvailable")}` } : preview ? { hint: "v0.82.2 可用" } : {})}
              >
                {t("shell.checkUpdate")}
              </MenuItem>
              <MenuItem icon="server" onClick={() => { chrome.onToggleOmpMenu(); onRoute("model-config"); }}>{t("shell.openModelConfig")}</MenuItem>
              <MenuItem icon="settings" onClick={() => { chrome.onToggleOmpMenu(); onRoute("settings"); }}>{t("shell.openSettings")}</MenuItem>
              <MenuItem icon="package" onClick={() => { chrome.onToggleOmpMenu(); onRoute("capabilities"); }}>{t("shell.openCapabilities")}</MenuItem>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

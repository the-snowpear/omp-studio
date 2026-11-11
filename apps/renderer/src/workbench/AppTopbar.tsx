import { dragConversation } from "../conversationWorkspace/drag";
import { useAllWindowed, useConversationWorkspace, useConversationView, useConversationDom } from "../conversationWorkspace/Context";
import { ConversationFloatingHeader, type ConversationHeaderStatus } from "../conversationWorkspace/Header";
import { TimeTravelEntry } from "../history/TimeTravelActivation";
import { revealMainWindow } from "../dock/SurfaceContext";
import { useDockEngine } from "../dock/DockContext";
import { DockRailToggle } from "../dock/DockRegions";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { useSessionTitles } from "../history/useSessionTitles";
import { SessionTitleMark } from "../history/SessionTitleMark";
import { previewSessionTitle } from "../preview/sessionTitlePreview";
import { AnnotationButton } from "../annotations/Annotations";
import { TokenUsagePanel } from "../usage/TokenUsagePanel";
import { setSettingsIntent } from "../pageIntents";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ConversationWidthMenu } from "../settings/ConversationWidthSettings";
import { useCompactTopbar } from "../layout/useCompactTopbar";
import type { SessionId, StudioClient } from "@omp-studio/client-contract";
import type { SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { MenuItem } from "../menus";
import { useI18n } from "../i18n";
import { useViewedSessionTelemetry, type ViewedSessionTelemetryState } from "../telemetry/useViewedSessionTelemetry";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_PROJECTS, findPreviewProject, findPreviewThread } from "../preview/fixtures";
import { PreviewContextPanel, PreviewContextTrigger, PreviewTokenTrigger } from "../preview/surfaces";
import { usableCapabilityManifest } from "../deck/interactionGate";
import { sidebarProjectOrder } from "../sidebar/projectOrder";
import { useGitSummary } from "../git/useGitSummary";
import { type Route, type ShellChrome, type ViewState } from "./types";
import { snapshotFrom } from "./shellState";
import { setSlashUiIntent } from "./slashUiIntent";
import { AnchoredPop, CrumbMenu, ThreadActionMenuItems } from "./menus";

function formatTelemetryTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString("en-US");
}

/** 压缩档只剩图标，把被收起的数字放进 tooltip（`.t-tok-icon` 见 App.css）。 */
function tokenUsageTip(telemetry: SessionTelemetrySnapshot | null): string {
  if (telemetry === null) return "Token";
  const t = telemetry.tokens;
  return `Token ↑${formatTelemetryTokens(t.input)} ↓${formatTelemetryTokens(t.output)} · ${formatTelemetryTokens(t.cacheRead + t.cacheWrite)} cache`;
}

function RealTokenTrigger({ telemetry }: { telemetry: SessionTelemetrySnapshot | null }) {
  const compact = <span className="t-tok-icon" data-tip={tokenUsageTip(telemetry)}><Icon name="chart" /></span>;
  if (telemetry === null) {
    return <>{compact}<span className="t-item"><Icon name="arrow-u" extra="sm" /><b>—</b></span><span className="t-item"><Icon name="arrow-d" extra="sm" /><b>—</b></span><span className="t-sep" aria-hidden="true" /><span className="t-item"><b>—</b>&nbsp;cache</span></>;
  }
  return <>{compact}<span className="t-item"><Icon name="arrow-u" extra="sm" /><b>{formatTelemetryTokens(telemetry.tokens.input)}</b></span><span className="t-item"><Icon name="arrow-d" extra="sm" /><b>{formatTelemetryTokens(telemetry.tokens.output)}</b></span><span className="t-sep" aria-hidden="true" /><span className="t-item"><b>{formatTelemetryTokens(telemetry.tokens.cacheRead + telemetry.tokens.cacheWrite)}</b>&nbsp;cache</span></>;
}

function formatTelemetryExact(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function RealContextTrigger({ telemetry }: { telemetry: SessionTelemetrySnapshot | null }) {
  const percent = telemetry?.context?.percent;
  return <><span className="ctx-ring" style={{ ["--p" as string]: percent ?? 0 }} aria-hidden="true" data-tip={percent === undefined ? "Context" : `Context ${Math.round(percent)}%`} /><span className="t-item"><b>{percent === undefined ? "—" : `${Math.round(percent)}%`}</b></span></>;
}

function RealContextPanel({ telemetry, view }: { telemetry: SessionTelemetrySnapshot | null; view: ViewedSessionTelemetryState | undefined }) {
  const { t: tr } = useI18n();
  const contextParts: ReadonlyArray<{ key: keyof NonNullable<SessionTelemetrySnapshot["context"]>; label: string; color: string }> = [
    { key: "systemPromptTokens", label: tr("shell.systemPrompt"), color: "#8a919c" },
    { key: "systemContextTokens", label: tr("shell.systemContext"), color: "#64748b" },
    { key: "systemToolsTokens", label: tr("shell.toolDefinitions"), color: "#d9930d" },
    { key: "skillsTokens", label: "Skills", color: "#6e56cf" },
    { key: "messagesTokens", label: tr("shell.chatMessages"), color: "#3b9bd4" },
  ];
  const context = telemetry?.context;
  if (context === null || context === undefined) {
    const reason = telemetry?.unavailableReason === "probe_dynamic_context_disabled"
      ? tr("common.unavailable")
      : view?.status === "loading"
        ? tr("common.loading")
        : tr("common.unavailable");
    return <><div className="tp-head"><Icon name="layers" extra="sm" />{tr("shell.contextComposition")}<span className="spacer" /><span className="chip gray xs">{tr("common.unavailable")}</span></div><div className="tp-ctx"><div className="tiny muted">{reason}</div></div></>;
  }
  const ctxWindow = Math.max(1, context.contextWindow);
  const pct = Math.round(context.percent);
  const tone = pct > 80 ? "red" : pct > 60 ? "amber" : "green";
  const restTokens = Math.max(0, context.contextWindow - context.usedTokens);
  const hasRest = restTokens > 0;
  return <><div className="tp-head"><Icon name="layers" extra="sm" />{tr("shell.contextComposition")}<span className="spacer" /><span className={`chip ${tone} xs`}>{pct}%</span></div><div className="tp-ctx" style={{ paddingTop: 12 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span>{tr("shell.used")}</span><b className="mono" style={{ fontSize: 13 }}>{formatTelemetryExact(context.usedTokens)} / {formatTelemetryExact(context.contextWindow)} ({context.percent.toFixed(1)}%)</b></div><div className="ctxbar">{contextParts.map((part) => <i key={part.key} style={{ width: `${Math.min(100, ((context[part.key] as number) / ctxWindow) * 100)}%`, background: part.color }} data-tip={part.label} />)}{hasRest ? <i className="cb-rest" data-tip={tr("shell.unused")} /> : null}</div><div className="ctx-legend">{contextParts.map((part) => <div key={part.key} className="cl-row"><span className="cl-dot" style={{ background: part.color }} /><span>{part.label}</span><span className="cl-v">{formatTelemetryTokens(context[part.key] as number)}</span></div>)}{hasRest ? <div className="cl-row"><span className="cl-dot" style={{ background: "var(--surface-3)" }} /><span>{tr("shell.unused")}</span><span className="cl-v">{formatTelemetryTokens(restTokens)}</span></div> : null}</div><div className="tiny muted" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>{context.anchored ? tr("shell.providerAnchor") : tr("shell.estimated")}</div></div></>;
}

export function AppTopbar({ state, client, chrome, onRoute, threadTitle, sideOpen, onToggleSide, onOpenChanges, onOpenGit, onOpenTerminal, viewedSessionId, telemetryRefreshToken }: {
  state: ViewState;
  client: StudioClient;
  chrome: ShellChrome;
  onRoute: (route: Route) => void;
  threadTitle: string;
  sideOpen: boolean;
  onToggleSide: () => void;
  onOpenChanges: () => void;
  /** 打开右侧面板的 Git 页签（分支菜单的 Git 操作入口）。 */
  onOpenGit: () => void;
  onOpenTerminal: () => void;
  /** Session being viewed when a history thread is open; undefined = live thread. */
  viewedSessionId: SessionId | undefined;
  /** Bump after compact so Context 构成 re-reads the current session. */
  telemetryRefreshToken?: number;
}) {
  const conversation = useConversationView();
  const conversationWorkspace = useConversationWorkspace();
  const { document, window } = useConversationDom();
  const { t, resolvedLanguage } = useI18n();
  const dock = useDockEngine();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [floatingDetails, setFloatingDetails] = useState<"tokens" | "context" | null>(null);
  const executionTarget = useExecutionTarget();
  const { preview, marks } = usePreviewMode();
  /** 对话动作可用性：写表面始终走真实 API（预览只覆盖读表面），
      因此只看真实 Runtime 快照；无活动会话时诚实禁用并说明原因。 */
  const liveSnapshot = snapshotFrom(state);
  const sessionLive = liveSnapshot !== undefined;
  const sessionBusy = liveSnapshot?.isStreaming === true || liveSnapshot?.isCompacting === true;
  const sessionActionReason = !sessionLive ? t("common.unavailable") : t("common.loading");
  const previewProject = findPreviewProject(chrome.previewProjectId);
  const previewHit = findPreviewThread(chrome.previewThreadId);
  const realActiveWorkspace = state.model.workspaces?.workspaces.find(workspace => workspace.workspaceId === conversation?.document.ref.workspaceId)
    ?? state.model.workspaces?.workspaces.find(workspace => workspace.active);
  // 与侧栏项目树同一顺序，避免「切换项目」菜单在每次切换后重排。
  const switchProjectOptions = useMemo(
    () => sidebarProjectOrder(state.model.workspaces),
    [state.model.workspaces],
  );
  const realGit = useGitSummary(client, preview ? undefined : realActiveWorkspace?.workspaceId);
  const crumbProject = preview
    ? (previewProject?.name ?? "omp-web")
    : (realActiveWorkspace?.name ?? t("conversation.noProjectSelected"));
  const crumbBranch = preview ? (previewProject?.branch ?? "main") : (realGit.repository?.branch ?? (realGit.repository?.detached ? "detached HEAD" : "—"));
  const crumbThread = preview ? (previewHit?.thread.title ?? threadTitle) : threadTitle;
  const titleTarget = viewedSessionId ?? liveSnapshot?.sessionId;
  const titleMetadata = useSessionTitles(client,{sessionId:liveSnapshot?.sessionId,available:(state.clientState?.connection.runtime ?? state.bootstrap?.runtime)?.status === "connected",capabilities:usableCapabilityManifest(state.model.capabilities,state.clientState?.connection.capabilityManifest,state.bootstrap?.capabilityManifest)},titleTarget?[{id:titleTarget,title:crumbThread}]:[],state.route === "workbench");
  const titleRow = preview ? previewSessionTitle(chrome.previewThreadId,crumbThread) : titleMetadata.rows.get(titleTarget ?? "");
  const viewedTelemetry = useViewedSessionTelemetry({
    client: preview ? null : client,
    preview,
    enabled: floatingDetails !== null || openMenu === "tokens" || openMenu === "context" || openMenu === "overflow-tokens" || openMenu === "overflow-context",
    viewedSessionId,
    liveSessionId: preview ? undefined : snapshotFrom(state)?.sessionId,
    liveTelemetry: preview ? undefined : (state.clientState?.entities.telemetry ?? undefined),
    ...(telemetryRefreshToken === undefined ? {} : { refreshToken: telemetryRefreshToken }),
  });
  const telemetry = preview ? null : (viewedTelemetry.telemetry ?? null);
  useEffect(() => { if (conversation && !conversation.active) setOpenMenu(null); }, [conversation?.active]);

  useEffect(() => {
    if (openMenu === null) return;
    const close = () => setOpenMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const run = (action?: () => void) => {
    setOpenMenu(null);
    action?.();
  };

  const openTokenCounter = () => run(() => { onRoute("workbench"); dock.store.dispatch({ type: "open", panel: "token-counter" }); });
  const contextPanel = <>
    {preview ? <PreviewContextPanel /> : <RealContextPanel telemetry={telemetry} view={viewedTelemetry} />}
    <footer className="telemetry-footer"><button type="button" onClick={() => run(() => { setSlashUiIntent("context-viewer"); onRoute("workbench"); })}><Icon name="layers" extra="sm" /><span>{t("palette.openContext")}</span><Icon name="arrow-r" extra="sm" /></button></footer>
  </>;
  const topbarRef = useCompactTopbar(conversationWorkspace?.titleRow);
  const windowed = useAllWindowed();
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const waiting = preview ? previewHit?.thread.wait : state.clientState?.interaction.pending;
  const runtimeConnected = (state.clientState?.connection.runtime ?? state.bootstrap?.runtime)?.status === "connected";
  const floatingStatus: ConversationHeaderStatus | undefined = !preview && !runtimeConnected ? { tone: "error", label: text("未连接", "Disconnected") }
    : liveSnapshot?.isCompacting && !preview ? { tone: "running", label: text("正在压缩", "Compacting") }
    : waiting ? { tone: "waiting", label: text("等待处理", "Waiting for input") }
    : (preview ? previewHit?.thread.status === "running" : liveSnapshot?.isStreaming) ? { tone: "running", label: text("运行中", "Running") } : undefined;
  /** From a window title row, actions that land in the main window (its panels and pages) bring it forward first. */
  const inMainWindow = (action: () => void, workbench = true) => () => { revealMainWindow(); if (workbench && state.route !== "workbench") onRoute("workbench"); action(); };
  /** Project and branch menus, shared by the top bar breadcrumb and (in window mode) each window's title row. */
  const projectMenu = (finish: (action: () => void) => void, fromWindow = false) => <>
    <div className="menu-label">{t("shell.switchProject")}</div>
    {preview ? PREVIEW_PROJECTS.map((project) => (
      <MenuItem
        key={project.id}
        icon="folder-open"
        current={project.id === chrome.previewProjectId}
        hint={project.id === chrome.previewProjectId ? t("shell.current") : project.branch}
        onClick={() => finish(() => chrome.onSelectPreviewProject(project.id))}
      >
        {project.name}
      </MenuItem>
    )) : (
      <>
        {switchProjectOptions.map((workspace) => (
          <MenuItem
            key={workspace.workspaceId}
            icon="folder-open"
            current={workspace.active}
            {...(workspace.active ? { hint: t("shell.current") } : {})}
            onClick={() => finish(() => chrome.onSelectProject({ id: workspace.workspaceId, name: workspace.name }))}
          >
            {workspace.name}
          </MenuItem>
        ))}
        {!switchProjectOptions.length ? (
          <MenuItem icon="folder-open" disabled title={t("shell.noProjects")}>{t("shell.noProjects")}</MenuItem>
        ) : null}
      </>
    )}
    <div className="menu-sep" />
    <MenuItem
      icon="external"
      disabled={chrome.projectShellUnavailable !== undefined || chrome.projectShellAction !== null}
      {...(chrome.projectShellUnavailable !== undefined
        ? { title: chrome.projectShellUnavailable }
        : chrome.projectShellAction === "editor"
          ? { title: t("common.loading") }
          : {})}
      onClick={() => finish(chrome.onOpenProjectInEditor)}
    >{t("shell.openInExternalEditor")}</MenuItem>
    <MenuItem icon="terminal" onClick={() => finish(fromWindow ? inMainWindow(onOpenTerminal) : onOpenTerminal)}>{t("shell.openInTerminal")}</MenuItem>
    <MenuItem
      icon="folder-open"
      disabled={chrome.projectShellUnavailable !== undefined || chrome.projectShellAction !== null}
      {...(chrome.projectShellUnavailable !== undefined
        ? { title: chrome.projectShellUnavailable }
        : chrome.projectShellAction === "directory"
          ? { title: t("common.loading") }
          : {})}
      onClick={() => finish(chrome.onOpenProjectDirectory)}
    >{t("shell.openProjectDirectory")}</MenuItem>
    <div className="menu-sep" />
    <MenuItem icon="home" onClick={() => finish(fromWindow ? inMainWindow(() => onRoute("home"), false) : () => onRoute("home"))}>{t("menu.projectHome")}</MenuItem>
  </>;
  const branchMenu = (finish: (action: () => void) => void, fromWindow = false) => {
    const git = fromWindow ? inMainWindow(onOpenGit) : onOpenGit, changes = fromWindow ? inMainWindow(onOpenChanges) : onOpenChanges;
    return <>
      <div className="branch-menu-head">
        <div className="bmh-title"><Icon name="branch" extra="sm" /><b>{crumbBranch}</b></div>
        <div className="bmh-meta">{preview ? `${previewProject?.dirty ?? 0} ${t("shell.uncommitted")}${marks ? ` · ${t("common.demo")}` : ""}` : realGit.repository?.isRepository ? `${realGit.repository.changedFiles} ${t("shell.uncommitted")} · ↑${realGit.repository.ahead} ↓${realGit.repository.behind}` : (realGit.error ?? t("common.unavailable"))}</div>
      </div>
      <MenuItem icon="commit" onClick={() => finish(git)}>{t("shell.uncommittedChanges")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="columns" onClick={() => finish(changes)}>{t("shell.viewChanges")}</MenuItem>
      <MenuItem icon="commit" onClick={() => finish(git)}>{t("shell.createCommit")}</MenuItem>
      <MenuItem icon="branch" onClick={() => finish(git)}>{t("shell.switchBranch")}</MenuItem>
      <MenuItem icon="worktree" onClick={() => finish(git)}>{t("shell.newWorktree")}</MenuItem>
    </>;
  };
  return (
    <>
    <header ref={topbarRef} className="topbar" onPointerDown={event => {
      if (!conversationWorkspace) return;
      const state = conversationWorkspace.store.getSnapshot();
      const main = state.views.find(view => view.placement === "main" && !view.minimized);
      if (main && !state.documents.find(record => record.id === state.activeDocumentId)?.page) dragConversation(event, conversationWorkspace.store, { viewId: main.id });
    }}>
      {windowed ? null : <div className="tb-left">
        <nav className="tb-crumb" aria-label={t("shell.currentLocation")}>
          <CrumbMenu
            id="project"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip={t("shell.project")}
            menu={projectMenu(run)}
          >
            <Icon name="folder-open" extra="sm" />
            <span className="crumb-label crumb-project-label" data-tip={crumbProject}>{crumbProject}</span>
            <Icon name="chevron-d" extra="sm crumb-chevron crumb-project-chevron" />
          </CrumbMenu>
          <span className="crumb-sep" aria-hidden="true">›</span>
          <CrumbMenu
            id="branch"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip={t("shell.branch")}
            menu={branchMenu(run)}
          >
            <Icon name="branch" extra="sm" />
            <span className="crumb-label crumb-branch-label" data-tip={crumbBranch}>{crumbBranch}</span>
          </CrumbMenu>
          <span className="crumb-sep" aria-hidden="true">›</span>
          <CrumbMenu
            id="thread"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip={t("shell.chat")}
            current
            menu={
              <>
                <ThreadActionMenuItems
                  live={sessionLive}
                  busy={sessionBusy}
                  compacting={liveSnapshot?.isCompacting === true}
                  compactPending={chrome.compactPending}
                  reason={sessionActionReason}
                  onRename={() => run(chrome.onRenameThread)}
                  onFork={() => run(chrome.onForkThread)}
                  onHandoff={() => run(chrome.onHandoffThread)}
                  onCompact={() => run(chrome.onCompactThread)}
                  onExport={() => run(chrome.onExportThread)}
                  onHistory={() => run(() => onRoute("history"))}
                />
                <MenuItem
                  icon="archive"
                  disabled={preview ? chrome.hiddenPreviewThreads.has(chrome.previewThreadId) : chrome.archiveTarget === undefined}
                  {...(preview
                    ? chrome.hiddenPreviewThreads.has(chrome.previewThreadId)
                    ? { title: t("history.archiveSession") }
                      : {}
                    : chrome.archiveTarget === undefined
                      ? { title: sessionActionReason }
                      : {})}
                  onClick={() => {
                    if (preview) {
                      run(() => chrome.onArchivePreviewThread(chrome.previewThreadId));
                      return;
                    }
                    const target = chrome.archiveTarget;
                    if (target !== undefined) run(() => chrome.onArchiveThread(target));
                  }}
                >{t("history.archiveSession")}</MenuItem>
                <div className="menu-sep" />
                <ConversationWidthMenu onSelect={() => setOpenMenu(null)} onOpenSettings={() => { setOpenMenu(null); setSettingsIntent("appearance", "conversation.width"); onRoute("settings"); }} />
              </>
            }
          >
            <SessionTitleMark row={titleRow} title={crumbThread} /><span className="ellipsis" data-tip={crumbThread}>{crumbThread}</span>
            <Icon name="chevron-d" extra="sm crumb-chevron" />
          </CrumbMenu>
        </nav>
        <button
          className="icon-btn"
          data-tip={sessionLive && !sessionBusy ? t("shell.tipForkThread") : sessionActionReason}
          aria-label={t("shell.forkThread")}
          disabled={!sessionLive || sessionBusy}
          onClick={() => run(chrome.onForkThread)}
        ><Icon name="fork" /></button>
        <button
          className="icon-btn"
          data-tip={sessionLive && !sessionBusy ? t("shell.tipHandoffThread") : sessionActionReason}
          aria-label={t("shell.handoffThread")}
          disabled={!sessionLive || sessionBusy}
          onClick={() => run(chrome.onHandoffThread)}
        ><Icon name="handoff" /></button>
      </div>}
      <button className="icon-btn lg" data-tip={t("nav.agentHub")} aria-label="Agent Hub" onClick={() => onRoute("agent-hub")}><Icon name="bot" extra="lg" /></button>
      <button className="icon-btn" data-tip={t("nav.history")} aria-label={t("nav.history")} onClick={() => onRoute("history")}><Icon name="history" /></button>
      <div className="tb-right">
        <div className="tb-overflow" onMouseDown={event => event.stopPropagation()}>
          <button type="button" className="icon-btn" aria-label={t("common.more")} data-tip={t("common.more")} aria-haspopup="menu" aria-expanded={openMenu === "overflow" || openMenu === "overflow-tokens" || openMenu === "overflow-context"} onClick={() => setOpenMenu(openMenu?.startsWith("overflow") ? null : "overflow")}><Icon name="more" /></button>
          {openMenu?.startsWith("overflow") ? createPortal(
            <div className={`menu title-menu-popover tb-overflow-menu${openMenu === "overflow-tokens" ? " tok-pop" : openMenu === "overflow-context" ? " telemetry-pop ctx-pop" : ""}`} role={openMenu === "overflow" ? "menu" : "dialog"} aria-label={openMenu === "overflow-tokens" ? t("shell.tokenUsageDetails") : openMenu === "overflow-context" ? t("shell.contextCompositionDetails") : t("common.more")} onMouseDown={event => event.stopPropagation()}>
              {openMenu === "overflow-tokens" ? <TokenUsagePanel telemetry={telemetry} view={viewedTelemetry} onClose={() => setOpenMenu(null)} onOpenCounter={openTokenCounter} /> : openMenu === "overflow-context" ? contextPanel : <>
                <MenuItem icon="bot" onClick={() => run(() => onRoute("agent-hub"))}>{t("nav.agentHub")}</MenuItem>
                <MenuItem icon="history" onClick={() => run(() => onRoute("history"))}>{t("nav.history")}</MenuItem>
                <MenuItem icon="terminal" onClick={() => run(onOpenTerminal)}>{t("nav.terminal")}</MenuItem>
                <MenuItem icon="diff" onClick={() => run(onOpenChanges)}>Changes</MenuItem>
                <MenuItem icon="branch" onClick={() => run(onOpenGit)}>Git</MenuItem>
                <div className="menu-sep" />
                <MenuItem onClick={() => setOpenMenu("overflow-tokens")}>{t("shell.tokenUsageDetails")}</MenuItem>
                <MenuItem onClick={() => setOpenMenu("overflow-context")}>{t("shell.contextCompositionDetails")}</MenuItem>
                <MenuItem icon="code" onClick={openTokenCounter}>{resolvedLanguage === "zh" ? "离线 Token 计数" : "Offline token counter"}</MenuItem>
                <MenuItem icon="minimize" disabled={!sessionLive || sessionBusy} onClick={() => run(chrome.onCompactThread)}>{t("shell.compactThread")}</MenuItem>
                <MenuItem icon="light" onClick={() => run(chrome.onToggleTheme)}>{t("shell.theme")}</MenuItem>
                <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>{t("nav.home")}</MenuItem>
              </>}
            </div>, document.body) : null}
        </div>
        <div className="telemetry">
          <AnnotationButton iconOnly />
          <AnchoredPop
            id="tokens"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="Token"
            label={t("shell.tokenUsageDetails")}
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop tok-pop"
            panel={<TokenUsagePanel telemetry={telemetry} view={viewedTelemetry} onClose={() => setOpenMenu(null)} onOpenCounter={openTokenCounter} />}
          >
            {preview ? <PreviewTokenTrigger /> : <RealTokenTrigger telemetry={telemetry} />}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          <AnchoredPop
            id="context"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="Context"
            label={t("shell.contextCompositionDetails")}
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop ctx-pop"
            panel={contextPanel}
          >
            {preview ? <PreviewContextTrigger /> : <RealContextTrigger telemetry={telemetry} />}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          {chrome.compactPending === true || liveSnapshot?.isCompacting === true ? (
            <button
              className="tb-compact is-pending"
              disabled={!sessionLive}
              data-tip={!sessionLive ? sessionActionReason : t("common.cancel")}
              aria-label={t("common.cancel")}
              onClick={() => run(chrome.onCancelCompact)}
            >
              <Icon name="x" extra="sm" />
              <span className="tb-compact-label">{t("common.cancel")}</span>
            </button>
          ) : (
            <button
              className="tb-compact"
              disabled={!sessionLive}
              data-tip={!sessionLive ? sessionActionReason : t("shell.tipCompactThread")}
              aria-label={t("shell.compactThread")}
              onClick={() => run(chrome.onCompactThread)}
            >
              <Icon name="minimize" extra="sm" />
              <span className="tb-compact-label">Compact</span>
            </button>
          )}
        </div>
        <DockRailToggle />
        <button className={`icon-btn${sideOpen ? " active" : ""}`} data-tip={t("menu.rightPanel")} aria-controls="sidePanel" data-dock-entry="right" aria-expanded={sideOpen} onClick={onToggleSide}><Icon name="panel" /></button>
        <button className="icon-btn" data-tip={t("shell.theme")} onClick={chrome.onToggleTheme} aria-label={t("shell.theme")}>
          <Icon name={chrome.theme === "dark" ? "moon" : "light"} />
        </button>
        <button className="icon-btn" data-tip={t("nav.home")} onClick={() => onRoute("home")}><Icon name="home" /></button>
      </div>
    </header>
    <ConversationFloatingHeader title={crumbThread} titleRow={titleRow}
      timeTravel={<TimeTravelEntry client={client ?? undefined} onOpen={() => { revealMainWindow(); onRoute("history"); }} />}
      source={{ project: crumbProject, branch: crumbBranch, path: preview ? previewProject?.path : realActiveWorkspace?.root, connection: executionTarget.id === null ? undefined : executionTarget.name }}
      status={floatingStatus} onDetailsChange={setFloatingDetails}
      windowed={windowed} projectMenu={close => projectMenu(action => { close(); run(action); }, true)} branchMenu={close => branchMenu(action => { close(); run(action); }, true)}
      threadActions={{ disabled: preview || !sessionLive || sessionBusy, reason: preview ? t("common.unavailableInPreview") : sessionActionReason, onFork: () => run(chrome.onForkThread), onHandoff: () => run(chrome.onHandoffThread) }}
      sessionMenu={close => {
        const finish = (action: () => void) => { close(); run(action); };
        return <><ThreadActionMenuItems live={!preview && sessionLive} busy={sessionBusy} compacting={liveSnapshot?.isCompacting === true} compactPending={chrome.compactPending} reason={preview ? t("common.unavailableInPreview") : sessionActionReason}
          onRename={() => finish(chrome.onRenameThread)} onFork={() => finish(chrome.onForkThread)} onHandoff={() => finish(chrome.onHandoffThread)} onCompact={() => finish(chrome.onCompactThread)} onExport={() => finish(chrome.onExportThread)} onHistory={() => finish(() => { revealMainWindow(); onRoute("history"); })} />
          {chrome.compactPending || liveSnapshot?.isCompacting ? <MenuItem icon="x" disabled={preview || !sessionLive} onClick={() => finish(chrome.onCancelCompact)}>{t("common.cancel")}</MenuItem> : null}
          <MenuItem icon="archive" disabled={preview ? chrome.hiddenPreviewThreads.has(chrome.previewThreadId) : chrome.archiveTarget === undefined} onClick={() => { if (preview) finish(() => chrome.onArchivePreviewThread(chrome.previewThreadId)); else if (chrome.archiveTarget) finish(() => chrome.onArchiveThread(chrome.archiveTarget!)); }}>{t("history.archiveSession")}</MenuItem>
          {windowed ? <><div className="menu-sep" /><ConversationWidthMenu onSelect={close} onOpenSettings={() => { close(); revealMainWindow(); setSettingsIntent("appearance", "conversation.width"); onRoute("settings"); }} /></> : null}
        </>;
      }}
      tokenPanel={close => <TokenUsagePanel telemetry={telemetry} view={viewedTelemetry} onClose={close} onOpenCounter={() => { close(); openTokenCounter(); }} />}
      contextPanel={contextPanel} onOpenTokenCounter={openTokenCounter} />
    </>
  );
}

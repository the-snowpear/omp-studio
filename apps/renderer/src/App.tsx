import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, FormEvent as ReactFormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type {
  AuthorityEpoch,
  AuthorityId,
  ClientBootstrap,
  ClientError,
  ClientEvent,
  ClientInteraction,
  CommandName,
  CommandInput,
  DiagnosticReadModel,
  EnvironmentReadModel,
  GitBranchRecord,
  GitOperationResult,
  HomeReadModel,
  InteractionResponseValue,
  OperatorInvokeOutcome,
  SessionHistoryEntry,
  SessionHistoryReadModel,
  SessionId,
  SessionTreeCommandOutcome,
  ThreadId,
  StudioClient,
  Unsubscribe,
  WorkspaceId,
  WorkspaceListReadModel,
  WorkspaceFileNode,
  WorkspaceFileTreeReadModel,
  PromptImageInput,
} from "@omp-studio/client-contract";
import { selectComposerReceipt, type ClientState, type ConversationHydrateClient } from "@omp-studio/client";
import {
  clientShellChanged,
  shouldRecordShellEvent,
  toShellEventLogEntry,
  type ShellEventLogEntry,
} from "./shellMemory";
import type { ApprovalMode, OperatorStateSnapshot, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import type { OperatorCommandManifest } from "@omp-studio/studio-protocol";
import { AppIcon, Icon } from "./icons";
import { HomePage, SecondaryPage } from "./HomePage";
import { HistoryPage } from "./HistoryPage";
import { AgentHubPage, setHubIntent } from "./AgentHub";
import { CapabilitiesPage, setCapIntent, type CapTab } from "./CapabilitiesPage";
import { ModelConfigPage, modelConfigHasUnsavedChanges, setModelConfigIntent } from "./ModelConfigPage";
import { approvalPickerDisabled, ComposerApprovalPicker } from "./ComposerApprovalPicker";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { ComposerModePicker } from "./ComposerModePicker";
import { ChipComposer, type ChipComposerHandle } from "./composer/ChipComposer";
import {
  bindSlashTypedCommand,
  composerSlashExecute,
  isDestructiveMemoryClear,
  planComposerSend,
  resolveSlashExecute,
  type SlashNativeUi,
  type StudioSlashCommand,
} from "./composer/commands";
import {
  canFlushQueuedMessage,
  composerFollowUpEnabled,
  composerPromptEnabled,
  composerQueueEnabled,
  visibleQueuedMessages,
} from "./composer/dispatch";
import {
  beginQueueEdit,
  cancelQueueEdit,
  commitQueueEdit,
  parkQueueEdit,
  snapshotOfQueued,
  switchQueueEdit,
  type QueueEditState,
} from "./composer/queueEdit";
import {
  createWorkspaceFileIndex,
  loadMentions,
  previewMentions,
  workspaceDirectoryLister,
} from "./composer/mentions";
import { snapshotFromDoc, snapshotFromText, snapshotFromTextAndImages, snapshotIsEmpty } from "./composer/serialize";
import { emptySnapshot, fileLabel, type ComposerSnapshot } from "./composer/types";
import { mergeUsedSkills, skillNamesInDoc, skillNamesInText } from "./skills/skillUsage";
import { MessageQueueBar, type QueuedMessage } from "./MessageQueueBar";
import { injectMagicKeyword, type MagicKeyword } from "./composerMode";
import { SettingsPage, setSettingsIntent } from "./SettingsPage";
import { DiagnosticsPage, setDiagnosticsIntent } from "./DiagnosticsPage";
import { queryWithTimeout } from "./updateCheck";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { TipHost } from "./TipHost";
import { ToastHost } from "./ToastHost";
import { SkillsDrawer } from "./SkillsDrawer";
import { CommandPalette, type CommandPaletteHandle } from "./CommandPalette";
import { buildPaletteGroups, type BottomTab, type PaletteAction, type SideTab } from "./commandPaletteCatalog";
import { toDrawerItems } from "./extensibilityMap";
import { countEnabledDrawerItems, createPreviewDrawerItems, type DrawerItem } from "./skillsPreview";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { useViewedSessionTelemetry, type ViewedSessionTelemetryState } from "./telemetry/useViewedSessionTelemetry";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { asConversationClient } from "./conversation/conversationHost";
import { useActivityRetry, useAwaitingTurn, useRunWindow } from "./conversation/ActivityLine";
import { deriveActivityStatus, isAbortEligible } from "./conversation/activityStatus";
import { ConversationEmpty } from "./conversation/ConversationEmpty";
import { ConversationPane } from "./conversation/ConversationPane";
import { SubagentInspectCard } from "./conversation/SubagentInspectCard";
import { collectLatestPlanDocument, SESSION_CHANGE_LAST_ID, type SubagentHubTarget } from "./conversation/toolMeta";
import { ConversationMinimap } from "./conversation/ConversationMinimap";
import { TaskProgressDock } from "./conversation/TaskProgressDock";
import { sessionTaskProgress } from "./conversation/toolMeta";
import { SessionChanges } from "./conversation/SessionChanges";
import { AgentTestsPane } from "./conversation/AgentTestsPane";
import { agentTestRunSummary, projectAgentTestRuns, rerunTestPrompt } from "./conversation/agentTestRuns";
import { revealConversationTool } from "./conversation/conversationReveal";
import { useConversation } from "./conversation/useConversation";
import { deriveExplorerFileActivity, explorerRowActivity, EMPTY_EXPLORER_FILE_ACTIVITY, type ExplorerFileActivity } from "./conversation/explorerFileActivity";
import {
  executeUserMessageBranch,
  executeUserMessageRestore,
  userMessageRestoreDisabledReason,
  type UserMessageEditorFill,
} from "./conversation/userMessageRestore";
import { useUserMessageTreeConfirm } from "./conversation/UserMessageTreeConfirm";
import { claimTransientToast, isTransientStatusNotice, transientStatusFamily } from "./conversation/transientStatusNotice";
import { PreviewModeProvider, usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_MODE_SWITCH_ENABLED, readStoredPreviewMode } from "./preview/mode";
import {
  getAppSettings,
  readLastRoute,
  readLayoutMemory,
  useAppSettings,
  writeLastRoute,
  writeLayoutMemory,
} from "./settings/appSettings";
import { desktopNotice, notifyAskConfirmation, clearAskConfirmationNotice } from "./settings/desktopNotice";
import { StartupNotice } from "./StartupNotice";
import { avatarInitial, useOperatorProfile } from "./settings/operatorProfile";
import {
  PREVIEW_PROJECTS,
  PREVIEW_QUEUED_MESSAGES,
  PREVIEW_RUN_ACTIVITY,
  PREVIEW_TODOS,
  PREVIEW_TODO_FILES,
  defaultPreviewSelection,
  findPreviewProject,
  findPreviewThread,
} from "./preview/fixtures";
import {
  PreviewChanges,
  PreviewContextPanel,
  PreviewContextTrigger,
  PreviewFileTree,
  PreviewGitPanel,
  PreviewLogs,
  PreviewProblems,
  PreviewSideAgents,
  PreviewSidePreview,
  PreviewSwitch,
  PreviewTests,
  PreviewTokenPanel,
  PreviewTokenTrigger,
} from "./preview/surfaces";
import { PreviewDeck } from "./preview/PreviewDeck";
import { PREVIEW_DECK_ITEMS } from "./preview/deckFixtures";
import { PREVIEW_BTW_QUESTION, PREVIEW_BTW_SNAPSHOTS, previewBtwSnapshot } from "./preview/btwPreview";
import { BtwHost } from "./btw/BtwHost";
import { BtwPanel } from "./btw/BtwPanel";
import type { BtwRect } from "./btw/btwGeometry";
import { useBtwSession, type BtwSessionApi } from "./btw/useBtwSession";
import { useBtwWindow, type BtwWindowApi } from "./btw/useBtwWindow";
import { InteractionDeck } from "./InteractionDeck";
import { ASK_GENIE_HOLD_MS, isAskDeckInteraction, prefersReducedMotion } from "./deck/askGenie";
import { interactionDeckDisabled, usableCapabilityManifest } from "./deck/interactionGate";
import { PlanReviewDeck, PlanViewDialog } from "./deck/PlanCard";
import { type PlanActionDetail, type PlanActionId } from "./deck/types";
import { ThreadSpin } from "./sidebar/ThreadSpin";
import { ThreadWaitChip } from "./sidebar/ThreadWaitChip";
import { threadRunningFromLive } from "./sidebar/threadRunning";
import { waitKindFromLive, type ThreadWaitKind } from "./sidebar/threadWait";
import { ensureSelectedSessionActive } from "./sessionLifecycle";
import { GitStatusPanel, useGitRepository } from "./git/GitStatusPanel";
import { buildGitStatusLookup, GIT_STATUS_META, type TreeGitStatus } from "./git/treeStatus";

const PREVIEW_PLAN_TITLE = PREVIEW_DECK_ITEMS.find((item) => item.kind === "plan")?.title ?? "Plan";

const KNOWN_ROUTES: ReadonlyArray<Route> = ["home", "workbench", "history", "agent-hub", "capabilities", "model-config", "settings", "diagnostics"];

function parseStoredRoute(value: string | undefined): Route | undefined {
  return value !== undefined && (KNOWN_ROUTES as readonly string[]).includes(value) ? (value as Route) : undefined;
}

/** 启动落地页：不恢复最近项目时停首页；「上次页面」读持久化的 route。 */
function initialRouteFromSettings(): Route {
  const settings = getAppSettings();
  if (!settings.restoreLastProject) return "home";
  if (settings.startupPage === "home") return "home";
  if (settings.startupPage === "last") return parseStoredRoute(readLastRoute()) ?? "workbench";
  return "workbench";
}

/** App 级系统通知：由 ClientEvent 流触发，偏好开关在 desktopNotice 内判断。 */
function notifyFromEvent(event: ClientEvent): void {
  if (event.kind === "interaction.required") {
    notifyAskConfirmation(event.interaction.interactionId, event.interaction.leaseGeneration, event.interaction.title);
    return;
  }
  if (event.kind === "interaction.resolved") {
    clearAskConfirmationNotice(event.interactionId, event.leaseGeneration);
    return;
  }
  if (event.kind === "command.receipt" && event.receipt.status === "failed") {
    desktopNotice("error", "命令失败", event.receipt.error.message);
    return;
  }
  if (event.kind === "resync.required") {
    desktopNotice("error", "需要重新同步", event.reason);
  }
}

type Model = {
  environment?: EnvironmentReadModel;
  capabilities?: ClientBootstrap["capabilityManifest"];
  commandManifest?: OperatorCommandManifest;
  diagnostics?: DiagnosticReadModel;
  history?: SessionHistoryReadModel;
  home?: HomeReadModel;
  workspaces?: WorkspaceListReadModel;
};

type ClientStateSource = StudioClient & ConversationHydrateClient & {
  getState?: () => ClientState;
  onState?: (listener: (state: ClientState) => void) => Unsubscribe;
};

type Route = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics";
type SecondaryRoute = Exclude<Route, "workbench">;

function isSecondary(route: Route): route is SecondaryRoute {
  return route === "home" || route === "history" || route === "agent-hub" || route === "capabilities" || route === "model-config" || route === "settings" || route === "diagnostics";
}

const SECONDARY_META: Record<SecondaryRoute, { title: string; icon: string }> = {
  home: { title: "首页", icon: "home" },
  history: { title: "会话历史与 Time Travel", icon: "history" },
  "agent-hub": { title: "Agent Hub", icon: "bot" },
  capabilities: { title: "能力中心", icon: "package" },
  "model-config": { title: "模型配置", icon: "server" },
  settings: { title: "设置", icon: "settings" },
  diagnostics: { title: "诊断中心", icon: "pulse" },
};

type ViewState = {
  loading: boolean;
  bootstrap?: ClientBootstrap;
  clientState?: ClientState;
  model: Model;
  error?: ClientError;
  hostError?: ClientError;
  events: ShellEventLogEntry[];
  route: Route;
};

type Action =
  | { type: "ready"; bootstrap: ClientBootstrap; clientState?: ClientState; hostError?: ClientError }
  | { type: "state"; clientState: ClientState }
  | { type: "model"; model: Model }
  | { type: "error"; error: ClientError }
  | { type: "event"; event: ClientEvent };

function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "ready": {
      const { error: _clearedError, hostError: _clearedHostError, ...rest } = state;
      return { ...rest, loading: false, bootstrap: action.bootstrap, ...(action.hostError ? { hostError: action.hostError } : {}), ...(action.clientState ? { clientState: action.clientState } : {}) };
    }
    case "state":
      return { ...state, clientState: action.clientState };
    case "model":
      return { ...state, model: { ...state.model, ...action.model } };
    case "error":
      return { ...state, loading: false, error: action.error };
    case "event":
      if (!shouldRecordShellEvent(action.event)) return state;
      return { ...state, events: [...state.events.slice(-199), toShellEventLogEntry(action.event)] };
  }
}

function unavailableBootstrap(): ClientBootstrap {
  return {
    contractVersion: CLIENT_CONTRACT_VERSION,
    authority: { authorityId: "desktop-unavailable" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
    runtime: { status: "unavailable", classification: "unavailable" },
    surface: { terminalAttach: false, fileReveal: false, previewInput: false, openExternal: false },
    capabilityManifest: { profile: "limited", generatedAt: "1970-01-01T00:00:00.000Z", hash: "unavailable", capabilities: [] },
    commandManifestHash: "unavailable",
    selected: {},
  };
}

function asError(cause: unknown): ClientError {
  const value = cause as { code?: unknown; message?: unknown } | null;
  if (value && typeof value.code === "string" && typeof value.message === "string") {
    return { code: value.code as ClientError["code"], message: value.message };
  }
  return {
    code: "TRANSPORT_ERROR",
    message: cause instanceof Error && cause.message ? cause.message : "Unknown client error",
  };
}

/** Session preferences apply on the next user turn; they must not wait for abort/prompt receipts. */
const LIVE_SESSION_PREFERENCE_COMMANDS = new Set<CommandName>([
  "session.model.set",
  "session.thinking.set",
  "mode.plan.enter",
  "mode.plan.exit",
  "mode.vibe.enter",
  "mode.vibe.exit",
  "goal.create",
  "goal.drop",
  "loop.enable",
  "loop.disable",
  "session.fast.set",
  "session.prewalk.arm",
  "session.prewalk.disarm",
  "permissions.mode.set",
]);

function isLiveSessionPreferenceCommand(name: CommandName): boolean {
  return LIVE_SESSION_PREFERENCE_COMMANDS.has(name);
}

function snapshotFrom(state: ViewState): OperatorStateSnapshot | undefined {
  if (state.clientState !== undefined) {
    return state.clientState.entities.snapshot ?? undefined;
  }
  return state.bootstrap && "snapshot" in state.bootstrap ? state.bootstrap.snapshot : state.model.home?.snapshot;
}

const SLASH_UI_INTENT_KEY = "omp.slashUiIntent";

function setSlashUiIntent(ui: SlashNativeUi): void {
  try {
    sessionStorage.setItem(SLASH_UI_INTENT_KEY, ui);
  } catch {
    /* sessionStorage may be blocked */
  }
}

function takeSlashUiIntent(): SlashNativeUi | undefined {
  try {
    const raw = sessionStorage.getItem(SLASH_UI_INTENT_KEY);
    if (raw === null) return undefined;
    sessionStorage.removeItem(SLASH_UI_INTENT_KEY);
    return raw as SlashNativeUi;
  } catch {
    return undefined;
  }
}

async function resyncRuntimeModel(client: ClientStateSource): Promise<Model> {
  const results = await Promise.allSettled([
    client.query("capabilities.get", {}),
    client.query("commands.getManifest", {}),
    client.query("projects.list", {}),
    client.query("history.list", { limit: 20, status: "active" }),
  ]);
  const [capabilities, commandManifest, workspaces, history] = results;
  return {
    ...(capabilities.status === "fulfilled" ? { capabilities: capabilities.value } : {}),
    ...(commandManifest.status === "fulfilled" ? { commandManifest: commandManifest.value } : {}),
    ...(workspaces.status === "fulfilled" ? { workspaces: workspaces.value } : {}),
    ...(history.status === "fulfilled" ? { history: history.value } : {}),
  };
}

function chipTone(value: string): "green" | "amber" | "red" {
  if (value.includes("connected") || value === "managed" || value === "completed") return "green";
  if (value.includes("reject") || value.includes("failed") || value === "error") return "red";
  return "amber";
}

function Chip({ children }: { children: ReactNode }) {
  return <span className={`chip ${chipTone(String(children))}`}>{children}</span>;
}

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

/** Host marker for a blocked `git switch`; message lines after it are `path[ TAB +N TAB -N ]`. */
const SWITCH_BLOCKED_HEADER = "Local changes would be overwritten by checkout";
interface SwitchBlockedFile {
  readonly path: string;
  readonly insertions?: number;
  readonly deletions?: number;
}
function switchBlockedFilesOf(error: unknown): SwitchBlockedFile[] | undefined {
  const message = hostErrorMessage(error, "");
  if (!message.startsWith(SWITCH_BLOCKED_HEADER)) return undefined;
  const files: SwitchBlockedFile[] = [];
  for (const line of message.split("\n").slice(1)) {
    const parts = line.trim().split("\t");
    const path = parts[0] ?? "";
    if (!path) continue;
    const insertions = parts.length === 3 ? Number(parts[1]) : Number.NaN;
    const deletions = parts.length === 3 ? Number(parts[2]) : Number.NaN;
    files.push({
      path,
      ...(Number.isFinite(insertions) && Number.isFinite(deletions) ? { insertions, deletions } : {}),
    });
  }
  return files.length > 0 ? files : undefined;
}

function runtimeStatusLabel(runtime?: ClientBootstrap["runtime"]): { text: string; tone: "ok" | "warn" | "err" } {
  const status = runtime?.status ?? "unavailable";
  if (status === "connected") return { text: "OMP Ready", tone: "ok" };
  if (status === "unavailable") return { text: "OMP Unavailable", tone: "err" };
  return { text: `OMP ${status}`, tone: "warn" };
}

type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
type ShellDialog = "about" | "shortcuts";
type WorkspaceCreationKind = "file" | "directory";
type ArchivePending =
  | { kind: "preview"; threadId: string; title: string; streaming: boolean }
  | { kind: "real"; entry: SessionHistoryEntry; streaming: boolean };

function archiveConfirmIsStreaming(
  pending: ArchivePending,
  live: { readonly sessionId?: string; readonly isStreaming?: boolean } | undefined,
): boolean {
  if (pending.streaming) return true;
  if (pending.kind !== "real") return false;
  return pending.entry.sessionId !== undefined
    && pending.entry.sessionId === live?.sessionId
    && live.isStreaming === true;
}

function execEditCommand(command: EditCommand): void {
  try {
    document.execCommand(command);
  } catch {
    /* Chromium may reject an unsupported edit command; the focused field is unchanged. */
  }
}

function TitleMenu({ id, label, openId, onToggle, children }: {
  id: string;
  label: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  children: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 2, left: rect.left });
  }, [open]);

  return (
    <div className={`title-menu${open ? " open" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className="title-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              className="menu title-menu-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MenuItem({ icon, children, hint, kbd, disabled, title, current, onClick }: {
  icon?: string;
  children: ReactNode;
  hint?: string;
  /** 右侧快捷键徽标；只标注当前真实存在的快捷键（aria-hidden 避免读屏重复播报）。 */
  kbd?: string;
  disabled?: boolean;
  title?: string;
  current?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      disabled={disabled}
      data-tip={title}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} extra="sm" /> : null}
      <span>{children}</span>
      {hint ? <span className="hint">{hint}</span> : null}
      {kbd ? <span className="kbd" aria-hidden="true">{kbd}</span> : null}
    </button>
  );
}

/** 左上应用菜单（ver1 sb-top 汉堡按钮）：本地命令入口聚合，各项复用既有表面，
 * 不引入新的 Host 能力；无后端的项按惯例禁用并给出原因。 */
export function AppMenu({ chrome, onRoute }: {
  chrome: ShellChrome;
  onRoute: (route: Route) => void;
}) {
  const { preview } = usePreviewMode();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const run = (action?: () => void) => {
    setOpen(false);
    action?.();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menu = menuRef.current;
      const pad = 8;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (menu) {
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - width - pad);
        if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
      }
      setPos({ top, left });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 项目 shell 两项的禁用条件与顶栏面包屑菜单一致：无真实 workspace / 非桌面端 / 动作进行中。
  const shellItemProps = (kind: "editor" | "directory") => chrome.projectShellUnavailable !== undefined
    ? { disabled: true, title: chrome.projectShellUnavailable }
    : chrome.projectShellAction !== null
      ? { disabled: true, ...(chrome.projectShellAction === kind ? { title: "正在打开…" } : {}) }
      : {};

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        data-tip="菜单"
        aria-label="应用菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="menu" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu app-menu-popover"
              role="menu"
              aria-label="应用菜单"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="menu-label">全局操作</div>
              <MenuItem icon="plus" kbd="Ctrl ⇧ O" onClick={() => run(chrome.onStartNewChat)}>新建对话</MenuItem>
              <MenuItem
                icon="folder-open"
                {...(preview
                  ? { disabled: true, title: "预览模式下不可用" }
                  : { onClick: () => run(chrome.onPickProject) })}
              >打开本地项目…</MenuItem>
              <MenuItem icon="branch" disabled title="克隆（暂未实现）">克隆 Git 仓库…</MenuItem>
              <MenuItem icon="flask" disabled title="临时工作区（暂未实现）">创建临时工作区</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="plus" onClick={() => run(chrome.onCreateProject)}>新建项目</MenuItem>
              <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>首页</MenuItem>
              <MenuItem icon="history" onClick={() => run(() => onRoute("history"))}>打开会话历史</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="search" kbd="Ctrl K" onClick={() => run(chrome.onOpenPalette)}>全局搜索</MenuItem>
              <MenuItem icon="terminal" kbd="Ctrl J" onClick={() => run(chrome.onOpenTerminalPanel)}>打开终端</MenuItem>
              <MenuItem icon="external" {...shellItemProps("editor")} onClick={() => run(chrome.onOpenProjectInEditor)}>在外部编辑器中打开项目</MenuItem>
              <MenuItem icon="folder" {...shellItemProps("directory")} onClick={() => run(chrome.onOpenProjectDirectory)}>打开系统文件管理器</MenuItem>
              <MenuItem icon="server" hint="供应商 · 角色" onClick={() => run(() => onRoute("model-config"))}>模型配置</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="settings" onClick={() => run(() => onRoute("settings"))}>设置</MenuItem>
              <MenuItem icon="keyboard" onClick={() => run(() => chrome.onOpenDialog("shortcuts"))}>快捷键</MenuItem>
              <MenuItem icon="info" onClick={() => run(() => chrome.onOpenDialog("about"))}>关于 OMP Studio</MenuItem>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function CrumbMenu({ id, openId, onToggle, tip, current, children, menu }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  tip: string;
  current?: boolean;
  children: ReactNode;
  menu: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 4, left: rect.left });
  }, [open]);

  return (
    <div className="crumb-menu" onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`crumb-item${current ? " crumb-current" : ""}${open ? " open" : ""}`}
        data-tip={tip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              className="menu title-menu-popover crumb-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {menu}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function AnchoredPop({ id, openId, onToggle, tip, label, align = "start", triggerClassName, popoverClassName, children, panel }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  tip: string;
  label: string;
  align?: "start" | "end";
  triggerClassName: string;
  popoverClassName?: string;
  children: ReactNode;
  panel: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = popRef.current?.offsetWidth ?? (align === "end" ? 360 : 240);
    const left = align === "end"
      ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor({ top: rect.bottom + 4, left });
  }, [align, open]);

  return (
    <div className="anchored-pop" onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`${triggerClassName}${open ? " open" : ""}`}
        data-tip={tip}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className={`menu title-menu-popover${popoverClassName ? ` ${popoverClassName}` : ""}`}
              role="dialog"
              aria-label={label}
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {panel}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function Titlebar({
  canBack,
  canForward,
  onBack,
  onForward,
  onToggleSidebar,
  sidebarCollapsed,
  menus,
}: {
  canBack?: boolean;
  canForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  menus?: ReactNode;
}) {
  const previewMode = usePreviewMode();
  return (
    <header className="app-titlebar">
      <button
        className="icon-btn"
        data-tip={sidebarCollapsed ? "展开" : "收起"}
        aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        aria-expanded={sidebarCollapsed === false}
        disabled={!onToggleSidebar}
        onClick={onToggleSidebar}
      >
        <Icon name="layout" />
      </button>
      <button className="icon-btn" data-tip="后退" aria-label="后退" disabled={!canBack} onClick={onBack}>
        <Icon name="arrow-l" />
      </button>
      <button className="icon-btn" data-tip="前进" aria-label="前进" disabled={!canForward} onClick={onForward}>
        <Icon name="arrow-r" />
      </button>
      <nav className="title-menus" aria-label="应用菜单">{menus}</nav>
      <div className="titlebar-end">
        <PreviewSwitch
          enabled={previewMode.enabled}
          preview={previewMode.preview}
          onToggle={() => {
            if (modelConfigHasUnsavedChanges() && !window.confirm("有未保存的模型配置更改，切换预览会丢弃草稿。确定继续？")) return;
            previewMode.setPreview(!previewMode.preview);
          }}
        />
      </div>
    </header>
  );
}

export function Unavailable() {
  return (
    <PreviewModeProvider>
      <div className="app">
        <Titlebar />
        <div className="main-col">
          <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
            <Icon name="alert" extra="lg" />
            <h1>Studio client unavailable</h1>
            <p className="muted">Inject a StudioClient through the desktop shell or WebUI bridge.</p>
          </div>
        </div>
      </div>
      <StartupNotice />
    </PreviewModeProvider>
  );
}

function Deferred({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <Icon name="info" extra="lg" />
      <p>{title}</p>
      <p className="muted small">{detail}</p>
    </div>
  );
}

function GenericCommandForm({ manifest, busy, enabled, onInvoke }: { manifest: OperatorCommandManifest; busy: boolean; enabled: boolean; onInvoke: (commandId: string, args?: unknown) => void }) {
  const [selected, setSelected] = useState("");
  const [args, setArgs] = useState("{}");
  const command = manifest.commands.find((entry) => entry.id === selected);
  return (
    <div className="generic-command">
      <div className="panel-head"><div><h2>Command form</h2><p className="muted">Manifest-driven operator entry; capability and Host validate the mutation.</p></div></div>
      <div className="actions">
        <select className="select" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Select command</option>
          {manifest.commands.filter((entry) => entry.presentation === "generic-form" && entry.availability === "available").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <input className="input" value={args} onChange={(event) => setArgs(event.target.value)} aria-label="Command arguments JSON" placeholder="{}" />
        <button className="btn primary" disabled={!command || !enabled || busy} onClick={() => { try { onInvoke(command!.id, JSON.parse(args)); } catch { /* malformed JSON stays local */ } }}>Invoke</button>
      </div>
    </div>
  );
}

function VirtualEventTranscript({ events }: { events: readonly ShellEventLogEntry[] }) {
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 32;
  const viewportHeight = 224;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const visible = events.slice(start, start + Math.ceil(viewportHeight / rowHeight) + 6);
  return (
    <div className="event-transcript" style={{ height: viewportHeight }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div style={{ height: events.length * rowHeight, position: "relative" }}>
        {visible.map((event, index) => {
          const actual = start + index;
          return <div className="event-row" key={`${event.cursor}-${event.kind}`} style={{ transform: `translateY(${actual * rowHeight}px)` }}><span className="mono event-cursor">{event.cursor}</span><span>{event.kind}</span><span className="muted">{event.occurredAt}</span></div>;
        })}
      </div>
    </div>
  );
}

const CURRENT_PROJECT = { id: "omp-studio", name: "OMP Studio" } as const;

type SelectedProject = { readonly id: string; readonly name: string };

/* 项目会话列表分页：默认 6 条，「展开更多」每次追加 10 条；
   QUERY_MAX 对齐 Host 侧 history.list 的上限（HISTORY_MAX_LIMIT = 200）。 */
const PROJECT_THREADS_INITIAL = 6;
const PROJECT_THREADS_PAGE = 10;
const PROJECT_THREADS_QUERY_MAX = 200;

/* 底栏高度：默认对齐 tokens.css --bottom-panel-h；夹取对齐 ver1 工作台 120–480。 */
const BOTTOM_PANEL_DEFAULT = 240;
const BOTTOM_PANEL_MIN = 120;
const BOTTOM_PANEL_MAX = 480;

function clampBottomHeight(px: number): number {
  if (!Number.isFinite(px)) return BOTTOM_PANEL_DEFAULT;
  return Math.min(BOTTOM_PANEL_MAX, Math.max(BOTTOM_PANEL_MIN, Math.round(px)));
}

type ShellChrome = {
  collapsed: boolean;
  skillsOpen: boolean;
  explorerOpen: boolean;
  /** 当前选中项目的会话列表是否展开（项目头 chevron 可收起，ver1/ver2 语义）。 */
  projectListExpanded: boolean;
  theme: "light" | "dark";
  sidebarWidth: number;
  splitRatio: number;
  selectedHistoryId: string | null;
  selectedProject: SelectedProject | null;
  skillsEnabledCount: number;
  previewProjectId: string;
  previewThreadId: string;
  /** PreviewDeck 当前卡（t3）对应的侧栏胶囊；undefined = 队列已空。 */
  previewDeckWait?: ThreadWaitKind;
  onToggleSidebar: () => void;
  onToggleSkills: () => void;
  onSkillsEnabledCount: (count: number) => void;
  onToggleExplorer: () => void;
  onToggleTheme: () => void;
  onResizeSidebar: (width: number) => void;
  onResizeSplit: (ratio: number) => void;
  onSelectProject: (project: SelectedProject) => void;
  /** 项目头点击：已展开的项目收起会话列表（保持选中），否则选中并展开。 */
  onToggleProject: (project: SelectedProject) => void;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  onSelectPreviewProject: (id: string) => void;
  onSelectPreviewThread: (id: string) => void;
  onPickProject: () => void;
  /** 左上应用菜单「新建项目」：打开工作台已有的创建项目对话框。 */
  onCreateProject: () => void;
  onStartNewChat: () => void;
  /** 项目行悬停「＋」：切换到该项目（必要时 workspace.open）并新建会话。 */
  onStartChatInProject: (project: SelectedProject) => void;
  /** 会话行悬停「归档」：打开确认弹窗；确认后仅预览模式本地隐藏。 */
  onArchivePreviewThread: (threadId: string) => void;
  /** 真实模式「归档」：打开确认弹窗；确认后 session.archive，会话物理移入 OMP 冷归档（gzip）。 */
  onArchiveThread: (entry: SessionHistoryEntry) => void;
  /** 历史页「取消归档」：session.unarchive，恢复到进行中列表。 */
  onUnarchiveThread: (entry: SessionHistoryEntry) => void;
  /** 顶栏「对话选项」：打开重命名对话框（builtin.rename，标题持久化到会话槽）。 */
  onRenameThread: () => void;
  /** 顶栏「对话选项」：Fork 当前会话（session.fork，Runtime 身份切换）。 */
  onForkThread: () => void;
  /** 顶栏「对话选项」：Handoff 到新会话（session.handoff，LLM 摘要 + 新会话）。 */
  onHandoffThread: () => void;
  /** 顶栏「对话选项」：Compact 当前上下文（builtin.compact，默认模式）。 */
  onCompactThread: () => void;
  /** 用户已点 Compact / 输入 /compact，命令尚未结束。 */
  compactPending: boolean;
  /** 顶栏「对话选项」：导出对话 HTML（builtin.export，路径来自命令输出）。 */
  onExportThread: () => void;
  /** 顶栏「归档」的目标会话；undefined = 不可用（原因见 archiveTargetReason）。 */
  archiveTarget: SessionHistoryEntry | undefined;
  archiveTargetReason: string | undefined;
  /** 驻留 Runtime 正在使用的 sessionId；归档该会话时 Host 会先停止再移走文件。 */
  residentSessionId: string | undefined;
  /** 「展开更多」：该项目已展开的会话数 +10，必要时重查 history.list。 */
  onLoadMoreThreads: (projectId: string) => void;
  /** 各项目当前展开的会话条数（缺省 = PROJECT_THREADS_INITIAL）。 */
  projectThreadLimits: Record<string, number>;
  /** 预览模式被「归档」隐藏的演示会话 id。 */
  hiddenPreviewThreads: ReadonlySet<string>;
  onOpenCapabilities: (tab?: CapTab, name?: string) => void;
  onOpenPalette: () => void;
  paletteOpen: boolean;
  onToggleOmpMenu: () => void;
  ompMenuOpen: boolean;
  /** 左上应用菜单：打开 shortcuts / about 对话框。 */
  onOpenDialog: (dialog: ShellDialog) => void;
  /** 左上应用菜单「打开终端」：切到终端页签并展开底部面板（Ctrl J 同款语义）。 */
  onOpenTerminalPanel: () => void;
  /** 项目 shell 动作（AppShell 统一实现，顶栏面包屑菜单与侧栏应用菜单共用）。 */
  onOpenProjectInEditor: () => void;
  onOpenProjectDirectory: () => void;
  /** undefined = 可用；否则为禁用原因（无真实 workspace / 非桌面端）。 */
  projectShellUnavailable: string | undefined;
  /** 进行中的 shell 动作类型；null = 空闲。 */
  projectShellAction: "editor" | "directory" | null;
  onAddComposerContext: (chip: { kind: "file" | "dir"; path: string; label: string }) => void;
  onInsertSkill: (skill: { name: string; desc?: string }) => void;
  onRemoveComposerSkill: (name: string) => void;
  draftSkills: ReadonlySet<string>;
  usedSkills: ReadonlySet<string>;
};

type ProjectShellActionResult =
  | { readonly status: "opened"; readonly editorName?: string }
  | { readonly status: "cancelled" };

function filterWorkspaceNodes(nodes: ReadonlyArray<WorkspaceFileNode>, query: string): ReadonlyArray<WorkspaceFileNode> {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    const children = node.children ? filterWorkspaceNodes(node.children, query) : [];
    return node.name.toLowerCase().includes(needle) || children.length > 0
      ? [{ ...node, ...(node.type === "dir" ? { children } : {}) }]
      : [];
  });
}

function formatDiffCount(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function findWorkspaceNode(nodes: ReadonlyArray<WorkspaceFileNode>, path: string): WorkspaceFileNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = node.children ? findWorkspaceNode(node.children, path) : undefined;
    if (found) return found;
  }
  return undefined;
}

function replaceWorkspaceChildren(nodes: ReadonlyArray<WorkspaceFileNode>, path: string, children: ReadonlyArray<WorkspaceFileNode>): ReadonlyArray<WorkspaceFileNode> {
  return nodes.map((node) => {
    if (node.path === path) return { ...node, children };
    return node.children ? { ...node, children: replaceWorkspaceChildren(node.children, path, children) } : node;
  });
}

type VisibleWorkspaceNode = {
  readonly node: WorkspaceFileNode;
  readonly parentPath?: string;
};

function flattenVisibleWorkspaceNodes(
  nodes: ReadonlyArray<WorkspaceFileNode>,
  expanded: ReadonlySet<string>,
  parentPath?: string,
): ReadonlyArray<VisibleWorkspaceNode> {
  const visible: VisibleWorkspaceNode[] = [];
  for (const node of nodes) {
    visible.push({ node, ...(parentPath ? { parentPath } : {}) });
    if (node.type === "dir" && expanded.has(node.path) && node.children) {
      visible.push(...flattenVisibleWorkspaceNodes(node.children, expanded, node.path));
    }
  }
  return visible;
}

function expandedWorkspacePathsForSearch(nodes: ReadonlyArray<WorkspaceFileNode>, expanded: ReadonlySet<string>, search: string): Set<string> {
  const next = new Set(expanded);
  if (!search.trim()) return next;
  const visit = (items: ReadonlyArray<WorkspaceFileNode>): void => {
    for (const item of items) {
      if (item.type === "dir" && item.children && item.children.length > 0) {
        next.add(item.path);
        visit(item.children);
      }
    }
  };
  visit(nodes);
  return next;
}

/** Explorer 行内 git 状态徽章：行尾彩色字母 + 文件名着色双通道，目录显示聚合后的后代状态。 */
function GitTreeBadge({ status }: { status?: TreeGitStatus | undefined }) {
  if (status === undefined) return null;
  const meta = GIT_STATUS_META[status];
  return (
    <span className={`fstat ${meta.className}`}>
      <span aria-hidden="true">{meta.letter}</span>
      <span className="sr-only"> {meta.label}</span>
    </span>
  );
}

/** Agent 正在读/写该路径时才出现；平时不占位。红 = Read，绿 = Write/Edit。 */
function TreeLiveDots({ reading, writing }: { reading: boolean; writing: boolean }) {
  if (!reading && !writing) return null;
  return (
    <span className="live">
      {reading ? <span className="dot red pulse" role="img" aria-label="读取中" data-tip="读取中" /> : null}
      {writing ? <span className="dot green pulse" role="img" aria-label="写入中" data-tip="写入中" /> : null}
    </span>
  );
}

function WorkspaceTreeNodes({
  nodes,
  depth,
  parentPath,
  expanded,
  loadingPaths,
  activePath,
  registerNode,
  createKind,
  createParentPath,
  createName,
  createBusy,
  createError,
  createInputRef,
  onCreateNameChange,
  onCreateSubmit,
  onCreateCancel,
  onSelect,
  onKeyDown,
  onToggle,
  onFile,
  onContext,
  onMore,
  gitStatus,
  fileActivity = EMPTY_EXPLORER_FILE_ACTIVITY,
}: {
  nodes: ReadonlyArray<WorkspaceFileNode>;
  depth: number;
  parentPath?: string;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  activePath: string | null;
  registerNode: (path: string, element: HTMLDivElement | null) => void;
  createKind: WorkspaceCreationKind | null;
  createParentPath: string | undefined;
  createName: string;
  createBusy: boolean;
  createError: string | undefined;
  createInputRef: { current: HTMLInputElement | null };
  onCreateNameChange: (value: string) => void;
  onCreateSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  onCreateCancel: () => void;
  onSelect: (path: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, node: WorkspaceFileNode, parentPath?: string) => void;
  onToggle: (path: string) => void;
  onFile: (path: string) => void;
  onContext: (path: string, kind: "file" | "dir") => void;
  onMore: (path: string) => void;
  gitStatus?: ReadonlyMap<string, TreeGitStatus> | undefined;
  fileActivity?: ExplorerFileActivity;
}) {
  const showCreate = createKind !== null && createParentPath === parentPath;
  const createPad = { ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties;
  useEffect(() => {
    if (!showCreate) return;
    const input = createInputRef.current;
    input?.focus();
    input?.scrollIntoView?.({ block: "nearest" });
  }, [createInputRef, createParentPath, showCreate]);
  return <>
    {nodes.map((node, index) => {
      const pad = { ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties;
      const gitStat = gitStatus?.get(node.path);
      const gitClass = gitStat === undefined ? undefined : GIT_STATUS_META[gitStat].className;
      const live = explorerRowActivity(node.path, node.type === "dir", fileActivity);
      if (node.type === "dir") {
        const open = expanded.has(node.path);
        return <div key={node.path}>
          <div
            ref={(element) => registerNode(node.path, element)}
            className={`tree-row${open ? " open" : ""}`}
            data-dir={node.path}
            data-git={gitClass}
            role="treeitem"
            aria-expanded={open}
            aria-selected={activePath === node.path}
            aria-busy={loadingPaths.has(node.path) || undefined}
            aria-level={depth + 1}
            aria-posinset={index + 1}
            aria-setsize={nodes.length}
            aria-label={`${node.name} 文件夹`}
            tabIndex={activePath === node.path ? 0 : -1}
            style={pad}
            onFocus={() => onSelect(node.path)}
            onClick={() => { onSelect(node.path); onToggle(node.path); }}
            onKeyDown={(event) => onKeyDown(event, node, parentPath)}
          >
            <span className="tw"><Icon name="chevron-r" extra="sm" /></span>
            <span className="fi"><Icon name={open ? "folder-open" : "folder"} /></span>
            <span className="fname ellipsis">{node.name}</span>
            <TreeLiveDots reading={live.reading} writing={live.writing} />
            <GitTreeBadge status={gitStat} />
            <span className="fop">
              <button type="button" className="icon-btn" data-tip="@" aria-label={`加入上下文 ${node.path}`} onClick={(event) => { event.stopPropagation(); onContext(node.path, "dir"); }}><Icon name="at" /></button>
              <button type="button" className="icon-btn" data-tip="更多" aria-label={`更多操作 ${node.path}`} onClick={(event) => { event.stopPropagation(); onMore(node.path); }}><Icon name="more" /></button>
            </span>
          </div>
          <div className="tree-children" role="group">
            {loadingPaths.has(node.path) ? (
              <div className="tree-row muted" style={{ ["--depth-pad" as string]: `${(depth + 1) * 14 + 6}px` } as CSSProperties} role="status">
                <span className="tw" />
                <span className="fi"><span className="spinner" aria-hidden="true" /></span>
                <span className="fname ellipsis">正在读取…</span>
              </div>
            ) : node.children ? <WorkspaceTreeNodes nodes={node.children} depth={depth + 1} parentPath={node.path} expanded={expanded} loadingPaths={loadingPaths} activePath={activePath} registerNode={registerNode} createKind={createKind} createParentPath={createParentPath} createName={createName} createBusy={createBusy} createError={createError} createInputRef={createInputRef} onCreateNameChange={onCreateNameChange} onCreateSubmit={onCreateSubmit} onCreateCancel={onCreateCancel} onSelect={onSelect} onKeyDown={onKeyDown} onToggle={onToggle} onFile={onFile} onContext={onContext} onMore={onMore} fileActivity={fileActivity} {...(gitStatus !== undefined ? { gitStatus } : {})} /> : null}
          </div>
        </div>;
      }
      const code = node.name.endsWith(".tsx") || node.name.endsWith(".ts");
      return <div
        ref={(element) => registerNode(node.path, element)}
        key={node.path}
        className="tree-row"
        data-file={node.path}
        data-git={gitClass}
        role="treeitem"
        aria-selected={activePath === node.path}
        aria-level={depth + 1}
        aria-posinset={index + 1}
        aria-setsize={nodes.length}
        tabIndex={activePath === node.path ? 0 : -1}
        style={pad}
        onFocus={() => onSelect(node.path)}
        onClick={() => { onSelect(node.path); onFile(node.path); }}
        onKeyDown={(event) => onKeyDown(event, node, parentPath)}
      >
        <span className="tw" />
        <span className="fi"><Icon name={code ? "file-code" : "file"} /></span>
        <span className="fname ellipsis">{node.name}</span>
        <TreeLiveDots reading={live.reading} writing={live.writing} />
        <GitTreeBadge status={gitStat} />
        <span className="fop">
          <button type="button" className="icon-btn" data-tip="@" aria-label={`加入上下文 ${node.path}`} onClick={(event) => { event.stopPropagation(); onContext(node.path, "file"); }}><Icon name="at" /></button>
          <button type="button" className="icon-btn" data-tip="更多" aria-label={`更多操作 ${node.path}`} onClick={(event) => { event.stopPropagation(); onMore(node.path); }}><Icon name="more" /></button>
        </span>
      </div>;
    })}
    {showCreate ? (
      <>
        <form className="tree-new-row" style={createPad} onSubmit={onCreateSubmit}>
          <span className="tw" />
          <span className="fi"><Icon name={createKind === "file" ? "file" : "folder"} /></span>
          <input
            ref={(element) => { createInputRef.current = element; }}
            className="input"
            value={createName}
            onChange={(event) => onCreateNameChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCreateCancel(); } }}
            placeholder={createKind === "file" ? "文件名（含后缀）" : "文件夹名"}
            aria-label={createKind === "file" ? "新建文件名" : "新建文件夹名"}
            disabled={createBusy}
            autoFocus
          />
          <button type="submit" className="icon-btn" data-tip="创建" aria-label="创建" disabled={createBusy}><Icon name="check" extra="sm" /></button>
          <button type="button" className="icon-btn" data-tip="取消" aria-label="取消" disabled={createBusy} onClick={onCreateCancel}><Icon name="x" extra="sm" /></button>
        </form>
        {createBusy ? <div className="tree-new-status muted tiny" style={createPad} role="status">正在创建…</div> : null}
        {createError ? <div className="tree-new-status error tiny" style={createPad} role="alert">{createError}</div> : null}
      </>
    ) : null}
  </>;
}

export function RealFileTree({ client, workspaceId, label, refreshToken, search, gitStatus, fileActivity = EMPTY_EXPLORER_FILE_ACTIVITY, createKind, createParentPath, createName, createBusy, createError, createInputRef, onCreateNameChange, onCreateSubmit, onCreateCancel, onSelectionChange, onAddContext }: {
  client: StudioClient;
  workspaceId: WorkspaceId;
  label: string;
  refreshToken: number;
  search: string;
  gitStatus?: ReadonlyMap<string, TreeGitStatus> | undefined;
  fileActivity?: ExplorerFileActivity;
  createKind: WorkspaceCreationKind | null;
  createParentPath: string | undefined;
  createName: string;
  createBusy: boolean;
  createError: string | undefined;
  createInputRef: { current: HTMLInputElement | null };
  onCreateNameChange: (value: string) => void;
  onCreateSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  onCreateCancel: () => void;
  onSelectionChange?: (node: WorkspaceFileNode | undefined) => void;
  onAddContext?: (path: string, kind: "file" | "dir") => void;
}) {
  const [model, setModel] = useState<WorkspaceFileTreeReadModel | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const expandedRef = useRef(new Set<string>());
  const loadingPathsRef = useRef(new Set<string>());
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const typeaheadRef = useRef<{ value: string; timeout?: ReturnType<typeof setTimeout> }>({ value: "" });
  const generationRef = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const next = await client.query("workspace.fileTree", { workspaceId });
      if (generation !== generationRef.current) return;
      setModel(next);
      expandedRef.current = new Set();
      setExpanded(expandedRef.current);
      setActivePath(next.nodes[0]?.path ?? null);
      onSelectionChange?.(undefined);
      loadingPathsRef.current.clear();
      setLoadingPaths(new Set());
      setMessage(undefined);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setModel(null);
      setMessage(hostErrorMessage(error, "文件树加载失败"));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client, onSelectionChange, workspaceId]);
  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  const visible = useMemo(() => filterWorkspaceNodes(model?.nodes ?? [], search), [model?.nodes, search]);
  const displayExpanded = useMemo(() => expandedWorkspacePathsForSearch(visible, expanded, search), [expanded, search, visible]);
  const visibleItems = useMemo(() => flattenVisibleWorkspaceNodes(visible, displayExpanded), [displayExpanded, visible]);
  useEffect(() => {
    if (activePath === null || visibleItems.some(({ node }) => node.path === activePath)) return;
    setActivePath(visibleItems[0]?.node.path ?? null);
  }, [activePath, visibleItems]);
  useEffect(() => () => {
    if (typeaheadRef.current.timeout !== undefined) clearTimeout(typeaheadRef.current.timeout);
  }, []);
  const loadDirectory = useCallback(async (path: string) => {
    if (loadingPathsRef.current.has(path)) return;
    const generation = generationRef.current;
    loadingPathsRef.current.add(path);
    setLoadingPaths(new Set(loadingPathsRef.current));
    try {
      const next = await client.query("workspace.fileTree", { workspaceId, path });
      if (generation !== generationRef.current) return;
      setModel((current) => current === null ? current : { ...current, nodes: replaceWorkspaceChildren(current.nodes, path, next.nodes) });
      setMessage(undefined);
    } catch (error) {
      if (generation === generationRef.current) {
        const next = new Set(expandedRef.current);
        next.delete(path);
        expandedRef.current = next;
        setExpanded(next);
        setMessage(hostErrorMessage(error, `无法展开 ${path}`));
      }
    } finally {
      loadingPathsRef.current.delete(path);
      if (generation === generationRef.current) setLoadingPaths(new Set(loadingPathsRef.current));
    }
  }, [client, workspaceId]);
  useEffect(() => {
    if (createKind === null || createParentPath === undefined || model === null) return;
    const target = findWorkspaceNode(model.nodes, createParentPath);
    if (target?.type !== "dir") return;
    if (!expandedRef.current.has(createParentPath)) {
      const next = new Set(expandedRef.current);
      next.add(createParentPath);
      expandedRef.current = next;
      setExpanded(next);
    }
    if (target.children === undefined) void loadDirectory(createParentPath);
  }, [createKind, createParentPath, loadDirectory, model]);
  const toggle = useCallback((path: string) => {
    const open = expandedRef.current.has(path);
    const next = new Set(expandedRef.current);
    if (open) next.delete(path); else next.add(path);
    expandedRef.current = next;
    setExpanded(next);
    if (!open && model && findWorkspaceNode(model.nodes, path)?.children === undefined) void loadDirectory(path);
  }, [loadDirectory, model]);
  const registerNode = useCallback((path: string, element: HTMLDivElement | null) => {
    if (element) nodeRefs.current.set(path, element);
    else nodeRefs.current.delete(path);
  }, []);
  const focusNode = useCallback((path: string) => {
    setActivePath(path);
    nodeRefs.current.get(path)?.focus();
  }, []);
  const openFile = useCallback((path: string) => {
    setActivePath(path);
    setMessage(`打开 ${path}`);
  }, []);
  const selectPath = useCallback((path: string) => {
    setActivePath(path);
    const node = model === null ? undefined : findWorkspaceNode(model.nodes, path);
    onSelectionChange?.(node);
  }, [model, onSelectionChange]);
  const clearBlankSelection = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[role=\"treeitem\"], form, input, button")) return;
    setActivePath(null);
    onSelectionChange?.(undefined);
  }, [onSelectionChange]);
  const handleTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, node: WorkspaceFileNode, parentPath?: string) => {
    if (event.target !== event.currentTarget) return;
    const index = visibleItems.findIndex((item) => item.node.path === node.path);
    if (index < 0) return;
    const focusAt = (nextIndex: number): void => {
      const item = visibleItems[nextIndex];
      if (item) focusNode(item.node.path);
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(Math.min(visibleItems.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusAt(visibleItems.length - 1);
      return;
    }
    if (event.key === "ArrowRight" && node.type === "dir") {
      event.preventDefault();
      if (!displayExpanded.has(node.path)) toggle(node.path);
      else focusAt(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.type === "dir" && displayExpanded.has(node.path) && !search.trim()) toggle(node.path);
      else if (parentPath) focusNode(parentPath);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (node.type === "dir") toggle(node.path);
      else openFile(node.path);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return;
    const typed = event.key.toLocaleLowerCase();
    const previous = typeaheadRef.current.value;
    const findMatch = (needle: string): VisibleWorkspaceNode | undefined => {
      for (let offset = 1; offset <= visibleItems.length; offset += 1) {
        const candidate = visibleItems[(index + offset) % visibleItems.length];
        if (candidate?.node.name.toLocaleLowerCase().startsWith(needle)) return candidate;
      }
      return undefined;
    };
    let value = `${previous}${typed}`;
    let match = findMatch(value);
    if (!match && previous) {
      value = typed;
      match = findMatch(value);
    }
    if (!match) return;
    event.preventDefault();
    if (typeaheadRef.current.timeout !== undefined) clearTimeout(typeaheadRef.current.timeout);
    typeaheadRef.current.value = value;
    typeaheadRef.current.timeout = setTimeout(() => { typeaheadRef.current.value = ""; }, 700);
    focusNode(match.node.path);
  }, [displayExpanded, focusNode, openFile, search, toggle, visibleItems]);
  if (loading && model === null) return <div className="empty"><p className="muted small">正在读取文件树…</p></div>;
  if (model === null) return <div className="empty"><p className="muted small">{message ?? "文件树不可用"}</p></div>;
  return <>
    {message ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{message}</div> : null}
    <div className="tree" role="tree" aria-label={`${label} 文件树`} onClick={clearBlankSelection}>
      <WorkspaceTreeNodes
        nodes={visible}
        depth={0}
        expanded={displayExpanded}
        loadingPaths={loadingPaths}
        activePath={activePath}
        registerNode={registerNode}
        createKind={createKind}
        createParentPath={createParentPath}
        createName={createName}
        createBusy={createBusy}
        createError={createError}
        createInputRef={createInputRef}
        onCreateNameChange={onCreateNameChange}
        onCreateSubmit={onCreateSubmit}
        onCreateCancel={onCreateCancel}
        onSelect={selectPath}
        onKeyDown={handleTreeKeyDown}
        onToggle={toggle}
        onFile={openFile}
        onContext={(path, kind) => {
          if (onAddContext) {
            onAddContext(path, kind);
            setMessage(`已加入上下文：${path}`);
            return;
          }
          setMessage(`已加入上下文：${path}`);
        }}
        onMore={() => {}}
        gitStatus={gitStatus}
        fileActivity={fileActivity}
      />
    </div>
    <div className="sr-only" aria-live="polite">{loading ? "正在刷新文件树" : ""}</div>
    <span className="sr-only">{model.nodes.length} 个顶层条目</span>
    <span className="sr-only">{`新建文件和目录可通过 Explorer 工具栏完成`}</span>
  </>;
}

function AppSidebar({ state, chrome, client, onRoute }: { state: ViewState; chrome: ShellChrome; client: StudioClient; onRoute: (route: Route) => void }) {
  const sidebarRef = useRef<HTMLElement>(null);
  const ompBtnRef = useRef<HTMLButtonElement>(null);
  const ompMenuRef = useRef<HTMLDivElement>(null);
  const [ompMenuPos, setOmpMenuPos] = useState<{ left: number; bottom?: number; top?: number }>({ left: 0, bottom: 0 });
  const [fileSearch, setFileSearch] = useState("");
  const [fileRefreshToken, setFileRefreshToken] = useState(0);
  const [previewFileMessage, setPreviewFileMessage] = useState<string | undefined>(undefined);
  const [newEntryKind, setNewEntryKind] = useState<WorkspaceCreationKind | null>(null);
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
    setNewEntryPath("");
    setNewEntryError(undefined);
  }, [chrome.selectedProject?.id]);
  const beginWorkspaceEntry = (kind: WorkspaceCreationKind) => {
    if (!chrome.selectedProject || newEntryBusy) return;
    setNewEntryKind(kind);
    setNewEntryPath("");
    setNewEntryParentPath(selectedDirectoryPath);
    setFileSearch("");
    setNewEntryError(undefined);
  };
  const cancelWorkspaceEntry = () => {
    if (newEntryBusy) return;
    setNewEntryKind(null);
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
      setNewEntryError("请输入名称");
      newEntryInputRef.current?.focus();
      return;
    }
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setNewEntryError("这里只能输入单个文件名或文件夹名");
      newEntryInputRef.current?.focus();
      return;
    }
    const kind = newEntryKind;
    const commandName = kind === "file" ? "workspace.file.create" : "workspace.directory.create";
    const path = newEntryParentPath ? `${newEntryParentPath}/${name}` : name;
    setNewEntryBusy(true);
    setNewEntryError(undefined);
    if (preview) {
      setPreviewFileMessage(`演示：已创建${kind === "file" ? "文件" : "文件夹"} ${path}`);
      setNewEntryBusy(false);
      setNewEntryKind(null);
      setNewEntryPath("");
      setNewEntryParentPath(undefined);
      return;
    }
    try {
      const handle = await client.command(commandName, { workspaceId: chrome.selectedProject.id as WorkspaceId, path });
      await waitReceipt(client, handle.requestId);
      setFileRefreshToken((value) => value + 1);
      setNewEntryKind(null);
      setNewEntryPath("");
      setNewEntryParentPath(undefined);
    } catch (error) {
      setNewEntryError(hostErrorMessage(error, `新建${kind === "file" ? "文件" : "文件夹"}失败`));
    } finally {
      setNewEntryBusy(false);
    }
  };
  const runtime = state.clientState?.connection.runtime ?? state.bootstrap?.runtime;
  const history = state.model.history;
  const omp = runtimeStatusLabel(runtime);
  const { preview } = usePreviewMode();
  const liveSnapshot = snapshotFrom(state);
  const pendingInteraction = state.clientState?.interaction.pending ?? null;
  const threadWaitForSession = (sessionId: SessionId | undefined) => waitKindFromLive({
    ...(sessionId === undefined ? {} : { sessionId }),
    pending: pendingInteraction,
    ...(liveSnapshot?.sessionId === undefined ? {} : { snapshotSessionId: liveSnapshot.sessionId }),
    ...(liveSnapshot?.plan?.status === undefined ? {} : { planStatus: liveSnapshot.plan.status }),
  });
  // Explorer git 徽章：真实模式读取选中项目的仓库状态；预览模式的徽章来自 fixtures，不查 Host。
  const gitWorkspaceId = preview || !chrome.selectedProject ? undefined : (chrome.selectedProject.id as WorkspaceId);
  const { repository: gitRepository, refresh: refreshGitRepository } = useGitRepository(client, gitWorkspaceId);
  const gitStatusLookup = useMemo(() => buildGitStatusLookup(gitRepository?.changes ?? []), [gitRepository]);
  const fileActivity = useMemo(
    () => deriveExplorerFileActivity(state.clientState?.conversation.liveTools ?? {}),
    [state.clientState?.conversation.liveTools],
  );
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
  const ompMeta = preview ? "rpc/2.1 · 演示" : (runtime?.classification ?? "unavailable");
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
    const pinDrawer = () => {
      const topBar = sidebar.querySelector(".sb-top");
      const foot = sidebar.querySelector(".sb-footer");
      if (!(topBar instanceof HTMLElement) || !(foot instanceof HTMLElement)) return;
      const box = sidebar.getBoundingClientRect();
      const top = topBar.getBoundingClientRect();
      const bottom = foot.getBoundingClientRect();
      sidebar.style.setProperty("--drawer-top", `${Math.max(0, Math.round(top.bottom - box.top))}px`);
      sidebar.style.setProperty("--drawer-bottom", `${Math.max(0, Math.round(box.bottom - bottom.top))}px`);
    };
    pinDrawer();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(pinDrawer);
    observer?.observe(sidebar);
    window.addEventListener("resize", pinDrawer);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", pinDrawer);
    };
  }, [chrome.skillsOpen, chrome.collapsed, chrome.sidebarWidth]);
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (chrome.collapsed) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const sidebar = handle.closest(".sidebar");
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = chrome.sidebarWidth;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    let latest = startWidth;
    const apply = (width: number) => {
      latest = width;
      if (sidebar instanceof HTMLElement) sidebar.style.width = `${width}px`;
      document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(Math.min(400, Math.max(200, startWidth + next.clientX - startX)));
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
  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!chrome.explorerOpen) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const sidebar = handle.closest(".sidebar");
    if (!(sidebar instanceof HTMLElement)) return;
    const projects = sidebar.querySelector("#sbProjects");
    const files = sidebar.querySelector("#sbFiles");
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
    <aside ref={sidebarRef} className={`sidebar${chrome.collapsed ? " collapsed" : ""}${chrome.explorerOpen ? "" : " explorer-collapsed"}`} id="sidebar" aria-label="项目与文件侧栏" style={{ width: chrome.sidebarWidth }}>
      <div className="sidebar-resizer" id="sbResizer" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度" tabIndex={0} onPointerDown={onResizePointerDown} />
      <div className="sb-top">
        <AppMenu
          chrome={chrome}
          onRoute={onRoute}
        />
        <button className="sb-brand" data-tip="主页" onClick={() => onRoute("home")}>
          <AppIcon className="logo" size={22} />
          <span className="name">OMP Studio</span>
        </button>
        <button
          className="icon-btn"
          data-tip="命令面板"
          data-cmdk-anchor=""
          aria-label="命令面板"
          aria-haspopup="dialog"
          aria-expanded={chrome.paletteOpen}
          {...(chrome.paletteOpen ? { "aria-controls": "cmdkList" } : {})}
          onClick={chrome.onOpenPalette}
        >
          <Icon name="search" />
        </button>
      </div>
      <div className="sb-actions">
        <button className="action-row new-convo-btn" aria-label="新建对话" onClick={() => chrome.onStartNewChat()}>
          <Icon name="plus" />
          <span className="lbl">新建对话</span>
          <span className="meta"><span className="hint">Ctrl ⇧ O</span></span>
        </button>
        <button className="action-row skills-btn" aria-label="技能与插件" aria-expanded={chrome.skillsOpen} aria-controls="skillsDrawer" onClick={chrome.onToggleSkills}>
          <Icon name="layers" />
          <span className="lbl">技能 & 插件</span>
          <span className="meta"><span className="count">{chrome.skillsEnabledCount}</span><Icon name="chevron-r" extra="sm chev" /></span>
        </button>
      </div>
      <section className="sb-section" id="sbProjects" aria-labelledby="sbProjectsTitle" style={{ ["--sb-proj-basis" as string]: `${projectShare.toFixed(3)}%` }}>
        <div className="sb-section-head">
          <h2 id="sbProjectsTitle">项目与对话</h2>
          <div className="sb-head-actions">
            <button className="icon-btn" data-tip="新建项目（暂未实现）" aria-label="新建项目" disabled><Icon name="plus" extra="sm" /></button>
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
                    onClick={() => chrome.onToggleProject({ id: project.id, name: project.name })}
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
                    <button type="button" className="icon-btn" data-tip="更多（暂未实现）" aria-label="更多操作" disabled><Icon name="more" extra="sm" /></button>
                    <button type="button" className="icon-btn" data-tip="新建会话" aria-label="在此项目下新建会话" onClick={() => chrome.onStartChatInProject({ id: project.id, name: project.name })}><Icon name="plus" extra="sm" /></button>
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
                      <div className={`thread-row${wait ? " has-wait" : ""}`} key={thread.id}>
                        <button
                          className={`thread${chrome.previewThreadId === thread.id ? " active" : ""}`}
                          onClick={() => chrome.onSelectPreviewThread(thread.id)}
                        >
                          <ThreadSpin running={running} />
                          <span className="t-title"><span className="t-scroll">{thread.title}</span></span>
                          {wait || running ? null : <span className="t-meta">{thread.time}</span>}
                        </button>
                        {/* 悬停操作区：最右「归档」（演示：本地隐藏），其左 ⋯ 更多（功能未接入） */}
                        <span className="t-actions">
                          <button type="button" className="icon-btn" data-tip="更多（暂未实现）" aria-label="更多操作" disabled><Icon name="more" extra="sm" /></button>
                          <button type="button" className="icon-btn" data-tip="归档" aria-label="归档会话" onClick={() => chrome.onArchivePreviewThread(thread.id)}><Icon name="archive" extra="sm" /></button>
                        </span>
                        {wait ? <ThreadWaitChip kind={wait} /> : null}
                      </div>
                      );
                    })}
                    {visible.length < threads.length ? (
                      <button type="button" className="load-more" onClick={() => chrome.onLoadMoreThreads(project.id)}>
                        <Icon name="chevron-d" extra="sm" />
                        <span>展开更多</span>
                        <span className="lm-count">{`还有 ${threads.length - visible.length} 个`}</span>
                      </button>
                    ) : null}
                    {!threads.length ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">暂无会话</p></div> : null}
                  </>);
                })() : null}
              </div>
            );
          }) : state.model.workspaces && state.model.workspaces.workspaces.length ? (
            state.model.workspaces.workspaces.map((workspace) => {
              const open = chrome.selectedProject?.id === workspace.workspaceId && chrome.projectListExpanded;
              return (
                <div className="project" key={workspace.workspaceId}>
                  <div className="project-head-row">
                    <button
                      className="project-head"
                      type="button"
                      aria-expanded={open}
                      onClick={() => chrome.onToggleProject({ id: workspace.workspaceId, name: workspace.name })}
                    >
                      {/* 左侧图标位：默认文件夹（展开 folder-open / 收起 folder），
                          悬停整行时换为折叠箭头（chevron-d / chevron-r） */}
                      <span className="tw">
                        <span className="tw-folder"><Icon name={open ? "folder-open" : "folder"} extra="sm" /></span>
                        <span className="tw-chev"><Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" /></span>
                      </span>
                      <span className="p-name ellipsis">{workspace.name}</span>
                      <span className="project-flags">
                        {open ? <span className="muted tiny">{history?.total ?? 0}</span> : null}
                      </span>
                    </button>
                    {/* 悬停浮现的操作区：最右 + 在此项目下新建会话，其左 ⋯ 更多（功能未接入） */}
                    <span className="p-actions">
                      <button type="button" className="icon-btn" data-tip="更多（暂未实现）" aria-label="更多操作" disabled><Icon name="more" extra="sm" /></button>
                      <button type="button" className="icon-btn" data-tip="新建会话" aria-label="在此项目下新建会话" onClick={() => chrome.onStartChatInProject({ id: workspace.workspaceId, name: workspace.name })}><Icon name="plus" extra="sm" /></button>
                    </span>
                  </div>
                  {open ? (() => {
                    const limit = chrome.projectThreadLimits[workspace.workspaceId] ?? PROJECT_THREADS_INITIAL;
                    const entries = (history?.entries ?? []).slice(0, limit);
                    const total = history?.total ?? 0;
                    return (<>
                      {entries.map((entry) => {
                        const wait = threadWaitForSession(entry.sessionId);
                        const running = threadRunningFromLive({
                          ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
                          ...(liveSnapshot?.sessionId === undefined ? {} : { snapshotSessionId: liveSnapshot.sessionId }),
                          ...(liveSnapshot?.isStreaming === undefined ? {} : { streaming: liveSnapshot.isStreaming }),
                          ...(liveSnapshot?.isCompacting === undefined ? {} : { compacting: liveSnapshot.isCompacting }),
                        });
                        return (
                        <div className={`thread-row${wait ? " has-wait" : ""}`} key={entry.historyId}>
                          <button
                            className={`thread${chrome.selectedHistoryId === entry.historyId ? " active" : ""}`}
                            onClick={() => chrome.onSelectThread(entry)}
                          >
                            <ThreadSpin running={running} />
                            <span className="t-title"><span className="t-scroll">{entry.title}</span></span>
                            {wait || running ? null : <span className="t-meta">{relativeTime(entry.lastActiveAt)}</span>}
                          </button>
                          {/* 悬停操作区：最右「归档」（session.archive），其左 ⋯ 更多（功能未接入） */}
                          <span className="t-actions">
                            <button type="button" className="icon-btn" data-tip="更多（暂未实现）" aria-label="更多操作" disabled><Icon name="more" extra="sm" /></button>
                            <button
                              type="button"
                              className="icon-btn"
                              data-tip="归档"
                              aria-label="归档会话"
                              onClick={() => chrome.onArchiveThread(entry)}
                            ><Icon name="archive" extra="sm" /></button>
                          </span>
                          {wait ? <ThreadWaitChip kind={wait} /> : null}
                        </div>
                        );
                      })}
                      {entries.length < total ? (
                        <button type="button" className="load-more" onClick={() => chrome.onLoadMoreThreads(workspace.workspaceId)}>
                          <Icon name="chevron-d" extra="sm" />
                          <span>展开更多</span>
                          <span className="lm-count">{`还有 ${total - entries.length} 个`}</span>
                        </button>
                      ) : null}
                      {!total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">暂无会话</p></div> : null}
                    </>);
                  })() : null}
                </div>
              );
            })
          ) : (
            <div className="project">
              <div className="empty" style={{ padding: "16px 8px" }}>
                <p className="muted small">暂无项目</p>
                <button className="btn small outline" type="button" onClick={chrome.onPickProject}>
                  <Icon name="folder-open" extra="sm" />打开本地文件夹
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      <div
        className="sb-divider"
        id="sbDivider"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="调整 Explorer 高度"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(projectShare)}
        onPointerDown={onSplitPointerDown}
        onDoubleClick={() => chrome.onResizeSplit(0.5)}
        onKeyDown={(event) => {
          if (!chrome.explorerOpen) return;
          const step = event.shiftKey ? 0.15 : 0.05;
          if (event.key === "ArrowUp") { event.preventDefault(); chrome.onResizeSplit(Math.max(0.15, chrome.splitRatio - step)); }
          else if (event.key === "ArrowDown") { event.preventDefault(); chrome.onResizeSplit(Math.min(0.85, chrome.splitRatio + step)); }
          else if (event.key === "Home") { event.preventDefault(); chrome.onResizeSplit(0.15); }
          else if (event.key === "End") { event.preventDefault(); chrome.onResizeSplit(0.85); }
        }}
      />
      <section className={`sb-section${chrome.explorerOpen ? "" : " collapse"}`} id="sbFiles" aria-labelledby="sbFilesTitle" style={{ ["--sb-files-basis" as string]: `${fileShare.toFixed(3)}%` }}>
        <div className="sb-section-head">
          <h2 id="sbFilesTitle">Explorer</h2>
          <div className="sb-head-actions">
            <button className={`icon-btn${newEntryKind === "file" ? " active" : ""}`} data-tip="新建文件" aria-label="新建文件" aria-pressed={newEntryKind === "file"} disabled={!chrome.selectedProject || newEntryBusy} onClick={() => beginWorkspaceEntry("file")}><Icon name="plus" extra="sm" /></button>
            <button className={`icon-btn${newEntryKind === "directory" ? " active" : ""}`} data-tip="新建文件夹" aria-label="新建文件夹" aria-pressed={newEntryKind === "directory"} disabled={!chrome.selectedProject || newEntryBusy} onClick={() => beginWorkspaceEntry("directory")}><Icon name="folder" extra="sm" /></button>
            <button className={`icon-btn${fileSearch ? " active" : ""}`} data-tip="筛选" aria-label="筛选已加载文件" onClick={() => setFileSearch((value) => value ? "" : " ")}><Icon name="search" extra="sm" /></button>
            <button className="icon-btn" data-tip="刷新" aria-label="刷新文件树" disabled={!chrome.selectedProject} onClick={() => preview ? setPreviewFileMessage("演示：文件树已刷新") : setFileRefreshToken((value) => value + 1)}><Icon name="refresh" extra="sm" /></button>
          </div>
          <button className={`icon-btn sb-collapse-btn${chrome.explorerOpen ? "" : " is-collapsed"}`} aria-label={chrome.explorerOpen ? "收起 Explorer" : "展开 Explorer"} aria-expanded={chrome.explorerOpen} onClick={chrome.onToggleExplorer}>
            <Icon name={chrome.explorerOpen ? "chevron-d" : "chevron-u"} extra="sm" />
          </button>
        </div>
        {fileSearch ? <div style={{ padding: "4px 10px" }}><input autoFocus className="input" value={fileSearch.trim()} onChange={(event) => setFileSearch(event.target.value || " ")} placeholder="筛选已加载文件…" aria-label="筛选已加载文件" /></div> : null}
        {preview && previewFileMessage ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{previewFileMessage}</div> : null}
        <div className="sb-scroll">
          {preview ? (
            <PreviewFileTree
              label={findPreviewProject(chrome.previewProjectId)?.name ?? "项目"}
              search={fileSearch.trim()}
              onContext={(path, kind) => chrome.onAddComposerContext({ kind, path, label: fileLabel(path) })}
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
              createKind={newEntryKind}
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
            />
          ) : (
            <div className="empty">暂无选择项目</div>
          )}
        </div>
      </section>
      <SkillsDrawer
        open={chrome.skillsOpen}
        client={client}
        onClose={chrome.onToggleSkills}
        onEnabledCountChange={chrome.onSkillsEnabledCount}
        onOpenHub={(intent) => chrome.onOpenCapabilities(intent?.tab, intent?.name)}
        onInsertSkill={chrome.onInsertSkill}
        onRemoveSkill={chrome.onRemoveComposerSkill}
        draftSkills={chrome.draftSkills}
        usedSkills={chrome.usedSkills}
      />
      <footer className="sb-footer">
        <button
          ref={ompBtnRef}
          type="button"
          className="sb-user"
          aria-label={`${profile.displayName} · OMP 状态与环境菜单`}
          aria-haspopup="menu"
          aria-expanded={chrome.ompMenuOpen}
          onClick={chrome.onToggleOmpMenu}
        >
          {profile.avatarSrc
            ? <img className="avatar" src={profile.avatarSrc} alt="" draggable={false} />
            : <span className="avatar" aria-hidden="true">{avatarInitial(profile.displayName)}</span>}
          <span>
            <span className="u-name">{profile.displayName}</span>
            <span className={`u-status ${omp.tone}`} role="status" aria-live="polite">
              <span className={`dot ${omp.tone === "ok" ? "green" : omp.tone === "err" ? "red" : "amber"}${omp.tone === "ok" ? " pulse" : ""}`} aria-hidden="true" />
              <span>{omp.text}</span>
            </span>
          </span>
          <Icon name="chevron-ud" extra="sm" />
        </button>
      </footer>
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
                {profile.avatarSrc
                  ? <img className="avatar" src={profile.avatarSrc} alt="" draggable={false} />
                  : <span className="avatar" aria-hidden="true">{avatarInitial(profile.displayName)}</span>}
                <span>
                  <span className="u-name">{profile.displayName}</span>
                  <span className="v">
                    <span style={{ color: ompConnected ? "var(--green)" : "var(--red)" }}>
                      {ompConnected ? "Ready" : "Disconnected"}
                    </span>
                    {` · ${ompVersion} · ${ompMeta}`}
                  </span>
                </span>
              </button>
              {!ompConnected ? (
                <div className="omp-menu-err">
                  <Icon name="alert" extra="sm" />
                  <span>{state.hostError?.message ?? "Runtime 未连接。"}</span>
                </div>
              ) : null}
              <div className="menu-sep" />
              <MenuItem icon="pulse" onClick={() => { chrome.onToggleOmpMenu(); onRoute("diagnostics"); }}>打开诊断中心</MenuItem>
              <MenuItem icon="update" onClick={() => { setDiagnosticsIntent("check-update"); chrome.onToggleOmpMenu(); onRoute("diagnostics"); }} {...(preview ? { hint: "v0.82.2 可用" } : {})}>检查更新</MenuItem>
              <MenuItem icon="server" onClick={() => { chrome.onToggleOmpMenu(); onRoute("model-config"); }}>打开模型配置</MenuItem>
              <MenuItem icon="settings" onClick={() => { chrome.onToggleOmpMenu(); onRoute("settings"); }}>打开设置</MenuItem>
              <MenuItem icon="package" onClick={() => { chrome.onToggleOmpMenu(); onRoute("capabilities"); }}>打开能力中心</MenuItem>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

function formatTelemetryTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString("en-US");
}

function formatTelemetryCost(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "—";
}

function formatTelemetryTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : "—";
}

const TELEMETRY_CONTEXT_PARTS: ReadonlyArray<{ key: keyof NonNullable<SessionTelemetrySnapshot["context"]>; label: string; color: string }> = [
  { key: "systemPromptTokens", label: "系统提示词", color: "#8a919c" },
  { key: "systemContextTokens", label: "系统上下文", color: "#64748b" },
  { key: "systemToolsTokens", label: "工具定义", color: "#d9930d" },
  { key: "skillsTokens", label: "Skills", color: "#6e56cf" },
  { key: "messagesTokens", label: "对话消息", color: "#3b9bd4" },
];

function RealTokenTrigger({ telemetry }: { telemetry: SessionTelemetrySnapshot | null }) {
  if (telemetry === null) {
    return <><span className="t-item"><Icon name="arrow-u" extra="sm" /><b>—</b></span><span className="t-item"><Icon name="arrow-d" extra="sm" /><b>—</b></span><span className="t-sep" aria-hidden="true" /><span className="t-item"><b>—</b>&nbsp;cache</span></>;
  }
  return <><span className="t-item"><Icon name="arrow-u" extra="sm" /><b>{formatTelemetryTokens(telemetry.tokens.input)}</b></span><span className="t-item"><Icon name="arrow-d" extra="sm" /><b>{formatTelemetryTokens(telemetry.tokens.output)}</b></span><span className="t-sep" aria-hidden="true" /><span className="t-item"><b>{formatTelemetryTokens(telemetry.tokens.cacheRead + telemetry.tokens.cacheWrite)}</b>&nbsp;cache</span></>;
}

const TELEMETRY_SOURCE_LABELS: Record<string, { label: string; cls: string }> = {
  live: { label: "实时", cls: "chip blue xs" },
  persisted: { label: "最后记录", cls: "chip blue xs" },
  "archive-recomputed": { label: "当前环境重算", cls: "chip blue xs" },
};

function telemetrySourceChip(view: ViewedSessionTelemetryState | undefined, fallback: "live" | undefined): { label: string; cls: string } | undefined {
  const source = view?.source ?? fallback;
  return source === undefined ? undefined : TELEMETRY_SOURCE_LABELS[source];
}

function formatTelemetryExact(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function formatTelemetryDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

function RealTokenPanel({ telemetry, view }: { telemetry: SessionTelemetrySnapshot | null; view: ViewedSessionTelemetryState | undefined }) {
  if (telemetry === null) {
    const reason = view?.status === "unavailable" ? "无法获取该会话的遥测数据。" : view?.status === "loading" ? "正在读取历史会话遥测…" : "Runtime telemetry 尚未就绪。";
    return <><div className="tp-head"><Icon name="zap" extra="sm" />Token 用量<span className="spacer" /><span className="chip gray xs">{view?.status === "loading" ? "读取中" : "不可用"}</span></div><div className="tp-ctx"><div className="tiny muted">{reason}</div></div></>;
  }
  const t = telemetry.tokens;
  const turn = telemetry.lastCompletedTurn;
  const chip = telemetrySourceChip(view, "live");
  const cacheSavedPct = t.cacheRead + t.input > 0 ? Math.round((t.cacheRead / (t.cacheRead + t.input)) * 100) : 0;
  const splitTotal = t.input + t.output + t.cacheRead + t.cacheWrite;
  const splitPct = (value: number): number => (splitTotal > 0 ? Math.min(100, (value / splitTotal) * 100) : 0);
  return <>
    <div className="tp-head"><Icon name="zap" extra="sm" />Token 用量<span className="spacer" />{chip === undefined ? null : <span className={chip.cls}>{chip.label}</span>}</div>
    <div className="tok-hero"><div className="th-cell"><div className="th-k">总消耗</div><div className="th-v">{formatTelemetryTokens(t.total)}</div><div className="th-sub">{turn ? `本轮 ${formatTelemetryTokens(turn.total)}` : "本轮 —"}</div></div><div className="th-cell"><div className="th-k">Cost</div><div className="th-v">{formatTelemetryCost(t.cost)}</div><div className="th-sub">缓存已省 <b>{cacheSavedPct}%</b></div></div></div>
    <div className="tok-split">
      <div className="ts-top"><span>构成</span><b>{formatTelemetryTokens(t.input)} 入 / {formatTelemetryTokens(t.output)} 出</b></div>
      <div className="tok-bar">
        {splitTotal <= 0
          ? <i className="tb-none" />
          : <><i className="tb-in" style={{ width: `${splitPct(t.input)}%` }} /><i className="tb-out" style={{ width: `${splitPct(t.output)}%` }} /><i className="tb-cache" style={{ width: `${splitPct(t.cacheRead + t.cacheWrite)}%` }} /></>}
      </div>
      <div className="tok-keys">
        <span><i className="tb-in" />输入</span>
        <span><i className="tb-out" />输出</span>
        <span><i className="tb-cache" />缓存 {formatTelemetryTokens(t.cacheRead + t.cacheWrite)} · 命中 <b>{cacheSavedPct}%</b></span>
      </div>
    </div>
    <div className="tok-rows">
      <div className="tr-row">本轮输入 / 输出<span className="tr-v">{turn ? `${formatTelemetryTokens(turn.input)} / ${formatTelemetryTokens(turn.output)}` : "—"}</span></div>
      <div className="tr-row">本轮耗时<span className="tr-v">{turn?.durationMs !== undefined ? formatTelemetryDuration(turn.durationMs) : "—"}</span></div>
      <div className="tr-row">TPS<span className="tr-v">{turn?.tps !== undefined ? turn.tps.toFixed(1) : "—"}</span></div>
      <div className="tr-row">Reasoning<span className="tr-v">{formatTelemetryTokens(t.reasoning)}</span></div>
      <div className="tr-row">Cache read<span className="tr-v">{formatTelemetryTokens(t.cacheRead)}</span></div>
      <div className="tr-row">Cache write<span className="tr-v">{formatTelemetryTokens(t.cacheWrite)}</span></div>
      <div className="tr-row">最近完成时间<span className="tr-v">{turn ? formatTelemetryTime(turn.completedAt) : "—"}</span></div>
    </div>
  </>;
}

function RealContextTrigger({ telemetry }: { telemetry: SessionTelemetrySnapshot | null }) {
  const percent = telemetry?.context?.percent;
  return <><span className="ctx-ring" style={{ ["--p" as string]: percent ?? 0 }} aria-hidden="true" /><span className="t-item"><b>{percent === undefined ? "—" : `${Math.round(percent)}%`}</b></span></>;
}

function RealContextPanel({ telemetry, view }: { telemetry: SessionTelemetrySnapshot | null; view: ViewedSessionTelemetryState | undefined }) {
  const context = telemetry?.context;
  if (context === null || context === undefined) {
    const reason = telemetry?.unavailableReason === "probe_dynamic_context_disabled"
      ? "该会话依赖扩展或 MCP；安全模式下无法离线重建 Context"
      : view?.status === "loading"
        ? "正在读取历史会话遥测…"
        : "当前模型没有可用的 Context Window";
    return <><div className="tp-head"><Icon name="layers" extra="sm" />CONTEXT 构成<span className="spacer" /><span className="chip gray xs">不可用</span></div><div className="tp-ctx"><div className="tiny muted">{reason}</div></div></>;
  }
  const ctxWindow = Math.max(1, context.contextWindow);
  const pct = Math.round(context.percent);
  const tone = pct > 80 ? "red" : pct > 60 ? "amber" : "green";
  const restTokens = Math.max(0, context.contextWindow - context.usedTokens);
  const hasRest = restTokens > 0;
  return <><div className="tp-head"><Icon name="layers" extra="sm" />CONTEXT 构成<span className="spacer" /><span className={`chip ${tone} xs`}>{pct}%</span></div><div className="tp-ctx" style={{ paddingTop: 12 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span>已使用</span><b className="mono" style={{ fontSize: 13 }}>{formatTelemetryExact(context.usedTokens)} / {formatTelemetryExact(context.contextWindow)}（{context.percent.toFixed(1)}%）</b></div><div className="ctxbar">{TELEMETRY_CONTEXT_PARTS.map((part) => <i key={part.key} style={{ width: `${Math.min(100, ((context[part.key] as number) / ctxWindow) * 100)}%`, background: part.color }} data-tip={part.label} />)}{hasRest ? <i className="cb-rest" data-tip="未使用" /> : null}</div><div className="ctx-legend">{TELEMETRY_CONTEXT_PARTS.map((part) => <div key={part.key} className="cl-row"><span className="cl-dot" style={{ background: part.color }} /><span>{part.label}</span><span className="cl-v">{formatTelemetryTokens(context[part.key] as number)}</span></div>)}{hasRest ? <div className="cl-row"><span className="cl-dot" style={{ background: "var(--surface-3)" }} /><span>未使用</span><span className="cl-v">{formatTelemetryTokens(restTokens)}</span></div> : null}</div><div className="tiny muted" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>{context.anchored ? "Provider anchor" : "Estimated"}</div></div></>;
}

function AppTopbar({ state, client, chrome, onRoute, threadTitle, sideOpen, onToggleSide, onOpenChanges, onOpenGit, onOpenTerminal, viewedSessionId }: {
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
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const { preview } = usePreviewMode();
  /** 对话动作可用性：写表面始终走真实 API（预览只覆盖读表面），
      因此只看真实 Runtime 快照；无活动会话时诚实禁用并说明原因。 */
  const liveSnapshot = snapshotFrom(state);
  const sessionLive = liveSnapshot !== undefined;
  const sessionBusy = liveSnapshot?.isStreaming === true || liveSnapshot?.isCompacting === true;
  const sessionActionReason = !sessionLive ? "无会话" : "进行中";
  const previewProject = findPreviewProject(chrome.previewProjectId);
  const previewHit = findPreviewThread(chrome.previewThreadId);
  const realActiveWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
  const realGit = useGitRepository(client, preview ? undefined : realActiveWorkspace?.workspaceId);
  const crumbProject = preview
    ? (previewProject?.name ?? "omp-web")
    : (realActiveWorkspace?.name ?? "未选择项目");
  const crumbBranch = preview ? (previewProject?.branch ?? "main") : (realGit.repository?.branch ?? (realGit.repository?.detached ? "detached HEAD" : "—"));
  const crumbThread = preview ? (previewHit?.thread.title ?? threadTitle) : threadTitle;
  const viewedTelemetry = useViewedSessionTelemetry({
    client: preview ? null : client,
    preview,
    viewedSessionId,
    liveSessionId: preview ? undefined : snapshotFrom(state)?.sessionId,
    liveTelemetry: preview ? undefined : (state.clientState?.entities.telemetry ?? undefined),
  });
  const telemetry = preview ? null : (viewedTelemetry.telemetry ?? null);

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

  return (
    <>
    <header className="topbar">
      <div className="tb-left">
        <nav className="tb-crumb" aria-label="当前位置">
          <CrumbMenu
            id="project"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="项目"
            menu={
              <>
                <div className="menu-label">切换项目</div>
                {preview ? PREVIEW_PROJECTS.map((project) => (
                  <MenuItem
                    key={project.id}
                    icon="folder-open"
                    current={project.id === chrome.previewProjectId}
                    hint={project.id === chrome.previewProjectId ? "当前" : project.branch}
                    onClick={() => run(() => chrome.onSelectPreviewProject(project.id))}
                  >
                    {project.name}
                  </MenuItem>
                )) : (
                  <>
                    {(state.model.workspaces?.workspaces ?? []).map((workspace) => (
                      <MenuItem
                        key={workspace.workspaceId}
                        icon="folder-open"
                        current={workspace.active}
                        {...(workspace.active ? { hint: "当前" } : {})}
                        onClick={() => run(() => chrome.onSelectProject({ id: workspace.workspaceId, name: workspace.name }))}
                      >
                        {workspace.name}
                      </MenuItem>
                    ))}
                    {!state.model.workspaces?.workspaces.length ? (
                      <MenuItem icon="folder-open" disabled title="无项目">暂无项目</MenuItem>
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
                      ? { title: "正在打开…" }
                      : {})}
                  onClick={() => run(chrome.onOpenProjectInEditor)}
                >在外部编辑器中打开项目</MenuItem>
                <MenuItem icon="terminal" onClick={() => run(onOpenTerminal)}>在终端中打开</MenuItem>
                <MenuItem
                  icon="folder-open"
                  disabled={chrome.projectShellUnavailable !== undefined || chrome.projectShellAction !== null}
                  {...(chrome.projectShellUnavailable !== undefined
                    ? { title: chrome.projectShellUnavailable }
                    : chrome.projectShellAction === "directory"
                      ? { title: "正在打开…" }
                      : {})}
                  onClick={() => run(chrome.onOpenProjectDirectory)}
                >打开项目目录</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>项目主页</MenuItem>
              </>
            }
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
            tip="分支"
            menu={
              <>
                <div className="branch-menu-head">
                  <div className="bmh-title"><Icon name="branch" extra="sm" /><b>{crumbBranch}</b></div>
                  <div className="bmh-meta">{preview ? `${previewProject?.dirty ?? 0} 个未提交 · 演示` : realGit.repository?.isRepository ? `${realGit.repository.changes.length} 个未提交 · ↑${realGit.repository.ahead} ↓${realGit.repository.behind}` : (realGit.error ?? "当前项目不是 Git 仓库")}</div>
                </div>
                <MenuItem icon="commit" onClick={() => run(onOpenGit)}>未提交修改</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="columns" onClick={() => run(onOpenChanges)}>查看 Changes</MenuItem>
                <MenuItem icon="commit" onClick={() => run(onOpenGit)}>创建 Commit</MenuItem>
                <MenuItem icon="branch" onClick={() => run(onOpenGit)}>切换分支</MenuItem>
                <MenuItem icon="worktree" onClick={() => run(onOpenGit)}>新建 Worktree</MenuItem>
              </>
            }
          >
            <Icon name="branch" extra="sm" />
            <span className="crumb-label crumb-branch-label" data-tip={crumbBranch}>{crumbBranch}</span>
          </CrumbMenu>
          <span className="crumb-sep" aria-hidden="true">›</span>
          <CrumbMenu
            id="thread"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="对话"
            current
            menu={
              <>
                <MenuItem
                  icon="pencil"
                  disabled={!sessionLive}
                  {...(sessionLive ? {} : { title: sessionActionReason })}
                  onClick={() => run(chrome.onRenameThread)}
                >重命名对话</MenuItem>
                <MenuItem
                  icon="fork"
                  disabled={!sessionLive || sessionBusy}
                  {...(sessionLive && !sessionBusy ? {} : { title: sessionActionReason })}
                  onClick={() => run(chrome.onForkThread)}
                >Fork 当前对话</MenuItem>
                <MenuItem
                  icon="handoff"
                  disabled={!sessionLive || sessionBusy}
                  {...(sessionLive && !sessionBusy ? {} : { title: sessionActionReason })}
                  onClick={() => run(chrome.onHandoffThread)}
                >Handoff 到新对话</MenuItem>
                <div className="menu-sep" />
                <MenuItem
                  icon="minimize"
                  disabled={!sessionLive || liveSnapshot?.isCompacting === true || chrome.compactPending}
                  {...(sessionLive && liveSnapshot?.isCompacting !== true && !chrome.compactPending ? {} : { title: sessionLive ? "压缩中" : sessionActionReason })}
                  onClick={() => run(chrome.onCompactThread)}
                >Compact 当前上下文</MenuItem>
                <MenuItem
                  icon="export"
                  disabled={!sessionLive || sessionBusy}
                  {...(sessionLive && !sessionBusy ? {} : { title: sessionActionReason })}
                  onClick={() => run(chrome.onExportThread)}
                >导出对话</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="history" onClick={() => run(() => onRoute("history"))}>会话历史</MenuItem>
                <MenuItem
                  icon="archive"
                  disabled={preview ? chrome.hiddenPreviewThreads.has(chrome.previewThreadId) : chrome.archiveTarget === undefined}
                  {...(preview
                    ? chrome.hiddenPreviewThreads.has(chrome.previewThreadId)
                      ? { title: "已归档" }
                      : {}
                    : chrome.archiveTarget === undefined
                      ? { title: "无会话" }
                      : {})}
                  onClick={() => {
                    if (preview) {
                      run(() => chrome.onArchivePreviewThread(chrome.previewThreadId));
                      return;
                    }
                    const target = chrome.archiveTarget;
                    if (target !== undefined) run(() => chrome.onArchiveThread(target));
                  }}
                >归档</MenuItem>
              </>
            }
          >
            <span className="ellipsis" data-tip={crumbThread}>{crumbThread}</span>
            <Icon name="chevron-d" extra="sm crumb-chevron" />
          </CrumbMenu>
        </nav>
        <button
          className="icon-btn"
          data-tip={sessionLive && !sessionBusy ? "Fork" : sessionActionReason}
          aria-label="Fork 对话"
          disabled={!sessionLive || sessionBusy}
          onClick={() => run(chrome.onForkThread)}
        ><Icon name="fork" /></button>
        <button
          className="icon-btn"
          data-tip={sessionLive && !sessionBusy ? "Handoff" : sessionActionReason}
          aria-label="Handoff 到新 Thread"
          disabled={!sessionLive || sessionBusy}
          onClick={() => run(chrome.onHandoffThread)}
        ><Icon name="handoff" /></button>
      </div>
      <button className="icon-btn lg" data-tip="Agent Hub" aria-label="Agent Hub" onClick={() => onRoute("agent-hub")}><Icon name="bot" extra="lg" /></button>
      <button className="icon-btn" data-tip="会话历史" aria-label="会话历史" onClick={() => onRoute("history")}><Icon name="history" /></button>
      <div className="tb-right">
        <div className="telemetry">
          <AnchoredPop
            id="tokens"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="Token"
            label="Token 用量详情"
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop tok-pop"
            panel={preview ? <PreviewTokenPanel /> : <RealTokenPanel telemetry={telemetry} view={viewedTelemetry} />}
          >
            {preview ? <PreviewTokenTrigger /> : <RealTokenTrigger telemetry={telemetry} />}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          <AnchoredPop
            id="context"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="Context"
            label="Context 构成详情"
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop ctx-pop"
            panel={preview ? <PreviewContextPanel /> : <RealContextPanel telemetry={telemetry} view={viewedTelemetry} />}
          >
            {preview ? <PreviewContextTrigger /> : <RealContextTrigger telemetry={telemetry} />}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          <span className="t-item"><b>auto</b>&nbsp;compact</span>
          <button
            className="tb-compact"
            disabled={!sessionLive || sessionBusy || chrome.compactPending}
            data-tip={
              !sessionLive
                ? sessionActionReason
                : sessionBusy || chrome.compactPending
                  ? "压缩中"
                  : "Compact"
            }
            aria-label="Compact 当前上下文"
            onClick={() => run(chrome.onCompactThread)}
          >
            {sessionBusy || chrome.compactPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="minimize" extra="sm" />}
            Compact
          </button>
        </div>
        <button className={`icon-btn${sideOpen ? " active" : ""}`} data-tip="右侧面板" aria-controls="sidePanel" aria-expanded={sideOpen} onClick={onToggleSide}><Icon name="panel" /></button>
        <button className="icon-btn" data-tip="主题" onClick={chrome.onToggleTheme} aria-label="切换主题">
          <Icon name={chrome.theme === "dark" ? "moon" : "light"} />
        </button>
        <button className="icon-btn" data-tip="主页" onClick={() => onRoute("home")}><Icon name="home" /></button>
      </div>
    </header>
    </>
  );
}

function useComposerCollisionCollapse() {
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    let frame: number | undefined;
    let disposed = false;
    const hasPressure = () => {
      bar.dataset.measuring = "true";
      const modes = bar.querySelector<HTMLElement>(".cmp-mode-cluster");
      // Menus and flyouts are absolutely positioned descendants and may enlarge
      // bar.scrollWidth while open. Only the in-flow capsule cluster represents
      // real pressure against the model picker.
      const pressured = modes !== null && modes.scrollWidth > modes.clientWidth + 1;
      delete bar.dataset.measuring;
      return pressured;
    };
    const measure = () => {
      frame = undefined;
      // Resetting collapse to "full" then back reflows the bar. Do not do that
      // while a composer menu is open: capsule toggles would make the popup jump.
      if (bar.querySelector("[aria-expanded='true']")) return;
      bar.dataset.collapse = "full";
      if (!hasPressure()) return;
      bar.dataset.collapse = "model";
      if (!hasPressure()) return;
      bar.dataset.collapse = "modes";
    };
    const schedule = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    resizeObserver?.observe(bar);
    const mutationObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(schedule);
    mutationObserver?.observe(bar, { childList: true, characterData: true, subtree: true });
    void document.fonts?.ready.then(() => {
      if (!disposed) schedule();
    });

    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return barRef;
}

function WorkbenchCanvas({ state, client, selectedSessionId, selectedThreadId, previewProjectId, previewThreadId, sessionCreating, waitForNewSession, onSelectProject, onSelectPreviewProject, onSelectPreviewThread, onSelectThread, onBranchedSession, hiddenPreviewThreads, onPreviewDeckWait, sideOpen, onCloseSide, sideTab, onSideTabChange, panelWidth, onResizePanel, bottomOpen, onBottomOpenChange, bottomHeight, onResizeBottom, bottomTab, onBottomTabChange, onRoute, onOpenChanges, onOpenGit, composerRef, workspaceId, onSlashUi, onDraftSkillsChange, onUsedSkillsChange, onSessionTitleMaybeChanged, btwWindow, btwSession, btwSideHeadRect, onBtwDemoNext, onBtwPreviewAsk, createProjectNonce, compactPending, onCompactPending }: {
  state: ViewState;
  client: ClientStateSource;
  selectedSessionId?: string;
  selectedThreadId?: ThreadId;
  /** 后台 session.create 进行中：欢迎区照常显示，发送前再等就绪。 */
  sessionCreating?: boolean;
  waitForNewSession?: () => Promise<boolean>;
  previewProjectId?: string;
  previewThreadId?: string;
  onPreviewDeckWait?: (kind: ThreadWaitKind | undefined) => void;
  onSelectProject: (project: SelectedProject) => void;
  onSelectPreviewProject: (id: string) => void;
  onSelectPreviewThread?: (id: string) => void;
  onSelectThread?: (entry: SessionHistoryEntry) => void;
  onBranchedSession?: (sessionId: string) => Promise<boolean>;
  hiddenPreviewThreads?: ReadonlySet<string>;
  sideOpen: boolean;
  onCloseSide: () => void;
  sideTab: SideTab;
  onSideTabChange: (tab: SideTab) => void;
  /** 右侧面板宽度（px），由 spResizer 拖拽调整，App 持久化到 --panel-w。 */
  panelWidth: number;
  onResizePanel: (width: number) => void;
  bottomOpen: boolean;
  onBottomOpenChange: (open: boolean) => void;
  /** 底部运行面板高度（px），由 bpResizer 拖拽调整，App 持久化到 --bottom-panel-h。 */
  bottomHeight: number;
  onResizeBottom: (height: number) => void;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  onRoute: (route: Route) => void;
  onOpenChanges: () => void;
  /** 打开右侧面板的 Git 页签。 */
  onOpenGit: () => void;
  composerRef: { current: ChipComposerHandle | null };
  workspaceId?: string;
  onSlashUi: (ui: SlashNativeUi) => void;
  onDraftSkillsChange?: (names: ReadonlySet<string>) => void;
  onUsedSkillsChange?: (identityKey: string, names: ReadonlySet<string>) => void;
  onSessionTitleMaybeChanged?: () => void;
  /** BTW 浮窗状态由 AppShell 持有，工作台只负责画它与侧栏页。 */
  btwWindow: BtwWindowApi;
  btwSession: BtwSessionApi;
  btwSideHeadRect: () => BtwRect | undefined;
  onBtwDemoNext: () => void;
  /** Preview `/btw`: reset the fixture round. Local UI only. */
  onBtwPreviewAsk: () => void;
  /** AppMenu「新建项目」：nonce 递增时打开与面包屑相同的创建项目对话框。 */
  createProjectNonce?: number;
  /** 顶栏 / slash Compact 已发出、命令尚未结束。 */
  compactPending?: boolean;
  onCompactPending?: (pending: boolean) => void;
}) {
  const [draft, setDraft] = useState<ComposerSnapshot>(emptySnapshot);
  const [bottomResizing, setBottomResizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const composerBarRef = useComposerCollisionCollapse();
  // 右侧面板收起是 250ms 滑出动画：Changes 内容跟随 sideOpen 立即卸载会先闪一帧空面板，
  // 这里延迟到滑动结束后再卸载。时长须与 tokens.css 的 --dur-slow 保持一致。
  const [sideContentMounted, setSideContentMounted] = useState(sideOpen);
  useEffect(() => {
    if (sideOpen) {
      setSideContentMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setSideContentMounted(false), 250);
    return () => window.clearTimeout(timer);
  }, [sideOpen]);
  // 右侧面板拖拽调宽：照左栏 sidebar-resizer 的模式，pointer capture 期间直接写
  // 元素宽度与 --panel-w（收起动画的 margin 偏移量依赖该变量），松手后提交 state。
  // 夹取范围与 .side-panel 的 min/max-width（360/640）保持一致。
  const onPanelResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sideOpen) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const panel = handle.closest(".side-panel");
    if (!(panel instanceof HTMLElement)) return;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panelWidth;
    handle.classList.add("dragging");
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    let latest = startWidth;
    const apply = (width: number) => {
      latest = width;
      panel.style.width = `${width}px`;
      document.documentElement.style.setProperty("--panel-w", `${width}px`);
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      // 面板贴右缘：指针左移变宽、右移变窄。
      apply(Math.min(640, Math.max(360, startWidth - (next.clientX - startX))));
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResizePanel(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  // 底栏拖拽调高：照右侧 sp-resizer。收起时拖动先展开；拖动期间关掉 height
  // 过渡（.resizing），否则每一步都在追光标。夹取 120–480，对齐 ver1。
  const onBottomResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const panel = handle.closest(".bottom-panel");
    if (!(panel instanceof HTMLElement)) return;
    if (!bottomOpen) onBottomOpenChange(true);
    setBottomResizing(true);
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = bottomHeight;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "row-resize";
    let latest = startHeight;
    const apply = (height: number) => {
      latest = clampBottomHeight(height);
      panel.style.height = `${latest}px`;
      document.documentElement.style.setProperty("--bottom-panel-h", `${latest}px`);
      handle.setAttribute("aria-valuenow", String(latest));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(startHeight - (next.clientY - startY));
    };
    const up = () => {
      handle.classList.remove("dragging");
      panel.classList.remove("resizing");
      panel.style.height = "";
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResizeBottom(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onBottomResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 60 : 20;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onBottomOpenChange(true);
      onResizeBottom(clampBottomHeight(bottomHeight + step));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onResizeBottom(clampBottomHeight(bottomHeight - step));
    } else if (event.key === "Home") {
      event.preventDefault();
      onBottomOpenChange(true);
      onResizeBottom(BOTTOM_PANEL_MAX);
    } else if (event.key === "End") {
      event.preventDefault();
      onResizeBottom(BOTTOM_PANEL_MIN);
    }
  };
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const toastedStatusIds = useRef(new Set<string>());
  const lastStatusToast = useRef<{ family: "fast-tier" | "prewalk-noop"; at: number } | undefined>(undefined);
  const [composerSubmitted, setComposerSubmitted] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(true);
  const composerInputRef = composerRef;
  // 流式期间按 Enter 的消息先排本地队列，本轮 run 结束后由 flush effect 按序发送。
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const queuedSeqRef = useRef(0);
  const [queueEdit, setQueueEdit] = useState<QueueEditState | undefined>(undefined);
  const [queueFlushTick, setQueueFlushTick] = useState(0);
  const queueFlushBusyRef = useRef(false);
  const queueRetryAtRef = useRef(0);
  const [contextProjectMenuOpen, setContextProjectMenuOpen] = useState(false);
  const [contextProjectQuery, setContextProjectQuery] = useState("");
  const [contextBranchMenuOpen, setContextBranchMenuOpen] = useState(false);
  const [branchListState, setBranchListState] = useState<{ status: "idle" | "loading" | "ready" | "error"; branches: ReadonlyArray<GitBranchRecord>; error?: string }>({ status: "idle", branches: [] });
  const [branchSwitchName, setBranchSwitchName] = useState<string | undefined>(undefined);
  const [branchNotice, setBranchNotice] = useState<{ tone: "ok" | "error"; text: string } | undefined>(undefined);
  // 流式对话（或有 pending interaction）期间请求的分支操作先排队，本轮结束后由 effect 执行。
  const [pendingBranchAction, setPendingBranchAction] = useState<{ kind: "switch" | "create"; name: string } | undefined>(undefined);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createBranchBusy, setCreateBranchBusy] = useState(false);
  const [createBranchError, setCreateBranchError] = useState<string | undefined>(undefined);
  // git switch 被未提交改动挡住：弹窗列出冲突文件，提交后重试切换。
  const [switchBlock, setSwitchBlock] = useState<{ branch: string; files: SwitchBlockedFile[] } | undefined>(undefined);
  const [switchCommitMessage, setSwitchCommitMessage] = useState("");
  const [switchCommitBusy, setSwitchCommitBusy] = useState(false);
  const [switchCommitError, setSwitchCommitError] = useState<string | undefined>(undefined);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectName, setCreateProjectName] = useState("");
  const [createProjectFolderReady, setCreateProjectFolderReady] = useState(false);
  const [createProjectBusy, setCreateProjectBusy] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | undefined>(undefined);
  const [previewCreatedProject, setPreviewCreatedProject] = useState<{ id: string; name: string } | null>(null);
  const [previewApprovalMode, setPreviewApprovalMode] = useState<ApprovalMode>("yolo");
  const [magicKeyword, setMagicKeyword] = useState<MagicKeyword | null>(null);
  const [modelMenuNonce, setModelMenuNonce] = useState(0);
  const [modeMenuNonce, setModeMenuNonce] = useState(0);
  const [modeOpenToggles, setModeOpenToggles] = useState(false);
  const [changesFocus, setChangesFocus] = useState<{ key: number; path?: string; turnId?: string }>({ key: 0 });
  const promptUnsub = useRef<Unsubscribe | undefined>(undefined);
  useEffect(() => () => promptUnsub.current?.(), []);
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const terminalAvailable = typeof globalThis.ompStudioTerminal !== "undefined";
  const { preview } = usePreviewMode();
  const treeConfirm = useUserMessageTreeConfirm(preview);
  const [inspectTarget, setInspectTarget] = useState<SubagentHubTarget | null>(null);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [rememberedPlan, setRememberedPlan] = useState<{ title: string; body: string } | undefined>(undefined);
  const planDialogOriginRef = useRef<HTMLElement | null>(null);
  const [previewDeckKind, setPreviewDeckKind] = useState<"plan" | "ask" | null>(null);
  const lastAskDeckRef = useRef<ClientInteraction | null>(null);
  const [askDeckLeaving, setAskDeckLeaving] = useState(false);
  useEffect(() => {
    setInspectTarget(null);
    setRememberedPlan(undefined);
    setPlanDialogOpen(false);
  }, [selectedSessionId]);
  // 预览模式的排队栏演示：t1「跟踪上游 pi-web 更新到 omp-web」流式中显示 fixture
  // 两条消息；操作只改本地列表，不触 Host（AGENTS.md 预览规则）。
  const previewQueueActive = preview === true && previewThreadId === "t1";
  const [previewQueue, setPreviewQueue] = useState<QueuedMessage[]>([]);
  const previewQueueSeqRef = useRef(100);
  useEffect(() => {
    // 进入 t1 重新播种演示队列；离开（run 结束的故事线）清空，如同已 flush。
    setPreviewQueue(previewQueueActive ? PREVIEW_QUEUED_MESSAGES.map((entry) => ({ ...entry })) : []);
  }, [previewQueueActive]);
  const queueEditRef = useRef(queueEdit);
  queueEditRef.current = queueEdit;
  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;
  const previewQueueRef = useRef(previewQueue);
  previewQueueRef.current = previewQueue;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const queueViewRef = useRef({ selectedSessionId, preview });
  useEffect(() => {
    const prev = queueViewRef.current;
    queueViewRef.current = { selectedSessionId, preview };
    if (prev.selectedSessionId === selectedSessionId && prev.preview === preview) return;
    const editing = queueEditRef.current;
    if (editing === undefined) return;
    const composer = composerInputRef.current?.getSnapshot() ?? draftRef.current;
    const realQueue = queuedMessagesRef.current;
    const demoQueue = previewQueueRef.current;
    const inPreview = demoQueue.some((item) => item.id === editing.entryId);
    const result = parkQueueEdit({
      queue: inPreview ? demoQueue : realQueue,
      editing,
      composer,
    });
    if (inPreview) setPreviewQueue([...result.queue]);
    else setQueuedMessages([...result.queue]);
    setQueueEdit(undefined);
    setDraft(result.composer);
    composerInputRef.current?.setSnapshot(result.composer);
  }, [selectedSessionId, preview]);
  const pendingComposerFillRef = useRef<{ sessionId: string; fill: UserMessageEditorFill } | undefined>(undefined);
  useEffect(() => {
    const pending = pendingComposerFillRef.current;
    if (pending === undefined || pending.sessionId !== selectedSessionId) return;
    pendingComposerFillRef.current = undefined;
    const restored = snapshotFromTextAndImages(pending.fill.text ?? "", pending.fill.images);
    setDraft(restored);
    composerInputRef.current?.setSnapshot(restored);
    setComposerError(undefined);
    queueMicrotask(() => composerInputRef.current?.focus());
  }, [selectedSessionId]);
  const snapshot = snapshotFrom(state);
  const connection = state.clientState?.connection;
  const runtime = connection?.runtime ?? state.bootstrap?.runtime;
  const commands = state.clientState?.commands ?? {};
  const pendingInteraction = state.clientState?.interaction.pending ?? null;
  const askDeckLive = isAskDeckInteraction(pendingInteraction);
  if (askDeckLive && pendingInteraction) lastAskDeckRef.current = pendingInteraction;
  useEffect(() => {
    if (askDeckLive) {
      setAskDeckLeaving(false);
      return;
    }
    if (pendingInteraction !== null) {
      lastAskDeckRef.current = null;
      setAskDeckLeaving(false);
      return;
    }
    if (lastAskDeckRef.current === null) return;
    if (prefersReducedMotion()) {
      lastAskDeckRef.current = null;
      setAskDeckLeaving(false);
      return;
    }
    setAskDeckLeaving(true);
    const timer = window.setTimeout(() => {
      lastAskDeckRef.current = null;
      setAskDeckLeaving(false);
    }, ASK_GENIE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [askDeckLive, pendingInteraction]);
  const askDeckInteraction = askDeckLive
    ? pendingInteraction
    : askDeckLeaving
      ? lastAskDeckRef.current
      : null;
  const deckInteraction = askDeckInteraction ?? pendingInteraction;
  const capabilities = usableCapabilityManifest(
    state.model.capabilities,
    connection?.capabilityManifest,
    state.bootstrap?.capabilityManifest,
  );
  const commandManifest = state.model.commandManifest;
  const capabilityById = useMemo(() => new Map((capabilities?.capabilities ?? []).map((capability) => [capability.id, capability])), [capabilities]);
  const can = (id: string) => {
    const entry = capabilityById.get(id);
    if (!entry || entry.grade === "unavailable") return false;
    if (connection?.resyncRequired) return false;
    if (runtime?.classification === "limited-system") return false;
    return true;
  };
  const conversationClient = useMemo(() => asConversationClient(client), [client]);
  const runtimeConnected = runtime?.status === "connected";
  const conversationIdentity = selectedSessionId === undefined
    ? sessionCreating === true || snapshot === undefined
      ? null
      : { runtimeEpoch: snapshot.runtimeEpoch, sessionId: snapshot.sessionId }
    : {
        sessionId: selectedSessionId as SessionId,
        ...(snapshot?.sessionId === selectedSessionId ? { runtimeEpoch: snapshot.runtimeEpoch } : {}),
      };
  const convo = useConversation({
    preview,
    client: conversationClient,
    identity: conversationIdentity,
    // Persistent archive reads are Broker/Host-owned and do not require a
    // currently connected Runtime capability manifest.
    canRead: true,
    runtimeConnected,
    ...(previewThreadId === undefined ? {} : { previewThreadId }),
  });
  const [compactReloadHold, setCompactReloadHold] = useState(false);
  const compactingNow = compactPending === true || snapshot?.isCompacting === true || compactReloadHold;
  const wasCompactPending = useRef(false);
  const reloadConversation = useRef(convo.reload);
  reloadConversation.current = convo.reload;
  useEffect(() => {
    if (wasCompactPending.current && compactPending !== true) {
      setCompactReloadHold(true);
      void reloadConversation.current().finally(() => setCompactReloadHold(false));
    }
    wasCompactPending.current = compactPending === true;
  }, [compactPending]);
  useEffect(() => {
    onDraftSkillsChange?.(skillNamesInDoc(draft.doc));
  }, [draft.doc, onDraftSkillsChange]);
  useEffect(() => {
    const names = new Set<string>();
    for (const row of convo.rows) {
      if (row.type !== "user") continue;
      for (const name of skillNamesInText(row.text)) names.add(name);
    }
    onUsedSkillsChange?.(convo.identityKey, names);
  }, [convo.rows, convo.identityKey, onUsedSkillsChange]);
  useEffect(() => {
    toastedStatusIds.current = new Set();
  }, [convo.identityKey]);
  useEffect(() => {
    for (const notice of convo.state.notices) {
      if (!isTransientStatusNotice(notice.message, notice.source)) continue;
      if (toastedStatusIds.current.has(notice.id)) continue;
      toastedStatusIds.current.add(notice.id);
      const claimed = claimTransientToast(
        transientStatusFamily(notice.message, notice.source),
        lastStatusToast.current,
      );
      lastStatusToast.current = claimed.next;
      if (claimed.show) setStatusToast(notice.message);
    }
  }, [convo.state.notices]);
  /* ConversationPane 与 ConversationMinimap 共享同一 scroller（滚动同步/跳转不走 DOM id 查询）。 */
  const convoScrollerRef = useRef<HTMLElement | null>(null);
  const isNewConversation = preview
    ? previewThreadId === "t0"
    : selectedSessionId === undefined && (sessionCreating === true || convo.rows.length === 0);
  const showWelcome = sessionCreating === true || isNewConversation
    || (convo.rows.length === 0 && (convo.demo || convo.state.hydrateStatus === "ready"));
  const showContextStrip = isNewConversation && !composerSubmitted;
  const taskProgress = useMemo(() => {
    if (preview) {
      if (isNewConversation) return { todos: [], files: [] };
      return { todos: PREVIEW_TODOS, files: PREVIEW_TODO_FILES };
    }
    return sessionTaskProgress(convo.rows);
  }, [convo.rows, isNewConversation, preview]);
  const testRuns = useMemo(() => preview ? [] : projectAgentTestRuns(convo.rows), [convo.rows, preview]);
  const testSummary = useMemo(() => agentTestRunSummary(testRuns), [testRuns]);
  const activeWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
  const gitWorkspaceId = preview ? undefined : activeWorkspace?.workspaceId;
  const realGit = useGitRepository(client, gitWorkspaceId);
  const loadBranches = useCallback(async () => {
    if (gitWorkspaceId === undefined) return;
    setBranchListState({ status: "loading", branches: [] });
    try {
      const value = await client.query("git.branches.list", { workspaceId: gitWorkspaceId });
      setBranchListState({ status: "ready", branches: value.branches });
    } catch (cause) {
      setBranchListState({ status: "error", branches: [], error: hostErrorMessage(cause, "无法读取分支列表") });
    }
  }, [client, gitWorkspaceId]);
  const openCreateBranch = () => {
    setContextBranchMenuOpen(false);
    setCreateBranchName("");
    setCreateBranchError(undefined);
    setCreateBranchOpen(true);
  };
  useEffect(() => {
    if (!contextBranchMenuOpen || preview || gitWorkspaceId === undefined) return;
    if (branchListState.status === "idle" && realGit.repository?.isRepository) void loadBranches();
  }, [branchListState.status, contextBranchMenuOpen, gitWorkspaceId, loadBranches, preview, realGit.repository?.isRepository]);
  useEffect(() => {
    if (branchNotice === undefined) return;
    const timer = window.setTimeout(() => setBranchNotice(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [branchNotice]);
  const localBranches = useMemo(() => branchListState.branches.filter((branch) => !branch.remote), [branchListState.branches]);
  const remoteBranches = useMemo(() => branchListState.branches.filter((branch) => branch.remote), [branchListState.branches]);
  const activePreviewProject = preview ? findPreviewProject(previewProjectId ?? "") : undefined;
  const contextProjectName = preview
    ? (previewCreatedProject?.name ?? activePreviewProject?.name ?? "未选择项目")
    : (activeWorkspace?.name ?? "未选择项目");
  const normalizedProjectQuery = contextProjectQuery.trim().toLocaleLowerCase();
  const previewProjectOptions = PREVIEW_PROJECTS.filter((project) => project.name.toLocaleLowerCase().includes(normalizedProjectQuery));
  const workspaceOptions = (state.model.workspaces?.workspaces ?? []).filter((workspace) => workspace.name.toLocaleLowerCase().includes(normalizedProjectQuery));
  const openCreateProject = () => {
    setContextProjectMenuOpen(false);
    setCreateProjectName("");
    setCreateProjectFolderReady(false);
    setCreateProjectError(undefined);
    setCreateProjectOpen(true);
  };
  useEffect(() => {
    if (!createProjectNonce) return;
    openCreateProject();
  }, [createProjectNonce]);
  const createProject = async () => {
    const name = createProjectName.trim();
    if (!name || !createProjectFolderReady || createProjectBusy) return;
    setCreateProjectError(undefined);
    if (preview) {
      setPreviewCreatedProject({ id: `preview-created-${Date.now()}`, name });
      setCreateProjectOpen(false);
      return;
    }
    setCreateProjectBusy(true);
    try {
      const handle = await client.command("workspace.pick", { name });
      const model = await waitReceipt<WorkspaceListReadModel>(client, handle.requestId);
      const active = model.workspaces.find((workspace) => workspace.active);
      if (!active) throw new Error("选择的文件夹未注册为项目");
      onSelectProject({ id: active.workspaceId, name: active.name });
      setCreateProjectOpen(false);
    } catch (error) {
      setCreateProjectError(hostErrorMessage(error, "创建项目失败"));
    } finally {
      setCreateProjectBusy(false);
    }
  };
  useEffect(() => {
    setComposerSubmitted(false);
    setComposerExpanded(true);
  }, [previewThreadId, selectedSessionId, selectedThreadId]);
  const convoRef = useRef(convo);
  convoRef.current = convo;
  const selectedTargetRef = useRef({ selectedSessionId, selectedThreadId });
  selectedTargetRef.current = { selectedSessionId, selectedThreadId };
  const run = useCallback(async <T extends CommandName>(name: T, input: CommandInput<T>): Promise<boolean> => {
    const concurrent = isLiveSessionPreferenceCommand(name) || name === "interaction.respond";
    if (busy && !concurrent) return false;
    if (!concurrent) setBusy(true);
    try {
      const handle = await client.command(name, input);
      const result = await waitReceipt<{ readonly syncStatus?: "complete" | "partial"; readonly failedSessions?: number }>(client, handle.requestId);
      if (name === "permissions.mode.set" && result.syncStatus === "partial") {
        setComposerError(`权限模式仅同步到部分 Runtime（${result.failedSessions ?? 0} 个失败），请稍后重试。`);
        return false;
      }
      setComposerError(undefined);
      return true;
    } catch (error) {
      const message = hostErrorMessage(error, "操作失败");
      if (isTransientStatusNotice(message)) {
        const claimed = claimTransientToast(transientStatusFamily(message), lastStatusToast.current);
        lastStatusToast.current = claimed.next;
        if (claimed.show) setStatusToast(message);
        return false;
      }
      setComposerError(message);
      return false;
    } finally {
      if (!concurrent) setBusy(false);
    }
  }, [busy, client]);
  const respond = useCallback((decision: "submit" | "cancel", value?: InteractionResponseValue): Promise<boolean> => {
    if (!pendingInteraction) return Promise.resolve(false);
    // run() waits for the receipt and reports failure through the return
    // value; the pending card stays until the Runtime resolves it.
    return run("interaction.respond", {
      interactionId: pendingInteraction.interactionId,
      leaseGeneration: pendingInteraction.leaseGeneration,
      decision,
      ...(value === undefined ? {} : { value }),
    });
  }, [pendingInteraction, run]);
  const respondPlanReview = useCallback(async (id: PlanActionId, detail?: PlanActionDetail): Promise<boolean> => {
    if (id === "refine") {
      const feedback = detail?.feedback?.trim();
      if (feedback) {
        return run("mode.plan.review.respond", { decision: "refine", feedback });
      }
      const ok = await run("mode.plan.review.respond", { decision: "dismiss" });
      if (ok) {
        setStatusToast("请在输入框写下修改意见");
        queueMicrotask(() => composerInputRef.current?.focus());
      }
      return ok;
    }
    if (id === "dismiss") {
      const ok = await run("mode.plan.review.respond", { decision: "dismiss" });
      if (ok) queueMicrotask(() => composerInputRef.current?.focus());
      return ok;
    }
    return run("mode.plan.review.respond", { decision: id });
  }, [run]);
  const commandRows = useMemo(() => Object.values(commands).slice(-20).reverse(), [commands]);
  const snapshotReady = snapshot !== undefined;
  const executionMatches = selectedSessionId === undefined || snapshot?.sessionId === selectedSessionId;
  const gated = busy || Boolean(connection?.resyncRequired) || !runtimeConnected || !snapshotReady || !executionMatches;
  // Composer `gated` / can() flicker while snapshot, capabilities, or the
  // selected session catch up. The ask is already on screen — lock only when
  // the Host cannot take interaction.respond. That is why the card went dead
  // and then unlocked with no click.
  const interactionDisabled = interactionDeckDisabled({
    resyncRequired: Boolean(connection?.resyncRequired),
    runtimeConnected,
  });
  const planReview = !preview && snapshot?.plan?.status === "review" ? snapshot.plan : undefined;
  const planReviewDisabled = gated || !can("mode.plan.review.respond");
  const liveReviewKey = pendingInteraction || planReview === undefined
    ? ""
    : `${planReview.planReference ?? ""}:${planReview.title ?? ""}:${planReview.body ?? ""}`;
  const previewPlanActive = preview === true && previewThreadId === "t3" && previewDeckKind === "plan";
  useEffect(() => {
    if (planReview === undefined) return;
    setRememberedPlan({
      title: planReview.title ?? "Plan",
      body: planReview.body ?? "",
    });
  }, [planReview]);
  const transcriptPlan = useMemo(() => collectLatestPlanDocument(convo.rows), [convo.rows]);
  const planView = planReview === undefined
    ? (rememberedPlan ?? transcriptPlan)
    : { title: planReview.title ?? "Plan", body: planReview.body ?? "" };
  useEffect(() => {
    if (liveReviewKey.length > 0) return;
    if (!previewPlanActive) setPlanDialogOpen(false);
  }, [liveReviewKey, previewPlanActive]);
  const openPlanFromConversation = useCallback((origin: HTMLElement) => {
    planDialogOriginRef.current = origin;
    if (preview || snapshot?.plan?.status === "review") {
      setPlanDialogOpen(true);
      return;
    }
    if (snapshot?.plan?.status === "active" || snapshot?.plan?.status === "paused") {
      void run("mode.plan.review.open", {});
      return;
    }
    if (planView !== undefined) {
      setPlanDialogOpen(true);
      return;
    }
    void run("mode.plan.review.open", {});
  }, [planView, preview, run, snapshot?.plan?.status]);
  const planLink = {
    onOpen: openPlanFromConversation,
    ...(planReview?.title
      ? { title: planReview.title }
      : previewPlanActive
        ? { title: PREVIEW_PLAN_TITLE }
        : {}),
    ...(previewPlanActive ? { demo: true as const } : {}),
    ...((planReview !== undefined || previewPlanActive) ? { attachEvenWithoutPropose: true as const } : {}),
  };
  const textReady = !snapshotIsEmpty(draft);
  const sessionStreaming = executionMatches && Boolean(snapshot?.isStreaming);
  const pendingPrompt = convo.state.pendingUsers.some((entry) => entry.status === "pending");
  const promptFailed = convo.state.pendingUsers.some((entry) => entry.status === "failed") && !pendingPrompt;
  const [retryCancelGeneration, setRetryCancelGeneration] = useState(0);
  useEffect(() => {
    setRetryCancelGeneration(0);
  }, [convo.identityKey]);
  const awaitingTurn = useAwaitingTurn({
    sending,
    pending: pendingPrompt,
    streaming: sessionStreaming,
    failed: promptFailed,
    identityKey: convo.identityKey,
  });
  const activityRetry = useActivityRetry({
    notices: convo.state.notices,
    streaming: sessionStreaming,
    failed: promptFailed,
    identityKey: convo.identityKey,
    cancelGeneration: retryCancelGeneration,
  });
  // Composer / abort / queue flush are write surfaces: follow the live Runtime,
  // including the send → isStreaming snapshot gap. Preview must not replace this
  // with the t1 demo story or the stop button appears while core.abort stays gated.
  const retrying = executionMatches && activityRetry !== undefined;
  const running = sessionStreaming || (executionMatches && awaitingTurn) || retrying;
  const abortEligible = isAbortEligible({
    executionMatches,
    streaming: sessionStreaming,
    pendingMessages: snapshot?.pendingMessages ?? 0,
    awaiting: awaitingTurn,
    retrying,
  });
  const abortAllowed = !gated && abortEligible && can("core.abort");
  const activityStatus = useMemo(
    () => (preview
      ? (previewThreadId === "t1" ? PREVIEW_RUN_ACTIVITY.status : null)
      : deriveActivityStatus({
          state: convo.state,
          streaming: sessionStreaming,
          pendingMessages: snapshot?.pendingMessages ?? 0,
          awaiting: executionMatches && awaitingTurn,
          ...(activityRetry === undefined ? {} : { retry: activityRetry }),
        })),
    [activityRetry, awaitingTurn, convo.state, executionMatches, preview, previewThreadId, sessionStreaming, snapshot?.pendingMessages],
  );
  const runWindowKey = preview ? `preview:${previewThreadId ?? ""}` : convo.identityKey;
  const runWindow = useRunWindow(activityStatus !== null, runWindowKey);
  const activity = activityStatus === null || sessionCreating === true
    ? undefined
    : {
        status: activityStatus,
        ...(runWindow.startedAt === null ? {} : { startedAt: runWindow.startedAt }),
        ...(preview ? { demo: true } : {}),
      };
  useEffect(() => {
    if (running) setComposerExpanded(false);
  }, [running]);
  useLayoutEffect(() => {
    if (running && !composerExpanded) {
      document.getElementById("composerInput")?.scrollTo({ top: 0 });
    }
  }, [composerExpanded, running]);
  // ---- 分支动作：run 进行中或有 pending interaction 时排队，本轮结束再执行 ----
  const branchActionDeferred = running || pendingInteraction !== null;
  const performBranchSwitch = useCallback(async (name: string) => {
    if (gitWorkspaceId === undefined || branchSwitchName !== undefined) return;
    setBranchSwitchName(name);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: gitWorkspaceId,
        operation: { kind: "branch.switch", name },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      setBranchNotice({ tone: "ok", text: `已切换到 ${name}` });
    } catch (cause) {
      const blocked = switchBlockedFilesOf(cause);
      if (blocked !== undefined) {
        setSwitchBlock({ branch: name, files: blocked });
        setSwitchCommitError(undefined);
      } else {
        setBranchNotice({ tone: "error", text: hostErrorMessage(cause, "切换分支失败") });
      }
    } finally {
      setBranchSwitchName(undefined);
      void realGit.refresh();
      if (realGit.repository?.isRepository) void loadBranches();
    }
  }, [branchSwitchName, client, gitWorkspaceId, loadBranches, realGit.refresh, realGit.repository?.isRepository]);
  const performBranchCreate = useCallback(async (name: string) => {
    if (gitWorkspaceId === undefined) return;
    setBranchSwitchName(name);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: gitWorkspaceId,
        operation: { kind: "branch.create", name, checkout: true },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      setBranchNotice({ tone: "ok", text: `已创建并切换到 ${name}` });
      void loadBranches();
    } catch (cause) {
      setBranchNotice({ tone: "error", text: hostErrorMessage(cause, "创建分支失败") });
    } finally {
      setBranchSwitchName(undefined);
      void realGit.refresh();
    }
  }, [client, gitWorkspaceId, loadBranches, realGit.refresh]);
  const requestBranchSwitch = (name: string) => {
    setContextBranchMenuOpen(false);
    if (pendingBranchAction?.kind === "switch" && pendingBranchAction.name === name) {
      setPendingBranchAction(undefined);
      setBranchNotice({ tone: "ok", text: `已取消切换到 ${name}` });
      return;
    }
    if (branchActionDeferred) {
      setPendingBranchAction({ kind: "switch", name });
      setBranchNotice({ tone: "ok", text: `本轮对话结束后将切换到 ${name}` });
      return;
    }
    void performBranchSwitch(name);
  };
  const createBranch = async () => {
    const name = createBranchName.trim();
    if (!name || createBranchBusy || gitWorkspaceId === undefined) return;
    if (branchActionDeferred) {
      setCreateBranchOpen(false);
      setPendingBranchAction({ kind: "create", name });
      setBranchNotice({ tone: "ok", text: `本轮对话结束后将创建并切换到 ${name}` });
      return;
    }
    setCreateBranchError(undefined);
    setCreateBranchBusy(true);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: gitWorkspaceId,
        operation: { kind: "branch.create", name, checkout: true },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      setCreateBranchOpen(false);
      setBranchNotice({ tone: "ok", text: `已创建并切换到 ${name}` });
      void loadBranches();
    } catch (cause) {
      setCreateBranchError(hostErrorMessage(cause, "创建分支失败"));
    } finally {
      setCreateBranchBusy(false);
      void realGit.refresh();
    }
  };
  useEffect(() => {
    if (branchActionDeferred || pendingBranchAction === undefined) return;
    const action = pendingBranchAction;
    setPendingBranchAction(undefined);
    if (action.kind === "switch") void performBranchSwitch(action.name);
    else void performBranchCreate(action.name);
  }, [branchActionDeferred, pendingBranchAction, performBranchCreate, performBranchSwitch]);
  // ---- 切换被未提交改动挡住：提交列出的文件后重试切换 ----
  const cancelSwitchBlock = () => {
    if (switchCommitBusy) return;
    const branch = switchBlock?.branch;
    setSwitchBlock(undefined);
    setSwitchCommitMessage("");
    setSwitchCommitError(undefined);
    if (branch !== undefined) setBranchNotice({ tone: "ok", text: `已取消切换到 ${branch}` });
  };
  const submitSwitchCommit = async () => {
    const block = switchBlock;
    const message = switchCommitMessage.trim();
    if (!block || !message || switchCommitBusy || gitWorkspaceId === undefined) return;
    setSwitchCommitBusy(true);
    setSwitchCommitError(undefined);
    try {
      // 未跟踪文件要先 add 才能 commit --only；已跟踪文件交给 --only 提交工作区内容。
      const paths = block.files.map((file) => file.path);
      const untracked = paths.filter((path) => realGit.repository?.changes.some((change) => change.path === path && change.worktree === "untracked") === true);
      if (untracked.length > 0) {
        const stageHandle = await client.command("git.execute", { workspaceId: gitWorkspaceId, operation: { kind: "stage", paths: untracked } });
        await waitReceipt<GitOperationResult>(client, stageHandle.requestId, 60_000);
      }
      const commitHandle = await client.command("git.execute", { workspaceId: gitWorkspaceId, operation: { kind: "commit", message, paths } });
      await waitReceipt<GitOperationResult>(client, commitHandle.requestId, 60_000);
      setSwitchBlock(undefined);
      setSwitchCommitMessage("");
      await performBranchSwitch(block.branch);
    } catch (cause) {
      setSwitchCommitError(hostErrorMessage(cause, "提交失败"));
      void realGit.refresh();
    } finally {
      setSwitchCommitBusy(false);
    }
  };
  // Approval mode pill (plan §5.5): preview is local chrome (same as the
  // mode picker). Live matching session is a read-only view of the Runtime
  // snapshot — never optimistic. History threads that are not the live
  // Runtime yet stay clickable: selecting a mode resumes then sets.
  // A live turn stays clickable; Runtime applies the write on the next prompt.
  const approvalMode: ApprovalMode = preview
    ? previewApprovalMode
    : executionMatches
      ? (snapshot?.approvalMode ?? "yolo")
      : "yolo";
  const approvalIndeterminate = !preview && !executionMatches;
  const approvalNextTurnOnly =
    !preview &&
    executionMatches &&
    (snapshot?.isStreaming === true || snapshot?.isCompacting === true || pendingInteraction !== null);
  const approvalDisabled = approvalPickerDisabled({
    preview,
    executionMatches,
    runtimeConnected,
    snapshotReady,
    canSet: can("permissions.mode.set"),
    resyncRequired: Boolean(connection?.resyncRequired),
    ...(selectedSessionId === undefined ? {} : { selectedSessionId }),
    ...(selectedThreadId === undefined ? {} : { selectedThreadId }),
  });
  const promptTargetReady = executionMatches
    ? runtimeConnected && snapshotReady
    : !preview && selectedSessionId !== undefined && selectedThreadId !== undefined;
  // prompt 通道可用性（与会话目标、连接、能力相关，与是否流式无关）：
  // 直接发送与流式期间的本地排队共用同一组闸门。
  const promptChannelReady =
    !busy &&
    !connection?.resyncRequired &&
    !sending &&
    sessionCreating !== true &&
    promptTargetReady &&
    can("core.prompt");
  const promptEnabled = composerPromptEnabled({
    textReady,
    running,
    pendingInteraction: pendingInteraction !== null,
    promptChannelReady,
    sessionCreating,
  });
  const slashExecuteReady = composerSlashExecute(draft) !== undefined;
  const testRerunDisabled = !promptChannelReady || running || pendingInteraction !== null;
  const testRerunTitle = running
    ? "进行中"
    : pendingInteraction !== null
      ? "先处理询问"
      : promptChannelReady
        ? "重跑"
        : "未就绪";
  // 流式期间 Enter 不再禁用：消息进本地排队栏，本轮结束后自动发送。
  // 想纠偏就在排队栏里点「插入纠偏」，走 core.steer 打断当前回合。
  const queueEnabled = composerQueueEnabled({ textReady, running, promptChannelReady });
  const followUpChannelReady =
    !busy &&
    !connection?.resyncRequired &&
    !sending &&
    sessionCreating !== true &&
    promptTargetReady &&
    can("core.followUp");
  const followUpEnabled = composerFollowUpEnabled({
    textReady,
    running,
    pendingInteraction: pendingInteraction !== null,
    followUpChannelReady,
  });
  const steerNowEnabled =
    !sending && sessionCreating !== true && promptTargetReady && !connection?.resyncRequired && can("core.steer");
  const restorePending = (requestId: string) => {
    const pending = convo.state.pendingUsers.find((entry) => entry.requestId === requestId);
    if (!pending) return;
    const restored = pending.doc !== undefined ? snapshotFromDoc(pending.doc) : snapshotFromText(pending.draft);
    setDraft(restored);
    composerInputRef.current?.setSnapshot(restored);
    setComposerError(undefined);
    convo.dropPending(requestId);
  };
  const applyComposerFill = (fill: UserMessageEditorFill) => {
    const restored = snapshotFromTextAndImages(fill.text ?? "", fill.images);
    setDraft(restored);
    composerInputRef.current?.setSnapshot(restored);
    setComposerError(undefined);
    queueMicrotask(() => composerInputRef.current?.focus());
  };
  const clearTreeQueued = () => {
    setQueueEdit(undefined);
    if (preview) {
      setPreviewQueue([]);
      return;
    }
    const sessionId = selectedTargetRef.current.selectedSessionId;
    setQueuedMessages((queue) =>
      queue.filter((entry) => visibleQueuedMessages([entry], sessionId).length === 0),
    );
  };
  const editorFillFromOutcome = (outcome: SessionTreeCommandOutcome): UserMessageEditorFill => ({
    ...(outcome.editorText === undefined ? {} : { text: outcome.editorText }),
    ...(outcome.editorImages === undefined || outcome.editorImages.length === 0
      ? {}
      : { images: outcome.editorImages }),
  });
  const invokeTreeCommand = async (
    name: "session.tree.navigate" | "session.tree.branch",
    targetId: string,
  ): Promise<SessionTreeCommandOutcome | undefined> => {
    if (busy) return undefined;
    setBusy(true);
    try {
      const handle = await client.command(name, { targetId });
      const outcome = await waitReceipt<SessionTreeCommandOutcome>(client, handle.requestId);
      setComposerError(undefined);
      return outcome;
    } catch (error) {
      const message = hostErrorMessage(error, name === "session.tree.branch" ? "新建会话失败" : "恢复失败");
      if (isTransientStatusNotice(message)) {
        const claimed = claimTransientToast(transientStatusFamily(message), lastStatusToast.current);
        lastStatusToast.current = claimed.next;
        if (claimed.show) setStatusToast(message);
        return undefined;
      }
      setComposerError(message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const userRestoreDisabledReason = userMessageRestoreDisabledReason({
    preview,
    running,
    compacting: snapshot?.isCompacting === true,
    resyncRequired: Boolean(connection?.resyncRequired) || convo.state.resyncRequired,
    sessionCreating: sessionCreating === true,
    gated: !preview && gated,
    canNavigateTree: can("session.tree"),
  });
  const restoreUserMessage = (itemId: string, text: string) => {
    if (userRestoreDisabledReason !== undefined) return;
    void executeUserMessageRestore({
      preview,
      itemId,
      text,
      confirm: () => treeConfirm.ask("restore"),
      restorePreview: (targetId) => convoRef.current.restoreFromUser(targetId),
      navigate: async (targetId) => {
        const outcome = await invokeTreeCommand("session.tree.navigate", targetId);
        if (outcome === undefined || outcome.cancelled === true) return undefined;
        return editorFillFromOutcome(outcome);
      },
      reload: () => convoRef.current.reload(),
      fillComposer: applyComposerFill,
      clearQueued: clearTreeQueued,
    });
  };
  const branchUserMessage = (itemId: string, text: string) => {
    if (userRestoreDisabledReason !== undefined) return;
    void executeUserMessageBranch({
      preview,
      itemId,
      text,
      confirm: () => treeConfirm.ask("branch"),
      restorePreview: (targetId) => convoRef.current.restoreFromUser(targetId),
      branch: async (targetId) => {
        const outcome = await invokeTreeCommand("session.tree.branch", targetId);
        if (outcome === undefined || outcome.cancelled === true) return undefined;
        return {
          ...editorFillFromOutcome(outcome),
          ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
        };
      },
      selectSession: async (sessionId) => (onBranchedSession === undefined ? false : onBranchedSession(sessionId)),
      reload: () => convoRef.current.reload(),
      fillComposer: applyComposerFill,
      stashComposerFill: (sessionId, fill) => {
        pendingComposerFillRef.current = { sessionId, fill };
      },
      clearQueued: clearTreeQueued,
      onPreviewDone: () => setStatusToast("演示：已从这条消息新建会话（未调用 Host）"),
    });
  };
  const promptInputOf = (payload: ComposerSnapshot): { text: string; images?: PromptImageInput[] } => {
    const text = injectMagicKeyword(payload.text.trim(), magicKeyword);
    return payload.images.length === 0 ? { text } : { text, images: [...payload.images] };
  };
  // sendPrompt 与排队 flush 共用的发送路径。失败时置 composerError 并返回 false，
  // 草稿恢复方式由调用方决定（输入框草稿回填 vs 排队条目回队）。
  const dispatchPrompt = async (payload: ComposerSnapshot, options?: { readonly asFollowUp?: boolean }): Promise<boolean> => {
    const plan = planComposerSend(payload);
    let outboundPayload = payload;
    const targetSessionId = selectedSessionId as SessionId | undefined;
    const targetThreadId = selectedThreadId;
    setComposerSubmitted(true);
    setSending(true);
    try {
      if (plan.kind === "execute") {
        if (options?.asFollowUp === true && running) {
          setComposerError("当前回合进行中，斜杠指令请等结束后再发。");
          return false;
        }
        return await runSlashCommand(plan.command, plan.args);
      }
      if (plan.kind === "apply-then-prompt") {
        for (const step of plan.apply) {
          const ok = await runSlashCommand(step.command, step.args);
          if (!ok) return false;
        }
        if (snapshotIsEmpty(plan.snapshot) && plan.snapshot.images.length === 0) return true;
        outboundPayload = plan.snapshot;
      }
      if (plan.kind === "follow-up") {
        outboundPayload = plan.snapshot;
      }
      const trimmed = outboundPayload.text.trim();
      if (!trimmed && outboundPayload.images.length === 0) return false;
      const resumed = targetSessionId !== undefined && snapshot?.sessionId !== targetSessionId;
      await ensureSelectedSessionActive(client, {
        ...(snapshot?.sessionId === undefined ? {} : { activeSessionId: snapshot.sessionId }),
        ...(targetSessionId === undefined ? {} : { selectedSessionId: targetSessionId }),
        ...(targetThreadId === undefined ? {} : { selectedThreadId: targetThreadId }),
      });
      const currentTarget = selectedTargetRef.current;
      if (
        currentTarget.selectedSessionId !== targetSessionId ||
        currentTarget.selectedThreadId !== targetThreadId
      ) {
        throw { code: "STATE_VERSION_CONFLICT", message: "发送期间已切换会话，本次发送已取消，草稿已恢复。" };
      }
      if (resumed) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const outbound = promptInputOf(outboundPayload);
      const commandName = options?.asFollowUp === true || plan.kind === "follow-up" ? "core.followUp" : "core.prompt";
      const handle = await client.command(commandName, outbound);
      const pendingConvo = convoRef.current;
      pendingConvo.trackPending({
        requestId: handle.requestId,
        text: outbound.text,
        draft: payload.text,
        status: "pending",
        knownItemIds: pendingConvo.state.items.map((item) => item.itemId),
        doc: outboundPayload.doc,
      });
      promptUnsub.current?.();
      const watchReceipt = () => {
        const commands = client.getState?.()?.commands;
        if (commands === undefined) return;
        const receipt = selectComposerReceipt(commands, handle.requestId);
        if (
          receipt.phase === "pending" ||
          receipt.phase === "accepted" ||
          receipt.phase === "unknown" ||
          receipt.phase === "interaction_required"
        ) {
          return;
        }
        promptUnsub.current?.();
        promptUnsub.current = undefined;
        if (receipt.phase === "completed") return;
        if (receipt.phase === "failed") {
          pendingConvo.failPending(handle.requestId, receipt.error.message);
          return;
        }
        pendingConvo.failPending(handle.requestId, receipt.reason);
      };
      promptUnsub.current = client.onState
        ? client.onState(() => watchReceipt())
        : client.subscribe({ scope: "command", requestId: handle.requestId }, () => watchReceipt());
      watchReceipt();
      if (!preview) onSessionTitleMaybeChanged?.();
      return true;
    } catch (error) {
      setComposerError(hostErrorMessage(error, "发送失败"));
      return false;
    } finally {
      setSending(false);
    }
  };
  const sendPrompt = async () => {
    const payload = composerInputRef.current?.getSnapshot() ?? draft;
    if (!promptEnabled && composerSlashExecute(payload) === undefined) return;
    setComposerError(undefined);
    composerInputRef.current?.clear();
    setDraft(emptySnapshot());
    if (waitForNewSession !== undefined) {
      const ready = await waitForNewSession();
      if (!ready) {
        setDraft(payload);
        composerInputRef.current?.setSnapshot(payload);
        return;
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    if (!(await dispatchPrompt(payload))) {
      setDraft(payload);
      composerInputRef.current?.setSnapshot(payload);
    }
  };
  const sendFollowUp = async () => {
    if (!followUpEnabled) return;
    setComposerError(undefined);
    const payload = composerInputRef.current?.getSnapshot() ?? draft;
    composerInputRef.current?.clear();
    setDraft(emptySnapshot());
    if (!(await dispatchPrompt(payload, { asFollowUp: true }))) {
      setDraft(payload);
      composerInputRef.current?.setSnapshot(payload);
    }
  };
  const takeComposerSnapshot = (): ComposerSnapshot => composerInputRef.current?.getSnapshot() ?? draft;
  const queueEntryOf = (payload: ComposerSnapshot, id: number): QueuedMessage => ({
    id,
    text: payload.text,
    ...(payload.images.length > 0 ? { images: payload.images } : {}),
    doc: payload.doc,
    ...(selectedSessionId === undefined ? {} : { sessionId: selectedSessionId }),
  });
  const snapshotOfEntry = (entry: QueuedMessage): ComposerSnapshot => snapshotOfQueued(entry);
  const activeQueue = (): QueuedMessage[] => (preview ? previewQueue : queuedMessages);
  const applyQueueEditResult = (result: {
    readonly queue: readonly QueuedMessage[];
    readonly editing: QueueEditState | undefined;
    readonly composer: ComposerSnapshot;
  }) => {
    if (preview) setPreviewQueue([...result.queue]);
    else setQueuedMessages([...result.queue]);
    setQueueEdit(result.editing);
    setDraft(result.composer);
    composerInputRef.current?.setSnapshot(result.composer);
    setComposerError(undefined);
  };
  const commitQueuedEdit = () => {
    if (queueEdit === undefined) return;
    applyQueueEditResult(commitQueueEdit({
      queue: activeQueue(),
      editing: queueEdit,
      composer: takeComposerSnapshot(),
    }));
  };
  const cancelQueuedEdit = () => {
    if (queueEdit === undefined) return;
    applyQueueEditResult(cancelQueueEdit({ queue: activeQueue(), editing: queueEdit }));
    composerInputRef.current?.focus();
  };
  // ---- 流式期间 Enter 的本地排队栏：编辑留在原位、Composer 内改、立刻发送 / 删除；run 结束后自动 flush ----
  const enqueueDraft = () => {
    if (queueEdit !== undefined) {
      commitQueuedEdit();
      return;
    }
    const payload = takeComposerSnapshot();
    if (snapshotIsEmpty(payload)) return;
    if (preview) {
      previewQueueSeqRef.current += 1;
      setPreviewQueue((queue) => [...queue, queueEntryOf(payload, previewQueueSeqRef.current)]);
      composerInputRef.current?.clear();
      setDraft(emptySnapshot());
      setComposerError(undefined);
      return;
    }
    if (!queueEnabled) return;
    queuedSeqRef.current += 1;
    setQueuedMessages((queue) => [...queue, queueEntryOf(payload, queuedSeqRef.current)]);
    composerInputRef.current?.clear();
    setDraft(emptySnapshot());
    setComposerError(undefined);
  };
  const editQueuedMessage = (entry: QueuedMessage) => {
    const composer = takeComposerSnapshot();
    const queue = activeQueue();
    if (queueEdit?.entryId === entry.id) {
      composerInputRef.current?.focus();
      return;
    }
    const result = queueEdit === undefined
      ? beginQueueEdit({ queue, composer, entry })
      : switchQueueEdit({ queue, editing: queueEdit, composer, entry });
    applyQueueEditResult(result);
    composerInputRef.current?.focus();
  };
  const removeQueuedMessage = (entry: QueuedMessage) => {
    if (queueEdit?.entryId === entry.id) {
      applyQueueEditResult(cancelQueueEdit({ queue: activeQueue(), editing: queueEdit }));
    }
    if (preview) setPreviewQueue((queue) => queue.filter((item) => item.id !== entry.id));
    else setQueuedMessages((queue) => queue.filter((item) => item.id !== entry.id));
  };
  // 「插入纠偏」：流式走 core.steer，打断当前回合（当前工具跑完后跳过尚未开始的
  // 调用，立刻处理这条）。空闲时等价于直接 prompt。预览模式只从本地列表移除。
  const sendQueuedNow = async (entry: QueuedMessage) => {
    let target = entry;
    if (queueEdit?.entryId === entry.id) {
      const result = commitQueueEdit({
        queue: activeQueue(),
        editing: queueEdit,
        composer: takeComposerSnapshot(),
      });
      applyQueueEditResult(result);
      const updated = result.queue.find((item) => item.id === entry.id);
      if (updated === undefined) return;
      target = updated;
    }
    if (preview) {
      setPreviewQueue((queue) => queue.filter((item) => item.id !== target.id));
      return;
    }
    if (sending) return;
    setComposerError(undefined);
    if (!running) {
      if (busy) return;
      setQueuedMessages((queue) => queue.filter((item) => item.id !== target.id));
      if (!(await dispatchPrompt(snapshotOfEntry(target)))) {
        setQueuedMessages((queue) => [{ ...target }, ...queue]);
      }
      return;
    }
    if (!steerNowEnabled) return;
    setSending(true);
    try {
      const planned = planComposerSend(snapshotOfEntry(target));
      if (planned.kind === "execute") {
        setComposerError("当前回合进行中，斜杠指令请等结束后再发。");
        return;
      }
      let outboundPayload = snapshotOfEntry(target);
      if (planned.kind === "apply-then-prompt") {
        for (const step of planned.apply) {
          const ok = await runSlashCommand(step.command, step.args);
          if (!ok) return;
        }
        outboundPayload = planned.snapshot;
      } else {
        outboundPayload = planned.snapshot;
      }
      const outbound = promptInputOf(outboundPayload);
      const handle = await client.command("core.steer", outbound);
      const pendingConvo = convoRef.current;
      pendingConvo.trackPending({
        requestId: handle.requestId,
        text: outbound.text,
        draft: target.text,
        status: "pending",
        knownItemIds: pendingConvo.state.items.map((item) => item.itemId),
        doc: outboundPayload.doc,
      });
      await waitReceipt(client, handle.requestId);
      setQueuedMessages((queue) => queue.filter((item) => item.id !== target.id));
      if (!preview) onSessionTitleMaybeChanged?.();
    } catch (error) {
      setComposerError(hostErrorMessage(error, "纠偏失败"));
    } finally {
      setSending(false);
    }
  };
  // run 结束（且无 pending interaction）后按序 flush：一次发一条，等下一个 run 结束再发
  // 下一条；busyRef 防 receipt→isStreaming 间隙内的重复触发。发送成功但新 run 瞬间完成
  //（running 仍为 false）时靠 tick 继续排水；失败回队后设冷却窗口，防止快速持续失败
  // （如会话切换冲突）被重新入队的依赖变化立刻重触发而形成热重试循环。
  useEffect(() => {
    const head = queuedMessages.find((entry) => entry.sessionId === selectedSessionId);
    if (
      head === undefined ||
      queueFlushBusyRef.current ||
      !canFlushQueuedMessage({
        running,
        pendingInteraction: pendingInteraction !== null,
        promptChannelReady,
        entryId: head.id,
        ...(queueEdit === undefined ? {} : { pausedEntryId: queueEdit.entryId }),
        ...(selectedSessionId === undefined ? {} : { selectedSessionId }),
        ...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId }),
        ...(head.sessionId === undefined ? {} : { entrySessionId: head.sessionId }),
      })
    ) {
      return;
    }
    const retryDelay = queueRetryAtRef.current - Date.now();
    if (retryDelay > 0) {
      const timer = window.setTimeout(() => setQueueFlushTick((tick) => tick + 1), retryDelay);
      return () => window.clearTimeout(timer);
    }
    queueFlushBusyRef.current = true;
    setQueuedMessages((queue) => queue.filter((item) => item.id !== head.id));
    void (async () => {
      let sent = false;
      try {
        sent = await dispatchPrompt(snapshotOfEntry(head));
        if (!sent) {
          queueRetryAtRef.current = Date.now() + 1500;
          setQueuedMessages((queue) => [{ ...head }, ...queue]);
        }
      } finally {
        queueFlushBusyRef.current = false;
        if (sent) window.setTimeout(() => setQueueFlushTick((tick) => tick + 1), 300);
      }
    })();
    // dispatchPrompt 每渲染重建（与 sendPrompt 同风格），effect 触发时同步快照队列头，
    // 不进依赖以免每次渲染都重启 flush。
  }, [running, pendingInteraction, promptChannelReady, queuedMessages, queueFlushTick, selectedSessionId, snapshot?.sessionId, queueEdit]);
  // 一次有界遍历后本地过滤，`@` 的每次击键不再回打 Host；换项目才重建索引。
  const fileIndex = useMemo(
    () => (preview || workspaceId === undefined
      ? undefined
      : createWorkspaceFileIndex(workspaceDirectoryLister(client, workspaceId as WorkspaceId))),
    [preview, client, workspaceId],
  );
  const fetchMentions = useCallback(async (trigger: "@" | "/", query: string) => {
    if (trigger === "/") return [];
    if (preview) return previewMentions(trigger, query);
    try {
      return await loadMentions(client, trigger, query, fileIndex);
    } catch {
      return [];
    }
  }, [preview, client, fileIndex]);
  function openChanges(focus?: { path?: string; turnId?: string }): void {
    if (focus !== undefined) {
      setChangesFocus((prev) => ({
        key: prev.key + 1,
        ...(focus.path === undefined ? {} : { path: focus.path }),
        ...(focus.turnId === undefined ? {} : { turnId: focus.turnId }),
      }));
    }
    onOpenChanges();
  }
  function openSlashUi(ui: SlashNativeUi): void {
    if (ui === "model-picker") {
      setModelMenuNonce((value) => value + 1);
      return;
    }
    if (ui === "mode-picker") {
      setModeOpenToggles(false);
      setModeMenuNonce((value) => value + 1);
      return;
    }
    if (ui === "mode-toggles") {
      setModeOpenToggles(true);
      setModeMenuNonce((value) => value + 1);
      return;
    }
    if (ui === "plan-review") {
      if (preview || snapshot?.plan?.status === "review") {
        setPlanDialogOpen(true);
        return;
      }
      if (snapshot?.plan?.status === "active" || snapshot?.plan?.status === "paused") {
        void run("mode.plan.review.open", {});
        return;
      }
      if (planView !== undefined) {
        setPlanDialogOpen(true);
        return;
      }
      if (!preview) void run("mode.plan.review.open", {});
      return;
    }
    if (ui === "session-tree") {
      openChanges();
      return;
    }
    if (ui === "user-message-branch") {
      setStatusToast("请在一条用户消息上点「新会话」");
      return;
    }
    onSlashUi(ui);
  }
  useEffect(() => {
    const ui = takeSlashUiIntent();
    if (ui !== undefined) openSlashUi(ui);
  }, []);
  async function runSlashCommand(command: StudioSlashCommand, args: string): Promise<boolean> {
    if (command.availability === "disabled") {
      setComposerError(command.disabledReason ?? `/${command.name} 暂不可用`);
      return false;
    }
    const destructive = command.risk === "destructive" || isDestructiveMemoryClear(command, args);
    if (destructive && !preview && !window.confirm(`确定执行 /${command.name}${args ? ` ${args}` : ""}？此操作会改会话状态。`)) {
      return false;
    }
    const execute = resolveSlashExecute(command, args);
    if (execute.kind === "none") return false;
    if (execute.kind === "native-ui") {
      openSlashUi(execute.ui);
      return true;
    }
    /* BTW 不走通用 run()：ask 的回执带着 branchToken，那是唯一能拿到它的地方，
       而 run() 只回报成败。同时把浮窗唤起来，placement 保持上次的偏好。
       预览开时同样走这条路径：打开演示浮窗，问题用输入框里的原文，不调 Host。 */
    if (execute.kind === "typed" && execute.name === "btw.ask") {
      const question = typeof execute.input.question === "string" ? execute.input.question : args.trim();
      btwWindow.show();
      if (preview) {
        onBtwPreviewAsk();
        if (question.length === 0) return true;
      }
      return await btwSession.ask(question);
    }
    if (preview) {
      setStatusToast(`演示：/${command.name}${args ? ` ${args}` : ""}`);
      return true;
    }
    if (execute.kind === "typed") {
      const bound = bindSlashTypedCommand(execute, selectedThreadId === undefined ? {} : { threadId: selectedThreadId });
      if (!bound.ok) {
        setComposerError(bound.error);
        return false;
      }
      return run(bound.name, bound.input as CommandInput<CommandName>);
    }
    if (execute.kind === "invoke") {
      const compacting = execute.commandId === "builtin.compact";
      if (compacting) onCompactPending?.(true);
      try {
        const handle = await client.command("operator.invoke", {
          commandId: execute.commandId,
          ...(execute.arguments ? { arguments: execute.arguments } : {}),
        });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        const failed = compacting ? outcome.output.find((item) => /compaction failed/i.test(item)) : undefined;
        const line = failed ?? outcome.output.find((item) => item.trim().length > 0);
        setStatusToast(line ?? `已执行 /${command.name}`);
        setComposerError(undefined);
        return true;
      } catch (error) {
        setComposerError(hostErrorMessage(error, `/${command.name} 失败`));
        return false;
      } finally {
        if (compacting) onCompactPending?.(false);
      }
    }
    return false;
  }
  return (
    <>
      <div className={`workbench${sideOpen ? " split-right" : ""}`} id="workbench">
        <div className={`convo-wrap${showWelcome ? " is-empty" : ""}`}>
          <ConversationPane
            snapshot={convo}
            onLoadOlder={convo.loadOlder}
            onRestore={restorePending}
            onRestoreUserMessage={restoreUserMessage}
            onBranchUserMessage={branchUserMessage}
            {...(userRestoreDisabledReason === undefined ? {} : { userRestoreDisabledReason })}
            scrollerRef={convoScrollerRef}
            onReviewChanges={(turnId) => openChanges({ turnId })}
            planLink={planLink}
            compacting={compactingNow}
            onInspectSubagent={(target) => {
              setInspectTarget(target);
            }}
            {...(activity === undefined ? {} : { activity })}
            {...(showWelcome ? { forceWelcome: true } : {})}
            {...(showWelcome ? {
              welcome: (
                <ConversationEmpty
                  client={client}
                  {...(state.model.history === undefined ? {} : { history: state.model.history })}
                  projectName={contextProjectName}
                  {...(snapshot?.isStreaming === true && snapshot.sessionId !== undefined ? { runningSessionId: snapshot.sessionId } : {})}
                  {...(pendingInteraction?.sessionId === undefined ? {} : { waitingSessionId: pendingInteraction.sessionId })}
                  {...(hiddenPreviewThreads === undefined ? {} : { hiddenPreviewThreadIds: hiddenPreviewThreads })}
                  {...(onSelectThread === undefined ? {} : { onSelectThread })}
                  {...(onSelectPreviewThread === undefined ? {} : { onSelectPreviewThread })}
                  onOpenHistory={() => onRoute("history")}
                />
              ),
            } : {})}
          />
          <ConversationMinimap rows={sessionCreating === true ? [] : convo.rows} scrollerRef={convoScrollerRef} preview={preview} />
          <div className="composer-region">
            {/* 真实 pending Interaction 永远优先；预览关时 Plan Review 走 snapshot；预览开才用演示 Deck。 */}
            {deckInteraction ? (
              <InteractionDeck
                interaction={deckInteraction}
                onRespond={respond}
                disabled={interactionDisabled}
                {...(askDeckLeaving ? { leaving: true } : {})}
              />
            ) : planReview ? (
              <PlanReviewDeck
                title={planReview.title ?? "Plan"}
                body={planReview.body ?? ""}
                expanded={planDialogOpen}
                onExpandedChange={setPlanDialogOpen}
                originRef={planDialogOriginRef}
                {...(planReviewDisabled ? { disabled: true } : {})}
                onAction={(id, detail) => { void respondPlanReview(id, detail); }}
              />
            ) : preview && previewThreadId === "t3" ? (
              <PreviewDeck
                onCurrentKind={(kind) => {
                  setPreviewDeckKind(kind);
                  onPreviewDeckWait?.(kind ?? undefined);
                }}
                planExpanded={planDialogOpen}
                onPlanExpandedChange={setPlanDialogOpen}
                planOriginRef={planDialogOriginRef}
              />
            ) : null}
            {!preview && planReview === undefined && planDialogOpen && planView !== undefined ? (
              <PlanViewDialog
                title={planView.title}
                body={planView.body}
                originRef={planDialogOriginRef}
                onClose={() => setPlanDialogOpen(false)}
              />
            ) : null}
            {sessionCreating !== true && (taskProgress.todos.length > 0 || taskProgress.files.length > 0) ? (
              <TaskProgressDock
                todos={taskProgress.todos}
                files={taskProgress.files}
                {...(preview ? { demo: true } : {})}
                onReview={() => openChanges({ turnId: SESSION_CHANGE_LAST_ID })}
                onOpen={(path) => openChanges({ path })}
              />
            ) : null}
            {inspectTarget === null ? null : (
              <SubagentInspectCard
                target={inspectTarget}
                preview={preview}
                client={preview ? null : conversationClient}
                sendClient={preview ? null : client}
                agents={snapshot?.agents ?? []}
                canSend={can("agent.send")}
                runtimeConnected={runtimeConnected}
                {...(workspaceId === undefined ? {} : { workspaceId })}
                loadMentions={fetchMentions}
                onClose={() => setInspectTarget(null)}
                onOpenHub={(agentId) => {
                  setHubIntent(agentId, "chat");
                  setInspectTarget(null);
                  onRoute("agent-hub");
                }}
              />
            )}
            {showContextStrip ? <div className="ctx-strip" role="status" aria-live="polite">
              <span className="ctx-project-wrap">
                <button
                  type="button"
                  className="ctx-item ctx-project-switch"
                  aria-haspopup="menu"
                  aria-expanded={contextProjectMenuOpen}
                  onClick={() => setContextProjectMenuOpen((open) => { if (!open) setContextBranchMenuOpen(false); return !open; })}
                  data-tip="项目"
                >
                  <Icon name="folder-open" extra="sm" />
                  <span>{contextProjectName}</span>
                  <Icon name="chevron-d" extra="sm" />
                </button>
                {contextProjectMenuOpen ? (
                  <>
                    <button className="ctx-project-backdrop" aria-label="关闭项目菜单" onClick={() => setContextProjectMenuOpen(false)} />
                    <div className="menu ctx-project-menu" role="menu" aria-label="切换项目">
                      <label className="ctx-project-search">
                        <Icon name="search" extra="sm" />
                        <span className="sr-only">搜索项目</span>
                        <input
                          autoFocus
                          value={contextProjectQuery}
                          placeholder="搜索项目"
                          onChange={(event) => setContextProjectQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setContextProjectMenuOpen(false);
                          }}
                        />
                      </label>
                      <div className="ctx-project-list">
                      {previewCreatedProject && previewCreatedProject.name.toLocaleLowerCase().includes(normalizedProjectQuery) ? (
                        <MenuItem icon="folder-open" current hint="演示">{previewCreatedProject.name}</MenuItem>
                      ) : null}
                      {preview ? previewProjectOptions.map((project) => (
                        <MenuItem
                          key={project.id}
                          icon="folder-open"
                          current={!previewCreatedProject && project.id === previewProjectId}
                          hint={!previewCreatedProject && project.id === previewProjectId ? "当前" : project.branch}
                          onClick={() => {
                            setContextProjectMenuOpen(false);
                            setPreviewCreatedProject(null);
                            onSelectPreviewProject(project.id);
                          }}
                        >{project.name}</MenuItem>
                      )) : workspaceOptions.map((workspace) => (
                        <MenuItem
                          key={workspace.workspaceId}
                          icon="folder-open"
                          current={workspace.active}
                          {...(workspace.active ? { hint: "当前" } : {})}
                          onClick={() => {
                            setContextProjectMenuOpen(false);
                            onSelectProject({ id: workspace.workspaceId, name: workspace.name });
                          }}
                        >{workspace.name}</MenuItem>
                      ))}
                      {!preview && !state.model.workspaces?.workspaces.length ? (
                        <MenuItem icon="folder-open" disabled>暂无项目</MenuItem>
                      ) : null}
                      {normalizedProjectQuery && (preview ? previewProjectOptions.length === 0 && !previewCreatedProject : workspaceOptions.length === 0) ? (
                        <div className="ctx-project-empty">没有匹配的项目</div>
                      ) : null}
                      </div>
                      <div className="menu-sep" />
                      <MenuItem icon="plus" onClick={openCreateProject}>新建项目</MenuItem>
                      <MenuItem icon="x" disabled title="需要工作区">不在项目中工作</MenuItem>
                    </div>
                  </>
                ) : null}
              </span>
              <span className="ctx-branch-wrap">
                {preview || gitWorkspaceId === undefined ? (
                  <span className="ctx-item muted" data-tip="分支">
                    <Icon name="branch" extra="sm" />
                    <span className="ellipsis">{preview ? (previewCreatedProject ? "main" : activePreviewProject?.branch ?? "—") : "—"}</span>
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ctx-item ctx-git-switch"
                      aria-haspopup="menu"
                      aria-expanded={contextBranchMenuOpen}
                      disabled={branchSwitchName !== undefined}
                      data-tip={branchSwitchName !== undefined
                        ? "切换中"
                        : pendingBranchAction !== undefined
                          ? "已排队"
                          : realGit.repository?.isRepository
                            ? "分支"
                            : "非 Git"}
                      onClick={() => setContextBranchMenuOpen((open) => { setContextProjectMenuOpen(false); return !open; })}
                    >
                      <Icon name="branch" extra="sm" />
                      {realGit.loading && realGit.repository === undefined ? (
                        <span>…</span>
                      ) : realGit.repository?.isRepository ? (
                        <span className="ellipsis">{realGit.repository.branch ?? (realGit.repository.detached ? "detached HEAD" : "—")}</span>
                      ) : realGit.error ? (
                        <span>Git 不可用</span>
                      ) : (
                        <span>非 Git 仓库</span>
                      )}
                      <Icon name="chevron-d" extra="sm" />
                    </button>
                    {contextBranchMenuOpen ? (
                      <>
                        <button className="ctx-project-backdrop" aria-label="关闭分支菜单" onClick={() => setContextBranchMenuOpen(false)} />
                        <div className="menu ctx-project-menu ctx-branch-menu" role="menu" aria-label="切换分支">
                          <div className="menu-label">切换分支</div>
                          <div className="ctx-project-list">
                            {realGit.repository === undefined ? (
                              <div className="ctx-project-empty">{realGit.loading ? "正在读取 Git 状态…" : "—"}</div>
                            ) : !realGit.repository.isRepository ? (
                              <div className="ctx-project-empty">{realGit.repository.unavailableReason ?? realGit.error ?? "当前项目不是 Git 仓库"}</div>
                            ) : branchListState.status === "loading" || branchListState.status === "idle" ? (
                              <div className="ctx-project-empty">正在读取分支…</div>
                            ) : branchListState.status === "error" ? (
                              <div className="ctx-project-empty">
                                <p>{branchListState.error}</p>
                                <button className="btn small outline" onClick={() => void loadBranches()}>重试</button>
                              </div>
                            ) : localBranches.length === 0 ? (
                              <div className="ctx-project-empty">暂无本地分支</div>
                            ) : localBranches.map((branch) => {
                              const queuedHere = pendingBranchAction?.kind === "switch" && pendingBranchAction.name === branch.name;
                              return (
                              <MenuItem
                                key={branch.name}
                                icon="branch"
                                current={branch.current}
                                disabled={branch.current || branchSwitchName !== undefined || branch.checkedOutWorktreeId !== undefined}
                                {...(branch.current
                                  ? { title: "当前" }
                                  : branch.checkedOutWorktreeId !== undefined
                                    ? { title: "其他 Worktree" }
                                    : queuedHere
                                      ? { title: "已排队" }
                                      : branchActionDeferred
                                        ? { title: "结束后切换" }
                                        : {})}
                                {...(queuedHere
                                  ? { hint: "等待本轮结束" }
                                  : branchSwitchName === branch.name
                                    ? { hint: "切换中…" }
                                    : branch.current
                                      ? { hint: "当前" }
                                      : branch.ahead || branch.behind
                                        ? { hint: `↑${branch.ahead} ↓${branch.behind}` }
                                        : {})}
                                onClick={() => requestBranchSwitch(branch.name)}
                              >{branch.name}</MenuItem>
                              );
                            })}
                          </div>
                          {remoteBranches.length > 0 ? (
                            <>
                              <div className="menu-sep" />
                              <div className="menu-label">远端分支</div>
                              <div className="ctx-project-list">
                                {remoteBranches.slice(0, 15).map((branch) => (
                                  <MenuItem key={branch.name} icon="branch" disabled title="需本地分支">{branch.name}</MenuItem>
                                ))}
                                {remoteBranches.length > 15 ? <div className="ctx-project-empty">还有 {remoteBranches.length - 15} 个远端分支</div> : null}
                              </div>
                            </>
                          ) : null}
                          <div className="menu-sep" />
                          <MenuItem icon="plus" disabled={branchSwitchName !== undefined} onClick={openCreateBranch}>新建分支…</MenuItem>
                          <MenuItem icon="columns" onClick={() => { setContextBranchMenuOpen(false); onOpenGit(); }}>分支管理（Git）</MenuItem>
                        </div>
                      </>
                    ) : null}
                  </>
                )}
              </span>
              <span className="spacer" />
              {branchNotice ? (
                <span className={`ctx-item ctx-notice-${branchNotice.tone}`} role="status">
                  <Icon name={branchNotice.tone === "ok" ? "check" : "alert"} extra="sm" />
                  <span>{branchNotice.text}</span>
                </span>
              ) : null}
              <span
                className="ctx-item muted"
                data-tip="未提交"
              >
                <Icon name="commit" extra="sm" />
                {preview ? (
                  previewCreatedProject ? (
                    <span className="ctx-diffstat mono"><b className="ds-add">+0</b><b className="ds-del">-0</b></span>
                  ) : (
                    <span className="ctx-diffstat mono"><b className="ds-add">+{formatDiffCount(activePreviewProject?.insertions ?? 0)}</b><b className="ds-del">-{formatDiffCount(activePreviewProject?.deletions ?? 0)}</b></span>
                  )
                ) : realGit.repository?.isRepository && realGit.repository.insertions !== undefined && realGit.repository.deletions !== undefined ? (
                  <span className="ctx-diffstat mono"><b className="ds-add">+{formatDiffCount(realGit.repository.insertions)}</b><b className="ds-del">-{formatDiffCount(realGit.repository.deletions)}</b></span>
                ) : (
                  <span>—</span>
                )}
              </span>
            </div> : null}
            {createProjectOpen ? (
              <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => { if (!createProjectBusy) setCreateProjectOpen(false); }}>
                <section className="modal create-project-modal" role="dialog" aria-modal="true" aria-labelledby="createProjectTitle" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="create-project-head">
                    <div>
                      <span className="create-project-kicker">WORKSPACE</span>
                      <h2 id="createProjectTitle">创建项目</h2>
                    </div>
                    <button type="button" className="icon-btn" aria-label="关闭" disabled={createProjectBusy} onClick={() => setCreateProjectOpen(false)}><Icon name="x" /></button>
                  </div>
                  <div className="create-project-body">
                    <label className="create-project-name">
                      <span className="sr-only">项目名称</span>
                      <Icon name="folder-open" />
                      <input autoFocus value={createProjectName} placeholder="项目名称" maxLength={80} onChange={(event) => setCreateProjectName(event.target.value)} />
                    </label>
                    <div className="create-project-label">源文件夹</div>
                    <button
                      type="button"
                      className={`create-project-folder${createProjectFolderReady ? " selected" : ""}`}
                      onClick={() => setCreateProjectFolderReady(true)}
                    >
                      <span className="create-folder-icon"><Icon name={createProjectFolderReady ? "check" : "folder-open"} /></span>
                      <span className="create-folder-copy">
                        <b>{createProjectFolderReady ? "已准备选择源文件夹" : "选择项目文件夹"}</b>
                        <span>{preview ? "演示模式不会访问本机文件" : "创建时将打开系统文件夹选择器"}</span>
                      </span>
                      {preview ? <span className="chip purple xs">演示</span> : <Icon name="chevron-r" extra="sm" />}
                    </button>
                    {createProjectError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{createProjectError}</div> : null}
                  </div>
                  <div className="create-project-foot">
                    <button type="button" className="btn outline" disabled={createProjectBusy} onClick={() => setCreateProjectOpen(false)}>取消</button>
                    <button type="button" className="btn primary" disabled={!createProjectName.trim() || !createProjectFolderReady || createProjectBusy} onClick={() => void createProject()}>
                      {createProjectBusy ? <><span className="spinner" aria-hidden="true" />正在创建</> : "创建项目"}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
            {createBranchOpen ? (
              <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => { if (!createBranchBusy) setCreateBranchOpen(false); }}>
                <section className="modal create-project-modal create-branch-modal" role="dialog" aria-modal="true" aria-labelledby="createBranchTitle" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="create-project-head">
                    <div>
                      <span className="create-project-kicker">NEW BRANCH</span>
                      <h2 id="createBranchTitle">创建并检出新分支</h2>
                      <p className="create-branch-sub">基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。</p>
                    </div>
                    <button type="button" className="icon-btn" aria-label="关闭" disabled={createBranchBusy} onClick={() => setCreateBranchOpen(false)}><Icon name="x" /></button>
                  </div>
                  <div className="create-project-body">
                    <label className="create-project-name">
                      <span className="sr-only">分支名</span>
                      <Icon name="branch" />
                      <input
                        autoFocus
                        value={createBranchName}
                        placeholder="分支名，例如 feature/git-branch-switcher"
                        maxLength={120}
                        aria-describedby="createBranchHint"
                        onChange={(event) => setCreateBranchName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                          if (!createBranchBusy && createBranchName.trim()) {
                            event.preventDefault();
                            void createBranch();
                          }
                        }}
                      />
                    </label>
                    <p className="create-branch-hint" id="createBranchHint">首版只支持基于当前 HEAD 创建并切换；如需基于其他分支或远端创建，请使用 Changes 面板。</p>
                    {createBranchError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{createBranchError}</div> : null}
                  </div>
                  <div className="create-project-foot">
                    <button type="button" className="btn outline" disabled={createBranchBusy} onClick={() => setCreateBranchOpen(false)}>取消</button>
                    <button type="button" className="btn primary" disabled={!createBranchName.trim() || createBranchBusy} onClick={() => void createBranch()}>
                      {createBranchBusy ? <><span className="spinner" aria-hidden="true" />正在创建</> : "创建并切换"}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
            {switchBlock ? (
              <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => { if (!switchCommitBusy) cancelSwitchBlock(); }}>
                <section className="modal create-project-modal create-branch-modal switch-block-modal" role="dialog" aria-modal="true" aria-labelledby="switchBlockTitle" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="create-project-head">
                    <div>
                      <span className="create-project-kicker">SWITCH BRANCH</span>
                      <h2 id="switchBlockTitle">切换到 {switchBlock.branch} 前需要提交</h2>
                      <p className="create-branch-sub">以下未提交改动会被切换覆盖。提交这些文件后继续切换，或取消本次切换。</p>
                    </div>
                    <button type="button" className="icon-btn" aria-label="关闭" disabled={switchCommitBusy} onClick={cancelSwitchBlock}><Icon name="x" /></button>
                  </div>
                  <div className="create-project-body">
                    <ul className="switch-block-files" aria-label="会被覆盖的未提交文件">
                      {switchBlock.files.map((file) => (
                        <li key={file.path}>
                          <span className="mono">{file.path}</span>
                          {file.insertions !== undefined && file.deletions !== undefined ? (
                            <span className="ctx-diffstat mono" data-tip="未提交">
                              <b className="ds-add">+{formatDiffCount(file.insertions)}</b>
                              <b className="ds-del">-{formatDiffCount(file.deletions)}</b>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <label className="create-project-name">
                      <span className="sr-only">提交信息</span>
                      <Icon name="commit" />
                      <input
                        autoFocus
                        value={switchCommitMessage}
                        placeholder="提交信息，例如：保存当前改动后切换分支"
                        maxLength={200}
                        aria-describedby="switchBlockHint"
                        onChange={(event) => setSwitchCommitMessage(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                          if (!switchCommitBusy && switchCommitMessage.trim()) {
                            event.preventDefault();
                            void submitSwitchCommit();
                          }
                        }}
                      />
                    </label>
                    <p className="create-branch-hint" id="switchBlockHint">只提交列出的 {switchBlock.files.length} 个文件，暂存区里的其他内容保持不变。</p>
                    {switchCommitError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{switchCommitError}</div> : null}
                  </div>
                  <div className="create-project-foot">
                    <button type="button" className="btn outline" disabled={switchCommitBusy} onClick={cancelSwitchBlock}>取消</button>
                    <button type="button" className="btn primary" disabled={!switchCommitMessage.trim() || switchCommitBusy} onClick={() => void submitSwitchCommit()}>
                      {switchCommitBusy ? <><span className="spinner" aria-hidden="true" />正在提交</> : "提交并切换"}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
            <MessageQueueBar
              messages={preview ? previewQueue : visibleQueuedMessages(queuedMessages, selectedSessionId)}
              running={preview ? previewThreadId === "t1" : running}
              sendEnabled={preview || (running ? steerNowEnabled : promptChannelReady)}
              {...(preview ? { demo: true } : {})}
              {...(queueEdit === undefined ? {} : { editingId: queueEdit.entryId })}
              onEdit={editQueuedMessage}
              onSendNow={(entry) => void sendQueuedNow(entry)}
              onRemove={removeQueuedMessage}
            />
            <div className={`composer${running ? ` running ${composerExpanded ? "expanded" : "compact"}` : ""}`} id="composer">
              <div className="composer-ctx" aria-label="已引用的上下文" role="group" />
              <label className="sr-only" htmlFor="composerInput">消息输入框。发送给 Runtime 的文本。</label>
              <ChipComposer
                ref={composerInputRef}
                id="composerInput"
                compact={running && !composerExpanded}
                placeholder={queueEdit === undefined ? "输入消息… / 指令，@ 引用文件、Agent 或 Skill；拖入或粘贴文件变成胶囊" : "正在编辑排队消息…"}
                describedBy="composerHint"
                {...(workspaceId === undefined ? {} : { workspaceId })}
                loadMentions={fetchMentions}
                onRunCommand={runSlashCommand}
                onChange={setDraft}
                onSubmit={() => {
                  if (queueEdit !== undefined) {
                    commitQueuedEdit();
                    return;
                  }
                  void sendPrompt();
                }}
                onQueue={enqueueDraft}
                onFollowUp={() => {
                  if (queueEdit !== undefined) {
                    commitQueuedEdit();
                    return;
                  }
                  if (followUpEnabled) void sendFollowUp();
                }}
                {...(queueEdit === undefined ? {} : { onEscape: cancelQueuedEdit })}
                running={running}
                onFocus={() => setComposerExpanded(true)}
                onPointerDown={(event) => {
                  if (!running || composerExpanded) return;
                  event.preventDefault();
                  setComposerExpanded(true);
                  window.requestAnimationFrame(() => {
                    composerInputRef.current?.focus();
                  });
                }}
                onBlur={() => {
                  if (running) setComposerExpanded(false);
                }}
                onError={setComposerError}
              />
              <p className="sr-only" id="composerHint">{
                queueEdit !== undefined
                  ? "正在编辑排队消息。Enter 写回原位，Escape 取消并还原输入框草稿。"
                  : running
                    ? "按 Enter 将消息加入排队栏，本轮结束后自动发送。Ctrl+Enter 立刻交给 Runtime，本轮结束后处理，可带图片。"
                    : pendingInteraction
                      ? "请先处理上方的询问或审批，再发送新消息"
                      : "按 Enter 发送，Ctrl+Enter 作为后续消息发送（可带图），Shift+Enter 换行"
              }</p>
              {composerError ? (
                <div className="composer-error" role="alert">
                  <Icon name="alert" extra="sm" />
                  <span>{composerError}</span>
                </div>
              ) : null}
              <div className="composer-bar" data-collapse="full" ref={composerBarRef}>
                <div className="cb-group">
                  <button className="icon-btn small" data-tip="附件" aria-label="附件 / 图片" onClick={() => composerInputRef.current?.openFilePicker()}><Icon name="attach" extra="sm" /></button>
                  <button className="icon-btn small" data-tip="@ 引用" aria-label="@ 引用文件、文件夹、Agent 或 Skill" onClick={() => composerInputRef.current?.openMention("@")}><Icon name="at" extra="sm" /></button>
                  <button className="icon-btn small" data-tip="指令" aria-label="指令" onClick={() => composerInputRef.current?.openCommandMenu()}><Icon name="slash" extra="sm" /></button>
                </div>
                {queueEdit !== undefined ? (
                  <span className="pill-btn queue-edit" role="status">
                    <Icon name="pencil" extra="sm" />
                    编辑排队
                    <button
                      type="button"
                      className="qe-x"
                      aria-label="取消编辑排队消息"
                      data-tip="取消编辑"
                      onClick={cancelQueuedEdit}
                    >
                      <Icon name="x" extra="sm" />
                    </button>
                  </span>
                ) : null}
                <ComposerApprovalPicker
                  preview={preview}
                  mode={approvalMode}
                  {...(approvalIndeterminate ? { indeterminate: true } : {})}
                  disabled={approvalDisabled}
                  nextTurnOnly={approvalNextTurnOnly}
                  onChange={(mode) => {
                    if (preview) {
                      setPreviewApprovalMode(mode);
                      return;
                    }
                    void (async () => {
                      const targetSessionId = selectedSessionId as SessionId | undefined;
                      const targetThreadId = selectedThreadId;
                      const needsResume =
                        targetSessionId !== undefined && snapshot?.sessionId !== targetSessionId;
                      try {
                        await ensureSelectedSessionActive(client, {
                          ...(snapshot?.sessionId === undefined ? {} : { activeSessionId: snapshot.sessionId }),
                          ...(targetSessionId === undefined ? {} : { selectedSessionId: targetSessionId }),
                          ...(targetThreadId === undefined ? {} : { selectedThreadId: targetThreadId }),
                        });
                        const currentTarget = selectedTargetRef.current;
                        if (
                          currentTarget.selectedSessionId !== targetSessionId ||
                          currentTarget.selectedThreadId !== targetThreadId
                        ) {
                          setComposerError("切换权限期间已切换会话，本次权限变更已取消。");
                          return;
                        }
                        if (needsResume) {
                          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                        }
                        await run("permissions.mode.set", { mode });
                      } catch (error) {
                        setComposerError(hostErrorMessage(error, "切换权限模式失败"));
                      }
                    })();
                  }}
                />
                <ComposerModePicker
                  preview={preview}
                  {...(snapshot === undefined ? {} : { snapshot })}
                  can={can}
                  busy={busy}
                  disabled={approvalDisabled}
                  keyword={magicKeyword}
                  onKeywordChange={setMagicKeyword}
                  onRun={run}
                  openNonce={modeMenuNonce}
                  openToggles={modeOpenToggles}
                />
                <span className="spacer" />
                <ComposerModelPicker
                  preview={preview}
                  client={client}
                  refreshKey={`${selectedSessionId ?? ""}·${(preview ? previewThreadId : selectedThreadId) ?? ""}`}
                  {...(snapshot === undefined ? {} : { snapshot })}
                  can={can}
                  busy={busy}
                  onRun={run}
                  openNonce={modelMenuNonce}
                />
                {/* 运行中且没有草稿时，发送位变停止；有草稿时保持"加入排队栏"，
                    否则会吃掉流式期间唯一的点击排队入口。编辑排队时始终是写回。 */}
                {running && !textReady && queueEdit === undefined ? (
                  <button
                    className="send-btn abort"
                    disabled={!abortAllowed}
                    onClick={() => {
                      if (preview) return;
                      void run("core.abort", {}).then((ok) => {
                        if (ok) setRetryCancelGeneration((generation) => generation + 1);
                      });
                    }}
                    data-tip="停止"
                    aria-label="停止当前运行"
                  >
                    <Icon name="stop" extra="sm" />
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    disabled={queueEdit === undefined && !(promptEnabled || queueEnabled || slashExecuteReady || (preview && running))}
                    onClick={() => {
                      if (queueEdit !== undefined) {
                        commitQueuedEdit();
                        return;
                      }
                      const payload = composerInputRef.current?.getSnapshot() ?? draft;
                      if (composerSlashExecute(payload) !== undefined) {
                        void sendPrompt();
                        return;
                      }
                      if (running) enqueueDraft();
                      else void sendPrompt();
                    }}
                    data-tip={
                      queueEdit !== undefined
                        ? "写回"
                        : running
                          ? "加入排队"
                          : pendingInteraction
                            ? "先处理询问"
                            : "发送"
                    }
                    aria-label={queueEdit !== undefined ? "写回排队消息" : "发送"}
                  >
                    <Icon name="send" extra="sm" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        <aside className={`side-panel${sideOpen ? " open" : ""}`} id="sidePanel" aria-label="功能面板" style={{ width: panelWidth }}>
          <div className="sp-resizer" id="spResizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整右侧面板宽度" onPointerDown={onPanelResizePointerDown} />
          <div className="sp-head">
            <div className="tabs" role="tablist" aria-label="面板视图">
              <button className={sideTab === "changes" ? "active" : ""} role="tab" aria-selected={sideTab === "changes"} aria-controls="spChanges" onClick={() => onSideTabChange("changes")}>
                <Icon name="diff" extra="sm" />Changes
              </button>
              <button className={sideTab === "git" ? "active" : ""} role="tab" aria-selected={sideTab === "git"} aria-controls="spGit" onClick={() => onSideTabChange("git")}>
                <Icon name="branch" extra="sm" />Git
              </button>
              <button className={sideTab === "preview" ? "active" : ""} role="tab" aria-selected={sideTab === "preview"} aria-controls="spPreview" onClick={() => onSideTabChange("preview")}>
                <Icon name="globe" extra="sm" />Preview
              </button>
              <button className={sideTab === "agents" ? "active" : ""} role="tab" aria-selected={sideTab === "agents"} aria-controls="spAgents" onClick={() => onSideTabChange("agents")}>
                <Icon name="bot" extra="sm" />Agents
                {preview ? <span className="chip gray xs">4<span className="sr-only"> 个 Agent</span></span> : snapshot ? <span className="chip gray xs">{snapshot.agents.length}<span className="sr-only"> 个 Agent</span></span> : null}
              </button>
              {btwWindow.open && btwWindow.placement === "docked" ? (
                /* 这个按钮同时是拖出握把：移动超过阈值并离开标题栏就切回浮动态，
                   不到阈值当普通点击。状态点让 BTW 在别的 tab 前台时也能看出在跑。 */
                <button
                  className={`btw-tab${sideTab === "btw" ? " active" : ""}`}
                  role="tab"
                  aria-selected={sideTab === "btw"}
                  aria-controls="spBtw"
                  data-tip="拖出"
                  onClick={() => onSideTabChange("btw")}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    btwWindow.beginUndockDrag(event, () => onSideTabChange("btw"));
                  }}
                >
                  <Icon name="sparkles" extra="sm" />BTW
                  <span
                    className="btw-tab-dot"
                    data-status={btwSession.snapshot?.status ?? "idle"}
                    aria-hidden="true"
                  />
                </button>
              ) : null}
            </div>
            <span className="spacer" />
            <button className="icon-btn small" data-tip="关闭" onClick={onCloseSide}><Icon name="x" extra="sm" /></button>
          </div>
          <div className="sp-body">
            <div className={`sp-page${sideTab === "changes" ? " active" : ""}`} id="spChanges" role="tabpanel">
              {sideContentMounted && sideTab === "changes" ? (preview ? <PreviewChanges {...(changesFocus.path === undefined ? {} : { focusPath: changesFocus.path })} {...(changesFocus.turnId === undefined ? {} : { focusTurnId: changesFocus.turnId })} focusKey={changesFocus.key} /> : <SessionChanges rows={convo.rows} {...(changesFocus.path === undefined ? {} : { focusPath: changesFocus.path })} {...(changesFocus.turnId === undefined ? {} : { focusTurnId: changesFocus.turnId })} focusKey={changesFocus.key} />) : null}
            </div>
            <div className={`sp-page${sideTab === "git" ? " active" : ""}`} id="spGit" role="tabpanel">
              {sideContentMounted && sideTab === "git" ? (preview ? <PreviewGitPanel /> : <GitStatusPanel client={client} {...(activeWorkspace === undefined ? {} : { workspaceId: activeWorkspace.workspaceId })} />) : null}
            </div>
            <div className={`sp-page${sideTab === "preview" ? " active" : ""}`} id="spPreview" role="tabpanel">
              {preview ? <PreviewSidePreview /> : <Deferred title="Preview 不可用" detail="当前功能等待后续接入" />}
            </div>
            <div className={`sp-page${sideTab === "agents" ? " active" : ""}`} id="spAgents" role="tabpanel">
              {preview ? (
                <PreviewSideAgents onOpenHub={() => onRoute("agent-hub")} />
              ) : snapshot ? (
                snapshot.agents.length ? (
                  snapshot.agents.map((agent) => (
                    <div className="agent-row" key={agent.agentId}>
                      <span className="ag-ic" aria-hidden="true"><Icon name="bot" extra="sm" /></span>
                      <div className="ag-main">
                        <button
                          className="ag-open"
                          type="button"
                          onClick={() => { setHubIntent(agent.agentId); onRoute("agent-hub"); }}
                        >
                          <span className="ag-name">
                            {agent.displayName}
                            <span className="chip gray xs">{agent.status}</span>
                          </span>
                          <span className="ag-task">{agent.assignment ?? agent.summary ?? "—"}</span>
                          <span className="ag-meta">gen {agent.generation}{agent.parentAgentId ? ` · of ${agent.parentAgentId}` : ""}</span>
                        </button>
                      </div>
                      <div className="ag-acts">
                        <button
                          className="icon-btn small"
                          type="button"
                          data-tip="打开"
                          aria-label="在 Agent Hub 打开"
                          onClick={() => { setHubIntent(agent.agentId); onRoute("agent-hub"); }}
                        >
                          <Icon name="external" extra="sm" />
                        </button>
                      </div>
                    </div>
                  ))
                ) : <Deferred title="No agents" detail="当前 snapshot 中没有 Agent。" />
              ) : <Deferred title="Agents deferred" detail="等待 Runtime snapshot。" />}
            </div>
            <div className={`sp-page${sideTab === "btw" ? " active" : ""}`} id="spBtw" role="tabpanel">
              {btwWindow.open && btwWindow.placement === "docked" ? (
                <BtwPanel
                  session={btwSession}
                  {...(preview ? { demo: true, onDemoNext: onBtwDemoNext } : {})}
                />
              ) : btwWindow.open ? (
                <Deferred title="BTW 在浮动态" detail="把浮窗或胶囊拖到标题栏，或点浮窗的「收进右侧栏」。" />
              ) : (
                <Deferred title="BTW 未开启" detail="用 /btw <question> 旁路问一句，或在命令面板里打开 BTW 面板。" />
              )}
            </div>
          </div>
        </aside>
        <BtwHost
          window={btwWindow}
          session={btwSession}
          sideOpen={sideOpen}
          sideHeadRect={btwSideHeadRect}
          {...(preview ? { demo: true, onDemoNext: onBtwDemoNext } : {})}
        />
      </div>
      <div className={`bottom-panel${bottomOpen ? "" : " collapsed"}${bottomResizing ? " resizing" : ""}`} id="bottomPanel">
        <div
          className={`bp-resizer${bottomResizing ? " dragging" : ""}`}
          id="bpResizer"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="调整运行面板高度"
          aria-valuemin={BOTTOM_PANEL_MIN}
          aria-valuemax={BOTTOM_PANEL_MAX}
          aria-valuenow={bottomHeight}
          data-tip="调整高度"
          onPointerDown={onBottomResizePointerDown}
          onDoubleClick={() => { onBottomOpenChange(true); onResizeBottom(BOTTOM_PANEL_DEFAULT); }}
          onKeyDown={onBottomResizeKeyDown}
        />
        <div className="bp-head">
          <div className="tabs" role="tablist" aria-label="运行面板视图">
            <button className={bottomTab === "terminal" ? "active" : ""} role="tab" aria-selected={bottomTab === "terminal"} onClick={() => { onBottomTabChange("terminal"); onBottomOpenChange(true); }}>
              <Icon name="terminal" extra="sm" />Terminal
            </button>
            <button className={bottomTab === "problems" ? "active" : ""} role="tab" aria-selected={bottomTab === "problems"} onClick={() => { onBottomTabChange("problems"); onBottomOpenChange(true); }}>
              <Icon name="alert-c" extra="sm" />Problems
            </button>
            <button className={bottomTab === "tests" ? "active" : ""} role="tab" aria-selected={bottomTab === "tests"} onClick={() => { onBottomTabChange("tests"); onBottomOpenChange(true); }}>
              <Icon name="test" extra="sm" />Tests
              {!preview && testSummary.failed > 0 ? <span className="chip red xs">{testSummary.failed}<span className="sr-only"> 个失败</span></span> : null}
              {!preview && testSummary.failed === 0 && testSummary.running > 0 ? <span className="chip amber xs">{testSummary.running}<span className="sr-only"> 个运行中</span></span> : null}
            </button>
            <button className={bottomTab === "output" ? "active" : ""} role="tab" aria-selected={bottomTab === "output"} onClick={() => { onBottomTabChange("output"); onBottomOpenChange(true); }}>
              <Icon name="console" extra="sm" />Output
            </button>
            <button className={bottomTab === "logs" ? "active" : ""} role="tab" aria-selected={bottomTab === "logs"} onClick={() => { onBottomTabChange("logs"); onBottomOpenChange(true); }}>
              <Icon name="book" extra="sm" />OMP Logs
              {state.events.length > 0 && <span className="chip gray xs">{state.events.length}<span className="sr-only"> 条事件</span></span>}
            </button>
            <button className={bottomTab === "pvlogs" ? "active" : ""} role="tab" aria-selected={bottomTab === "pvlogs"} onClick={() => { onBottomTabChange("pvlogs"); onBottomOpenChange(true); }}>
              <Icon name="globe" extra="sm" />Preview Logs
            </button>
          </div>
          <span className="spacer" />
          <button
            className="icon-btn small"
            data-tip={terminalAvailable ? "新建" : "新建（暂未实现）"}
            disabled={!terminalAvailable}
            onClick={() => terminalRef.current?.create()}
          >
            <Icon name="plus" extra="sm" />
          </button>
          <button className="icon-btn small" data-tip={bottomOpen ? "收起" : "展开"} aria-expanded={bottomOpen} aria-controls="bottomPanel" onClick={() => onBottomOpenChange(!bottomOpen)}>
            <Icon name={bottomOpen ? "chevron-d" : "chevron-u"} extra="sm" />
          </button>
        </div>
        <div className="bp-body">
          <div className={`bp-page${bottomTab === "terminal" ? " active" : ""}`} id="bpTerminal" role="tabpanel">
            <TerminalPane ref={terminalRef} visible={bottomTab === "terminal" && bottomOpen} />
          </div>
          <div className={`bp-page${bottomTab === "problems" ? " active" : ""}`} id="bpProblems" role="tabpanel">
            {preview ? <PreviewProblems /> : <Deferred title="Problems 不可用" detail="Problems 不在公共 contract 中。" />}
          </div>
          <div className={`bp-page${bottomTab === "tests" ? " active" : ""}`} id="bpTests" role="tabpanel">
            {preview ? <PreviewTests /> : (
              <AgentTestsPane
                runs={testRuns}
                rerunDisabled={testRerunDisabled}
                rerunTitle={testRerunTitle}
                onRerun={(command) => { void dispatchPrompt(snapshotFromText(rerunTestPrompt(command))); }}
                onReveal={(run) => { revealConversationTool(convoScrollerRef.current, run); }}
              />
            )}
          </div>
          <div className={`bp-page${bottomTab === "output" ? " active" : ""}`} id="bpOutput" role="tabpanel">
            <div className="panel-head"><div><h2>Command lifecycle</h2><p className="muted">Semantic command ledger from client state.</p></div></div>
            {commandRows.length ? (
              <ul className="lifecycle-list">
                {commandRows.map((command) => (
                  <li key={command.requestId}>
                    <span className="mono">{command.commandName}</span>
                    <Chip>{command.status}</Chip>
                    {"reason" in command && <span className="muted">{command.reason}</span>}
                    {"error" in command && <span className="muted">{command.error.message}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No commands issued.</p>}
            <div className="p4-grid">
              <div>
                <h2>Modes</h2>
                <div className="actions">
                  <button className="btn outline" disabled={!can("mode.plan") || busy} onClick={() => void run("mode.plan.enter", {})}>Plan</button>
                  <button className="btn outline" disabled={!can("mode.vibe") || busy} onClick={() => void run("mode.vibe.enter", {})}>Vibe</button>
                  <button className="btn outline" disabled={!can("mode.plan") || busy} onClick={() => void run("mode.plan.exit", {})}>Exit plan</button>
                  <button className="btn outline" disabled={!can("mode.vibe") || busy} onClick={() => void run("mode.vibe.exit", {})}>Exit vibe</button>
                </div>
              </div>
              <div>
                <h2>Goal / loop</h2>
                <div className="actions">
                  <button className="btn outline" disabled={!can("goal.create") || busy} onClick={() => void run("goal.create", { objective: "Continue current work" })}>Create goal</button>
                  <button className="btn outline" disabled={!can("goal.pause") || busy} onClick={() => void run("goal.pause", {})}>Pause goal</button>
                  <button className="btn outline" disabled={!can("goal.resume") || busy} onClick={() => void run("goal.resume", {})}>Resume goal</button>
                  <button className="btn outline" disabled={!can("loop.enable") || busy} onClick={() => void run("loop.enable", {})}>Start loop</button>
                  <button className="btn outline" disabled={!can("loop.pause") || busy} onClick={() => void run("loop.pause", {})}>Pause loop</button>
                  <button className="btn outline" disabled={!can("loop.disable") || busy} onClick={() => void run("loop.disable", {})}>Stop loop</button>
                </div>
              </div>
            </div>
            {commandManifest && <GenericCommandForm manifest={commandManifest} busy={busy} enabled={can("operator.invoke")} onInvoke={(commandId, args) => void run("operator.invoke", { commandId, ...(args === undefined ? {} : { arguments: args }) })} />}
            {runtime?.classification === "limited-system" && <p className="capability-note">Runtime is Limited. P4 mutations are disabled until the capability manifest grants them.</p>}
          </div>
          <div className={`bp-page${bottomTab === "logs" ? " active" : ""}`} id="bpLogs" role="tabpanel">
            <div className="panel-head"><div><h2>OMP Logs</h2><p className="muted">Virtualized semantic events；消息 transcript 不在公共 contract 中。</p></div><span className="mono">{state.events.length} events</span></div>
            <VirtualEventTranscript events={state.events} />
          </div>
          <div className={`bp-page${bottomTab === "pvlogs" ? " active" : ""}`} id="bpPvlogs" role="tabpanel">
            {preview ? <PreviewLogs /> : <Deferred title="Preview Logs 不可用" detail="Preview 不在公共 contract 中。" />}
          </div>
        </div>
      </div>
      <ToastHost message={statusToast} icon="info" onDismiss={() => setStatusToast(null)} />
      {treeConfirm.dialog}
    </>
  );
}

function AppShell({ state, client, onRoute, selectedHistoryId, onSelectThread, onNewThread, onWorkspacesChange, onHistoryChange }: {
  state: ViewState;
  client: ClientStateSource;
  onRoute: (route: Route) => void;
  selectedHistoryId: string | null;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  onNewThread: () => void;
  onWorkspacesChange: (workspaces: WorkspaceListReadModel) => void;
  onHistoryChange: (history: SessionHistoryReadModel) => void;
}) {
  const previewMode = usePreviewMode();
  const previewOn = () => PREVIEW_MODE_SWITCH_ENABLED && readStoredPreviewMode();
  const [collapsed, setCollapsed] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsEnabledCount, setSkillsEnabledCount] = useState(() => previewOn() ? countEnabledDrawerItems(createPreviewDrawerItems()) : 0);
  const [explorerOpen, setExplorerOpen] = useState(() => previewOn());
  const [projectListExpanded, setProjectListExpanded] = useState(true);
  const [selectedProject, setSelectedProject] = useState<SelectedProject | null>(() => previewOn() ? CURRENT_PROJECT : null);
  const composerRef = useRef<ChipComposerHandle | null>(null);
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
  /** 各项目当前展开的会话条数；折叠会话列表时清掉对应键回到默认 6 条。 */
  const [projectThreadLimits, setProjectThreadLimits] = useState<Record<string, number>>({});
  /** 预览模式「归档」演示隐藏的会话 id（仅本地，不碰 Host）。 */
  const [hiddenPreviewThreads, setHiddenPreviewThreads] = useState<ReadonlySet<string>>(() => new Set());
  /** 历史页的全量会话模型（含已归档）；进入历史页时懒加载，归档动作后刷新。 */
  const [historyAll, setHistoryAll] = useState<SessionHistoryReadModel | undefined>(undefined);
  const initialPreview = defaultPreviewSelection();
  const [previewProjectId, setPreviewProjectId] = useState(initialPreview.projectId);
  const [previewThreadId, setPreviewThreadId] = useState(initialPreview.threadId);
  const [previewDeckWait, setPreviewDeckWait] = useState<ThreadWaitKind | undefined>("plan");
  const { settings: appSettings, update: updateAppSettings } = useAppSettings();
  const theme = appSettings.theme;
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [splitRatio, setSplitRatio] = useState(0.46);
  const [sideOpen, setSideOpen] = useState(() => previewOn());
  const [bottomOpen, setBottomOpen] = useState(() => previewOn());
  const [sideTab, setSideTab] = useState<SideTab>("changes");
  /** 右侧面板宽度：默认与 tokens.css 的 --panel-w(480px) 一致，spResizer 拖拽提交。 */
  const [panelWidth, setPanelWidth] = useState(480);
  /** 底栏高度：默认与 tokens.css 的 --bottom-panel-h(240px) 一致，bpResizer 拖拽提交。 */
  const [bottomHeight, setBottomHeight] = useState(BOTTOM_PANEL_DEFAULT);
  const [bottomTab, setBottomTab] = useState<BottomTab>("logs");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [sessionActionError, setSessionActionError] = useState<string | undefined>(undefined);
  /** 后台 session.create 进行中：欢迎区先出现，composer 可输入；发送时再等这条 Promise。 */
  const [creatingSession, setCreatingSession] = useState(false);
  /** 左上菜单「新建项目」：递增后 WorkbenchCanvas 打开已有创建项目对话框。 */
  const [createProjectNonce, setCreateProjectNonce] = useState(0);
  const sessionCreateWaitRef = useRef<Promise<boolean> | null>(null);
  const [shellNotice, setShellNotice] = useState<{ text: string; icon: string } | null>(null);
  const [compactPending, setCompactPending] = useState(false);
  const [paletteInventory, setPaletteInventory] = useState<DrawerItem[]>([]);
  const paletteRef = useRef<CommandPaletteHandle>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [ompMenuOpen, setOmpMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ShellDialog | null>(null);
  /** 归档确认弹窗：点「归档」只打开此窗，确认后才执行预览隐藏或 session.archive。 */
  const [archivePending, setArchivePending] = useState<ArchivePending | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);
  const [trail, setTrail] = useState<Route[]>([state.route]);
  const lastPageRoute = useRef<SecondaryRoute>("home");
  if (isSecondary(state.route)) lastPageRoute.current = state.route;
  const wantPage = isSecondary(state.route);
  const { shown: showPage, phase: shellPhase } = useDeferredKey(wantPage);
  const pageRoute = isSecondary(state.route) ? state.route : lastPageRoute.current;
  const pageMeta = SECONDARY_META[pageRoute];
  const shellClass = pagePhaseClass(shellPhase);
  const [trailAt, setTrailAt] = useState(0);
  const [capNonce, setCapNonce] = useState(0);
  const [settingsNonce, setSettingsNonce] = useState(0);
  const [mcNonce, setMcNonce] = useState(0);
  const snapshot = snapshotFrom(state);
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
  const fetchHubMentions = useCallback(async (trigger: "@" | "/", query: string) => {
    if (trigger === "/") return [];
    if (previewMode.preview) return previewMentions(trigger, query);
    try {
      return await loadMentions(client, trigger, query, hubFileIndex);
    } catch {
      return [];
    }
  }, [previewMode.preview, client, hubFileIndex]);
  const hubRuntimeConnected = runtime?.status === "connected";
  const hubCanSend = (() => {
    const entry = capabilities?.capabilities.find((item) => item.id === "agent.send");
    if (!entry || entry.grade === "unavailable") return false;
    if (state.clientState?.connection.resyncRequired) return false;
    if (runtime?.classification === "limited-system") return false;
    return true;
  })();
  /* BTW 旁路问答：状态挂在 AppShell 而不是 WorkbenchCanvas —— 回首页会卸载
     WorkbenchCanvas，浮窗不该跟着消失。演示轮次只改本地 UI，不碰 Host。 */
  const [btwDemoRound, setBtwDemoRound] = useState(0);
  /* 吸附落点要的是拖动那一刻的实时位置，所以按需量而不是订阅：右侧栏宽度、
     收起动画、tab 数量都会改这个盒子。 */
  const sideHeadRect = useCallback((): BtwRect | undefined => {
    const head = document.querySelector("#sidePanel .sp-head");
    if (!(head instanceof HTMLElement)) return undefined;
    const box = head.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  }, []);
  const btwWindow = useBtwWindow({
    sideOpen,
    sideHeadRect,
    onDock: () => { setSideTab("btw"); setSideOpen(true); },
  });
  const btwOnBranchedRef = useRef<(sessionId: string) => Promise<boolean>>(async () => false);
  const btwSession = useBtwSession({
    snapshot: previewMode.preview
      ? previewBtwSnapshot(btwDemoRound)
      : (state.clientState?.entities.btw ?? null),
    client,
    preview: previewMode.preview,
    previewQuestion: PREVIEW_BTW_QUESTION,
    canCommand: snapshot !== undefined && runtime?.status === "connected",
    onBranched: async (sessionId) => {
      await btwOnBranchedRef.current(sessionId);
    },
  });
  /** Approval mode for Settings → Permissions (plan §5.6); never optimistic. */
  const approvalMode: ApprovalMode = snapshot?.approvalMode ?? "yolo";
  const setApprovalMode = useCallback(
    (mode: ApprovalMode) => {
      if (snapshot === undefined) return;
      void (async () => {
        try {
          const handle = await client.command("permissions.mode.set", { mode });
          await waitReceipt(client, handle.requestId);
          setSessionActionError(undefined);
        } catch (error) {
          setSessionActionError(hostErrorMessage(error, "切换权限模式失败"));
        }
      })();
    },
    [client, snapshot],
  );
  const selected = state.model.history?.entries.find((entry) => entry.historyId === selectedHistoryId)
    ?? historyAll?.entries.find((entry) => entry.historyId === selectedHistoryId);
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
    ? "归档：当前没有可归档的会话"
    : archiveTargetBase.status === "archived"
      ? "归档：该会话已在归档中"
      : undefined;
  const archiveTarget = archiveTargetReason === undefined ? archiveTargetBase : undefined;
  const threadTitle = previewMode.preview
    ? (previewThread?.thread.title ?? "跟踪上游 pi-web 更新到 omp-web")
    : selected?.title ?? (state.route === "history" ? "会话历史" : state.route === "home" ? "项目主页" : state.route === "agent-hub" ? "Agent Hub" : state.route === "capabilities" ? "能力中心" : state.route === "model-config" ? "模型配置" : "新对话");

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
      setSelectedProject({ id: active.workspaceId, name: active.name });
      setExplorerOpen(true);
      setProjectListExpanded(true);
    } else {
      setSelectedProject(null);
    }
  }, [previewMode.preview, previewProjectId, state.model.workspaces]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", appSettings.theme);
    document.documentElement.setAttribute("data-density", appSettings.density);
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    document.documentElement.style.setProperty("--panel-w", `${panelWidth}px`);
    document.documentElement.style.setProperty("--bottom-panel-h", `${bottomHeight}px`);
    void globalThis.ompStudioChrome?.setTheme(appSettings.theme);
  }, [appSettings.theme, appSettings.density, sidebarWidth, panelWidth, bottomHeight]);

  /* 布局记忆（App 级，非 Host）：按 scope（全局 / project:<id>）恢复与
     持久化；预览模式不参与，避免与演示默认布局互相覆盖。 */
  const layoutScope = appSettings.rememberLayout && appSettings.perProjectLayout && selectedProject
    ? `project:${selectedProject.id}`
    : "global";
  const appliedLayoutScope = useRef<string | null>(null);
  const skipNextLayoutPersist = useRef(false);
  useEffect(() => {
    if (previewMode.preview || !appSettings.rememberLayout) return;
    if (appliedLayoutScope.current === layoutScope) return;
    appliedLayoutScope.current = layoutScope;
    const memory = readLayoutMemory(layoutScope);
    if (memory === undefined) return;
    skipNextLayoutPersist.current = true;
    if (memory.collapsed !== undefined) setCollapsed(memory.collapsed);
    if (memory.sidebarWidth !== undefined) setSidebarWidth(memory.sidebarWidth);
    if (memory.splitRatio !== undefined) setSplitRatio(memory.splitRatio);
    if (memory.sideOpen !== undefined) setSideOpen(memory.sideOpen);
    if (memory.bottomOpen !== undefined) setBottomOpen(memory.bottomOpen);
    if (memory.sideTab === "changes" || memory.sideTab === "git" || memory.sideTab === "preview"
      || memory.sideTab === "agents" || memory.sideTab === "btw") setSideTab(memory.sideTab);
    if (memory.bottomTab === "terminal" || memory.bottomTab === "problems" || memory.bottomTab === "tests"
      || memory.bottomTab === "output" || memory.bottomTab === "logs" || memory.bottomTab === "pvlogs") setBottomTab(memory.bottomTab);
    if (memory.explorerOpen !== undefined) setExplorerOpen(memory.explorerOpen);
    if (memory.panelWidth !== undefined) setPanelWidth(memory.panelWidth);
    if (memory.bottomHeight !== undefined) setBottomHeight(clampBottomHeight(memory.bottomHeight));
    const btwOpen = memory.btwOpen ?? memory.btwPlacement === "docked";
    btwWindow.restoreMemory({
      ...(typeof btwOpen === "boolean" ? { open: btwOpen } : {}),
      ...(memory.btwPlacement === "float" || memory.btwPlacement === "docked" ? { placement: memory.btwPlacement } : {}),
      ...(memory.btwMinimized === undefined ? {} : { minimized: memory.btwMinimized }),
      ...(memory.btwX !== undefined && memory.btwY !== undefined && memory.btwW !== undefined && memory.btwH !== undefined
        ? { rect: { x: memory.btwX, y: memory.btwY, width: memory.btwW, height: memory.btwH } }
        : {}),
      ...(memory.btwCapX !== undefined && memory.btwCapY !== undefined
        ? { capsulePos: { x: memory.btwCapX, y: memory.btwCapY } }
        : {}),
    });
  }, [previewMode.preview, appSettings.rememberLayout, layoutScope, btwWindow.restoreMemory]);
  useEffect(() => {
    if (previewMode.preview || !appSettings.rememberLayout) return;
    if (appliedLayoutScope.current !== layoutScope) return;
    if (skipNextLayoutPersist.current) {
      skipNextLayoutPersist.current = false;
      return;
    }
    writeLayoutMemory(layoutScope, {
      collapsed,
      sidebarWidth,
      splitRatio,
      sideOpen,
      bottomOpen,
      sideTab,
      bottomTab,
      explorerOpen,
      panelWidth,
      bottomHeight,
      btwOpen: btwWindow.open,
      btwPlacement: btwWindow.placement,
      btwMinimized: btwWindow.minimized,
      btwX: btwWindow.rect.x,
      btwY: btwWindow.rect.y,
      btwW: btwWindow.rect.width,
      btwH: btwWindow.rect.height,
      btwCapX: btwWindow.capsulePos.x,
      btwCapY: btwWindow.capsulePos.y,
    });
  }, [previewMode.preview, appSettings.rememberLayout, layoutScope, collapsed, sidebarWidth, splitRatio, sideOpen, bottomOpen, sideTab, bottomTab, explorerOpen, panelWidth, bottomHeight, btwWindow.open, btwWindow.placement, btwWindow.minimized, btwWindow.rect, btwWindow.capsulePos]);

  /* 任务完成 / 长任务系统通知：isStreaming 由真变假视为当前任务结束。 */
  const streamingSinceRef = useRef<{ on: boolean; since: number }>({ on: false, since: 0 });
  useEffect(() => {
    const now = snapshot?.isStreaming === true;
    const previous = streamingSinceRef.current;
    if (now && !previous.on) streamingSinceRef.current = { on: true, since: Date.now() };
    if (!now && previous.on) {
      streamingSinceRef.current = { on: false, since: 0 };
      desktopNotice("task", "任务完成", "会话结束了当前任务");
    }
  }, [snapshot?.isStreaming]);
  useEffect(() => {
    if (snapshot?.isStreaming !== true || !appSettings.notifyLongTasks) return;
    const startedAt = streamingSinceRef.current.since || Date.now();
    const remaining = Math.max(0, 5 * 60_000 - (Date.now() - startedAt));
    const timer = window.setTimeout(() => {
      desktopNotice("longTask", "任务仍在运行", "当前任务已连续运行超过 5 分钟");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [snapshot?.isStreaming, appSettings.notifyLongTasks]);

  useEffect(() => {
    if (openMenu === null) return;
    const close = () => setOpenMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openMenu]);

  const refreshProjects = async () => {
    try {
      const workspaces = await client.query("projects.list", {});
      onWorkspacesChange(workspaces);
    } catch {
      // A failed projects.list never blocks navigation; the stale list stays.
    }
  };

  const selectProject = (project: SelectedProject) => {
    setSelectedProject(project);
    setExplorerOpen(true);
    setProjectListExpanded(true);
    if (!previewMode.preview) {
      // Host remembers the selection; the registry is the only path holder.
      void client.command("workspace.open", { workspaceId: project.id as WorkspaceId }).then(() => {
        void refreshProjects();
      });
    }
  };

  /** System directory picker → register + activate + enter the workbench. */
  const pickProject = async () => {
    if (previewMode.preview) return;
    const handle = await client.command("workspace.pick", {});
    const unsub = client.subscribe({ scope: "command", requestId: handle.requestId }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== handle.requestId) return;
      unsub();
      if (event.receipt.status !== "completed") {
        // Cancelled or failed: keep the current selection untouched.
        return;
      }
      const result = event.receipt.result as WorkspaceListReadModel;
      onWorkspacesChange(result);
      const active = result.workspaces.find((workspace) => workspace.active);
      if (active) {
        setSelectedProject({ id: active.workspaceId, name: active.name });
        setExplorerOpen(true);
        setProjectListExpanded(true);
        go("workbench");
      }
    });
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
    if (next === trail[trailAt]) {
      onRoute(next);
      return;
    }
    setTrail((current) => [...current.slice(0, trailAt + 1), next]);
    setTrailAt((value) => value + 1);
    onRoute(next);
  }, [onRoute, trail, trailAt, state.model.workspaces]);

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
    const history = state.model.history;
    if (previewMode.preview || history === undefined) return;
    if (next <= history.entries.length || history.entries.length >= history.total) return;
    void client.query("history.list", { limit: Math.min(next, PROJECT_THREADS_QUERY_MAX), status: "active" })
      .then((refreshed) => {
        onHistoryChange(refreshed);
      })
      .catch(() => {
        // 重查失败保留现有条目；下次点击「展开更多」会再试。
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

  const requestArchivePreview = (threadId: string) => {
    if (archiveBusy) return;
    const hit = findPreviewThread(threadId);
    setArchiveError(undefined);
    setArchivePending({
      kind: "preview",
      threadId,
      title: hit?.thread.title ?? "该会话",
      streaming: hit?.thread.status === "running",
    });
  };

  const requestArchiveThread = (entry: SessionHistoryEntry) => {
    if (archiveBusy) return;
    setArchiveError(undefined);
    setArchivePending({
      kind: "real",
      entry,
      streaming: entry.sessionId !== undefined && entry.sessionId === snapshot?.sessionId && snapshot.isStreaming === true,
    });
  };

  /** 归档/取消归档成功后刷新两个 history 模型：侧栏（active）与历史页（全量）。 */
  const refreshHistoryModels = useCallback(async (): Promise<void> => {
    const loaded = state.model.history?.entries.length ?? 20;
    try {
      const [active, all] = await Promise.all([
        client.query("history.list", { limit: Math.min(Math.max(loaded, 20), PROJECT_THREADS_QUERY_MAX), status: "active" }),
        client.query("history.list", { limit: PROJECT_THREADS_QUERY_MAX }),
      ]);
      onHistoryChange(active);
      setHistoryAll(all);
    } catch {
      // 刷新失败保留现有条目；下次进入历史页会重查。
    }
  }, [client, onHistoryChange, state.model.history?.entries.length]);

  const sessionTitleRefreshTimers = useRef<number[]>([]);
  const refreshSessionTitles = useCallback(() => {
    if (previewMode.preview) return;
    for (const id of sessionTitleRefreshTimers.current) window.clearTimeout(id);
    sessionTitleRefreshTimers.current = [0, 2_000, 8_000].map((delay) =>
      window.setTimeout(() => {
        void refreshHistoryModels();
      }, delay),
    );
  }, [previewMode.preview, refreshHistoryModels]);
  useEffect(() => () => {
    for (const id of sessionTitleRefreshTimers.current) window.clearTimeout(id);
  }, []);

  /** 真实模式「归档」：session.archive 把会话移入 OMP 冷归档（gzip）。
      进行中的会话由 Host 先 abort / 切走 Runtime，再移文件。
      归档的是当前选中会话时回到新对话视图。仅由确认弹窗调用。 */
  const archiveThread = async (entry: SessionHistoryEntry): Promise<boolean> => {
    try {
      const handle = await client.command("session.archive", { threadId: entry.threadId });
      await waitReceipt(client, handle.requestId);
      if (selectedHistoryId === entry.historyId) onNewThread();
      await refreshHistoryModels();
      setShellNotice({ text: `已归档「${entry.title}」，可在会话历史页查看`, icon: "archive" });
      return true;
    } catch (error) {
      setArchiveError(hostErrorMessage(error, "归档失败"));
      return false;
    }
  };

  const closeArchiveConfirm = () => {
    if (archiveBusy) return;
    setArchivePending(null);
    setArchiveError(undefined);
  };

  const confirmArchive = () => {
    if (archivePending === null || archiveBusy) return;
    if (archivePending.kind === "preview") {
      archivePreviewThread(archivePending.threadId);
      setArchivePending(null);
      setArchiveError(undefined);
      return;
    }
    const entry = archivePending.entry;
    setArchiveBusy(true);
    void archiveThread(entry).then((ok) => {
      if (ok) {
        setArchivePending(null);
        setArchiveError(undefined);
      }
      setArchiveBusy(false);
    });
  };

  /** 真实模式「取消归档」：session.unarchive 恢复到进行中列表。 */
  const unarchiveThread = (entry: SessionHistoryEntry) => {
    void (async () => {
      try {
        const handle = await client.command("session.unarchive", { threadId: entry.threadId });
        await waitReceipt(client, handle.requestId);
        await refreshHistoryModels();
        setShellNotice({ text: `已恢复「${entry.title}」`, icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "取消归档失败"), icon: "alert" });
      }
    })();
  };

  /** 顶栏「对话选项」Fork：Runtime 切换身份（快照 sessionId 变为新会话），
      重查 history 让侧栏/历史页出现新会话。 */
  const forkThread = () => {
    void (async () => {
      try {
        const handle = await client.command("session.fork", {});
        const receipt = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
        await refreshHistoryModels();
        setShellNotice({ text: `已 Fork 到新会话（${receipt.sessionId}）`, icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "Fork 失败"), icon: "alert" });
      }
    })();
  };

  /** 顶栏「对话选项」Handoff：LLM 生成摘要并切换到新会话。 */
  const handoffThread = () => {
    void (async () => {
      try {
        const handle = await client.command("session.handoff", {});
        const receipt = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId);
        await refreshHistoryModels();
        setShellNotice({ text: `已 Handoff 到新会话（${receipt.sessionId}）`, icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "Handoff 失败"), icon: "alert" });
      }
    })();
  };

  /** 顶栏 Compact：默认模式压缩上下文。手动 compact 不发 live start 事件，
      用 compactPending 立刻画出「压缩中」横线；命令结束后再重读 transcript。 */
  const compactThread = () => {
    setCompactPending(true);
    void (async () => {
      try {
        const handle = await client.command("operator.invoke", { commandId: "builtin.compact" });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        const failed = outcome.output.find((line) => /compaction failed/i.test(line));
        setShellNotice({
          text: failed ?? "已压缩上下文",
          icon: failed === undefined ? "check" : "alert",
        });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "压缩失败"), icon: "alert" });
      } finally {
        setCompactPending(false);
      }
    })();
  };

  /** 顶栏「对话选项」导出：builtin.export 生成自包含 HTML；导出路径来自
      operator.invoke 回执的命令输出（Host 侧透传，非演示数据）。 */
  const exportThread = () => {
    void (async () => {
      try {
        const handle = await client.command("operator.invoke", { commandId: "builtin.export" });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        const exportedLine = outcome.output.find((line) => /export/i.test(line));
        setShellNotice({ text: exportedLine ?? "已导出对话（HTML）", icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "导出失败"), icon: "alert" });
      }
    })();
  };

  const waitForNewSession = useCallback(() => sessionCreateWaitRef.current ?? Promise.resolve(true), []);
  const runSessionCreate = useCallback((work: () => Promise<void>) => {
    if (sessionCreateWaitRef.current) return;
    setCreatingSession(true);
    const pending = work()
      .then(() => true)
      .catch((error) => {
        setShellNotice({ text: hostErrorMessage(error, "新建对话失败"), icon: "alert" });
        return false;
      })
      .finally(() => {
        setCreatingSession(false);
        if (sessionCreateWaitRef.current === pending) sessionCreateWaitRef.current = null;
      });
    sessionCreateWaitRef.current = pending;
  }, []);

  const startNewChat = useCallback(() => {
    if (previewMode.preview) {
      go("workbench");
      return;
    }
    if (sessionCreateWaitRef.current) return;
    setSessionActionError(undefined);
    onNewThread();
    go("workbench");
    runSessionCreate(async () => {
      const handle = await client.command("session.create", {});
      await waitReceipt(client, handle.requestId);
      refreshSessionTitles();
    });
  }, [client, go, onNewThread, previewMode.preview, runSessionCreate, refreshSessionTitles]);

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
    if (execute.kind === "typed" && execute.name === "btw.ask") {
      go("workbench");
      btwWindow.show();
      if (previewMode.preview) {
        setBtwDemoRound(0);
        return true;
      }
      const question = typeof execute.input.question === "string" ? execute.input.question : args.trim();
      if (question.length === 0) return true;
      return await btwSession.ask(question);
    }
    if (previewMode.preview) {
      setShellNotice({ text: `演示：/${command.name}${args ? ` ${args}` : ""}`, icon: "info" });
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
        const failed = compacting ? outcome.output.find((item) => /compaction failed/i.test(item)) : undefined;
        const line = failed ?? outcome.output.find((item) => item.trim().length > 0);
        setShellNotice({
          text: line ?? `已执行 /${command.name}`,
          icon: failed === undefined ? "check" : "alert",
        });
        return true;
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, `/${command.name} 失败`), icon: "alert" });
        return false;
      } finally {
        if (compacting) setCompactPending(false);
      }
    }
    return false;
  };

  /** 项目行「＋」：在指定项目下新建会话。非激活项目先 workspace.open
   * 并等待回执（Host 在回执前完成 Runtime 重绑），再 session.create，
   * 否则会话会建到旧项目的 cwd 里。 */
  const startNewChatInProject = useCallback((project: SelectedProject) => {
    if (previewMode.preview) {
      // 预览模式：只切换本地演示状态，不调 Host。
      setPreviewProjectId(project.id);
      setSelectedProject(project);
      setPreviewThreadId("t0");
      setExplorerOpen(true);
      setProjectListExpanded(true);
      go("workbench");
      return;
    }
    setSessionActionError(undefined);
    if (sessionCreateWaitRef.current) return;
    onNewThread();
    go("workbench");
    runSessionCreate(async () => {
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      if (active?.workspaceId !== project.id) {
        const open = await client.command("workspace.open", { workspaceId: project.id as WorkspaceId });
        const model = await waitReceipt<WorkspaceListReadModel>(client, open.requestId);
        onWorkspacesChange(model);
        setSelectedProject(project);
        setExplorerOpen(true);
        setProjectListExpanded(true);
      }
      const handle = await client.command("session.create", {});
      await waitReceipt(client, handle.requestId);
      refreshSessionTitles();
    });
  }, [client, previewMode.preview, go, onNewThread, onWorkspacesChange, runSessionCreate, state.model.workspaces, refreshSessionTitles]);

  const openHistoryEntry = (entry: SessionHistoryEntry) => {
    if (previewMode.preview) {
      onSelectThread(entry);
      return;
    }
    const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    if (active) {
      setSelectedProject((current) => current?.id === active.workspaceId
        ? current
        : { id: active.workspaceId, name: active.name });
      setExplorerOpen(true);
      setProjectListExpanded(true);
    } else {
      setExplorerOpen(true);
      setProjectListExpanded(true);
    }
    // Selecting a historical conversation is a View-plane operation. Do not
    // stop/restart the current Runtime just to render persisted transcript.
    // Execution stays gated until a Worker can be ensured for this session.
    setSessionActionError(undefined);
    onSelectThread(entry);
  };

  const selectBranchedSession = async (sessionId: string): Promise<boolean> => {
    await refreshHistoryModels();
    try {
      const history = await client.query("history.list", {
        limit: PROJECT_THREADS_QUERY_MAX,
        status: "active",
      });
      const entry = history.entries.find((item) => item.sessionId === sessionId);
      if (entry === undefined) return false;
      openHistoryEntry(entry);
      return true;
    } catch {
      return false;
    }
  };
  btwOnBranchedRef.current = selectBranchedSession;

  const runPaletteAction = (action: PaletteAction) => {
    closePalette(false);
    switch (action.kind) {
      case "route":
        go(action.route);
        return;
      case "newChat":
        startNewChat();
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
        setCollapsed((value) => !value);
        return;
      case "toggleBottom":
        go("workbench");
        setBottomOpen((value) => !value);
        return;
      case "toggleSide":
        go("workbench");
        setSideOpen((value) => !value);
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
        setBottomOpen(true);
        return;
      case "openSide":
        go("workbench");
        // BTW 是浮动/停靠两态的：只切 tab 会开出一个空壳，所以顺手停靠进来。
        if (action.tab === "btw") {
          btwWindow.show();
          btwWindow.dock();
        }
        setSideTab(action.tab);
        setSideOpen(true);
        return;
      case "openSettings":
        setSettingsIntent(action.group);
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
    historyEntries: state.model.history?.entries ?? [],
    workspaces: state.model.workspaces?.workspaces ?? [],
    ...(selectedProject ? { activeProjectName: selectedProject.name } : {}),
    inventory: paletteInventory,
    query: paletteQuery,
  }), [previewMode.preview, state.model.history, state.model.workspaces, selectedProject, paletteInventory, paletteQuery]);

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
      if (event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        setCollapsed((value) => !value);
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
        setBottomOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [archiveBusy, archivePending, dialog, go, skillsOpen, paletteOpen, closePalette, openPalette, startNewChat]);

  // 项目 shell 动作（外部编辑器 / 文件管理器）：AppShell 统一持有，
  // 顶栏面包屑菜单与侧栏应用菜单共用同一套状态与 Toast 提示。
  const [shellAction, setShellAction] = useState<"editor" | "directory" | null>(null);
  /** 顶栏「重命名对话」模态：builtin.rename 持久化到会话标题槽。 */
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const openRenameDialog = () => {
    setRenameValue(threadTitle);
    setRenameError(undefined);
    setRenameOpen(true);
  };
  const submitRename = () => {
    const next = renameValue.trim();
    if (!next || renameBusy) return;
    setRenameError(undefined);
    setRenameBusy(true);
    void (async () => {
      try {
        const handle = await client.command("operator.invoke", { commandId: "builtin.rename", arguments: next });
        await waitReceipt(client, handle.requestId);
        await refreshHistoryModels();
        setShellNotice({ text: `已重命名为「${next}」`, icon: "check" });
        setRenameOpen(false);
      } catch (error) {
        setRenameError(hostErrorMessage(error, "重命名失败"));
      } finally {
        setRenameBusy(false);
      }
    })();
  };
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

  const chrome: ShellChrome = {
    collapsed,
    skillsOpen,
    explorerOpen,
    projectListExpanded,
    theme,
    sidebarWidth,
    splitRatio,
    selectedHistoryId,
    selectedProject,
    skillsEnabledCount,
    previewProjectId,
    previewThreadId,
    ...(previewDeckWait === undefined ? {} : { previewDeckWait }),
    onToggleSidebar: () => setCollapsed((value) => !value),
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
        : selectedProject?.id === project.id && projectListExpanded;
      // 再点已展开的项目：收起会话列表，保持当前选中（不发 workspace.open）。
      // 折叠同时重置该项目已展开的会话数，再展开从头显示默认 6 条。
      if (open) {
        setProjectListExpanded(false);
        setProjectThreadLimits((current) => {
          if (!(project.id in current)) return current;
          const { [project.id]: _reset, ...rest } = current;
          return rest;
        });
        return;
      }
      setProjectListExpanded(true);
      if (previewMode.preview) {
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
    onSelectThread: (entry) => {
      openHistoryEntry(entry);
    },
    onPickProject: () => {
      void pickProject();
    },
    onCreateProject: () => setCreateProjectNonce((value) => value + 1),
    onStartNewChat: startNewChat,
    onStartChatInProject: startNewChatInProject,
    onArchivePreviewThread: requestArchivePreview,
    onArchiveThread: requestArchiveThread,
    onUnarchiveThread: unarchiveThread,
    onRenameThread: openRenameDialog,
    onForkThread: forkThread,
    onHandoffThread: handoffThread,
    onCompactThread: compactThread,
    compactPending,
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
    onOpenTerminalPanel: () => {
      setBottomTab("terminal");
      setBottomOpen(true);
    },
    onOpenProjectInEditor: openProjectInEditor,
    onOpenProjectDirectory: openProjectDirectory,
    projectShellUnavailable,
    projectShellAction: shellAction,
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

  return (
    <div className="app" id="appRoot">
      <a className="skip-link" href="#convoScroll">跳到对话内容</a>
      <Titlebar
        canBack={trailAt > 0}
        canForward={trailAt < trail.length - 1}
        onBack={() => {
          if (trailAt <= 0) return;
          if (modelConfigHasUnsavedChanges() && !window.confirm("有未保存的模型配置更改，确定离开吗？")) return;
          const next = trailAt - 1;
          const route = trail[next] ?? "workbench";
          setTrailAt(next);
          if (route === "home") {
            setSelectedProject(null);
            setExplorerOpen(false);
          } else if (route === "workbench") {
            enterWorkbench();
          }
          onRoute(route);
        }}
        onForward={() => {
          if (trailAt >= trail.length - 1) return;
          const next = trailAt + 1;
          const route = trail[next] ?? "workbench";
          setTrailAt(next);
          if (route === "home") {
            setSelectedProject(null);
            setExplorerOpen(false);
          } else if (route === "workbench") {
            enterWorkbench();
          }
          onRoute(route);
        }}
        onToggleSidebar={() => setCollapsed((value) => !value)}
        sidebarCollapsed={collapsed}
        menus={
          <>
            <TitleMenu id="file" label="文件" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => startNewChat()}>新建对话<span className="kbd">Ctrl ⇧ O</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("history")}>会话历史</button>
              <button className="menu-item" role="menuitem" onClick={() => go("agent-hub")}>Agent Hub</button>
              <button className="menu-item" role="menuitem" onClick={() => go("capabilities")}>能力中心</button>
              <button className="menu-item" role="menuitem" onClick={() => go("model-config")}>模型配置</button>
              <button className="menu-item" role="menuitem" onClick={() => go("settings")}>设置</button>
              <button className="menu-item" role="menuitem" onClick={() => go("diagnostics")}>诊断中心</button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => { setOpenMenu(null); openPalette(); }}>命令面板<span className="kbd">Ctrl K</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("home")}>项目主页</button>
            </TitleMenu>
            <TitleMenu id="edit" label="编辑" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("undo")}>撤销<span className="kbd">Ctrl Z</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("redo")}>重做<span className="kbd">Ctrl Y</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runEdit("cut")}>剪切<span className="kbd">Ctrl X</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("copy")}>复制<span className="kbd">Ctrl C</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("paste")}>粘贴<span className="kbd">Ctrl V</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("selectAll")}>全选<span className="kbd">Ctrl A</span></button>
            </TitleMenu>
            <TitleMenu id="view" label="视图" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setCollapsed((value) => !value))}>{collapsed ? "展开侧栏" : "收起侧栏"}<span className="kbd">Ctrl B</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setExplorerOpen((value) => !value))}>{explorerOpen ? "收起 Explorer" : "展开 Explorer"}</button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setSkillsOpen((value) => !value))}>{skillsOpen ? "关闭技能与插件" : "打开技能与插件"}<span className="kbd">Ctrl ⇧ K</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setSideOpen((value) => !value))}>{sideOpen ? "收起右侧面板" : "展开右侧面板"}</button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setBottomOpen((value) => !value))}>{bottomOpen ? "收起底部面板" : "展开底部面板"}<span className="kbd">Ctrl J</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => chrome.onToggleTheme())}>{theme === "dark" ? "切换为浅色" : "切换为深色"}</button>
            </TitleMenu>
            <TitleMenu id="help" label="帮助" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("shortcuts")}>键盘快捷键</button>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("about")}>关于 OMP Studio</button>
              <button className="menu-item" role="menuitem" disabled data-tip="文档（暂未实现）">文档</button>
            </TitleMenu>
          </>
        }
      />
      {sessionActionError ? (
        <div className="empty" role="alert" style={{ padding: "8px 16px" }}>
          <p className="muted small">{sessionActionError}</p>
        </div>
      ) : null}
      {showPage ? (
        <SecondaryPage
          route={pageRoute}
          title={pageMeta.title}
          titleIcon={pageMeta.icon}
          theme={theme}
          className={shellClass}
          onRoute={go}
          onToggleTheme={chrome.onToggleTheme}
        >
          {state.hostError && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>host unavailable</b> · <span className="banner-detail">{state.hostError.message}</span></span>
            </div>
          )}
          {state.clientState?.connection.resyncRequired && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>resync required</b> · <span className="banner-detail">正在恢复最新 Runtime 状态，敏感操作已暂停。</span></span>
            </div>
          )}
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
                  {...(historyModel ? { history: historyModel } : {})}
                  onRoute={go}
                  onSelectThread={chrome.onSelectThread}
                  onUnarchive={chrome.onUnarchiveThread}
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
              {...(hubWorkspaceId === undefined ? {} : { workspaceId: hubWorkspaceId })}
              loadMentions={fetchHubMentions}
              onOpenMain={() => go("workbench")}
            />
          ) : pageRoute === "model-config" ? (
            <ModelConfigPage key={mcNonce} client={client} />
          ) : pageRoute === "settings" ? (
            <SettingsPage
              key={settingsNonce}
              {...(snapshot ? { approvalMode } : {})}
              onSetApprovalMode={setApprovalMode}
            />
          ) : pageRoute === "diagnostics" ? (
            <DiagnosticsPage
              client={client}
              {...(state.model.diagnostics ? { diagnostics: state.model.diagnostics } : {})}
              {...(capabilities ? { capabilities } : {})}
              {...(runtime ? { runtime } : {})}
              {...(environment ? { environment } : {})}
            />
          ) : (
            <CapabilitiesPage key={capNonce} client={client} onRunSlash={runSlashFromShell} />
          )}
        </SecondaryPage>
      ) : (
      <div className={`app-body ${shellClass}`}>
        <AppSidebar state={state} chrome={chrome} client={client} onRoute={go} />
        <div className="main-col">
          <AppTopbar
            state={state}
            client={client}
            chrome={chrome}
            onRoute={go}
            threadTitle={threadTitle}
            sideOpen={sideOpen}
            onToggleSide={() => setSideOpen((value) => !value)}
            onOpenChanges={() => { setSideTab("changes"); setSideOpen(true); }}
            onOpenGit={() => { setSideTab("git"); setSideOpen(true); }}
            onOpenTerminal={() => { setBottomTab("terminal"); setBottomOpen(true); }}
            viewedSessionId={selected?.sessionId}
          />
          {state.hostError && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>host unavailable</b> · <span className="banner-detail">{state.hostError.message}</span></span>
            </div>
          )}
          {state.clientState?.connection.resyncRequired && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>resync required</b> · <span className="banner-detail">正在恢复最新 Runtime 状态，敏感操作已暂停。</span></span>
            </div>
          )}
          <WorkbenchCanvas
            state={state}
            client={client}
            {...(selected?.sessionId === undefined ? {} : { selectedSessionId: selected.sessionId })}
            {...(selected?.threadId === undefined ? {} : { selectedThreadId: selected.threadId })}
            waitForNewSession={waitForNewSession}
            {...(creatingSession ? { sessionCreating: true } : {})}
            {...(previewMode.preview ? { previewProjectId: chrome.previewProjectId, previewThreadId: chrome.previewThreadId, onPreviewDeckWait: setPreviewDeckWait } : {})}
            onSelectProject={chrome.onSelectProject}
            onSelectPreviewProject={chrome.onSelectPreviewProject}
            onSelectPreviewThread={chrome.onSelectPreviewThread}
            onSelectThread={openHistoryEntry}
            onBranchedSession={selectBranchedSession}
            hiddenPreviewThreads={chrome.hiddenPreviewThreads}
            sideOpen={sideOpen}
            onCloseSide={() => setSideOpen(false)}
            sideTab={sideTab}
            onSideTabChange={setSideTab}
            panelWidth={panelWidth}
            onResizePanel={setPanelWidth}
            bottomOpen={bottomOpen}
            onBottomOpenChange={setBottomOpen}
            bottomHeight={bottomHeight}
            onResizeBottom={(height) => setBottomHeight(clampBottomHeight(height))}
            bottomTab={bottomTab}
            onBottomTabChange={setBottomTab}
            onRoute={go}
            onOpenChanges={() => { setSideTab("changes"); setSideOpen(true); }}
            onOpenGit={() => { setSideTab("git"); setSideOpen(true); }}
            composerRef={composerRef}
            onDraftSkillsChange={onDraftSkillsChange}
            onUsedSkillsChange={onUsedSkillsChange}
            onSessionTitleMaybeChanged={refreshSessionTitles}
            onSlashUi={applySlashUi}
            btwWindow={btwWindow}
            btwSession={btwSession}
            btwSideHeadRect={sideHeadRect}
            onBtwDemoNext={() => setBtwDemoRound((round) => (round + 1) % PREVIEW_BTW_SNAPSHOTS.length)}
            onBtwPreviewAsk={() => setBtwDemoRound(0)}
            compactPending={compactPending}
            onCompactPending={setCompactPending}
            {...(createProjectNonce === 0 ? {} : { createProjectNonce })}
            {...(selectedProject?.id === undefined ? {} : { workspaceId: selectedProject.id })}
          />
          <span className="sr-only">client contract v{CLIENT_CONTRACT_VERSION}{snapshot ? ` · session ${snapshot.sessionId}` : ""}</span>
        </div>
      </div>
      )}
      {renameOpen ? (
        <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => { if (!renameBusy) setRenameOpen(false); }}>
          <section className="modal create-project-modal rename-thread-modal" role="dialog" aria-modal="true" aria-labelledby="renameThreadTitle" onMouseDown={(event) => event.stopPropagation()}>
            <div className="create-project-head">
              <div>
                <span className="create-project-kicker">THREAD</span>
                <h2 id="renameThreadTitle">重命名对话</h2>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭" disabled={renameBusy} onClick={() => setRenameOpen(false)}><Icon name="x" /></button>
            </div>
            <div className="create-project-body">
              <label className="create-project-name">
                <span className="sr-only">对话标题</span>
                <Icon name="pencil" />
                <input
                  autoFocus
                  value={renameValue}
                  placeholder="对话标题"
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
              <div className="create-project-label">重命名会写入会话标题槽，侧栏与历史页同步显示新标题。</div>
              {renameError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{renameError}</div> : null}
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" disabled={renameBusy} onClick={() => setRenameOpen(false)}>取消</button>
              <button type="button" className="btn primary" disabled={!renameValue.trim() || renameBusy} onClick={submitRename}>
                {renameBusy ? <><span className="spinner" aria-hidden="true" />正在重命名</> : "重命名"}
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
                <h2 id="archiveThreadTitle">确认归档</h2>
                <p className="create-branch-sub">
                  确定要归档「{archivePending.kind === "preview" ? archivePending.title : archivePending.entry.title}」吗？
                </p>
                {archiveConfirmIsStreaming(archivePending, snapshot) ? (
                  <p className="create-branch-sub">当前对话正在进行。确认后将强制停止输出，再归档。</p>
                ) : null}
              </div>
              <button type="button" className="icon-btn" aria-label="关闭" disabled={archiveBusy} onClick={closeArchiveConfirm}><Icon name="x" /></button>
            </div>
            <div className="create-project-body">
              <p className="create-branch-hint">
                {archivePending.kind === "preview"
                  ? "演示：仅从侧栏隐藏该会话，不会改 Host。"
                  : "会话会移入冷归档，可在会话历史页查看或恢复。"}
              </p>
              {archiveError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{archiveError}</div> : null}
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" disabled={archiveBusy} onClick={closeArchiveConfirm}>取消</button>
              <button type="button" className="btn primary" autoFocus disabled={archiveBusy} onClick={confirmArchive}>
                {archiveBusy
                  ? <><span className="spinner" aria-hidden="true" />{archiveConfirmIsStreaming(archivePending, snapshot) ? "正在停止并归档" : "正在归档"}</>
                  : "归档"}
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
                    关于 OMP Studio
                  </span>
                </div>
                <div className="modal-body">
                  <dl className="about-list">
                    <div className="about-row"><dt>产品</dt><dd>OMP Studio</dd></div>
                    <div className="about-row"><dt>Client contract</dt><dd>v{CLIENT_CONTRACT_VERSION}</dd></div>
                    <div className="about-row"><dt>Runtime</dt><dd>{runtime?.status ?? "unavailable"}{runtime?.classification ? ` · ${runtime.classification}` : ""}</dd></div>
                    {runtime?.runtimeVersion ? <div className="about-row"><dt>Runtime 版本</dt><dd>{runtime.runtimeVersion}</dd></div> : null}
                    {environment ? <div className="about-row"><dt>平台</dt><dd>{environment.platform} · {environment.arch}</dd></div> : null}
                    {snapshot ? <div className="about-row"><dt>Session</dt><dd className="mono">{snapshot.sessionId}</dd></div> : null}
                  </dl>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head" id="shellDialogTitle">键盘快捷键</div>
                <div className="modal-body">
                  <dl className="about-list">
                    <div className="about-row"><dt>新建对话</dt><dd><span className="kbd">Ctrl ⇧ O</span></dd></div>
                    <div className="about-row"><dt>命令面板</dt><dd><span className="kbd">Ctrl K</span></dd></div>
                    <div className="about-row"><dt>展开 / 收起侧栏</dt><dd><span className="kbd">Ctrl B</span></dd></div>
                    <div className="about-row"><dt>技能与插件</dt><dd><span className="kbd">Ctrl ⇧ K</span></dd></div>
                    <div className="about-row"><dt>底部面板</dt><dd><span className="kbd">Ctrl J</span></dd></div>
                    <div className="about-row"><dt>关闭菜单或面板</dt><dd><span className="kbd">Esc</span></dd></div>
                  </dl>
                </div>
              </>
            )}
            <div className="modal-foot">
              <button type="button" className="btn primary" onClick={() => setDialog(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
      <ToastHost message={shellNotice?.text ?? null} icon={shellNotice?.icon ?? "info"} placement="top" onDismiss={() => setShellNotice(null)} />
      <CommandPalette
        ref={paletteRef}
        open={paletteOpen}
        query={paletteQuery}
        groups={paletteGroups}
        onQueryChange={setPaletteQuery}
        onClose={closePalette}
        onRun={runPaletteAction}
      />
    </div>
  );
}

export function App({ client: inputClient }: { readonly client: StudioClient }) {
  const client = inputClient as ClientStateSource;
  const [state, dispatch] = useReducer(reduce, { loading: true, model: {}, events: [], route: "workbench" });
  const [route, setRoute] = useState<Route>(initialRouteFromSettings);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const offEvent = client.subscribe({ scope: "all" }, (event) => {
      notifyFromEvent(event);
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
      try {
        const bootstrap = await client.bootstrap();
        if (cancelled) return;
        const clientState = client.getState?.();
        dispatch({ type: "ready", bootstrap, ...(clientState ? { clientState } : {}) });
        const results = await Promise.allSettled([
          queryWithTimeout(() => client.query("environment.get", {})),
          client.query("capabilities.get", {}),
          client.query("commands.getManifest", {}),
          client.query("diagnostics.get", {}),
          client.query("history.list", { limit: 20, status: "active" }),
          client.query("home.get", {}),
          client.query("projects.list", {}),
        ]);
        if (cancelled) return;
        const [environment, capabilities, commandManifest, diagnostics, history, home, workspaces] = results;
        dispatch({ type: "model", model: {
          ...(environment.status === "fulfilled" ? { environment: environment.value } : {}),
          ...(capabilities.status === "fulfilled" ? { capabilities: capabilities.value } : {}),
          ...(commandManifest.status === "fulfilled" ? { commandManifest: commandManifest.value } : {}),
          ...(diagnostics.status === "fulfilled" ? { diagnostics: diagnostics.value } : {}),
          ...(history.status === "fulfilled" ? { history: history.value } : {}),
          ...(home.status === "fulfilled" ? { home: home.value } : {}),
          ...(workspaces.status === "fulfilled" ? { workspaces: workspaces.value } : {}),
        } });
      } catch (error) {
        if (!cancelled) dispatch({ type: "ready", bootstrap: unavailableBootstrap(), hostError: asError(error) });
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
  const runtimeStatus = state.clientState?.connection.runtime?.status;
  useEffect(() => {
    if (state.loading || runtimeStatus !== "connected") return;
    let cancelled = false;
    void resyncRuntimeModel(client).then((model) => {
      if (!cancelled) dispatch({ type: "model", model });
    });
    return () => {
      cancelled = true;
    };
  }, [client, state.loading, runtimeEpoch, runtimeStatus]);

  /* 上次页面持久化：供「启动后默认页面 = 上次页面」读取。 */
  useEffect(() => {
    writeLastRoute(route);
  }, [route]);

  /* 启动时恢复最近会话：仅冷启动一次性尝试——无驻留 Runtime 会话、
     用户尚未选择过会话时，选中最近活跃的历史会话。 */
  const sessionRestoreTried = useRef(false);
  useEffect(() => {
    if (sessionRestoreTried.current || state.loading) return;
    sessionRestoreTried.current = true;
    if (!getAppSettings().restoreLastSession) return;
    if (selectedHistoryId !== null) return;
    if (state.clientState?.connection.runtime?.status === "connected") return;
    const entry = state.model.history?.entries[0];
    if (entry !== undefined) setSelectedHistoryId(entry.historyId);
  }, [state.loading, state.clientState, state.model.history, selectedHistoryId]);

  const routedState = { ...state, route };
  const body = state.loading ? (
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
      state={routedState}
      client={client}
      onRoute={setRoute}
      selectedHistoryId={selectedHistoryId}
      onSelectThread={(entry) => { setSelectedHistoryId(entry.historyId); setRoute("workbench"); }}
      onNewThread={() => setSelectedHistoryId(null)}
        onWorkspacesChange={(workspaces) => dispatch({ type: "model", model: { workspaces } })}
        onHistoryChange={(history) => dispatch({ type: "model", model: { history } })}
    />
  );
  return (
    <PreviewModeProvider>
      {body}
      <StartupNotice />
      <TipHost />
    </PreviewModeProvider>
  );
}

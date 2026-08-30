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
  StudioPlanSaveAndQuitResult,
  StudioRuntimeSettingKey,
  StudioRuntimeSettingValue,
  Unsubscribe,
  WorkspaceId,
  WorkspaceListReadModel,
  WorkspaceFileNode,
  WorkspaceFileTreeReadModel,
  PromptImageInput,
} from "@omp-studio/client-contract";
import { selectComposerReceipt, type ClientState } from "@omp-studio/client";
import {
  clientShellChanged,
  layoutRestoreNeeded,
  shouldRecordShellEvent,
  toShellEventLogEntry,
  type ShellEventLogEntry,
} from "./shellMemory";
import type { ApprovalMode, OperatorStateSnapshot, SessionTelemetrySnapshot, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import type { OperatorCommandManifest } from "@omp-studio/studio-protocol";
import { AppIcon, Icon } from "./icons";
import { FileRowMenu, MenuItem, type FileMenuAction, type FileMenuController, type FileMenuTarget, type FileOpenerOption } from "./menus";
import { I18nProvider, useI18n, type TranslationParams } from "./i18n";
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
  mergeSlashCatalogWithManifest,
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
import { SettingsPage, setSettingsIntent, type RuntimeSettingsApi } from "./SettingsPage";
import { DiagnosticsPage, setDiagnosticsIntent } from "./DiagnosticsPage";
import { RuntimeLossBanner } from "./RuntimeLossBanner";
import {
  formatRuntimeClassification,
  formatRuntimeStatusLabel,
  runtimeCanReconnect,
  runtimeCanRestart,
} from "./diagnosticsModel";
import { queryWithTimeout } from "./updateCheck";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { TipHost } from "./TipHost";
import { ToastHost } from "./ToastHost";
import { compactNoticeFromOutput } from "./compactNotice";
import { SkillsDrawer } from "./SkillsDrawer";
import { CommandPalette, type CommandPaletteHandle } from "./CommandPalette";
import { buildPaletteGroups, type BottomTab, type PaletteAction, type SideTab } from "./commandPaletteCatalog";
import { toDrawerItems } from "./extensibilityMap";
import { countEnabledDrawerItems, createPreviewDrawerItems, type DrawerItem } from "./skillsPreview";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { revealBottomBar, toggleBottomBarOpen, toggleBottomBarVisible } from "./bottomPanelChrome";
import { useViewedSessionTelemetry, type ViewedSessionTelemetryState } from "./telemetry/useViewedSessionTelemetry";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { asConversationClient } from "./conversation/conversationHost";
import { useActivityRetry, useAwaitingTurn, useRunWindow } from "./conversation/ActivityLine";
import { deriveActivityStatus, isAbortEligible } from "./conversation/activityStatus";
import { ConversationEmpty } from "./conversation/ConversationEmpty";
import { ConversationPane } from "./conversation/ConversationPane";
import { SubagentInspectCard } from "./conversation/SubagentInspectCard";
import { collectLatestPlanDocument, SESSION_CHANGE_LAST_ID, sessionTaskProgress, type SubagentHubTarget } from "./conversation/toolMeta";
import { TaskProgressDock } from "./conversation/TaskProgressDock";
import { SessionChanges } from "./conversation/SessionChanges";
import { AgentTestsPane } from "./conversation/AgentTestsPane";
import { agentTestRunSummary, projectAgentTestRuns, rerunTestPrompt } from "./conversation/agentTestRuns";
import { revealConversationTool } from "./conversation/conversationReveal";
import { useConversation } from "./conversation/useConversation";
import { usePersistedSessionAgents } from "./conversation/persistedSessionAgents";
import { explorerRowActivity, EMPTY_EXPLORER_FILE_ACTIVITY, type ExplorerFileActivity } from "./conversation/explorerFileActivity";
import {
  executeUserMessageBranch,
  executeUserMessageRestore,
  userMessageRestoreDisabledReason,
  type UserMessageEditorFill,
} from "./conversation/userMessageRestore";
import { useUserMessageTreeConfirm } from "./conversation/UserMessageTreeConfirm";
import { getDefaultThumbStore } from "./conversation/userMessageThumbs";
import { claimTransientToast, isTransientStatusNotice, transientStatusFamily } from "./conversation/transientStatusNotice";
import { PreviewModeProvider, usePreviewMode } from "./preview/PreviewContext";
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
import { AppUpdateDialog } from "./AppUpdateDialog";
import { useAppUpdate } from "./settings/appUpdate";
import { avatarInitial, useOperatorProfile } from "./settings/operatorProfile";
import {
  PREVIEW_APP_UPDATE,
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
import { interactionDeckDisabled, planReviewDeckDisabled, usableCapabilityManifest } from "./deck/interactionGate";
import { PlanReviewDeck, PlanViewDialog } from "./deck/PlanCard";
import { type PlanActionDetail, type PlanActionId } from "./deck/types";
import { ThreadSpin } from "./sidebar/ThreadSpin";
import { ThreadWaitChip } from "./sidebar/ThreadWaitChip";
import { residentForSession, residentRowsOf, threadRunningFromLive } from "./sidebar/threadRunning";
import { sidebarProjectOrder } from "./sidebar/projectOrder";
import { readExplorerExpansion, readExpandedProjects, writeExplorerExpansion, writeExpandedProjects } from "./sidebar/expandMemory";
import {
  projectHasSession,
  provisionalSessionTitleEnsureKey,
  provisionalThreadForHistoryEntry,
  provisionalThreadTitle,
  reconcileProvisionalProjectThread,
  resolveProvisionalHistoryTitle,
  shouldEnsureProvisionalSessionTitle,
  sidebarThreadTitle,
  type ProvisionalProjectThread,
} from "./sidebar/provisionalThread";
import { renameNeedsSessionResume, workspaceForSession } from "./sidebar/sessionTitle";
import { waitKindFromLive, type ThreadWaitKind } from "./sidebar/threadWait";
import {
  PROJECT_HISTORY_INITIAL_LIMIT,
  PROJECT_HISTORY_PAGE_SIZE,
  PROJECT_HISTORY_QUERY_MAX,
  streamingProjectHistoryRefreshKey,
  type ProjectHistoryCache,
  useProjectHistories,
} from "./sidebar/useProjectHistories";
import { createResumeGenerationGate, ensureSelectedSessionActive, type NewSessionWaitResult } from "./sessionLifecycle";
import { createSerialTaskQueue } from "./workspaceActionQueue";
import { isNewConversationSurface, shouldShowConversationWelcome } from "./conversation/welcomeGate";
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
function notifyFromEvent(event: ClientEvent, t: (key: string, params?: TranslationParams) => string): void {
  if (event.kind === "interaction.required") {
    notifyAskConfirmation(event.interaction.interactionId, event.interaction.leaseGeneration, event.interaction.title);
    return;
  }
  if (event.kind === "interaction.resolved") {
    clearAskConfirmationNotice(event.interactionId, event.leaseGeneration);
    return;
  }
  if (event.kind === "command.receipt" && event.receipt.status === "failed") {
    desktopNotice("error", t("shell.commandFailed"), event.receipt.error.message);
    return;
  }
  if (event.kind === "resync.required") {
    desktopNotice("error", t("shell.resyncRequired"), event.reason);
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

type ClientStateSource = StudioClient & {
  getState?: () => ClientState;
  onState?: (listener: (state: ClientState) => void) => Unsubscribe;
};

type Route = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics";
type SecondaryRoute = Exclude<Route, "workbench">;

function isSecondary(route: Route): route is SecondaryRoute {
  return route === "home" || route === "history" || route === "agent-hub" || route === "capabilities" || route === "model-config" || route === "settings" || route === "diagnostics";
}

const SECONDARY_META: Record<SecondaryRoute, { titleKey: string; icon: string }> = {
  home: { titleKey: "nav.home", icon: "home" },
  history: { titleKey: "nav.history", icon: "history" },
  "agent-hub": { titleKey: "nav.agentHub", icon: "bot" },
  capabilities: { titleKey: "nav.capabilities", icon: "package" },
  "model-config": { titleKey: "nav.modelConfig", icon: "server" },
  settings: { titleKey: "nav.settings", icon: "settings" },
  diagnostics: { titleKey: "nav.diagnostics", icon: "pulse" },
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

/** Compose the optional Runtime settings seam without inventing values for older Runtimes. */
export function runtimeSettingsPropsOf(
  snapshot: OperatorStateSnapshot | undefined,
  canSet: boolean,
  onSet: RuntimeSettingsApi["onSet"] | undefined,
): RuntimeSettingsApi | undefined {
  const hasSnapshot = snapshot?.runtimeSettings !== undefined;
  const hasSpeculation = snapshot?.compactionSpeculation !== undefined;
  if (!hasSnapshot && !hasSpeculation && !(canSet && onSet !== undefined)) return undefined;
  return {
    ...(hasSnapshot ? { snapshot: snapshot.runtimeSettings } : {}),
    ...(hasSpeculation ? { compactionSpeculation: snapshot.compactionSpeculation } : {}),
    ...(canSet && onSet !== undefined ? { onSet } : {}),
  };
}

/** Keep the save/exit receipt honest when Runtime could not select the new session. */
export function planSaveAndQuitNotice(result: StudioPlanSaveAndQuitResult, selected: boolean): string {
  const prefix = `已保存 ${result.path}，Plan 已退出`;
  if (result.newSession === "cancelled") return `${prefix}；新会话创建已取消。`;
  if (result.newSession === "failed") return `${prefix}；新会话创建失败，请从历史记录打开。`;
  return selected
    ? `${prefix}；已创建并切换到新会话。`
    : `${prefix}；新会话已创建，但未能自动切换，请从历史记录打开。`;
}

export function canStartPlanSaveAndQuit(canSave: boolean, pending: boolean): boolean {
  return canSave && !pending;
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
    client.query("environment.get", {}),
    client.query("diagnostics.get", {}),
  ]);
  const [capabilities, commandManifest, workspaces, history, environment, diagnostics] = results;
  return {
    ...(capabilities.status === "fulfilled" ? { capabilities: capabilities.value } : {}),
    ...(commandManifest.status === "fulfilled" ? { commandManifest: commandManifest.value } : {}),
    ...(workspaces.status === "fulfilled" ? { workspaces: workspaces.value } : {}),
    ...(history.status === "fulfilled" ? { history: history.value } : {}),
    ...(environment.status === "fulfilled" ? { environment: environment.value } : {}),
    ...(diagnostics.status === "fulfilled" ? { diagnostics: diagnostics.value } : {}),
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

function runtimeStatusLabel(runtime?: ClientBootstrap["runtime"], t?: (k: string) => string): { text: string; tone: "ok" | "warn" | "err" } {
  const tr = t ?? ((k: string) => k);
  const status = runtime?.status ?? "unavailable";
  if (status === "connected") return { text: tr("runtime.ready"), tone: "ok" };
  if (status === "connecting") return { text: tr("common.connecting"), tone: "warn" };
  if (status === "disconnected") return { text: tr("diagnostics.statusDisconnected"), tone: "err" };
  return { text: formatRuntimeStatusLabel(status, tr), tone: "err" };
}

type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
type ShellDialog = "about" | "shortcuts";
type WorkspaceCreationKind = "file" | "directory";
type ArchivePending =
  | { kind: "preview"; threadId: string; title: string; streaming: boolean }
  | { kind: "real"; entry: SessionHistoryEntry; streaming: boolean; workspaceId?: WorkspaceId };

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

/** 左上应用菜单（ver1 sb-top 汉堡按钮）：本地命令入口聚合，各项复用既有表面，
 * 不引入新的 Host 能力；无后端的项按惯例禁用并给出原因。 */
export function AppMenu({ chrome, onRoute }: {
  chrome: ShellChrome;
  onRoute: (route: Route) => void;
}) {
  const { preview } = usePreviewMode();
  const { t } = useI18n();
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
      ? { disabled: true, ...(chrome.projectShellAction === kind ? { title: t("common.opening") } : {}) }
      : {};

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        data-tip={t("nav.menu")}
        aria-label={t("nav.menu")}
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
              aria-label={t("nav.menu")}
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="menu-label">{t("shell.globalActions")}</div>
              <MenuItem icon="plus" kbd="Ctrl ⇧ O" onClick={() => run(chrome.onStartNewChat)}>{t("nav.newChat")}</MenuItem>
              <MenuItem
                icon="folder-open"
                {...(preview
                  ? { disabled: true, title: t("common.unavailableInPreview") }
                  : { onClick: () => run(chrome.onPickProject) })}
              >{t("nav.openProject")}</MenuItem>
              <MenuItem icon="branch" disabled title={t("common.notImplemented")}>{t("shell.cloneRepo")}</MenuItem>
              <MenuItem icon="flask" disabled title={t("common.notImplemented")}>{t("shell.tempWorkspace")}</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="plus" onClick={() => run(chrome.onCreateProject)}>{t("nav.createProject")}</MenuItem>
              <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>{t("nav.home")}</MenuItem>
              <MenuItem icon="history" onClick={() => run(() => onRoute("history"))}>{t("nav.history")}</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="search" kbd="Ctrl K" onClick={() => run(chrome.onOpenPalette)}>{t("nav.search")}</MenuItem>
              <MenuItem icon="terminal" kbd="Ctrl J" onClick={() => run(chrome.onOpenTerminalPanel)}>{t("nav.terminal")}</MenuItem>
              <MenuItem icon="external" {...shellItemProps("editor")} onClick={() => run(chrome.onOpenProjectInEditor)}>{t("shell.openInEditor")}</MenuItem>
              <MenuItem icon="folder" {...shellItemProps("directory")} onClick={() => run(chrome.onOpenProjectDirectory)}>{t("shell.openInExplorer")}</MenuItem>
              <MenuItem icon="server" hint={t("menu.modelConfigHint")} onClick={() => run(() => onRoute("model-config"))}>{t("nav.modelConfig")}</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="settings" onClick={() => run(() => onRoute("settings"))}>{t("nav.settings")}</MenuItem>
              <MenuItem icon="keyboard" onClick={() => run(() => chrome.onOpenDialog("shortcuts"))}>{t("nav.shortcuts")}</MenuItem>
              <MenuItem icon="info" onClick={() => run(() => chrome.onOpenDialog("about"))}>{t("nav.about")}</MenuItem>
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

/** 顶栏「对话选项」与侧栏会话行 ⋯ 菜单共用的会话动作项（归档项作用目标不同，由调用方各自追加）。
    live/busy/compacting 语义与顶栏一致，只是取值来源不同：顶栏看当前会话，行菜单看所在行。 */
function ThreadActionMenuItems({ live, busy, compacting, compactPending, reason, onRename, onFork, onHandoff, onCompact, onExport, onHistory }: {
  live: boolean;
  busy: boolean;
  compacting: boolean;
  compactPending: boolean;
  /** 禁用时的悬停原因（无 Runtime / 加载中 / 预览不可用）。 */
  reason: string;
  onRename: () => void;
  onFork: () => void;
  onHandoff: () => void;
  onCompact: () => void;
  onExport: () => void;
  onHistory: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <MenuItem
        icon="pencil"
        disabled={!live}
        {...(live ? {} : { title: reason })}
        onClick={onRename}
      >{t("conversation.renameThread")}</MenuItem>
      <MenuItem
        icon="fork"
        disabled={!live || busy}
        {...(live && !busy ? {} : { title: reason })}
        onClick={onFork}
      >{t("shell.forkThread")}</MenuItem>
      <MenuItem
        icon="handoff"
        disabled={!live || busy}
        {...(live && !busy ? {} : { title: reason })}
        onClick={onHandoff}
      >{t("shell.handoffThread")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem
        icon="minimize"
        disabled={!live || compacting || compactPending}
        {...(live && !compacting && !compactPending ? {} : { title: live ? t("common.loading") : reason })}
        onClick={onCompact}
      >{t("shell.compactThread")}</MenuItem>
      <MenuItem
        icon="export"
        disabled={!live || busy}
        {...(live && !busy ? {} : { title: reason })}
        onClick={onExport}
      >{t("shell.exportThread")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="history" onClick={onHistory}>{t("nav.history")}</MenuItem>
    </>
  );
}

/** 侧栏会话行「⋯ 更多」菜单：顶栏「对话选项」同款动作，弹层稍窄（208px）。
    两种锚定：⋯ 按钮触发时右缘对齐按钮右缘向左展开；行右键触发时弹层左上角
    贴光标（Windows 上下文菜单惯例）。上下左右均按视口钳制。 */
function ThreadRowMenu({ id, openId, onToggle, contextPoint, menu }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  /** 非 null = 本次打开来自行右键，弹层贴该光标点。 */
  contextPoint: { x: number; y: number } | null;
  menu: ReactNode;
}) {
  const { t } = useI18n();
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const pad = 8;
      const width = menuRef.current?.offsetWidth ?? 208;
      const height = menuRef.current?.offsetHeight ?? 0;
      let left: number;
      let top: number;
      if (contextPoint !== null) {
        // 右键：弹层左上角贴光标，越界向左/向上翻。
        left = contextPoint.x;
        top = contextPoint.y;
      } else {
        const rect = buttonRef.current?.getBoundingClientRect();
        if (!rect) return;
        left = rect.right - width;
        top = rect.bottom + 4;
      }
      left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
      if (height > 0 && top + height > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - height - pad);
      }
      setAnchor({ top, left });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [contextPoint, open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`icon-btn${open ? " open" : ""}`}
        data-tip={t("common.moreActions")}
        aria-label={t("common.moreActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        // 拦下 mousedown：窗口级「点外部关闭」不会在 toggle 前先把菜单关掉。
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => onToggle(open ? null : id)}
      ><Icon name="more" extra="sm" /></button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu title-menu-popover thread-row-popover"
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
    </>
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
  const { t } = useI18n();
  const previewMode = usePreviewMode();
  return (
    <header className="app-titlebar">
      <button
        className="icon-btn"
        data-tip={sidebarCollapsed ? t("common.expand") : t("common.collapse")}
        aria-label={sidebarCollapsed ? t("menu.expandSidebar") : t("menu.collapseSidebar")}
        aria-expanded={sidebarCollapsed === false}
        disabled={!onToggleSidebar}
        onClick={onToggleSidebar}
      >
        <Icon name="layout" />
      </button>
      <button className="icon-btn" data-tip={t("common.back")} aria-label={t("common.back")} disabled={!canBack} onClick={onBack}>
        <Icon name="arrow-l" />
      </button>
      <button className="icon-btn" data-tip={t("common.forward")} aria-label={t("common.forward")} disabled={!canForward} onClick={onForward}>
        <Icon name="arrow-r" />
      </button>
      <nav className="title-menus" aria-label={t("nav.menu")}>{menus}</nav>
      <div className="titlebar-end">
        <PreviewSwitch
          enabled={previewMode.enabled}
          preview={previewMode.preview}
          onToggle={() => {
            if (modelConfigHasUnsavedChanges() && !window.confirm(t("shell.unsavedModelConfigConfirm"))) return;
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
const PROJECT_THREADS_INITIAL = PROJECT_HISTORY_INITIAL_LIMIT;
const PROJECT_THREADS_PAGE = PROJECT_HISTORY_PAGE_SIZE;
const PROJECT_THREADS_QUERY_MAX = PROJECT_HISTORY_QUERY_MAX;

/** A live provisional row is already openable before the archive catalog sees it. */
export function shouldOpenLiveProvisional(
  provisionalSessionId: string,
  liveSessionId: string | undefined,
): boolean {
  return liveSessionId !== undefined && provisionalSessionId === liveSessionId;
}

/* 底栏高度：默认对齐 tokens.css --bottom-panel-h；夹取对齐 ver1 工作台 120–480。 */
const BOTTOM_PANEL_DEFAULT = 240;
const BOTTOM_PANEL_MIN = 120;
const BOTTOM_PANEL_MAX = 480;

function clampBottomHeight(px: number): number {
  if (!Number.isFinite(px)) return BOTTOM_PANEL_DEFAULT;
  return Math.min(BOTTOM_PANEL_MAX, Math.max(BOTTOM_PANEL_MIN, Math.round(px)));
}

/** 侧栏会话行 ⋯ 菜单可执行的会话动作（与顶栏「对话选项」同一套）。 */
type ThreadRowActionKind = "rename" | "fork" | "handoff" | "compact" | "export";

type ShellChrome = {
  collapsed: boolean;
  skillsOpen: boolean;
  explorerOpen: boolean;
  /** 当前选中项目的会话列表是否展开（项目头 chevron 可收起，ver1/ver2 语义）。 */
  projectListExpanded: boolean;
  /** Real-mode project rows keep independent expansion state. */
  expandedProjects: ReadonlySet<string>;
  /** Real-mode active history, keyed by opaque workspace id. */
  projectHistories: ProjectHistoryCache;
  /** Renderer-only rows for fresh sessions with a draft or accepted prompt. */
  provisionalThreads: ReadonlyArray<ProvisionalProjectThread>;
  /** Current blank-history workbench, used only for active-row styling. */
  activeProvisionalSessionId?: SessionId;
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
  /** Lazy-load one project's active history when its row is expanded. */
  onLoadProjectHistory: (workspaceId: string) => void;
  onSelectThread: (entry: SessionHistoryEntry, workspaceId?: WorkspaceId) => void;
  /** Select a submitted session before its persisted history row has replaced the provisional row. */
  onSelectProvisionalThread: (thread: ProvisionalProjectThread) => void;
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
  onArchiveThread: (entry: SessionHistoryEntry, workspaceId?: WorkspaceId) => void;
  /** Resolve and archive a submitted session whose sidebar row is still provisional. */
  onArchiveProvisionalThread: (thread: ProvisionalProjectThread) => void;
  /** 历史页「取消归档」：session.unarchive，恢复到进行中列表。 */
  onUnarchiveThread: (entry: SessionHistoryEntry) => void;
  /** 历史页「删除会话」：session.delete，永久删除本地文件与相关残留。 */
  onDeleteSessionThread: (entry: SessionHistoryEntry) => Promise<boolean>;
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
  /** 压缩进行中：取消当前压缩（core.abort，与原生 Esc 同语义）。 */
  onCancelCompact: () => void;
  /** 顶栏「对话选项」：导出对话 HTML（builtin.export，路径来自命令输出）。 */
  onExportThread: () => void;
  /** 侧栏会话行 ⋯ 菜单：先打开（必要时 resume）所在行会话，再执行顶栏同款动作。 */
  onThreadRowAction: (entry: SessionHistoryEntry, workspaceId: WorkspaceId | undefined, action: ThreadRowActionKind) => void;
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
  /** Explorer 文件「更多」菜单：本机已安装编辑器（「打开方式」子菜单数据）。 */
  fileOpeners: ReadonlyArray<FileOpenerOption>;
  /** undefined = 可用；否则为文件级桌面动作的禁用原因（非桌面端）。 */
  fileShellUnavailable: string | undefined;
  /** Explorer 文件「更多」菜单动作分发（打开 / 打开方式 / 资源管理器 / 复制路径）。 */
  onFileShellAction: (workspaceId: string, action: FileMenuAction, target: FileMenuTarget) => void;
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
  const { t } = useI18n();
  if (!reading && !writing) return null;
  return (
    <span className="live">
      {reading ? <span className="dot red pulse" role="img" aria-label={t("common.reading")} data-tip={t("common.reading")} /> : null}
      {writing ? <span className="dot green pulse" role="img" aria-label={t("common.writing")} data-tip={t("common.writing")} /> : null}
    </span>
  );
}

/** Explorer 行「⋯ 更多」菜单的下发束见 menus.tsx 的 FileMenuController。 */
type TreeFileMenu = FileMenuController;

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
  fileMenu,
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
  fileMenu: TreeFileMenu;
  gitStatus?: ReadonlyMap<string, TreeGitStatus> | undefined;
  fileActivity?: ExplorerFileActivity;
}) {
  const { t } = useI18n();
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
            aria-label={`${node.name} ${t("nav.folder")}`}
            tabIndex={activePath === node.path ? 0 : -1}
            style={pad}
            onFocus={() => onSelect(node.path)}
            onClick={() => { onSelect(node.path); onToggle(node.path); }}
            onContextMenu={(event) => fileMenu.onContext(event, node.path)}
            onKeyDown={(event) => onKeyDown(event, node, parentPath)}
          >
            <span className="tw"><Icon name="chevron-r" extra="sm" /></span>
            <span className="fi"><Icon name={open ? "folder-open" : "folder"} /></span>
            <span className="fname ellipsis">{node.name}</span>
            <TreeLiveDots reading={live.reading} writing={live.writing} />
            <GitTreeBadge status={gitStat} />
            <span className="fop">
              <button type="button" className="icon-btn" data-tip={t("shell.addContext")} aria-label={`${t("shell.addContext")} ${node.path}`} onClick={(event) => { event.stopPropagation(); onContext(node.path, "dir"); }}><Icon name="at" /></button>
              <FileRowMenu
                id={node.path}
                openId={fileMenu.openId}
                onToggle={fileMenu.onToggle}
                contextPoint={fileMenu.openId === node.path ? fileMenu.point : null}
                target={{ path: node.path, name: node.name, kind: "dir" }}
                openers={fileMenu.openers}
                desktopActionsReason={fileMenu.desktopReason}
                onAction={fileMenu.onAction}
              />
            </span>
          </div>
          <div className="tree-children" role="group">
            {loadingPaths.has(node.path) ? (
              <div className="tree-row muted" style={{ ["--depth-pad" as string]: `${(depth + 1) * 14 + 6}px` } as CSSProperties} role="status">
                <span className="tw" />
                <span className="fi"><span className="spinner" aria-hidden="true" /></span>
                <span className="fname ellipsis">{t("common.reading")}</span>
              </div>
            ) : node.children ? <WorkspaceTreeNodes nodes={node.children} depth={depth + 1} parentPath={node.path} expanded={expanded} loadingPaths={loadingPaths} activePath={activePath} registerNode={registerNode} createKind={createKind} createParentPath={createParentPath} createName={createName} createBusy={createBusy} createError={createError} createInputRef={createInputRef} onCreateNameChange={onCreateNameChange} onCreateSubmit={onCreateSubmit} onCreateCancel={onCreateCancel} onSelect={onSelect} onKeyDown={onKeyDown} onToggle={onToggle} onFile={onFile} onContext={onContext} fileMenu={fileMenu} fileActivity={fileActivity} {...(gitStatus !== undefined ? { gitStatus } : {})} /> : null}
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
        onContextMenu={(event) => fileMenu.onContext(event, node.path)}
        onKeyDown={(event) => onKeyDown(event, node, parentPath)}
      >
        <span className="tw" />
        <span className="fi"><Icon name={code ? "file-code" : "file"} /></span>
        <span className="fname ellipsis">{node.name}</span>
        <TreeLiveDots reading={live.reading} writing={live.writing} />
        <GitTreeBadge status={gitStat} />
        <span className="fop">
          <button type="button" className="icon-btn" data-tip={t("shell.addContext")} aria-label={`${t("shell.addContext")} ${node.path}`} onClick={(event) => { event.stopPropagation(); onContext(node.path, "file"); }}><Icon name="at" /></button>
          <FileRowMenu
            id={node.path}
            openId={fileMenu.openId}
            onToggle={fileMenu.onToggle}
            contextPoint={fileMenu.openId === node.path ? fileMenu.point : null}
            target={{ path: node.path, name: node.name, kind: "file" }}
            openers={fileMenu.openers}
            desktopActionsReason={fileMenu.desktopReason}
            onAction={fileMenu.onAction}
          />
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
            placeholder={createKind === "file" ? t("shell.fileName") : t("shell.folderName")}
            aria-label={createKind === "file" ? t("shell.newFileName") : t("shell.newFolderName")}
            disabled={createBusy}
            autoFocus
          />
          <button type="submit" className="icon-btn" data-tip={t("common.create")} aria-label={t("common.create")} disabled={createBusy}><Icon name="check" extra="sm" /></button>
          <button type="button" className="icon-btn" data-tip={t("common.cancel")} aria-label={t("common.cancel")} disabled={createBusy} onClick={onCreateCancel}><Icon name="x" extra="sm" /></button>
        </form>
        {createBusy ? <div className="tree-new-status muted tiny" style={createPad} role="status">{t("common.loading")}</div> : null}
        {createError ? <div className="tree-new-status error tiny" style={createPad} role="alert">{createError}</div> : null}
      </>
    ) : null}
  </>;
}

const EMPTY_FILE_OPENERS: ReadonlyArray<FileOpenerOption> = [];

export function RealFileTree({ client, workspaceId, label, refreshToken, search, gitStatus, fileActivity = EMPTY_EXPLORER_FILE_ACTIVITY, createKind, createParentPath, createName, createBusy, createError, createInputRef, onCreateNameChange, onCreateSubmit, onCreateCancel, onSelectionChange, onAddContext, fileOpeners = EMPTY_FILE_OPENERS, fileShellUnavailable, onFileAction }: {
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
  /** 「打开方式」子菜单的已安装编辑器清单（App 侧拉取）。 */
  fileOpeners?: ReadonlyArray<FileOpenerOption>;
  /** undefined = 文件级桌面动作可用；否则为禁用原因（非桌面端）。 */
  fileShellUnavailable?: string | undefined;
  /** 除「目录展开 / 添加上下文」外的菜单动作分发（App 侧统一 toast 与桌面调用）。 */
  onFileAction?: (action: FileMenuAction, target: FileMenuTarget) => void;
}) {
  const [model, setModel] = useState<WorkspaceFileTreeReadModel | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const expandedRef = useRef(new Set<string>());
  /* 待恢复的记忆展开路径（相对 workspaceId）；null = 无恢复在进行。 */
  const pendingRestoreRef = useRef<ReadonlySet<string> | null>(null);
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
      const remembered = readExplorerExpansion(String(workspaceId));
      pendingRestoreRef.current = remembered.size > 0 ? remembered : null;
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
  /* 启动 / 刷新后恢复记忆的目录展开：目录 children 懒加载，路径逐级可见，
     每次模型更新推进一层，直到全部落地或没有更多可加载的目录。 */
  useEffect(() => {
    if (model === null) return;
    const pending = pendingRestoreRef.current;
    if (pending === null) return;
    let next: Set<string> | undefined;
    for (const path of pending) {
      if (findWorkspaceNode(model.nodes, path)?.type !== "dir") continue;
      if (!expandedRef.current.has(path)) {
        next ??= new Set(expandedRef.current);
        next.add(path);
      }
    }
    if (next) {
      expandedRef.current = next;
      setExpanded(next);
    }
    let loading = false;
    for (const path of pending) {
      const node = findWorkspaceNode(model.nodes, path);
      if (node?.type === "dir" && node.children === undefined) {
        void loadDirectory(path);
        loading = true;
      }
    }
    if (!loading) pendingRestoreRef.current = null;
  }, [loadDirectory, model]);
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
    /* 用户手动切换后剩余恢复让位于当前操作，并按现状更新记忆。 */
    pendingRestoreRef.current = null;
    const open = expandedRef.current.has(path);
    const next = new Set(expandedRef.current);
    if (open) next.delete(path); else next.add(path);
    expandedRef.current = next;
    setExpanded(next);
    writeExplorerExpansion(String(workspaceId), next);
    if (!open && model && findWorkspaceNode(model.nodes, path)?.children === undefined) void loadDirectory(path);
  }, [loadDirectory, model, workspaceId]);
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
  const { t } = useI18n();
  // 行「⋯ 更多」菜单：同一时刻至多一个弹层；Escape / 点外部关闭（会话行菜单同款）。
  const [fileMenuOpenId, setFileMenuOpenId] = useState<string | null>(null);
  /** 非 null = 当前弹层由行右键打开，贴该光标点；null = 由 ⋯ 按钮打开。 */
  const [fileMenuPoint, setFileMenuPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (fileMenuOpenId === null) return;
    const close = () => setFileMenuOpenId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [fileMenuOpenId]);
  const toggleFileMenu = useCallback((id: string | null) => {
    // 按钮打开一律锚定按钮，清掉旧右键点。
    setFileMenuPoint(null);
    setFileMenuOpenId(id);
  }, []);
  const openFileMenuAtCursor = useCallback((event: { clientX: number; clientY: number; preventDefault(): void }, path: string) => {
    event.preventDefault();
    setFileMenuPoint({ x: event.clientX, y: event.clientY });
    setFileMenuOpenId(path);
  }, []);
  const handleMenuAction = useCallback((action: FileMenuAction, target: FileMenuTarget) => {
    if (action.type === "addContext") {
      onAddContext?.(target.path, target.kind);
      return;
    }
    // 目录的「打开」= 树内展开/收起（与点击目录行同一条 toggle 链）。
    if (action.type === "open" && target.kind === "dir") {
      toggle(target.path);
      return;
    }
    onFileAction?.(action, target);
  }, [onAddContext, onFileAction, toggle]);
  const fileMenu = useMemo<TreeFileMenu>(() => ({
    openId: fileMenuOpenId,
    point: fileMenuPoint,
    openers: fileOpeners,
    desktopReason: fileShellUnavailable ?? (onFileAction === undefined ? t("shell.fileDesktopOnly") : undefined),
    onToggle: toggleFileMenu,
    onContext: openFileMenuAtCursor,
    onAction: handleMenuAction,
  }), [fileMenuOpenId, fileMenuPoint, fileOpeners, fileShellUnavailable, handleMenuAction, onFileAction, openFileMenuAtCursor, t, toggleFileMenu]);
  if (loading && model === null) return <div className="empty"><p className="muted small">{t("common.reading")}</p></div>;
  if (model === null) return <div className="empty"><p className="muted small">{message ?? t("common.unavailable")}</p></div>;
  return <>
    {message ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{message}</div> : null}
    <div className="tree" role="tree" aria-label={label} onClick={clearBlankSelection}>
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
          onAddContext?.(path, kind);
        }}
        fileMenu={fileMenu}
        gitStatus={gitStatus}
        fileActivity={fileActivity}
      />
    </div>
    <div className="sr-only" aria-live="polite">{loading ? t("common.loading") : ""}</div>
    <span className="sr-only">{model.nodes.length}</span>
  </>;
}

export function AppSidebar({ state, chrome, client, onRoute, onOpenAppUpdateDialog }: { state: ViewState; chrome: ShellChrome; client: StudioClient; onRoute: (route: Route) => void; onOpenAppUpdateDialog: () => void }) {
  const { t } = useI18n();
  const { preview } = usePreviewMode();
  const appUpdate = useAppUpdate();
  const effectiveUpdate = preview ? PREVIEW_APP_UPDATE : (appUpdate.state.updateInfo?.available ? appUpdate.state.updateInfo : null);
  const hasUpdate = effectiveUpdate?.available === true;
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
      setPreviewFileMessage(`${t("common.demo")}: ${kind === "file" ? t("shell.newFile") : t("shell.newFolder")} ${path}`);
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
  const omp = runtimeStatusLabel(runtime, t);
  const liveSnapshot = snapshotFrom(state);
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
  const ompMeta = preview ? `${t("runtime.ready")} · ${t("common.demo")}` : (runtime ? formatRuntimeClassification(runtime.classification, (k) => t(k)) : t("common.unavailable"));
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
    <aside ref={sidebarRef} className={`sidebar${chrome.collapsed ? " collapsed" : ""}${chrome.explorerOpen ? "" : " explorer-collapsed"}`} id="sidebar" aria-label={t("shell.projectAndChat")} style={{ width: chrome.sidebarWidth }}>
      <div className="sidebar-resizer" id="sbResizer" role="separator" aria-orientation="vertical" aria-label={t("shell.adjustPanelWidth")} tabIndex={0} onPointerDown={onResizePointerDown} />
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
          <span className="meta"><span className="hint">Ctrl ⇧ O</span></span>
        </button>
        <button className="action-row skills-btn" aria-label={t("skills.sidebarAction")} aria-expanded={chrome.skillsOpen} aria-controls="skillsDrawer" onClick={chrome.onToggleSkills}>
          <Icon name="layers" />
          <span className="lbl">{t("skills.sidebarAction")}</span>
          <span className="meta"><span className="count">{chrome.skillsEnabledCount}</span><Icon name="chevron-r" extra="sm chev" /></span>
        </button>
      </div>
      <section className="sb-section" id="sbProjects" aria-labelledby="sbProjectsTitle" style={{ ["--sb-proj-basis" as string]: `${projectShare.toFixed(3)}%` }}>
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
                          onClick={() => chrome.onSelectPreviewThread(thread.id)}
                        >
                          <ThreadSpin running={running} />
                          <span className="t-title"><span className="t-scroll">{thread.title}</span></span>
                          {wait || running ? null : <span className="t-meta">{thread.time}</span>}
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
                                  reason={t("common.unavailableInPreview")}
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
                        {wait ? <ThreadWaitChip kind={wait} /> : null}
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
                            onClick={() => chrome.onSelectThread(entry, workspace.workspaceId as WorkspaceId)}
                          >
                            <ThreadSpin running={running} />
                            <span className="t-title">
                              {entry.pinned === true ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
                              <span className="t-scroll">{sidebarThreadTitle(entry, provisional, t("conversation.untitledSession"))}</span>
                            </span>
                            {wait || running ? null : <span className="t-meta">{relativeTime(entry.lastActiveAt)}</span>}
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
                          {wait ? <ThreadWaitChip kind={wait} /> : null}
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
                      {historyState?.status === "loading" && !total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{t("common.loading")}</p></div> : null}
                      {historyState?.status === "error" && !total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{historyState.error ?? t("history.catalogUnavailable")}</p></div> : null}
                      {historyState?.status !== "loading" && historyState?.status !== "error" && !total ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">{t("home.noRecentSessions")}</p></div> : null}
                    </>);
                  })() : null}
                </div>
              );
            })
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
          <h2 id="sbFilesTitle">{t("shell.workspace")}</h2>
          <div className="sb-head-actions">
            <button className={`icon-btn${newEntryKind === "file" ? " active" : ""}`} data-tip={t("shell.newFile")} aria-label={t("shell.newFile")} aria-pressed={newEntryKind === "file"} disabled={!chrome.selectedProject || newEntryBusy} onClick={() => beginWorkspaceEntry("file")}><Icon name="plus" extra="sm" /></button>
            <button className={`icon-btn${newEntryKind === "directory" ? " active" : ""}`} data-tip={t("shell.newFolder")} aria-label={t("shell.newFolder")} aria-pressed={newEntryKind === "directory"} disabled={!chrome.selectedProject || newEntryBusy} onClick={() => beginWorkspaceEntry("directory")}><Icon name="folder" extra="sm" /></button>
            <button className={`icon-btn${fileSearch ? " active" : ""}`} data-tip={t("common.filter")} aria-label={t("shell.filterLoadedFiles")} onClick={() => setFileSearch((value) => value ? "" : " ")}><Icon name="search" extra="sm" /></button>
            <button className="icon-btn" data-tip={t("common.refresh")} aria-label={t("shell.refreshFileTree")} disabled={!chrome.selectedProject} onClick={() => preview ? setPreviewFileMessage(`${t("common.demo")}: ${t("shell.refreshFileTree")}`) : setFileRefreshToken((value) => value + 1)}><Icon name="refresh" extra="sm" /></button>
          </div>
          <button className={`icon-btn sb-collapse-btn${chrome.explorerOpen ? "" : " is-collapsed"}`} aria-label={chrome.explorerOpen ? t("menu.collapseExplorer") : t("menu.expandExplorer")} aria-expanded={chrome.explorerOpen} onClick={chrome.onToggleExplorer}>
            <Icon name={chrome.explorerOpen ? "chevron-d" : "chevron-u"} extra="sm" />
          </button>
        </div>
        {fileSearch ? <div style={{ padding: "4px 10px" }}><input autoFocus className="input" value={fileSearch.trim()} onChange={(event) => setFileSearch(event.target.value || " ")} placeholder={`${t("shell.filterLoadedFiles")}…`} aria-label={t("shell.filterLoadedFiles")} /></div> : null}
        {preview && previewFileMessage ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{previewFileMessage}</div> : null}
        <div className="sb-scroll">
          {preview ? (
            <PreviewFileTree
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
          className={`sb-user${hasUpdate ? " has-update" : ""}`}
          aria-label={`${profile.displayName} · ${hasUpdate ? `${t("appUpdate.foundNewVersion")} v${effectiveUpdate?.version} · ` : ""}OMP 状态与环境菜单`}
          aria-haspopup="menu"
          aria-expanded={chrome.ompMenuOpen}
          onClick={chrome.onToggleOmpMenu}
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
            <span className="u-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>{profile.displayName}</span>
              {hasUpdate && (
                <span
                  style={{
                    fontSize: "0.68rem",
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: "var(--accent, #3b82f6)",
                    color: "#fff",
                    fontWeight: 600,
                    lineHeight: 1.2,
                  }}
                >
                  v{effectiveUpdate?.version}
                </span>
              )}
            </span>
            <span className={`u-status ${hasUpdate ? "ok" : omp.tone}`} role="status" aria-live="polite">
              <span className={`dot ${hasUpdate ? "green pulse" : omp.tone === "ok" ? "green pulse" : omp.tone === "err" ? "red" : "amber"}`} aria-hidden="true" />
              <span>{hasUpdate ? `${t("appUpdate.foundNewVersion")} v${effectiveUpdate?.version}` : omp.text}</span>
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

function telemetrySourceChip(view: ViewedSessionTelemetryState | undefined, fallback: "live" | undefined, t: (key: any) => string): { label: string; cls: string } | undefined {
  const source = view?.source ?? fallback;
  if (source === undefined) return undefined;
  if (source === "live") return { label: t("shell.realtime"), cls: "chip blue xs" };
  if (source === "persisted") return { label: t("shell.lastRecorded"), cls: "chip blue xs" };
  if (source === "archive-recomputed") return { label: t("shell.currentEnvRecomputed"), cls: "chip blue xs" };
  return undefined;
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
  const { t: tr } = useI18n();
  if (telemetry === null) {
    const reason = view?.status === "unavailable" ? tr("common.unavailable") : view?.status === "loading" ? tr("common.loading") : tr("common.unavailable");
    return <><div className="tp-head"><Icon name="zap" extra="sm" />{tr("shell.tokenUsage")}<span className="spacer" /><span className="chip gray xs">{view?.status === "loading" ? tr("common.loading") : tr("common.unavailable")}</span></div><div className="tp-ctx"><div className="tiny muted">{reason}</div></div></>;
  }
  const t = telemetry.tokens;
  const turn = telemetry.lastCompletedTurn;
  const chip = telemetrySourceChip(view, "live", tr);
  const cacheSavedPct = t.cacheRead + t.input > 0 ? Math.round((t.cacheRead / (t.cacheRead + t.input)) * 100) : 0;
  const splitTotal = t.input + t.output + t.cacheRead + t.cacheWrite;
  const splitPct = (value: number): number => (splitTotal > 0 ? Math.min(100, (value / splitTotal) * 100) : 0);
  return <>
    <div className="tp-head"><Icon name="zap" extra="sm" />{tr("shell.tokenUsage")}<span className="spacer" />{chip === undefined ? null : <span className={chip.cls}>{chip.label}</span>}</div>
    <div className="tok-hero"><div className="th-cell"><div className="th-k">{tr("shell.totalTokens")}</div><div className="th-v">{formatTelemetryTokens(t.total)}</div><div className="th-sub">{turn ? `${formatTelemetryTokens(turn.total)}` : "—"}</div></div><div className="th-cell"><div className="th-k">{tr("shell.cost")}</div><div className="th-v">{formatTelemetryCost(t.cost)}</div><div className="th-sub">{tr("shell.cacheSaved")} <b>{cacheSavedPct}%</b></div></div></div>
    <div className="tok-split">
      <div className="ts-top"><span>{tr("shell.composition")}</span><b>{formatTelemetryTokens(t.input)} / {formatTelemetryTokens(t.output)}</b></div>
      <div className="tok-bar">
        {splitTotal <= 0
          ? <i className="tb-none" />
          : <><i className="tb-in" style={{ width: `${splitPct(t.input)}%` }} /><i className="tb-out" style={{ width: `${splitPct(t.output)}%` }} /><i className="tb-cache" style={{ width: `${splitPct(t.cacheRead + t.cacheWrite)}%` }} /></>}
      </div>
      <div className="tok-keys">
        <span><i className="tb-in" />{tr("shell.inputTokens")}</span>
        <span><i className="tb-out" />{tr("shell.outputTokens")}</span>
        <span><i className="tb-cache" />{tr("shell.cacheTokens")} {formatTelemetryTokens(t.cacheRead + t.cacheWrite)} · <b>{cacheSavedPct}%</b></span>
      </div>
    </div>
    <div className="tok-rows">
      <div className="tr-row">{tr("shell.turnInputOutput")}<span className="tr-v">{turn ? `${formatTelemetryTokens(turn.input)} / ${formatTelemetryTokens(turn.output)}` : "—"}</span></div>
      <div className="tr-row">{tr("shell.turnDuration")}<span className="tr-v">{turn?.durationMs !== undefined ? formatTelemetryDuration(turn.durationMs) : "—"}</span></div>
      <div className="tr-row">TPS<span className="tr-v">{turn?.tps !== undefined ? turn.tps.toFixed(1) : "—"}</span></div>
      <div className="tr-row">Reasoning<span className="tr-v">{formatTelemetryTokens(t.reasoning)}</span></div>
      <div className="tr-row">Cache read<span className="tr-v">{formatTelemetryTokens(t.cacheRead)}</span></div>
      <div className="tr-row">Cache write<span className="tr-v">{formatTelemetryTokens(t.cacheWrite)}</span></div>
      <div className="tr-row">{tr("shell.lastCompletedTime")}<span className="tr-v">{turn ? formatTelemetryTime(turn.completedAt) : "—"}</span></div>
    </div>
  </>;
}

function RealContextTrigger({ telemetry }: { telemetry: SessionTelemetrySnapshot | null }) {
  const percent = telemetry?.context?.percent;
  return <><span className="ctx-ring" style={{ ["--p" as string]: percent ?? 0 }} aria-hidden="true" /><span className="t-item"><b>{percent === undefined ? "—" : `${Math.round(percent)}%`}</b></span></>;
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

function AppTopbar({ state, client, chrome, onRoute, threadTitle, sideOpen, onToggleSide, onOpenChanges, onOpenGit, onOpenTerminal, viewedSessionId, telemetryRefreshToken }: {
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
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const { preview } = usePreviewMode();
  /** 对话动作可用性：写表面始终走真实 API（预览只覆盖读表面），
      因此只看真实 Runtime 快照；无活动会话时诚实禁用并说明原因。 */
  const liveSnapshot = snapshotFrom(state);
  const sessionLive = liveSnapshot !== undefined;
  const sessionBusy = liveSnapshot?.isStreaming === true || liveSnapshot?.isCompacting === true;
  const sessionActionReason = !sessionLive ? t("common.unavailable") : t("common.loading");
  const previewProject = findPreviewProject(chrome.previewProjectId);
  const previewHit = findPreviewThread(chrome.previewThreadId);
  const realActiveWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
  // 与侧栏项目树同一顺序，避免「切换项目」菜单在每次切换后重排。
  const switchProjectOptions = useMemo(
    () => sidebarProjectOrder(state.model.workspaces),
    [state.model.workspaces],
  );
  const realGit = useGitRepository(client, preview ? undefined : realActiveWorkspace?.workspaceId);
  const crumbProject = preview
    ? (previewProject?.name ?? "omp-web")
    : (realActiveWorkspace?.name ?? t("conversation.noProjectSelected"));
  const crumbBranch = preview ? (previewProject?.branch ?? "main") : (realGit.repository?.branch ?? (realGit.repository?.detached ? "detached HEAD" : "—"));
  const crumbThread = preview ? (previewHit?.thread.title ?? threadTitle) : threadTitle;
  const viewedTelemetry = useViewedSessionTelemetry({
    client: preview ? null : client,
    preview,
    viewedSessionId,
    liveSessionId: preview ? undefined : snapshotFrom(state)?.sessionId,
    liveTelemetry: preview ? undefined : (state.clientState?.entities.telemetry ?? undefined),
    ...(telemetryRefreshToken === undefined ? {} : { refreshToken: telemetryRefreshToken }),
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
        <nav className="tb-crumb" aria-label={t("shell.currentLocation")}>
          <CrumbMenu
            id="project"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip={t("shell.project")}
            menu={
              <>
                <div className="menu-label">{t("shell.switchProject")}</div>
                {preview ? PREVIEW_PROJECTS.map((project) => (
                  <MenuItem
                    key={project.id}
                    icon="folder-open"
                    current={project.id === chrome.previewProjectId}
                    hint={project.id === chrome.previewProjectId ? t("shell.current") : project.branch}
                    onClick={() => run(() => chrome.onSelectPreviewProject(project.id))}
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
                        onClick={() => run(() => chrome.onSelectProject({ id: workspace.workspaceId, name: workspace.name }))}
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
                  onClick={() => run(chrome.onOpenProjectInEditor)}
                >{t("shell.openInExternalEditor")}</MenuItem>
                <MenuItem icon="terminal" onClick={() => run(onOpenTerminal)}>{t("shell.openInTerminal")}</MenuItem>
                <MenuItem
                  icon="folder-open"
                  disabled={chrome.projectShellUnavailable !== undefined || chrome.projectShellAction !== null}
                  {...(chrome.projectShellUnavailable !== undefined
                    ? { title: chrome.projectShellUnavailable }
                    : chrome.projectShellAction === "directory"
                      ? { title: t("common.loading") }
                      : {})}
                  onClick={() => run(chrome.onOpenProjectDirectory)}
                >{t("shell.openProjectDirectory")}</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>{t("menu.projectHome")}</MenuItem>
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
            tip={t("shell.branch")}
            menu={
              <>
                <div className="branch-menu-head">
                  <div className="bmh-title"><Icon name="branch" extra="sm" /><b>{crumbBranch}</b></div>
                  <div className="bmh-meta">{preview ? `${previewProject?.dirty ?? 0} ${t("shell.uncommitted")} · ${t("common.demo")}` : realGit.repository?.isRepository ? `${realGit.repository.changes.length} ${t("shell.uncommitted")} · ↑${realGit.repository.ahead} ↓${realGit.repository.behind}` : (realGit.error ?? t("common.unavailable"))}</div>
                </div>
                <MenuItem icon="commit" onClick={() => run(onOpenGit)}>{t("shell.uncommittedChanges")}</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="columns" onClick={() => run(onOpenChanges)}>{t("shell.viewChanges")}</MenuItem>
                <MenuItem icon="commit" onClick={() => run(onOpenGit)}>{t("shell.createCommit")}</MenuItem>
                <MenuItem icon="branch" onClick={() => run(onOpenGit)}>{t("shell.switchBranch")}</MenuItem>
                <MenuItem icon="worktree" onClick={() => run(onOpenGit)}>{t("shell.newWorktree")}</MenuItem>
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
              </>
            }
          >
            <span className="ellipsis" data-tip={crumbThread}>{crumbThread}</span>
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
      </div>
      <button className="icon-btn lg" data-tip={t("menu.agentHub")} aria-label="Agent Hub" onClick={() => onRoute("agent-hub")}><Icon name="bot" extra="lg" /></button>
      <button className="icon-btn" data-tip={t("nav.history")} aria-label={t("nav.history")} onClick={() => onRoute("history")}><Icon name="history" /></button>
      <div className="tb-right">
        <div className="telemetry">
          <AnchoredPop
            id="tokens"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="Token"
            label={t("shell.tokenUsageDetails")}
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
            label={t("shell.contextCompositionDetails")}
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop ctx-pop"
            panel={preview ? <PreviewContextPanel /> : <RealContextPanel telemetry={telemetry} view={viewedTelemetry} />}
          >
            {preview ? <PreviewContextTrigger /> : <RealContextTrigger telemetry={telemetry} />}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          {chrome.compactPending === true || liveSnapshot?.isCompacting === true ? (
            <button
              className="tb-compact"
              disabled={!sessionLive}
              data-tip={!sessionLive ? sessionActionReason : t("common.cancel")}
              aria-label={t("common.cancel")}
              onClick={() => run(chrome.onCancelCompact)}
            >
              <Icon name="x" extra="sm" />
              {t("common.cancel")}
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
              Compact
            </button>
          )}
        </div>
        <button className={`icon-btn${sideOpen ? " active" : ""}`} data-tip={t("menu.rightPanel")} aria-controls="sidePanel" aria-expanded={sideOpen} onClick={onToggleSide}><Icon name="panel" /></button>
        <button className="icon-btn" data-tip={t("shell.theme")} onClick={chrome.onToggleTheme} aria-label={t("shell.theme")}>
          <Icon name={chrome.theme === "dark" ? "moon" : "light"} />
        </button>
        <button className="icon-btn" data-tip={t("nav.home")} onClick={() => onRoute("home")}><Icon name="home" /></button>
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
      // Menus and flyouts are absolutely positioned descendants and may enlarge
      // bar.scrollWidth while open. Only the in-flow capsule cluster represents
      // real pressure against the model picker.
      // Resetting collapse to "full" then back reflows the bar. Do not do that
      // while a composer menu is open: capsule toggles would make the popup jump.
      if (bar.querySelector("[aria-expanded='true']")) return;
      // 无变化不写：本 hook 自己观察着这个 bar（ResizeObserver），无条件改写
      // data-collapse 会触发布局变化又把观察者唤醒，形成 rAF 级自持循环。
      const setCollapse = (value: string) => {
        if (bar.dataset.collapse !== value) bar.dataset.collapse = value;
      };
      setCollapse("full");
      if (!hasPressure()) return;
      setCollapse("model");
      if (!hasPressure()) return;
      setCollapse("modes");
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

function WorkbenchCanvas({ state, client, selectedSessionId, viewedAgents, selectedThreadId, viewIdentity, previewProjectId, previewThreadId, sessionCreating, waitForNewSession, ensureNewSession, onSelectProject, onSelectPreviewProject, onSelectPreviewThread, onSelectThread, onBranchedSession, hiddenPreviewThreads, onPreviewDeckWait, sideOpen, onCloseSide, sideTab, onSideTabChange, panelWidth, onResizePanel, bottomOpen, onBottomOpenChange, bottomVisible, onBottomVisibleChange, bottomHeight, onResizeBottom, bottomTab, onBottomTabChange, onRoute, onOpenChanges, onOpenGit, composerRef, workspaceId, onSlashUi, onDraftSkillsChange, onUsedSkillsChange, onSessionTitleMaybeChanged, onProvisionalSessionChange, onPinCompleted, btwWindow, btwSession, btwSideHeadRect, onBtwDemoNext, onBtwPreviewAsk, createProjectNonce, compactPending, onCompactPending, onViewedTelemetryRefresh, composerDraft, onComposerDraftChange }: {
  state: ViewState;
  client: ClientStateSource;
  selectedSessionId?: string;
  viewedAgents?: readonly StudioAgentSnapshot[];
  selectedThreadId?: ThreadId;
  /** Stable renderer view identity; changes even while history entry resolution is pending. */
  viewIdentity?: string;
  /** 后台 session.create 进行中：欢迎区照常显示，发送前再等就绪。 */
  sessionCreating?: boolean;
  waitForNewSession?: () => Promise<NewSessionWaitResult>;
  /** Start session.create when sending from an empty workbench with no live session. */
  ensureNewSession?: () => void;
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
  /** Entire tab strip on screen; independent of `bottomOpen` (tab body). */
  bottomVisible: boolean;
  onBottomVisibleChange: (visible: boolean) => void;
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
  onProvisionalSessionChange?: (state: {
    readonly sessionId?: SessionId;
    readonly workspaceId?: WorkspaceId;
    readonly visible: boolean;
    readonly title?: string;
    readonly running: boolean;
    readonly submitted: boolean;
  }) => void;
  /** Refresh Host history after Runtime's `/pin` command persists its global pin file. */
  onPinCompleted?: () => Promise<void>;
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
  onViewedTelemetryRefresh?: () => void;
  onComposerDraftChange?: (sessionId: string, draft: ComposerSnapshot) => void;
  composerDraft?: ComposerSnapshot;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ComposerSnapshot>(emptySnapshot);
  const composerDraftRef = useRef<ComposerSnapshot | undefined>(composerDraft);
  composerDraftRef.current = composerDraft;
  const [submittedPrompt, setSubmittedPrompt] = useState<{ readonly sessionId?: SessionId; readonly title: string } | undefined>(undefined);
  const [bottomResizing, setBottomResizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planSaveBusy, setPlanSaveBusy] = useState(false);
  const planSaveBusyRef = useRef(false);
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
  const [modeCapsulesPresent, setModeCapsulesPresent] = useState(false);
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
  // Composer content belongs to the viewed conversation, not to the workbench
  // shell.  Clear the editor when navigation changes the conversation identity
  // so a draft from A can never leak into B (or the fresh-chat surface).
  const composerViewRef = useRef<{ readonly sessionId: string | undefined; readonly threadId: string | undefined; readonly viewIdentity: string | undefined }>({
    sessionId: selectedSessionId,
    threadId: selectedThreadId,
    viewIdentity,
  });
  useEffect(() => {
    const previous = composerViewRef.current;
    composerViewRef.current = { sessionId: selectedSessionId, threadId: selectedThreadId, viewIdentity };
    if (previous.sessionId === selectedSessionId && previous.threadId === selectedThreadId && previous.viewIdentity === viewIdentity) return;
    composerInputRef.current?.clear();
    const restored = composerDraftRef.current ?? emptySnapshot();
    setDraft(restored);
    if (!snapshotIsEmpty(restored)) composerInputRef.current?.setSnapshot(restored);
    setComposerError(undefined);
    setSubmittedPrompt(undefined);
    setQueueEdit(undefined);
  }, [selectedSessionId, selectedThreadId, viewIdentity]);
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
  const submittedPromptTitle = submittedPrompt !== undefined && submittedPrompt.sessionId === snapshot?.sessionId
    ? submittedPrompt.title
    : undefined;
  const rosterAgents = viewedAgents ?? snapshot?.agents;
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
  const slashCatalog = useMemo(
    () => mergeSlashCatalogWithManifest(preview ? undefined : commandManifest),
    [commandManifest, preview],
  );
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
  /* ConversationPane 内的 minimap 与 transcript 共享同一 scroller。 */
  const convoScrollerRef = useRef<HTMLElement | null>(null);
  const welcomeGate = {
    preview,
    compacting: compactingNow,
    rowCount: convo.rows.length,
    hydrateStatus: convo.state.hydrateStatus,
    demo: convo.demo,
    ...(sessionCreating === undefined ? {} : { sessionCreating }),
    ...(previewThreadId === undefined ? {} : { previewThreadId }),
    ...(selectedSessionId === undefined ? {} : { selectedSessionId }),
  };
  const isNewConversation = isNewConversationSurface(welcomeGate);
  const showWelcome = shouldShowConversationWelcome(welcomeGate);
  /* 在屏面的欢迎态：由 ConversationPane 上报（leaving 期间保留旧屏）。壳层布局类
     跟它走，避免切换瞬间 minimap 占宽把还在淡出的欢迎页向左顶。 */
  const [surfaceWelcome, setSurfaceWelcome] = useState(showWelcome);
  const [jumpPill, setJumpPill] = useState<{ visible: boolean; jumpToLatest: () => void } | undefined>(undefined);
  const jumpPillRef = useRef<{ visible: boolean; jumpToLatest: () => void } | undefined>(undefined);
  const jumpToLatestSlot = useCallback((slot: { visible: boolean; jumpToLatest: () => void }) => {
    const previous = jumpPillRef.current;
    if (previous !== undefined && previous.visible === slot.visible && previous.jumpToLatest === slot.jumpToLatest) return;
    jumpPillRef.current = slot;
    setJumpPill(slot);
  }, []);
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
  // 项目选择器同样按稳定顺序，切换后列表不重排。
  const workspaceOptions = sidebarProjectOrder(state.model.workspaces).filter((workspace) => workspace.name.toLocaleLowerCase().includes(normalizedProjectQuery));
  const openCreateProject = () => {
    setContextProjectMenuOpen(false);
    setCreateProjectName("");
    setCreateProjectError(undefined);
    setCreateProjectOpen(true);
  };
  useEffect(() => {
    if (!createProjectNonce) return;
    openCreateProject();
  }, [createProjectNonce]);
  const createProject = async () => {
    if (createProjectBusy) return;
    const name = createProjectName.trim();
    setCreateProjectError(undefined);
    if (preview) {
      setPreviewCreatedProject({ id: `preview-created-${Date.now()}`, name: name || "演示新项目" });
      setCreateProjectOpen(false);
      return;
    }
    setCreateProjectBusy(true);
    try {
      const handle = await client.command("workspace.pick", name ? { name } : {});
      const model = await waitReceipt<WorkspaceListReadModel>(client, handle.requestId);
      const active = model.workspaces.find((workspace) => workspace.active);
      if (!active) throw new Error("选择的文件夹未注册为项目");
      onSelectProject({ id: active.workspaceId, name: active.name });
      setCreateProjectOpen(false);
    } catch (error) {
      const message = hostErrorMessage(error, "");
      if (
        (error as { readonly code?: string })?.code === "WORKSPACE_PICK_CANCELLED" ||
        (error as { readonly code?: string })?.code === "OPERATION_CANCELLED" ||
        message.toLowerCase().includes("cancel") ||
        message.includes("取消")
      ) {
        return;
      }
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
    // 「压缩后执行」与顶栏「压缩」按钮共用同一套反馈：渲染端主动点亮
    // 「压缩中」行，压缩完成、执行提交（收到回执）后再熄灭——快照的
    // isCompacting 推送在 Plan 审批路径上不保证及时可见（尤其 snapcompact）。
    const compacting = id === "compact";
    if (compacting) onCompactPending?.(true);
    try {
      return await run("mode.plan.review.respond", { decision: id });
    } finally {
      if (compacting) onCompactPending?.(false);
    }
  }, [onCompactPending, run]);
  /** 收集「保存并退出」的目标路径：桌面端经白名单 IPC 走 Main 的原生另存为
      对话框（默认 `<工作区>/PLAN.md`，返回工作区相对路径）；浏览器 dev /
      测试环境回退 window.prompt。Electron 渲染进程不支持 prompt，旧 preload
      没有新通道时保持静默失败而不是抛错。取消 / 空输入 / 工作区外 → null，
      不发起保存。 */
  const pickPlanSaveTarget = useCallback(async (): Promise<string | null> => {
    const chrome = globalThis.ompStudioChrome;
    if (chrome?.pickPlanSavePath !== undefined) {
      if (activeWorkspace === undefined) {
        setStatusToast("没有可用的本地项目，无法选择保存位置");
        return null;
      }
      const picked = await chrome.pickPlanSavePath({ workspaceId: activeWorkspace.workspaceId });
      if (picked.status === "cancelled") return null;
      if (picked.status === "outside-workspace") {
        setStatusToast(`保存位置在工作区外（${picked.fileName}），已取消保存`);
        return null;
      }
      return picked.relativePath;
    }
    try {
      const raw = window.prompt("请输入相对于工作区的 PLAN.md 路径：", "PLAN.md");
      const normalized = raw?.trim();
      if (normalized) return normalized;
    } catch {
      /* Electron 不支持 window.prompt（electron/electron#472）。 */
    }
    return null;
  }, [activeWorkspace]);
  const savePlanAndQuit = useCallback(async (): Promise<void> => {
    if (!canStartPlanSaveAndQuit(can("mode.plan.review.saveAndQuit"), planSaveBusyRef.current)) return;
    planSaveBusyRef.current = true;
    setPlanSaveBusy(true);
    try {
      const path = await pickPlanSaveTarget();
      if (path === null) return;
      const handle = await client.command("mode.plan.review.saveAndQuit", { path });
      const result = await waitReceipt<StudioPlanSaveAndQuitResult>(client, handle.requestId);
      let selected = false;
      if (result.newSession === "started") {
        if (result.sessionId !== undefined && onBranchedSession !== undefined) {
          try {
            selected = await onBranchedSession(result.sessionId);
          } catch {
            selected = false;
          }
        }
        // selectBranchedSession refreshes immediately; retain the existing delayed
        // title/history refresh path for runtimes that omit a session id.
        onSessionTitleMaybeChanged?.();
      }
      setStatusToast(planSaveAndQuitNotice(result, selected));
    } catch (error) {
      setStatusToast(hostErrorMessage(error, "保存计划并退出失败"));
    } finally {
      planSaveBusyRef.current = false;
      setPlanSaveBusy(false);
    }
  }, [can, client, onBranchedSession, onSessionTitleMaybeChanged, pickPlanSaveTarget]);
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
  const planReviewDisabled = planReviewDeckDisabled({
    resyncRequired: Boolean(connection?.resyncRequired),
    runtimeConnected,
    canRespond: can("mode.plan.review.respond"),
  });
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
  const planLink = useMemo(
    () => ({
      onOpen: openPlanFromConversation,
      ...(planReview?.title
        ? { title: planReview.title }
        : previewPlanActive
          ? { title: PREVIEW_PLAN_TITLE }
          : {}),
      ...(previewPlanActive ? { demo: true as const } : {}),
      ...((planReview !== undefined || previewPlanActive) ? { attachEvenWithoutPropose: true as const } : {}),
    }),
    [openPlanFromConversation, planReview, previewPlanActive],
  );
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
  // Title freezes on the first accepted prompt; later drafts never override it.
  const provisionalTitle = submittedPromptTitle ?? provisionalThreadTitle(draft.text);
  useEffect(() => {
    const visible = textReady || provisionalTitle !== undefined || running;
    onProvisionalSessionChange?.({
      ...((selectedSessionId ?? snapshot?.sessionId) === undefined
        ? {}
        : { sessionId: (selectedSessionId ?? snapshot?.sessionId) as SessionId }),
      ...(workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId }),
      visible,
      ...(provisionalTitle === undefined ? {} : { title: provisionalTitle }),
      running,
      submitted: submittedPromptTitle !== undefined || running,
    });
  }, [onProvisionalSessionChange, provisionalTitle, running, selectedSessionId, snapshot?.sessionId, submittedPromptTitle, textReady, workspaceId]);
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
  const hasStatusCapsules =
    modeCapsulesPresent ||
    Boolean(magicKeyword) ||
    Boolean(snapshot?.activeMode) ||
    Boolean(snapshot?.loop) ||
    Boolean(snapshot?.fast?.enabled) ||
    Boolean(snapshot?.prewalk && snapshot.prewalk.status !== "off") ||
    draft.doc.nodes.some((node) => node.type === "chip") ||
    draft.images.length > 0 ||
    queueEdit !== undefined;
  const hasDraftContent = draft.text.trim().length > 0 || !snapshotIsEmpty(draft) || hasStatusCapsules;
  useEffect(() => {
    if (running) {
      if (hasStatusCapsules || hasDraftContent) {
        setComposerExpanded(true);
      } else {
        setComposerExpanded(false);
      }
    }
  }, [running]);
  useEffect(() => {
    if (hasStatusCapsules) {
      setComposerExpanded(true);
    }
  }, [hasStatusCapsules]);
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
      setBranchNotice({ tone: "ok", text: t("git.switchedToBranch", { name }) });
    } catch (cause) {
      const blocked = switchBlockedFilesOf(cause);
      if (blocked !== undefined) {
        setSwitchBlock({ branch: name, files: blocked });
        setSwitchCommitError(undefined);
      } else {
        setBranchNotice({ tone: "error", text: hostErrorMessage(cause, t("git.switchBranchFailed")) });
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
      setBranchNotice({ tone: "ok", text: t("git.createdAndSwitchedTo", { name }) });
      void loadBranches();
    } catch (cause) {
      setBranchNotice({ tone: "error", text: hostErrorMessage(cause, t("git.createBranchFailed")) });
    } finally {
      setBranchSwitchName(undefined);
      void realGit.refresh();
    }
  }, [client, gitWorkspaceId, loadBranches, realGit.refresh]);
  const requestBranchSwitch = (name: string) => {
    setContextBranchMenuOpen(false);
    if (pendingBranchAction?.kind === "switch" && pendingBranchAction.name === name) {
      setPendingBranchAction(undefined);
      setBranchNotice({ tone: "ok", text: t("git.cancelledSwitchTo", { name }) });
      return;
    }
    if (branchActionDeferred) {
      setPendingBranchAction({ kind: "switch", name });
      setBranchNotice({ tone: "ok", text: t("git.switchBranchAfterTurn", { name }) });
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
      setBranchNotice({ tone: "ok", text: t("git.createBranchAfterTurn", { name }) });
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
      setCreateBranchError(hostErrorMessage(cause, t("git.createBranchFailed")));
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
    if (branch !== undefined) setBranchNotice({ tone: "ok", text: t("git.cancelledSwitchTo", { name: branch }) });
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
      setSwitchCommitError(hostErrorMessage(cause, t("git.commitFailed")));
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
    newConversation: !preview && isNewConversation,
  });
  const slashExecuteReady = composerSlashExecute(draft, slashCatalog) !== undefined;
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
    const targetSessionId = selectedSessionId as SessionId | undefined;
    const targetThreadId = selectedThreadId;
    const viewingHistory = viewIdentity?.startsWith("history:") === true;
    if (viewingHistory && targetSessionId === undefined) {
      setComposerError("当前历史会话缺少 sessionId，无法安全执行会话树操作。");
      return undefined;
    }
    const needsResume =
      viewingHistory
      && targetSessionId !== undefined
      && snapshot?.sessionId !== targetSessionId;
    setBusy(true);
    try {
      await ensureSelectedSessionActive(client, {
        ...(snapshot?.sessionId === undefined ? {} : { activeSessionId: snapshot.sessionId }),
        ...(targetSessionId === undefined ? {} : { selectedSessionId: targetSessionId }),
        ...(targetThreadId === undefined ? {} : { selectedThreadId: targetThreadId }),
      });
      const currentTarget = selectedTargetRef.current;
      if (
        currentTarget.selectedSessionId !== targetSessionId
        || currentTarget.selectedThreadId !== targetThreadId
      ) {
        throw { code: "STATE_VERSION_CONFLICT", message: "操作期间已切换会话，本次操作已取消。" };
      }
      if (needsResume) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
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
  const viewingHistory = viewIdentity?.startsWith("history:") === true;
  const treeTargetMatches =
    !viewingHistory
    || (selectedSessionId !== undefined && snapshot?.sessionId === selectedSessionId);
  const canResumeViewedHistory =
    !preview
    && viewingHistory
    && !treeTargetMatches
    && selectedSessionId !== undefined
    && selectedThreadId !== undefined
    && runtime?.classification !== "limited-system";
  const treeActionGated =
    busy
    || (!treeTargetMatches && !canResumeViewedHistory)
    || (treeTargetMatches && (!runtimeConnected || !snapshotReady));
  const userRestoreDisabledReason = userMessageRestoreDisabledReason({
    preview,
    running,
    compacting: treeTargetMatches && snapshot?.isCompacting === true,
    resyncRequired: Boolean(connection?.resyncRequired) || convo.state.resyncRequired,
    sessionCreating: sessionCreating === true,
    gated: !preview && treeActionGated,
    canNavigateTree: can("session.tree.navigate") || can("session.tree") || canResumeViewedHistory,
  });
  const userBranchDisabledReason = userMessageRestoreDisabledReason({
    preview,
    running,
    compacting: treeTargetMatches && snapshot?.isCompacting === true,
    resyncRequired: Boolean(connection?.resyncRequired) || convo.state.resyncRequired,
    sessionCreating: sessionCreating === true,
    gated: !preview && treeActionGated,
    canNavigateTree: can("session.tree.branch") || can("session.tree") || canResumeViewedHistory,
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
    if (userBranchDisabledReason !== undefined) return;
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
    const plan = planComposerSend(payload, slashCatalog);
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
      const acceptedPromptTitle = provisionalThreadTitle(outboundPayload.text);
      if (acceptedPromptTitle !== undefined) {
        const acceptedSessionId = snapshot?.sessionId;
        setSubmittedPrompt((current) =>
          current?.sessionId === acceptedSessionId
            ? current
            : {
                ...(acceptedSessionId === undefined ? {} : { sessionId: acceptedSessionId }),
                title: acceptedPromptTitle,
              },
        );
      }
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
    if (!promptEnabled && composerSlashExecute(payload, slashCatalog) === undefined) return;
    setComposerError(undefined);
    composerInputRef.current?.clear();
    setDraft(emptySnapshot());
    if (!preview && selectedSessionId === undefined && snapshot === undefined) {
      ensureNewSession?.();
    }
    if (waitForNewSession !== undefined) {
      const ready = await waitForNewSession();
      if (!ready.ok) {
        setDraft(payload);
        composerInputRef.current?.setSnapshot(payload);
        setComposerError(ready.error);
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
  /** 排队栏当前要显示的条目。「回到最新」按钮在排队栏可见时移入其头行
   *  （qs-head-slot），否则浮在输入框右上角——两个位置互斥，避免按钮压在栏身上。 */
  const sessionQueue = preview ? previewQueue : visibleQueuedMessages(queuedMessages, selectedSessionId);
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
      const planned = planComposerSend(snapshotOfEntry(target), slashCatalog);
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
      setStatusToast(t("shell.clickOnUserMessageForNewSession"));
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
        if (compacting) {
          const notice = compactNoticeFromOutput(outcome.output, { successText: "已压缩上下文" });
          setStatusToast(notice.text);
          if (notice.ok) onViewedTelemetryRefresh?.();
        } else if (command.name === "pin") {
          // `/pin` persists Runtime's global session-pins.json. Refresh only
          // after the authoritative command receipt so the next render cannot
          // race the Runtime's file write.
          await onPinCompleted?.();
        } else {
          const line = outcome.output.find((item) => item.trim().length > 0);
          setStatusToast(line ?? `已执行 /${command.name}`);
        }
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
        <div className={`convo-wrap${surfaceWelcome ? " is-empty" : ""}`}>
          <ConversationPane
            snapshot={convo}
            liveEngine={convo.engine}
            {...(jumpToLatestSlot === undefined ? {} : { jumpToLatestSlot })}
            onLoadOlder={convo.loadOlder}
            onRestore={restorePending}
            onRestoreUserMessage={restoreUserMessage}
            onBranchUserMessage={branchUserMessage}
            {...(userRestoreDisabledReason === undefined ? {} : { userRestoreDisabledReason })}
            {...(userBranchDisabledReason === undefined ? {} : { userBranchDisabledReason })}
            scrollerRef={convoScrollerRef}
            onSurfaceWelcomeChange={setSurfaceWelcome}
            onReviewChanges={(turnId) => openChanges({ turnId })}
            planLink={planLink}
            compacting={compactingNow}
            onInspectSubagent={(target) => {
              setInspectTarget(target);
            }}
            {...(preview || rosterAgents === undefined ? {} : { liveAgents: rosterAgents })}
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
                  runtimeConnected={runtimeConnected}
                  onOpenDiagnostics={() => onRoute("diagnostics")}
                />
              ),
            } : {})}
          />
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
                {...(planReviewDisabled || planSaveBusy ? { disabled: true } : {})}
                onAction={(id, detail) => { void respondPlanReview(id, detail); }}
                {...(can("mode.plan.review.saveAndQuit") ? { onSaveAndQuit: savePlanAndQuit } : {})}
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
            {showContextStrip ? <div className="ctx-strip" role="status" aria-live="polite">
              <span className="ctx-project-wrap">
                <button
                  type="button"
                  className="ctx-item ctx-project-switch"
                  aria-haspopup="menu"
                  aria-expanded={contextProjectMenuOpen}
                  onClick={() => setContextProjectMenuOpen((open) => { if (!open) setContextBranchMenuOpen(false); return !open; })}
                  data-tip={t("shell.project")}
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
                        <span className="sr-only">{t("shell.searchProject")}</span>
                        <input
                          autoFocus
                          value={contextProjectQuery}
                          placeholder={t("shell.searchProject")}
                          onChange={(event) => setContextProjectQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setContextProjectMenuOpen(false);
                          }}
                        />
                      </label>
                      <div className="ctx-project-list">
                      {previewCreatedProject && previewCreatedProject.name.toLocaleLowerCase().includes(normalizedProjectQuery) ? (
                        <MenuItem icon="folder-open" current hint={t("common.demo")}>{previewCreatedProject.name}</MenuItem>
                      ) : null}
                      {preview ? previewProjectOptions.map((project) => (
                        <MenuItem
                          key={project.id}
                          icon="folder-open"
                          current={!previewCreatedProject && project.id === previewProjectId}
                          hint={!previewCreatedProject && project.id === previewProjectId ? t("common.current") : project.branch}
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
                          {...(workspace.active ? { hint: t("common.current") } : {})}
                          onClick={() => {
                            setContextProjectMenuOpen(false);
                            onSelectProject({ id: workspace.workspaceId, name: workspace.name });
                          }}
                        >{workspace.name}</MenuItem>
                      ))}
                      {!preview && !state.model.workspaces?.workspaces.length ? (
                        <MenuItem icon="folder-open" disabled>{t("shell.noProjects")}</MenuItem>
                      ) : null}
                      {normalizedProjectQuery && (preview ? previewProjectOptions.length === 0 && !previewCreatedProject : workspaceOptions.length === 0) ? (
                        <div className="ctx-project-empty">{t("shell.noMatchingProjects")}</div>
                      ) : null}
                      </div>
                      <div className="menu-sep" />
                      <MenuItem icon="plus" onClick={openCreateProject}>{t("shell.newProject")}</MenuItem>
                      <MenuItem icon="x" disabled title={t("shell.needsWorkspace")}>{t("shell.notInProject")}</MenuItem>
                    </div>
                  </>
                ) : null}
              </span>
              <span className="ctx-branch-wrap">
                {preview || gitWorkspaceId === undefined ? (
                  <span className="ctx-item muted" data-tip={t("contextBar.branch")}>
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
                        ? t("git.switching")
                        : pendingBranchAction !== undefined
                          ? t("git.queued")
                          : realGit.repository?.isRepository
                            ? t("contextBar.branch")
                            : t("contextBar.nonGit")}
                      onClick={() => setContextBranchMenuOpen((open) => { setContextProjectMenuOpen(false); return !open; })}
                    >
                      <Icon name="branch" extra="sm" />
                      {realGit.loading && realGit.repository === undefined ? (
                        <span>…</span>
                      ) : realGit.repository?.isRepository ? (
                        <span className="ellipsis">{realGit.repository.branch ?? (realGit.repository.detached ? "detached HEAD" : "—")}</span>
                      ) : realGit.error ? (
                        <span>{t("git.gitUnavailable")}</span>
                      ) : (
                        <span>{t("git.notGitRepo")}</span>
                      )}
                      <Icon name="chevron-d" extra="sm" />
                    </button>
                    {contextBranchMenuOpen ? (
                      <>
                        <button className="ctx-project-backdrop" aria-label={t("contextBar.closeBranchMenu")} onClick={() => setContextBranchMenuOpen(false)} />
                        <div className="menu ctx-project-menu ctx-branch-menu" role="menu" aria-label={t("git.switchBranch")}>
                          <div className="menu-label">{t("git.switchBranch")}</div>
                          <div className="ctx-project-list">
                            {realGit.repository === undefined ? (
                              <div className="ctx-project-empty">{realGit.loading ? t("git.readingGitStatus") : "—"}</div>
                            ) : !realGit.repository.isRepository ? (
                              <div className="ctx-project-empty">{realGit.repository.unavailableReason ?? realGit.error ?? t("git.notGitRepo")}</div>
                            ) : branchListState.status === "loading" || branchListState.status === "idle" ? (
                              <div className="ctx-project-empty">{t("git.readingBranches")}</div>
                            ) : branchListState.status === "error" ? (
                              <div className="ctx-project-empty">
                                <p>{branchListState.error}</p>
                                <button className="btn small outline" onClick={() => void loadBranches()}>{t("common.retry")}</button>
                              </div>
                            ) : localBranches.length === 0 ? (
                              <div className="ctx-project-empty">{t("git.noLocalBranches")}</div>
                            ) : localBranches.map((branch) => {
                              const queuedHere = pendingBranchAction?.kind === "switch" && pendingBranchAction.name === branch.name;
                              return (
                              <MenuItem
                                key={branch.name}
                                icon="branch"
                                current={branch.current}
                                disabled={branch.current || branchSwitchName !== undefined || branch.checkedOutWorktreeId !== undefined}
                                {...(branch.current
                                  ? { title: t("common.current") }
                                  : branch.checkedOutWorktreeId !== undefined
                                    ? { title: t("git.otherWorktree") }
                                    : queuedHere
                                      ? { title: t("git.queued") }
                                      : branchActionDeferred
                                        ? { title: t("git.switchAfterTurn") }
                                        : {})}
                                {...(queuedHere
                                  ? { hint: t("git.waitingTurnEnd") }
                                  : branchSwitchName === branch.name
                                    ? { hint: t("git.switching") }
                                    : branch.current
                                      ? { hint: t("common.current") }
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
                              <div className="menu-label">{t("git.remoteBranches")}</div>
                              <div className="ctx-project-list">
                                {remoteBranches.slice(0, 15).map((branch) => (
                                  <MenuItem key={branch.name} icon="branch" disabled title={t("git.needLocalBranch")}>{branch.name}</MenuItem>
                                ))}
                                {remoteBranches.length > 15 ? <div className="ctx-project-empty">{t("git.moreRemoteBranches", { count: remoteBranches.length - 15 })}</div> : null}
                              </div>
                            </>
                          ) : null}
                          <div className="menu-sep" />
                          <MenuItem icon="plus" disabled={branchSwitchName !== undefined} onClick={openCreateBranch}>{t("git.newBranchEllipsis")}</MenuItem>
                          <MenuItem icon="columns" onClick={() => { setContextBranchMenuOpen(false); onOpenGit(); }}>{t("git.branchManagement")}</MenuItem>
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
                data-tip={t("git.uncommitted")}
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
                      <h2 id="createProjectTitle">{t("shell.createProject")}</h2>
                    </div>
                    <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={createProjectBusy} onClick={() => setCreateProjectOpen(false)}><Icon name="x" /></button>
                  </div>
                  <div className="create-project-body">
                    <label className="create-project-name">
                      <span className="sr-only">{t("shell.projectNamePlaceholder")}</span>
                      <Icon name="folder-open" />
                      <input autoFocus value={createProjectName} placeholder={t("shell.projectNamePlaceholder")} maxLength={80} onChange={(event) => setCreateProjectName(event.target.value)} />
                    </label>
                    <div className="create-project-label">{t("shell.sourceFolder")}</div>
                    <button
                      type="button"
                      className="create-project-folder"
                      disabled={createProjectBusy}
                      onClick={() => void createProject()}
                    >
                      <span className="create-folder-icon">
                        {createProjectBusy ? <span className="spinner" aria-hidden="true" /> : <Icon name="folder-open" />}
                      </span>
                      <span className="create-folder-copy">
                        <b>{createProjectBusy ? t("shell.openingFolderPicker") : t("shell.selectProjectFolder")}</b>
                        <span>{preview ? t("shell.createProjectDemoTip") : t("shell.createProjectFolderTip")}</span>
                      </span>
                      {preview ? <span className="chip purple xs">演示</span> : <Icon name="chevron-r" extra="sm" />}
                    </button>
                    {createProjectError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{createProjectError}</div> : null}
                  </div>
                  <div className="create-project-foot">
                    <button type="button" className="btn outline" disabled={createProjectBusy} onClick={() => setCreateProjectOpen(false)}>{t("common.cancel")}</button>
                    <button type="button" className="btn primary" disabled={createProjectBusy} onClick={() => void createProject()}>
                      {createProjectBusy ? <><span className="spinner" aria-hidden="true" />{t("shell.creating")}</> : t("shell.selectFolderAndCreate")}
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
                      <h2 id="createBranchTitle">{t("shell.createBranchTitle")}</h2>
                      <p className="create-branch-sub">{t("shell.createBranchSub")}</p>
                    </div>
                    <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={createBranchBusy} onClick={() => setCreateBranchOpen(false)}><Icon name="x" /></button>
                  </div>
                  <div className="create-project-body">
                    <label className="create-project-name">
                      <span className="sr-only">{t("shell.branch")}</span>
                      <Icon name="branch" />
                      <input
                        autoFocus
                        value={createBranchName}
                        placeholder={t("shell.branchNamePlaceholder")}
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
                    <p className="create-branch-hint" id="createBranchHint">{t("shell.createBranchHint")}</p>
                    {createBranchError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{createBranchError}</div> : null}
                  </div>
                  <div className="create-project-foot">
                    <button type="button" className="btn outline" disabled={createBranchBusy} onClick={() => setCreateBranchOpen(false)}>{t("common.cancel")}</button>
                    <button type="button" className="btn primary" disabled={!createBranchName.trim() || createBranchBusy} onClick={() => void createBranch()}>
                      {createBranchBusy ? <><span className="spinner" aria-hidden="true" />{t("shell.creating")}</> : t("shell.createAndSwitch")}
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
                      <h2 id="switchBlockTitle">{t("shell.switchBlockTitle", { branch: switchBlock.branch })}</h2>
                      <p className="create-branch-sub">{t("shell.switchBlockSub")}</p>
                    </div>
                    <button type="button" className="icon-btn" aria-label="关闭" disabled={switchCommitBusy} onClick={cancelSwitchBlock}><Icon name="x" /></button>
                  </div>
                  <div className="create-project-body">
                    <ul className="switch-block-files" aria-label={t("shell.switchBlockFilesAria")}>
                      {switchBlock.files.map((file) => (
                        <li key={file.path}>
                          <span className="mono">{file.path}</span>
                          {file.insertions !== undefined && file.deletions !== undefined ? (
                            <span className="ctx-diffstat mono" data-tip={t("shell.uncommitted")}>
                              <b className="ds-add">+{formatDiffCount(file.insertions)}</b>
                              <b className="ds-del">-{formatDiffCount(file.deletions)}</b>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <label className="create-project-name">
                      <span className="sr-only">{t("shell.createCommit")}</span>
                      <Icon name="commit" />
                      <input
                        autoFocus
                        value={switchCommitMessage}
                        placeholder={t("shell.switchCommitPlaceholder")}
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
                    <p className="create-branch-hint" id="switchBlockHint">{t("shell.switchBlockHint", { count: switchBlock.files.length })}</p>
                    {switchCommitError ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{switchCommitError}</div> : null}
                  </div>
                  <div className="create-project-foot">
                    <button type="button" className="btn outline" disabled={switchCommitBusy} onClick={cancelSwitchBlock}>{t("common.cancel")}</button>
                    <button type="button" className="btn primary" disabled={!switchCommitMessage.trim() || switchCommitBusy} onClick={() => void submitSwitchCommit()}>
                      {switchCommitBusy ? <><span className="spinner" aria-hidden="true" />{t("shell.committing")}</> : t("shell.commitAndSwitch")}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
            <MessageQueueBar
              messages={sessionQueue}
              running={preview ? previewThreadId === "t1" : running}
              sendEnabled={preview || (running ? steerNowEnabled : promptChannelReady)}
              {...(preview ? { demo: true } : {})}
              {...(queueEdit === undefined ? {} : { editingId: queueEdit.entryId })}
              {...(jumpPill?.visible && sessionQueue.length > 0 ? {
                headerSlot: (
                  <button
                    type="button"
                    className="new-content-pill queue-jump-latest"
                    onClick={jumpPill.jumpToLatest}
                    aria-label="回到最新"
                    data-tip="回到最新"
                  >
                    <Icon name="chevron-d" />
                  </button>
                ),
              } : {})}
              onEdit={editQueuedMessage}
              onSendNow={(entry) => void sendQueuedNow(entry)}
              onRemove={removeQueuedMessage}
            />
            <div className={`composer${running ? ` running ${composerExpanded ? "expanded" : "compact"}` : ""}`} id="composer">
              {jumpPill?.visible && sessionQueue.length === 0 ? (
                <button
                  type="button"
                  className="new-content-pill composer-jump-latest"
                  onClick={jumpPill.jumpToLatest}
                  aria-label="回到最新"
                  data-tip="回到最新"
                >
                  <Icon name="chevron-d" />
                </button>
              ) : null}
              <div className="composer-ctx" aria-label="已引用的上下文" role="group" />
              <label className="sr-only" htmlFor="composerInput">消息输入框。发送给 Runtime 的文本。</label>
              <ChipComposer
                ref={composerInputRef}
                id="composerInput"
                compact={running && !composerExpanded}
                placeholder={queueEdit === undefined ? t("conversation.composerPlaceholder") : t("conversation.editingQueuedMessage")}
                describedBy="composerHint"
                {...(workspaceId === undefined ? {} : { workspaceId })}
                loadMentions={fetchMentions}
                slashCatalog={slashCatalog}
                onRunCommand={runSlashCommand}
                onChange={(next) => {
                  setDraft(next);
                  const owner = selectedSessionId ?? snapshot?.sessionId;
                  if (owner !== undefined) onComposerDraftChange?.(owner, next);
                }}
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
                  if (running && !hasStatusCapsules && !hasDraftContent) setComposerExpanded(false);
                }}
                onError={setComposerError}
              />
              <p className="sr-only" id="composerHint">{
                queueEdit !== undefined
                  ? t("composer.editingQueuedMessageHint")
                  : running
                    ? t("composer.runningHint")
                    : pendingInteraction
                      ? t("composer.pendingInteractionHint")
                      : t("composer.idleHint")
              }</p>
              {composerError ? (
                <div className="composer-error" role="alert">
                  <Icon name="alert" extra="sm" />
                  <span>{composerError}</span>
                  <button
                    type="button"
                    className="composer-error-x"
                    aria-label={t("common.close")}
                    data-tip={t("common.close")}
                    onClick={() => setComposerError(undefined)}
                  >
                    <Icon name="x" extra="sm" />
                  </button>
                </div>
              ) : null}
              <div className="composer-bar" data-collapse="full" ref={composerBarRef}>
                <div className="cb-group">
                  <button className="icon-btn small" data-tip={t("composer.attachFiles")} aria-label={t("composer.attachFilesAria")} onClick={() => { setComposerExpanded(true); composerInputRef.current?.openFilePicker(); }}><Icon name="attach" extra="sm" /></button>
                  <button className="icon-btn small" data-tip={t("composer.mention")} aria-label={t("composer.mentionAria")} onClick={() => { setComposerExpanded(true); composerInputRef.current?.openMention("@"); }}><Icon name="at" extra="sm" /></button>
                  <button className="icon-btn small" data-tip={t("composer.commands")} aria-label={t("composer.commands")} onClick={() => { setComposerExpanded(true); composerInputRef.current?.openCommandMenu(); }}><Icon name="slash" extra="sm" /></button>
                </div>
                {queueEdit !== undefined ? (
                  <span className="pill-btn queue-edit" role="status">
                    <Icon name="pencil" extra="sm" />
                    {t("composer.editQueued")}
                    <button
                      type="button"
                      className="qe-x"
                      aria-label={t("composer.cancelEditQueued")}
                      data-tip={t("composer.cancelEdit")}
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
                  onInteract={() => setComposerExpanded(true)}
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
                          setComposerError(t("composer.permissionSwitchConflict"));
                          return;
                        }
                        if (needsResume) {
                          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                        }
                        await run("permissions.mode.set", { mode });
                      } catch (error) {
                        setComposerError(hostErrorMessage(error, t("composer.permissionSwitchFailed")));
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
                  onInteract={() => setComposerExpanded(true)}
                  onCapsulesChange={setModeCapsulesPresent}
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
                    data-tip={t("composer.stop")}
                    aria-label={t("composer.stopRunning")}
                  >
                    <Icon name="stop" extra="sm" />
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    disabled={queueEdit === undefined && !(promptEnabled || queueEnabled || slashExecuteReady || (preview && running))}
                    onClick={() => {
                      setComposerExpanded(true);
                      if (queueEdit !== undefined) {
                        commitQueuedEdit();
                        return;
                      }
                      const payload = composerInputRef.current?.getSnapshot() ?? draft;
                      if (composerSlashExecute(payload, slashCatalog) !== undefined) {
                        void sendPrompt();
                        return;
                      }
                      if (running) enqueueDraft();
                      else void sendPrompt();
                    }}
                    data-tip={
                      queueEdit !== undefined
                        ? t("composer.commitQueue")
                        : running
                          ? t("composer.enqueue")
                          : pendingInteraction
                            ? t("composer.resolvePendingFirst")
                            : t("composer.send")
                    }
                    aria-label={queueEdit !== undefined ? t("composer.commitQueueAria") : t("composer.send")}
                  >
                    <Icon name="arrow-u" extra="sm" />
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* 定位上下文是 .convo-wrap，不要放回 .composer-region，否则会按错误盒子算高并溢出底栏。 */}
          {inspectTarget === null ? null : (
            <SubagentInspectCard
              target={inspectTarget}
              preview={preview}
              client={preview ? null : conversationClient}
              sendClient={preview ? null : client}
              agents={rosterAgents ?? []}
              canSend={
                can("agent.send")
                && (selectedSessionId === undefined || snapshot?.sessionId === undefined || selectedSessionId === snapshot.sessionId)
              }
              runtimeConnected={runtimeConnected}
              {...(selectedSessionId === undefined ? {} : { parentSessionId: selectedSessionId as SessionId })}
              {...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId })}
              pendingInteraction={pendingInteraction !== null}
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
          <button
            className="icon-btn small bp-reveal"
            data-tip={bottomVisible ? t("shell.collapseBottomBar") : t("shell.expandBottomBar")}
            aria-label={bottomVisible ? t("shell.collapseBottomBar") : t("shell.expandBottomBar")}
            aria-expanded={bottomVisible}
            aria-controls="bottomPanel"
            onClick={() => onBottomVisibleChange(toggleBottomBarVisible({ visible: bottomVisible, open: bottomOpen }).visible)}
          >
            <Icon name="panel-bottom" extra="sm" />
          </button>
        </div>
        <aside className={`side-panel${sideOpen ? " open" : ""}`} id="sidePanel" aria-label={t("shell.rightPanel")} style={{ width: panelWidth }}>
          <div className="sp-resizer" id="spResizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t("shell.adjustPanelWidth")} onPointerDown={onPanelResizePointerDown} />
          <div className="sp-head">
            <div className="tabs" role="tablist" aria-label={t("menu.view")}>
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
                {preview ? <span className="chip gray xs">4</span> : rosterAgents !== undefined ? <span className="chip gray xs">{rosterAgents.length}</span> : snapshot ? <span className="chip gray xs">{snapshot.agents.length}</span> : null}
              </button>
              {btwWindow.open && btwWindow.placement === "docked" ? (
                /* 这个按钮同时是拖出握把：移动超过阈值并离开标题栏就切回浮动态，
                   不到阈值当普通点击。状态点让 BTW 在别的 tab 前台时也能看出在跑。 */
                <button
                  className={`btw-tab${sideTab === "btw" ? " active" : ""}`}
                  role="tab"
                  aria-selected={sideTab === "btw"}
                  aria-controls="spBtw"
                  data-tip={t("shell.dragOut")}
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
              {preview ? <PreviewSidePreview /> : <Deferred title={t("shell.previewUnavailableTitle")} detail={t("shell.previewUnavailableDetail")} />}
            </div>
            <div className={`sp-page${sideTab === "agents" ? " active" : ""}`} id="spAgents" role="tabpanel">
              {preview ? (
                <PreviewSideAgents onOpenHub={() => onRoute("agent-hub")} />
              ) : rosterAgents !== undefined ? (
                rosterAgents.length ? (
                  rosterAgents.map((agent) => (
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
                          aria-label={t("shell.openInAgentHubAria")}
                          onClick={() => { setHubIntent(agent.agentId); onRoute("agent-hub"); }}
                        >
                          <Icon name="external" extra="sm" />
                        </button>
                      </div>
                    </div>
                  ))
                ) : <Deferred title={t("shell.noAgentsTitle")} detail={t("shell.noAgentsDetail")} />
              ) : <Deferred title={t("shell.agentsDeferredTitle")} detail={t("shell.agentsDeferredDetail")} />}
            </div>
            <div className={`sp-page${sideTab === "btw" ? " active" : ""}`} id="spBtw" role="tabpanel">
              {btwWindow.open && btwWindow.placement === "docked" ? (
                <BtwPanel
                  session={btwSession}
                  {...(preview ? { demo: true, onDemoNext: onBtwDemoNext } : {})}
                />
              ) : btwWindow.open ? (
                <Deferred title={t("shell.btwFloatingTitle")} detail={t("shell.btwFloatingDetail")} />
              ) : (
                <Deferred title={t("shell.btwClosedTitle")} detail={t("shell.btwClosedDetail")} />
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
      <div className={`bottom-panel${bottomOpen ? "" : " collapsed"}${bottomVisible ? "" : " closed"}${bottomResizing ? " resizing" : ""}`} id="bottomPanel" {...(bottomVisible ? {} : { inert: true })}>
        <div
          className={`bp-resizer${bottomResizing ? " dragging" : ""}`}
          id="bpResizer"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={t("shell.resizeBottomPanel")}
          aria-valuemin={BOTTOM_PANEL_MIN}
          aria-valuemax={BOTTOM_PANEL_MAX}
          aria-valuenow={bottomHeight}
          data-tip={t("shell.resizeHeight")}
          onPointerDown={onBottomResizePointerDown}
          onDoubleClick={() => { onBottomOpenChange(true); onResizeBottom(BOTTOM_PANEL_DEFAULT); }}
          onKeyDown={onBottomResizeKeyDown}
        />
        <div className="bp-head">
          <div className="tabs" role="tablist" aria-label={t("shell.bottomViews")}>
            <button className={bottomTab === "terminal" ? "active" : ""} role="tab" aria-selected={bottomTab === "terminal"} onClick={() => { onBottomTabChange("terminal"); onBottomOpenChange(true); }}>
              <Icon name="terminal" extra="sm" />Terminal
            </button>
            <button className={bottomTab === "problems" ? "active" : ""} role="tab" aria-selected={bottomTab === "problems"} onClick={() => { onBottomTabChange("problems"); onBottomOpenChange(true); }}>
              <Icon name="alert-c" extra="sm" />Problems
            </button>
            <button className={bottomTab === "tests" ? "active" : ""} role="tab" aria-selected={bottomTab === "tests"} onClick={() => { onBottomTabChange("tests"); onBottomOpenChange(true); }}>
              <Icon name="test" extra="sm" />Tests
              {!preview && testSummary.failed > 0 ? <span className="chip red xs">{testSummary.failed}<span className="sr-only"> {t("shell.failedCount", { count: testSummary.failed })}</span></span> : null}
              {!preview && testSummary.failed === 0 && testSummary.running > 0 ? <span className="chip amber xs">{testSummary.running}<span className="sr-only"> {t("shell.runningCount", { count: testSummary.running })}</span></span> : null}
            </button>
            <button className={bottomTab === "output" ? "active" : ""} role="tab" aria-selected={bottomTab === "output"} onClick={() => { onBottomTabChange("output"); onBottomOpenChange(true); }}>
              <Icon name="console" extra="sm" />Output
            </button>
            <button className={bottomTab === "logs" ? "active" : ""} role="tab" aria-selected={bottomTab === "logs"} onClick={() => { onBottomTabChange("logs"); onBottomOpenChange(true); }}>
              <Icon name="book" extra="sm" />OMP Logs
              {state.events.length > 0 && <span className="chip gray xs">{state.events.length}<span className="sr-only"> {t("shell.eventsCount", { count: state.events.length })}</span></span>}
            </button>
            <button className={bottomTab === "pvlogs" ? "active" : ""} role="tab" aria-selected={bottomTab === "pvlogs"} onClick={() => { onBottomTabChange("pvlogs"); onBottomOpenChange(true); }}>
              <Icon name="globe" extra="sm" />Preview Logs
            </button>
          </div>
          <span className="spacer" />
          <button
            className="icon-btn small"
            data-tip={terminalAvailable ? t("terminal.newTerminal") : t("terminal.newTerminal")}
            disabled={!terminalAvailable}
            onClick={() => terminalRef.current?.create()}
          >
            <Icon name="plus" extra="sm" />
          </button>
          <button className="icon-btn small" data-tip={bottomOpen ? t("common.collapse") : t("common.expand")} aria-expanded={bottomOpen} aria-controls="bottomPanel" onClick={() => onBottomOpenChange(toggleBottomBarOpen({ visible: bottomVisible, open: bottomOpen }).open)}>
            <Icon name={bottomOpen ? "chevron-d" : "chevron-u"} extra="sm" />
          </button>
        </div>
        <div className="bp-body">
          <div className={`bp-page${bottomTab === "terminal" ? " active" : ""}`} id="bpTerminal" role="tabpanel">
            <TerminalPane ref={terminalRef} visible={bottomTab === "terminal" && bottomOpen && bottomVisible} />
          </div>
          <div className={`bp-page${bottomTab === "problems" ? " active" : ""}`} id="bpProblems" role="tabpanel">
            {preview ? <PreviewProblems /> : <Deferred title={t("shell.problemsUnavailableTitle")} detail={t("shell.problemsUnavailableDetail")} />}
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
            {preview ? (
              <>
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
              </>
            ) : null}
          </div>
          <div className={`bp-page${bottomTab === "logs" ? " active" : ""}`} id="bpLogs" role="tabpanel">
            <div className="panel-head"><div><h2>OMP Logs</h2><p className="muted">{t("shell.ompLogsVirtualDesc")}</p></div><span className="mono">{t("shell.eventsCount", { count: state.events.length })}</span></div>
            <VirtualEventTranscript events={state.events} />
          </div>
          <div className={`bp-page${bottomTab === "pvlogs" ? " active" : ""}`} id="bpPvlogs" role="tabpanel">
            {preview ? <PreviewLogs /> : <Deferred title={t("shell.previewLogsUnavailableTitle")} detail={t("shell.previewLogsUnavailableDetail")} />}
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
  const { t } = useI18n();
  const previewMode = usePreviewMode();
  const appUpdate = useAppUpdate();
  const effectiveUpdate = previewMode.preview ? PREVIEW_APP_UPDATE : (appUpdate.state.updateInfo?.available ? appUpdate.state.updateInfo : null);
  const [showAppUpdateDialog, setShowAppUpdateDialog] = useState(false);
  const previewOn = () => previewMode.preview;
  const [collapsed, setCollapsed] = useState(false);
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
  const [selectedProvisionalSessionId, setSelectedProvisionalSessionId] = useState<string | undefined>(undefined);
  const [composerDraftsBySession, setComposerDraftsBySession] = useState<Readonly<Record<string, ComposerSnapshot>>>({});
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
    setComposerDraftsBySession((current) => {
      if (snapshotIsEmpty(draft)) {
        if (!(sessionId in current)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      }
      if (current[sessionId] === draft) return current;
      return { ...current, [sessionId]: draft };
    });
  }, []);
  useEffect(() => {
    if (selectedHistoryId !== null) setSelectedProvisionalSessionId(undefined);
  }, [selectedHistoryId]);
  /** 各项目当前展开的会话条数；折叠会话列表时清掉对应键回到默认 6 条。 */
  const [projectThreadLimits, setProjectThreadLimits] = useState<Record<string, number>>({});
  const projectHistories = useProjectHistories({ client, preview: previewMode.preview });
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
  const [previewProjectId, setPreviewProjectId] = useState(initialPreview.projectId);
  const [previewThreadId, setPreviewThreadId] = useState(initialPreview.threadId);
  const [previewDeckWait, setPreviewDeckWait] = useState<ThreadWaitKind | undefined>("plan");
  const { settings: appSettings, update: updateAppSettings } = useAppSettings();
  const theme = appSettings.theme;
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [splitRatio, setSplitRatio] = useState(0.46);
  const [sideOpen, setSideOpen] = useState(() => previewOn());
  const [bottomOpen, setBottomOpen] = useState(() => previewOn());
  const [bottomVisible, setBottomVisible] = useState(true);
  const applyBottomChrome = useCallback((next: { visible: boolean; open: boolean }) => {
    setBottomVisible(next.visible);
    setBottomOpen(next.open);
  }, []);
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
  const [provisionalThreadsBySession, setProvisionalThreadsBySession] = useState<
    Readonly<Record<string, ProvisionalProjectThread>>
  >({});
  /** Prevent a late Workbench effect from resurrecting a successfully archived row. */
  const archivedProvisionalSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  /** 左上菜单「新建项目」：递增后 WorkbenchCanvas 打开已有创建项目对话框。 */
  const [createProjectNonce, setCreateProjectNonce] = useState(0);
  const sessionCreateWaitRef = useRef<Promise<NewSessionWaitResult> | null>(null);
  const [shellNotice, setShellNotice] = useState<{ text: string; icon: string } | null>(null);
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
  const [dialog, setDialog] = useState<ShellDialog | null>(null);
  /** 归档确认弹窗：点「归档」只打开此窗，确认后才执行预览隐藏或 session.archive。 */
  const [archivePending, setArchivePending] = useState<ArchivePending | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);
  const [trail, setTrail] = useState<Route[]>([state.route]);
  const lastPageRoute = useRef<SecondaryRoute>("home");
  const workspaceActionQueue = useMemo(() => createSerialTaskQueue(), []);
  const navigationGate = useMemo(() => createResumeGenerationGate(), []);
  useEffect(() => {
    if (state.route === "home") navigationGate.next();
  }, [navigationGate, state.route]);
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
  const pendingInteraction = state.clientState?.interaction.pending ?? null;
  const residentModel = state.clientState?.entities.residents;
  const residentRows = residentModel?.residents ?? [];
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
  const runtimeSettingsCanSet = (() => {
    const entry = capabilities?.capabilities.find((capability) => capability.id === "runtime.settings.set");
    if (!entry || entry.grade === "unavailable") return false;
    if (state.clientState?.connection.resyncRequired) return false;
    if (runtime?.classification === "limited-system") return false;
    return true;
  })();
  const setRuntimeSetting = useCallback(async (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue): Promise<void> => {
    const input = { key, value, persist: true } as CommandInput<"runtime.settings.set">;
    const handle = await client.command("runtime.settings.set", input);
    await waitReceipt(client, handle.requestId);
  }, [client]);
  const runtimeSettings = runtimeSettingsPropsOf(snapshot, runtimeSettingsCanSet, setRuntimeSetting);
  const selected = state.model.history?.entries.find((entry) => entry.historyId === selectedHistoryId)
    ?? historyAll?.entries.find((entry) => entry.historyId === selectedHistoryId)
    ?? Object.values(projectHistoryCache).flatMap((historyState) => historyState.model?.entries ?? [])
      .find((entry) => entry.historyId === selectedHistoryId);
  const viewedSessionId = selected?.sessionId ?? snapshot?.sessionId;
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
  const snapshotTitleIsCurrent = snapshot?.sessionId !== undefined
    && snapshot.sessionTitle !== undefined
    && (selectedHistoryId === null || selected?.sessionId === snapshot.sessionId);
  const provisionalCurrentTitle = snapshot?.sessionId !== undefined
    && (selectedHistoryId === null || selected?.sessionId === snapshot.sessionId)
    ? provisionalThreadsBySession[String(snapshot.sessionId)]?.title
    : undefined;
  const currentThreadTitle = snapshotTitleIsCurrent
    ? snapshot?.sessionTitle
    : selected?.title ?? provisionalCurrentTitle;
  const untitledThreadTitle = selectedHistoryId === null
    ? t("conversation.newChat")
    : t("conversation.untitledSession");
  const threadTitle = previewMode.preview
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
        if (persisted === undefined || persisted.title === undefined) continue;
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
  const previewWasOn = useRef(previewMode.preview);
  useEffect(() => {
    const leavingPreview = previewWasOn.current && !previewMode.preview;
    previewWasOn.current = previewMode.preview;
    if (!layoutRestoreNeeded({
      preview: previewMode.preview,
      rememberLayout: appSettings.rememberLayout,
      leavingPreview,
      appliedScope: appliedLayoutScope.current,
      layoutScope,
    })) return;
    appliedLayoutScope.current = layoutScope;
    const memory = readLayoutMemory(layoutScope);
    if (memory === undefined) return;
    skipNextLayoutPersist.current = true;
    if (memory.collapsed !== undefined) setCollapsed(memory.collapsed);
    if (memory.sidebarWidth !== undefined) setSidebarWidth(memory.sidebarWidth);
    if (memory.splitRatio !== undefined) setSplitRatio(memory.splitRatio);
    if (memory.sideOpen !== undefined) setSideOpen(memory.sideOpen);
    if (memory.bottomOpen !== undefined) setBottomOpen(memory.bottomOpen);
    if (memory.bottomVisible !== undefined) setBottomVisible(memory.bottomVisible);
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
      bottomVisible,
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
  }, [previewMode.preview, appSettings.rememberLayout, layoutScope, collapsed, sidebarWidth, splitRatio, sideOpen, bottomOpen, bottomVisible, sideTab, bottomTab, explorerOpen, panelWidth, bottomHeight, btwWindow.open, btwWindow.placement, btwWindow.minimized, btwWindow.rect, btwWindow.capsulePos]);

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

  const selectProject = (project: SelectedProject) => {
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
    const generation = navigationGate.next();
    try {
      const result = await workspaceActionQueue.enqueue(async () => {
        const handle = await client.command("workspace.pick", {});
        return await waitReceipt<WorkspaceListReadModel>(client, handle.requestId);
      });
      if (!navigationGate.isCurrent(generation)) return;
      onWorkspacesChange(result);
      const active = result.workspaces.find((workspace) => workspace.active);
      if (active) {
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

  const requestArchiveThread = (entry: SessionHistoryEntry, workspaceId?: WorkspaceId) => {
    if (archiveBusy) return;
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
  useEffect(() => {
    if (semanticTitleKey === undefined || snapshot?.sessionId === undefined || snapshot.sessionTitle === undefined) return;
    const title = snapshot.sessionTitle.trim();
    if (title.length === 0) return;
    const key = String(snapshot.sessionId);
    setProvisionalThreadsBySession((current) => {
      const thread = current[key];
      if (thread === undefined) return current;
      const next = resolveProvisionalHistoryTitle(thread, title);
      return next === thread ? current : { ...current, [key]: next };
    });
    void refreshHistoryAfterTitle(currentSessionWorkspaceId);
  }, [currentSessionWorkspaceId, refreshHistoryAfterTitle, semanticTitleKey, snapshot?.sessionId, snapshot?.sessionTitle]);

  /**
   * OMP's native title generator is normally triggered by the Runtime. A
   * submitted idle session can still be left untitled when that path is
   * unavailable, so ask the Runtime to persist the prompt fallback exactly
   * once at a time. The receipt snapshot remains the authority; the history
   * refresh lets a newer Runtime/Host projection take over the row as well.
   */
  const provisionalTitleEnsureThread = snapshot?.sessionId === undefined
    ? undefined
    : provisionalThreadsBySession[String(snapshot.sessionId)];
  const provisionalTitleEnsureInFlightRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const thread = provisionalTitleEnsureThread;
    if (!shouldEnsureProvisionalSessionTitle({
      preview: previewMode.preview,
      runtimeConnected: runtime?.status === "connected",
      provisional: thread,
      snapshot: snapshot === undefined
        ? undefined
        : {
          sessionId: snapshot.sessionId,
          ...(snapshot.sessionTitle === undefined ? {} : { sessionTitle: snapshot.sessionTitle }),
          ...(snapshot.sessionTitleSource === undefined ? {} : { sessionTitleSource: snapshot.sessionTitleSource }),
          isStreaming: snapshot.isStreaming,
          isCompacting: snapshot.isCompacting,
      },
      inFlightSessionIds: provisionalTitleEnsureInFlightRef.current,
    })) {
      return;
    }
    if (thread === undefined) return;
    const key = provisionalSessionTitleEnsureKey(thread.sessionId);
    const inFlight = new Set(provisionalTitleEnsureInFlightRef.current);
    inFlight.add(key);
    provisionalTitleEnsureInFlightRef.current = inFlight;
    void (async () => {
      try {
        const handle = await client.command("operator.invoke", {
          commandId: "studio.session-title.ensure",
          arguments: thread.title,
        });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        if (outcome.snapshot.sessionId !== thread.sessionId) {
          throw new Error("自动标题回执与当前会话不一致");
        }
        const title = outcome.snapshot.sessionTitle?.trim();
        if (title !== undefined && title.length > 0) {
          setProvisionalThreadsBySession((current) => {
            const currentThread = current[key];
            if (currentThread === undefined) return current;
            return { ...current, [key]: resolveProvisionalHistoryTitle(currentThread, title) };
          });
        }
        await refreshHistoryAfterTitle(thread.workspaceId);
      } catch {
        // A later authoritative Runtime state change may retry. Ref-only
        // cleanup below cannot itself create a render/effect hot loop.
      } finally {
        const next = new Set(provisionalTitleEnsureInFlightRef.current);
        next.delete(key);
        provisionalTitleEnsureInFlightRef.current = next;
      }
    })();
  }, [client, previewMode.preview, provisionalTitleEnsureThread, refreshHistoryAfterTitle, runtime?.status, snapshot?.isCompacting, snapshot?.isStreaming, snapshot?.sessionId, snapshot?.sessionTitle, snapshot?.sessionTitleSource, snapshot?.stateVersion]);

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
    void archiveThread(entry, archivePending.workspaceId).then((ok) => {
      if (ok) {
        setArchivePending(null);
        setArchiveError(undefined);
      }
      setArchiveBusy(false);
    });
  };

  /** 真实模式「取消归档」：session.unarchive 恢复到进行中列表。 */
  const unarchiveThread = (entry: SessionHistoryEntry) => {
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
      }
    });
  };

  /** 真实模式「删除会话」：session.delete 永久删除本地文件与相关残留。 */
  const deleteSessionThread = (entry: SessionHistoryEntry): Promise<boolean> => {
    return workspaceActionQueue.enqueue(async () => {
      try {
        const cachedWorkspaceId = Object.entries(projectHistoryCache).find(([, value]) =>
          value.model?.entries.some((candidate) => candidate.historyId === entry.historyId),
        )?.[0] as WorkspaceId | undefined;
        const targetWorkspaceId = cachedWorkspaceId
          ?? residentForSession(residentModel, entry.sessionId)?.workspaceId;
        await ensureWorkspaceActive(targetWorkspaceId);
        const handle = await client.command("session.delete", { threadId: entry.threadId });
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
        await refreshHistoryModels();
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
        await refreshHistoryModels();
        setShellNotice({ text: t("shell.handoffToNewSession", { id: receipt.sessionId }), icon: "check" });
      } catch (error) {
        setShellNotice({ text: hostErrorMessage(error, "Handoff 失败"), icon: "alert" });
      }
    });
  };

  /** 顶栏 Compact：与 Composer 发送一样，先 ensureSelectedSessionActive（历史会话
      只读打开时 Runtime 仍停在空会话上），再 operator.invoke builtin.compact。 */
  const compactThread = (target?: { sessionId?: SessionId; threadId?: ThreadId }) => {
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
        await openHistoryEntry(entry, workspaceId, { resumeForAction: true, skipQueue: true });
        switch (action) {
          case "rename":
            openRenameDialog(entry.title ?? t("conversation.untitledSession"), {
              ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
              threadId: entry.threadId,
              ...(workspaceId === undefined ? {} : { workspaceId }),
            });
            break;
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
  const runSessionCreate = useCallback((work: () => Promise<void>) => {
    if (sessionCreateWaitRef.current) return;
    setCreatingSession(true);
    const pending = work()
      .then((): NewSessionWaitResult => ({ ok: true }))
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
  }, []);
  const ensureNewSession = useCallback(() => {
    if (previewMode.preview || sessionCreateWaitRef.current) return;
    runSessionCreate(() => workspaceActionQueue.enqueue(async () => {
      const handle = await client.command("session.create", {});
      await waitReceipt(client, handle.requestId);
      refreshSessionTitles();
    }));
  }, [client, previewMode.preview, runSessionCreate, refreshSessionTitles, workspaceActionQueue]);

  const startNewChat = useCallback(() => {
    if (previewMode.preview) {
      go("workbench");
      return;
    }
    if (sessionCreateWaitRef.current) return;
    navigationGate.next();
    setSessionActionError(undefined);
    setSelectedProvisionalSessionId(undefined);
    onNewThread();
    go("workbench");
    runSessionCreate(() => workspaceActionQueue.enqueue(async () => {
      const handle = await client.command("session.create", {});
      await waitReceipt(client, handle.requestId);
      refreshSessionTitles();
    }));
  }, [client, go, navigationGate, onNewThread, previewMode.preview, runSessionCreate, refreshSessionTitles, workspaceActionQueue]);

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
    setSessionActionError(undefined);
    if (sessionCreateWaitRef.current) return;
    const generation = navigationGate.next();
    setSelectedProvisionalSessionId(undefined);
    onNewThread();
    go("workbench");
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
      await waitReceipt(client, handle.requestId);
      refreshSessionTitles(project.id as WorkspaceId);
    }));
  }, [client, expandProject, loadProjectHistory, navigationGate, previewMode.preview, go, onNewThread, onWorkspacesChange, runSessionCreate, refreshSessionTitles, workspaceActionQueue]);

  /** opts.resumeForAction：行级「打开并执行」——即使无驻留也 resume，让目标会话
      真正成为 Runtime 活动会话；失败时向上抛出，由调用方统一报告并中止后续动作。 */
  const openHistoryEntry = (entry: SessionHistoryEntry, workspaceId?: WorkspaceId, opts?: { resumeForAction?: boolean; skipQueue?: boolean }): Promise<void> => {
    const generation = navigationGate.next();
    setSelectedProvisionalSessionId(undefined);
    if (previewMode.preview) {
      onSelectThread(entry);
      return Promise.resolve();
    }
    // Navigation is a renderer concern and should react immediately. Runtime
    // activation may take longer and can reset transcript hydrate state; keep
    // it in the background after the selected history identity is visible.
    onSelectThread(entry);
    const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    const resident = residentForSession(residentModel, entry.sessionId);
    const targetWorkspaceId = resident?.workspaceId ?? workspaceId ?? active?.workspaceId;
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
    // The current Runtime session can be viewed immediately even while its
    // JSONL tail is still being flushed and the history catalog has no row yet.
    // Do not turn that normal live state into the misleading "仍在写入" error.
    if (shouldOpenLiveProvisional(thread.sessionId, snapshot?.sessionId)) {
      setSessionActionError(undefined);
      setSelectedProvisionalSessionId(thread.sessionId);
      onNewThread();
      onRoute("workbench");
      return;
    }
    if (!thread.submitted) {
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
    if (archiveBusy) return;
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
      case "diagnostics":
        if (action.intent !== undefined) setDiagnosticsIntent(action.intent);
        go("diagnostics");
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
        applyBottomChrome(toggleBottomBarOpen({ visible: bottomVisible, open: bottomOpen }));
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
        applyBottomChrome(revealBottomBar());
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
        applyBottomChrome(toggleBottomBarOpen({ visible: bottomVisible, open: bottomOpen }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [archiveBusy, archivePending, applyBottomChrome, bottomOpen, bottomVisible, dialog, go, skillsOpen, paletteOpen, closePalette, openPalette, startNewChat]);

  // 项目 shell 动作（外部编辑器 / 文件管理器）：AppShell 统一持有，
  // 顶栏面包屑菜单与侧栏应用菜单共用同一套状态与 Toast 提示。
  const [shellAction, setShellAction] = useState<"editor" | "directory" | null>(null);
  /** 顶栏「重命名对话」模态：builtin.rename 持久化到会话标题槽。 */
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const renameContextRef = useRef<{ sessionId?: SessionId; threadId?: ThreadId; workspaceId?: WorkspaceId } | undefined>(undefined);
  /** initialTitle：行级菜单显式传入所在行标题；顶栏缺省用当前查看会话标题。 */
  const openRenameDialog = (initialTitle?: string, context?: { sessionId?: SessionId; threadId?: ThreadId; workspaceId?: WorkspaceId }) => {
    renameContextRef.current = context ?? {
      ...(renameTargetSessionId === undefined ? {} : { sessionId: renameTargetSessionId }),
      ...(selected?.threadId === undefined ? {} : { threadId: selected.threadId }),
      ...(renameTargetWorkspaceId === undefined ? {} : { workspaceId: renameTargetWorkspaceId }),
    };
    setRenameValue(initialTitle ?? threadTitle);
    setRenameError(undefined);
    setRenameOpen(true);
  };
  const submitRename = () => {
    const next = renameValue.trim();
    if (!next || renameBusy) return;
    setRenameError(undefined);
    setRenameBusy(true);
    void workspaceActionQueue.enqueue(async () => {
      try {
        const context = renameContextRef.current;
        const targetSessionId = context?.sessionId ?? renameTargetSessionId;
        const targetThreadId = context?.threadId ?? selected?.threadId;
        const targetWorkspaceId = context?.workspaceId ?? renameTargetWorkspaceId;
        let renamedSessionId = targetSessionId;
        if (renameNeedsSessionResume({
          hasViewedHistory: context !== undefined || selected !== undefined,
          ...(targetSessionId === undefined ? {} : { viewedSessionId: targetSessionId }),
          ...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId }),
        })) {
          if (targetThreadId === undefined) throw new Error("当前查看会话缺少 threadId，无法重命名");
          await ensureWorkspaceActive(targetWorkspaceId);
          const resume = await client.command("session.resume", { threadId: targetThreadId });
          const resumed = await waitReceipt<OperatorStateSnapshot>(client, resume.requestId);
          if (selected?.sessionId !== undefined && resumed.sessionId !== selected.sessionId) {
            throw new Error("恢复的会话与当前查看会话不一致");
          }
          renamedSessionId = resumed.sessionId;
        }
        const handle = await client.command("operator.invoke", { commandId: "builtin.rename", arguments: next });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        if (renamedSessionId !== undefined && outcome.snapshot.sessionId !== renamedSessionId) {
          throw new Error("重命名回执与目标会话不一致");
        }
        renamedSessionId ??= outcome.snapshot.sessionId;
        const receiptTitle = outcome.snapshot.sessionTitle?.trim();
        const refreshed = await refreshHistoryAfterTitle(targetWorkspaceId);
        const historyTitle = refreshed?.entries.find((entry) => entry.sessionId === renamedSessionId)?.title?.trim();
        const confirmedTitle = receiptTitle === next
          ? receiptTitle
          : historyTitle === next
            ? historyTitle
            : undefined;
        if (confirmedTitle === undefined) {
          throw new Error("重命名回执或历史记录未确认目标标题");
        }
        if (renamedSessionId !== undefined) {
          const key = String(renamedSessionId);
          setProvisionalThreadsBySession((current) => {
            const thread = current[key];
            if (thread === undefined) return current;
            return { ...current, [key]: resolveProvisionalHistoryTitle(thread, confirmedTitle) };
          });
        }
        setShellNotice({ text: `已重命名为「${next}」`, icon: "check" });
        setRenameOpen(false);
      } catch (error) {
        setRenameError(hostErrorMessage(error, "重命名失败"));
      } finally {
        setRenameBusy(false);
      }
    });
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

  // Explorer 文件「更多」菜单：本机编辑器清单只在真实 workspace 且桌面 chrome 可用时拉取一次。
  const [fileOpeners, setFileOpeners] = useState<ReadonlyArray<FileOpenerOption>>([]);
  useEffect(() => {
    const workspace = realActiveWorkspace;
    const list = globalThis.ompStudioChrome?.listFileOpeners;
    if (workspace === undefined || list === undefined) {
      setFileOpeners([]);
      return;
    }
    let cancelled = false;
    void list({ workspaceId: workspace.workspaceId })
      .then((openers) => {
        if (!cancelled) setFileOpeners([...openers]);
      })
      .catch(() => {
        if (!cancelled) setFileOpeners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [realActiveWorkspace]);
  const fileShellUnavailable = globalThis.ompStudioChrome?.openFile === undefined ? "仅桌面端可用" : undefined;

  const runFileShellAction = (workspaceId: string, action: FileMenuAction, target: FileMenuTarget) => {
    const desktop = globalThis.ompStudioChrome;
    const messageOf = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : String(cause));
    const notice = (text: string, icon: string): void => {
      setShellNotice({ text, icon });
    };
    if (action.type === "copyRelative") {
      void navigator.clipboard
        .writeText(target.path)
        .then(() => notice("已复制相对路径", "check"))
        .catch(() => notice("复制相对路径失败", "alert"));
      return;
    }
    const input = { workspaceId, path: target.path, kind: target.kind };
    if (action.type === "copyAbsolute") {
      const resolve = desktop?.resolveFileAbsolutePath;
      if (resolve === undefined) return;
      void resolve(input)
        .then((absolute) => navigator.clipboard.writeText(absolute))
        .then(() => notice("已复制绝对路径", "check"))
        .catch((cause) => notice(`操作失败：${messageOf(cause)}`, "alert"));
      return;
    }
    const run = (invoke: () => Promise<WorkspaceFileActionResult>, openedText: string): void => {
      void invoke()
        .then((result) => {
          if (result.status === "cancelled") {
            notice("已取消选择打开器", "info");
            return;
          }
          if (result.status === "failed") {
            notice(`操作失败：${result.message}`, "alert");
            return;
          }
          notice(openedText, "check");
        })
        .catch((cause) => notice(`操作失败：${messageOf(cause)}`, "alert"));
    };
    if (action.type === "open") {
      const open = desktop?.openFile;
      if (open === undefined) return;
      run(() => open(input), `已用默认程序打开 ${target.name}`);
      return;
    }
    if (action.type === "openWith") {
      const openWith = desktop?.openFileWith;
      if (openWith === undefined) return;
      run(() => openWith({ ...input, openerId: action.openerId as "vscode" | "cursor" | "windsurf" | "choose" }), `已用所选程序打开 ${target.name}`);
      return;
    }
    if (action.type === "reveal") {
      const reveal = desktop?.revealFileInFileManager;
      if (reveal === undefined) return;
      run(() => reveal(input), target.kind === "dir" ? `已在资源管理器中打开 ${target.name}` : `已在资源管理器中定位 ${target.name}`);
    }
  };

  const chrome: ShellChrome = {
    collapsed,
    skillsOpen,
    explorerOpen,
    projectListExpanded,
    expandedProjects,
    projectHistories: projectHistoryCache,
    provisionalThreads: Object.values(provisionalThreadsBySession),
    ...(selectedHistoryId === null && (selectedProvisionalSessionId ?? snapshot?.sessionId) !== undefined
      ? { activeProvisionalSessionId: (selectedProvisionalSessionId ?? snapshot?.sessionId) as SessionId }
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
            <TitleMenu id="file" label={t("menu.file")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => startNewChat()}>{t("menu.newThread")}<span className="kbd">Ctrl ⇧ O</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("history")}>{t("menu.history")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("agent-hub")}>Agent Hub</button>
              <button className="menu-item" role="menuitem" onClick={() => go("capabilities")}>{t("menu.capabilities")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("model-config")}>{t("menu.modelConfig")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("settings")}>{t("menu.settings")}</button>
              <button className="menu-item" role="menuitem" onClick={() => go("diagnostics")}>{t("menu.diagnostics")}</button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => { setOpenMenu(null); openPalette(); }}>{t("menu.commandPalette")}<span className="kbd">Ctrl K</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("home")}>{t("menu.home")}</button>
            </TitleMenu>
            <TitleMenu id="edit" label={t("menu.edit")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("undo")}>{t("menu.undo")}<span className="kbd">Ctrl Z</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("redo")}>{t("menu.redo")}<span className="kbd">Ctrl Y</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runEdit("cut")}>{t("menu.cut")}<span className="kbd">Ctrl X</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("copy")}>{t("menu.copy")}<span className="kbd">Ctrl C</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("paste")}>{t("menu.paste")}<span className="kbd">Ctrl V</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("selectAll")}>{t("menu.selectAll")}<span className="kbd">Ctrl A</span></button>
            </TitleMenu>
            <TitleMenu id="view" label={t("menu.view")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setCollapsed((value) => !value))}>{collapsed ? t("menu.expandSidebar") : t("menu.collapseSidebar")}<span className="kbd">Ctrl B</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setExplorerOpen((value) => !value))}>{explorerOpen ? t("menu.collapseExplorer") : t("menu.expandExplorer")}</button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setSkillsOpen((value) => !value))}>{skillsOpen ? t("skills.closeAria") : t("skills.title")}<span className="kbd">Ctrl ⇧ K</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setSideOpen((value) => !value))}>{sideOpen ? t("menu.collapseRightPanel") : t("menu.expandRightPanel")}</button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setBottomOpen((value) => !value))}>{bottomOpen ? t("menu.collapseBottomPanel") : t("menu.expandBottomPanel")}<span className="kbd">Ctrl J</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => chrome.onToggleTheme())}>{theme === "dark" ? t("menu.lightTheme") : t("menu.darkTheme")}</button>
            </TitleMenu>
            <TitleMenu id="help" label={t("menu.help")} openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("shortcuts")}>{t("menu.shortcuts")}</button>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("about")}>{t("menu.about")}</button>
              <button className="menu-item" role="menuitem" disabled data-tip={t("menu.documentation")}>{t("menu.documentation")}</button>
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
          title={t(pageMeta.titleKey)}
          titleIcon={pageMeta.icon}
          theme={theme}
          className={shellClass}
          onRoute={go}
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
                  onDeleteSession={chrome.onDeleteSessionThread}
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
          ) : pageRoute === "model-config" ? (
            <ModelConfigPage key={mcNonce} client={client} />
          ) : pageRoute === "settings" ? (
            <SettingsPage
              key={settingsNonce}
              {...(snapshot ? { approvalMode } : {})}
              onSetApprovalMode={setApprovalMode}
              {...(runtimeSettings === undefined ? {} : { runtimeSettings })}
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
            <CapabilitiesPage key={capNonce} client={client} onRunSlash={runSlashFromShell} onPinCompleted={refreshPinnedHistory} />
          )}
        </SecondaryPage>
      ) : (
      <div className={`app-body ${shellClass}`}>
        <AppSidebar state={state} chrome={chrome} client={client} onRoute={go} onOpenAppUpdateDialog={() => setShowAppUpdateDialog(true)} />
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
            telemetryRefreshToken={telemetryRefreshToken}
          />
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
          <RuntimeLossBanner
            {...(runtime === undefined ? {} : { runtime })}
            client={client}
            preview={previewMode.preview}
            onOpenDiagnostics={() => go("diagnostics")}
          />
          <WorkbenchCanvas
            state={state}
            client={client}
            viewIdentity={selectedProvisionalSessionId === undefined
              ? (selectedHistoryId === null ? "live" : `history:${selectedHistoryId}`)
              : `draft:${selectedProvisionalSessionId}`}
             {...((selectedProvisionalSessionId ?? selected?.sessionId) === undefined ? {} : { selectedSessionId: selectedProvisionalSessionId ?? selected?.sessionId as string })}
            viewedAgents={viewedAgents}
            {...(selected?.threadId === undefined ? {} : { selectedThreadId: selected.threadId })}
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
            sideOpen={sideOpen}
            onCloseSide={() => setSideOpen(false)}
            sideTab={sideTab}
            onSideTabChange={setSideTab}
            panelWidth={panelWidth}
            onResizePanel={setPanelWidth}
            bottomOpen={bottomOpen}
            onBottomOpenChange={setBottomOpen}
            bottomVisible={bottomVisible}
            onBottomVisibleChange={setBottomVisible}
            bottomHeight={bottomHeight}
            onResizeBottom={(height) => setBottomHeight(clampBottomHeight(height))}
            bottomTab={bottomTab}
            onBottomTabChange={setBottomTab}
            onRoute={go}
            onOpenChanges={() => { setSideTab("changes"); setSideOpen(true); }}
            onOpenGit={() => { setSideTab("git"); setSideOpen(true); }}
             composerRef={composerRef}
             {...(composerDraftsBySession[selectedProvisionalSessionId ?? selected?.sessionId ?? ""] === undefined
               ? {}
               : { composerDraft: composerDraftsBySession[selectedProvisionalSessionId ?? selected?.sessionId ?? ""] })}
             onComposerDraftChange={onComposerDraftChange}
            onDraftSkillsChange={onDraftSkillsChange}
            onUsedSkillsChange={onUsedSkillsChange}
            onSessionTitleMaybeChanged={() => refreshSessionTitles(selectedProject?.id as WorkspaceId | undefined)}
            onProvisionalSessionChange={onProvisionalSessionChange}
            onPinCompleted={refreshPinnedHistory}
            onSlashUi={applySlashUi}
            btwWindow={btwWindow}
            btwSession={btwSession}
            btwSideHeadRect={sideHeadRect}
            onBtwDemoNext={() => setBtwDemoRound((round) => (round + 1) % PREVIEW_BTW_SNAPSHOTS.length)}
            onBtwPreviewAsk={() => setBtwDemoRound(0)}
            compactPending={compactPending}
            onCompactPending={setCompactPending}
            onViewedTelemetryRefresh={refreshViewedTelemetry}
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
              <button type="button" className="btn primary" disabled={!renameValue.trim() || renameBusy} onClick={submitRename}>
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
                    <div className="about-row"><dt>{t("nav.newChat")}</dt><dd><span className="kbd">Ctrl ⇧ O</span></dd></div>
                    <div className="about-row"><dt>{t("menu.commandPalette")}</dt><dd><span className="kbd">Ctrl K</span></dd></div>
                    <div className="about-row"><dt>{t("menu.toggleSidebar")}</dt><dd><span className="kbd">Ctrl B</span></dd></div>
                    <div className="about-row"><dt>{t("menu.skillsAndPlugins")}</dt><dd><span className="kbd">Ctrl ⇧ K</span></dd></div>
                    <div className="about-row"><dt>{t("menu.bottomPanel")}</dt><dd><span className="kbd">Ctrl J</span></dd></div>
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
          isDownloading={appUpdate.state.downloading}
          downloadError={appUpdate.state.downloadError}
          onClose={() => setShowAppUpdateDialog(false)}
          onDownloadAndInstall={() => appUpdate.downloadAndInstall()}
        />
      ) : null}
    </div>
  );
}

export function App({ client: inputClient }: { readonly client: StudioClient }) {
  const { t } = useI18n();
  const client = inputClient as ClientStateSource;
  const [state, dispatch] = useReducer(reduce, { loading: true, model: {}, events: [], route: "workbench" });
  const [route, setRoute] = useState<Route>(initialRouteFromSettings);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const { check: checkAppUpdate } = useAppUpdate();

  useEffect(() => {
    void checkAppUpdate(true);
  }, [checkAppUpdate]);

  useEffect(() => {
    let cancelled = false;
    const offEvent = client.subscribe({ scope: "all" }, (event) => {
      notifyFromEvent(event, t);
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
    if (state.loading || runtimeStatus === undefined) return;
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
      <I18nProvider>
        {body}
        <StartupNotice />
        <TipHost />
      </I18nProvider>
    </PreviewModeProvider>
  );
}

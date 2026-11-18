import { useWorkbenchResizers } from "../layout/useWorkbenchResizers";
import { useWorkbenchBranches } from "../git/useWorkbenchBranches";
import { FileDockInstances } from "../files/FileDockInstances";
import { SharedSurface, useConversationWorkspace, useConversationView, useConversationDom } from "../conversationWorkspace/Context";
import { browserReferenceSnapshot } from "../composer/browserReference";
import type { BrowserElementReference } from "@omp-studio/studio-protocol";
import { EnvironmentDockCard } from "../environment/EnvironmentCard";
import { ContextDockPanel } from "../conversation/ContextCard";
import { PanelRegistration } from "../dock/PanelRegistration";
import { FileBrowserDock } from "../fileBrowser/FileBrowserDock";
import { revealMainWindow } from "../dock/SurfaceContext";
import { DockPanel, useAgentDockLayout, useDockEngine } from "../dock/DockContext";
import { DockGroupRegion, DockRail, DockCapsules, DockKeyboard } from "../dock/DockRegions";
import { useBottomToggleClearance } from "../dock/revealClearance";
import { locatePanel } from "../dock/model";
import { agentPanelId, panelBaseId, type AgentPanelId, type PanelId } from "../dock/types";
import { DeferredPanel, lazyPanel } from "../DeferredPanel";
import { DictationControl } from "../composer/DictationControl";
import { PromptHistoryButton } from "../composer/PromptHistory";
import { useExecutionTarget, useTargetMemory } from "../workspaces/ExecutionTargets";
import { ExecutionTargetPicker } from "../workspaces/ExecutionTargetPicker";
import { AppSelect } from "../AppSelect";
import { PlanExecutionPicker, useNativePlanReview } from "../deck/PlanExecutionPicker";
import { WorktreeLaunchGate } from "../workspaces/SessionWorktreesPane";
import { BrowserPane } from "../browser/BrowserPane";
import { BrowserDockInstances } from "../browser/BrowserDockInstances";
import { ComputerLinkProvider } from "../computer/links";
import type { ComputerFrameIntent } from "../computer/types";
import { TokenCounterPane } from "../usage/TokenCounterPane";
import { SelectiveCommitPane, selectiveCommitHandoff, type SelectiveCommitIntent } from "../commit/SelectiveCommitPane";
import { SelectiveCommitLauncherProvider } from "../commit/SelectiveCommitLauncher";
import { setHubIntent, setModelConfigIntent, setSettingsIntent } from "../pageIntents";
import { conversationViewLeases } from "../conversation/conversationViews";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useConversationWidth } from "../settings/ConversationWidthContext";
import { useReadingColumn } from "../layout/useReadingColumn";
import type { ClientInteraction, CommandName, CommandState, CommandInput, InteractionResponseValue, OperatorInvokeOutcome, SessionHistoryEntry, SessionId, SessionTreeCommandOutcome, ThreadId, StudioPlanSaveAndQuitResult, Unsubscribe, WorkspaceId, WorkspaceListReadModel, PromptImageInput, ContinueTurnOutcome } from "@omp-studio/client-contract";
import { selectComposerReceipt } from "@omp-studio/client";
import { type ShellEventLogEntry } from "../shellMemory";
import type { ApprovalMode, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import type { OperatorCommandManifest } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { MenuItem } from "../menus";
import { useI18n } from "../i18n";
import { SHORTCUTS, formatShortcut } from "../keyboard/shortcuts";
import { approvalPickerDisabled, ComposerApprovalPicker } from "../ComposerApprovalPicker";
import { ComposerModelPicker } from "../ComposerModelPicker";
import { ServiceTierPicker } from "../composer/ServiceTierPicker";
import { RuntimeQueue } from "../composer/RuntimeQueue";
import { ComposerModePicker } from "../ComposerModePicker";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { bindSlashTypedCommand, composerSlashExecute, isDestructiveMemoryClear, mergeSlashCatalogWithManifest, planComposerSend, resolveSlashExecute, type SlashNativeUi, type StudioSlashCommand } from "../composer/commands";
import { LuxOrbit } from "../lux/LuxOrbit";
import { composerFollowUpEnabled, composerOwnerSessionId, composerOwnsLiveSnapshot, composerPromptEnabled, composerQueueEnabled, composerRunningForTarget, createComposerDispatchGate, promptTargetChanged, visibleQueuedMessages } from "../composer/dispatch";
import { beginQueueEdit, cancelQueueEdit, commitQueueEdit, parkQueueEdit, snapshotOfQueued, switchQueueEdit, type QueueEditState } from "../composer/queueEdit";
import { createWorkspaceFileIndex, followWorkspaceFileIndex, loadMentions, previewMentions, workspaceDirectoryLister } from "../composer/mentions";
import { snapshotFromDoc, snapshotFromText, snapshotFromTextAndImages, snapshotIsEmpty } from "../composer/serialize";
import { useComposerDraft } from "../composer/useComposerDraft";
import { emptySnapshot, type ComposerSnapshot } from "../composer/types";
import type { FileViewerActions } from "../files/fileActions";
import { skillNamesInDoc, skillNamesInText } from "../skills/skillUsage";
import type { StudioSpeed } from "@omp-studio/studio-protocol";
import { ComposerSpeedControl } from "../composer/ComposerSpeedControl";
import { SessionModelRecovery } from "../models/SessionModelRecovery";
import { RuntimeQueueBar } from "../composer/RuntimeQueueBar";
import { MessageQueueBar, type QueuedMessage } from "../MessageQueueBar";
import { injectMagicKeyword, type MagicKeyword } from "../composerMode";
import { RuntimeLossBanner } from "../RuntimeLossBanner";
import { ToastHost } from "../ToastHost";
import { OmpLogsPanel } from "../panels/OmpLogsPanel";
import { OutputPanel } from "../panels/OutputPanel";
import type { LedgerCommandRow } from "../panels/types";
import { compactNoticeFromOutput } from "../compactNotice";
import { toggleBottomBarVisible } from "../bottomPanelChrome";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { asConversationClient } from "../conversation/conversationHost";
import { useActivityRetry, useAwaitingTurn, useRunStreaming, useRunWindow } from "../conversation/ActivityLine";
import { deriveActivityStatus, hasLiveActivityProgress, isAbortEligible } from "../conversation/activityStatus";
import { ConversationEmpty } from "../conversation/ConversationEmpty";
import { ConversationPane } from "../conversation/ConversationPane";
import { CommandBlockProvider } from "../conversation/CommandBlock";
import { SubagentHoverProvider } from "../conversation/SubagentHoverPreview";
import { AgentsDock } from "../agents/deck/AgentsDock";
import { agentSwarmScope } from "../agents/deck/swarmScope";
import type { DeckLinks } from "../agents/deck/AgentDeck";
import { BackgroundTasksDock } from "../backgroundTasks/BackgroundTasksDock";
import { AgentDetailPanel } from "../agents/AgentDetailPanel";
import { getPreviewDockAgents } from "../preview/agentDockPreview";
import { nextSubagentBtwIntent, sharedSubagentViewBook, subagentViewKey } from "../conversation/subagentViewState";
import { agentPresentation } from "../agents/agentPresentation";
import { collectAgents, collectLatestPlanDocument, SESSION_CHANGE_LAST_ID, sessionTaskProgress, type SubagentHubTarget } from "../conversation/toolMeta";
import { TaskProgressDock } from "../conversation/TaskProgressDock";
import { SessionChanges } from "../conversation/SessionChanges";
import { ChangesDockMeter } from "../conversation/ChangesDockMeter";
import { AgentTestsPane } from "../conversation/AgentTestsPane";
import { projectAgentTestRuns, rerunTestPrompt } from "../conversation/agentTestRuns";
import { revealConversationTool, revealConversationTarget } from "../conversation/conversationReveal";
import { useConversation } from "../conversation/useConversation";
import type { PendingUser } from "../conversation/conversationViewModel";
import { tailInterrupted } from "../conversation/conversationViewModel";
import { executeUserMessageBranch, executeUserMessageRestore, userMessageRestoreDisabledReason, type UserMessageEditorFill } from "../conversation/userMessageRestore";
import { useUserMessageTreeConfirm } from "../conversation/UserMessageTreeConfirm";
import { claimTransientToast, isTransientStatusNotice, transientStatusFamily } from "../conversation/transientStatusNotice";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_LEDGER_COMMANDS, PREVIEW_SHELL_EVENTS, PREVIEW_TODO_FILES, findPreviewProject, getPreviewProjects, getPreviewQueuedMessages, getPreviewRunActivity, getPreviewTodos } from "../preview/fixtures";
import { PreviewChanges, PreviewLogs, PreviewProblems, PreviewTests } from "../preview/surfaces";
import { PreviewDeck } from "../preview/PreviewDeck";
import { ContentGallerySamples } from "../preview/ContentGallerySamples";
import { getPreviewDeckItems } from "../preview/deckFixtures";
import { previewEnvironmentCard } from "../preview/environmentCardPreview";
import { previewTailInterrupted } from "../preview/conversationFixtures";
import { BtwPanel } from "../btw/BtwPanel";
import { type BtwSessionApi } from "../btw/useBtwSession";
import { InteractionDeck } from "../InteractionDeck";
import { useFormInteractionLifecycle } from "../deck/FormSession";
import { ASK_GENIE_HOLD_MS, isAskDeckInteraction } from "../deck/askGenie";
import { motionReduced } from "../motion";
import { interactionDeckDisabled, planReviewDeckDisabled, usableCapabilityManifest } from "../deck/interactionGate";
import { PlanReviewDeck, PlanViewDialog } from "../deck/PlanCard";
import { type PlanActionDetail, type PlanActionId } from "../deck/types";
import { residentForSession } from "../sidebar/threadRunning";
import { sidebarProjectOrder } from "../sidebar/projectOrder";
import { provisionalThreadTitle } from "../sidebar/provisionalThread";
import { type ThreadWaitKind } from "../sidebar/threadWait";
import { ensureSelectedSessionActive, type NewSessionWaitResult } from "../sessionLifecycle";
import { isNewConversationSurface, shouldShowConversationWelcome } from "../conversation/welcomeGate";
import { useGitRepository } from "../git/useGitRepository";
import { type ClientStateSource, type Route, type ViewState } from "./types";
import { type SelectedProject } from "./sessionSelection";
import { useComposerCollisionCollapse } from "../composer/useComposerCollisionCollapse";
import { BOTTOM_PANEL_DEFAULT, BottomPanelChrome } from "./BottomPanelChrome";
import { snapshotFrom } from "./shellState";
import { canStartPlanSaveAndQuit, isLiveSessionPreferenceCommand, planSaveAndQuitNotice } from "./sessionActions";
import { takeSlashUiIntent } from "./slashUiIntent";
import { GitWorkbenchPanels } from "../git/GitWorkbenchPanels";

const LocalFilesPane = lazyPanel(() => import("../capabilities/LocalFilesPane").then(module => ({ default: module.LocalFilesPane })));

const ContextInspector = lazyPanel(() => import("../contextViewer/ContextInspector").then(module => ({ default: module.ContextInspector })));

const ComputerDockPane = lazyPanel(() => import("../computer/ComputerDockPane").then(module => ({ default: module.ComputerDockPane })));

const TerminalPane = lazyPanel(() => import("../TerminalPane").then(module => ({ default: module.TerminalPane })));

/** 已弹过 toast 的通知 id 记忆量。通知本身封顶 100 条，留 4 倍余量。 */
const TOASTED_NOTICE_MEMORY = 400;

function Deferred({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <Icon name="info" extra="lg" />
      <p>{title}</p>
      <p className="muted small">{detail}</p>
    </div>
  );
}

/** Flattens the reducer's command states into the ledger's scan-only view. */
function toLedgerCommand(command: CommandState): LedgerCommandRow {
  const at = "observedAt" in command ? command.observedAt : "acceptedAt" in command ? command.acceptedAt : "issuedAt" in command ? command.issuedAt : undefined;
  const detail = "reason" in command ? command.reason : "error" in command ? command.error.message : undefined;
  return {
    requestId: command.requestId,
    commandName: command.commandName,
    status: command.status,
    ...(at ? { at } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Manifest-driven operator entry: one command, one JSON argument object. */
function OperatorCommandForm({ manifest, busy, enabled, onInvoke }: { manifest: OperatorCommandManifest; busy: boolean; enabled: boolean; onInvoke: (commandId: string, args?: unknown) => void }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState("");
  const [args, setArgs] = useState("{}");
  const command = manifest.commands.find((entry) => entry.id === selected);
  return (
    <section>
      <h3 className="dock-group-label">{t("shell.operatorCommandForm")}</h3>
      <p className="dock-group-hint">{t("shell.operatorCommandFormHint")}</p>
      <div className="dock-form-row">
        <AppSelect className="select" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Select command</option>
          {manifest.commands.filter((entry) => entry.presentation === "generic-form" && entry.availability === "available").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </AppSelect>
        <input className="input" value={args} onChange={(event) => setArgs(event.target.value)} aria-label="Command arguments JSON" placeholder="{}" />
        <button className="btn primary" disabled={!command || !enabled || busy} onClick={() => { try { onInvoke(command!.id, JSON.parse(args)); } catch { /* malformed JSON stays local */ } }}>Invoke</button>
      </div>
    </section>
  );
}

function formatDiffCount(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

type PromptSendPhase = "starting" | "sending" | "initiating";

type OptimisticPrompt = { readonly pending: PendingUser; readonly phase: PromptSendPhase };

let nextOptimisticPromptId = 1;

const PROMPT_SEND_PHASE_LABEL: Record<PromptSendPhase, string> = {
  starting: "Starting OMP",
  sending: "Sending",
  initiating: "Initiating",
};

export function WorkbenchCanvas({ workbenchVisible, railMode, layoutOverlayDismiss, state, client, onOpenWorktree, selectedSessionId, viewedSessionName, viewedAgents, selectedThreadId, viewIdentity, previewProjectId, previewThreadId, sessionCreating, waitForNewSession, ensureNewSession, onSelectProject, onSelectPreviewProject, onSelectPreviewThread, onSelectThread, onBranchedSession, hiddenPreviewThreads, onPreviewDeckWait, sideOpen, panelWidth, onResizePanel, bottomOpen, onBottomOpenChange, bottomVisible, onBottomVisibleChange, bottomHeight, onResizeBottom, onRoute, onOpenChanges, onOpenGit, composerRef, workspaceId, onSlashUi, onDraftSkillsChange, onUsedSkillsChange, onSessionTitleMaybeChanged, onProvisionalSessionChange, onPinCompleted, btwSession, onBtwDemoNext, onBtwPreviewAsk, createProjectNonce, compactPending, onCompactThread, onCompactPending, onViewedTelemetryRefresh, telemetryRefreshToken, composerDraft, onComposerDraftChange, composerInsertion, onComposerInsertionApplied, fileViewerActions }: {
  workbenchVisible: boolean;
  railMode: "hidden" | "expanded" | "compact";
  state: ViewState;
  client: ClientStateSource;
  onOpenWorktree?: ((workspaceId: string) => Promise<void>) | undefined;
  selectedSessionId?: string;
  viewedSessionName?: string;
  viewedAgents?: readonly StudioAgentSnapshot[];
  selectedThreadId?: ThreadId;
  /** Stable renderer view identity; changes even while history entry resolution is pending. */
  viewIdentity?: string;
  /** 后台 session.create 进行中：欢迎区照常显示，发送前再等就绪。 */
  sessionCreating?: boolean;
  waitForNewSession?: () => Promise<NewSessionWaitResult>;
  /** Start session.create when sending from an empty workbench with no live session. */
  ensureNewSession?: (model?: string) => void;
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
  layoutOverlayDismiss?: () => void;
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
  btwSession: BtwSessionApi;
  onBtwDemoNext: () => void;
  /** Preview `/btw`: reset the fixture round. Local UI only. */
  onBtwPreviewAsk: () => void;
  /** AppMenu「新建项目」：nonce 递增时打开与面包屑相同的创建项目对话框。 */
  createProjectNonce?: number;
  /** 顶栏 / slash Compact 已发出、命令尚未结束。 */
  compactPending?: boolean;
  onCompactThread: () => void;
  onCompactPending?: (pending: boolean) => void;
  onViewedTelemetryRefresh?: () => void;
  telemetryRefreshToken?: number;
  onComposerDraftChange?: (sessionId: string, draft: ComposerSnapshot) => void;
  composerDraft?: ComposerSnapshot;
  composerInsertion?: { owner: string | undefined; text: string } | undefined;
  onComposerInsertionApplied?: () => void;
  fileViewerActions?: FileViewerActions;
}) {
  const { document, window } = useConversationDom();
  const mdi = useConversationView();
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const executionTarget = useExecutionTarget();
  const [draft, setDraft] = useTargetMemory<ComposerSnapshot>("composer-current-draft", () => composerDraft ?? emptySnapshot());
  const composerDraftRef = useRef<ComposerSnapshot | undefined>(composerDraft);
  composerDraftRef.current = composerDraft;
  /* 精确草稿不重渲；渲染视图仅在状态边界或停止输入后发布。 */
  const { draftLive, publishDraft, commitDraft } = useComposerDraft(draft, setDraft);
  const applyingDraft = useRef(false);
  const replaceDraft = useCallback((next: ComposerSnapshot) => {
    const editor = composerRef.current;
    if (editor === null) {
      commitDraft(next);
      return;
    }
    applyingDraft.current = true;
    try {
      // Both methods emit the normalized document once, including image labels.
      if (next.doc.nodes.length === 0) editor.clear();
      else editor.setSnapshot(next);
    } finally {
      applyingDraft.current = false;
    }
  }, [composerRef, commitDraft]);
  const [submittedPrompt, setSubmittedPrompt] = useState<{ readonly sessionId?: SessionId; readonly title: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const [planSaveBusy, setPlanSaveBusy] = useState(false);
  const [remotePlanSave, setRemotePlanSave] = useState<{ resolve(path: string | null): void }>();
  const [remotePlanPath, setRemotePlanPath] = useState("PLAN.md");
  const planSaveBusyRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [optimisticPrompt, setOptimisticPrompt] = useState<OptimisticPrompt | undefined>(undefined);
  const optimisticPromptRef = useRef(optimisticPrompt);
  optimisticPromptRef.current = optimisticPrompt;
  const composerBarRef = useComposerCollisionCollapse();
  const dock = useDockEngine();
  const agentDockLayout = useAgentDockLayout();
  const { bottomResizing, onPanelResizePointerDown, onPanelResizeKeyDown, onBottomResizePointerDown, onBottomResizeKeyDown } = useWorkbenchResizers({ sideOpen, panelWidth, onResizePanel, bottomOpen, onBottomOpenChange, bottomHeight, onResizeBottom });
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const toastedStatusIds = useRef(new Set<string>());
  /** 已扫过技能名的 user 行 itemId（按会话重置，跟着可见窗口裁剪）。 */
  const usedSkillScanRef = useRef<{ identityKey: string; itemIds: Set<string> }>({ identityKey: "", itemIds: new Set() });
  const lastStatusToast = useRef<{ family: "fast-tier" | "prewalk-noop"; at: number } | undefined>(undefined);
  const [composerSubmitted, setComposerSubmitted] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(true);
  const [modeCapsulesPresent, setModeCapsulesPresent] = useState(false);
  const composerInputRef = composerRef;
  useEffect(() => {
    const restored = composerDraftRef.current ?? draftLive.current;
    if (!snapshotIsEmpty(restored)) replaceDraft(restored);
  }, []);
  // 流式期间按 Enter 的消息先排本地队列，本轮 run 结束后由 flush effect 按序发送。
  const [queuedMessages, setQueuedMessages] = useTargetMemory<QueuedMessage[]>("composer-queue", () => []);
  const [previewSpeeds, setPreviewSpeeds] = useState<Record<string, StudioSpeed>>({});
  const [queueEdit, setQueueEdit] = useState<QueueEditState | undefined>(undefined);
  const [contextProjectMenuOpen, setContextProjectMenuOpen] = useState(false);
  const [contextProjectQuery, setContextProjectQuery] = useState("");
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
  const [commitIntent, setCommitIntent] = useState<SelectiveCommitIntent | undefined>(undefined);
  /* Git, Changes and `/commit` all land in the same session-scoped panel. */
  const openSelectiveCommit = (intent: Omit<SelectiveCommitIntent, "key"> = {}) => {
    setCommitIntent(previous => ({ ...intent, key: (previous?.key ?? 0) + 1 }));
    dock.store.dispatch({ type: "open", panel: "commit" });
  };
  const promptUnsub = useRef<Unsubscribe | undefined>(undefined);
  const promptDispatchGate = useMemo(createComposerDispatchGate, []);
  useEffect(() => () => promptUnsub.current?.(), []);
  const { preview, marks } = usePreviewMode();
  const treeConfirm = useUserMessageTreeConfirm(preview);
  const agentViewBook = sharedSubagentViewBook;
  const contextInspectorOpened = useSyncExternalStore(dock.store.subscribe, () => !!locatePanel(dock.store.getSnapshot().layout, "context-viewer"));
  const openContextInspector = () => dock.store.dispatch({ type: "open", panel: "context-viewer" });
  const [localFilesOpen, setLocalFilesOpen] = useState(false);
  const [localFileName, setLocalFileName] = useState("");
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [rememberedPlan, setRememberedPlan] = useState<{ title: string; body: string } | undefined>(undefined);
  const planDialogOriginRef = useRef<HTMLElement | null>(null);
  const [previewDeckKind, setPreviewDeckKind] = useState<"plan" | "ask" | null>(null);
  const lastAskDeckRef = useRef<ClientInteraction | null>(null);
  const [askDeckLeaving, setAskDeckLeaving] = useState(false);
  useEffect(() => {
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
    setPreviewQueue(previewQueueActive ? getPreviewQueuedMessages(zh).map((entry) => ({ ...entry })) : []);
  }, [previewQueueActive, previewQueueActive ? zh : false]);
  const queueEditRef = useRef(queueEdit);
  queueEditRef.current = queueEdit;
  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;
  const previewQueueRef = useRef(previewQueue);
  previewQueueRef.current = previewQueue;
  const queueViewRef = useRef({ selectedSessionId, preview });
  useEffect(() => {
    const prev = queueViewRef.current;
    queueViewRef.current = { selectedSessionId, preview };
    if (prev.selectedSessionId === selectedSessionId && prev.preview === preview) return;
    const editing = queueEditRef.current;
    if (editing === undefined) return;
    const composer = composerInputRef.current?.getSnapshot() ?? draftLive.current;
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
    replaceDraft(result.composer);
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
    if (previous.sessionId === undefined && selectedSessionId !== undefined
      && previous.viewIdentity === viewIdentity && snapshotFrom(state)?.sessionId === selectedSessionId) {
      onComposerDraftChange?.(selectedSessionId, composerRef.current?.getSnapshot() ?? draftLive.current);
      return;
    }
    replaceDraft(composerDraftRef.current ?? emptySnapshot());
    setComposerError(undefined);
    setQueueEdit(undefined);
  }, [selectedSessionId, selectedThreadId, viewIdentity]);
  const pendingComposerFillRef = useRef<{ sessionId: string; fill: UserMessageEditorFill } | undefined>(undefined);
  useEffect(() => {
    const pending = pendingComposerFillRef.current;
    if (pending === undefined || pending.sessionId !== selectedSessionId) return;
    pendingComposerFillRef.current = undefined;
    const restored = snapshotFromTextAndImages(pending.fill.text ?? "", pending.fill.images);
    replaceDraft(restored);
    setComposerError(undefined);
    queueMicrotask(() => composerInputRef.current?.focus());
  }, [selectedSessionId]);
  const snapshot = snapshotFrom(state);
  const terminalConversationId = mdi?.view && mdi.view.placement !== "main" ? mdi.document.id : undefined;
  const terminalSessionId = terminalConversationId || !mdi ? snapshot?.sessionId : undefined;
  const submittedPromptTitle = submittedPrompt !== undefined && submittedPrompt.sessionId === snapshot?.sessionId
    ? submittedPrompt.title
    : undefined;
  const rosterAgents = viewedAgents ?? (selectedSessionId === undefined || selectedSessionId === snapshot?.sessionId ? snapshot?.agents : undefined);
  const agentParentSessionId = preview ? `preview:${previewThreadId ?? "current"}` : selectedSessionId ?? snapshot?.sessionId;
  const agentScope = agentSwarmScope(executionTarget.id, workspaceId, agentParentSessionId, preview);
  const recentAgentPanel = agentDockLayout.lastAgentPanel;
  const recentAgent = recentAgentPanel ? agentDockLayout.agentPanels[recentAgentPanel] : undefined;
  const inspectTarget = recentAgent?.scope === agentScope && recentAgentPanel && locatePanel(agentDockLayout, recentAgentPanel) ? recentAgent.target : null;
  const dockAgents = useMemo(() => preview ? getPreviewDockAgents(zh) : rosterAgents ?? [], [preview, preview ? zh : false, rosterAgents]);
  const openedAgentIds = Object.entries(agentDockLayout.agentPanels).filter(([id, descriptor]) => descriptor.scope === agentScope && locatePanel(agentDockLayout, id as PanelId)).map(([, descriptor]) => descriptor.target.agentId);
  const openAgentDetail = useCallback((target: SubagentHubTarget) => {
    const agent = dockAgents.find(item => item.agentId === target.agentId);
    dock.store.dispatch({ type: "agent-open", panel: agentPanelId(agentScope, target.agentId), descriptor: { scope: agentScope, target: { ...target,
      ...(agent?.resolvedModel === undefined ? {} : { resolvedModel: agent.resolvedModel }),
      ...(agentParentSessionId === undefined ? {} : { parentSessionId: agentParentSessionId }) } } });
  }, [agentScope, agentParentSessionId, dock.store, dockAgents]);
  /** The deck's BTW action opens the agent's tab on its BTW page; the serial lets a repeat request re-apply. */
  const [agentBtwIntent, setAgentBtwIntent] = useState<{ scope: string; agentId: string; serial: number } | null>(null);
  const connection = state.clientState?.connection;
  const runtime = connection?.runtime ?? state.bootstrap?.runtime;
  const commands = state.clientState?.commands ?? {};
  const pendingInteraction = state.clientState?.interaction.pending ?? null;
  useFormInteractionLifecycle(pendingInteraction);
  const readForm = useCallback(async (interaction: Extract<ClientInteraction, { kind: "form" }>) => {
    const result = await client.query("interaction.form.read", { sessionId: interaction.sessionId, interactionId: interaction.interactionId, leaseGeneration: interaction.leaseGeneration });
    return result.form;
  }, [client]);
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
    if (motionReduced()) {
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
    () => mergeSlashCatalogWithManifest(preview ? undefined : commandManifest, resolvedLanguage === "zh"),
    [commandManifest, preview, resolvedLanguage],
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
  // The viewed chat owns the browser pages, matching the dock layout's scope.
  const browserChatId = preview ? previewThreadId : selectedSessionId ?? snapshot?.sessionId;
  const insertBrowserReferences = useCallback((references: BrowserElementReference[]) => {
    revealMainWindow(); onRoute("workbench"); setComposerExpanded(true);
    for (const element of references) {
      const reference = browserReferenceSnapshot(element);
      composerInputRef.current?.insertChip({ kind: "browser", label: reference.title, reference });
      if (element.screenshot) composerInputRef.current?.insertChip({ kind: "image", label: element.tagName, image: { type: "image", mimeType: element.screenshot.mimeType, data: element.screenshot.data } });
    }
    composerInputRef.current?.focus();
  }, [onRoute]);
  const agentRosterSource = preview ? "live" : selectedSessionId !== undefined && snapshot?.sessionId !== undefined && selectedSessionId !== snapshot.sessionId ? "history" : !runtimeConnected || connection?.resyncRequired ? "offline" : "live";
  const openAgentFromCatalog = useCallback((agentId: string) => {
    const agent = dockAgents.find(item => item.agentId === agentId);
    openAgentDetail({ agentId, ...(agent?.displayName === undefined ? {} : { displayName: agent.displayName }), ...(agent?.assignment === undefined ? {} : { task: agent.assignment }) });
  }, [dockAgents, openAgentDetail]);
  useLayoutEffect(() => {
    const zh = resolvedLanguage === "zh";
    dock.setAgentCatalog({ scope: agentScope, open: openAgentFromCatalog, entries: dockAgents.filter(agent => agent.kind !== "main").map(agent => {
      const presentation = agentPresentation(agent, preview, zh);
      return { agentId: agent.agentId, name: agent.displayName, model: `${zh ? "模型" : "Model"}: ${presentation.model ?? presentation.modelLabel}`,
        status: presentation.status, tone: presentation.tone, stale: agentRosterSource !== "live" };
    }) });
  }, [dock.setAgentCatalog, agentScope, dockAgents, openAgentFromCatalog, preview, resolvedLanguage, agentRosterSource]);
  // A resident session is activated asynchronously after history selection.
  // Do not start an archive read for it only to throw that work away when the
  // live epoch arrives a moment later.
  const selectedResident = selectedSessionId === undefined
    ? undefined
    : residentForSession(state.clientState?.entities.residents, selectedSessionId);
  const deferResidentHydrate = selectedResident !== undefined && snapshot?.sessionId !== selectedSessionId;
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
    syncRevision: preview ? 0 : executionTarget.syncRevision,
    deferHydrate: deferResidentHydrate,
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
  /* 技能集合是内容而不是身份：草稿每换一次快照都重新 `new Set(...)` 会让
     AppShell 跟着重渲（击键 → 标题/侧栏）。只有名字真的变了才上报。 */
  const draftSkillKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const names = skillNamesInDoc(draft.doc);
    const key = [...names].sort().join("\u0000");
    if (draftSkillKeyRef.current === key) return;
    draftSkillKeyRef.current = key;
    onDraftSkillsChange?.(names);
  }, [draft.doc, onDraftSkillsChange]);
  useEffect(() => {
    // 增量扫描：`mergeUsedSkills` 做并集，所以只需要交出「这次新看到的」技能名。
    // 原实现每次 rows 换身份就对全部 user 行重跑一遍正则，长会话下是 O(全对话)。
    // 记住已扫过的 itemId 而不是行数：`loadOlder` 会往前插，窗口也会从头裁。
    const scanned = usedSkillScanRef.current;
    if (scanned.identityKey !== convo.identityKey) {
      scanned.identityKey = convo.identityKey;
      scanned.itemIds = new Set();
    }
    const names = new Set<string>();
    const present = new Set<string>();
    for (const row of convo.rows) {
      if (row.type !== "user") continue;
      present.add(row.itemId);
      if (scanned.itemIds.has(row.itemId)) continue;
      scanned.itemIds.add(row.itemId);
      for (const name of skillNamesInText(row.text)) names.add(name);
    }
    // 跟着窗口裁，别让它随会话长度无界增长。
    for (const itemId of scanned.itemIds) if (!present.has(itemId)) scanned.itemIds.delete(itemId);
    if (names.size > 0) onUsedSkillsChange?.(convo.identityKey, names);
  }, [convo.rows, convo.identityKey, onUsedSkillsChange]);
  useEffect(() => {
    toastedStatusIds.current = new Set();
  }, [convo.identityKey]);
  useEffect(() => {
    for (const notice of convo.state.notices) {
      if (!isTransientStatusNotice(notice.message, notice.source)) continue;
      if (toastedStatusIds.current.has(notice.id)) continue;
      toastedStatusIds.current.add(notice.id);
      // 只在切会话时清（见上方），所以单个长会话里它会随通知条数单调增长。
      // 通知本身封顶 100 条（`NOTICE_LIMIT`），去重集合留 4 倍余量足够。
      if (toastedStatusIds.current.size > TOASTED_NOTICE_MEMORY) {
        const oldest = toastedStatusIds.current.values().next().value;
        if (oldest !== undefined) toastedStatusIds.current.delete(oldest);
      }
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
  const computerApprovalRef = useRef<HTMLDivElement>(null);
  const [computerFrameIntent, setComputerFrameIntent] = useState<ComputerFrameIntent>();
  const computerSessionId = selectedSessionId ?? snapshot?.sessionId;
  const computerScopeKey = JSON.stringify([executionTarget.id, executionTarget.syncRevision, connection?.authorityEpoch, connection?.runtimeEpoch ?? snapshot?.runtimeEpoch]);
  const openComputerFrame = useCallback((intent: Omit<ComputerFrameIntent, "id">) => {
    setComputerFrameIntent({ ...intent, id: crypto.randomUUID() });
    // Open restores the user's existing Dock location; never force a move to the right rail.
    dock.store.dispatch({ type: "open", panel: "computer" });
  }, [dock.store]);
  useEffect(() => { setComputerFrameIntent(undefined); }, [computerSessionId, computerScopeKey]);
  const revealComputerAction = async (action?: { sessionId: string; toolCallId?: string; agentId?: string }) => {
    onRoute("workbench");
    if (!action) { composerInputRef.current?.focus(); return true; }
    if (!action.toolCallId) return false;
    if (!action.agentId && action.sessionId === computerSessionId) return revealConversationTarget(convoScrollerRef.current, { toolCallId: action.toolCallId });
    const child = action.agentId;
    if (!child) return false;
    openAgentDetail({ agentId: child });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    const host = dock.hosts.get(agentPanelId(agentScope, child));
    return revealConversationTarget(host.element.querySelector<HTMLElement>(".sa-inspect-scroll"), { toolCallId: action.toolCallId });
  };
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
  /* 项目 / 分支 / 执行位置 / 变更统计条只属于「新对话且还没发送」的界面；
     已开始的对话整条不显示（项目与分支在顶栏里）。 */
  const showContextStrip = isNewConversation && !composerSubmitted;
  const hideNewConversationRail = showContextStrip && !dock.newConversationRailOpened;
  useLayoutEffect(() => {
    dock.setNewConversation(showContextStrip);
  }, [dock.setNewConversation, showContextStrip]);
  useLayoutEffect(() => () => dock.setNewConversation(false), [dock.setNewConversation]);
  const showWelcome = shouldShowConversationWelcome(welcomeGate);
  /* 在屏面的欢迎态：由 ConversationPane 上报（leaving 期间保留旧屏）。壳层布局类
     跟它走，避免切换瞬间 minimap 占宽把还在淡出的欢迎页向左顶。 */
  const [surfaceWelcome, setSurfaceWelcome] = useState(showWelcome);
  const readingColumnRef = useRef<HTMLDivElement>(null);
  const bottomRevealRef = useRef<HTMLButtonElement>(null);
  const conversationWorkspace = useConversationWorkspace();
  const conversationWidth = useConversationWidth();
  useReadingColumn(readingColumnRef, conversationWidth, surfaceWelcome);
  useBottomToggleClearance(readingColumnRef, bottomRevealRef, !mdi || mdi.active, conversationWorkspace?.slots.bottomReveal);
  const [jumpPill, setJumpPill] = useState<{ visible: boolean; jumpToLatest: () => void } | undefined>(undefined);
  const jumpPillRef = useRef<{ visible: boolean; jumpToLatest: () => void } | undefined>(undefined);
  const jumpToLatestSlot = useCallback((slot: { visible: boolean; jumpToLatest: () => void }) => {
    const previous = jumpPillRef.current;
    if (previous !== undefined && previous.visible === slot.visible && previous.jumpToLatest === slot.jumpToLatest) return;
    jumpPillRef.current = slot;
    setJumpPill(slot);
  }, []);
  const taskProgress = useMemo(() => {
    if (preview) {
      if (isNewConversation) return { todos: [], files: [] };
      return { todos: getPreviewTodos(zh), files: PREVIEW_TODO_FILES };
    }
    return sessionTaskProgress(convo.rows);
  }, [convo.rows, isNewConversation, preview, preview ? zh : false]);
  const testRuns = useMemo(() => preview ? [] : projectAgentTestRuns(convo.rows), [convo.rows, preview]);
  const activeWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
  const gitWorkspaceId = preview ? undefined : activeWorkspace?.workspaceId;
  const realGit = useGitRepository(client, gitWorkspaceId);
  const activePreviewProject = preview ? findPreviewProject(previewProjectId ?? "", zh) : undefined;
  const gitScope = `${preview ? "preview" : "real"}:${executionTarget.id ?? "local"}:${preview ? previewProjectId ?? "none" : activeWorkspace?.workspaceId ?? "none"}`;
  const gitSharedWorkspaceId = preview ? `preview-${previewProjectId ?? "none"}` as WorkspaceId : activeWorkspace?.workspaceId;
  const contextProjectName = preview
    ? (previewCreatedProject?.name ?? activePreviewProject?.name ?? (zh ? "未选择项目" : "No project selected"))
    : (activeWorkspace?.name ?? (zh ? "未选择项目" : "No project selected"));
  const normalizedProjectQuery = contextProjectQuery.trim().toLocaleLowerCase();
  const previewProjectOptions = getPreviewProjects(zh).filter((project) => project.name.toLocaleLowerCase().includes(normalizedProjectQuery));
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
      setPreviewCreatedProject({ id: `preview-created-${Date.now()}`, name: name || (marks ? (zh ? "演示新项目" : "Demo new project") : (zh ? "新项目" : "New project")) });
      setCreateProjectOpen(false);
      return;
    }
    if (!preview && executionTarget.id) { setCreateProjectOpen(false); executionTarget.openDirectory(); return; }
    setCreateProjectBusy(true);
    try {
      const handle = await client.command("workspace.pick", name ? { name } : {});
      const model = await waitReceipt<WorkspaceListReadModel>(client, handle.requestId, null);
      const active = model.workspaces.find((workspace) => workspace.active);
      if (!active) throw new Error(zhRef.current ? "选择的文件夹未注册为项目" : "The selected folder is not registered as a project");
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
      setCreateProjectError(hostErrorMessage(error, zhRef.current ? "创建项目失败" : "Failed to create project"));
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
  // A cold start/new session remounts the conversation engine while the prompt
  // is in flight. Re-attach the same local row to the new engine; the store
  // reconciles it immediately if the authoritative user item already arrived.
  useEffect(() => {
    const optimistic = optimisticPromptRef.current;
    if (optimistic === undefined) return;
    convoRef.current.trackPending(optimistic.pending);
  }, [convo.engine, optimisticPrompt?.pending.requestId]);
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
        setComposerError(zhRef.current ? `权限模式仅同步到部分 Runtime（${result.failedSessions ?? 0} 个失败），请稍后重试。` : `Permission mode synced to only some Runtimes (${result.failedSessions ?? 0} failed); please try again later.`);
        return false;
      }
      setComposerError(undefined);
      return true;
    } catch (error) {
      const message = hostErrorMessage(error, zhRef.current ? "操作失败" : "Operation failed");
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
  const nativePlanEnabled = !preview && runtimeConnected && can("mode.plan.review.details") && can("mode.plan.review.resolve");
  const planExecution = useNativePlanReview(client, snapshot?.sessionId, nativePlanEnabled, snapshot?.plan?.status === "review", snapshot?.stateVersion);
  const submitPlanDecision = useCallback((decision: "execute" | "compact" | "keep" | "refine" | "dismiss", feedback?: string): Promise<boolean> => {
    if (!nativePlanEnabled) return run("mode.plan.review.respond", { decision, ...(feedback ? { feedback } : {}) });
    const reviewId = planExecution.details?.reviewId;
    if (!snapshot?.sessionId || !reviewId || !planExecution.details?.available || planExecution.loading) {
      setStatusToast(planExecution.error || (zhRef.current ? "计划评审已变化，请稍后重试" : "Plan review changed; please try again shortly"));
      return Promise.resolve(false);
    }
    return run("mode.plan.review.resolve", { sessionId: snapshot.sessionId, reviewId, decision,
      ...(["execute", "compact", "keep"].includes(decision) && planExecution.role ? { role: planExecution.role } : {}),
      ...(feedback ? { feedback } : {}) });
  }, [nativePlanEnabled, planExecution.details, planExecution.role, planExecution.loading, planExecution.error, snapshot?.sessionId, run]);
  const respondPlanReview = useCallback(async (id: PlanActionId, detail?: PlanActionDetail): Promise<boolean> => {
    if (id === "refine") {
      const feedback = detail?.feedback?.trim();
      if (feedback) {
        return submitPlanDecision("refine", feedback);
      }
      const ok = await submitPlanDecision("dismiss");
      if (ok) {
        setStatusToast(zhRef.current ? "请在输入框写下修改意见" : "Write your requested changes in the input box");
        queueMicrotask(() => composerInputRef.current?.focus());
      }
      return ok;
    }
    if (id === "dismiss") {
      const ok = await submitPlanDecision("dismiss");
      if (ok) queueMicrotask(() => composerInputRef.current?.focus());
      return ok;
    }
    // 「压缩后执行」与顶栏「压缩」按钮共用同一套反馈：渲染端主动点亮
    // 「压缩中」行，压缩完成、执行提交（收到回执）后再熄灭——快照的
    // isCompacting 推送在 Plan 审批路径上不保证及时可见（尤其 snapcompact）。
    const compacting = id === "compact";
    if (compacting) onCompactPending?.(true);
    try {
      return await submitPlanDecision(id);
    } finally {
      if (compacting) onCompactPending?.(false);
    }
  }, [onCompactPending, submitPlanDecision]);
  /** 收集「保存并退出」的目标路径：桌面端经白名单 IPC 走 Main 的原生另存为
      对话框（默认 `<工作区>/PLAN.md`，返回工作区相对路径）；浏览器 dev /
      测试环境回退 window.prompt。Electron 渲染进程不支持 prompt，旧 preload
      没有新通道时保持静默失败而不是抛错。取消 / 空输入 / 工作区外 → null，
      不发起保存。 */
  const pickPlanSaveTarget = useCallback(async (): Promise<string | null> => {
    if (executionTarget.id) {
      setRemotePlanPath("PLAN.md");
      return new Promise(resolve => setRemotePlanSave({ resolve }));
    }
    const chrome = globalThis.ompStudioChrome;
    if (chrome?.pickPlanSavePath !== undefined) {
      if (activeWorkspace === undefined) {
        setStatusToast(zhRef.current ? "没有可用的本地项目，无法选择保存位置" : "No local project is available to choose a save location");
        return null;
      }
      const picked = await chrome.pickPlanSavePath({ workspaceId: activeWorkspace.workspaceId });
      if (picked.status === "cancelled") return null;
      if (picked.status === "outside-workspace") {
        setStatusToast(zhRef.current ? `保存位置在工作区外（${picked.fileName}），已取消保存` : `Save location is outside the workspace (${picked.fileName}); save cancelled`);
        return null;
      }
      return picked.relativePath;
    }
    try {
      const raw = window.prompt(zhRef.current ? "请输入相对于工作区的 PLAN.md 路径：" : "Enter a PLAN.md path relative to the workspace:", "PLAN.md");
      const normalized = raw?.trim();
      if (normalized) return normalized;
    } catch {
      /* Electron 不支持 window.prompt（electron/electron#472）。 */
    }
    return null;
  }, [activeWorkspace, executionTarget.id]);
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
      setStatusToast(planSaveAndQuitNotice(result, selected, zhRef.current));
    } catch (error) {
      setStatusToast(hostErrorMessage(error, zhRef.current ? "保存计划并退出失败" : "Failed to save plan and quit"));
    } finally {
      planSaveBusyRef.current = false;
      setPlanSaveBusy(false);
    }
  }, [can, client, onBranchedSession, onSessionTitleMaybeChanged, pickPlanSaveTarget]);
  const commandRows = useMemo(() => Object.values(commands).slice(-20).reverse(), [commands]);
  // The bottom dock's two ledgers read demo fixtures while preview is on, so a
  // reviewer sees the real row types, counts and statuses without a Runtime.
  const ledgerCommands = useMemo<readonly LedgerCommandRow[]>(
    () => preview ? PREVIEW_LEDGER_COMMANDS : commandRows.map(toLedgerCommand),
    [preview, commandRows],
  );
  const ledgerEvents: readonly ShellEventLogEntry[] = preview ? PREVIEW_SHELL_EVENTS : state.events;
  const snapshotReady = snapshot !== undefined;
  // A fresh-draft surface (`selectedSessionId === undefined`) does not own the
  // Runtime snapshot until its own `session.create` lands: until then the
  // snapshot still describes the session the operator just left, so it must not
  // lend that session's streaming state, queue, approval mode, or prompt target
  // to this surface. `composerOwner` is the same truth in session-id form and is
  // the only fallback drafts/queue rows/active-row marks may use.
  // Preview is a display-layer story (its t1 run has no real session.create) and
  // keeps the old verdict; its queue is a local fixture, never a Host write.
  const composerTarget = { selectedSessionId, sessionCreating, liveSessionId: snapshot?.sessionId };
  const composerOwner = composerOwnerSessionId(composerTarget) as SessionId | undefined;
  useEffect(() => {
    if (!workbenchVisible || !composerInsertion || composerInsertion.owner !== composerOwner || !composerInputRef.current) return;
    const current = composerInputRef.current.getSnapshot();
    const addition = (current.doc.nodes.length ? "\n\n" : "") + composerInsertion.text;
    replaceDraft(snapshotFromDoc({ nodes: [...current.doc.nodes, { type: "text", value: addition }] }));
    composerInputRef.current.focus();
    onComposerInsertionApplied?.();
  }, [composerInsertion, composerOwner, onComposerInsertionApplied, workbenchVisible]);
  const snapshotIsViewedSession = preview || composerOwnsLiveSnapshot(composerTarget);
  const executionMatches = snapshotIsViewedSession;
  const [worktreeGated, setWorktreeGated] = useState(false);
  const worktreeWait = useRef<{ promise: Promise<void>; resolve(): void } | undefined>(undefined);
  const changeWorktreeGate = useCallback((blocked: boolean) => {
    setWorktreeGated(blocked);
    if (blocked && !worktreeWait.current) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      worktreeWait.current = { promise, resolve };
    } else if (!blocked) {
      worktreeWait.current?.resolve(); worktreeWait.current = undefined;
    }
  }, []);

  const gated = worktreeGated || busy || Boolean(connection?.resyncRequired) || !runtimeConnected || !snapshotReady || !executionMatches;
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
  const previewDeckActive = preview === true && previewThreadId === "t3" && previewDeckKind !== null;
  const previewPlanActive = previewDeckActive && previewDeckKind === "plan";
  // `planReview` 是 `snapshot.plan`，每次 operator 状态更新都是新对象，所以直接
  // 依赖它会在整个评审期间每帧往 state 写一个全新对象，React 永远无法 bail out。
  // 按内容签名依赖，值真的变了才写；对象本身从 ref 读，不参与依赖比较。
  const planReviewRef = useRef(planReview);
  planReviewRef.current = planReview;
  const planReviewContentKey = planReview === undefined
    ? ""
    : `${planReview.title ?? "Plan"}|${planReview.body ?? ""}`;
  useEffect(() => {
    if (planReviewContentKey === "") return;
    const current = planReviewRef.current;
    if (current === undefined) return;
    setRememberedPlan({ title: current.title ?? "Plan", body: current.body ?? "" });
  }, [planReviewContentKey]);
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
  const previewPlanTitle = useMemo(() => getPreviewDeckItems(zh).find((item) => item.kind === "plan")?.title ?? "Plan", [zh]);
  const planLink = useMemo(
    () => ({
      onOpen: openPlanFromConversation,
      ...(planReview?.title
        ? { title: planReview.title }
        : previewPlanActive
          ? { title: previewPlanTitle }
          : {}),
      ...(previewPlanActive ? { demo: true as const } : {}),
      ...((planReview !== undefined || previewPlanActive) ? { attachEvenWithoutPropose: true as const } : {}),
    }),
    [openPlanFromConversation, planReview, previewPlanActive, previewPlanTitle],
  );
  const textReady = !snapshotIsEmpty(draft);
  const conversationLive = executionMatches && (
    hasLiveActivityProgress(convo.state) ||
    Object.keys(convo.state.liveMessages).length > 0 ||
    Object.keys(convo.state.liveTools).length > 0 ||
    Object.keys(convo.state.openTurnItems).length > 0
  );
  // Live conversation state leads the snapshot at the start of a run, but it is
  // NOT allowed to outlive the Runtime's own idle verdict: a turn whose close
  // event never arrives would otherwise pin `working` forever. See
  // `reduceRunStreaming`. Queued messages count as Runtime work in flight — a
  // follow-up drain briefly reports `isStreaming: false` between the two turns,
  // and every other surface here already reads a non-empty queue as "not idle".
  const runStreaming = useRunStreaming({
    identityKey: convo.identityKey,
    runtimeStreaming: executionMatches && (Boolean(snapshot?.isStreaming) || (snapshot?.pendingMessages ?? 0) > 0),
    conversationLive,
  });
  const sessionStreaming = runStreaming.streaming;
  useEffect(() => {
    if (optimisticPrompt?.phase !== "initiating") return;
    const pendingStillVisible = convo.state.pendingUsers.some(
      (entry) => entry.requestId === optimisticPrompt.pending.requestId,
    );
    if (pendingStillVisible) return;
    // `isStreaming` flips before the first authoritative conversation item,
    // so it is too early to drop the transport phase there. Keep Initiating
    // until the optimistic user row is actually reconciled by the store.
    setOptimisticPrompt((current) => current?.pending.requestId === optimisticPrompt.pending.requestId
      ? undefined
      : current);
  }, [convo.state.pendingUsers, optimisticPrompt]);
  const pendingPrompt = convo.state.pendingUsers.some((entry) => entry.status === "pending");
  const promptFailed = convo.state.pendingUsers.some((entry) => entry.status === "failed") && !pendingPrompt;
  // Bumped on an accepted `core.abort`. Both run latches need it: neither can
  // rely on a streaming falling edge that a Runtime already idle will never emit.
  const [abortGeneration, setAbortGeneration] = useState(0);
  useEffect(() => {
    setAbortGeneration(0);
  }, [convo.identityKey]);
  const awaitingTurn = useAwaitingTurn({
    sending,
    pending: pendingPrompt,
    streaming: sessionStreaming,
    failed: promptFailed,
    identityKey: convo.identityKey,
    cancelGeneration: abortGeneration,
  });
  const activityRetry = useActivityRetry({
    notices: convo.state.notices,
    ...(!preview && executionMatches && snapshot?.retry !== undefined ? { runtimeRetry: snapshot.retry } : {}),
    streaming: sessionStreaming,
    failed: promptFailed,
    identityKey: convo.identityKey,
    cancelGeneration: abortGeneration,
  });
  // Reconcile a turn the client still holds open once the Runtime reports idle —
  // either because it just settled this run, or because the operator pressed stop
  // (which on an already-idle Runtime is a no-op that emits nothing). The
  // `turn.completed` / `turn.aborted` that would have closed it is never coming.
  // Only inert residue is settled: a still-running tool or an open live block
  // means events are in flight, and a mid-run idle snapshot must not abort them.
  // Idempotent: a no-op as soon as the store has nothing open.
  useEffect(() => {
    if (!executionMatches || snapshot?.isStreaming !== false) return;
    // OMP 18.12: the run ended only to wait for background jobs; their result resumes it.
    if (snapshot?.awaitingAsyncWork === true) return;
    if (!runStreaming.settled && abortGeneration === 0) return;
    if (hasLiveActivityProgress(convoRef.current.state)) return;
    convoRef.current.settleOpenTurns();
  }, [abortGeneration, executionMatches, runStreaming.settled, snapshot?.isStreaming, snapshot?.awaitingAsyncWork]);
  // Composer / abort / queue flush are write surfaces: follow the live Runtime,
  // including the send → isStreaming snapshot gap. Preview must not replace this
  // with the t1 demo story or the stop button appears while core.abort stays gated.
  const retrying = executionMatches && activityRetry !== undefined;
  const running = sessionStreaming || optimisticPrompt !== undefined || (executionMatches && awaitingTurn) || retrying;
  // Enter / the send button only queue locally while the conversation on screen
  // is the one streaming. On a fresh-draft surface whose `session.create` is
  // still in flight this is false even though the live session streams, so the
  // draft goes through dispatchPrompt and waits for its own session instead of
  // being filed against the session the operator just left. Preview keeps its
  // fixture story (the local demo queue is not a Host target).
  const composerRunning = preview ? running : composerRunningForTarget({ ...composerTarget, running });
  const composerLightState = pendingInteraction !== null || planReview !== undefined || previewDeckActive
    ? "waiting"
    : composerRunning ? "running" : "idle";
  // Title freezes on the first accepted prompt; later drafts never override it.
  const provisionalTitle = submittedPromptTitle ?? provisionalThreadTitle(draft.text);
  useEffect(() => {
    const visible = textReady || provisionalTitle !== undefined || running;
    onProvisionalSessionChange?.({
      ...(composerOwner === undefined ? {} : { sessionId: composerOwner }),
      ...(workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId }),
      visible,
      ...(provisionalTitle === undefined ? {} : { title: provisionalTitle }),
      running,
      submitted: submittedPromptTitle !== undefined || running,
    });
  }, [onProvisionalSessionChange, provisionalTitle, running, composerOwner, submittedPromptTitle, textReady, workspaceId]);
  useEffect(() => {
    if (preview || !snapshot || !composerOwner || executionTarget.id) return;
    conversationViewLeases.setOwnerKnown();
    const blocked = !snapshotIsEmpty(draft) || sending || optimisticPrompt !== undefined || queuedMessages.length > 0 || pendingInteraction !== undefined || worktreeGated;
    return blocked ? conversationViewLeases.block(Number(snapshot.runtimeEpoch), composerOwner) : undefined;
  }, [preview, snapshot?.runtimeEpoch, composerOwner, draft, sending, optimisticPrompt, queuedMessages.length, pendingInteraction, worktreeGated, executionTarget.id]);
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
      ? (previewThreadId === "t1" ? getPreviewRunActivity(zh).status : null)
      : snapshot?.pause?.paused
        ? { phase: "waiting" as const, label: snapshot.pause.unsettledTurns || snapshot.pause.unfinishedJobs ? (zh ? `暂停收尾 / Draining · ${snapshot.pause.unsettledTurns ?? 0} turns · ${snapshot.pause.unfinishedJobs ?? 0} jobs` : `Draining · ${snapshot.pause.unsettledTurns ?? 0} turns · ${snapshot.pause.unfinishedJobs ?? 0} jobs`) : (zh ? "已停稳 / Safely paused" : "Safely paused") }
      : optimisticPrompt !== undefined
        ? { phase: "waiting" as const, label: PROMPT_SEND_PHASE_LABEL[optimisticPrompt.phase] }
        : executionMatches && snapshot?.awaitingAsyncWork === true && !sessionStreaming
          ? { phase: "waiting" as const, label: zh ? "等待后台任务 / Waiting for background jobs" : "Waiting for background jobs" }
          : deriveActivityStatus({
          state: convo.state,
          streaming: sessionStreaming,
          pendingMessages: snapshot?.pendingMessages ?? 0,
          awaiting: executionMatches && awaitingTurn,
          zh,
          ...(activityRetry === undefined ? {} : { retry: activityRetry }),
        })),
    [activityRetry, awaitingTurn, convo.state, executionMatches, optimisticPrompt, preview, previewThreadId, sessionStreaming, snapshot?.pendingMessages, snapshot?.awaitingAsyncWork, snapshot?.pause, zh],
  );
  const runWindowKey = preview ? `preview:${previewThreadId ?? ""}` : convo.identityKey;
  const runWindow = useRunWindow(activityStatus !== null, runWindowKey);
  const activity = activityStatus === null
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
    if (composerRunning) {
      if (hasStatusCapsules || hasDraftContent) {
        setComposerExpanded(true);
      } else {
        setComposerExpanded(false);
      }
    }
  }, [composerRunning]);
  useEffect(() => {
    if (hasStatusCapsules) {
      setComposerExpanded(true);
    }
  }, [hasStatusCapsules]);
  useLayoutEffect(() => {
    if (composerRunning && !composerExpanded) {
      document.getElementById("composerInput")?.scrollTo({ top: 0 });
    }
  }, [composerExpanded, composerRunning]);
  const { contextBranchMenuOpen, setContextBranchMenuOpen, branchListState, branchSwitchName, branchNotice, pendingBranchAction, createBranchOpen, setCreateBranchOpen, createBranchName, setCreateBranchName, createBranchBusy, createBranchError, switchBlock, switchCommitMessage, setSwitchCommitMessage, switchCommitBusy, switchCommitError, loadBranches, openCreateBranch, localBranches, remoteBranches, branchActionDeferred, requestBranchSwitch, createBranch, cancelSwitchBlock, submitSwitchCommit } = useWorkbenchBranches({ client, gitWorkspaceId, realGit, preview, running, interactionPending: pendingInteraction !== null });
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
  const executionStatus = executionTarget.inventory.statuses.find(value => value.id === executionTarget.id);
  const targetOffline = !preview && executionTarget.id !== null && (executionStatus?.state !== "connected" || Boolean(executionStatus.operation));
  const canPrepareModel = !preview && !targetOffline && !worktreeGated && !connection?.resyncRequired
    && runtime?.classification !== "limited-system" && workspaceId !== undefined
    && (!runtimeConnected || !executionMatches);
  const runModelPreference = async <T extends CommandName>(name: T, input: CommandInput<T>): Promise<boolean> => {
    const expected = selectedTargetRef.current;
    let createdSessionId: SessionId | undefined;
    try {
      if (!runtimeConnected || !executionMatches) {
        const model = name === "session.model.set" ? (input as CommandInput<"session.model.set">).selector : undefined;
        if (expected.selectedSessionId === undefined) {
          ensureNewSession?.(model);
          const ready = await waitForNewSession?.();
          if (ready && !ready.ok) throw new Error(ready.error);
          createdSessionId = ready?.sessionId;
        } else {
          await ensureSelectedSessionActive(client, {
            ...(snapshot?.sessionId === undefined ? {} : { activeSessionId: snapshot.sessionId }),
            selectedSessionId: expected.selectedSessionId as SessionId,
            ...(expected.selectedThreadId === undefined ? {} : { selectedThreadId: expected.selectedThreadId }),
            ...(model === undefined ? {} : { model }),
          });
        }
        const manifest = await client.query("capabilities.get", {});
        if (!manifest.capabilities.some(entry => entry.id === name && entry.grade !== "unavailable")) {
          throw new Error(t("composer.runtimeNotExposedModelSet"));
        }
      }
      if (promptTargetChanged({ sent: expected, current: selectedTargetRef.current, createdSessionId })) {
        throw new Error(zhRef.current ? "模型选择期间已切换会话，本次选择已取消。" : "Session switched while selecting model; selection cancelled.");
      }
      return await run(name, input);
    } catch (error) {
      setComposerError(hostErrorMessage(error, zhRef.current ? "模型选择失败" : "Failed to select model"));
      return false;
    }
  };
  const promptChannelReady =
    !targetOffline &&
    !busy &&
    !connection?.resyncRequired &&
    !sending &&
    sessionCreating !== true &&
    promptTargetReady &&
    (can("core.prompt") || (!!mdi && !runtimeConnected && selectedSessionId !== undefined && selectedThreadId !== undefined));
  const promptEnabled = composerPromptEnabled({
    textReady,
    sending,
    running: composerRunning,
    pendingInteraction: pendingInteraction !== null,
    promptChannelReady,
    sessionCreating,
    newConversation: !preview && isNewConversation,
  });
  const slashExecuteReady = composerSlashExecute(draft, slashCatalog) !== undefined;
  const testRerunDisabled = !promptChannelReady || running || pendingInteraction !== null;
  const testRerunTitle = running
    ? (zh ? "进行中" : "In progress")
    : pendingInteraction !== null
      ? (zh ? "先处理询问" : "Resolve prompt first")
      : promptChannelReady
        ? (zh ? "重跑" : "Rerun")
        : (zh ? "未就绪" : "Not ready");
  // 流式期间 Enter 不再禁用：消息进本地排队栏，本轮结束后自动发送。
  // 想纠偏就在排队栏里点「插入纠偏」，走 core.steer 打断当前回合。
  const queueEnabled = composerQueueEnabled({ textReady, running: composerRunning, promptChannelReady });
  const followUpChannelReady =
    !targetOffline &&
    !busy &&
    !connection?.resyncRequired &&
    !sending &&
    sessionCreating !== true &&
    promptTargetReady &&
    can("core.followUp");
  const followUpEnabled = composerFollowUpEnabled({
    textReady,
    running: composerRunning,
    pendingInteraction: pendingInteraction !== null,
    followUpChannelReady,
  });
  const steerNowEnabled =
    !targetOffline && !sending && sessionCreating !== true && promptTargetReady && !connection?.resyncRequired && can("core.steer");
  const restorePending = (requestId: string) => {
    const pending = convo.state.pendingUsers.find((entry) => entry.requestId === requestId);
    if (!pending) return;
    const restored = pending.doc !== undefined ? snapshotFromDoc(pending.doc) : snapshotFromText(pending.draft);
    replaceDraft(restored);
    setComposerError(undefined);
    convo.dropPending(requestId);
  };
  const applyComposerFill = (fill: UserMessageEditorFill) => {
    const restored = snapshotFromTextAndImages(fill.text ?? "", fill.images);
    replaceDraft(restored);
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
      setComposerError(zhRef.current ? "当前历史会话缺少 sessionId，无法安全执行会话树操作。" : "The current historical session is missing sessionId, so session tree operations cannot safely proceed.");
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
        throw { code: "STATE_VERSION_CONFLICT", message: zhRef.current ? "操作期间已切换会话，本次操作已取消。" : "Session switched during the operation; operation cancelled." };
      }
      if (needsResume) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const handle = await client.command(name, { targetId });
      const outcome = await waitReceipt<SessionTreeCommandOutcome>(client, handle.requestId);
      setComposerError(undefined);
      return outcome;
    } catch (error) {
      const message = hostErrorMessage(error, name === "session.tree.branch" ? (zhRef.current ? "新建会话失败" : "Failed to branch session") : (zhRef.current ? "恢复失败" : "Failed to restore"));
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
  // Runtime 18.20.2 branches while a turn streams: the new session starts from the
  // chosen message and the running turn keeps going in the original session.
  const userBranchDisabledReason = userMessageRestoreDisabledReason({
    preview,
    running: retrying,
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
  // 「重试上一轮」：与 restore/branch 同一套门控习惯；busy 置位让按钮在回执
  // 落地前立即禁用（Runtime 的 retry() 是排程即返回，isStreaming 翻转有间隙）。
  const retryTurnDisabledReason = (() => {
    if (sessionCreating === true) return zh ? "创建中" : "Creating";
    if (Boolean(connection?.resyncRequired) || convo.state.resyncRequired) return zh ? "同步中" : "Syncing";
    if (busy) return zh ? "进行中" : "In progress";
    if (running) return zh ? "进行中" : "In progress";
    if (snapshot?.isCompacting === true) return zh ? "压缩中" : "Compacting";
    if (!preview && (!runtimeConnected || !snapshotReady)) return zh ? "未连接" : "Disconnected";
    if (!executionMatches) return zh ? "无法操作" : "Unavailable";
    if (!preview && !can("turn.retry")) return zh ? "当前 Runtime 不支持重试" : "Current Runtime does not support retry";
    return undefined;
  })();
  const retryLastTurn = () => {
    if (preview || retryTurnDisabledReason !== undefined) return;
    setBusy(true);
    client
      .command("turn.retry", {})
      .then((handle) =>
        waitReceipt<{ readonly retried: boolean; readonly reason?: "nothing_to_retry" }>(client, handle.requestId),
      )
      .then((result) => {
        if (result.retried === true) {
          setComposerError(undefined);
          return;
        }
        setStatusToast(result.reason === "nothing_to_retry" ? (zhRef.current ? "没有可重试的上一轮" : "No previous turn to retry") : (zhRef.current ? "未重试" : "Not retried"));
      })
      .catch((error: unknown) => {
        setComposerError(hostErrorMessage(error, zhRef.current ? "重试上一轮失败" : "Failed to retry last turn"));
      })
      .finally(() => setBusy(false));
  };
  // 「继续」：会话停在「没有最终汇报」的尾巴上、输入框又为空时，发送位换成播放键。
  // 判定分两层：可见性看尾行/快照，可用性直接复用 retryTurnDisabledReason（九项门禁），
  // 预览下按 fixture 的暂停线程走演示分支。`core.continue` 只在能持续时出现，
  // 旧 Runtime 上没有该能力就退回 turn.retry 的重跑语义。
  const continueInterrupted = preview
    ? previewTailInterrupted(previewThreadId)
    : snapshot?.lastTurnOutcome === "interrupted"
      || convo.state.lastTurnInterrupted
      || tailInterrupted(convo.rows);
  const continueSlot =
    continueInterrupted
    && !textReady
    && !composerRunning
    && queueEdit === undefined
    && pendingInteraction === null;
  const continueEnabled = preview ? true : retryTurnDisabledReason === undefined;
  const continueTurn = () => {
    if (!continueEnabled) return;
    if (preview) {
      if (marks) setStatusToast(zhRef.current ? "预览模式：继续仅演示，不会调用 Runtime" : "Preview mode: Continue is demo-only and does not invoke Runtime");
      return;
    }
    if (!can("core.continue")) {
      retryLastTurn();
      return;
    }
    setBusy(true);
    client
      .command("core.continue", {})
      .then((handle) => waitReceipt<ContinueTurnOutcome>(client, handle.requestId))
      .then((result) => {
        if (result.started === true) {
          setComposerError(undefined);
          return;
        }
        setStatusToast(result.mode === "none" ? (zhRef.current ? "没有可继续的上一轮" : "No previous turn to continue") : (zhRef.current ? "未继续" : "Not continued"));
      })
      .catch((error: unknown) => {
        setComposerError(hostErrorMessage(error, t("composer.continueUnavailable")));
      })
      .finally(() => setBusy(false));
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
      onPreviewDone: () => { if (marks) setStatusToast(zhRef.current ? "演示：已从这条消息新建会话（未调用 Host）" : "Demo: branched a new session from this message (Host not called)"); },
    });
  };
  const promptInputOf = (payload: ComposerSnapshot): { text: string; images?: PromptImageInput[] } => {
    const text = injectMagicKeyword(payload.text.trim(), magicKeyword);
    return payload.images.length === 0 ? { text } : { text, images: [...payload.images] };
  };
  const prepareDictationSession = async (signal: AbortSignal): Promise<string> => {
    const expected = selectedTargetRef.current;
    signal.throwIfAborted();
    if (executionTarget.id) throw new Error(zhRef.current ? "远程工作区暂不支持本机听写 / Local dictation is unavailable for remote workspaces" : "Local dictation is unavailable for remote workspaces");
    let readySessionId: SessionId | undefined;
    if (expected.selectedSessionId === undefined) {
      if (!snapshot) ensureNewSession?.();
      const ready = await waitForNewSession?.();
      signal.throwIfAborted();
      if (ready && !ready.ok) throw new Error(ready.error);
      readySessionId = ready?.sessionId;
    }
    if (worktreeWait.current) await worktreeWait.current.promise;
    signal.throwIfAborted();
    const latest = client.getState?.()?.entities.snapshot;
    await ensureSelectedSessionActive(client, {
      ...((readySessionId ?? latest?.sessionId) ? { activeSessionId: (readySessionId ?? latest!.sessionId) as SessionId } : {}),
      ...(expected.selectedSessionId ? { selectedSessionId: expected.selectedSessionId as SessionId } : {}),
      ...(expected.selectedThreadId ? { selectedThreadId: expected.selectedThreadId } : {}),
    });
    signal.throwIfAborted();
    if (selectedTargetRef.current.selectedSessionId !== expected.selectedSessionId || selectedTargetRef.current.selectedThreadId !== expected.selectedThreadId) throw new Error(zhRef.current ? "听写准备期间已切换会话 / The dictation target changed" : "The dictation target changed while preparing dictation");
    const id = expected.selectedSessionId ?? readySessionId ?? client.getState?.()?.entities.snapshot?.sessionId;
    if (!id) throw new Error(zhRef.current ? "没有可用于听写的会话 / No dictation session is ready" : "No dictation session is ready");
    return id;
  };
  // sendPrompt 与排队 flush 共用的发送路径。失败时置 composerError 并返回 false，
  // 草稿恢复方式由调用方决定（输入框草稿回填 vs 排队条目回队）。
  const dispatchPrompt = async (payload: ComposerSnapshot, options?: { readonly asFollowUp?: boolean; readonly waitForReady?: boolean }): Promise<boolean> => {
    if (!promptDispatchGate.tryEnter()) return false;
    const plan = planComposerSend(payload, slashCatalog);
    let outboundPayload = payload;
    let optimisticRequestId: string | undefined;
    let readySessionId: SessionId | undefined;
    const targetSessionId = selectedSessionId as SessionId | undefined;
    const targetThreadId = selectedThreadId;
    setComposerSubmitted(true);
    try {
      if (plan.kind === "execute") {
        if (options?.asFollowUp === true && composerRunning) {
          setComposerError(zhRef.current ? "当前回合进行中，斜杠指令请等结束后再发。" : "A turn is running; wait until it finishes before sending slash commands.");
          return false;
        }
        return await runSlashCommand(plan.command, plan.args, payload.images);
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
      const acceptedPromptTitle = provisionalThreadTitle(outboundPayload.text);
      const rememberSubmittedPrompt = (sessionId: SessionId | undefined) => {
        if (acceptedPromptTitle === undefined) return;
        setSubmittedPrompt((current) =>
          current?.sessionId === sessionId
            ? current
            : {
                ...(sessionId === undefined ? {} : { sessionId }),
                title: acceptedPromptTitle,
              },
        );
      };
      // Freeze the first prompt before the first await. Clearing the composer
      // and entering the transport phases must never expose an Untitled row.
      // The fallback is the composer's own session, never a stale snapshot: on a
      // fresh-draft surface the new prompt belongs to the session being created.
      rememberSubmittedPrompt(targetSessionId ?? composerOwner);
      const resumed = targetSessionId !== undefined && snapshot?.sessionId !== targetSessionId;
      const outbound = promptInputOf(outboundPayload);
      optimisticRequestId = `optimistic:${Date.now()}:${nextOptimisticPromptId++}`;
      const pending: PendingUser = {
        requestId: optimisticRequestId,
        text: outbound.text,
        draft: payload.text,
        status: "pending",
        knownItemIds: convoRef.current.state.items.map((item) => item.itemId),
        doc: outboundPayload.doc,
      };
      const initialPhase: PromptSendPhase = sessionCreating === true || (targetSessionId === undefined && snapshot === undefined) || resumed
        ? "starting"
        : "sending";
      convoRef.current.trackPending(pending);
      setOptimisticPrompt({ pending, phase: initialPhase });
      setSending(true);
      if (options?.waitForReady === true && waitForNewSession !== undefined) {
        const ready = await waitForNewSession();
        if (!ready.ok) throw { code: "SESSION_CREATE_FAILED", message: ready.error };
        readySessionId = ready.sessionId;
        rememberSubmittedPrompt(readySessionId);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (worktreeWait.current) {
        await worktreeWait.current.promise;
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const prepared = client.getState?.()?.entities.snapshot;
        if (prepared?.sessionId !== undefined && targetSessionId === undefined) {
          readySessionId = prepared.sessionId as SessionId;
          rememberSubmittedPrompt(readySessionId);
        }
      }
      await ensureSelectedSessionActive(client, {
        ...((readySessionId ?? snapshot?.sessionId) === undefined ? {} : { activeSessionId: readySessionId ?? snapshot!.sessionId }),
        ...(targetSessionId === undefined ? {} : { selectedSessionId: targetSessionId }),
        ...(targetThreadId === undefined ? {} : { selectedThreadId: targetThreadId }),
      });
      if (promptTargetChanged({
        sent: { selectedSessionId: targetSessionId, selectedThreadId: targetThreadId },
        current: selectedTargetRef.current,
        createdSessionId: readySessionId ?? (targetSessionId === undefined ? snapshot?.sessionId : undefined),
      })) {
        throw { code: "STATE_VERSION_CONFLICT", message: zhRef.current ? "发送期间已切换会话，本次发送已取消，草稿已恢复。" : "Session switched while sending; send cancelled and draft restored." };
      }
      if (resumed) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      setOptimisticPrompt((current) => current !== undefined && current.pending.requestId === optimisticRequestId
        ? { pending: current.pending, phase: "sending" }
        : current);
      const commandName = options?.asFollowUp === true || plan.kind === "follow-up" ? "core.followUp" : "core.prompt";
      const handle = await client.command(commandName, outbound);
      setOptimisticPrompt((current) => current !== undefined && current.pending.requestId === optimisticRequestId
        ? { pending: current.pending, phase: "initiating" }
        : current);
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
          convoRef.current.failPending(optimisticRequestId!, receipt.error.message);
          setOptimisticPrompt(undefined);
          return;
        }
        convoRef.current.failPending(optimisticRequestId!, receipt.reason);
        setOptimisticPrompt(undefined);
      };
      promptUnsub.current = client.onState
        ? client.onState(() => watchReceipt())
        : client.subscribe({ scope: "command", requestId: handle.requestId }, () => watchReceipt());
      watchReceipt();
      if (!preview) onSessionTitleMaybeChanged?.();
      return true;
    } catch (error) {
      const message = hostErrorMessage(error, zhRef.current ? "发送失败" : "Send failed");
      setComposerError(message);
      if (optimisticRequestId !== undefined) convoRef.current.failPending(optimisticRequestId, message);
      setOptimisticPrompt(undefined);
      return false;
    } finally {
      promptDispatchGate.leave();
      setSending(false);
    }
  };
  const sendPrompt = async () => {
    // A pending create has no queue owner yet. Keep the second draft in the
    // editor until the first dispatch completes, including same-frame Enter.
    if (promptDispatchGate.busy && !composerRunning) return;
    if (await composerInputRef.current?.waitForAttachments?.() === false) return;
    const payload = composerInputRef.current?.getSnapshot() ?? draftLive.current;
    // OMP 18.11: typing while a tool approval waits denies that call and steers the turn.
    if (
      composerRunning &&
      pendingInteraction?.kind === "approval" &&
      steerNowEnabled &&
      !snapshotIsEmpty(payload) &&
      composerSlashExecute(payload, slashCatalog) === undefined
    ) {
      void steerPastApproval(payload);
      return;
    }
    if (composerRunning && composerSlashExecute(payload, slashCatalog) === undefined) {
      enqueueDraft();
      return;
    }
    const ready = composerPromptEnabled({ textReady: !snapshotIsEmpty(payload), sending, running: composerRunning, pendingInteraction: pendingInteraction !== null, promptChannelReady, sessionCreating, newConversation: !preview && isNewConversation });
    if (!ready && composerSlashExecute(payload, slashCatalog) === undefined) return;
    setComposerError(undefined);
    replaceDraft(emptySnapshot());
    if (!preview && selectedSessionId === undefined && snapshot === undefined) {
      ensureNewSession?.();
    }
    if (!(await dispatchPrompt(payload, { waitForReady: waitForNewSession !== undefined }))) {
      replaceDraft(payload);
    }
  };
  const steerPastApproval = async (payload: ComposerSnapshot) => {
    if (sending) return;
    setComposerError(undefined);
    replaceDraft(emptySnapshot());
    setSending(true);
    try {
      if (!(await respond("cancel"))) throw new Error(zhRef.current ? "拒绝审批失败 / Could not deny the approval" : "Could not deny the approval");
      const outbound = promptInputOf(payload);
      const handle = await client.command("core.steer", outbound);
      convoRef.current.trackPending({
        requestId: handle.requestId,
        text: outbound.text,
        draft: payload.text,
        status: "pending",
        knownItemIds: convoRef.current.state.items.map((item) => item.itemId),
        doc: payload.doc,
      });
      await waitReceipt(client, handle.requestId);
    } catch (error) {
      replaceDraft(payload);
      setComposerError(hostErrorMessage(error, zhRef.current ? "纠偏失败" : "Steer failed"));
    } finally {
      setSending(false);
    }
  };
  const sendFollowUp = async () => {
    if (!followUpEnabled || promptDispatchGate.busy) return;
    setComposerError(undefined);
    const payload = composerInputRef.current?.getSnapshot() ?? draftLive.current;
    replaceDraft(emptySnapshot());
    if (!(await dispatchPrompt(payload, { asFollowUp: true }))) {
      replaceDraft(payload);
    }
  };
  const takeComposerSnapshot = (): ComposerSnapshot => composerInputRef.current?.getSnapshot() ?? draftLive.current;
  const queueEntryOf = (payload: ComposerSnapshot, id: number): QueuedMessage => {
    const ownerSessionId = composerOwner;
    return {
      id,
      text: payload.text,
      ...(payload.images.length > 0 ? { images: payload.images } : {}),
      doc: payload.doc,
      ...(ownerSessionId === undefined ? {} : { sessionId: ownerSessionId }),
    };
  };
  const snapshotOfEntry = (entry: QueuedMessage): ComposerSnapshot => snapshotOfQueued(entry);
  const activeQueue = (): QueuedMessage[] => (preview ? previewQueue : queuedMessages);
  /** 排队栏当前要显示的条目（本会话的本地草稿；预览时为演示队列）。 */
  const sessionQueue = preview ? previewQueue : visibleQueuedMessages(queuedMessages, composerOwner);
  const applyQueueEditResult = (result: {
    readonly queue: readonly QueuedMessage[];
    readonly editing: QueueEditState | undefined;
    readonly composer: ComposerSnapshot;
  }) => {
    if (preview) setPreviewQueue([...result.queue]);
    else setQueuedMessages([...result.queue]);
    setQueueEdit(result.editing);
    replaceDraft(result.composer);
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
      replaceDraft(emptySnapshot());
      setComposerError(undefined);
      return;
    }
    if (!composerRunning) return;
    if (!can("session.queue.list")) { setComposerError(zhRef.current ? "当前 Runtime 不支持消息队列，输入已保留为草稿。 / Queue unavailable; input kept as a draft." : "Queue unavailable; input kept as a draft."); return; }
    void sendFollowUp();
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
        setComposerError(zhRef.current ? "当前回合进行中，斜杠指令请等结束后再发。" : "A turn is running; wait until it finishes before sending slash commands.");
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
      // A waiting approval would hold the steer; deny it first, as OMP does when the user types.
      if (pendingInteraction?.kind === "approval" && !(await respond("cancel"))) return;
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
      setComposerError(hostErrorMessage(error, zhRef.current ? "纠偏失败" : "Steer failed"));
    } finally {
      setSending(false);
    }
  };
  // 一次有界遍历后本地过滤；Git 变更立即失效，非 Git 目录短期到期后重读。
  const fileIndex = useMemo(
    () => (preview || workspaceId === undefined
      ? undefined
      : createWorkspaceFileIndex(workspaceDirectoryLister(client, workspaceId as WorkspaceId))),
    [preview, client, workspaceId],
  );
  useEffect(() => {
    if (fileIndex === undefined || workspaceId === undefined) return;
    return followWorkspaceFileIndex(client, workspaceId as WorkspaceId, fileIndex);
  }, [client, workspaceId, fileIndex]);
  const fetchMentions = useCallback(async (trigger: "@" | "/" | "^", query: string) => {
    if (trigger === "/") return [];
    if (preview) return previewMentions(trigger, query, zh);
    try {
      return await loadMentions(client, trigger, query, fileIndex, can("session.skills.list") ? composerOwner ?? null : null);
    } catch {
      return [];
    }
  }, [preview, client, fileIndex, composerOwner, capabilities, zh]);
  const predictDraft = useCallback(async (before:string,prefix:string,version:number) => {
    if(preview||!composerOwner||!can("prediction.query"))return {version,suffix:null,engine:"off" as const};
    return client.query("prediction.query",{sessionId:composerOwner,version,before,prefix});
  },[client,composerOwner,preview,capabilities]);
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
    if (ui === "context-viewer") { openContextInspector(); return; }
    if (ui === "local-files") { setLocalFilesOpen(true); return; }
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
    const receive = (event: Event) => openSlashUi((event as CustomEvent<SlashNativeUi>).detail);
    window.addEventListener("omp-studio-slash-ui", receive);
    return () => window.removeEventListener("omp-studio-slash-ui", receive);
  }, []);
  async function runSlashCommand(command: StudioSlashCommand, args: string, images?: readonly PromptImageInput[]): Promise<boolean> {
    if (command.name === "local") { setLocalFileName(args.trim()); setLocalFilesOpen(true); return true; }
    if (command.availability === "disabled") {
      setComposerError(command.disabledReason ?? (zhRef.current ? `/${command.name} 暂不可用` : `/${command.name} is unavailable`));
      return false;
    }
    const destructive = command.risk === "destructive" || isDestructiveMemoryClear(command, args);
    if (destructive && !preview && !window.confirm(zhRef.current ? `确定执行 /${command.name}${args ? ` ${args}` : ""}？此操作会改会话状态。` : `Run /${command.name}${args ? ` ${args}` : ""}? This modifies session state.`)) {
      return false;
    }
    const execute = resolveSlashExecute(command, args);
    if (execute.kind === "none") return false;
    if (execute.kind === "native-ui") {
      openSlashUi(execute.ui);
      return true;
    }
    if (command.side && execute.kind === "invoke") {
      dock.store.dispatch({ type: "open", panel: "btw" });
      if (preview) { onBtwPreviewAsk(); return true; }
      return btwSession.ask(`/${command.name}${args ? ` ${args}` : ""}`, true, images ? [...images] : undefined, { name: command.name, arguments: args });
    }
    /* BTW 不走通用 run()：ask 的回执带着 branchToken，那是唯一能拿到它的地方，
       而 run() 只回报成败。同时把浮窗唤起来，placement 保持上次的偏好。
       预览开时同样走这条路径：打开演示浮窗，问题用输入框里的原文，不调 Host。 */
    if (execute.kind === "typed" && execute.name === "btw.ask") {
      const question = typeof execute.input.question === "string" ? execute.input.question : args.trim();
      dock.store.dispatch({ type: "open", panel: "btw" });
      if (preview) {
        onBtwPreviewAsk();
        if (question.length === 0) return true;
      }
      if (question.length === 0) { await btwSession.refreshHistory?.(); return true; }
      return await btwSession.ask(question, true, images ? [...images] : undefined);
    }
    if (preview) {
      if (execute.kind === "invoke" && execute.commandId === "builtin.commit") {
        openSelectiveCommit(args.trim() ? { instructions: args.trim() } : {});
        return true;
      }
      if (marks) setStatusToast(zhRef.current ? `演示：/${command.name}${args ? ` ${args}` : ""}` : `Demo: /${command.name}${args ? ` ${args}` : ""}`);
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
        const commitDraft = execute.commandId === "builtin.commit" ? selectiveCommitHandoff(outcome.result) : undefined;
        if (commitDraft) {
          /* builtin.commit only prepares a native draft; the panel owns preview and confirmation. */
          openSelectiveCommit(commitDraft);
        } else if (compacting) {
          const notice = compactNoticeFromOutput(outcome.output, { successText: zhRef.current ? "已压缩上下文" : "Context compacted" });
          setStatusToast(notice.text);
          if (notice.ok) onViewedTelemetryRefresh?.();
        } else if (command.name === "pin") {
          // `/pin` persists Runtime's global session-pins.json. Refresh only
          // after the authoritative command receipt so the next render cannot
          // race the Runtime's file write.
          await onPinCompleted?.();
        } else {
          const line = outcome.output.find((item) => item.trim().length > 0);
          setStatusToast(line ?? (zhRef.current ? `已执行 /${command.name}` : `Executed /${command.name}`));
        }
        setComposerError(undefined);
        return true;
      } catch (error) {
        setComposerError(hostErrorMessage(error, zhRef.current ? `/${command.name} 失败` : `/${command.name} failed`));
        return false;
      } finally {
        if (compacting) onCompactPending?.(false);
      }
    }
    return false;
  }
  const commitBlocked = preview ? undefined
    : !runtimeConnected || !executionMatches || !snapshot?.sessionId ? (zh ? "连接 Runtime 并打开会话后可用" : "Available once a Runtime session is open")
      : !can("commit.draft.prepare") ? (zh ? "当前 Runtime 不支持原生选择性提交" : "This Runtime has no native selective commit") : undefined;
  const revealDeckDestination = (panel?: PanelId) => {
    revealMainWindow();
    for (const group of dock.store.getSnapshot().layout.floats) {
      if (group.maximized && group.panels.some(id => panelBaseId(id) === "agents") && (!panel || !group.panels.includes(panel))) {
        dock.store.dispatch({ type: "float", groupId: group.id, maximized: false });
      }
    }
  };
  const goMainAgent = () => { revealDeckDestination(); onRoute("workbench"); composerInputRef.current?.focus(); };
  const openRosterAgent = (agent: StudioAgentSnapshot) => {
    revealDeckDestination(agentPanelId(agentScope, agent.agentId));
    openAgentDetail({ agentId: agent.agentId, displayName: agent.displayName, ...(agent.assignment === undefined ? {} : { task: agent.assignment }) });
  };
  /** The delegation that spawned an agent, when its card is among the loaded conversation rows. */
  const agentSourceCall = (agentId: string): string | undefined => {
    for (const row of convo.rows) {
      if (row.type !== "assistant") continue;
      for (const segment of row.segments) {
        if (segment.type !== "batch") continue;
        const found = collectAgents(segment.tools).find(agent => agent.agentId === agentId);
        if (found) return found.toolCallId;
      }
    }
    return undefined;
  };
  const agentDeckLinks: DeckLinks = {
    onOpen: row => openRosterAgent(row.agent),
    onMain: goMainAgent,
    onHub: row => { setHubIntent(row.id, "chat"); onRoute("agent-hub"); },
    onBtw: preview || can("agent.btw.read") ? row => {
      const serial = nextSubagentBtwIntent(agentViewBook.get(subagentViewKey(agentScope, row.id)));
      setAgentBtwIntent({ scope: agentScope, agentId: row.id, serial });
      openRosterAgent(row.agent);
    } : undefined,
    canLocate: row => agentSourceCall(row.id) !== undefined,
    onLocate: row => {
      const toolCallId = agentSourceCall(row.id);
      if (toolCallId === undefined) return Promise.resolve(false);
      revealDeckDestination(); onRoute("workbench");
      return revealConversationTarget(convoScrollerRef.current, { toolCallId });
    },
  };
  return (
    <ComputerLinkProvider onOpen={openComputerFrame}>
    <SelectiveCommitLauncherProvider value={{ open: () => openSelectiveCommit(), blocked: commitBlocked }}>
    <SubagentHoverProvider scope={JSON.stringify([agentScope, viewIdentity, snapshot?.runtimeEpoch])}
      enabled={workbenchVisible && !sessionCreating} client={conversationClient} agents={dockAgents}
      runtimeConnected={runtimeConnected && !connection?.resyncRequired}
      {...(agentParentSessionId === undefined ? {} : { parentSessionId: agentParentSessionId as SessionId })}
      {...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId })}>
      {remotePlanSave ? <div className="modal-backdrop" onKeyDown={event => { if (event.key === "Escape") { remotePlanSave.resolve(null); setRemotePlanSave(undefined); } }}>
        <section className="modal" role="dialog" aria-modal="true" aria-label={zh ? "保存远端计划" : "Save remote plan"}>
          <form onSubmit={event => { event.preventDefault(); remotePlanSave.resolve(remotePlanPath.trim()); setRemotePlanSave(undefined); }}>
            <h2>{zh ? "保存远端计划" : "Save remote plan"}</h2><p>{zh ? `保存到 SSH · ${executionTarget.name} 的当前项目中。` : `Save to the current project on SSH · ${executionTarget.name}.`}</p>
            <label>{zh ? "项目内相对路径" : "Project-relative path"}<input autoFocus required value={remotePlanPath} onChange={event => setRemotePlanPath(event.target.value)} /></label>
            <div className="ssh-dialog-actions"><button type="button" className="btn outline" onClick={() => { remotePlanSave.resolve(null); setRemotePlanSave(undefined); }}>{zh ? "取消" : "Cancel"}</button><button className="btn primary" disabled={!remotePlanPath.trim()}>{zh ? "保存并退出" : "Save & Quit"}</button></div>
          </form>
        </section>
      </div> : null}
      {localFilesOpen ? <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="local://"><button autoFocus className="btn small ghost" onClick={() => setLocalFilesOpen(false)}>{t("common.close")}</button><DeferredPanel><LocalFilesPane client={client} sessionId={snapshot?.sessionId} available={runtimeConnected && executionMatches} initialName={localFileName} /></DeferredPanel></section></div> : null}
      <WorktreeLaunchGate client={client} context={{ sessionId: snapshot?.sessionId, available: runtimeConnected && executionMatches && !connection?.resyncRequired, capabilities }} visible={state.route === "workbench"} onGateChange={changeWorktreeGate} onOpenWorkspace={onOpenWorktree} />
      <div className={`workbench${!mdi && sideOpen ? " split-right" : ""}`} id="workbench">
        <div ref={readingColumnRef} className={`convo-wrap${surfaceWelcome ? " is-empty" : ""}`} inert={state.loading}>
          {state.loading && <div className="cw-content-loading" role="status"><span className="spinner" />{zh ? "正在打开对话…" : "Opening conversation…"}</div>}
          {!state.loading && <RuntimeLossBanner
            {...(runtime === undefined ? {} : { runtime })}
            client={client}
            preview={preview}
            floating
            onOpenDiagnostics={() => onRoute("diagnostics")}
          />}
          <DockRail mode={hideNewConversationRail ? "hidden" : railMode} />
          <DockCapsules />
          <SessionModelRecovery demo={previewThreadId === "t5"} client={client} currentSessionId={snapshot?.sessionId} targetSessionId={selectedSessionId} threadId={selectedThreadId} available={runtimeConnected && !connection?.resyncRequired} capabilities={capabilities} onOpenModels={() => onRoute("model-config")} />
          <CommandBlockProvider workspaceId={workspaceId} sessionId={terminalSessionId} conversationId={terminalConversationId}>
          <ConversationPane
            {...(preview && previewThreadId === "t15" ? { supplement: <ContentGallerySamples /> } : {})}
            runtimeTools={{ client, actions: client, sessionId: snapshot?.sessionId, enabled: preview || runtimeConnected && executionMatches && can("shell.view.read") }}
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
            {...(preview ? {} : { onRetryTurn: retryLastTurn })}
            {...(preview || retryTurnDisabledReason === undefined ? {} : { retryTurnDisabledReason })}
            onInspectSubagent={openAgentDetail}
            liveAgents={dockAgents}
            {...(activity === undefined ? {} : { activity })}
            {...(showWelcome && optimisticPrompt === undefined && convo.state.pendingUsers.length === 0 ? { forceWelcome: true } : {})}
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
                />
              ),
            } : {})}
          />
          </CommandBlockProvider>
          <div className="composer-region" ref={computerApprovalRef}>
            {/* 真实 pending Interaction 永远优先；预览关时 Plan Review 走 snapshot；预览开才用演示 Deck。 */}
            {deckInteraction ? (
              <InteractionDeck
                interaction={deckInteraction}
                onRespond={respond}
                readForm={readForm}
                disabled={interactionDisabled}
                {...(askDeckLeaving ? { leaving: true } : {})}
              />
            ) : planReview ? (
              <PlanReviewDeck
                executionControl={nativePlanEnabled ? <PlanExecutionPicker details={planExecution.details} role={planExecution.role} onChange={planExecution.setRole} loading={planExecution.loading} error={planExecution.error} disabled={planSaveBusy || !planExecution.details?.available} /> : undefined}
                title={planReview.title ?? "Plan"}
                body={planReview.body ?? ""}
                expanded={planDialogOpen}
                onExpandedChange={setPlanDialogOpen}
                originRef={planDialogOriginRef}
                {...(planReviewDisabled || planSaveBusy || nativePlanEnabled && (planExecution.loading || !planExecution.details?.available) ? { disabled: true } : {})}
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
                        <span>{preview && marks ? t("shell.createProjectDemoTip") : t("shell.createProjectFolderTip")}</span>
                      </span>
                      {preview && marks ? <span className="chip purple xs">{t("common.demo")}</span> : <Icon name="chevron-r" extra="sm" />}
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
                    <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={switchCommitBusy} onClick={cancelSwitchBlock}><Icon name="x" /></button>
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
            {/* 排队托盘：已提交（Runtime）与本地草稿合成一张贴在输入框上沿的托盘；
                「回到最新」浮在整个托盘 + 输入框组合的右上方，不再挤进任何一栏的头行。 */}
            <div className="composer-queues">
            {jumpPill?.visible ? (
              <button
                type="button"
                className="new-content-pill composer-jump-latest"
                onClick={jumpPill.jumpToLatest}
                aria-label={zh ? "回到最新" : "Jump to latest"}
                data-tip={zh ? "回到最新" : "Jump to latest"}
              >
                <Icon name="chevron-d" />
              </button>
            ) : null}
            <div className="composer-tray">
            {(preview || can("session.queue.get")) ? (<RuntimeQueueBar client={client} sessionId={snapshot?.sessionId} capabilities={capabilities} available={runtimeConnected && executionMatches && !connection?.resyncRequired} pending={snapshot?.pendingMessages ?? 0} running={Boolean(snapshot?.isStreaming || snapshot?.isCompacting)} showDemo={previewThreadId === "t1"} />) : (!preview ? <RuntimeQueue client={client} sessionId={composerOwner} available={can("session.queue.list")} running={Boolean(snapshot?.isStreaming)} pending={snapshot?.pendingMessages ?? 0} hasDraft={() => !snapshotIsEmpty(takeComposerSnapshot())} onRecover={(recovered, owner) => {
              if (owner !== composerOwner) return;
              const current = takeComposerSnapshot();
              const merged = snapshotIsEmpty(current) ? recovered : {
                text: current.text + "\n" + recovered.text,
                images: [...current.images, ...recovered.images],
                doc: { nodes: [...current.doc.nodes, { type: "text" as const, value: "\n" }, ...recovered.doc.nodes] },
              };
              replaceDraft(merged); composerInputRef.current?.focus();
            }} /> : null)}
            <MessageQueueBar
              messages={sessionQueue}
              running={preview ? previewThreadId === "t1" : running}
              sendEnabled={preview || (running ? steerNowEnabled : promptChannelReady)}
              {...(preview ? { demo: true } : {})}
              {...(queueEdit === undefined ? {} : { editingId: queueEdit.entryId })}
              onEdit={editQueuedMessage}
              onSendNow={(entry) => void sendQueuedNow(entry)}
              onRemove={removeQueuedMessage}
            />
            </div>
            </div>
            {/* 项目 / 分支 / 执行位置 / Git 增删统计：只给还没发送过消息的新对话，贴在
                Composer 上沿。已开始的对话整条不显示——项目与分支在顶栏里，这一条
                只服务于「开新对话前先确认上下文」。 */}
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
                    <button className="ctx-project-backdrop" aria-label={zh ? "关闭项目菜单" : "Close project menu"} onClick={() => setContextProjectMenuOpen(false)} />
                    <div className="menu ctx-project-menu" role="menu" aria-label={zh ? "切换项目" : "Switch project"}>
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
                        <MenuItem icon="folder-open" current {...(marks ? { hint: t("common.demo") } : {})}>{previewCreatedProject.name}</MenuItem>
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
              <ExecutionTargetPicker onOpen={() => { setContextProjectMenuOpen(false); setContextBranchMenuOpen(false); }} otherMenuOpen={contextProjectMenuOpen || contextBranchMenuOpen} />
              {branchNotice ? (
                <span className={`ctx-item ctx-notice-${branchNotice.tone}`} role="status">
                  <Icon name={branchNotice.tone === "ok" ? "check" : "alert"} extra="sm" />
                  <span>{branchNotice.text}</span>
                </span>
              ) : null}
              <button
                type="button"
                className="ctx-item ctx-git-summary muted"
                data-tip={t("git.uncommitted")}
                aria-label={t("shell.uncommittedChanges")}
                aria-controls="dock-tab-git"
                onClick={onOpenGit}
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
              </button>
            </div> : null}
            <div className={`composer${composerRunning ? ` running ${composerExpanded ? "expanded" : "compact"}` : ""}`} id="composer">
              <LuxOrbit state={composerLightState} />
              <div className="composer-ctx" aria-label={zh ? "已引用的上下文" : "Referenced context"} role="group" />
              <label className="sr-only" htmlFor="composerInput">{zh ? "消息输入框。发送给 Runtime 的文本。" : "Message input box. Text to send to the Runtime."}</label>
              <ChipComposer
                prediction={{client,sessionId:snapshot?.sessionId,available:runtimeConnected&&executionMatches&&can("prediction.prepare"),nextMessageAvailable:can("composer.predictions")}}
                ref={composerInputRef}
                id="composerInput"
                disabled={worktreeGated}
                compact={composerRunning && !composerExpanded}
                placeholder={queueEdit === undefined ? t("conversation.composerPlaceholder") : t("conversation.editingQueuedMessage")}
                describedBy="composerHint"
                {...(workspaceId === undefined ? {} : { workspaceId })}
                loadMentions={fetchMentions}
                {...(can("prediction.prepare") ? {} : { predict: predictDraft })}
                slashCatalog={slashCatalog}
                onRunCommand={runSlashCommand}
                onChange={(next) => {
                  // Draft ownership follows the same truth as the queue: on a
                  // fresh-draft surface whose session is still being created the
                  // snapshot's session must not receive this draft.
                  const owner = composerOwner;
                  if (owner !== undefined) onComposerDraftChange?.(owner, next);
                  // Keystrokes land in the live ref first; the render-visible
                  // `draft` follows only at a status boundary or a typing pause.
                  publishDraft(next, applyingDraft.current);
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
                running={composerRunning}
                onFocus={() => setComposerExpanded(true)}
                onPointerDown={(event) => {
                  if (!composerRunning || composerExpanded) return;
                  event.preventDefault();
                  setComposerExpanded(true);
                  window.requestAnimationFrame(() => {
                    composerInputRef.current?.focus();
                  });
                }}
                onBlur={() => {
                  if (composerRunning && !hasStatusCapsules && !hasDraftContent) setComposerExpanded(false);
                }}
                onError={setComposerError}
              />
              <p className="sr-only" id="composerHint">{
                queueEdit !== undefined
                  ? t("composer.editingQueuedMessageHint")
                  : composerRunning
                    ? t("composer.runningHint", { shortcut: formatShortcut(SHORTCUTS.followUp, "hint") })
                    : pendingInteraction
                      ? t("composer.pendingInteractionHint")
                      : t("composer.idleHint", { shortcut: formatShortcut(SHORTCUTS.followUp, "hint") })
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
                <div className="cb-group cb-shortcuts">
                  <button className="icon-btn small" data-tip={t("composer.attachFiles")} aria-label={t("composer.attachFilesAria")} onClick={() => { setComposerExpanded(true); composerInputRef.current?.openFilePicker(); }}><Icon name="attach" extra="sm" /></button>
                  <button className="icon-btn small" data-tip={t("composer.mention")} aria-label={t("composer.mentionAria")} onClick={() => { setComposerExpanded(true); composerInputRef.current?.openMention("@"); }}><Icon name="at" extra="sm" /></button>
                  <button className="icon-btn small" data-tip={t("composer.commands")} aria-label={t("composer.commands")} onClick={() => { setComposerExpanded(true); composerInputRef.current?.openCommandMenu(); }}><Icon name="slash" extra="sm" /></button>
                </div>
                {queueEdit !== undefined ? (
                  <span className="pill-btn queue-edit" role="status">
                    <Icon name="pencil" extra="sm" />
                    <span className="qe-label">{t("composer.editQueued")}</span>
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
                  composerActions={{
                    onAttachFiles: () => { setComposerExpanded(true); composerInputRef.current?.openFilePicker(); },
                    onMention: () => { setComposerExpanded(true); composerInputRef.current?.openMention("@"); },
                    onCommands: () => { setComposerExpanded(true); composerInputRef.current?.openCommandMenu(); },
                  }}
                  {...(preview || (can("session.speed.get") && can("session.speed.set")) ? { speedControl: <ComposerSpeedControl previewSelected={previewSpeeds[previewThreadId ?? "new"] ?? "normal"} onPreviewChange={value => setPreviewSpeeds(values => ({ ...values, [previewThreadId ?? "new"]: value }))} client={client} sessionId={snapshot?.sessionId} modelSelector={snapshot?.model?.selector} available={runtimeConnected && executionMatches && !connection?.resyncRequired} /> } : {})}
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
                  {...(!executionMatches || snapshot === undefined ? {} : { snapshot })}
                  can={can}
                  canStartSession={canPrepareModel}
                  busy={busy}
                  onRun={runModelPreference}
                  openNonce={modelMenuNonce}
                />
                {!can("session.speed.get") ? <ServiceTierPicker client={client} sessionId={composerOwner} available={can("session.tier.get")} modelKey={JSON.stringify(snapshot?.model)} /> : null}
                <div className="cb-group">
                  <PromptHistoryButton client={client} sessionId={composerOwner ?? snapshot?.sessionId} ownSession={composerOwner !== undefined}
                    available={can("history.prompts.list") && can("history.prompts.read") && runtimeConnected && !worktreeGated}
                    canDelete={can("history.prompts.delete")} composerRef={composerInputRef} />
                  <DictationControl client={client} sessionId={composerOwner} draftId="composer" label={zh ? "工作台 / Composer" : "Workbench / Composer"} available={can("dictation.inspect") && runtimeConnected && !worktreeGated} visible={workbenchVisible} composerRef={composerInputRef} ensureSession={prepareDictationSession} onSubmit={() => { if (queueEdit !== undefined) commitQueuedEdit(); else void sendPrompt(); }} onSettings={() => { setSettingsIntent("voice", "dictation"); onRoute("settings"); }} onModels={() => { setModelConfigIntent({ tab: "roles", role: "dictation" }); onRoute("model-config"); }} />
                  {/* 运行中且没有草稿时，发送位变停止；上一轮停在没有最终汇报的尾巴上时
                      变播放键（空输入也能点，点了继续）；有草稿时保持"加入排队栏"，
                      否则会吃掉流式期间唯一的点击排队入口。编辑排队时始终是写回。 */}
                  {composerRunning && !textReady && queueEdit === undefined ? (
                    <button
                      className="send-btn abort"
                      disabled={!abortAllowed}
                      onClick={() => {
                        if (preview) return;
                        void run("core.abort", {}).then((ok) => {
                          if (ok) setAbortGeneration((generation) => generation + 1);
                        });
                      }}
                      data-tip={t("composer.stop")}
                      aria-label={t("composer.stopRunning")}
                    >
                      <Icon name="stop" extra="sm" />
                    </button>
                  ) : continueSlot ? (
                    <button
                      className="send-btn"
                      disabled={!continueEnabled}
                      onClick={continueTurn}
                      data-tip={continueEnabled ? t("composer.continueTurnAria") : retryTurnDisabledReason ?? t("composer.continueUnavailable")}
                      aria-label={t("composer.continueTurnAria")}
                    >
                      <Icon name="play" extra="sm" />
                    </button>
                  ) : (
                    <button
                      className="send-btn"
                      disabled={queueEdit === undefined && !(promptEnabled || queueEnabled || slashExecuteReady || (preview && running) || (composerRunning && textReady))}
                      onClick={() => {
                        setComposerExpanded(true);
                        if (queueEdit !== undefined) {
                          commitQueuedEdit();
                          return;
                        }
                        const payload = composerInputRef.current?.getSnapshot() ?? draftLive.current;
                        if (composerSlashExecute(payload, slashCatalog) !== undefined) {
                          void sendPrompt();
                          return;
                        }
                        if (composerRunning) enqueueDraft();
                        else void sendPrompt();
                      }}
                      data-tip={
                        queueEdit !== undefined
                          ? t("composer.commitQueue")
                          : composerRunning
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
          </div>
          <SharedSurface region="bottomReveal"><button
            ref={bottomRevealRef}
            className="icon-btn small bp-reveal"
            data-tip={bottomVisible ? t("shell.collapseBottomBar") : t("shell.expandBottomBar")}
            aria-label={bottomVisible ? t("shell.collapseBottomBar") : t("shell.expandBottomBar")}
            aria-expanded={bottomVisible}
            aria-controls="bottomPanel"
            data-dock-entry="bottom"
            onClick={() => onBottomVisibleChange(toggleBottomBarVisible({ visible: bottomVisible, open: bottomOpen }).visible)}
          >
            <Icon name="panel-bottom" extra="sm" />
          </button></SharedSurface>
        </div>
        <SharedSurface region="right">
        <aside className={`side-panel${sideOpen ? " open" : ""}`} id="sidePanel" inert={!sideOpen} aria-label={t("shell.rightPanel")}>
          <div className="sp-resizer" id="spResizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t("shell.adjustPanelWidth")} aria-valuemin={360} aria-valuemax={640} aria-valuenow={panelWidth} onPointerDown={onPanelResizePointerDown} onKeyDown={onPanelResizeKeyDown} onDoubleClick={() => onResizePanel(480)} />
          <DockGroupRegion region="right" visible={sideOpen} />
        </aside>
        </SharedSurface>
      </div>
      <SharedSurface region="bottom">
      <BottomPanelChrome
        visible={bottomVisible}
        expanded={bottomOpen}
        resizing={bottomResizing}
        height={bottomHeight}
        onResizePointerDown={onBottomResizePointerDown}
        onResizeDoubleClick={() => { onBottomOpenChange(true); onResizeBottom(BOTTOM_PANEL_DEFAULT); }}
        onResizeKeyDown={onBottomResizeKeyDown}
      />
      </SharedSurface>
      <DockKeyboard />
      <AgentsDock agents={dockAgents} ready={preview || rosterAgents !== undefined} source={agentRosterSource} scope={agentScope}
        openedIds={openedAgentIds} {...(inspectTarget === null ? {} : { selectedId: inspectTarget.agentId })}
        onMain={goMainAgent} onOpenRoster={openRosterAgent} links={agentDeckLinks}
        commandContext={{ client, capabilities, preview, viewingLive: preview || agentRosterSource === "live", online: runtimeConnected && !connection?.resyncRequired, sessionId: snapshot?.sessionId }} />
      <ChangesDockMeter rows={convo.rows} />
      <BackgroundTasksDock client={client} snapshot={snapshot} sessionId={selectedSessionId ?? snapshot?.sessionId}
        scopeKey={`${executionTarget.id ?? "local"}:${workspaceId ?? ""}:${selectedSessionId ?? snapshot?.sessionId ?? ""}:${connection?.runtimeEpoch ?? ""}:${preview ? previewThreadId ?? "preview" : "real"}`}
        available={runtimeConnected && executionMatches && !connection?.resyncRequired && !sessionCreating}
        jobsReady={preview || (executionMatches && !!snapshot)} workbenchVisible={workbenchVisible && !hideNewConversationRail}
        canListServices={can("services.list")} canStopServices={can("services.stop")} canCancelJobs={can("job.cancel")} />
      <ContextDockPanel client={client} viewedSessionId={selectedSessionId as SessionId | undefined} liveSessionId={snapshot?.sessionId}
        liveTelemetry={state.clientState?.entities.telemetry ?? undefined} refreshToken={telemetryRefreshToken}
        viewedThreadId={selectedThreadId} previewSessionId={previewThreadId}
        compactionAvailable={runtimeConnected && !connection?.resyncRequired && !sessionCreating && (executionMatches || selectedSessionId !== undefined) && can("session.compaction.get") && can("session.compaction.set")}
        compactionRefreshKey={`${snapshot?.model?.selector ?? ""}:${connection?.runtimeEpoch ?? ""}`}
        onOpenDetails={openContextInspector} onCompact={onCompactThread} compacting={compactingNow}
        queueInstead={snapshot?.isStreaming === true && can("session.compaction.enqueue")}
        compactDisabled={!runtimeConnected || !snapshot || connection?.resyncRequired === true || snapshot.isStreaming && !can("session.compaction.enqueue") || sessionCreating === true} />
      <GitWorkbenchPanels capabilities={capabilities} gitScope={gitScope} client={client} gitSharedWorkspaceId={gitSharedWorkspaceId} composerOwner={composerOwner} activeWorkspace={activeWorkspace} onOpenWorktree={onOpenWorktree} sessionId={snapshot?.sessionId} available={runtimeConnected && executionMatches && !connection?.resyncRequired} onRoute={onRoute} composerInputRef={composerInputRef} onOpenGit={onOpenGit} />
      <PanelRegistration panels={{
        "context-viewer": visibility => <ContextInspector client={client} sessionId={selectedSessionId ?? snapshot?.sessionId} sessionName={viewedSessionName} sourceKey={preview ? previewThreadId : selectedSessionId} opened={contextInspectorOpened} available={runtimeConnected && executionMatches && !connection?.resyncRequired} width={visibility.width} height={visibility.height} />,
        "token-counter": <TokenCounterPane key={String(preview)} client={client} />,
        commit: visibility => <SelectiveCommitPane client={client} sessionId={snapshot?.sessionId} runtimeEpoch={connection?.runtimeEpoch ?? undefined}
          available={runtimeConnected && executionMatches && !connection?.resyncRequired && !sessionCreating}
          supported={can("commit.draft.prepare") && can("commit.draft.select") && can("commit.draft.preview") && can("commit.draft.execute")}
          visible={visibility.visible} intent={commitIntent}
          onOpenSettings={() => { setSettingsIntent("tasks", "commit.enabled"); onRoute("settings"); }} />,
        changes: <>{preview ? <PreviewChanges {...(changesFocus.path === undefined ? {} : { focusPath: changesFocus.path })} {...(changesFocus.turnId === undefined ? {} : { focusTurnId: changesFocus.turnId })} focusKey={changesFocus.key} /> : <SessionChanges rows={convo.rows} {...(changesFocus.path === undefined ? {} : { focusPath: changesFocus.path })} {...(changesFocus.turnId === undefined ? {} : { focusTurnId: changesFocus.turnId })} focusKey={changesFocus.key} />}</>,
        environment: <EnvironmentDockCard {...(preview
          ? previewEnvironmentCard(activePreviewProject === undefined ? undefined : { name: activePreviewProject.name, root: activePreviewProject.path }, zh)
          : {
              target: { remote: executionTarget.id !== null, ...(executionTarget.id === null ? {} : { name: executionTarget.name }) },
              runtimeStatus: runtime?.status ?? "unavailable",
              ...(runtime?.runtimeVersion === undefined ? {} : { version: runtime.runtimeVersion }),
              ...(activeWorkspace === undefined ? {} : { project: { name: activeWorkspace.name, ...(activeWorkspace.root === undefined ? {} : { root: activeWorkspace.root }) } }),
              repository: realGit,
            })} />,
        browser: visibility => <BrowserPane client={client} sessionId={snapshot?.sessionId} chatId={browserChatId} available={runtimeConnected && executionMatches && !connection?.resyncRequired} visible={visibility.visible} capabilities={capabilities} />,
        computer: visibility => <ComputerDockPane client={client} sessionId={computerSessionId} sessionName={viewedSessionName}
          scopeKey={computerScopeKey} available={runtimeConnected && executionMatches && !connection?.resyncRequired}
          visible={visibility.visible} width={visibility.width} height={visibility.height} capabilities={capabilities}
          executionTarget={{ kind: executionTarget.id === null ? "local" : "remote", id: executionTarget.id ?? "local", name: executionTarget.name }}
          frameIntent={computerFrameIntent} onRevealConversation={revealComputerAction}
          onRevealApproval={pendingInteraction ? () => { onRoute("workbench"); const deck = computerApprovalRef.current?.querySelector<HTMLElement>(".deck"); deck?.scrollIntoView({ block: "nearest" }); deck?.querySelector<HTMLElement>("button, input, [tabindex]")?.focus(); } : undefined}
          onOpenSettings={() => { setSettingsIntent("tasks", "computer.enabled"); onRoute("settings"); }} />,
        "agent-detail": visibility => <AgentDetailPanel target={null} scope={agentScope} agents={dockAgents}
          visible={visibility.visible} client={client} conversationClient={conversationClient}
          runtimeConnected={runtimeConnected} canSend={can("agent.send")} canBtw={can("agent.btw.read")}
          {...(agentParentSessionId === undefined ? {} : { parentSessionId: agentParentSessionId as SessionId })}
          {...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId })}
          {...(pendingInteraction?.sessionId === undefined ? {} : { pendingInteractionSessionId: pendingInteraction.sessionId })}
          {...(workspaceId === undefined ? {} : { workspaceId })} loadMentions={fetchMentions}
          onMain={() => { revealMainWindow(); onRoute("workbench"); composerInputRef.current?.focus(); }}
          onOpenHub={agentId => { setHubIntent(agentId, "chat"); onRoute("agent-hub"); }}
          onRevealSource={target => target.toolCallId === undefined ? Promise.resolve(false) : revealConversationTarget(convoScrollerRef.current, { toolCallId: target.toolCallId })} />,
        btw: visibility => <><BtwPanel session={btwSession} onClose={() => dock.store.dispatch({ type: "hide", panels: ["btw"] })} visible={visibility.visible} {...(preview ? { demo: true, onDemoNext: onBtwDemoNext } : {})} /></>,
        terminal: visibility => <><TerminalPane workspaceId={preview ? state.bootstrap?.selected?.workspaceId : workspaceId} sessionId={terminalSessionId} conversationId={terminalConversationId} visible={visibility.visible} /></>,
        problems: <>{preview ? <div className="dock-pad"><PreviewProblems /></div> : <Deferred title={t("shell.problemsUnavailableTitle")} detail={t("shell.problemsUnavailableDetail")} />}</>,
        tests: <div className="dock-pad">{preview ? <PreviewTests /> : (
              <AgentTestsPane
                runs={testRuns}
                rerunDisabled={testRerunDisabled}
                rerunTitle={testRerunTitle}
                onRerun={(command) => { void dispatchPrompt(snapshotFromText(rerunTestPrompt(command))); }}
                onReveal={(run) => { revealConversationTool(convoScrollerRef.current, run); }}
              />
            )}</div>,
        output: (
          <OutputPanel
            commands={ledgerCommands}
            preview={preview}
            operator={(preview || commandManifest) ? (
              <>
                {preview ? (
                  <>
                    <section>
                      <h3 className="dock-group-label">{t("shell.operatorModes")}</h3>
                      <div className="actions">
                        <button className="btn outline" disabled={!can("mode.plan") || busy} onClick={() => void run("mode.plan.enter", {})}>Plan</button>
                        <button className="btn outline" disabled={!can("mode.vibe") || busy} onClick={() => void run("mode.vibe.enter", {})}>Vibe</button>
                        <button className="btn outline" disabled={!can("mode.plan") || busy} onClick={() => void run("mode.plan.exit", {})}>Exit plan</button>
                        <button className="btn outline" disabled={!can("mode.vibe") || busy} onClick={() => void run("mode.vibe.exit", {})}>Exit vibe</button>
                      </div>
                    </section>
                    <section>
                      <h3 className="dock-group-label">{t("shell.operatorGoalLoop")}</h3>
                      <div className="actions">
                        <button className="btn outline" disabled={!can("goal.create") || busy} onClick={() => void run("goal.create", { objective: "Continue current work" })}>Create goal</button>
                        <button className="btn outline" disabled={!can("goal.pause") || busy} onClick={() => void run("goal.pause", {})}>Pause goal</button>
                        <button className="btn outline" disabled={!can("goal.resume") || busy} onClick={() => void run("goal.resume", {})}>Resume goal</button>
                        <button className="btn outline" disabled={!can("loop.enable") || busy} onClick={() => void run("loop.enable", {})}>Start loop</button>
                        <button className="btn outline" disabled={!can("loop.pause") || busy} onClick={() => void run("loop.pause", {})}>Pause loop</button>
                        <button className="btn outline" disabled={!can("loop.disable") || busy} onClick={() => void run("loop.disable", {})}>Stop loop</button>
                      </div>
                    </section>
                    {runtime?.classification === "limited-system" && <p className="capability-note">Runtime is Limited. P4 mutations are disabled until the capability manifest grants them.</p>}
                  </>
                ) : null}
                {commandManifest && <OperatorCommandForm manifest={commandManifest} busy={busy} enabled={can("operator.invoke")} onInvoke={(commandId, args) => void run("operator.invoke", { commandId, ...(args === undefined ? {} : { arguments: args }) })} />}
              </>
            ) : undefined}
          />
        ),
        logs: <OmpLogsPanel events={ledgerEvents} preview={preview} />,
        pvlogs: <>{preview ? <div className="dock-pad"><PreviewLogs /></div> : <Deferred title={t("shell.previewLogsUnavailableTitle")} detail={t("shell.previewLogsUnavailableDetail")} />}</>,
      }} />
      {Object.entries(agentDockLayout.agentPanels).filter(([id, descriptor]) => (descriptor.scope === agentScope || agentDockLayout.floats.some(group => group.pin && group.panels.includes(id as PanelId))) && locatePanel(agentDockLayout, id as PanelId)).map(([id, descriptor]) =>
        <DockPanel key={id} id={id as AgentPanelId}>{visibility => <AgentDetailPanel target={descriptor.target} scope={descriptor.scope} agents={descriptor.scope === agentScope ? dockAgents : []}
          contextAvailable={descriptor.scope === agentScope}
          visible={visibility.visible} client={client} conversationClient={descriptor.scope === agentScope ? conversationClient : null}
          runtimeConnected={runtimeConnected && descriptor.scope === agentScope} canSend={can("agent.send") && descriptor.scope === agentScope} canBtw={can("agent.btw.read") && descriptor.scope === agentScope}
          {...((descriptor.target.parentSessionId ?? agentParentSessionId) === undefined ? {} : { parentSessionId: (descriptor.target.parentSessionId ?? agentParentSessionId) as SessionId })}
          {...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId })}
          {...(pendingInteraction?.sessionId === undefined ? {} : { pendingInteractionSessionId: pendingInteraction.sessionId })}
          {...(workspaceId === undefined ? {} : { workspaceId })} loadMentions={fetchMentions}
          viewState={agentViewBook.get(subagentViewKey(descriptor.scope, descriptor.target.agentId))}
          {...(agentBtwIntent !== null && agentBtwIntent.scope === descriptor.scope && agentBtwIntent.agentId === descriptor.target.agentId && descriptor.scope === agentScope ? { btwIntent: agentBtwIntent.serial } : {})}
          onActivate={() => dock.store.dispatch({ type: "agent-focus", panel: id as AgentPanelId })}
          onMain={() => { revealMainWindow(); onRoute("workbench"); composerInputRef.current?.focus(); }}
          onOpenHub={agentId => { setHubIntent(agentId, "chat"); onRoute("agent-hub"); }}
          onRevealSource={target => target.toolCallId === undefined ? Promise.resolve(false) : revealConversationTarget(convoScrollerRef.current, { toolCallId: target.toolCallId })} />}</DockPanel>)}
      <FileDockInstances workspaceId={workspaceId ? String(workspaceId) : undefined} targetId={executionTarget.id} onSettings={() => { setSettingsIntent("maintenance", "office-preview"); onRoute("settings"); }} actions={fileViewerActions} />
      <FileBrowserDock workspaceId={workspaceId ? String(workspaceId) : undefined} targetId={executionTarget.id} targetName={executionTarget.name} actions={fileViewerActions} />
      <BrowserDockInstances client={client} sessionId={browserChatId} available={runtimeConnected && executionMatches && !connection?.resyncRequired} capabilities={capabilities} remote={!!executionTarget.id} onReferences={insertBrowserReferences} />
      <ToastHost message={statusToast} icon="info" onDismiss={() => setStatusToast(null)} />
      {treeConfirm.dialog}
    </SubagentHoverProvider>
    </SelectiveCommitLauncherProvider>
    </ComputerLinkProvider>
  );
}
